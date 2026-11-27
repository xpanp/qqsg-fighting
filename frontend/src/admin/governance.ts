import { request, type Account, type Session } from "../auth/client";

export function mountGovernance(target: HTMLElement, session: Session, logout: () => void) {
  target.innerHTML = `<header><div><h1>用户管理</h1><p>账号权限和游客访问</p></div><button id="logout">退出登录</button></header>
    <main class="admin-layout governance-layout"><section class="card">
      <div class="controls"><label><input type="checkbox" id="guest-reports">允许游客查看战报</label><button id="reload-users">刷新用户</button></div>
      <p id="system-status" role="status"></p><div class="table-wrap" id="users"></div>
    </section></main>`;
  target.querySelector<HTMLButtonElement>("#logout")!.onclick = logout;
  const status = target.querySelector<HTMLElement>("#system-status")!;
  const list = target.querySelector<HTMLElement>("#users")!;
  const guest = target.querySelector<HTMLInputElement>("#guest-reports")!;
  let busy = false;
  const lifecycle = new AbortController();
  let secretTimer: ReturnType<typeof setTimeout> | undefined;
  const clearSecrets = () => {
    clearTimeout(secretTimer);
    for (const secret of list.querySelectorAll<HTMLElement>("[data-secret]")) {
      secret.textContent = "";
    }
  };
  document.addEventListener("visibilitychange", clearSecrets, { signal: lifecycle.signal });
  window.addEventListener("pagehide", clearSecrets, { signal: lifecycle.signal });
  const button = (label: string, onclick: () => void) => {
    const elem = document.createElement("button");
    elem.textContent = label;
    elem.onclick = onclick;
    return elem;
  };
  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    try { await action(); }
    catch (e) { status.textContent = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
  async function load() {
    clearSecrets();
    const response = await request<{ users: Account[]; guestReports: boolean }>("system/users");
    guest.checked = response.guestReports;
    const table = document.createElement("table");
    const header = table.createTHead().insertRow();
    for (const label of ["用户名", "区服", "角色", "注册时间", "操作"]) {
      const th = document.createElement("th"); th.textContent = label; header.append(th);
    }
    const body = table.createTBody();
    for (const account of response.users) {
      const row = body.insertRow();
      const label = { admin: "Admin", ordinary: "普通用户", super: "超管", guest: "游客" }[account.role];
      for (const value of [account.username, account.region || "—", label, account.registeredAtMs ? new Date(account.registeredAtMs).toLocaleString() : "—"]) row.insertCell().textContent = value;
      const actions = row.insertCell();
      if (account.role !== "ordinary" && account.role !== "super") continue;
      const path = "system/users/" + encodeURIComponent(account.id);
      const secret = document.createElement("span");
      secret.dataset.secret = "";
      const roleButton = button(account.role === "super" ? "撤销超管" : "设为超管", () => void run(async () => {
        await request(path, "PATCH", { role: account.role === "super" ? "ordinary" : "super" }, session.csrf);
        await load();
      }));
      const remove = button("删除", () => {
        if (!confirm(`删除账号 ${account.username}？`)) return;
        void run(async () => { await request(path, "DELETE", undefined, session.csrf); await load(); });
      });
      const reveal = button("查看密码", () => {
        if (secret.textContent) { secret.textContent = ""; return; }
        void run(async () => {
          clearSecrets();
          const result = await request<{ password: string }>(path + "/password", "POST", {}, session.csrf);
          if (secret.isConnected && !document.hidden) {
            secret.textContent = result.password;
            secretTimer = setTimeout(clearSecrets, 20000);
          }
        });
      });
      actions.append(roleButton, remove, reveal, secret);
    }
    list.replaceChildren(table);
    status.textContent = `共 ${response.users.length} 个账号`;
  }
  guest.onchange = () => {
    if (busy) { guest.checked = !guest.checked; return; }
    const checked = guest.checked;
    guest.disabled = true;
    void run(async () => {
      try { await request("system/settings", "PATCH", { guestReports: checked }, session.csrf); }
      finally { await load(); }
    }).finally(() => { guest.disabled = false; });
  };
  target.querySelector<HTMLButtonElement>("#reload-users")!.onclick = () => void run(load);
  void run(load);
  return () => { lifecycle.abort(); clearSecrets(); };
}
