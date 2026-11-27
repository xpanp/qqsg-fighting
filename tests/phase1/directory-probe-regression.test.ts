import test from "node:test";
import assert from "node:assert/strict";
import * as store from "../../frontend/src/storage/journal.ts";
const verify = (folder: any) => (store as any).verifyDirectoryWritable(folder);
function fixture(fail?: string, deleteFailure = false) {
  const paths: string[] = [],
    deleted: string[] = [],
    events: string[] = [];
  const error = new DOMException(
    "injected filesystem denial",
    "NotAllowedError",
  );
  return {
    paths,
    deleted,
    events,
    error,
    folder: {
      name: "user-videos",
      async getFileHandle(name: string, options: any) {
        paths.push(name);
        events.push("create");
        assert.equal(options.create, true);
        if (fail === "create") throw error;
        return {
          async createWritable() {
            events.push("writable");
            if (fail === "writable") throw error;
            return {
              async write(data: any) {
                events.push("write");
                assert.ok(
                  (data.size ?? data.byteLength ?? data.length ?? 0) > 0,
                  "probe must actually write bytes",
                );
                if (fail === "write") throw error;
              },
              async close() {
                events.push("close");
                if (fail === "close") throw error;
              },
              async abort() {
                events.push("abort");
              },
            };
          },
        };
      },
      async removeEntry(name: string) {
        deleted.push(name);
        assert.ok(
          paths.includes(name),
          "must never remove existing unrelated user files",
        );
        if (deleteFailure)
          throw new DOMException("cleanup blocked", "SecurityError");
      },
    },
  };
}
for (const phase of ["create", "writable", "write", "close"])
  test(
    "directory probe reports original filesystem error at " + phase,
    async () => {
      const f = fixture(phase);
      await assert.rejects(verify(f.folder), (error: any) => {
        assert.equal(
          error.phase,
          phase === "create"
            ? "create-file"
            : phase === "writable"
              ? "create-writable"
              : phase,
        );
        assert.equal(error.originalName, "NotAllowedError");
        assert.equal(error.cause, f.error);
        const detail = JSON.stringify({
          message: error.message,
          name: error.name,
          phase: error.phase,
          causeName: error.cause?.name,
        });
        assert.match(detail, /NotAllowedError/);
        assert.match(detail, new RegExp(phase));
        return true;
      });
      assert.equal(f.paths.length, 1);
      assert.equal(f.events.includes("close"), phase === "close");
    },
  );
test("successful directory probe writes then closes and only deletes own unique file", async () => {
  const a = fixture(),
    b = fixture();
  await verify(a.folder);
  await verify(b.folder);
  assert.deepEqual(a.events, ["create", "writable", "write", "close"]);
  assert.deepEqual(a.deleted, a.paths);
  assert.notEqual(a.paths[0], b.paths[0]);
  assert.ok(a.paths[0].length > 10);
});
test("cleanup failure warns without claiming writable directory is unusable", async () => {
  const f = fixture(undefined, true);
  const result = await verify(f.folder);
  assert.equal(f.events.at(-1), "close");
  assert.match(JSON.stringify(result), /warning|清理|删除|SecurityError/i);
  assert.deepEqual(f.deleted, f.paths);
});

test("failed write aborts stream and cleanup failure does not replace original error", async () => {
  const f = fixture("write", true);
  await assert.rejects(verify(f.folder), (error: any) => {
    assert.equal(error.phase, "write");
    assert.equal(error.cause, f.error);
    return true;
  });
  assert.ok(f.events.includes("abort"));
  assert.deepEqual(f.deleted, f.paths);
});
