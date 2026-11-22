import test from "node:test";
import assert from "node:assert/strict";
import { MessageArchive } from "../../frontend/src/storage/message-archive.ts";
import type { MergedMessage } from "../../contracts/types.ts";

const message = (
  id = "one",
  text = "[地图]测试甲在战斗中击败了测试乙",
  revision = 1,
): MergedMessage => ({
  id,
  sessionId: "test-session",
  text,
  revision,
  observations: revision,
  firstObservedAtMs: Date.UTC(2026, 10, 22, 6, 0, 0),
  lastObservedAtMs: Date.UTC(2026, 10, 22, 6, 0, revision),
});
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function directory() {
  const files = new Map<string, string>(),
    calls: string[] = [];
  const control: {
    failAt?: "write" | "close";
    failSuffix?: string;
    gate?: Promise<void>;
    entered?: () => void;
  } = {};
  return {
    files,
    calls,
    control,
    name: "test-output",
    async getFileHandle(name: string) {
      return {
        async createWritable() {
          let pending = "";
          return {
            async write(data: Blob | string) {
              calls.push("write:" + name);
              control.entered?.();
              if (control.gate) await control.gate;
              if (
                control.failAt === "write" &&
                name.endsWith(control.failSuffix ?? ".txt")
              )
                throw Error("write failed");
              pending = typeof data === "string" ? data : await data.text();
            },
            async close() {
              calls.push("close:" + name);
              if (
                control.failAt === "close" &&
                name.endsWith(control.failSuffix ?? ".txt")
              )
                throw Error("close failed");
              files.set(name, pending);
            },
            async abort() {
              calls.push("abort:" + name);
            },
          };
        },
      };
    },
  };
}
function setup(intervalMs = 60_000) {
  const folder = directory(),
    events: any[] = [];
  const archive = new MessageArchive({
    folder,
    sessionId: "test-session",
    startedAtMs: Date.UTC(2026, 10, 22, 6),
    intervalMs,
    onStatus: (status) => events.push(status),
  });
  return { folder, events, archive };
}
const txt = (files: Map<string, string>) =>
  [...files].filter(([name]) => name.endsWith(".txt"));
const json = (files: Map<string, string>) =>
  [...files].filter(([name]) => name.endsWith(".json"));

test("empty archive creates no empty or misleading output files", async () => {
  const { archive, folder } = setup();
  assert.equal(await archive.flush(), undefined);
  assert.equal(await archive.stop(), undefined);
  assert.equal(folder.files.size, 0);
});

test("flush creates readable TXT and parseable JSON containing message metadata", async () => {
  const { archive, folder, events } = setup();
  archive.update([message()]);
  const saved = await archive.flush();
  assert.ok(saved);
  assert.equal(saved.count, 1);
  assert.equal(txt(folder.files).length, 1);
  assert.equal(json(folder.files).length, 1);
  assert.match(txt(folder.files)[0][1], /测试甲在战斗中击败了测试乙/);
  const metadata = JSON.parse(json(folder.files)[0][1]);
  assert.ok(JSON.stringify(metadata).includes("firstObservedAtMs"));
  assert.ok(JSON.stringify(metadata).includes("test-session"));
  assert.ok(
    events.some(
      (event) => event.state === "saved" && event.result?.count === 1,
    ),
  );
});

test("new revision replaces text under the same message ID", async () => {
  const { archive, folder } = setup();
  archive.update([message("one", "incorrect text", 1)]);
  await archive.flush();
  archive.update([message("one", "corrected text", 2)]);
  const saved = await archive.flush();
  assert.equal(saved?.count, 1);
  const output = txt(folder.files)
    .map(([, text]) => text)
    .join("\n");
  assert.match(output, /corrected text/);
  assert.doesNotMatch(output, /incorrect text/);
});

test("unchanged archive does not rewrite snapshot files", async () => {
  const { archive, folder } = setup();
  archive.update([message()]);
  await archive.flush();
  const count = folder.calls.length;
  assert.equal(await archive.flush(), undefined);
  assert.equal(folder.calls.length, count);
});

for (const failAt of ["write", "close"] as const)
  for (const suffix of [".txt", ".json"]) {
    test(`${suffix} ${failAt} failure is visible and retains latest messages for retry`, async () => {
      const { archive, folder, events } = setup();
      folder.control.failAt = failAt;
      folder.control.failSuffix = suffix;
      archive.update([message()]);
      try {
        await archive.flush();
      } catch {
        /* rejection or status reporting both expose failure */
      }
      assert.equal(
        events.some((event) => event.state === "saved"),
        false,
      );
      assert.ok(events.some((event) => event.state === "error"));
      folder.control.failAt = undefined;
      const saved = await archive.flush();
      assert.equal(saved?.count, 1);
      assert.match(txt(folder.files)[0][1], /测试甲/);
    });
  }

test("update arriving during file write is not lost when flush completes", async () => {
  const { archive, folder } = setup();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  folder.control.gate = new Promise<void>((resolve) => (release = resolve));
  folder.control.entered = entered;
  archive.update([message("one", "initial", 1)]);
  const first = archive.flush();
  await started;
  archive.update([message("one", "newest", 2)]);
  release();
  await first;
  folder.control.gate = undefined;
  await archive.flush();
  assert.match(txt(folder.files)[0][1], /newest/);
  assert.doesNotMatch(txt(folder.files)[0][1], /initial/);
});

test("periodic flush saves and stop performs the final changed snapshot", async () => {
  const { archive, folder } = setup(10);
  archive.start();
  archive.update([message("one", "periodic", 1)]);
  await delay(45);
  assert.match(txt(folder.files)[0]?.[1] ?? "", /periodic/);
  archive.update([message("one", "final", 2)]);
  await archive.stop();
  assert.match(txt(folder.files)[0][1], /final/);
  const calls = folder.calls.length;
  await delay(35);
  assert.equal(folder.calls.length, calls);
});

test("concurrent flush calls serialize and do not rewrite an unchanged generation", async () => {
  const { archive, folder } = setup();
  archive.update([message()]);
  const outputs = await Promise.all([
    archive.flush(),
    archive.flush(),
    archive.flush(),
  ]);
  assert.equal(outputs.filter(Boolean).length, 1);
  assert.equal(
    folder.calls.filter((call) => call.startsWith("write:")).length,
    2,
  );
});

test("foreign session and stale revisions cannot replace the current snapshot", async () => {
  const { archive, folder } = setup();
  archive.update([message("one", "current", 3)]);
  archive.update([
    message("one", "stale", 1),
    { ...message("other", "foreign"), sessionId: "foreign-session" },
  ]);
  const saved = await archive.flush();
  assert.equal(saved?.count, 1);
  assert.match(txt(folder.files)[0][1], /current/);
  assert.doesNotMatch(txt(folder.files)[0][1], /stale|foreign/);
});
