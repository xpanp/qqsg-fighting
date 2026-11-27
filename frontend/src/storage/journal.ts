import type { MergedMessage, RecordingSegment } from "../../../contracts/types";
export type Segment = RecordingSegment;
export interface DirectoryHandle {
  name: string;
  removeEntry?(name: string): Promise<void>;
  getFileHandle(
    name: string,
    options?: { create: boolean },
  ): Promise<{
    createWritable(): Promise<{
      write(data: Blob): Promise<void>;
      close(): Promise<void>;
      abort(): Promise<void>;
    }>;
  }>;
}
export async function chooseDirectory(): Promise<DirectoryHandle> {
  const picker = (
    window as Window & {
      showDirectoryPicker?: (options: object) => Promise<DirectoryHandle>;
    }
  ).showDirectoryPicker;
  if (!picker)
    throw Error(
      "请选择桌面版 Chrome 或 Edge；当前浏览器不支持直接保存到目录。",
    );
  return picker.call(window, { mode: "readwrite" });
}
export type DirectoryWritePhase =
  | "create-file"
  | "create-writable"
  | "write"
  | "close";
export class DirectoryWriteError extends Error {
  readonly originalName: string;
  constructor(
    readonly directory: string,
    readonly phase: DirectoryWritePhase,
    cause: unknown,
  ) {
    const name = cause instanceof Error ? cause.name : "Error",
      detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `目录“${directory || "所选目录"}”写入验证失败（${phase}，${name}）：${detail}。请重新选择可写目录。`,
      { cause },
    );
    this.name = "DirectoryWriteError";
    this.originalName = name;
  }
}
/** Test the real write/close path, without changing a user's existing files. */
export async function verifyDirectoryWritable(
  folder: DirectoryHandle,
): Promise<{ warning?: string }> {
  const name = ".qqsg-write-check-" + crypto.randomUUID() + ".tmp";
  let phase: DirectoryWritePhase = "create-file",
    created = false,
    closed = false,
    stream:
      | Awaited<
          ReturnType<
            Awaited<
              ReturnType<DirectoryHandle["getFileHandle"]>
            >["createWritable"]
          >
        >
      | undefined;
  let failure: DirectoryWriteError | undefined, warning: string | undefined;
  try {
    const file = await folder.getFileHandle(name, { create: true });
    created = true;
    phase = "create-writable";
    stream = await file.createWritable();
    phase = "write";
    await stream.write(
      new Blob(["QQSG directory write verification\n"], { type: "text/plain" }),
    );
    phase = "close";
    await stream.close();
    closed = true;
  } catch (error) {
    failure = new DirectoryWriteError(folder.name, phase, error);
  } finally {
    if (stream && !closed)
      try {
        await stream.abort();
      } catch {}
    if (created) {
      if (folder.removeEntry)
        try {
          await folder.removeEntry(name);
        } catch {
          warning = `目录可写，但测试文件未能自动清理：${name}`;
        }
      else warning = `目录可写；浏览器不支持自动清理测试文件：${name}`;
    }
  }
  if (failure) throw failure;
  return warning ? { warning } : {};
}
let opened: Promise<IDBDatabase> | undefined;
export function database() {
  return (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("qqsg-recorder-v1", 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore("segments", { keyPath: "id" });
      db.createObjectStore("chunks", { keyPath: ["segmentId", "index"] });
      db.createObjectStore("messages", { keyPath: "id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => {
      opened = undefined;
      reject(r.error);
    };
    r.onblocked = () => reject(Error("请关闭其他录制页面后重试"));
  }));
}
async function write(stores: string[], action: (tx: IDBTransaction) => void) {
  const db = await database();
  return new Promise<void>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(stores, "readwrite", { durability: "strict" });
    } catch {
      tx = db.transaction(stores, "readwrite");
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || Error("本机缓存写入中断"));
    try {
      action(tx);
    } catch (e) {
      tx.abort();
      reject(e);
    }
  });
}
async function read<T>(store: string, key?: IDBValidKey) {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const st = db.transaction(store).objectStore(store),
      r = key === undefined ? st.getAll() : st.get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function createSegment(
  meta: Omit<
    Segment,
    "chunkCount" | "bytes" | "status" | "schemaVersion" | "sourceId"
  >,
) {
  const row = {
    ...meta,
    schemaVersion: 1,
    sourceId: meta.sessionId,
    chunkCount: 0,
    bytes: 0,
    status: "recording",
  } as Segment;
  await write(["segments"], (tx) => tx.objectStore("segments").add(row));
  return row;
}
export async function appendChunk(
  id: string,
  index: number,
  blob: Blob,
  timing: object,
) {
  await write(["segments", "chunks"], (tx) => {
    tx.objectStore("chunks").add({ segmentId: id, index, blob, ...timing });
    const r = tx.objectStore("segments").get(id);
    r.onsuccess = () => {
      if (!r.result) {
        tx.abort();
        return;
      }
      tx.objectStore("segments").put({
        ...r.result,
        chunkCount: index + 1,
        bytes: r.result.bytes + blob.size,
        lastChunk: timing,
      });
    };
  });
}
export async function finishSegment(id: string, updates: Partial<Segment>) {
  await write(["segments"], (tx) => {
    const r = tx.objectStore("segments").get(id);
    r.onsuccess = () => {
      if (!r.result) {
        tx.abort();
        return;
      }
      tx.objectStore("segments").put({ ...r.result, ...updates });
    };
  });
}
export async function listSegments() {
  return (await read<Segment[]>("segments")).sort(
    (a, b) => b.startedUtcMs - a.startedUtcMs,
  );
}
export function getSegment(id: string) {
  return read<Segment>("segments", id);
}
export async function recoverBlob(id: string) {
  const db = await database();
  const rows = await new Promise<{ index: number; blob: Blob }[]>(
    (resolve, reject) => {
      const r = db
        .transaction("chunks")
        .objectStore("chunks")
        .getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    },
  );
  rows.sort((a, b) => a.index - b.index);
  if (!rows.length) throw Error("没有可恢复的数据块");
  if (rows.some((r, i) => r.index !== i))
    throw Error("数据块不连续，请保留缓存并联系维护者");
  return new Blob(
    rows.map((r) => r.blob),
    { type: "video/webm" },
  );
}
export async function saveMessages(rows: MergedMessage[]) {
  if (!rows.length) return;
  await write(["messages"], (tx) => {
    for (const row of rows) tx.objectStore("messages").put(row);
  });
}
export function messages() {
  return read<MergedMessage[]>("messages");
}
/** Read a bounded page without upgrading the recording database or loading all history. */
export async function messagePage(
  after?: string,
  limit = 100,
): Promise<{ rows: MergedMessage[]; after?: string }> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const rows: MergedMessage[] = [];
    const r = db
      .transaction("messages")
      .objectStore("messages")
      .openCursor(after ? IDBKeyRange.lowerBound(after, true) : undefined);
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const c = r.result;
      if (!c) {
        resolve({ rows });
        return;
      }
      rows.push(c.value);
      if (rows.length >= limit) {
        resolve({ rows, after: String(c.key) });
        return;
      }
      c.continue();
    };
  });
}
// A tab may record or recover, but recovery must never consume another live tab's chunks.
const captureLockName = "qqsg-capture-or-recovery-v1";
export async function acquireCaptureLease(): Promise<() => void> {
  if (!navigator.locks)
    throw Error("当前浏览器不支持安全录制锁，请更新桌面 Chrome 或 Edge。");
  return new Promise((resolve, reject) => {
    void navigator.locks
      .request(captureLockName, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          reject(Error("另一个页面正在录制或恢复，请先停止后再试。"));
          return;
        }
        await new Promise<void>((release) => resolve(release));
      })
      .catch(reject);
  });
}
export async function recoverSegmentFiles(id: string, folder: DirectoryHandle) {
  if (!navigator.locks) throw Error("请更新桌面 Chrome 或 Edge 后恢复片段。");
  return navigator.locks.request(
    captureLockName,
    { ifAvailable: true },
    async (lock) => {
      if (!lock) throw Error("有页面仍在录制或恢复，请先停止所有录制后重试。");
      const segment = await getSegment(id);
      if (segment.status === "recording") {
        await finishSegment(id, {
          status: "error",
          errors: ["页面异常结束，仅恢复已提交数据"],
        });
      }
      return writeSegmentFiles(id, folder);
    },
  );
}
export async function writeSegmentFiles(id: string, folder: DirectoryHandle) {
  const meta = await getSegment(id),
    blob = await recoverBlob(id);
  const base =
    new Date(meta.startedUtcMs)
      .toISOString()
      .replaceAll(":", "-")
      .replace("T", "_") +
    "_" +
    meta.sessionId +
    "_" +
    String(meta.segment + 1).padStart(3, "0");
  for (const [name, data] of [
    [base + ".webm", blob],
    [
      base + ".json",
      new Blob([JSON.stringify(meta, null, 2)], { type: "application/json" }),
    ],
  ] as const) {
    const file = await folder.getFileHandle(name, { create: true }),
      stream = await file.createWritable();
    try {
      await stream.write(data);
      await stream.close();
    } catch (e) {
      try {
        await stream.abort();
      } catch {}
      throw e;
    }
  }
  await finishSegment(id, { savedToDirectory: true, fileName: base + ".webm" });
  await write(["chunks"], (tx) =>
    tx
      .objectStore("chunks")
      .delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])),
  );
  return base + ".webm";
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
