// Pure image operations. No access to recording, storage or upload state.
export function signature({ data, width: w, height: h }) {
  const gray = new Float32Array(w * h),
    tmp = new Float32Array(w * h),
    out = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++)
    gray[i] = Math.round(
      0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2],
    );
  const radius = 12,
    k = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const x = Math.exp((-i * i) / 18);
    k.push(x);
    sum += x;
  }
  k.forEach((x, i) => (k[i] = x / sum));
  const reflect = (v, max) => (v < 0 ? -v : v >= max ? 2 * max - v - 2 : v);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -radius; i <= radius; i++)
        s += gray[y * w + reflect(x + i, w)] * k[i + radius];
      tmp[y * w + x] = s;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -radius; i <= radius; i++)
        s += tmp[reflect(y + i, h) * w + x] * k[i + radius];
      out[y * w + x] = gray[y * w + x] - s > 18 ? 1 : 0;
    }
  return out;
}
const median = (a) => {
  a = [...a].sort((x, y) => x - y);
  return a.length
    ? (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2
    : 0;
};
export function change(a, b, w) {
  if (!a || a.length !== b.length) return 1;
  const h = b.length / w,
    rows = [];
  let peak = 0;
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) n += a[y * w + x] !== b[y * w + x] ? 1 : 0;
    rows.push(n);
  }
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let j = y; j < Math.min(h, y + 12); j++) n += rows[j];
    peak = Math.max(peak, n);
  }
  return peak / (w * Math.min(12, h));
}
function brightColor(r, g, b) {
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min;
  const sat = max ? (d / max) * 255 : 0;
  let hue = 0;
  if (d) {
    hue =
      max === r
        ? ((g - b) / d) % 6
        : max === g
          ? (b - r) / d + 2
          : (r - g) / d + 4;
    hue *= 30;
    if (hue < 0) hue += 180;
  }
  return (
    max >= 145 &&
    ((hue >= 15 && hue <= 45 && sat >= 80) || sat < 100 || hue >= 135)
  );
}
export function splitLines(image) {
  const { width: w, height: h, data } = image,
    mask = signature(image),
    projection = new Float32Array(h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) projection[y] += mask[y * w + x];
  const active = Array.from(projection, (n) => (n >= 6 ? 1 : 0)),
    dil = active.map((_, y) =>
      Math.max(...active.slice(Math.max(0, y - 1), Math.min(h, y + 2))),
    );
  const closed = dil.map((_, y) =>
    Math.min(...dil.slice(Math.max(0, y - 1), Math.min(h, y + 2))),
  );
  const spans = [];
  for (let y = 0; y < h; ) {
    if (!closed[y]) {
      y++;
      continue;
    }
    const t = y;
    while (y < h && closed[y]) y++;
    if (y - t >= 4) spans.push([t, y]);
  }
  const gaps = spans
      .slice(1)
      .map((s, i) => s[0] - spans[i][0])
      .filter((n) => n >= 8),
    pitch = median(gaps),
    parts = [];
  for (const [t, b] of spans) {
    const count = pitch ? Math.max(1, Math.round((b - t) / pitch)) : 1,
      cuts = [t];
    for (let i = 1; i < count; i++) {
      const expected = t + ((b - t) * i) / count,
        lo = Math.max(cuts.at(-1) + 4, Math.round(expected - pitch * 0.18)),
        hi = Math.min(b - 4, Math.round(expected + pitch * 0.18));
      if (lo < hi) {
        let best = lo;
        for (let j = lo; j < hi; j++)
          if (projection[j] < projection[best]) best = j;
        cuts.push(best);
      }
    }
    cuts.push(b);
    for (let i = 0; i < cuts.length - 1; i++)
      parts.push([cuts[i], cuts[i + 1]]);
  }
  const typical = median(parts.map(([t, b]) => b - t)),
    boxes = [],
    dropped = [];
  for (let i = 0; i < parts.length; i++) {
    let [t, b] = parts[i];
    const edge = i < 3 || i >= parts.length - 3,
      peak = Math.max(...projection.slice(t, b));
    const boundary = Math.max(
      t ? projection[t - 1] : peak,
      b < h ? projection[b] : peak,
    );
    let reason = "";
    if (edge) {
      if (i < 3 && t <= 1) reason = "top_capture_edge";
      else if (b >= h - 1) reason = "bottom_capture_edge";
      else if (typical && (b - t < 0.65 * typical || b - t > 1.45 * typical))
        reason = "abnormal_line_height";
      else if (boundary > Math.max(6, 0.18 * peak))
        reason = "unsafe_text_boundary";
    }
    if (reason) {
      dropped.push({ top: t, bottom: b, reason });
      continue;
    }
    if (t && projection[t - 1] === 0) t = Math.max(0, t - 2);
    if (b < h && projection[b] === 0) b = Math.min(h, b + 2);
    let left = w,
      right = -1,
      lastBright = -1,
      firstBright = w,
      brightColumns = 0;
    for (let x = 0; x < w; x++) {
      let ink = false,
        bright = false;
      for (let y = t; y < b; y++)
        if (mask[y * w + x]) {
          ink = true;
          const j = (y * w + x) * 4;
          if (brightColor(data[j], data[j + 1], data[j + 2])) bright = true;
        }
      if (ink) {
        left = Math.min(left, x);
        right = x;
      }
      if (bright) {
        firstBright = Math.min(firstBright, x);
        lastBright = x;
        brightColumns++;
      }
    }
    if (right < 0) continue;
    left = Math.max(0, left - 3);
    right = Math.min(w, right + 4);
    if (brightColumns >= 8 && firstBright - left <= 20)
      right = Math.min(right, lastBright + 5);
    boxes.push([left, t, right, b]);
  }
  return { boxes, dropped, mask };
}
export function cropWithBorder(image, box) {
  const [l, t, r, b] = box,
    w = r - l + 6,
    h = b - t + 4,
    out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.min(r - 1, Math.max(l, l + x - 3)),
        sy = Math.min(b - 1, Math.max(t, t + y - 2)),
        a = (sy * image.width + sx) * 4,
        c = (y * w + x) * 4;
      out.set(image.data.subarray(a, a + 4), c);
    }
  return { data: out, width: w, height: h };
}
// Bilinear RGB->BGR normalization matches Python's channel order; browser resize may differ by rounding.
export function tensorInput(image) {
  const h = 48,
    resized = Math.ceil((h * image.width) / image.height),
    w = Math.max(
      320,
      Math.floor(h * Math.max(320 / h, image.width / image.height)),
    ),
    out = new Float32Array(3 * h * w);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < Math.min(w, resized); x++) {
      const sx = ((x + 0.5) * image.width) / resized - 0.5,
        sy = ((y + 0.5) * image.height) / h - 0.5,
        x0 = Math.floor(sx),
        y0 = Math.floor(sy),
        dx = sx - x0,
        dy = sy - y0;
      for (let c = 0; c < 3; c++) {
        let v = 0;
        for (let j = 0; j < 2; j++)
          for (let i = 0; i < 2; i++) {
            const px = Math.min(image.width - 1, Math.max(0, x0 + i)),
              py = Math.min(image.height - 1, Math.max(0, y0 + j));
            v +=
              image.data[(py * image.width + px) * 4 + (2 - c)] *
              (i ? dx : 1 - dx) *
              (j ? dy : 1 - dy);
          }
        out[c * h * w + y * w + x] = (Math.round(v) / 255 - 0.5) / 0.5;
      }
    }
  return { data: out, shape: [1, 3, h, w] };
}
