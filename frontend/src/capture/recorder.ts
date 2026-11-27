import * as defaultJournal from "../storage/journal";
import type { DirectoryHandle } from "../storage/journal";

type Journal = Pick<
  typeof defaultJournal,
  "createSegment" | "appendChunk" | "finishSegment" | "writeSegmentFiles"
>;
export interface RecordingIssue {
  id?: string;
  phase: string;
  name: string;
  message: string;
  atMs: number;
}
export interface RecorderStatus {
  event: string;
  id?: string;
  error?: string;
  issue?: RecordingIssue;
  bytes?: number;
  fileName?: string;
  savedToDirectory?: boolean;
}
interface Options {
  folder?: DirectoryHandle;
  segmentSeconds?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
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
  stopped: Promise<void>;
  releaseStopped: () => void;
  stoppedEvent: boolean;
  stopRequested: boolean;
  finalizing: boolean;
  dataFailed: boolean;
  issues: RecordingIssue[];
  index: number;
  written: number;
  startedUtc?: number;
  startedMono?: number;
  endedUtc?: number;
  endedMono?: number;
  timer?: ReturnType<typeof setTimeout>;
  stopTimer?: ReturnType<typeof setTimeout>;
  cancelStart?: (error?: Error) => void;
}
const errorInfo = (error: unknown) => ({
  name:
    error instanceof Error || error instanceof DOMException
      ? error.name
      : "Error",
  message:
    error instanceof Error || error instanceof DOMException
      ? error.message
      : String(error),
});
export class DurableRecorder {
  readonly sessionId: string;
  readonly errors: string[] = [];
  readonly issues: RecordingIssue[] = [];
  savedSegments = 0;
  private items: Item[] = [];
  private running = false;
  private serial: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private sequence = 0;
  private journal: Journal;
  private now: () => number;
  private mono: () => number;
  constructor(
    private stream: MediaStream,
    private opts: Options = {},
  ) {
    this.sessionId = opts.sessionId ?? crypto.randomUUID();
    this.journal = opts.journal ?? defaultJournal;
    this.now = opts.now ?? (() => Date.now());
    this.mono = opts.mono ?? (() => performance.now());
  }
  private emit(event: RecorderStatus) {
    try {
      this.opts.onStatus?.(event);
    } catch (e) {
      console.error(e);
    }
  }
  private report(error: unknown, id: string | undefined, phase: string) {
    const issue: RecordingIssue = {
      ...errorInfo(error),
      id,
      phase,
      atMs: this.now(),
    };
    this.issues.push(issue);
    const message = `${issue.name}: ${issue.message} [${phase}${id ? ` · ${id}` : ""}]`;
    this.errors.push(message);
    const item = this.items.find((i) => i.id === id);
    item?.issues.push(issue);
    if (this.running) {
      this.running = false;
      this.generation++;
    }
    for (const current of this.items) {
      clearTimeout(current.timer);
      if (current.recorder.state !== "inactive") this.requestStop(current);
    }
    this.emit({ event: "error", id, error: message, issue });
    return issue;
  }
  private requestStop(item: Item) {
    if (item.stopRequested || item.stoppedEvent) return;
    item.stopRequested = true;
    item.stopTimer = setTimeout(() => {
      if (item.stoppedEvent) return;
      item.dataFailed = true;
      item.endedUtc = this.now();
      item.endedMono = this.mono();
      this.report(
        Error("浏览器编码器停止超时，保留已缓存数据"),
        item.id,
        "encoder-stop",
      );
      item.releaseStopped();
      void this.finalize(item);
    }, this.opts.stopTimeoutMs ?? 10000);
    try {
      item.recorder.stop();
    } catch (error) {
      clearTimeout(item.stopTimer);
      item.dataFailed = true;
      item.endedUtc = this.now();
      item.endedMono = this.mono();
      this.report(error, item.id, "encoder-stop");
      item.releaseStopped();
      void this.finalize(item);
    }
  }
  private async finalize(item: Item) {
    if (item.finalizing) return;
    item.finalizing = true;
    try {
      await item.queue;
      if (!item.written && !item.dataFailed) {
        item.dataFailed = true;
        this.report(
          Error("这一段没有收到视频数据，未生成视频文件"),
          item.id,
          "empty-segment",
        );
      }
      await this.journal.finishSegment(item.id, {
        status: item.dataFailed ? "error" : "complete",
        endedUtcMs: item.endedUtc ?? this.now(),
        endedMono: item.endedMono ?? this.mono(),
        ...(item.startedUtc === undefined
          ? {}
          : { startedUtcMs: item.startedUtc, startedMono: item.startedMono }),
        errors: item.issues.map((e) => `${e.name}: ${e.message} [${e.phase}]`),
        recordingIssues: item.issues,
      });
      let fileName: string | undefined;
      if (this.opts.folder && item.written && !item.dataFailed) {
        try {
          fileName = await this.journal.writeSegmentFiles(
            item.id,
            this.opts.folder,
          );
        } catch (error) {
          this.report(error, item.id, "save-files");
          // Encoded chunks remain in IndexedDB; record the cause for later recovery.
          await this.journal.finishSegment(item.id, {
            errors: item.issues.map(
              (e) => `${e.name}: ${e.message} [${e.phase}]`,
            ),
            recordingIssues: item.issues,
          });
        }
      }
      if (fileName) this.savedSegments++;
      this.emit({
        event: "segment",
        id: item.id,
        fileName,
        savedToDirectory: !!fileName,
      });
    } catch (error) {
      this.report(error, item.id, "finalize-cache");
    } finally {
      item.resolve();
    }
  }
  async start() {
    if (this.running) throw Error("已经在录制");
    this.running = true;
    const token = ++this.generation;
    this.serial = this.next(token);
    await this.serial;
  }
  private async next(token: number) {
    if (!this.running || token !== this.generation) return;
    const id = this.sessionId + "/" + this.sequence++;
    let phase = "create-segment",
      created = false,
      item: Item | undefined;
    try {
      const mimeType = ["video/webm;codecs=vp8", "video/webm"].find((t) =>
        MediaRecorder.isTypeSupported(t),
      );
      if (!mimeType) throw Error("浏览器不支持 WebM 录制");
      await this.journal.createSegment({
        id,
        sessionId: this.sessionId,
        segment: this.sequence - 1,
        mimeType,
        startedUtcMs: this.now(),
        startedMono: this.mono(),
        timeOrigin: performance.timeOrigin,
        ...this.opts.metadata,
      });
      created = true;
      if (!this.running || token !== this.generation) {
        await this.journal.finishSegment(id, {
          status: "error",
          endedUtcMs: this.now(),
          errors: ["录制开始前已停止"],
        });
        return;
      }
      phase = "construct-encoder";
      const recorder =
        this.opts.recorderFactory?.(this.stream, mimeType) ??
        new MediaRecorder(this.stream, { mimeType });
      let resolve!: () => void, releaseStopped!: () => void;
      const done = new Promise<void>((r) => (resolve = r)),
        stopped = new Promise<void>((r) => (releaseStopped = r));
      const current: Item = {
        id,
        recorder,
        queue: Promise.resolve(),
        done,
        resolve,
        stopped,
        releaseStopped,
        stoppedEvent: false,
        stopRequested: false,
        finalizing: false,
        dataFailed: false,
        issues: [],
        index: 0,
        written: 0,
      };
      item = current;
      this.items.push(current);
      recorder.ondataavailable = (e) => {
        if (!e.data.size || current.finalizing) return;
        const index = current.index++,
          timing = {
            receivedUtcMs: this.now(),
            receivedMono: this.mono(),
            blobTimecode: e.timecode,
          };
        current.queue = current.queue.then(async () => {
          if (current.dataFailed) return;
          try {
            await this.journal.appendChunk(id, index, e.data, timing);
            current.written++;
            this.emit({ event: "chunk", id, bytes: e.data.size });
          } catch (error) {
            current.dataFailed = true;
            this.report(error, id, "append-chunk");
          }
        });
      };
      recorder.onstop = () => {
        if (current.stoppedEvent) return;
        current.stoppedEvent = true;
        current.endedUtc = this.now();
        current.endedMono = this.mono();
        clearTimeout(current.timer);
        clearTimeout(current.stopTimer);
        current.cancelStart?.(Error("录制启动已中断"));
        // Release the encoder before file I/O. No overlap, and slow saving doesn't delay the successor.
        current.releaseStopped();
        if (!current.stopRequested && this.running)
          this.report(
            Error("浏览器编码器意外停止，请检查已保存片段"),
            current.id,
            "unexpected-encoder-stop",
          );
        void this.finalize(current);
      };
      recorder.onerror = (e) => {
        const error =
          (e as Event & { error?: Error }).error ?? Error("浏览器录制发生错误");
        current.dataFailed = true;
        current.cancelStart?.(error);
        this.report(error, id, "encoder");
        if (recorder.state === "inactive" && !current.stoppedEvent) {
          current.releaseStopped();
          void this.finalize(current);
        }
      };
      phase = "start-encoder";
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const complete = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          current.cancelStart = undefined;
          error ? reject(error) : resolve();
        };
        const timeout = setTimeout(
          () => complete(Error("浏览器录制启动超时")),
          this.opts.startTimeoutMs ?? 10000,
        );
        current.cancelStart = (error) =>
          complete(error ?? Error("录制启动已中断"));
        recorder.onstart = () => {
          current.startedUtc = this.now();
          current.startedMono = this.mono();
          complete();
        };
        try {
          recorder.start(1000);
        } catch (error) {
          complete(error instanceof Error ? error : Error(String(error)));
        }
      });
      this.emit({ event: "started", id });
      if (!this.running || token !== this.generation) {
        if (recorder.state !== "inactive") this.requestStop(current);
        return;
      }
      current.timer = setTimeout(
        () => {
          this.serial = this.serial
            .then(async () => {
              if (!this.running || token !== this.generation) return;
              this.requestStop(current);
              await current.stopped;
              if (this.running && token === this.generation)
                await this.next(token);
            })
            .catch(() => {}); // next() already recorded the precise segment and stage.
        },
        (this.opts.segmentSeconds ?? 60) * 1000,
      );
    } catch (error) {
      if (item) item.dataFailed = true;
      const issue = this.report(error, id, phase);
      if (item) {
        if (item.recorder.state !== "inactive") this.requestStop(item);
        else if (!item.stoppedEvent) {
          item.releaseStopped();
          void this.finalize(item);
        }
      } else if (created) {
        try {
          await this.journal.finishSegment(id, {
            status: "error",
            endedUtcMs: this.now(),
            errors: [`${issue.name}: ${issue.message} [${phase}]`],
            recordingIssues: [issue],
          });
        } catch (persistError) {
          this.report(persistError, id, "persist-start-error");
        }
      }
      throw error;
    }
  }
  async stop() {
    this.running = false;
    this.generation++;
    for (const item of this.items) {
      clearTimeout(item.timer);
      item.cancelStart?.();
    }
    await this.serial.catch(() => {});
    for (const item of this.items)
      if (item.recorder.state !== "inactive" && !item.stopRequested)
        this.requestStop(item);
    await Promise.all(this.items.map((item) => item.done));
  }
}
