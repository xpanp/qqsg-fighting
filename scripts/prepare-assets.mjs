/** Prepare reproducible local assets; no real recording or chat is needed. */
import { readFile, writeFile, mkdir, copyFile, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, "frontend/public");
const source =
  "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/";
const model = {
  file: "PP-OCRv6_rec_medium.onnx",
  url: source + "onnx/PP-OCRv6/rec/PP-OCRv6_rec_medium.onnx",
  characters: "characters.json",
  sha256: "eef444829dbbe18d7fea59a3f6eb75647518d2b3a9568d27c92e42940204894b",
  name: "PP-OCRv6_rec_medium",
};
const hash = (b) => createHash("sha256").update(b).digest("hex");
async function checkedFile(file, url, expected) {
  try {
    const b = await readFile(file);
    if (hash(b) === expected) return b;
  } catch {}
  console.log("Downloading", url);
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw Error(`Download failed: ${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== expected) throw Error(`SHA256 mismatch: ${url}`);
  await writeFile(file, bytes);
  return bytes;
}
await mkdir(resolve(target, "models"), { recursive: true });
await mkdir(resolve(target, "vendor/ort"), { recursive: true });
// Remove only the known generated weight from the previous same-origin build.
// Vite copies every public file, so leaving it here would still ship 73 MiB.
const legacyWeight = resolve(target, "models", model.file);
let previousWeight;
try {
  previousWeight = await readFile(legacyWeight);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (previousWeight) {
  if (hash(previousWeight) !== model.sha256)
    throw Error("Unexpected local weight; refusing to remove it");
  await unlink(legacyWeight);
}
const dict = await checkedFile(
  resolve(target, "models/ppocrv6_dict.txt"),
  source + "paddle/PP-OCRv6/rec/PP-OCRv6_rec_medium/ppocrv6_dict.txt",
  "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d",
);
const characters = [
  "blank",
  ...dict.toString("utf8").trimEnd().split(/\r?\n/),
  " ",
];
if (characters.length !== 18710) throw Error("Unexpected dictionary size");
await writeFile(
  resolve(target, "models/characters.json"),
  JSON.stringify(characters),
);
await writeFile(
  resolve(target, "models/model.json"),
  JSON.stringify(
    {
      ...model,
      charactersSha256: hash(Buffer.from(JSON.stringify(characters))),
    },
    null,
    2,
  ),
);
const pkg = JSON.parse(
  await readFile(
    resolve(root, "node_modules/onnxruntime-web/package.json"),
    "utf8",
  ),
);
if (pkg.version !== "1.31.1")
  throw Error("Unexpected ONNX Runtime Web version");
for (const file of [
  "ort.webgpu.min.mjs",
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
]) {
  await copyFile(
    resolve(root, "node_modules/onnxruntime-web/dist", file),
    resolve(target, "vendor/ort", file),
  );
}
console.log(
  "Public model URL, dictionary and ONNX Runtime Web assets ready (weight not bundled).",
);
