export interface OcrResult {
  provider: string;
  skipped?: boolean;
  elapsedMs: number;
  lines: { text: string; box: number[]; confidence: number }[];
}
export class OcrClient {
  private worker: Worker;
  private sequence = 0;
  private closed = false;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor() {
    this.worker = new Worker(new URL("./worker.js", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = ({ data }) => {
      const item = this.pending.get(data.id);
      if (!item) return;
      clearTimeout(item.timer);
      this.pending.delete(data.id);
      data.error ? item.reject(Error(data.error)) : item.resolve(data.result);
    };
    this.worker.onerror = (e) =>
      this.close(Error(e.message || "识别进程异常，请重试识别"));
  }
  call<T = any>(type: string, args: object = {}): Promise<T> {
    if (this.closed) return Promise.reject(Error("识别进程已停止"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.close(Error("识别超时，录像继续。请点击重试识别。")),
        180000,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker.postMessage({
          id,
          type,
          baseUrl: new URL(import.meta.env.BASE_URL, location.href).href,
          ...args,
        });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  init() {
    return this.call<{ provider: string }>("init");
  }
  recognize(image: ImageData) {
    return this.call<OcrResult>("stream-frame", { image });
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
