import type { MergedMessage } from "../../../contracts/types";
import type { SyncContext } from "../../../contracts/sync";
export interface SessionGrant {
  sessionId: string;
  sourceId: string;
  context: SyncContext;
  captureSessionId?: string;
  captureFromMs?: number;
}
export interface CaptureIntent {
  id: string;
  captureSessionId: string;
  observedAtMs: number;
  context: SyncContext;
}
export interface QueueRow {
  key: string;
  sourceId: string;
  sessionId: string;
  message: MergedMessage;
  ackRevision: number;
  rejected?: string;
  state: "pending" | "rejected";
}
export class Outbox {
  private opened?: Promise<IDBDatabase>;
  constructor(
    readonly limit = 5000,
    readonly name = "qqsg-sync-v2",
  ) {}
  private db() {
    return (this.opened ??= new Promise((resolve, reject) => {
      const r = indexedDB.open(this.name, 3);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains("sessions")) {
          db.createObjectStore("sessions", { keyPath: "sessionId" });
          const q = db.createObjectStore("queue", { keyPath: "key" });
          q.createIndex("sourceState", ["sourceId", "state"]);
          q.createIndex("sessionId", "sessionId");
          db.createObjectStore("receipts", { keyPath: "key" }).createIndex(
            "sessionId",
            "sessionId",
          );
        }
        if (!db.objectStoreNames.contains("intents"))
          db.createObjectStore("intents", { keyPath: "id" });
        if (!db.objectStoreNames.contains("assignments"))
          db.createObjectStore("assignments", { keyPath: "key" }).createIndex(
            "sessionId",
            "sessionId",
          );
      };
      r.onsuccess = () => {
        r.result.onversionchange = () => {
          r.result.close();
          this.opened = undefined;
        };
        resolve(r.result);
      };
      r.onerror = () => {
        this.opened = undefined;
        reject(r.error);
      };
      r.onblocked = () => {
        this.opened = undefined;
        reject(Error("同步存储暂不可用，录像继续"));
      };
    }));
  }
  private async transaction<T>(
    store: string,
    mode: IDBTransactionMode,
    action: (s: IDBObjectStore, result: (v: T) => void) => void,
  ): Promise<T> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(
        ["queue", "receipts", "sessions", "assignments", "intents"],
        mode,
      );
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? Error("同步缓存事务中断"));
      try {
        action(tx.objectStore(store), (v) => {
          value = v;
        });
      } catch (e) {
        tx.abort();
        reject(e);
      }
    });
  }
  rememberCapture(intent: CaptureIntent) {
    return this.transaction<void>("intents", "readwrite", (s) => {
      const exists = s.get(intent.id);
      exists.onsuccess = () => {
        if (exists.result) return;
        const count = s.count();
        count.onsuccess = () => {
          if (count.result >= 1000) s.transaction.abort();
          else s.put(intent);
        };
      };
    });
  }
  captureIntents(): Promise<CaptureIntent[]> {
    return this.transaction("intents", "readonly", (s, result) => {
      const r = s.getAll();
      r.onsuccess = () => result(r.result);
    });
  }
  forgetCapture(id: string) {
    return this.transaction<void>("intents", "readwrite", (s) => {
      s.delete(id);
    });
  }
  authorize(grant: SessionGrant) {
    return this.transaction<void>("sessions", "readwrite", (s) => {
      const r = s.get(grant.sessionId);
      r.onsuccess = () => {
        if (r.result) {
          if (
            r.result.sourceId !== grant.sourceId ||
            r.result.context.realm !== grant.context.realm ||
            r.result.context.line !== grant.context.line ||
            (r.result.context.character ?? "") !==
              (grant.context.character ?? "")
          )
            s.transaction.abort();
          return;
        }
        const count = s.count();
        count.onsuccess = () => {
          if (count.result >= 1000) s.transaction.abort();
          else s.put(grant);
        };
      };
    });
  }
  grants(): Promise<SessionGrant[]> {
    return this.transaction("sessions", "readonly", (s, result) => {
      const r = s.getAll();
      r.onsuccess = () => result(r.result);
    });
  }
  /** Atomically bind an original capture message once, even after its ack. */
  enqueueCaptured(grants: SessionGrant[], message: MergedMessage) {
    const eligible = grants
      .filter(
        (g) =>
          g.captureSessionId === message.sessionId &&
          (g.captureFromMs ?? 0) <= message.firstObservedAtMs,
      )
      .sort((a, b) => (b.captureFromMs ?? 0) - (a.captureFromMs ?? 0));
    if (!eligible.length) return Promise.resolve();
    const proposal = eligible[0];
    this.checkSize(message);
    return this.transaction<void>("assignments", "readwrite", (assignments) => {
      const key = JSON.stringify([
        proposal.sourceId,
        message.sessionId,
        message.id,
      ]);
      const found = assignments.get(key);
      found.onsuccess = () => {
        const grant = found.result
          ? grants.find(
              (g) =>
                g.sessionId === found.result.sessionId &&
                g.sourceId === proposal.sourceId,
            )
          : proposal;
        if (!grant) {
          assignments.transaction.abort();
          return;
        }
        const put = () => {
          if (!found.result)
            assignments.put({ key, sessionId: grant.sessionId });
          this.putMessage(assignments.transaction.objectStore("queue"), grant, {
            ...message,
            sessionId: grant.sessionId,
          });
        };
        if (found.result) {
          put();
          return;
        }
        const count = assignments.count();
        count.onsuccess = () => {
          if (count.result >= 100000) assignments.transaction.abort();
          else put();
        };
      };
    });
  }
  private checkSize(message: MergedMessage) {
    if (message.text.length > 4000)
      throw Error("消息超过同步大小上限，已保留本地原文");
  }
  private putMessage(
    s: IDBObjectStore,
    grant: SessionGrant,
    message: MergedMessage,
  ) {
    const key = JSON.stringify([grant.sourceId, grant.sessionId, message.id]),
      r = s.get(key);
    r.onsuccess = () => {
      const old = r.result as QueueRow | undefined;
      if (old && old.message.revision >= message.revision) return;
      const put = () =>
        s.put({
          key,
          sourceId: grant.sourceId,
          sessionId: grant.sessionId,
          message: structuredClone(message),
          ackRevision: old?.ackRevision ?? -1,
          state: "pending",
        } satisfies QueueRow);
      if (old) {
        put();
        return;
      }
      const receipt = s.transaction.objectStore("receipts").get(key);
      receipt.onsuccess = () => {
        if (receipt.result && receipt.result.revision >= message.revision)
          return;
        const count = s.count();
        count.onsuccess = () => {
          if (count.result >= this.limit) s.transaction.abort();
          else put();
        };
      };
    };
  }
  async enqueue(grant: SessionGrant, message: MergedMessage) {
    if (message.sessionId !== grant.sessionId) return;
    this.checkSize(message);
    return this.transaction<void>("queue", "readwrite", (s) =>
      this.putMessage(s, grant, message),
    );
  }
  rows(): Promise<QueueRow[]> {
    return this.transaction("queue", "readonly", (s, result) => {
      const r = s.getAll();
      r.onsuccess = () => result(r.result);
    });
  }
  sample(
    sourceId: string,
  ): Promise<{ rows: QueueRow[]; pending: number; rejected: number }> {
    return this.transaction("queue", "readonly", (s, result) => {
      const index = s.index("sourceState"),
        range = IDBKeyRange.only([sourceId, "pending"]);
      const rows = index.getAll(range, 50),
        pending = index.count(range),
        rejected = index.count(IDBKeyRange.only([sourceId, "rejected"]));
      let done = 0;
      const finish = () => {
        if (++done === 3)
          result({
            rows: rows.result,
            pending: pending.result,
            rejected: rejected.result,
          });
      };
      rows.onsuccess = pending.onsuccess = rejected.onsuccess = finish;
    });
  }
  mark(key: string, revision: number, rejected?: string) {
    return this.transaction<void>("queue", "readwrite", (s) => {
      const r = s.get(key);
      r.onsuccess = () => {
        const row = r.result as QueueRow | undefined;
        if (!row || row.message.revision !== revision) return;
        if (rejected) s.put({ ...row, rejected, state: "rejected" });
        else {
          const receipts = s.transaction.objectStore("receipts"),
            count = receipts.count();
          count.onsuccess = () => {
            if (count.result >= 100000) {
              s.transaction.abort();
              return;
            }
            receipts.put({ key, revision, sessionId: row.sessionId });
            s.delete(key);
          };
        }
      };
    });
  }
  /** Only fully acknowledged, inactive old sessions expire. Pending/rejected evidence is retained. */
  async prune(now = Date.now()) {
    const grants = await this.grants();
    for (const grant of grants) {
      if (now - grant.context.sessionStartedAtMs < 30 * 86400000) continue;
      await this.transaction<void>("receipts", "readwrite", (receipts) => {
        const pending = receipts.transaction
          .objectStore("queue")
          .index("sessionId")
          .count(IDBKeyRange.only(grant.sessionId));
        pending.onsuccess = () => {
          if (pending.result) return;
          receipts.transaction.objectStore("sessions").delete(grant.sessionId);
          const assignments = receipts.transaction
            .objectStore("assignments")
            .index("sessionId")
            .openCursor(IDBKeyRange.only(grant.sessionId));
          assignments.onsuccess = () => {
            const cursor = assignments.result;
            if (cursor) {
              cursor.delete();
              cursor.continue();
            }
          };
          const r = receipts
            .index("sessionId")
            .openCursor(IDBKeyRange.only(grant.sessionId));
          r.onsuccess = () => {
            const cursor = r.result;
            if (cursor) {
              cursor.delete();
              cursor.continue();
            }
          };
        };
      });
    }
  }
}
