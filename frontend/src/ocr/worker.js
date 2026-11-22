import * as ort from "onnxruntime-web/webgpu";
import { loadBinaryResource } from "./resources.ts";
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
async function init(preferred = "webgpu", report = () => {}) {
  if (session) return { provider, cacheHit: true };
  if (initializing) return initializing;
  initializing = (async () => {
    ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 1);
    const start = performance.now();
    report({ stage: "configuration", label: "读取识别配置", loaded: 0 });
    const configResponse = await fetch(new URL("models/model.json", baseUrl));
    if (!configResponse.ok) throw Error("无法加载识别配置，请刷新页面重试");
    const config = await configResponse.json();
    if (!config.url || !config.url.startsWith("https://"))
      throw Error("识别配置缺少公开模型下载地址，请刷新页面重试");
    const warnings = [];
    const dictionary = await loadBinaryResource({
      url: new URL("models/" + config.characters, baseUrl).href,
      label: "字典",
      cacheKey: new URL(
        "models/" + config.characters + "?model=" + config.sha256,
        baseUrl,
      ).href,
      sha256:
        config.charactersSha256 ??
        "e41e95fa4e12cc4e971e2ec4ab32a205a700056bc8a46e0803cd3f59f4d93dcf",
      onProgress: report,
    });
    characters = JSON.parse(new TextDecoder().decode(dictionary.buffer));
    if (
      !Array.isArray(characters) ||
      characters.length !== 18710 ||
      characters.some((value) => typeof value !== "string")
    )
      throw Error("识别字典格式不正确，请重新准备资源");
    warnings.push(...dictionary.warnings);
    const model = await loadBinaryResource({
      url: config.url,
      label: "识别模型",
      sha256: config.sha256,
      cacheName: "qqsg-models-v1", // Reuse verified model bytes from the first deployed version.
      cacheKey: new URL(
        "models/" + config.file + "?sha256=" + config.sha256,
        baseUrl,
      ).href,
      onProgress: report,
    });
    warnings.push(...model.warnings);
    // Supplying wasmBinary lets us show the actual runtime download instead of
    // letting ONNX Runtime fetch a large invisible file during initialization.
    const runtime = await loadBinaryResource({
      url: new URL("vendor/ort/ort-wasm-simd-threaded.asyncify.wasm", baseUrl)
        .href,
      label: "识别运行库",
      sha256:
        "ca319e9539cd0f1e291cf56074760121eaf39650f5dbf84b6e52c07f4b2944ec",
      cacheKey: new URL(
        "vendor/ort/ort-wasm-simd-threaded.asyncify.wasm?v=1.31.1",
        baseUrl,
      ).href,
      onProgress: report,
    });
    warnings.push(...runtime.warnings);
    ort.env.wasm.wasmBinary = runtime.buffer;
    ort.env.wasm.wasmPaths = {
      mjs: new URL("vendor/ort/ort-wasm-simd-threaded.asyncify.mjs", baseUrl)
        .href,
    };
    const errors = [];
    for (const candidate of preferred === "wasm"
      ? ["wasm"]
      : ["webgpu", "wasm"]) {
      report({
        stage: "initializing",
        label:
          candidate === "webgpu"
            ? "正在启动本机 GPU 识别"
            : "正在启动本机 CPU 识别",
        loaded: 0,
      });
      try {
        session = await ort.InferenceSession.create(model.buffer, {
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
    report({
      stage: "ready",
      label: "本机识别已就绪",
      loaded: 0,
      cacheHit: model.cacheHit,
    });
    return {
      provider,
      initializationMs: performance.now() - start,
      fallbackReasons: errors,
      threads: ort.env.wasm.numThreads,
      cacheHit: model.cacheHit,
      runtimeCacheHit: runtime.cacheHit,
      warnings,
    };
  })();
  try {
    return await initializing;
  } finally {
    if (!session) initializing = undefined;
  }
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
    let lastProgressAt = -Infinity;
    const report = (progress) => {
      const now = performance.now();
      if (
        progress.stage === "download" &&
        progress.loaded &&
        progress.loaded !== progress.total &&
        now - lastProgressAt < 120
      )
        return;
      lastProgressAt = now;
      self.postMessage({ type: "progress", id: m.id, progress });
    };
    if (m.type === "init") {
      self.postMessage({ id: m.id, result: await init(m.provider, report) });
      return;
    }
    await init(m.provider, report);
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
    self.postMessage({ id: m.id, error: e.message || String(e) });
  }
};
