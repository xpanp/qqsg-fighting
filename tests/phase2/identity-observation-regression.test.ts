import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  IdentityTracker,
  parseCaptureIdentity,
} from "../../frontend/src/capture/identity.ts";
import { OcrClient } from "../../frontend/src/ocr/client.ts";
const req = createRequire(import.meta.url);
const { transformSync } = req("esbuild");
const source = readFileSync(
  new URL("../../frontend/src/app/main.ts", import.meta.url),
  "utf8",
);
const ts = req("typescript");
const parsed = ts.createSourceFile(
  "main.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const fn = parsed.statements.find(
  (node: any) =>
    ts.isFunctionDeclaration(node) && node.name?.text === "readWindowIdentity",
);
assert.ok(fn, "readWindowIdentity declaration must exist");
const begin = fn.getStart(parsed),
  end = fn.getEnd();
const identityCode = transformSync(source.slice(begin, end), {
  loader: "ts",
  target: "es2022",
}).code;
const A = { realm: "得陇望蜀", line: "2", character: "甲", evidence: {} };
test("A unknown A does not confirm; next A confirms location as a pair", () => {
  const tracker = new IdentityTracker();
  assert.equal(tracker.observe(A, 1).changed, false);
  tracker.observe({ evidence: {} }, 2);
  assert.equal(tracker.observe(A, 3).changed, false);
  assert.equal(tracker.observe(A, 4).identity.line, "2");
});
test("confirmation retains the sampled frame timestamp", async () => {
  let now = 10000;
  const bound: number[] = [];
  const tracker = new IdentityTracker();
  const env: any = {
    identity: { evidence: {} },
    identityDue: 0,
    realm: "得陇望蜀",
    locationConfirmed: false,
    performance: { now: () => now },
    source: {},
    recorder: {},
    client: {
      readIdentity: async () => {
        now += 4000;
        return { title: "得陇望蜀2线", character: "甲" };
      },
    },
    ocrGeneration: 1,
    checked: () => true,
    identityImages: () => ({ title: {}, character: {}, hasTitleBar: true }),
    $: () => ({}),
    startedUtc: 100000,
    startedMono: 0,
    parseCaptureIdentity,
    identityTracker: tracker,
    renderIdentity() {},
    bindIdentity: (t: number) => bound.push(t),
    setText() {},
  };
  const run = new Function(
    ...Object.keys(env),
    identityCode + ";return readWindowIdentity;",
  )(...Object.values(env));
  await run(1);
  now += 40000;
  const captureTime = now;
  await run(1);
  assert.equal(bound.at(-1), 100000 + captureTime);
});
test("real identity RPC timeout keeps checkbox enabled and next chat tick recreates worker", async () => {
  const tickStart = source.indexOf("async function tickOcr()"),
    tickEnd = source.indexOf("function renderMessages()", tickStart);
  const tickCode = transformSync(source.slice(tickStart, tickEnd), {
    loader: "ts",
    target: "es2022",
  }).code;
  let workers = 0,
    chatReads = 0,
    identityReads = 0,
    ingests = 0;
  const clients: OcrClient[] = [];
  const makeClient = () => {
    workers++;
    const worker: any = {
      postMessage(m: any) {
        if (m.type === "identity") {
          identityReads++;
          return;
        }
        chatReads++;
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
      terminate() {},
    };
    const c = new OcrClient({
      workerFactory: () => worker,
      identityTimeoutMs: 20,
      inferenceTimeoutMs: 200,
    });
    clients.push(c);
    return c;
  };
  const checkbox = { checked: true };
  const nodes = new Map();
  const $ = (id: string) =>
    id === "ocr-enabled"
      ? checkbox
      : (nodes.get(id) ?? (nodes.set(id, {}), nodes.get(id)));
  const env: any = {
    client: undefined,
    makeClient,
    identity: { evidence: {} },
    identityDue: 0,
    realm: "得陇望蜀",
    locationConfirmed: false,
    identityTracker: new IdentityTracker(),
    performance,
    source: {},
    recorder: { sessionId: "capture" },
    crop: {
      image: () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) }),
    },
    merger: {
      ingest() {
        ingests++;
        return [];
      },
    },
    checked: () => checkbox.checked,
    ocrBusy: false,
    ocrGeneration: 1,
    startedUtc: Date.now(),
    startedMono: performance.now(),
    frame: 0,
    connectCollector: async () => {},
    identityImages: () => ({
      title: { data: new Uint8ClampedArray(4) },
      character: { data: new Uint8ClampedArray(4) },
      hasTitleBar: true,
    }),
    $,
    setText() {},
    renderIdentity() {},
    bindIdentity() {},
    parseCaptureIdentity,
    ocrDevice: "fake",
    deviceName: (x: any) => x,
    knownMessages: new Map(),
    messageCandidates: (x: any) => x,
    archive: { update() {} },
    sessionMessageIds: new Set(),
    store: { saveMessages: async () => {} },
    sync: { notify() {} },
    renderMessages() {},
    button: $,
    notify() {},
    describe: String,
  };
  const harness = new Function(
    ...Object.keys(env),
    identityCode +
      "\nasync function loadOcr(){if(!client)client=makeClient();}\n" +
      tickCode +
      "\nreturn {tickOcr,getClient:()=>client};",
  )(...Object.values(env));
  try {
    await harness.tickOcr();
    assert.equal(chatReads, 1);
    assert.equal(identityReads, 1);
    assert.equal(checkbox.checked, true);
    assert.equal(clients[0].isClosed, true);
    assert.equal(harness.getClient(), undefined);
    await harness.tickOcr();
    assert.equal(workers, 2);
    assert.equal(chatReads, 2);
    assert.equal(ingests, 2);
    assert.equal(checkbox.checked, true);
    assert.equal(
      identityReads,
      1,
      "backoff avoids immediate repeat identity timeout",
    );
  } finally {
    clients.forEach((c) => c.close());
  }
});
