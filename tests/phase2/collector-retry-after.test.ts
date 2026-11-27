import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
req("fake-indexeddb/auto");
import { Outbox } from "../../frontend/src/sync/outbox.ts";
import { SyncClient } from "../../frontend/src/sync/client.ts";
for (const mode of ["seconds", "date", "invalid"])
  test(
    "ingest429 Retry-After " +
      mode +
      " suppresses early retry and retains pending",
    async () => {
      const original = Date.now;
      let now = 1700000000000,
        calls = 0;
      Date.now = () => now;
      const delay = mode === "invalid" ? 30000 : 120000;
      const box = new Outbox(5000, "retry-after-" + crypto.randomUUID());
      const grant = {
        sessionId: "session",
        sourceId: "source",
        context: { sessionStartedAtMs: now, realm: "realm", line: "1" },
      };
      await box.authorize(grant);
      await box.enqueue(grant, {
        id: "one",
        sessionId: "session",
        revision: 1,
        text: "[地图]甲在战斗中击败了乙",
        firstObservedAtMs: now,
        lastObservedAtMs: now,
        observations: 1,
      });
      const client = new SyncClient({
        outbox: box,
        settings: () => ({
          enabled: true,
          token: "x".repeat(32),
          sourceId: "source",
          realm: "realm",
          line: "1",
        }),
        scan: async () => ({ rows: [] }),
        onStatus() {},
        fetch: async (url, init) => {
          if (String(url).endsWith("/time"))
            return Response.json({ serverTimeMs: now });
          calls++;
          if (calls === 1)
            return new Response("", {
              status: 429,
              headers: {
                "Retry-After":
                  mode === "seconds"
                    ? "120"
                    : mode === "date"
                      ? new Date(now + delay).toUTCString()
                      : "nonsense",
              },
            });
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
      try {
        await client.tick();
        assert.equal(calls, 1);
        now += delay - 1;
        await client.tick();
        assert.equal(calls, 1);
        assert.equal((await box.rows()).length, 1);
        now++;
        await client.tick();
        assert.equal(calls, 2);
        assert.equal((await box.rows()).length, 0);
      } finally {
        client.stop();
        Date.now = original;
      }
    },
  );
