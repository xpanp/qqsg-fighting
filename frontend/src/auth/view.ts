import { realm, request, type Session } from "./client";

export function mountLogin(target: HTMLElement, onSession: (session: Session) => void, guestAllowed = true) {
  target.innerHTML = `<h2>登录战报账号</h2>
    <form class="account-form">
      <label>用户名 <input name="username" autocomplete="username" required></label>
      <label>密码 <input name="password" type="password" autocomplete="current-password" required></label>
      <label data-region hidden>区服 <select name="region"><option>${realm}</option></select></label>
      <button class="primary" type="submit">登录</button>
    </form>
    <div class="controls"><button type="button" data-switch>注册账号</button><button type="button" data-guest>游客查看战报</button></div>
    <p class="subtle">请为战报设置独立的账号和密码，避免使用游戏账号密码。</p>
    <p role="status"></p>`;
  const form = target.querySelector("form")!;
  const region = target.querySelector<HTMLElement>("[data-region]")!;
  const swap = target.querySelector<HTMLButtonElement>("[data-switch]")!;
  const guest = target.querySelector<HTMLButtonElement>("[data-guest]")!;
  guest.hidden = !guestAllowed;
  const submit = form.querySelector("button")!;
  const status = target.querySelector<HTMLElement>("[role=status]")!;
  const user = form.elements.namedItem("username") as HTMLInputElement;
  const password = form.elements.namedItem("password") as HTMLInputElement;
  let registering = false;
  let busy = false;
  swap.onclick = () => {
    registering = !registering; region.hidden = !registering;
    submit.textContent = registering ? "注册并登录" : "登录";
    swap.textContent = registering ? "返回登录" : "注册账号";
    password.value = "";
    password.autocomplete = registering ? "new-password" : "current-password";
    status.textContent = registering ? "用户名 4–16 位，密码 8–18 位，可用英文、数字和符号。" : "";
  };
  async function run(action: string, body: unknown) {
    if (busy) return;
    busy = true;
    for (const button of [swap, guest, submit]) button.disabled = true;
    status.textContent = "正在连接…";
    try {
      const next = await request<Session>("auth/" + action, "POST", body);
      if (!next.user) throw Error("登录未生效，请检查浏览器的站点 Cookie 设置。");
      password.value = "";
      onSession(next);
    } catch (e) { status.textContent = e instanceof Error ? e.message : String(e); }
    finally { busy = false; for (const button of [swap, guest, submit]) button.disabled = false; }
  }
  form.onsubmit = event => {
    event.preventDefault();
    if (registering && (!/^[!-~]{4,16}$/.test(user.value) || !/^[!-~]{8,18}$/.test(password.value))) {
      status.textContent = "请输入 4–16 位用户名、8–18 位密码，使用英文、数字或符号且不含空格。";
      return;
    }
    void run(registering ? "register" : "login", { username: user.value, password: password.value, ...(registering ? { region: realm } : {}) });
  };
  guest.onclick = () => void run("guest", {});
}
