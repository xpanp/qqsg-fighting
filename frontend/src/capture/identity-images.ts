import type { Rect } from "../../../contracts/types";
/** Read only the selected window's title and HUD; never enlarge the saved crop. */
export function identityImages(video: HTMLVideoElement) {
  if (video.videoWidth < 320 || video.videoHeight < 100)
    throw Error("窗口画面太小，来源暂未识别");
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(760, video.videoWidth);
  canvas.height = Math.min(140, video.videoHeight);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(
    video,
    0,
    0,
    canvas.width,
    canvas.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let bar = 0;
  for (let y = 0; y < Math.min(65, canvas.height); y++) {
    let light = 0,
      total = 0;
    for (
      let x = Math.round(canvas.width * 0.55);
      x < canvas.width * 0.9;
      x += 4
    ) {
      const i = (y * canvas.width + x) * 4;
      const r = pixels.data[i],
        g = pixels.data[i + 1],
        b = pixels.data[i + 2];
      light +=
        r > 210 &&
        g > 210 &&
        b > 210 &&
        Math.max(r, g, b) - Math.min(r, g, b) < 30
          ? 1
          : 0;
      total++;
    }
    if (light / total > 0.8) bar = y + 1;
    else if (y > 4) break;
  }
  if (bar < 15) bar = 0;
  const scale = bar ? Math.min(2, Math.max(0.75, bar / 32)) : 1;
  const read = (r: Rect) => {
    const x = Math.max(0, Math.round(r.x)),
      y = Math.max(0, Math.round(r.y));
    return ctx.getImageData(
      x,
      y,
      Math.max(1, Math.min(Math.round(r.width), canvas.width - x)),
      Math.max(1, Math.min(Math.round(r.height), canvas.height - y)),
    );
  };
  return {
    title: read({
      x: 24,
      y: 2,
      width: Math.min(680, canvas.width - 24),
      height: bar ? bar - 4 : 26,
    }),
    character: read({
      x: 162 * scale,
      y: bar + 7 * scale,
      width: 125 * scale,
      height: 24 * scale,
    }),
    hasTitleBar: !!bar,
  };
}
