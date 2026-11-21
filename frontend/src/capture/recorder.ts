import * as defaultJournal from "../storage/journal";
import type { DirectoryHandle } from "../storage/journal";
type Journal = Pick<
  typeof defaultJournal,
  "createSegment" | "appendChunk" | "finishSegment" | "writeSegmentFiles"
>;
export interface RecorderStatus {
  event: string;
  id?: string;
  error?: string;
  bytes?: number;
  fileName?: string;
  savedToDirectory?: boolean;
}
interface Options {
  folder?: DirectoryHandle;
  segmentSeconds?: number;
  startTimeoutMs?: number;
  sessionId?: string;
  metadata?: object;
  onStatus?: (event: RecorderStatus) => void;
  journal?: Journal;
  recorderFactory?: (stream: MediaStream, mimeType: string) => MediaRecorder;
  now?: () => number;
  mono?: () => number;
}
interface Item {
  id: string;
  recorder: MediaRecorder;
  queue: Promise<void>;
  done: Promise<void>;
  resolve: () => void;
  index: number;
  stopped: boolean;
  timer?: ReturnType<typeof setTimeout>;
  cancelStart?: (error?: Error) => void;
}
export class DurableRecorder {
  readonly sessionId: string;
  readonly errors: string[] = [];
  savedSegments = 0;
  private items: Item[] = [];
  private running = false;
  private serial: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private journal: Journal;
  private now: () => number;
  private mono: () => number;
  private opts: Options;
  private sequence = 0;
  constructor(
    private stream: MediaStream,
    options: Options = {},
  ) {
    this.opts = options;
    this.sessionId = options.sessionId ?? crypto.randomUUID();
    this.journal = options.journal ?? defaultJournal;
    this.now = options.now ?? (() => Date.now());
    this.mono = options.mono ?? (() => performance.now());
  }
  private emit(event: RecorderStatus) {
    try {
      this.opts.onStatus?.(event);
    } catch (e) {
      console.error(e);
    }
  }
  private async fail(error: unknown, id?: string) {
    const message = error instanceof Error ? error.message : String(error);
    this.errors.push(message);
    this.running = false;
    this.generation++;
    this.emit({ event: "error", id, error: message });
    for (const item of this.items) {
      clearTimeout(item.timer);
      if (item.recorder.state !== "inactive")
        try {
          item.recorder.stop();
        } catch {
          item.resolve();
        }
    }
  }
  async start() {
    if (this.running) throw Error("已经在录制");
    this.running = true;
    const token = ++this.generation;
    this.serial = this.next(token);
    try {
      await this.serial;
    } catch (e) {
      await this.fail(e);
      throw e;
    }
  }
  private async next(token: number) {
    if (!this.running || token !== this.generation) return;
    const mimeType = ["video/webm;codecs=vp8", "video/webm"].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    if (!mimeType) throw Error("浏览器不支持 WebM 录制");
    const segment = this.sequence++,
      id = this.sessionId + "/" + segment;
    await this.journal.createSegment({
      id,
      sessionId: this.sessionId,
      segment,
      mimeType,
      startedUtcMs: this.now(),
      startedMono: this.mono(),
      timeOrigin: performance.timeOrigin,
      ...this.opts.metadata,
    });
    if (!this.running || token !== this.generation) {
      await this.journal.finishSegment(id, {
        status: "error",
        endedUtcMs: this.now(),
        errors: ["录制开始前已停止"],
      });
      return;
    }
    const recorder =
      this.opts.recorderFactory?.(this.stream, mimeType) ??
      new MediaRecorder(this.stream, { mimeType });
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r)),
      item: Item = {
        id,
        recorder,
        queue: Promise.resolve(),
        done,
        resolve,
        index: 0,
        stopped: false,
      };
    this.items.push(item);
    recorder.ondataavailable = (e) => {
      if (!e.data.size) return;
      const index = item.index++,
        timing = {
          receivedUtcMs: this.now(),
          receivedMono: this.mono(),
          blobTimecode: e.timecode,
        };
      item.queue = item.queue
        .then(() => this.journal.appendChunk(id, index, e.data, timing))
        .then(() => this.emit({ event: "chunk", id, bytes: e.data.size }))
        .catch((e) => this.fail(e, id));
    };
    recorder.onstop = () => {
      item.cancelStart?.();
      if (item.stopped) return;
      item.stopped = true;
      clearTimeout(item.timer);
      void (async () => {
        try {
          await item.queue;
          if (!item.index && !this.errors.length) {
            await this.fail(
              Error("这一段没有收到视频数据，未生成视频文件"),
              id,
            );
          }
          await this.journal.finishSegment(id, {
            status: this.errors.length ? "error" : "complete",
            endedUtcMs: this.now(),
            endedMono: this.mono(),
            errors: [...this.errors],
          });
          let fileName: string | undefined;
          if (this.opts.folder && item.index && !this.errors.length)
            fileName = await this.journal.writeSegmentFiles(
              id,
              this.opts.folder,
            );
          if (fileName) this.savedSegments++;
          this.emit({
            event: "segment",
            id,
            fileName,
            savedToDirectory: !!fileName,
          });
        } catch (e) {
          await this.fail(e, id);
        } finally {
          item.resolve();
        }
      })();
    };
    recorder.onerror = (e) => {
      const error =
        (e as Event & { error?: Error }).error ?? Error("浏览器录制发生错误");
      item.cancelStart?.(error);
      void this.fail(error, id);
    };
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const complete = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          item.cancelStart = undefined;
          error ? reject(error) : resolve();
        };
        const timeout = setTimeout(
          () => complete(Error("浏览器录制启动超时")),
          this.opts.startTimeoutMs ?? 10000,
        );
        item.cancelStart = (error) =>
          complete(error ?? Error("录制启动已中断"));
        recorder.onstart = () => complete();
        try {
          recorder.start(1000);
        } catch (e) {
          complete(e instanceof Error ? e : Error(String(e)));
        }
      });
    } catch (e) {
      item.resolve();
      await this.journal.finishSegment(id, {
        status: "error",
        endedUtcMs: this.now(),
        errors: [String(e)],
      });
      throw e;
    }
    this.emit({ event: "started", id });
    if (!this.running || token !== this.generation) {
      if (recorder.state !== "inactive") recorder.stop();
      return;
    }
    item.timer = setTimeout(
      () => {
        this.serial = this.serial.then(async () => {
          if (!this.running || token !== this.generation) return;
          try {
            await this.next(token);
            if (recorder.state !== "inactive") recorder.stop();
          } catch (e) {
            await this.fail(e, id);
          }
        });
      },
      (this.opts.segmentSeconds ?? 60) * 1000,
    );
  }
  async stop() {
    this.running = false;
    this.generation++;
    for (const item of this.items) item.cancelStart?.();
    await this.serial.catch(() => {});
    for (const item of this.items) {
      clearTimeout(item.timer);
      if (item.recorder.state !== "inactive")
        try {
          item.recorder.stop();
        } catch (e) {
          await this.fail(e, item.id);
          item.resolve();
        }
    }
    await Promise.all(this.items.map((i) => i.done));
  }
}
