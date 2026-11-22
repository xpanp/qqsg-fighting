export interface ResourceProgress {
  stage: "cache" | "download" | "verify" | "cache-write";
  label: string;
  loaded: number;
  total?: number;
  cacheHit?: boolean;
}
export interface ResourceOptions {
  url: string;
  label: string;
  sha256?: string;
  cacheKey?: string;
  cacheName?: string;
  onProgress?: (progress: ResourceProgress) => void;
  fetcher?: typeof fetch;
  cacheStorage?: CacheStorage | null;
}
export async function loadBinaryResource(options: ResourceOptions) {
  const { url, label, sha256, onProgress } = options;
  const fetcher = options.fetcher ?? fetch;
  const warnings: string[] = [];
  const cacheStorage =
    options.cacheStorage === undefined
      ? globalThis.caches
      : options.cacheStorage;
  const key = options.cacheKey ?? url;
  let cache: Cache | undefined;
  try {
    cache = await cacheStorage?.open(
      options.cacheName ?? "qqsg-ocr-resources-v2",
    );
  } catch {
    warnings.push("浏览器缓存不可用，本次下载仍可正常识别");
  }
  const verify = async (buffer: ArrayBuffer, cacheHit: boolean) => {
    onProgress?.({
      stage: "verify",
      label,
      loaded: buffer.byteLength,
      total: buffer.byteLength,
      cacheHit,
    });
    if (sha256) {
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      const actual = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      if (actual !== sha256.toLowerCase())
        throw Error(`${label}校验失败，请检查下载后重试`);
    }
  };
  onProgress?.({ stage: "cache", label, loaded: 0 });
  try {
    const cached = await cache?.match(key);
    if (cached) {
      const buffer = await cached.arrayBuffer();
      await verify(buffer, true);
      return { buffer, cacheHit: true, warnings };
    }
  } catch {
    warnings.push(`${label}缓存不可用，将重新下载`);
    try {
      await cache?.delete(key);
    } catch {}
  }
  onProgress?.({ stage: "download", label, loaded: 0, cacheHit: false });
  const response = await fetcher(url);
  if (!response.ok)
    throw Error(`${label}下载失败（HTTP ${response.status}），请稍后重试`);
  const declared = Number(response.headers.get("content-length"));
  const encoding = response.headers.get("content-encoding");
  const total =
    (!encoding || encoding === "identity") &&
    Number.isFinite(declared) &&
    declared > 0
      ? declared
      : undefined;
  let buffer: ArrayBuffer;
  if (response.body) {
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let loaded = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        onProgress?.({
          stage: "download",
          label,
          loaded,
          total: total && loaded <= total ? total : undefined,
          cacheHit: false,
        });
      }
    } finally {
      reader.releaseLock();
    }
    const joined = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    buffer = joined.buffer;
  } else buffer = await response.arrayBuffer();
  if (!buffer.byteLength) throw Error(`${label}下载结果为空，请重试`);
  onProgress?.({
    stage: "download",
    label,
    loaded: buffer.byteLength,
    total: buffer.byteLength,
    cacheHit: false,
  });
  await verify(buffer, false);
  if (cache) {
    onProgress?.({
      stage: "cache-write",
      label,
      loaded: buffer.byteLength,
      total: buffer.byteLength,
    });
    try {
      await cache.put(
        key,
        new Response(buffer.slice(0), {
          headers: {
            "Content-Type":
              response.headers.get("content-type") ??
              "application/octet-stream",
          },
        }),
      );
    } catch {
      warnings.push(`${label}无法写入浏览器缓存，下次可能需要重新下载`);
    }
  }
  return { buffer, cacheHit: false, warnings };
}
