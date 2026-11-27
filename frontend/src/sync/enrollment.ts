/** Public collector credentials identify a browser, never the OCR character. */
export interface CollectorCredential {
  sourceId: string;
  token: string;
}
export class CollectorEnrollment {
  private active?: Promise<CollectorCredential>;
  private retryAfter = 0;
  constructor(
    private options: { fetch?: typeof fetch; now?: () => number } = {},
  ) {}
  get nextAttemptAt() {
    return this.retryAfter;
  }
  ensure(existing: CollectorCredential): Promise<CollectorCredential> {
    if (existing.sourceId && existing.token) return Promise.resolve(existing);
    if (this.active) return this.active;
    const now = (this.options.now ?? Date.now)();
    if (now < this.retryAfter)
      return Promise.reject(Error("采集接入稍后重试；本地录像继续"));
    this.active = (async () => {
      const response = await (this.options.fetch ?? fetch)(
        "/fighting/api/v1/collectors/register",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          credentials: "same-origin",
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok)
        throw Error(
          response.status === 429
            ? "采集接入暂满，请稍后重试；本地录像继续"
            : "暂时无法连接文字采集服务；本地录像继续",
        );
      const result = await response.json();
      if (
        typeof result.sourceId !== "string" ||
        !result.sourceId ||
        result.sourceId.length > 120 ||
        typeof result.token !== "string" ||
        result.token.length < 20 ||
        result.token.length > 256
      )
        throw Error("采集接入响应无效；本地录像继续");
      return { sourceId: result.sourceId, token: result.token };
    })()
      .catch((error) => {
        this.retryAfter = (this.options.now ?? Date.now)() + 60000;
        throw error;
      })
      .finally(() => {
        this.active = undefined;
      });
    return this.active;
  }
}

export const COLLECTOR_STORAGE_KEY = "qqsg-sync-settings-v2";
export interface SharedEnrollmentOptions {
  read: () => CollectorCredential | undefined;
  save: (credential: CollectorCredential) => void;
  lock: <T>(name: string, task: () => Promise<T>) => Promise<T>;
}
/** Hold only an enrollment lock, including durable save, never a capture lock. */
export async function enrollBrowser(
  enrollment: CollectorEnrollment,
  fallback: CollectorCredential,
  options: SharedEnrollmentOptions,
): Promise<{ credential: CollectorCredential; persistent: boolean }> {
  return options.lock("qqsg-collector-enrollment-v1", async () => {
    let saved: CollectorCredential | undefined;
    try {
      saved = options.read();
    } catch {}
    const credential = await enrollment.ensure(saved ?? fallback);
    try {
      options.save(credential);
      return { credential, persistent: true };
    } catch {
      return { credential, persistent: false };
    }
  });
}
export function readCollectorCredential(
  storage: Pick<Storage, "getItem">,
): CollectorCredential | undefined {
  const saved = JSON.parse(storage.getItem(COLLECTOR_STORAGE_KEY) ?? "null");
  if (
    typeof saved?.sourceId === "string" &&
    saved.sourceId &&
    typeof saved?.token === "string" &&
    saved.token
  )
    return { sourceId: saved.sourceId, token: saved.token };
}
