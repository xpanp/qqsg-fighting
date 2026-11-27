import type { ResourceProgress } from "./resources";
export interface OcrResult {
  provider: string;
  skipped?: boolean;
  elapsedMs: number;
  lines: { text: string; box: number[]; confidence: number }[];
  diagnostics?: { detectedLines: number; droppedLines: number };
}
export interface OcrProgress extends Omit<ResourceProgress, "stage"> {
  stage:
    | ResourceProgress["stage"]
    | "configuration"
    | "initializing"
    | "ready"
    | "recognizing";
  completed?: number;
  elapsedMs?: number;
}
export interface OcrInfo {
  provider: string;
  cacheHit?: boolean;
  runtimeCacheHit?: boolean;
  warnings?: string[];
}
interface ClientOptions {
  workerFactory?: () => Worker;
  baseUrl?: string;
  onProgress?: (progress: OcrProgress) => void;
  initTimeoutMs?: number;
  inferenceTimeoutMs?: number;
  identityTimeoutMs?: number;
}
export class OcrClient {
  private worker: Worker;
  private sequence = 0;
  private closed = false;
  private baseUrl: string;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      timeoutMs: number;
      initializing: boolean;
    }
  >();
  constructor(private options: ClientOptions = {}) {
    this.baseUrl =
      options.baseUrl ??
      new URL(
        import.meta.env?.BASE_URL ?? "/",
        globalThis.location?.href ?? "http://localhost/",
      ).href;
    this.worker =
      options.workerFactory?.() ??
      new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = ({ data }) => {
      const item = this.pending.get(data.id);
      if (!item) return;
      if (data.type === "progress") {
        // Download progress is not the completion of an RPC request.
        if (item.initializing) {
          clearTimeout(item.timer);
          item.timer = this.timeout(item.timeoutMs);
        }
        try {
          options.onProgress?.(data.progress);
        } catch (e) {
          console.error(e);
        }
        return;
      }
      clearTimeout(item.timer);
      this.pending.delete(data.id);
      data.error ? item.reject(Error(data.error)) : item.resolve(data.result);
    };
    this.worker.onerror = (e) =>
      this.close(Error(e.message || "识别进程异常，请重试识别"));
  }
  private timeout(ms: number) {
    return setTimeout(
      () =>
        this.close(
          Error("识别准备或运行长时间没有响应，录像不受影响。请点击重试识别。"),
        ),
      ms,
    );
  }
  call<T = any>(
    type: string,
    args: object = {},
    transfer: Transferable[] = [],
    deadlineMs?: number,
  ): Promise<T> {
    if (this.closed) return Promise.reject(Error("识别进程已停止"));
    const id = ++this.sequence;
    const initializing = type === "init";
    const timeoutMs =
      deadlineMs ??
      (initializing
        ? (this.options.initTimeoutMs ?? 600000)
        : (this.options.inferenceTimeoutMs ?? 180000));
    return new Promise((resolve, reject) => {
      const timer = this.timeout(timeoutMs);
      this.pending.set(id, { resolve, reject, timer, timeoutMs, initializing });
      try {
        this.worker.postMessage(
          { id, type, baseUrl: this.baseUrl, ...args },
          transfer,
        );
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  init() {
    return this.call<OcrInfo>("init");
  }
  recognize(image: ImageData) {
    return this.call<OcrResult>("stream-frame", { image }, [
      image.data.buffer as ArrayBuffer,
    ]);
  }
  readIdentity(title: ImageData, character: ImageData) {
    return this.call<{ title: string; character: string }>(
      "identity",
      { title, character },
      [title.data.buffer as ArrayBuffer, character.data.buffer as ArrayBuffer],
      this.options.identityTimeoutMs ?? 5000,
    );
  }
  get isClosed() {
    return this.closed;
  }
  close(reason = Error("识别已停止")) {
    this.closed = true;
    this.worker.terminate();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
  }
}
