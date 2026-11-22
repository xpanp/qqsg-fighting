import type { MergedMessage } from "../../../contracts/types";
import type { DirectoryHandle } from "./journal";

export interface ArchiveResult {
  fileName: string;
  jsonFileName: string;
  savedAtMs: number;
  count: number;
}
export interface ArchiveStatus {
  state: "saving" | "saved" | "error";
  result?: ArchiveResult;
  error?: string;
}
interface Options {
  folder: DirectoryHandle;
  sessionId: string;
  startedAtMs: number;
  intervalMs?: number;
  onStatus?: (status: ArchiveStatus) => void;
}

/** Per-session replaceable snapshots. No append log, so OCR revisions cannot duplicate rows. */
export class MessageArchive {
  private rows = new Map<string, MergedMessage>();
  private generation = 0;
  private savedGeneration = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private result?: ArchiveResult;
  private readonly base: string;

  constructor(private readonly options: Options) {
    // Session identifiers must never introduce path separators into user-directory filenames.
    const session = options.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    this.base =
      new Date(options.startedAtMs).toISOString().replaceAll(":", "-") +
      "_" +
      session +
      "_messages";
  }

  update(rows: MergedMessage[]): void {
    for (const row of rows) {
      if (row.sessionId !== this.options.sessionId) continue;
      const previous = this.rows.get(row.id);
      if (previous && row.revision < previous.revision) continue;
      if (previous && JSON.stringify(previous) === JSON.stringify(row))
        continue;
      this.rows.set(row.id, { ...row });
      this.generation++;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush().catch(() => {}); // Errors are surfaced via onStatus; dirty state remains retryable.
    }, this.options.intervalMs ?? 60000);
  }

  flush(): Promise<ArchiveResult | undefined> {
    const operation = this.queue.then(() => this.writeSnapshot());
    this.queue = operation.catch(() => {});
    return operation;
  }

  async stop(): Promise<ArchiveResult | undefined> {
    clearInterval(this.timer);
    this.timer = undefined;
    return this.flush();
  }

  private emit(status: ArchiveStatus): void {
    try {
      this.options.onStatus?.(status);
    } catch {
      /* UI errors cannot invalidate file persistence. */
    }
  }

  private async writeSnapshot(): Promise<ArchiveResult | undefined> {
    if (!this.rows.size || this.generation === this.savedGeneration)
      return undefined;
    const revision = this.generation;
    const messages = [...this.rows.values()]
      .map((row) => ({ ...row }))
      .sort(
        (a, b) =>
          a.firstObservedAtMs - b.firstObservedAtMs || a.id.localeCompare(b.id),
      );
    const savedAtMs = Date.now();
    const fileName = this.base + ".txt";
    const jsonFileName = this.base + ".json";
    const text =
      messages
        .map(
          (row) =>
            `${new Date(row.firstObservedAtMs).toISOString()}  ${row.text}`,
        )
        .join("\r\n") + "\r\n";
    const json = JSON.stringify(
      {
        schemaVersion: 1,
        kind: "merged-message-snapshot",
        sessionId: this.options.sessionId,
        startedAtMs: this.options.startedAtMs,
        savedAtMs,
        messageCount: messages.length,
        messages,
      },
      null,
      2,
    );
    this.emit({ state: "saving" });
    try {
      for (const [name, blob] of [
        [
          fileName,
          new Blob(["\uFEFF", text], { type: "text/plain;charset=utf-8" }),
        ],
        [jsonFileName, new Blob([json], { type: "application/json" })],
      ] as const) {
        const handle = await this.options.folder.getFileHandle(name, {
          create: true,
        });
        const writable = await handle.createWritable();
        try {
          await writable.write(blob);
          await writable.close();
        } catch (error) {
          try {
            await writable.abort();
          } catch {}
          throw error;
        }
      }
      this.savedGeneration = revision;
      this.result = {
        fileName,
        jsonFileName,
        savedAtMs,
        count: messages.length,
      };
      this.emit({ state: "saved", result: { ...this.result } });
      return { ...this.result };
    } catch (error) {
      this.emit({
        state: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
