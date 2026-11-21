import test from "node:test";
import assert from "node:assert/strict";
import { DurableRecorder } from "../../frontend/src/capture/recorder.ts";

class FakeRecorder {
  static isTypeSupported() {
    return true;
  }
  state = "inactive";
  onstart: null | (() => void) = null;
  ondataavailable: null | ((event: any) => void) = null;
  onstop: null | (() => void) = null;
  onerror: null | ((event: any) => void) = null;
  failStart = false;
  failAsyncStart = false;
  omitStartEvent = false;
  start() {
    if (this.failStart) throw Error("start failed");
    this.state = "recording";
    if (this.omitStartEvent) return;
    if (this.failAsyncStart) {
      queueMicrotask(() => {
        this.state = "inactive";
        this.onerror?.({ error: Error("async encoder failed") });
        this.onstop?.();
      });
      return;
    }
    queueMicrotask(() => this.onstart?.());
  }
  chunk() {
    this.ondataavailable?.({ data: new Blob(["video-data"]), timecode: 1000 });
  }
  stop() {
    if (this.state === "inactive") throw Error("already inactive");
    this.state = "inactive";
    queueMicrotask(() => {
      this.chunk();
      this.onstop?.();
    });
  }
}

function fixture(
  options: {
    failStart?: boolean;
    failAsyncStart?: boolean;
    omitStartEvent?: boolean;
    failSave?: boolean;
    failAppend?: boolean;
    createGate?: Promise<void>;
    segmentSeconds?: number;
    startTimeoutMs?: number;
  } = {},
) {
  const media: FakeRecorder[] = [],
    events: any[] = [],
    calls: string[] = [];
  const journal = {
    async createSegment() {
      calls.push("create");
      await options.createGate;
      return {} as any;
    },
    async appendChunk() {
      calls.push("append");
      if (options.failAppend) throw Error("disk quota");
    },
    async finishSegment() {
      calls.push("finish");
    },
    async writeSegmentFiles() {
      calls.push("save");
      if (options.failSave) throw Error("close failed");
      return "video.webm";
    },
  };
  const recorder = new DurableRecorder({} as MediaStream, {
    sessionId: "test-session",
    journal,
    folder: { name: "test" } as any,
    segmentSeconds: options.segmentSeconds ?? 60,
    startTimeoutMs: options.startTimeoutMs,
    onStatus: (event) => events.push(event),
    recorderFactory: () => {
      const fake = new FakeRecorder();
      fake.failStart = !!options.failStart;
      fake.failAsyncStart = !!options.failAsyncStart;
      fake.omitStartEvent = !!options.omitStartEvent;
      media.push(fake);
      return fake as any;
    },
  });
  return { recorder, media, events, calls };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = async (promise: Promise<unknown>) => {
  let timeout: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(Error("recorder did not settle")),
          1500,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout!);
  }
};

test("stop flushes final chunk and reports saved only after journal file completion", async () => {
  globalThis.MediaRecorder = FakeRecorder as any;
  const f = fixture();
  await f.recorder.start();
  await settle(f.recorder.stop());
  assert.deepEqual(f.calls, ["create", "append", "finish", "save"]);
  assert.equal(
    f.events.filter(
      (event) => event.event === "segment" && event.savedToDirectory,
    ).length,
    1,
  );
});

test("failed start rejects and a subsequent stop is not left hanging", async () => {
  globalThis.MediaRecorder = FakeRecorder as any;
  const f = fixture({ failStart: true });
  await assert.rejects(f.recorder.start(), /start failed/);
  await settle(f.recorder.stop());
  assert.ok(f.events.some((event) => event.event === "error"));
  assert.equal(
    f.events.some((event) => event.savedToDirectory),
    false,
  );
});

test("directory close failure never emits saved success", async () => {
  globalThis.MediaRecorder = FakeRecorder as any;
  const f = fixture({ failSave: true });
  await f.recorder.start();
  await settle(f.recorder.stop());
  assert.ok(f.events.some((event) => event.error?.includes("close failed")));
  assert.equal(
    f.events.some((event) => event.savedToDirectory),
    false,
  );
});

test("stop during pending segment creation prevents a new media recorder", async () => {
  globalThis.MediaRecorder = FakeRecorder as any;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const f = fixture({ createGate: gate });
  const started = f.recorder.start();
  const stopped = f.recorder.stop();
  release();
  await settle(Promise.all([started, stopped]));
  assert.equal(f.media.length, 0);
  assert.equal(
    f.events.some((event) => event.event === "started"),
    false,
  );
});

test("segment rollover starts successor before stopping predecessor and stops all on request", async () => {
  globalThis.MediaRecorder = FakeRecorder as any;
  const f = fixture({ segmentSeconds: 0.02 });
  await f.recorder.start();
  await sleep(35);
  await settle(f.recorder.stop());
  assert.ok(f.media.length >= 2);
  assert.equal(
    f.media.every((media) => media.state === "inactive"),
    true,
  );
  const count = f.media.length;
  await sleep(45);
  assert.equal(f.media.length, count, "no successor may appear after stop");
});

test("append failure is reported and stop settles without saved success for failed segment", async () => {
  globalThis.MediaRecorder = FakeRecorder as any;
  const f = fixture({ failAppend: true });
  await f.recorder.start();
  f.media[0].chunk();
  await sleep(10);
  await settle(f.recorder.stop());
  assert.ok(f.events.some((event) => event.error?.includes("disk quota")));
  assert.equal(
    f.events.some((event) => event.savedToDirectory),
    false,
  );
});

test("asynchronous encoder failure before start event rejects start and allows stop", async () => {
  globalThis.MediaRecorder = FakeRecorder as any;
  const f = fixture({ failAsyncStart: true });
  await assert.rejects(settle(f.recorder.start()), /async encoder failed/);
  await settle(f.recorder.stop());
  assert.equal(
    f.events.some((event) => event.savedToDirectory),
    false,
  );
});

test("zero-data segment is an error rather than a saved video", async () => {
  globalThis.MediaRecorder = FakeRecorder as any;
  const f = fixture();
  await f.recorder.start();
  f.media[0].chunk = () => {};
  await settle(f.recorder.stop());
  assert.equal(
    f.events.some((event) => event.savedToDirectory),
    false,
  );
  assert.ok(
    f.events.some((event) => event.error?.includes("没有收到视频数据")),
  );
});

test("missing recorder start event times out and permits cleanup", async () => {
  globalThis.MediaRecorder = FakeRecorder as any;
  const f = fixture({ omitStartEvent: true, startTimeoutMs: 20 });
  await assert.rejects(settle(f.recorder.start()), /超时/);
  await settle(f.recorder.stop());
  assert.equal(
    f.media.every((media) => media.state === "inactive"),
    true,
  );
});
