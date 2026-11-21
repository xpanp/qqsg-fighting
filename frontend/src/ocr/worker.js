import * as ort from "onnxruntime-web/webgpu";
import {
  splitLines,
  cropWithBorder,
  tensorInput,
  signature,
  change,
} from "./preprocess.js";
let session,
  characters,
  provider,
  initializing,
  lastSignature,
  lastSize,
  lastRun = -Infinity,
  baseUrl;
async function init(preferred = "webgpu") {
  if (session) return { provider };
  if (initializing) return initializing;
  initializing = (async () => {
    ort.env.wasm.wasmPaths = new URL("vendor/ort/", baseUrl).href;
    ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 1);
    const start = performance.now(),
      config = await (
        await fetch(new URL("models/model.json", baseUrl))
      ).json();
    characters = await (
      await fetch(new URL("models/" + config.characters, baseUrl))
    ).json();
    const cache = await caches.open("qqsg-models-v1"),
      key = new URL(
        "models/" + config.file + "?sha256=" + config.sha256,
        baseUrl,
      ).href;
    let response = await cache.match(key),
      cacheHit = !!response;
    if (!response) {
      response = await fetch(new URL("models/" + config.file, baseUrl));
      if (!response.ok) throw Error("模型下载失败");
      await cache.put(key, response.clone());
    }
    const model = await response.arrayBuffer(),
      hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", model)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
    if (hash !== config.sha256) {
      await cache.delete(key);
      throw Error("模型校验不一致，请重新加载");
    }
    const errors = [];
    for (const candidate of preferred === "wasm"
      ? ["wasm"]
      : ["webgpu", "wasm"]) {
      try {
        session = await ort.InferenceSession.create(model, {
          executionProviders: [candidate],
          graphOptimizationLevel: "all",
        });
        provider = candidate;
        break;
      } catch (e) {
        errors.push(candidate + ": " + e.message);
      }
    }
    if (!session) throw Error(errors.join("\n"));
    return {
      provider,
      initializationMs: performance.now() - start,
      fallbackReasons: errors,
      threads: ort.env.wasm.numThreads,
      cacheHit,
    };
  })();
  return initializing;
}
function decode(output) {
  const data = output.data,
    classes = output.dims.at(-1),
    steps = output.dims.at(-2);
  let last = -1,
    text = "",
    score = 0,
    n = 0;
  for (let t = 0; t < steps; t++) {
    let best = 0;
    for (let c = 1; c < classes; c++)
      if (data[t * classes + c] > data[t * classes + best]) best = c;
    if (best && best !== last) {
      text += characters[best] || "";
      score += data[t * classes + best];
      n++;
    }
    last = best;
  }
  return { text, confidence: n ? score / n : 0 };
}
async function recognize(input) {
  const tensor = new ort.Tensor("float32", input.data, input.shape),
    start = performance.now();
  try {
    const outputs = await session.run({ [session.inputNames[0]]: tensor });
    try {
      return {
        ...decode(outputs[session.outputNames[0]]),
        inferenceMs: performance.now() - start,
      };
    } finally {
      Object.values(outputs).forEach((v) => v.dispose?.());
    }
  } finally {
    tensor.dispose();
  }
}
self.onmessage = async ({ data: m }) => {
  try {
    baseUrl = m.baseUrl;
    if (m.type === "init") {
      self.postMessage({ id: m.id, result: await init(m.provider) });
      return;
    }
    await init(m.provider);
    if (m.type === "exact") {
      const result = await recognize({
        data: new Float32Array(m.buffer),
        shape: m.shape,
      });
      self.postMessage({ id: m.id, result: { ...result, provider } });
      return;
    }
    if (m.type === "stream-frame") {
      const now = performance.now(),
        sig = signature(m.image),
        size = m.image.width + "x" + m.image.height;
      if (
        lastSize === size &&
        change(lastSignature, sig, m.image.width) < 0.015 &&
        now - lastRun < 3000
      ) {
        self.postMessage({
          id: m.id,
          result: { provider, skipped: true, lines: [], elapsedMs: 0 },
        });
        return;
      }
      lastSignature = sig;
      lastSize = size;
      lastRun = now;
    }
    const started = performance.now(),
      seg =
        m.type === "line"
          ? { boxes: [[0, 0, m.image.width, m.image.height]], dropped: [] }
          : splitLines(m.image),
      lines = [];
    for (const box of seg.boxes) {
      const image = m.type === "line" ? m.image : cropWithBorder(m.image, box);
      lines.push({ ...(await recognize(tensorInput(image))), box });
    }
    self.postMessage({
      id: m.id,
      result: {
        provider,
        lines,
        dropped: seg.dropped,
        elapsedMs: performance.now() - started,
      },
    });
  } catch (e) {
    self.postMessage({ id: m.id, error: e.stack || String(e) });
  }
};
