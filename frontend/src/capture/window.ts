import type { Rect } from "../../../contracts/types";
export async function selectWindow() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "window", frameRate: { ideal: 10 } },
    audio: false,
    monitorTypeSurfaces: "exclude",
    selfBrowserSurface: "exclude",
  } as DisplayMediaStreamOptions);
  const track = stream.getVideoTracks()[0];
  if (track.getSettings().displaySurface !== "window") {
    stream.getTracks().forEach((t) => t.stop());
    throw Error("请选择“窗口”中的 QQ 三国，不要选择屏幕或浏览器标签页。");
  }
  return stream;
}
export function createCrop(video: HTMLVideoElement, area: Rect) {
  const canvas = document.createElement("canvas");
  canvas.width = area.width;
  canvas.height = area.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const paint = () =>
    ctx.drawImage(
      video,
      area.x,
      area.y,
      area.width,
      area.height,
      0,
      0,
      area.width,
      area.height,
    );
  paint();
  const timer = setInterval(paint, 100),
    stream = canvas.captureStream(10);
  return {
    canvas,
    stream,
    image: () => ctx.getImageData(0, 0, canvas.width, canvas.height),
    close() {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}
