/** OCR identity is a source hint, never proof of the uploader's identity. */
export interface CaptureIdentity {
  realm?: string;
  /** Decimal line number without 线. */
  line?: string;
  character?: string;
  evidence: Partial<Record<"realm" | "line" | "character", string>>;
}
export interface IdentityInput {
  windowTitle?: string;
  titleLines?: string[];
  /** Only text cropped specifically from the character-name HUD region. */
  characterLines?: string[];
  /** Generic OCR lines only contribute explicitly labelled names. */
  lines?: string[];
}
const digits: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  兩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
function lineNumber(text: string): string | undefined {
  let number: number;
  if (/^\d+$/.test(text)) number = Number(text);
  else if (text.includes("十")) {
    const [tens, units, extra] = text.split("十");
    if (
      extra !== undefined ||
      (tens && !(tens in digits)) ||
      (units && !(units in digits))
    )
      return;
    number = (tens ? digits[tens] : 1) * 10 + (units ? digits[units] : 0);
  } else if (text.length === 1 && text in digits) number = digits[text];
  else return;
  return Number.isInteger(number) && number > 0 && number <= 999
    ? String(number)
    : undefined;
}
const rejectedRealm =
  /^(?:QQ)?三国$|服务器|伺服器|线路|線路|频道|頻道|角色|玩家|等级|等級|生命|体力|體力|地图|地圖|窗口|客户端|遊戲|游戏/;
const rejectedName =
  /^(?:生命|体力|體力|经验|經驗|等级|等級|角色|角色名|昵称|暱稱|系统|系統|同屏|同屏聊天|聊天|地图|地圖|未知|QQ三国|QQ三國)$/;
function characterName(text: string): string | undefined {
  const name = text.trim();
  if (!name || [...name].length > 16 || rejectedName.test(name)) return;
  if (
    !/\p{L}/u.test(name) ||
    /[\[\]【】\r\n]|在战斗|击败了|擊敗了|[:：]|\b(?:LV|Lv)\s*\d/.test(name)
  )
    return;
  return name;
}
function labelledName(text: string) {
  const match = text.match(
    /^\s*(?:角色名称|角色名稱|角色名|角色|昵称|暱稱)\s*[:：]\s*(.+)$/u,
  );
  return match ? characterName(match[1]) : undefined;
}
/** Missing or ambiguous fields remain unknown; never infer identity from chat. */
export function parseCaptureIdentity(input: IdentityInput): CaptureIdentity {
  const result: CaptureIdentity = { evidence: {} };
  const headers = [
    ...(input.titleLines ?? []),
    ...(input.titleLines?.length ? [input.titleLines.join(" ")] : []),
    input.windowTitle ?? "",
  ];
  for (const original of headers) {
    const text = original.normalize("NFKC").trim();
    const match = text.match(
      /([\p{Script=Han}]{2,16}?)\s*[\[【(（]?\s*([0-9一二两兩三四五六七八九十〇零]{1,3})\s*[线線](?:\s*[\]】)）])?/u,
    );
    if (!match || rejectedRealm.test(match[1])) continue;
    const line = lineNumber(match[2]);
    if (!line) continue;
    result.realm = match[1];
    result.line = line;
    result.evidence.realm = original;
    result.evidence.line = original;
    break;
  }
  const labelled = [...(input.lines ?? []), ...(input.characterLines ?? [])]
    .map((text) => ({ text, name: labelledName(text) }))
    .filter((item) => !!item.name);
  const candidates = labelled.length
    ? labelled
    : (input.characterLines ?? [])
        .map((text) => ({ text, name: characterName(text) }))
        .filter((item) => !!item.name);
  if (new Set(candidates.map((item) => item.name)).size === 1) {
    result.character = candidates[0].name;
    result.evidence.character = candidates[0].text;
  }
  return result;
}

/** Confirm observations, never inference completion time. Missing frames break votes. */
export class IdentityTracker {
  private votes = new Map<string, { value: string; count: number }>();
  private current: CaptureIdentity;
  constructor(initial: CaptureIdentity = { evidence: {} }) {
    this.current = structuredClone(initial);
  }
  observe(candidate: CaptureIdentity, sampledAtMs: number) {
    let changed = false;
    const confirm = (
      key: string,
      value: string | undefined,
      apply: () => void,
    ) => {
      if (!value) {
        this.votes.delete(key);
        return;
      }
      const previous = this.votes.get(key);
      const count = previous?.value === value ? previous.count + 1 : 1;
      this.votes.set(key, { value, count });
      if (count >= 2) apply();
    };
    confirm(
      "location",
      candidate.realm && candidate.line
        ? JSON.stringify([candidate.realm, candidate.line])
        : undefined,
      () => {
        if (
          this.current.realm !== candidate.realm ||
          this.current.line !== candidate.line
        ) {
          this.current.realm = candidate.realm;
          this.current.line = candidate.line;
          this.current.evidence.realm = candidate.evidence.realm;
          this.current.evidence.line = candidate.evidence.line;
          changed = true;
        }
      },
    );
    confirm("character", candidate.character, () => {
      if (this.current.character !== candidate.character) {
        this.current.character = candidate.character;
        this.current.evidence.character = candidate.evidence.character;
        changed = true;
      }
    });
    return { identity: structuredClone(this.current), changed, sampledAtMs };
  }
}
