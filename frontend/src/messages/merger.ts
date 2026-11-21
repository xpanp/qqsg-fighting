import type {
  FrameContext,
  MergedMessage,
  OcrLine,
} from "../../../contracts/types";

const channels =
  "系统|同屏|队伍|密语|职业|国家|小喇叭|大喇叭|地图|军团|好友|阵营";
const prefix = new RegExp(
  `(?:\\[|【)\\s*(${channels
    .split("|")
    .map((x) => x.split("").join("\\s*"))
    .join("|")})\\s*(?:\\]|】)`,
  "g",
);
const key = (s: string) =>
  s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
const gameTime = (s: string) =>
  s
    .match(/[\[【]\s*(\d{2})\s*[:：]\s*(\d{2})\s*[:：]\s*(\d{2})\s*[\]】]/)
    ?.slice(1)
    .join(":");

/** Group wrapped physical OCR lines by explicit channel boundaries. Leading orphans are discarded. */
export function messageCandidates(
  lines: OcrLine[],
): { text: string; confidence: number; box?: number[] }[] {
  const nonempty = lines.filter((l) => l.text.trim());
  const text = nonempty.map((l) => l.text.trim()).join("\n");
  const normalized = text.replace(
    prefix,
    (_m, c: string) => `[${c.replace(/\s/g, "")}]`,
  );
  const boundaries = [
    ...normalized.matchAll(new RegExp(`\\[(${channels})\\]`, "g")),
  ];
  const confidence =
    lines.reduce((n, l) => n + (l.confidence ?? 0.5), 0) /
    Math.max(lines.length, 1);
  if (!boundaries.length) return [];
  return boundaries
    .map((m, i) => ({
      text: normalized
        .slice(m.index, boundaries[i + 1]?.index)
        .replace(/\s*\n\s*/g, "")
        .trim(),
      confidence,
      box: nonempty[normalized.slice(0, m.index).split("\n").length - 1]?.box,
    }))
    .filter(
      (l) =>
        l.text.length > 4 &&
        !/在战(?:斗(?:中(?:击(?:败(?:了)?)?)?)?)?$/.test(l.text),
    );
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const ta = gameTime(a),
    tb = gameTime(b);
  if (ta && tb && ta !== tb) return 0;
  const x = key(a),
    y = key(b);
  if (
    !x ||
    !y ||
    Math.min(x.length, y.length) / Math.max(x.length, y.length) < 0.65
  )
    return 0;
  const row = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const old = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        prev + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
      prev = old;
    }
  }
  const score = 1 - row[y.length] / Math.max(x.length, y.length);
  // Very short player names/messages should not be merged solely because one character agrees.
  return score >= (Math.min(x.length, y.length) < 8 ? 0.9 : 0.78) ? score : 0;
}

interface Track {
  message: MergedMessage;
  box?: number[];
  readings: Map<string, { count: number; confidence: number }>;
}

/** Matches only the previous ordered viewport, never a permanent text-to-message map. */
export class MessageMerger {
  private previous: Track[] = [];
  private history: MergedMessage[] = [];
  private lastFrame = "";
  constructor(private readonly sessionId: string) {}
  list(): MergedMessage[] {
    return this.history.map((m) => ({ ...m }));
  }
  ingest(lines: OcrLine[], context: FrameContext): MergedMessage[] {
    if (context.sessionId !== this.sessionId)
      throw new Error("Message merger session mismatch");
    if (context.frameId === this.lastFrame) return [];
    this.lastFrame = context.frameId;
    const current = messageCandidates(lines).slice(-100);
    // Empty OCR is not evidence that every visible message disappeared.
    if (!current.length) return [];
    const n = this.previous.length,
      m = current.length;
    // Common templates alone do not prove identity. Fuzzy correction needs a stable
    // neighbouring anchor, or matching explicit game time plus unchanged position.
    const scoreAt = (i: number, j: number): number => {
      const track = this.previous[i],
        reading = current[j];
      const score = similarity(track.message.text, reading.text);
      if (score === 1 || key(track.message.text) === key(reading.text))
        return 1;
      if (!score) return 0;
      const neighbour = [-1, 1].some(
        (d) =>
          this.previous[i + d] &&
          current[j + d] &&
          key(this.previous[i + d].message.text) === key(current[j + d].text),
      );
      const beforeTime = gameTime(track.message.text),
        afterTime = gameTime(reading.text);
      const box = reading.box;
      const samePosition =
        track.box && box && Math.abs(track.box[1] - box[1]) <= 3;
      return neighbour ||
        (beforeTime && beforeTime === afterTime && samePosition)
        ? score
        : 0;
    };
    const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    for (let i = 1; i <= n; i++)
      for (let j = 1; j <= m; j++) {
        const score = scoreAt(i - 1, j - 1);
        dp[i][j] = Math.max(
          dp[i - 1][j],
          dp[i][j - 1],
          score ? dp[i - 1][j - 1] + score : 0,
        );
      }
    const matches = new Map<number, Track>();
    let i = n,
      j = m;
    while (i && j) {
      const score = scoreAt(i - 1, j - 1);
      if (score && Math.abs(dp[i][j] - dp[i - 1][j - 1] - score) < 1e-8) {
        matches.set(j - 1, this.previous[i - 1]);
        i--;
        j--;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
      else j--;
    }
    const changed: MergedMessage[] = [];
    this.previous = current.map((reading, index) => {
      let track = matches.get(index);
      if (!track) {
        const message: MergedMessage = {
          id: crypto.randomUUID(),
          sessionId: this.sessionId,
          text: reading.text,
          firstObservedAtMs: context.capturedAtMs,
          lastObservedAtMs: context.capturedAtMs,
          revision: 1,
          observations: 1,
          gameTime: gameTime(reading.text),
          firstFrameId: context.frameId,
          lastFrameId: context.frameId,
        };
        track = {
          message,
          box: reading.box,
          readings: new Map([
            [reading.text, { count: 1, confidence: reading.confidence }],
          ]),
        };
        this.history.push(message);
      } else {
        const votes = track.readings.get(reading.text) ?? {
          count: 0,
          confidence: reading.confidence,
        };
        votes.count++;
        votes.confidence = Math.max(votes.confidence, reading.confidence);
        track.readings.set(reading.text, votes);
        const completeKey = key(track.message.text);
        const best = [...track.readings]
          .filter(
            ([text]) =>
              !(
                completeKey.startsWith(key(text)) &&
                key(text).length < completeKey.length
              ),
          )
          .sort((a, b) => {
            const rank = ([s, v]: [
              string,
              { count: number; confidence: number },
            ]) =>
              v.count + v.confidence * 0.4 + Math.min(s.length, 200) * 0.002;
            return rank(b) - rank(a);
          })[0][0];
        if (best !== track.message.text) {
          track.message.text = best;
          track.message.gameTime = gameTime(best);
          track.message.revision++;
        }
        track.message.observations++;
        track.message.lastObservedAtMs = context.capturedAtMs;
        track.message.lastFrameId = context.frameId;
        track.box = reading.box;
        if (track.readings.size > 8) {
          const least = [...track.readings].sort(
            (a, b) => a[1].count - b[1].count,
          )[0][0];
          if (least !== track.message.text) track.readings.delete(least);
        }
      }
      changed.push({ ...track.message });
      return track;
    });
    if (this.history.length > 1000)
      this.history.splice(0, this.history.length - 1000);
    return changed;
  }
}
