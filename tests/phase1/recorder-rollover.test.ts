import test from "node:test";
import assert from "node:assert/strict";
import { DurableRecorder } from "../../frontend/src/capture/recorder.ts";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function fixture(failAt = Infinity) {
  const active = new Set<Encoder>(),
    events: any[] = [],
    saved: string[] = [],
    metadata = new Map<string, any>();
  let starts = 0,
    maxActive = 0;
  class Encoder {
    static isTypeSupported() {
      return true;
    }
    state = "inactive";
    onstart: any;
    onstop: any;
    onerror: any;
    ondataavailable: any;
    start() {
      starts++;
      if (starts === failAt) throw Error("successor-start-failed");
      if (active.size) throw Error("encoder-still-in-use");
      active.add(this);
      maxActive = Math.max(maxActive, active.size);
      this.state = "recording";
      queueMicrotask(() => {
        this.onstart?.();
        this.chunk();
      });
    }
    chunk() {
      this.ondataavailable?.({ data: new Blob(["test-data"]), timecode: 0 });
    }
    stop() {
      if (this.state === "inactive") throw Error("already stopped");
      this.state = "inactive";
      setTimeout(() => {
        this.chunk();
        active.delete(this);
        this.onstop?.();
      }, 5);
    }
  }
  globalThis.MediaRecorder = Encoder as any;
  const recorder = new DurableRecorder({} as MediaStream, {
    sessionId: "rollover",
    segmentSeconds: 0.015,
    folder: { name: "fake" } as any,
    recorderFactory: () => new Encoder() as any,
    onStatus: (e) => events.push(e),
    journal: {
      async createSegment(row) {
        metadata.set(String(row.id), { ...row });
        return row as any;
      },
      async appendChunk() {},
      async finishSegment(id, row) {
        metadata.set(String(id), { ...metadata.get(String(id)), ...row });
      },
      async writeSegmentFiles(id) {
        saved.push(String(id));
        return id + ".webm";
      },
    },
  });
  return {
    recorder,
    saved,
    events,
    metadata,
    get starts() {
      return starts;
    },
    get maxActive() {
      return maxActive;
    },
  };
}
test("three automatic segments do not overlap a single encoder resource", async () => {
  const f = fixture();
  try {
    await f.recorder.start();
    for (
      let n = 0;
      n < 100 && f.saved.length < 3 && !f.recorder.errors.length;
      n++
    )
      await wait(10);
    assert.deepEqual(f.recorder.errors, []);
    assert.ok(f.saved.length >= 3, "three segments save without another click");
    assert.equal(f.maxActive, 1);
  } finally {
    await f.recorder.stop();
  }
});
test("failure to start successor does not invalidate healthy predecessor data", async () => {
  const f = fixture(2);
  try {
    await f.recorder.start();
    for (let n = 0; n < 100 && !f.recorder.errors.length; n++) await wait(10);
  } finally {
    await f.recorder.stop();
  }
  assert.ok(
    f.recorder.errors.some((s) => s.includes("successor-start-failed")),
  );
  assert.ok(
    f.saved.includes("rollover/0"),
    "first completed segment must still save",
  );
});
