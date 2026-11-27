import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DurableRecorder } from "../../frontend/src/capture/recorder.ts";
import { OcrClient } from "../../frontend/src/ocr/client.ts";
const req = createRequire(import.meta.url);
const { transformSync } = req("esbuild");
const source = readFileSync(
  new URL("../../frontend/src/app/main.ts", import.meta.url),
  "utf8",
);
const body = source.slice(
  source.indexOf("async function tickOcr()"),
  source.indexOf("function renderMessages()"),
);
const code = transformSync(body, { loader: "ts", target: "es2022" }).code;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (const mode of ["registration-hangs", "identity-hangs"])
  test(
    mode + " does not stop segment commits (actual tickOcr body)",
    async () => {
      const saved: string[] = [],
        statuses: any[] = [];
      let terminated = false,
        calls = 0;
      class Encoder {
        static isTypeSupported() {
          return true;
        }
        state = "inactive";
        onstart: any;
        onstop: any;
        ondataavailable: any;
        start() {
          this.state = "recording";
          queueMicrotask(() => this.onstart?.());
        }
        stop() {
          this.state = "inactive";
          queueMicrotask(() => {
            this.ondataavailable?.({ data: new Blob(["synthetic-video"]) });
            this.onstop?.();
          });
        }
      }
      const old = globalThis.MediaRecorder;
      globalThis.MediaRecorder = Encoder as any;
      const recorder = new DurableRecorder({} as any, {
        sessionId: "test",
        segmentSeconds: 0.015,
        folder: { name: "fake" } as any,
        journal: {
          async createSegment() {
            return {} as any;
          },
          async appendChunk() {},
          async finishSegment() {},
          async writeSegmentFiles(id) {
            saved.push(String(id));
            return id + ".webm";
          },
        },
        recorderFactory: () => new Encoder() as any,
        onStatus: (s) => statuses.push(s),
      });
      const worker: any = {
        postMessage(m: any) {
          calls++;
          if (mode === "init-failure") {
            queueMicrotask(() =>
              worker.onmessage({
                data: { id: m.id, error: "model-load-failed" },
              }),
            );
            return;
          }
          if (mode === "worker-timeout" || mode === "recognize-never") return;
          queueMicrotask(() =>
            worker.onmessage({
              data: {
                id: m.id,
                result: {
                  provider: "fake",
                  elapsedMs: 1,
                  lines: [{ text: "[地图]甲在战斗中击败了乙" }],
                },
              },
            }),
          );
        },
        terminate() {
          terminated = true;
        },
      };
      const client = new OcrClient({
        workerFactory: () => worker,
        inferenceTimeoutMs: mode === "recognize-never" ? 10000 : 20,
        initTimeoutMs: 20,
      });
      const nodes = new Map<string, any>();
      const $ = (id: string) => {
        if (!nodes.has(id)) nodes.set(id, { checked: true });
        return nodes.get(id);
      };
      const notices: string[] = [];
      const row = { id: "message", revision: 1 };
      const env: any = {
        recorder,
        crop: {
          image: () => ({
            data: new Uint8ClampedArray(4),
            width: 1,
            height: 1,
          }),
        },
        merger: { ingest: () => [row] },
        checked: () => true,
        ocrBusy: false,
        ocrGeneration: 1,
        readWindowIdentity: () =>
          mode === "identity-hangs" ? new Promise(() => {}) : Promise.resolve(),
        connectCollector: () => new Promise(() => {}),
        loadOcr: () =>
          mode === "init-failure" ? client.init() : Promise.resolve(),
        performance,
        startedMono: performance.now(),
        startedUtc: Date.now(),
        frame: 0,
        client,
        setText: () => {},
        ocrDevice: "fake",
        deviceName: (x: any) => x,
        knownMessages: new Map(),
        messageCandidates: (x: any) => x,
        archive: {
          update() {
            if (mode === "archive-throws") throw Error("archive-update-failed");
          },
        },
        sessionMessageIds: new Set(),
        store: {
          saveMessages: () =>
            mode === "saveMessages-reject"
              ? Promise.reject(Error("quota"))
              : mode === "saveMessages-never"
                ? new Promise(() => {})
                : Promise.resolve(),
        },
        sync: { notify() {} },
        renderMessages() {},
        $,
        button: $,
        notify: (s: string) => notices.push(s),
        describe: String,
      };
      // Compile and run the source function, preserving its real catch/finally and dependency order.
      const tick = new Function(...Object.keys(env), code + ";return tickOcr;")(
        ...Object.values(env),
      );
      let settled = false;
      try {
        await recorder.start();
        const running = tick().finally(() => {
          settled = true;
        });
        await wait(85);
        assert.ok(saved.length >= 3, `only ${saved.length} files committed`);
        assert.deepEqual(recorder.errors, []);
        if (mode === "identity-hangs") assert.equal(settled, false);
        else {
          await running;
          assert.ok(
            calls > 0,
            "chat recognition still executes with registration hanging",
          );
          assert.equal(notices.length, 0);
        }
      } finally {
        client.close();
        await recorder.stop();
        globalThis.MediaRecorder = old;
      }
    },
  );
