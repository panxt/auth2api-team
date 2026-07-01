import { get, put } from "./client";

export type LogCategory = "upstream" | "service" | "policy" | "client" | "ok";

export interface LogRow {
  id: number;
  ts: string;
  apiKeyShort: string;
  keyName: string | null;
  ip: string;
  endpoint: string;
  model: string | null;
  provider: string | null;
  accountEmail: string | null;
  status: "success" | "failure";
  statusCode: number;
  failureKind: string | null;
  category: LogCategory;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  errorDetail: string | null;
  requestId: string | null;
}

export interface LogsResp {
  logs: LogRow[];
  nextCursor: number | null;
  generated_at: string;
}

export interface LogFilter {
  limit?: number;
  cursor?: number | null;
  status?: "success" | "failure" | "";
  category?: LogCategory | "";
  apiKey?: string;
  keyName?: string;
  email?: string;
  model?: string;
  endpoint?: string;
  provider?: string;
  since?: string;
  until?: string;
  q?: string;
}

export function fetchLogs(f: LogFilter): Promise<LogsResp> {
  const p = new URLSearchParams();
  if (f.limit) p.set("limit", String(f.limit));
  if (f.cursor != null) p.set("cursor", String(f.cursor));
  if (f.status) p.set("status", f.status);
  if (f.category) p.set("category", f.category);
  if (f.apiKey) p.set("apiKey", f.apiKey);
  if (f.keyName) p.set("keyName", f.keyName);
  if (f.email) p.set("email", f.email);
  if (f.model) p.set("model", f.model);
  if (f.endpoint) p.set("endpoint", f.endpoint);
  if (f.provider) p.set("provider", f.provider);
  if (f.since) p.set("since", f.since);
  if (f.until) p.set("until", f.until);
  if (f.q) p.set("q", f.q);
  return get<LogsResp>(`/admin/logs?${p.toString()}`);
}

/* ── logging config ── */

export interface LoggingConfig {
  enabled: boolean;
  capture: "all" | "failures";
  "error-detail": "full" | "snippet" | "off";
  "snippet-length": number;
  redact: boolean;
  "store-request-id": boolean;
  categories: {
    upstream: boolean;
    service: boolean;
    policy: boolean;
    client: boolean;
  };
  retention: {
    "max-age-days": number;
    "max-rows": number;
    "cleanup-interval-minutes": number;
  };
}

export const fetchLoggingConfig = () =>
  get<LoggingConfig>("/admin/logging/config");

export const updateLoggingConfig = (patch: Partial<LoggingConfig>) =>
  put<LoggingConfig>("/admin/logging/config", patch);
