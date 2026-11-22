export function renderShell() {
  document.querySelector("#app")!.innerHTML = `
<header><div><h1>QQ三国战报 <span style="font-size:13px;font-weight:400;color:#86968d">by ppp</span></h1><p>记录聊天画面，留住每一场战斗</p></div><span class="local-badge">● 视频与文字只保存在你的电脑</span></header>
<main class="layout"><div id="alert" role="status" aria-live="polite"></div>
<section class="card"><h2>录制聊天区域</h2><div class="subtle">先选保存位置，再选游戏窗口，最后框住聊天区。</div><div class="steps"><span id="step-folder" class="step active">1 选择目录</span><span id="step-window" class="step">2 选择窗口</span><span id="step-area" class="step">3 框选聊天区</span></div>
<div class="controls"><button id="folder">选择保存目录</button><button id="share">选择游戏窗口</button></div><div id="folder-label" class="subtle">未选择保存目录</div>
<div id="selection-notice" class="notice">请选择“窗口”中的 QQ 三国，然后在下方画面拖动鼠标，框住完整聊天区。</div>
<div class="preview-shell"><div id="placeholder">选择游戏窗口后<br>这里会显示画面供你框选</div><video id="source" muted playsinline hidden></video><canvas id="preview" width="640" height="300" hidden></canvas></div><div id="area-label" class="meta-line">尚未框选聊天区域</div>
<div class="status-strip"><span id="record-state"><span class="dot"></span>尚未开始</span><span id="duration">00:00</span></div><div class="controls"><button id="record" class="primary" disabled>开始录制</button><button id="stop" disabled>停止并保存</button></div><div class="meta-line"><span>每分钟自动保存一个视频</span><span id="chunk-status">等待开始</span></div>
<label class="toggle"><input id="ocr-enabled" type="checkbox" checked>同时识别聊天文字</label><div class="controls"><button id="prepare-ocr">提前准备识别</button></div><div id="ocr-preparation" hidden><progress id="ocr-progress" max="100" aria-label="识别资源准备进度"></progress><div id="ocr-progress-detail" class="subtle" aria-live="polite"></div></div><p id="ocr-resource-note" class="subtle">首次需下载约 73 MB 模型和 28 MB 运行库；下载后在本机识别，不上传聊天画面。</p><div class="meta-line"><span id="ocr-status">可提前准备，开始录制后也会自动加载</span><button id="retry-ocr" hidden>重试识别</button></div></section>
<section class="card"><div class="section-title"><h2>聊天消息</h2><button id="export">导出文字</button></div><p class="subtle">从多次识别中整理出的本地消息，可能仍有错字。每分钟自动保存文字和结构化结果到录像目录，停止时再保存一次。</p><div class="meta-line"><span id="message-save-status">开始录制后自动保存文字</span><button id="save-messages" disabled>立即保存文字</button></div><div class="meta-line"><span id="message-count">0 条消息</span><label class="toggle"><input id="autoscroll" type="checkbox" checked>跟随新消息</label></div><div id="messages" class="messages"><div class="empty">开始录制并开启识别后<br>消息会出现在这里</div></div></section>
<section class="card full"><div class="section-title"><h2>最近的视频</h2><button id="refresh">刷新列表</button></div><p class="subtle">显示最近 10 段，以及更早的全部未保存片段。只有视频和时间文件都写入目录后，才会显示“已保存”。恢复前请停止所有页面的录制。</p><div id="segments"><div class="empty">还没有录制记录</div></div></section>
<div class="footer"><strong>录制时请保持本页开启，并避免电脑休眠。</strong> 后台运行可能被浏览器暂停；关页或崩溃会中断录制，最后未写入缓存的部分可能丢失。<details><summary>保存与恢复说明</summary><p>视频先临时写入浏览器本机缓存，再每分钟保存到你选的目录。请勿在恢复前清理浏览器站点数据。未保存片段的“恢复到目录”需要你重新授权目录。截图、视频和聊天结果不会上传服务器。</p></details></div></main>`;
}
export function element<T extends HTMLElement = HTMLElement>(id: string) {
  return document.getElementById(id) as T;
}
export function setText(id: string, text: string) {
  element(id).textContent = text;
}
export function notify(message: string, error = false) {
  setText("alert", message);
  element("alert").className = error ? "error" : "info";
}
