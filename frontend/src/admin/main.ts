import "../app/style.css";
import "./style.css";
import { AdminApi } from "./client";
import { request, RequestError, type Session } from "../auth/client";
import { mountLogin } from "../auth/view";
import { mountGovernance } from "./governance";
const api = new AdminApi();
const app = document.querySelector<HTMLDivElement>("#app")!;
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let session: Session;
let viewerGranted = false;
let viewerPending: Promise<void> | undefined;
let viewerRenewAt = 0;
let viewerRetryAt = 0;
let viewerActive = false;
let disposeGovernance: (() => void) | undefined;
let viewerTabRelease: (() => void) | undefined;
let clockTimer: ReturnType<typeof setInterval> | undefined;
let currentPage = "events";
let projectionVersion: number | string | undefined;
let requestGeneration = 0;
let offset = 0;
let editing = false;
let filterDirty = false;
let appliedRange: { start:number; end:number } | undefined;
function text(id: string, value: string) { el(id).textContent = value; }
function showError(error: unknown) { if (Number((error as { status?: number })?.status) === 401) { login(); return; } text("admin-status", error instanceof Error ? error.message : String(error)); }
function table(target: HTMLElement, columns: { key: string; label: string }[], rows: Record<string, unknown>[]) {
  const t = document.createElement("table"), head = document.createElement("thead"), tr = document.createElement("tr");
  for (const c of columns) { const th = document.createElement("th"); th.textContent = c.label; tr.append(th); } head.append(tr); t.append(head);
  const body = document.createElement("tbody");
  for (const row of rows) { const line = document.createElement("tr"); for (const c of columns) { const td = document.createElement("td"); const value = row[c.key]; td.textContent = value === undefined || value === null ? "—" : Array.isArray(value) && value.every(v => v && typeof v === "object" && "name" in v && "count" in v) ? value.map(v => `${v.name} × ${v.count}`).join("、") : typeof value === "object" ? JSON.stringify(value) : String(value); line.append(td); } body.append(line); }
  if (!rows.length) { const line = document.createElement("tr"), cell = document.createElement("td"); cell.colSpan = columns.length; cell.textContent = "所选时间暂无记录"; line.append(cell); body.append(line); }
  t.append(body); target.replaceChildren(t);
}
function localInput(ms: number) { const d = new Date(ms); return new Date(ms - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19); }
function interval() {
  const start = Date.parse(el<HTMLInputElement>("start").value), end = Date.parse(el<HTMLInputElement>("end").value);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw Error("请选择有效的开始与结束时间");
  return { start, end };
}
function query(extra: Record<string, string> = {}) { const range = interval(); return new URLSearchParams({ start: String(range.start), end: String(range.end), ...extra }).toString(); }
function login() {
  disposeGovernance?.();
  disposeGovernance = undefined;
  viewerActive = false;
  void releaseViewer();
  clearInterval(clockTimer);
  requestGeneration++;
  app.innerHTML = '<main id="report-login" class="admin-login card"></main>';
  mountLogin(el("report-login"), activate, session?.guestReports ?? true);
}

function activate(next: Session) {
  session = next;
  api.csrf = next.csrf;
  if (next.user?.role === "admin") disposeGovernance = mountGovernance(app, session, () => void logout());
  else if (next.user) shell();
  else login();
}

async function logout() {
  try {
    viewerActive = false;
    await releaseViewer();
    await request("auth/logout", "POST", {}, session.csrf);
    login();
  } catch (e) {
    viewerActive = true;
    const status = document.querySelector<HTMLElement>("#admin-status, #system-status");
    if (status) status.textContent = e instanceof Error ? e.message : String(e);
  }
}

async function ensureViewer() {
  if (session.user?.role === "super") return;
  if (!viewerActive || document.hidden) throw Error("返回战报页面后继续更新");
  if (Date.now() < viewerRetryAt) throw Error("战报访问人数已满，稍后将自动重试");
  if (viewerGranted && Date.now() < viewerRenewAt) return;
  const csrf = session.csrf;
  if (viewerPending) return await viewerPending;
  viewerPending = (async () => {
    if (!viewerTabRelease && navigator.locks) {
      await new Promise<void>(resolve => {
        void navigator.locks.request("qqsg-report-" + csrf, { mode: "shared" }, () =>
          new Promise<void>(release => { viewerTabRelease = release; resolve(); }),
        ).catch(() => resolve());
      });
    }
    if (!viewerActive || document.hidden) {
      viewerTabRelease?.();
      viewerTabRelease = undefined;
      throw Error("返回战报页面后继续更新");
    }
    await request("reports/lease", "POST", { action: viewerGranted ? "renew" : "acquire" }, csrf)
      .then(() => { viewerGranted = true; viewerRenewAt = Date.now() + 30000; })
      .catch(e => {
        viewerGranted = false;
        if (e instanceof RequestError && e.status === 429) {
          const wait = Number(e.retryAfter || 30);
          viewerRetryAt = Date.now() + 1000 * (Number.isFinite(wait) ? Math.max(1, wait) : 30);
          throw Error("战报访问人数已满，稍后将自动重试");
        }
        throw e;
      });
  })().finally(() => { viewerPending = undefined; });
  await viewerPending;
}

async function releaseViewer() {
  await viewerPending?.catch(() => {});
  const release = viewerTabRelease;
  viewerTabRelease = undefined;
  release?.();
  if (!viewerGranted || !session?.csrf) return;
  viewerGranted = false;
  const csrf = session.csrf;
  if (!navigator.locks || !release) return;
  await navigator.locks.request("qqsg-report-" + csrf, { ifAvailable: true }, async lock => {
    if (lock) await request("reports/lease", "POST", { action: "release" }, csrf, true).catch(() => {});
  });
}
function shell() {
  currentPage = "events";
  offset = 0;
  editing = false;
  filterDirty = false;
  appliedRange = undefined;
  viewerActive = true;
  viewerRetryAt = 0;
  const superUser = session.user?.role === "super";
  app.innerHTML = `<header><div><h1>QQ三国战报管理 · by ppp</h1><p>服务端汇集结果</p></div><div class="controls">${session.user?.role !== "guest" ? '<a href="/fighting/" target="_blank" rel="noopener">打开录制</a>' : ""}<button id="logout">退出登录</button></div></header><main class="admin-layout"><nav class="card"><button data-page="events">击杀战报</button><button data-page="stats">战报统计</button><button data-page="config">名单版本</button></nav><section class="card"><div class="controls" id="filters"><label>开始时间<input id="start" type="datetime-local" step="1"></label><label>结束时间<input id="end" type="datetime-local" step="1"></label><label class="toggle"><input id="live" type="checkbox" checked>最近三小时实时跟随</label><button id="apply">刷新</button><button id="excel">导出 Excel</button></div><p class="subtle">时间按本机时区显示，统计区间含开始、不含结束。仅 A/B 对抗计入双方概览；其他阵营与黑名单按规则排除。</p><p id="admin-status" role="status" aria-live="polite"></p><div id="content"></div></section></main>`;
  el<HTMLInputElement>("start").value = localInput(Date.now() - 3 * 3600000); el<HTMLInputElement>("end").value = localInput(Date.now());
  el("logout").onclick = () => void logout();
  el("excel").hidden = !superUser;
  document.querySelector<HTMLElement>('[data-page="config"]')!.hidden = !superUser;
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-page]")) b.onclick = () => { editing = false; offset = 0; currentPage = b.dataset.page!; void load().catch(showError); };
  el("apply").onclick = () => { editing = false; offset = 0; void load().catch(showError); };
  el("content").addEventListener("input", () => { editing = true; });
  el("content").addEventListener("change", () => { editing = true; });
  for (const id of ["start", "end"]) el(id).onchange = () => { requestGeneration++; el<HTMLInputElement>("live").checked = false; filterDirty = true; el<HTMLButtonElement>("excel").disabled=true; text("admin-status","筛选时间已修改，请点击刷新应用；当前表格仍为上次结果"); };
  el("live").onchange=()=>{filterDirty=false;editing=false;offset=0;void load().catch(showError);};
  el("excel").onclick = async () => {
    const button=el<HTMLButtonElement>("excel"); if(filterDirty||!appliedRange)return;
    button.disabled=true;button.textContent="正在生成 Excel…";
    try { const blob = await api.download("exports", { ...appliedRange, projectionVersion }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `battle-${new Date().toISOString().slice(0, 10)}.xlsx`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); } catch (e) { showError(e); }
    finally{button.textContent="导出 Excel";button.disabled=filterDirty||!appliedRange;}
  };
  clearInterval(clockTimer);
  clockTimer = setInterval(() => {
    if (document.hidden) return;
    if (currentPage === "config") {
      void api.request("jobs").then(r => { const jobs = r.jobs ?? []; text("admin-status", `处理任务：排队 ${jobs.filter((j: any) => j.status === "queued").length} · 处理中 ${jobs.filter((j: any) => j.status === "running").length} · 失败 ${jobs.filter((j: any) => j.status === "failed").length}。重算失败时保留上次发布的统计。`); }).catch(showError);
    } else if (!editing && !filterDirty && el<HTMLInputElement>("live").checked) void load().catch(showError);
    else void ensureViewer().catch(showError);
  }, 15000);
  void load().catch(showError);
}
async function load() {
  const generation = ++requestGeneration;
  el<HTMLButtonElement>("excel").disabled=true;
  try {
    if (el<HTMLInputElement>("live").checked) { el<HTMLInputElement>("end").value = localInput(Date.now()); el<HTMLInputElement>("start").value = localInput(Date.now() - 3 * 3600000); }
    el("filters").hidden = currentPage === "config";
    text("admin-status", "正在读取服务端结果…");
    if (currentPage === "config") { await configPage(generation); return; }
    const requestedRange=interval();
    await ensureViewer();
    if (generation !== requestGeneration) return;
    const response = await request<any>("reports/" + (currentPage === "events" ? "events?" : "stats?") + query(currentPage === "events" ? { offset: String(offset), limit: "200" } : {})); if (generation !== requestGeneration) return;
    projectionVersion = response.projectionVersion;
    appliedRange=requestedRange;filterDirty=false;el<HTMLButtonElement>("excel").disabled=false;
    const target = el("content"); target.replaceChildren();
    if (currentPage === "events") {
      const rows = response.events ?? response.items ?? [];
      table(target, [{ key: "eventTime", label: "时间" }, { key: "timeQuality", label: "时间依据" }, { key: "killer", label: "击杀者" }, { key: "killerFaction", label: "阵营" }, { key: "victim", label: "死亡者" }, { key: "victimFaction", label: "阵营" }, { key: "status", label: "状态" }, { key: "reason", label: "原因" }, { key: "sourceCount", label: "来源数" }, { key: "text", label: "播报原文" }], rows.map((r: Record<string, any>) => ({ ...r, status: ({ counted: "计入统计", excluded: "已排除", pending: "待确认", duplicate: "重复已排除" } as Record<string, string>)[r.status] ?? r.status, timeQuality: r.timeQuality === "game_inferred" ? "游戏时间（日期推断）" : "采集时间（非精确发生时间）", eventTime: new Date(r.occurredAtMs ?? r.eventAtMs ?? r.eventTimeMs ?? 0).toLocaleString("zh-CN", { hour12: false }) })));
      if (session.user?.role === "super") {
      const details = document.createElement("div"); details.className = "controls"; const id = document.createElement("input"); id.placeholder = "事件 ID（从下方列表选择）"; const reason = document.createElement("input"); reason.placeholder = "更正原因";
      const select = document.createElement("select"); for (const row of rows) { const option = document.createElement("option"); option.value = row.id; option.textContent = `${new Date(row.occurredAtMs).toLocaleString("zh-CN",{hour12:false})} · ${row.killer} → ${row.victim} · 来源 ${row.sourceCount} (${row.id})`; select.append(option); }
      const killer = document.createElement("input"); killer.placeholder = "更正击杀者（可留空）"; const victim = document.createElement("input"); victim.placeholder = "更正死亡者（可留空）";
      const submit = (excluded: boolean) => { if (!reason.value.trim()) { text("admin-status", "请填写更正原因"); return; } void api.request("event-overrides", "POST", { eventId: select.value, excluded, reason: reason.value, requestId: crypto.randomUUID(), ...(killer.value.trim() ? { killer: killer.value.trim() } : {}), ...(victim.value.trim() ? { victim: victim.value.trim() } : {}) }).then(() => { editing = false; return load(); }).catch(showError); };
      const exclude = document.createElement("button"); exclude.textContent = "排除所选事件"; exclude.onclick = () => submit(true);
      const correct = document.createElement("button"); correct.textContent = "保存更正并计入"; correct.onclick = () => submit(false);
      const sources = document.createElement("button"); sources.textContent = "查看原始来源"; const sourceDetails = document.createElement("pre"); sources.onclick = () => { if (!select.value) return; void api.request("messages/" + encodeURIComponent(select.value)).then(result => { sourceDetails.textContent = JSON.stringify(result, null, 2); }).catch(showError); };
      details.append(select, reason, killer, victim, exclude, correct, sources); target.append(details, sourceDetails);
      const reset = document.createElement("button"); reset.textContent = "撤销所选事件的全部人工调整";
      reset.onclick = () => { if (!select.value || !reason.value.trim()) { text("admin-status", "请选择事件并填写撤销原因");return; } void api.request("event-overrides", "POST", { eventId:select.value,requestId:crypto.randomUUID(),reason:reason.value,reset:true }).then(()=>{editing=false;return load();}).catch(showError); };details.append(reset);
      const mergeTarget = document.createElement("input"); mergeTarget.placeholder = "合并到事件 ID（可在原始来源中查看）";
      for (const [label, operation] of [["拆分所选事件的来源", "split"], ["关联为同一次击杀", "merge"]] as const) { const b = document.createElement("button"); b.textContent = label; b.onclick = () => { if (!reason.value.trim() || !select.value || (operation === "merge" && !mergeTarget.value.trim())) { text("admin-status", "请选择事件、填写原因及需要的目标 ID"); return; } void api.request("event-overrides", "POST", { eventId: select.value, reason: reason.value, requestId: crypto.randomUUID(), ...(operation === "split" ? { split: true } : { mergeInto: mergeTarget.value.trim() }) }).then(() => { editing = false; return load(); }).catch(showError); }; details.append(b); } details.append(mergeTarget);
      }
      const count = document.createElement("p"); count.className = "subtle"; count.textContent = `符合条件 ${response.total ?? rows.length} 条，当前显示 ${rows.length} 条。可缩小时间范围查询。`; target.append(count);
      const paging = document.createElement("div"); paging.className = "controls";
      for (const [label, next] of [["上一页", Math.max(0, offset - 200)], ["下一页", offset + 200]] as const) { const b = document.createElement("button"); b.textContent = label; b.disabled = next === offset || next >= response.total; b.onclick = () => { offset = next; el<HTMLInputElement>("live").checked = false; void load().catch(showError); }; paging.append(b); } target.append(paging);
    } else {
      const sections: [string, any[], { key: string; label: string }[]][] = [
        ["战斗概览", [{ ...response.overview, aShare: ((response.overview?.aShare ?? 0) * 100).toFixed(1) + "%", bShare: ((response.overview?.bShare ?? 0) * 100).toFixed(1) + "%" }], [{ key: "aKills", label: "A 击杀" }, { key: "bKills", label: "B 击杀" }, { key: "aShare", label: "A 人头占比" }, { key: "bShare", label: "B 人头占比" }, { key: "aPlayers", label: "A 参战人数" }, { key: "bPlayers", label: "B 参战人数" }]],
        ["击杀表", response.kills ?? [], [{ key: "name", label: "人名" }, { key: "faction", label: "阵营" }, { key: "count", label: "击杀次数" }, { key: "opponents", label: "击杀对象及次数" }]],
        ["死亡表", response.deaths ?? [], [{ key: "name", label: "人名" }, { key: "faction", label: "阵营" }, { key: "count", label: "死亡次数" }, { key: "opponents", label: "被谁击杀及次数" }]],
        ["K/D（无助攻数据）", (response.kda ?? []).map((r: any) => ({ ...r, ratio: r.deaths === 0 ? "无死亡" : r.ratio })), [{ key: "name", label: "人名" }, { key: "faction", label: "阵营" }, { key: "kills", label: "击杀" }, { key: "deaths", label: "死亡" }, { key: "ratio", label: "K/D" }]],
        ["优势最大的十分钟", Object.entries(response.advantages ?? {}).filter(([, value]) => value).map(([faction, r]: [string, any]) => ({ faction: faction.toUpperCase(), start: new Date(r.startMs).toLocaleString("zh-CN", { hour12: false }), end: new Date(r.endMs).toLocaleString("zh-CN", { hour12: false }), netKills: faction==='b'?-r.net:r.net, aKills: r.aKills, bKills: r.bKills })), [{ key: "faction", label: "阵营" }, { key: "start", label: "开始" }, { key: "end", label: "结束" }, { key: "aKills", label: "A 击杀" }, { key: "bKills", label: "B 击杀" }, { key: "netKills", label: "本方净优势" }]],
      ];
      for (const [title, rows, columns] of sections) { const h = document.createElement("h2"), wrap = document.createElement("div"); h.textContent = title; wrap.className = "table-wrap"; table(wrap, columns, rows); target.append(h, wrap); }
    }
    const stale = response.rosterStatus === "failed" ? " · 名单重算失败，显示上次发布结果" : response.rosterStatus === "pending" ? " · 名单正在重算，显示上次发布结果" : "";
    text("admin-status", `已更新 · 数据版本 ${projectionVersion ?? "—"} · ${new Date().toLocaleTimeString()}${stale}`);
  } finally { /* Requests are generation guarded; rapid navigation may supersede them. */ }
}
async function configPage(generation: number) {
  const response = await api.request("name-configs"); if (generation !== requestGeneration) return;
  const target = el("content"); target.innerHTML = `<h2>服务端名单</h2><p class="notice">一行一个标准名。别名每行“标准名 TAB 别名”，黑名单命中任一方就排除整条事件。保存会生成新配置版本并重算。</p><div id="name-fields"></div><div class="controls"><button id="save-config">校验并启用</button><button id="reprocess">重新处理全部文字</button></div><h2>名单版本</h2><div id="config-history"></div>`;
  const fields = [{ key: "nameA", label: "A 阵营" }, { key: "nameB", label: "B 阵营" }, { key: "nameOthers", label: "其他" }, { key: "aliases", label: "别名映射" }, { key: "blacklist", label: "黑名单" }];
  for (const f of fields) { const label = document.createElement("label"), area = document.createElement("textarea"); label.textContent = f.label; area.id = "config-" + f.key; const value = response.active?.[f.key] ?? response[f.key] ?? ""; area.value = f.key === "aliases" && Array.isArray(value) ? value.map((r: any) => `${r.canonical}\t${r.alias}`).join("\n") : Array.isArray(value) ? value.join("\n") : String(value); label.append(area); el("name-fields").append(label); }
  el("save-config").onclick = () => {
    try {
      const body: Record<string, unknown> = {};
      for (const f of fields) { const lines = el<HTMLTextAreaElement>("config-" + f.key).value.split(/\r?\n/).map(s => s.trim()).filter(Boolean); body[f.key] = f.key === "aliases" ? lines.map(line => { const parts = line.split("\t"); if (parts.length !== 2 || parts.some(s => !s.trim())) throw Error("别名每行需要标准名与别名两列，用 TAB 分隔"); return { canonical: parts[0].trim(), alias: parts[1].trim() }; }) : lines; }
      void api.request("name-configs", "POST", body).then(() => { editing = false; text("admin-status", "名单已保存，正在重算；可在统计页查看发布版本"); }).catch(showError);
    } catch (e) { showError(e); }
  };
  el("reprocess").onclick = () => void api.request("reprocess", "POST", {}).then(() => text("admin-status", "已提交重算任务")).catch(showError);
  const versions = response.versions ?? [];
  const active = versions.find((item: { id: string }) => item.id === response.active?.id);
  const history = el("config-history");
  const published = versions.find((item: { id: string }) => item.id === response.publishedConfigId);
  if (active?.id && response.publishedConfigId !== active.id) {
    const note = document.createElement("p");
    note.className = "notice";
    const publishedLabel = published ? `战报仍使用已发布版本 ${published.version}。` : "战报尚未发布名单结果。";
    note.textContent = publishedLabel + (response.rosterStatus === "failed" ? "当前名单重算失败，可重新处理。" : "当前名单将在重新统计成功后生效。");
    history.append(note);
  }
  for (const item of versions) {
    const row = document.createElement("p");
    const timestamp = new Date(item.createdAtMs).toLocaleString();
    row.textContent = `版本 ${item.version ?? item.id} · ${timestamp} · ${item.actor ?? "—"} · ${item.action === "restore" ? "恢复" : "保存"}${item.id === active?.id ? " · 当前" : ""} `;
    if (item.id !== active?.id) {
      const restore = document.createElement("button");
      restore.textContent = "恢复此版本";
      restore.onclick = async () => {
        if (!confirm(`将版本 ${item.version ?? item.id} 恢复为新版本并重新处理战报？`)) return;
        restore.disabled = true;
        try {
          await api.request("name-configs/" + encodeURIComponent(item.id) + "/restore", "POST", {});
          editing = false;
          await load();
          text("admin-status", "已创建恢复版本。重算成功后会发布新版统计。");
        } catch (e) { showError(e); }
        finally { restore.disabled = false; }
      };
      row.append(restore);
    }
    history.append(row);
  }
  text("admin-status", "当前名单版本 " + (active?.version ?? response.active?.id ?? "—"));
}
void request<Session>("auth/session").then(activate).catch(login);
window.addEventListener("pagehide", () => {
  viewerActive = false;

  clearInterval(clockTimer);
  void releaseViewer();
});
window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
document.addEventListener("visibilitychange", () => {
  if (!viewerActive) return;
  if (document.hidden) void releaseViewer();
  else if (!editing && !filterDirty && currentPage !== "config") void load().catch(showError);
});