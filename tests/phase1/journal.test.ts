import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import * as journal from "../../frontend/src/storage/journal.ts";

async function segment() {
  const id = crypto.randomUUID();
  await journal.createSegment({
    id,
    sessionId: id,
    segment: 0,
    mimeType: "video/webm",
    startedUtcMs: Date.now(),
    startedMono: 0,
  });
  return id;
}

function folder(failName?: string, failAt?: "write" | "close") {
  const files = new Map<string, Blob | string>(),
    calls: string[] = [];
  return {
    files,
    calls,
    name: "isolated-test",
    async getFileHandle(name: string) {
      return {
        async createWritable() {
          let data: Blob | string;
          return {
            async write(value: Blob | string) {
              calls.push("write:" + name);
              if (name.endsWith(failName ?? "impossible") && failAt === "write")
                throw Error("write denied");
              data = value;
            },
            async close() {
              calls.push("close:" + name);
              if (name.endsWith(failName ?? "impossible") && failAt === "close")
                throw Error("close denied");
              files.set(name, data);
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

test("recover assembles committed chunks in index order and isolates other segments", async () => {
  const id = await segment(),
    other = await segment();
  await journal.appendChunk(id, 0, new Blob(["first"]), {});
  await journal.appendChunk(other, 0, new Blob(["foreign"]), {});
  await journal.appendChunk(id, 1, new Blob(["second"]), {});
  assert.equal(await (await journal.recoverBlob(id)).text(), "firstsecond");
});

test("missing chunks fail recovery instead of returning a silently corrupt video", async () => {
  const id = await segment();
  await journal.appendChunk(id, 1, new Blob(["missing-header"]), {});
  await assert.rejects(journal.recoverBlob(id), /不连续/);
});

test("closing both files commits saved status and only then removes cached chunks", async () => {
  const id = await segment(),
    target = folder();
  await journal.appendChunk(id, 0, new Blob(["webm"]), {});
  await journal.finishSegment(id, {
    status: "complete",
    endedUtcMs: Date.now(),
  });
  await journal.writeSegmentFiles(id, target);
  const meta = await journal.getSegment(id);
  assert.equal(meta.savedToDirectory, true);
  assert.equal(target.files.size, 2);
  const video = [...target.files.values()].find(
    (value): value is Blob =>
      value instanceof Blob && value.type !== "application/json",
  );
  assert.ok(video);
  assert.equal(await video.text(), "webm");
  await assert.rejects(journal.recoverBlob(id), /没有可恢复/);
});

for (const ext of [".webm", ".json"])
  for (const at of ["write", "close"] as const) {
    test(`${ext} ${at} failure retains recovery data and never marks saved`, async () => {
      const id = await segment(),
        target = folder(ext, at);
      await journal.appendChunk(id, 0, new Blob(["recover-me"]), {});
      await assert.rejects(journal.writeSegmentFiles(id, target), /denied/);
      assert.notEqual((await journal.getSegment(id)).savedToDirectory, true);
      assert.equal(await (await journal.recoverBlob(id)).text(), "recover-me");
      assert.ok(target.calls.some((call) => call.startsWith("abort:")));
    });
  }

test("message revisions persist one stable ID rather than duplicate records", async () => {
  const id = crypto.randomUUID(),
    row = {
      id,
      sessionId: "test",
      text: "initial",
      firstObservedAtMs: 1,
      lastObservedAtMs: 1,
      revision: 1,
      observations: 1,
    };
  await journal.saveMessages([row]);
  await journal.saveMessages([
    { ...row, text: "corrected", revision: 2, observations: 2 },
  ]);
  const found = (await journal.messages()).filter(
    (message) => message.id === id,
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].text, "corrected");
});

test("recovery refuses while another page owns the capture lease", async () => {
  let held = false;
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      async request(
        _name: string,
        _options: unknown,
        callback: (lock: object | null) => Promise<unknown>,
      ) {
        if (held) return callback(null);
        held = true;
        try {
          return await callback({ name: "test-lock" });
        } finally {
          held = false;
        }
      },
    },
  });
  const id = await segment(),
    target = folder();
  await journal.appendChunk(id, 0, new Blob(["restore"]), {});
  const release = await journal.acquireCaptureLease();
  await assert.rejects(journal.recoverSegmentFiles(id, target), /仍在录制/);
  assert.equal(await (await journal.recoverBlob(id)).text(), "restore");
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await journal.recoverSegmentFiles(id, target);
  assert.equal((await journal.getSegment(id)).savedToDirectory, true);
  Reflect.deleteProperty(navigator, "locks");
});
