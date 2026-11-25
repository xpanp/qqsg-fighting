const prefix = "/fighting/api/v1/admin/";
export class AdminApi {
  csrf = "";
  async request(path: string, method = "GET", body?: unknown): Promise<any> {
    const response = await fetch(prefix + path, {
      method, credentials: "same-origin", signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json", ...(this.csrf ? { "X-CSRF-Token": this.csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) { let message = `请求失败（${response.status}）`; try { const error = await response.json(); message = error.error?.message ?? error.error ?? message; } catch {} throw Object.assign(Error(String(message)), { status: response.status }); }
    if (response.status === 204) return;
    return response.json();
  }
  async download(path: string, body: unknown) {
    const response = await fetch(prefix + path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": this.csrf }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw Error(response.status === 409 ? "统计版本刚刚更新，请刷新后再导出" : `导出失败（${response.status}）`);
    return response.blob();
  }
}
