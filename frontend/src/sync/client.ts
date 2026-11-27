import type { MergedMessage } from "../../../contracts/types";
import type {
  SyncAckV2,
  SyncBatchV2,
  SyncContext,
} from "../../../contracts/sync";
import { Outbox, type SessionGrant, type CaptureIntent } from "./outbox";
export interface SyncSettings {
  enabled: boolean;
  token: string;
  sourceId: string;
  realm: string;
  line: string;
  character?: string;
}
export interface SyncStatus {
  pending: number;
  rejected: number;
  detail: string;
  lastSuccess?: number;
}
/** Capture uses a monotonic clock with fractional milliseconds; wire v2 uses UTC integer ms. */
export function toWireMessage(message: MergedMessage): MergedMessage {
  if (
    !Number.isFinite(message.firstObservedAtMs) ||
    !Number.isFinite(message.lastObservedAtMs)
  )
    throw Error("消息时间无效，已保留本地记录");
  return {
    ...message,
    firstObservedAtMs: Math.round(message.firstObservedAtMs),
    lastObservedAtMs: Math.max(
      Math.round(message.firstObservedAtMs),
      Math.round(message.lastObservedAtMs),
    ),
  };
}
export class SyncClient {
  private contextSerial: Promise<void> = Promise.resolve();
  private serializeContext(action: () => Promise<void>) {
    const task = this.contextSerial.then(action);
    this.contextSerial = task.catch(() => {});
    return task;
  }
  bindCapture(
    sessionId: string,
    sessionStartedAtMs: number,
    identity: { realm?: string; line?: string; character?: string },
    observedAtMs: number,
  ) {
    if (!this.options.settings().enabled) return;
    const intent: CaptureIntent = {
      id: JSON.stringify([sessionId, Math.round(observedAtMs)]),
      captureSessionId: sessionId,
      observedAtMs: Math.round(observedAtMs),
      context: {
        sessionStartedAtMs,
        realm: identity.realm ?? "",
        line: identity.line ?? "",
        ...(identity.character ? { character: identity.character } : {}),
      },
    };
    void this.serializeContext(async () => {
      await this.outbox.rememberCapture(intent);
      await this.adoptCaptures();
    }).catch(() => this.status("采集来源保存失败；先保留本地文字，录像继续"));
  }
  private async adoptCaptures() {
    const settings = { ...this.options.settings() };
    if (!settings.enabled || !settings.token || !settings.sourceId) return;
    const pending = (await this.outbox.captureIntents()).sort(
      (a, b) => a.observedAtMs - b.observedAtMs,
    );
    for (const intent of pending) {
      const existing = (await this.outbox.grants())
        .filter(
          (g) =>
            g.sourceId === settings.sourceId &&
            g.captureSessionId === intent.captureSessionId,
        )
        .sort((a, b) => (a.captureFromMs ?? 0) - (b.captureFromMs ?? 0));
      const last = existing.at(-1),
        context = intent.context;
      if (
        !last ||
        last.context.realm !== context.realm ||
        last.context.line !== context.line ||
        (last.context.character ?? "") !== (context.character ?? "")
      ) {
        await this.outbox.authorize({
          sessionId: intent.captureSessionId + "/sync/" + intent.observedAtMs,
          sourceId: settings.sourceId,
          context,
          captureSessionId: intent.captureSessionId,
          captureFromMs: last
            ? intent.observedAtMs
            : context.sessionStartedAtMs,
        });
      }
      await this.outbox.forgetCapture(intent.id);
    }
  }
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private failures = 0;
  private retryAt = 0;
  private authFailed = false;
  private lastSuccess?: number;
  private cursor?: string;
  private clock?: { clockOffsetMs: number; clockUncertaintyMs: number };
  private generation = 0;
  private controller?: AbortController;
  private active = false;
  private lastPrune = 0;
  private pendingCount = 0;
  private rejectedCount = 0;
  constructor(
    private options: {
      settings: () => SyncSettings;
      onStatus: (s: SyncStatus) => void;
      scan: (
        after?: string,
      ) => Promise<{ rows: MergedMessage[]; after?: string }>;
      outbox?: Outbox;
      fetch?: typeof fetch;
    },
  ) {}
  get outbox() {
    return (this.options.outbox ??= new Outbox());
  }
  private status(
    detail: string,
    pending = this.pendingCount,
    rejected = this.rejectedCount,
  ) {
    this.pendingCount = pending;
    this.rejectedCount = rejected;
    try {
      this.options.onStatus({
        detail,
        pending,
        rejected,
        lastSuccess: this.lastSuccess,
      });
    } catch {}
  }
  authorize(sessionId: string, sessionStartedAtMs: number) {
    const s = this.options.settings();
    if (!s.enabled || !s.token || !s.sourceId) return;
    void this.outbox
      .authorize({
        sessionId,
        sourceId: s.sourceId,
        context: { sessionStartedAtMs, realm: s.realm, line: s.line },
      })
      .catch(() => this.status("同步授权保存失败；录像继续，下次请重试"));
  }
  /** Never returns an upload promise to OCR/capture callers. */
  notify(rows: MergedMessage[]) {
    void this.enqueue(rows).catch(() =>
      this.status("同步缓存已满或不可写；原文仍在本地，录像继续"),
    );
  }
  private async enqueue(rows: MergedMessage[]) {
    const settings = this.options.settings();
    if (!settings.enabled) return;
    await this.contextSerial;
    const grants = await this.outbox.grants();
    const allowed = grants.filter((g) => g.sourceId === settings.sourceId);
    for (const row of rows) {
      const legacy = allowed.find(
        (g) => g.sessionId === row.sessionId && !g.captureSessionId,
      );
      if (legacy) await this.outbox.enqueue(legacy, row);
      else await this.outbox.enqueueCaptured(allowed, row);
    }
  }
  reset() {
    this.stop();
    this.authFailed = false;
    this.failures = 0;
    this.retryAt = 0;
    this.clock = undefined;
    this.start();
  }
  start() {
    this.active = true;
    if (!this.timer)
      this.timer = setTimeout(
        () => {
          this.timer = undefined;
          void this.tick()
            .catch(() => {})
            .finally(() => {
              if (this.active) this.start();
            });
        },
        Math.max(
          Math.min(60000, 2000 * 2 ** this.failures),
          this.retryAt - Date.now(),
        ) +
          Math.random() * 250,
      );
  }
  stop() {
    this.active = false;
    this.generation++;
    this.controller?.abort();
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  private async request(
    path: string,
    settings: SyncSettings,
    generation: number,
    init: RequestInit = {},
  ) {
    if (generation !== this.generation)
      throw Error("同步配置已变更；保留未确认记录");
    const response = await (this.options.fetch ?? fetch)(
      "/fighting/api/v1/" + path,
      {
        ...init,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + settings.token,
          ...init.headers,
        },
        signal: AbortSignal.any([
          AbortSignal.timeout(10000),
          this.controller!.signal,
        ]),
      },
    );
    if (generation !== this.generation)
      throw Error("同步配置已变更；保留未确认记录");
    if (response.status === 429) {
      const retry = response.headers.get("Retry-After") ?? "30";
      const seconds = Number(retry);
      const delay = Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(retry) - Date.now();
      this.retryAt =
        Date.now() +
        Math.max(
          1000,
          Math.min(3600000, Number.isFinite(delay) ? delay : 30000),
        );
      throw Error(
        "当前上传人数已满或请求过快；文字已暂存，将自动重试，本地录像继续",
      );
    }
    if (response.status === 401 || response.status === 403) {
      this.authFailed = true;
      throw Error("采集接入已失效，请联系管理员；本地录像继续");
    }
    if (!response.ok)
      throw Error(
        "服务器暂不可用（" + response.status + "）；稍后重试，录像继续",
      );
    return response;
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    const generation = this.generation;
    this.controller = new AbortController();
    try {
      const s = this.options.settings();
      if (!s.enabled || !s.token || !s.sourceId) {
        this.status("正在等待采集接入；视频和文字先保存在本机");
        return;
      }
      if (Date.now() < this.retryAt) {
        this.status(
          "正在等待上传名额或服务器重试时间；文字已暂存，本地录像继续",
        );
        return;
      }
      await this.serializeContext(() => this.adoptCaptures());
      if (this.authFailed) {
        this.status("采集接入已失效，请联系管理员；本地录像继续");
        return;
      }
      if (Date.now() - this.lastPrune > 3600000) {
        await this.outbox.prune();
        this.lastPrune = Date.now();
      }
      // A bounded page repairs save/enqueue gaps. Only explicitly granted sessions qualify.
      let scanWarning = "";
      try {
        const page = await this.options.scan(this.cursor);
        await this.enqueue(page.rows);
        this.cursor = page.after;
      } catch {
        scanWarning = "补入同步队列失败/已满；先上传已有记录，缺口稍后重试。";
      }
      const sampled = await this.outbox.sample(s.sourceId),
        pending = sampled.rows,
        rejected = sampled.rejected;
      this.pendingCount = sampled.pending;
      this.rejectedCount = rejected;
      if (!pending.length) {
        this.status(
          scanWarning ||
            (this.lastSuccess
              ? "已同步；等待新消息"
              : "已接入，等待识别到新消息"),
          0,
          rejected,
        );
        this.failures = 0;
        return;
      }
      if (!this.clock) {
        const start = Date.now();
        const r = await this.request("time", s, generation);
        const { serverTimeMs } = await r.json();
        const end = Date.now();
        if (!Number.isFinite(serverTimeMs)) throw Error("服务器校时响应无效");
        this.clock = {
          clockOffsetMs: serverTimeMs - (start + end) / 2,
          clockUncertaintyMs: (end - start) / 2,
        };
      }
      const first = pending[0],
        grant = (await this.outbox.grants()).find(
          (g) => g.sessionId === first.sessionId && g.sourceId === s.sourceId,
        );
      if (!grant) throw Error("缺少会话授权信息");
      const selected = pending
        .filter((r) => r.sessionId === first.sessionId)
        .slice(0, 50);
      const batch: SyncBatchV2 = {
        schemaVersion: 2,
        batchId: crypto.randomUUID(),
        sourceId: s.sourceId,
        sessionId: first.sessionId,
        context: { ...grant.context, ...this.clock },
        messages: selected.map((r) => toWireMessage(r.message)),
      };
      const ack = (await (
        await this.request("ingest/batches", s, generation, {
          method: "POST",
          body: JSON.stringify(batch),
        })
      ).json()) as SyncAckV2;
      if (
        ack.batchId !== batch.batchId ||
        !Array.isArray(ack.accepted) ||
        !Array.isArray(ack.rejected)
      )
        throw Error("服务器确认格式不匹配，保留待上传记录");
      const confirmed = new Set<string>();
      for (const item of [...ack.accepted, ...ack.rejected]) {
        if (
          !item ||
          !selected.some(
            (r) =>
              r.message.id === item.id &&
              r.sessionId === item.sessionId &&
              r.message.revision === item.revision,
          )
        )
          throw Error("服务器确认包含本批以外的消息，保留待上传记录");
        const key = JSON.stringify([item.sessionId, item.id, item.revision]);
        if (confirmed.has(key))
          throw Error("服务器确认重复或冲突，保留待上传记录");
        confirmed.add(key);
      }
      if (
        ack.rejected.some(
          (item) =>
            typeof item.code !== "string" ||
            !item.code ||
            typeof item.retryable !== "boolean",
        )
      )
        throw Error("服务器拒绝确认格式无效，保留待上传记录");
      for (const row of selected) {
        if (
          ack.accepted.some(
            (a) =>
              a.id === row.message.id &&
              a.sessionId === row.sessionId &&
              a.revision === row.message.revision,
          )
        )
          await this.outbox.mark(row.key, row.message.revision);
        const reject = ack.rejected.find(
          (a) =>
            a.id === row.message.id &&
            a.sessionId === row.sessionId &&
            a.revision === row.message.revision,
        );
        if (reject && !reject.retryable)
          await this.outbox.mark(row.key, row.message.revision, reject.code);
      }
      if (ack.accepted.length) this.lastSuccess = Date.now();
      this.failures = 0;
      this.status(
        scanWarning || "本批已处理",
        Math.max(0, sampled.pending - ack.accepted.length),
        rejected + ack.rejected.filter((r) => !r.retryable).length,
      );
      if (ack.rejected.some((r) => r.retryable)) this.failures = 1;
    } catch (e) {
      this.failures = Math.min(5, this.failures + 1);
      this.status(e instanceof Error ? e.message : "同步异常；录像继续");
    } finally {
      this.running = false;
    }
  }
}
