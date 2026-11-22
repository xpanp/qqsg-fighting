import test from "node:test";
import assert from "node:assert/strict";
import { loadBinaryResource } from "../../frontend/src/ocr/resources.ts";

const payload = Uint8Array.from([1, 2, 3, 4, 5, 6]);
const digest = async (bytes: Uint8Array) =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
  ).toString("hex");
function cacheFixture(initial?: Response, fail = false) {
  let response = initial;
  const calls: string[] = [];
  const keys: string[] = [];
  return {
    calls,
    keys,
    storage: {
      async open() {
        if (fail) throw Error("cache disabled");
        return {
          async match(key: string) {
            calls.push("match");
            keys.push(key);
            return response?.clone();
          },
          async delete() {
            calls.push("delete");
            response = undefined;
            return true;
          },
          async put(_key: string, value: Response) {
            calls.push("put");
            response = value.clone();
          },
        };
      },
    } as unknown as CacheStorage,
  };
}
function streamedResponse(length?: number) {
  const chunks = [payload.slice(0, 2), payload.slice(2, 5), payload.slice(5)];
  return new Response(
    new ReadableStream({
      pull(controller) {
        const chunk = chunks.shift();
        chunk ? controller.enqueue(chunk) : controller.close();
      },
    }),
    {
      headers: length === undefined ? {} : { "content-length": String(length) },
    },
  );
}

test("cold download emits cumulative progress and caches only verified bytes", async () => {
  const cache = cacheFixture(),
    progress: any[] = [],
    sha256 = await digest(payload);
  const output = await loadBinaryResource({
    url: "https://example.test/model.onnx",
    cacheKey: "model-v1",
    sha256,
    label: "model",
    cacheStorage: cache.storage,
    fetcher: async () => streamedResponse(payload.length),
    onProgress: (event) => progress.push(event),
  });
  assert.deepEqual(new Uint8Array(output.buffer), payload);
  assert.equal(output.cacheHit, false);
  const downloads = progress.filter((event) => event.stage === "download");
  assert.ok(
    downloads.some(
      (event) =>
        event.loaded === payload.length && event.total === payload.length,
    ),
  );
  assert.equal(
    downloads.every(
      (event, i) => !i || event.loaded >= downloads[i - 1].loaded,
    ),
    true,
  );
  assert.equal(cache.calls.filter((call) => call === "put").length, 1);
});

test("unknown content length reports bytes without inventing a total", async () => {
  const progress: any[] = [],
    cache = cacheFixture();
  await loadBinaryResource({
    url: "https://example.test/model.onnx",
    label: "model",
    cacheStorage: cache.storage,
    fetcher: async () => streamedResponse(),
    onProgress: (event) => progress.push(event),
  });
  const downloads = progress.filter((event) => event.stage === "download");
  assert.ok(downloads.some((event) => event.loaded === payload.length));
  assert.equal(
    downloads
      .filter((event) => event.loaded < payload.length)
      .every((event) => event.total === undefined),
    true,
  );
  assert.equal(
    downloads.every(
      (event) => event.total === undefined || event.total === payload.length,
    ),
    true,
  );
});

test("valid cached bytes avoid network and still pass checksum verification", async () => {
  const cache = cacheFixture(new Response(payload));
  let requests = 0;
  const output = await loadBinaryResource({
    url: "https://example.test/model.onnx",
    cacheKey: "model-v1",
    sha256: await digest(payload),
    label: "model",
    cacheStorage: cache.storage,
    fetcher: async () => {
      requests++;
      throw Error("network forbidden");
    },
  });
  assert.equal(requests, 0);
  assert.equal(output.cacheHit, true);
  assert.deepEqual(new Uint8Array(output.buffer), payload);
});

test("corrupt cache is deleted and replaced from network", async () => {
  const cache = cacheFixture(new Response("bad-cache"));
  let requests = 0;
  const output = await loadBinaryResource({
    url: "https://example.test/model.onnx",
    cacheKey: "model-v1",
    sha256: await digest(payload),
    label: "model",
    cacheStorage: cache.storage,
    fetcher: async () => {
      requests++;
      return streamedResponse(payload.length);
    },
  });
  assert.equal(requests, 1);
  assert.equal(output.cacheHit, false);
  assert.ok(cache.calls.includes("delete"));
  assert.deepEqual(new Uint8Array(output.buffer), payload);
});

test("network checksum failure never stores an invalid model", async () => {
  const cache = cacheFixture();
  await assert.rejects(
    loadBinaryResource({
      url: "https://example.test/model.onnx",
      cacheKey: "model-v1",
      sha256: await digest(payload),
      label: "model",
      cacheStorage: cache.storage,
      fetcher: async () => new Response("corrupt-response"),
    }),
  );
  assert.equal(cache.calls.includes("put"), false);
});

test("unavailable browser cache falls back to network with a warning", async () => {
  const cache = cacheFixture(undefined, true);
  const output = await loadBinaryResource({
    url: "https://example.test/model.onnx",
    cacheKey: "model-v1",
    sha256: await digest(payload),
    label: "model",
    cacheStorage: cache.storage,
    fetcher: async () => streamedResponse(payload.length),
  });
  assert.deepEqual(new Uint8Array(output.buffer), payload);
  assert.ok(output.warnings.length > 0);
});

test("HTTP failure is not accepted as a model payload", async () => {
  const cache = cacheFixture();
  await assert.rejects(
    loadBinaryResource({
      url: "https://example.test/model.onnx",
      label: "model",
      cacheStorage: cache.storage,
      fetcher: async () => new Response("not found", { status: 404 }),
    }),
  );
  assert.equal(cache.calls.includes("put"), false);
});

test("external model URL reuses prior same-origin verified cache key", async () => {
  const cache = cacheFixture(new Response(payload));
  const oldKey = "https://example.test/fighting/models/model.onnx?sha256=known";
  const output = await loadBinaryResource({
    url: "https://www.modelscope.cn/models/example/model/resolve/v1/model.onnx",
    cacheKey: oldKey,
    cacheName: "qqsg-models-v1",
    sha256: await digest(payload),
    label: "model",
    cacheStorage: cache.storage,
    fetcher: async () => {
      throw Error("cached model must not download again");
    },
  });
  assert.equal(output.cacheHit, true);
  assert.deepEqual(cache.keys, [oldKey]);
});

test("cold external download uses public URL with an independent cache key", async () => {
  const cache = cacheFixture(),
    urls: string[] = [];
  const publicUrl =
    "https://www.modelscope.cn/models/example/model/resolve/v1/model.onnx";
  await loadBinaryResource({
    url: publicUrl,
    cacheKey: "https://example.test/fighting/models/model.onnx?sha256=known",
    sha256: await digest(payload),
    label: "model",
    cacheStorage: cache.storage,
    fetcher: async (input) => {
      urls.push(String(input));
      return streamedResponse(payload.length);
    },
  });
  assert.deepEqual(urls, [publicUrl]);
  assert.equal(cache.calls.includes("put"), true);
});
