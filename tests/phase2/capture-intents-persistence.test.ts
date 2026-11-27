import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
req("fake-indexeddb/auto");
import { Outbox } from "../../frontend/src/sync/outbox.ts";
import { SyncClient } from "../../frontend/src/sync/client.ts";
const base = Date.now();
const msg = (
  id: string,
  time: number,
  revision = 1,
  sessionId = "capture",
) => ({
  id,
  sessionId,
  revision,
  text: "[地图]甲在战斗中击败了乙",
  firstObservedAtMs: time,
  lastObservedAtMs: base + 500,
  observations: 1,
});
const grant = (line: string, offset: number) => ({
  sessionId: "capture/epoch/" + line,
  sourceId: "source",
  captureSessionId: "capture",
  captureFromMs: base + offset,
  context: { sessionStartedAtMs: base, realm: "realm", line },
});
test("offline intents survive stopped client/reopen and adopt ordered epochs without unrelated history", async () => {
  const name = "intent-" + crypto.randomUUID(),
    outbox = new Outbox(5000, name),
    batches: any[] = [];
  let settings = {
    enabled: true,
    token: "",
    sourceId: "",
    realm: "",
    line: "",
  };
  const options = (box: Outbox) => ({
    outbox: box,
    settings: () => settings,
    onStatus() {},
    scan: async () => ({
      rows: [
        msg("unknown", base + 50),
        msg("line1", base + 150),
        msg("line2", base + 250),
        msg("foreign", base + 150, 1, "never-authorized"),
      ],
    }),
    fetch: async (url: any, init: any) => {
      if (String(url).endsWith("/time"))
        return Response.json({ serverTimeMs: Date.now() });
      const b = JSON.parse(init.body);
      batches.push(b);
      return Response.json({
        batchId: b.batchId,
        accepted: b.messages.map((m: any) => ({
          id: m.id,
          sessionId: m.sessionId,
          revision: m.revision,
        })),
        rejected: [],
      });
    },
  });
  const first = new SyncClient(options(outbox));
  first.bindCapture("capture", base, {}, base);
  first.bindCapture("capture", base, { realm: "realm", line: "2" }, base + 200);
  first.bindCapture("capture", base, { realm: "realm", line: "1" }, base + 100);
  await (first as any).contextSerial;
  first.stop();
  assert.equal((await outbox.captureIntents()).length, 3);
  assert.equal((await outbox.grants()).length, 0);
  settings = { ...settings, token: "x".repeat(32), sourceId: "source" };
  const reopened = new Outbox(5000, name),
    client = new SyncClient(options(reopened));
  for (let i = 0; i < 4; i++) await client.tick();
  const routed = batches
    .flatMap((b) =>
      b.messages.map((m: any) => ({ id: m.id, line: b.context.line })),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(routed, [
    { id: "line1", line: "1" },
    { id: "line2", line: "2" },
    { id: "unknown", line: "" },
  ]);
  assert.equal((await reopened.captureIntents()).length, 0);
});
test("ack plus outbox reopen preserves assignment despite revision moving across epoch", async () => {
  const name = "ack-" + crypto.randomUUID(),
    box = new Outbox(5000, name),
    grants = [grant("1", 0), grant("2", 200)];
  for (const g of grants) await box.authorize(g);
  await box.enqueueCaptured(grants, msg("stable", base + 100));
  const old = (await box.rows())[0];
  await box.mark(old.key, 1);
  assert.equal((await box.rows()).length, 0);
  const reopened = new Outbox(5000, name);
  await reopened.enqueueCaptured(
    await reopened.grants(),
    msg("stable", base + 300, 2),
  );
  const rows = await reopened.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, old.sessionId);
  assert.equal(rows[0].message.revision, 2);
});
test("full queue abort rolls back proposed assignment, retry can correctly choose later epoch", async () => {
  const box = new Outbox(1, "quota-" + crypto.randomUUID()),
    grants = [grant("1", 0), grant("2", 200)];
  for (const g of grants) await box.authorize(g);
  await box.enqueueCaptured(grants, msg("occupant", base + 50));
  await assert.rejects(box.enqueueCaptured(grants, msg("retry", base + 100)));
  const row = (await box.rows())[0];
  await box.mark(row.key, 1);
  await box.enqueueCaptured(grants, msg("retry", base + 300, 2));
  assert.equal(
    (await box.rows())[0].sessionId,
    grant("2", 200).sessionId,
    "failed first attempt must not leave old epoch assignment",
  );
});
test("v1 persisted pending queue and grants survive upgrade and new intent storage works", async () => {
  const name = "upgrade-" + crypto.randomUUID(),
    g = grant("1", 0),
    m = { ...msg("legacy", base + 10), sessionId: g.sessionId },
    key = JSON.stringify([g.sourceId, g.sessionId, m.id]);
  await new Promise<void>((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore("sessions", { keyPath: "sessionId" });
      const q = db.createObjectStore("queue", { keyPath: "key" });
      q.createIndex("sourceState", ["sourceId", "state"]);
      q.createIndex("sessionId", "sessionId");
      db.createObjectStore("receipts", { keyPath: "key" }).createIndex(
        "sessionId",
        "sessionId",
      );
    };
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const db = r.result,
        tx = db.transaction(["sessions", "queue"], "readwrite");
      tx.objectStore("sessions").put(g);
      tx.objectStore("queue").put({
        key,
        sourceId: g.sourceId,
        sessionId: g.sessionId,
        message: m,
        ackRevision: -1,
        state: "pending",
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
  const box = new Outbox(5000, name);
  assert.equal((await box.rows())[0].message.id, "legacy");
  assert.equal((await box.grants())[0].sessionId, g.sessionId);
  await box.rememberCapture({
    id: "new",
    captureSessionId: "new",
    observedAtMs: base,
    context: { sessionStartedAtMs: base, realm: "", line: "" },
  });
  assert.equal((await box.captureIntents()).length, 1);
  await box.enqueueCaptured([g], msg("new-message", base + 40));
  assert.equal((await box.rows()).length, 2);
});

test("transient adoption failure retries on next tick without requiring another bindCapture", async () => {
  const box = new Outbox(5000, "adopt-retry-" + crypto.randomUUID());
  let settings = {
      enabled: true,
      token: "",
      sourceId: "",
      realm: "",
      line: "",
    },
    uploads = 0;
  const client = new SyncClient({
    outbox: box,
    settings: () => settings,
    onStatus() {},
    scan: async () => ({ rows: [msg("retry-adopt", base + 10)] }),
    fetch: async (url, init) => {
      if (String(url).endsWith("/time"))
        return Response.json({ serverTimeMs: Date.now() });
      uploads++;
      const b = JSON.parse(String(init?.body));
      return Response.json({
        batchId: b.batchId,
        accepted: b.messages.map((m: any) => ({
          id: m.id,
          sessionId: m.sessionId,
          revision: m.revision,
        })),
        rejected: [],
      });
    },
  });
  client.bindCapture("capture", base, {}, base);
  await (client as any).contextSerial;
  settings = { ...settings, token: "x".repeat(32), sourceId: "source" };
  const authorize = box.authorize.bind(box);
  let once = true;
  box.authorize = (g) => {
    if (once) {
      once = false;
      return Promise.reject(Error("transient IDB transaction failure"));
    }
    return authorize(g);
  };
  await client.tick();
  assert.equal((await box.captureIntents()).length, 1);
  await client.tick();
  assert.equal(
    uploads,
    1,
    "transient failed adoption must not poison future ticks",
  );
  assert.equal((await box.captureIntents()).length, 0);
});
