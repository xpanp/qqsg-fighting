export type Role = "admin" | "super" | "ordinary" | "guest";
export interface Account { id: string; username: string; region: string; role: Role; registeredAtMs?: number }
export interface Session { user: Account | null; csrf: string; guestReports: boolean }
export const apiPrefix = "/fighting/api/v1/";
export const realm = "得陇望蜀";

export class RequestError extends Error {
  constructor(readonly status: number, readonly retryAfter: string | null, message: string) { super(message); }
}

export async function request<T>(path: string, method = "GET", body?: unknown, csrf = "", keepalive = false): Promise<T> {
  const response = await fetch(apiPrefix + path, {
    method, keepalive, credentials: "same-origin", cache: "no-store",
    signal: AbortSignal.timeout(10000),
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    const detail = data?.error?.message ?? data?.error ?? data?.message;
    throw new RequestError(response.status, response.headers.get("Retry-After"), typeof detail === "string" ? detail : `请求失败（${response.status}）`);
  }
  if (response.status !== 204) return await response.json() as T;
  return undefined as T;
}
