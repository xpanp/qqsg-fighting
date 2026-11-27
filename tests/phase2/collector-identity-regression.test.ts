import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
req("fake-indexeddb/auto");
import { CollectorEnrollment } from "../../frontend/src/sync/enrollment.ts";
import { SyncClient } from "../../frontend/src/sync/client.ts";
import { Outbox } from "../../frontend/src/sync/outbox.ts";
import { parseCaptureIdentity } from "../../frontend/src/capture/identity.ts";

test("enrollment offline rejection preserves existing credential and suppresses retry storm", async () => {
  let calls = 0,
    now = 100000;
  const enrollment = new CollectorEnrollment({
    now: () => now,
    fetch: async () => {
      calls++;
      throw Error("offline");
    },
  });
  await assert.rejects(enrollment.ensure({ sourceId: "", token: "" }));
  await assert.rejects(enrollment.ensure({ sourceId: "", token: "" }));
  assert.equal(calls, 1);
  const existing = { sourceId: "existing", token: "x".repeat(32) };
  assert.deepEqual(await enrollment.ensure(existing), existing);
  assert.equal(calls, 1);
  now += 60001;
  await assert.rejects(enrollment.ensure({ sourceId: "", token: "" }));
  assert.equal(calls, 2);
});
test("concurrent enrollment shares single successful registration", async () => {
  let calls = 0;
  const enrollment = new CollectorEnrollment({
    fetch: async () => {
      calls++;
      return Response.json({ sourceId: "browser", token: "x".repeat(32) });
    },
  });
  const empty = { sourceId: "", token: "" };
  const [a, b] = await Promise.all([
    enrollment.ensure(empty),
    enrollment.ensure(empty),
  ]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
});
test("line change keeps old-message revisions in old epoch and new messages in new epoch", async () => {
  const outbox = new Outbox(5000, "epoch-" + crypto.randomUUID());
  const batches: any[] = [];
  const client = new SyncClient({
    outbox,
    settings: () => ({
      enabled: true,
      token: "x".repeat(32),
      sourceId: "browser",
      realm: "",
      line: "",
    }),
    scan: async () => ({ rows: [] }),
    onStatus() {},
    fetch: async (url, init) => {
      if (String(url).endsWith("/time"))
        return Response.json({ serverTimeMs: Date.now() });
      const batch = JSON.parse(String(init?.body));
      batches.push(batch);
      return Response.json({
        batchId: batch.batchId,
        accepted: batch.messages.map((m: any) => ({
          id: m.id,
          sessionId: m.sessionId,
          revision: m.revision,
        })),
        rejected: [],
      });
    },
  });
  const message = (id: string, time: number, revision = 1) => ({
    id,
    sessionId: "capture",
    revision,
    text: "[地图]甲在战斗中击败了乙",
    firstObservedAtMs: time,
    lastObservedAtMs: time,
    observations: 1,
  });
  client.bindCapture(
    "capture",
    1000,
    { realm: "得陇望蜀", line: "1", character: "甲" },
    1000,
  );
  await (client as any).enqueue([message("old", 1500)]);
  await client.tick();
  client.bindCapture(
    "capture",
    1000,
    { realm: "得陇望蜀", line: "2", character: "甲" },
    2000,
  );
  await (client as any).enqueue([
    message("old", 1500, 2),
    message("new", 2500),
  ]);
  await client.tick();
  await client.tick();
  const old = batches
    .flatMap((b) =>
      b.messages.map((m: any) => ({ line: b.context.line, ...m })),
    )
    .filter((m) => m.id === "old");
  assert.deepEqual(
    old.map((m) => m.line),
    ["1", "1"],
  );
  assert.equal(
    batches.find((b) => b.messages.some((m: any) => m.id === "new")).context
      .line,
    "2",
  );
  assert.equal((await outbox.grants()).length, 2);
});
test("fresh title OCR takes precedence over stale capture-track label after changing line", () => {
  const parsed = parseCaptureIdentity({
    windowTitle: "QQ三国 得陇望蜀 1线",
    titleLines: ["QQ三国 得陇望蜀 2线"],
  });
  assert.equal(parsed.line, "2");
});

test("already queued message never migrates epoch when revision adjusts firstObserved across boundary", async () => {
  const outbox = new Outbox(5000, "sticky-" + crypto.randomUUID());
  const client = new SyncClient({
    outbox,
    settings: () => ({
      enabled: true,
      token: "x".repeat(32),
      sourceId: "browser",
      realm: "",
      line: "",
    }),
    scan: async () => ({ rows: [] }),
    onStatus() {},
  });
  const msg = (time: number, revision: number) => ({
    id: "same-message",
    sessionId: "capture",
    revision,
    text: "[地图]甲在战斗中击败了乙",
    firstObservedAtMs: time,
    lastObservedAtMs: 2500,
    observations: 1,
  });
  client.bindCapture("capture", 1000, { realm: "得陇望蜀", line: "1" }, 1000);
  await (client as any).enqueue([msg(1500, 1)]);
  const original = (await outbox.rows())[0].sessionId;
  client.bindCapture("capture", 1000, { realm: "得陇望蜀", line: "2" }, 2000);
  await (client as any).enqueue([msg(2100, 2)]);
  const rows = await outbox.rows();
  assert.equal(
    rows.length,
    1,
    "a revision must not duplicate a logical message across epochs",
  );
  assert.equal(rows[0].sessionId, original);
  assert.equal(rows[0].message.revision, 2);
});

test("wrapped fresh title is combined before falling back to stale capture label", () => {
  const result = parseCaptureIdentity({
    windowTitle: "QQ三国 得陇望蜀 1线",
    titleLines: ["得陇望蜀", "2线"],
  });
  assert.equal(result.line, "2");
});
