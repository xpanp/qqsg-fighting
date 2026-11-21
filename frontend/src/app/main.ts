import "./style.css";
import { renderShell, element as $, setText, notify } from "./view";
import { selectWindow, createCrop } from "../capture/window";
import { DurableRecorder } from "../capture/recorder";
import { OcrClient } from "../ocr/client";
import { MessageMerger } from "../messages/merger";
import * as store from "../storage/journal";
import type { Rect, MergedMessage } from "../../../contracts/types";
renderShell();
let folder: store.DirectoryHandle | undefined,
  source: MediaStream | undefined,
  area: Rect | undefined,
  drag: { x: number; y: number } | undefined;
let recorder: DurableRecorder | undefined,
  crop: ReturnType<typeof createCrop> | undefined,
  merger: MessageMerger | undefined;
let previewTimer: ReturnType<typeof setInterval> | undefined,
  ocrTimer: ReturnType<typeof setInterval> | undefined,
  elapsedTimer: ReturnType<typeof setInterval> | undefined;
let client: OcrClient | undefined,
  loading: Promise<void> | undefined,
  ocrBusy = false,
  starting = false,
  stopping = false,
  startedMono = 0,
  startedUtc = 0,
  frame = 0,
  chunks = 0,
  sessionGeneration = 0;
const knownMessages = new Map<string, MergedMessage>();
let releaseCaptureLease: (() => void) | undefined;
const button = (id: string) => $<HTMLButtonElement>(id),
  checked = (id: string) => $<HTMLInputElement>(id).checked;
const formatTime = (ms: number) =>
  new Date(ms).toLocaleString("zh-CN", { hour12: false });
function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function failure(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return;
  notify(describe(error), true);
}
function controls() {
  const busy = starting || stopping || !!recorder;
  button("folder").disabled = busy;
  button("share").disabled = busy;
  button("record").disabled = busy || !folder || !source || !area;
  button("stop").disabled = !recorder || stopping;
  for (const [id, active] of [
    ["step-folder", !!folder],
    ["step-window", !!source],
    ["step-area", !!area],
  ] as const)
    $(id).classList.toggle("active", active);
}
async function loadOcr() {
  if (client) return;
  if (loading) return loading;
  loading = (async () => {
    setText("ocr-status", "正在准备本机识别，首次需下载约 73 MB 模型…");
    button("retry-ocr").hidden = true;
    const next = new OcrClient();
    try {
      const info = await next.init();
      client = next;
      setText(
        "ocr-status",
        info.provider === "webgpu"
          ? "识别已准备好 · 使用本机 GPU"
          : "识别已准备好 · 使用本机 CPU，速度可能较慢",
      );
    } catch (e) {
      next.close();
      throw e;
    }
  })();
  try {
    await loading;
  } finally {
    loading = undefined;
  }
}
async function tickOcr() {
  if (!recorder || !crop || !merger || !checked("ocr-enabled") || ocrBusy)
    return;
  ocrBusy = true;
  const token = sessionGeneration,
    current = merger;
  try {
    await loadOcr();
    if (token !== sessionGeneration || !crop || !checked("ocr-enabled")) return;
    const relativeMs = performance.now() - startedMono;
    const context = {
      sessionId: recorder!.sessionId,
      frameId: `${recorder!.sessionId}/${++frame}`,
      capturedAtMs: startedUtc + relativeMs,
      relativeMs,
    };
    const image = crop.image();
    const result = await client!.recognize(image);
    if (token !== sessionGeneration || !checked("ocr-enabled")) return;
    if (result.skipped) {
      setText("ocr-status", "画面未变 · 等待新消息");
      return;
    }
    const changes = current.ingest(result.lines, context);
    await store.saveMessages(changes);
    for (const row of changes) knownMessages.set(row.id, row);
    renderMessages();
    setText(
      "ocr-status",
      `正在识别 · 最近一次 ${Math.round(result.elapsedMs)} 毫秒`,
    );
  } catch (e) {
    client?.close();
    client = undefined;
    setText("ocr-status", "识别暂不可用，视频录制继续");
    button("retry-ocr").hidden = false;
    notify(`文字识别：${describe(e)}。录像不受影响，可点击重试识别。`, true);
    $<HTMLInputElement>("ocr-enabled").checked = false;
  } finally {
    ocrBusy = false;
  }
}
function renderMessages() {
  const rows = [...knownMessages.values()]
    .sort((a, b) => a.firstObservedAtMs - b.firstObservedAtMs)
    .slice(-200);
  setText("message-count", `${knownMessages.size} 条消息 · 显示最近 200 条`);
  const target = $("messages");
  if (!rows.length) return;
  const scrollTop = target.scrollTop;
  target.replaceChildren();
  for (const row of rows) {
    const el = document.createElement("div");
    el.className = "message";
    const time = document.createElement("time");
    time.textContent =
      formatTime(row.firstObservedAtMs) +
      (row.gameTime ? ` · 游戏 ${row.gameTime}` : "");
    el.append(time, document.createTextNode(row.text));
    target.append(el);
  }
  target.scrollTop = checked("autoscroll") ? target.scrollHeight : scrollTop;
}
function paintPreview() {
  const video = $<HTMLVideoElement>("source"),
    canvas = $<HTMLCanvasElement>("preview");
  if (!video.videoWidth) return;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  if (area) {
    ctx.fillStyle = "#071a1270";
    ctx.fillRect(0, 0, canvas.width, area.y);
    ctx.fillRect(
      0,
      area.y + area.height,
      canvas.width,
      canvas.height - area.y - area.height,
    );
    ctx.fillRect(0, area.y, area.x, area.height);
    ctx.fillRect(
      area.x + area.width,
      area.y,
      canvas.width - area.x - area.width,
      area.height,
    );
    ctx.strokeStyle = "#49ff9d";
    ctx.lineWidth = Math.max(2, canvas.width / 500);
    ctx.strokeRect(area.x, area.y, area.width, area.height);
  }
}
button("folder").onclick = async () => {
  try {
    folder = await store.chooseDirectory();
    setText("folder-label", "保存目录：" + folder.name);
    notify("保存目录已选择，接下来选择 QQ 三国窗口。");
    controls();
  } catch (e) {
    failure(e);
  }
};
button("share").onclick = async () => {
  try {
    const next = await selectWindow();
    source?.getTracks().forEach((t) => t.stop());
    source = next;
    area = undefined;
    const video = $<HTMLVideoElement>("source");
    video.srcObject = next;
    await video.play();
    const c = $<HTMLCanvasElement>("preview");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.hidden = false;
    $("placeholder").hidden = true;
    clearInterval(previewTimer);
    previewTimer = setInterval(paintPreview, 100);
    paintPreview();
    setText(
      "selection-notice",
      "现在请在下方游戏画面按住鼠标拖动，框住完整聊天区；框好后才能开始录制。",
    );
    setText("area-label", "等待你拖动鼠标框选聊天区");
    notify("窗口已连接，请在预览画面上拖动框选聊天区域。");
    next.getVideoTracks()[0].addEventListener(
      "ended",
      () => {
        if (source !== next) return;
        void stop().finally(() => {
          source = undefined;
          area = undefined;
          clearInterval(previewTimer);
          controls();
          notify("窗口共享已结束，请检查最近视频的保存状态。");
        });
      },
      { once: true },
    );
    controls();
  } catch (e) {
    failure(e);
  }
};
function point(e: PointerEvent) {
  const c = $<HTMLCanvasElement>("preview"),
    r = c.getBoundingClientRect();
  return {
    x: Math.round(
      Math.max(
        0,
        Math.min(c.width, ((e.clientX - r.left) * c.width) / r.width),
      ),
    ),
    y: Math.round(
      Math.max(
        0,
        Math.min(c.height, ((e.clientY - r.top) * c.height) / r.height),
      ),
    ),
  };
}
const preview = $<HTMLCanvasElement>("preview");
preview.onpointerdown = (e) => {
  if (!source || recorder || starting) return;
  drag = point(e);
  area = undefined;
  preview.setPointerCapture(e.pointerId);
};
preview.onpointermove = (e) => {
  if (!drag) return;
  const p = point(e);
  area = {
    x: Math.min(p.x, drag.x),
    y: Math.min(p.y, drag.y),
    width: Math.abs(p.x - drag.x),
    height: Math.abs(p.y - drag.y),
  };
  paintPreview();
};
preview.onpointerup = () => {
  if (!drag) return;
  drag = undefined;
  if (!area || area.width < 60 || area.height < 30) {
    area = undefined;
    setText("area-label", "选区太小，请重新拖框选择完整聊天区域");
  } else {
    setText(
      "area-label",
      `已选聊天区域：${area.width} × ${area.height} 像素 · 可重新拖框调整`,
    );
    setText(
      "selection-notice",
      "聊天区域已选好。录制后每分钟保存一个视频，请保持本页开启。",
    );
    notify("准备就绪，点击“开始录制”。");
  }
  controls();
};
preview.onpointercancel = () => {
  drag = undefined;
  area = undefined;
  controls();
};
async function start() {
  if (starting || recorder) return;
  if (!source || !area || !folder)
    throw Error("请先选择保存目录、游戏窗口，并框选聊天区域。");
  starting = true;
  controls();
  const token = ++sessionGeneration;
  try {
    await store.database();
    await navigator.storage?.persist?.().catch(() => false);
    if (token !== sessionGeneration) return;
    releaseCaptureLease = await store.acquireCaptureLease();
    if (token !== sessionGeneration) {
      releaseCaptureLease();
      releaseCaptureLease = undefined;
      return;
    }
    if (
      !source.getVideoTracks()[0] ||
      source.getVideoTracks()[0].readyState !== "live"
    )
      throw Error("窗口共享已结束，请重新选择窗口");
    startedMono = performance.now();
    startedUtc = Date.now();
    crop = createCrop($<HTMLVideoElement>("source"), { ...area });
    frame = 0;
    chunks = 0;
    const next = new DurableRecorder(crop.stream, {
      folder,
      metadata: {
        area: { ...area },
        captureStartedUtcMs: startedUtc,
        captureStartedMono: startedMono,
        sourceSettings: source.getVideoTracks()[0].getSettings(),
      },
      now: () => startedUtc + performance.now() - startedMono,
      onStatus: (event) => {
        if (token !== sessionGeneration) return;
        if (event.event === "chunk")
          setText("chunk-status", `已暂存 ${++chunks} 个数据块`);
        if (event.event === "segment") {
          void refreshSegments();
          if (event.savedToDirectory)
            notify("视频和时间信息已保存，录制仍在继续。");
        }
        if (event.error) {
          notify(
            `录制保存异常：${event.error}。已暂存的片段可在下方恢复。`,
            true,
          );
          void stop(true);
        }
      },
    });
    recorder = next;
    merger = new MessageMerger(next.sessionId);
    await next.start();
    if (token !== sessionGeneration || recorder !== next) return;
    setText("record-state", "● 正在录制");
    $("record-state").classList.add("recording");
    setText("record-state", "");
    $("record-state").append(
      Object.assign(document.createElement("span"), { className: "dot" }),
      document.createTextNode("正在录制"),
    );
    notify("正在录制聊天区域，每分钟自动保存一段视频。");
    elapsedTimer = setInterval(() => {
      const sec = Math.floor((performance.now() - startedMono) / 1000);
      setText(
        "duration",
        String(Math.floor(sec / 60)).padStart(2, "0") +
          ":" +
          String(sec % 60).padStart(2, "0"),
      );
    }, 500);
    ocrTimer = setInterval(() => void tickOcr(), 1000);
    void tickOcr();
  } catch (e) {
    await stop(true);
    throw e;
  } finally {
    starting = false;
    controls();
  }
}
async function stop(hasError = false) {
  if (stopping) return;
  stopping = true;
  controls();
  clearInterval(ocrTimer);
  clearInterval(elapsedTimer);
  sessionGeneration++;
  const current = recorder;
  recorder = undefined;
  try {
    if (current) await current.stop();
    setText(
      "record-state",
      hasError || current?.errors.length
        ? "录制已停止 · 请检查恢复片段"
        : "已停止",
    );
    $("record-state").classList.remove("recording");
    if (current?.errors.length) {
      notify(
        `录制已停止：${current.errors.at(-1)}。请检查下方片段；只有“已保存”的视频已写入目录。`,
        true,
      );
    } else if (current && !hasError && current.savedSegments > 0)
      notify("录制已停止，最后一段视频已完成保存。");
    else if (current && !hasError)
      notify("录制已停止，但未确认生成视频文件。请检查下方片段。", true);
  } catch (e) {
    failure(e);
  } finally {
    try {
      crop?.close();
    } finally {
      crop = undefined;
      releaseCaptureLease?.();
      releaseCaptureLease = undefined;
      stopping = false;
      $("record-state").classList.remove("recording");
      controls();
      await refreshSegments().catch(failure);
    }
  }
}
async function refreshSegments() {
  const all = await store.listSegments();
  const recent = all.slice(0, 10);
  const recentIds = new Set(recent.map((row) => row.id));
  const pending = all.filter(
    (row) =>
      !row.savedToDirectory && row.chunkCount > 0 && !recentIds.has(row.id),
  );
  const rows = [...recent, ...pending],
    target = $("segments");
  target.replaceChildren();
  if (!rows.length) {
    target.innerHTML = '<div class="empty">还没有录制记录</div>';
    return;
  }
  for (const row of rows) {
    if (pending.length && row.id === pending[0].id) {
      const heading = document.createElement("p");
      heading.className = "notice";
      heading.textContent = "更早的未保存片段 · 请恢复到目录后再清理浏览器缓存";
      target.append(heading);
    }
    const el = document.createElement("div");
    el.className = "file-row";
    const info = document.createElement("div");
    info.className = "file-main";
    const title = document.createElement("strong");
    title.textContent =
      row.fileName ??
      `${formatTime(row.startedUtcMs)} · 第 ${row.segment + 1} 段`;
    const sub = document.createElement("small");
    sub.textContent = `${(row.bytes / 1024 / 1024).toFixed(2)} MB · ${row.chunkCount} 个数据块`;
    info.append(title, sub);
    const status = document.createElement("span");
    status.className = row.savedToDirectory ? "saved" : "cached";
    status.textContent = row.savedToDirectory
      ? "✓ 已保存"
      : row.status === "recording" && recorder?.sessionId === row.sessionId
        ? "录制中"
        : "仅在本机缓存";
    el.append(info, status);
    if (
      !row.savedToDirectory &&
      row.chunkCount &&
      recorder?.sessionId !== row.sessionId
    ) {
      const recover = document.createElement("button");
      recover.textContent = "恢复到目录";
      recover.onclick = async () => {
        recover.disabled = true;
        try {
          const destination = await store.chooseDirectory();
          await store.recoverSegmentFiles(row.id, destination);
          notify("片段及时间文件已恢复到目录：" + destination.name);
          await refreshSegments();
        } catch (e) {
          failure(e);
          recover.disabled = false;
        }
      };
      el.append(recover);
    }
    target.append(el);
  }
}
button("record").onclick = () => void start().catch(failure);
button("stop").onclick = () => void stop();
button("refresh").onclick = () => void refreshSegments().catch(failure);
button("retry-ocr").onclick = () => {
  $<HTMLInputElement>("ocr-enabled").checked = true;
  void tickOcr();
};
$<HTMLInputElement>("ocr-enabled").onchange = () => {
  setText(
    "ocr-status",
    checked("ocr-enabled")
      ? "识别已开启，正在等待画面"
      : "识别已暂停，录像继续",
  );
  if (checked("ocr-enabled")) void tickOcr();
};
button("export").onclick = async () => {
  try {
    const rows = (await store.messages()).sort(
      (a, b) => a.firstObservedAtMs - b.firstObservedAtMs,
    );
    store.download(
      new Blob(
        [
          "\ufeff" +
            rows
              .map((r) => `${formatTime(r.firstObservedAtMs)}  ${r.text}`)
              .join("\n"),
        ],
        { type: "text/plain;charset=utf-8" },
      ),
      "messages-" + new Date().toISOString().slice(0, 10) + ".txt",
    );
  } catch (e) {
    failure(e);
  }
};
document.addEventListener("visibilitychange", () => {
  if (recorder && document.hidden)
    notify(
      "页面进入后台，浏览器可能暂停录制任务；请尽量保持本页在前台，并检查视频保存情况。",
      true,
    );
});
window.addEventListener("beforeunload", (e) => {
  if (recorder || starting || stopping) {
    e.preventDefault();
    e.returnValue = "";
  }
});
void store
  .messages()
  .then((rows) => {
    for (const row of rows) knownMessages.set(row.id, row);
    renderMessages();
  })
  .catch(failure);
void refreshSegments().catch(failure);
controls();
if (!isSecureContext || !navigator.mediaDevices?.getDisplayMedia)
  notify("请通过 HTTPS 或本机地址，使用桌面 Chrome / Edge 打开此页面。", true);
