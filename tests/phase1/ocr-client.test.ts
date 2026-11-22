import test from "node:test";
import assert from "node:assert/strict";
import { OcrClient } from "../../frontend/src/ocr/client.ts";

class FakeWorker {
  onmessage: null | ((event: any) => void) = null;
  onerror: null | ((event: any) => void) = null;
  sent: any[] = [];
  terminated = false;
  postMessage(value: any) {
    this.sent.push(value);
  }
  terminate() {
    this.terminated = true;
  }
  response(value: any) {
    this.onmessage?.({ data: value });
  }
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function setup(initTimeoutMs = 100, inferenceTimeoutMs = 30) {
  const worker = new FakeWorker(),
    progress: any[] = [];
  const client = new OcrClient({
    workerFactory: () => worker as unknown as Worker,
    baseUrl: "https://example.test/fighting/",
    initTimeoutMs,
    inferenceTimeoutMs,
    onProgress: (event) => progress.push(event),
  });
  return { client, worker, progress };
}

test("progress events update the observer without completing initialization", async () => {
  const { client, worker, progress } = setup();
  let settled = false;
  const ready = client.init().then((value) => {
    settled = true;
    return value;
  });
  const id = worker.sent[0].id;
  worker.response({
    type: "progress",
    id,
    progress: { stage: "download", label: "model", loaded: 100, total: 200 },
  });
  await delay(5);
  assert.equal(settled, false);
  assert.equal(progress.length, 1);
  worker.response({ id, result: { provider: "wasm" } });
  assert.equal((await ready).provider, "wasm");
  client.close();
});

test("initialization uses its own inactivity deadline rather than inference timeout", async () => {
  const { client, worker } = setup(100, 10),
    ready = client.init();
  await delay(25);
  assert.equal(worker.terminated, false);
  worker.response({ id: worker.sent[0].id, result: { provider: "webgpu" } });
  assert.equal((await ready).provider, "webgpu");
  client.close();
});

test("active initialization progress extends its inactivity deadline", async () => {
  const { client, worker } = setup(40),
    ready = client.init(),
    id = worker.sent[0].id;
  for (let n = 1; n <= 4; n++) {
    await delay(20);
    worker.response({
      type: "progress",
      id,
      progress: { stage: "download", label: "model", loaded: n },
    });
  }
  assert.equal(worker.terminated, false);
  worker.response({ id, result: { provider: "wasm" } });
  await ready;
  client.close();
});

test("manual close cancels a pending initialization and terminates its worker", async () => {
  const { client, worker } = setup(),
    ready = client.init();
  client.close(Error("user cancelled"));
  await assert.rejects(ready, /user cancelled/);
  assert.equal(worker.terminated, true);
  await assert.rejects(client.init());
});

test("worker failure rejects pending requests instead of reporting ready", async () => {
  const { client, worker } = setup(),
    ready = client.init();
  worker.onerror?.({ message: "worker failed" });
  await assert.rejects(ready, /worker failed/);
  assert.equal(worker.terminated, true);
});
