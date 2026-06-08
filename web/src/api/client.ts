/**
 * Minimal fetch wrapper that:
 *   - auto-attaches Authorization from localStorage
 *   - throws typed ApiError on non-2xx
 *   - returns parsed JSON (or null for 204)
 *
 * Pages that want to handle 401 specially (redirect to /login) should catch
 * ApiError and check .status === 401.
 */

const STORAGE_KEY = "auth2api.adminKey";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function authHeader(): Record<string, string> {
  const k = localStorage.getItem(STORAGE_KEY);
  return k ? { Authorization: `Bearer ${k}` } : {};
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...authHeader(),
    ...(options.headers as Record<string, string> | undefined),
  };

  const resp = await fetch(path, { ...options, headers });

  if (resp.status === 204) return null as T;

  let body: unknown = null;
  const text = await resp.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!resp.ok) {
    const msg =
      (body && typeof body === "object" && "error" in body
        ? ((body as any).error?.message ?? JSON.stringify(body))
        : null) ?? `HTTP ${resp.status}`;
    throw new ApiError(resp.status, msg, body);
  }

  return body as T;
}

export const get = <T = unknown>(path: string) => api<T>(path);
export const post = <T = unknown>(path: string, json?: unknown) =>
  api<T>(path, { method: "POST", body: json ? JSON.stringify(json) : undefined });
export const patch = <T = unknown>(path: string, json: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(json) });
export const del = <T = unknown>(path: string) =>
  api<T>(path, { method: "DELETE" });
