import { get } from "./client";

/* ── /admin/stats ───────────────────────────────────────────────────── */

interface BaseBucket {
  requests: number;
  successes: number;
  failures: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  totalReasoningOutputTokens: number;
  totalCostUsd: number;
  totalLatencyMs: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ClientBucket extends BaseBucket {
  apiKeyShort: string;
  lastIp: string;
  lastUa: string;
}

export interface AccountBucket extends BaseBucket {
  provider: string;
  email: string;
}

export interface ApiBucket extends BaseBucket {
  endpoint: string;
  model: string;
  provider: string | null;
}

export interface ClientModelBucket extends BaseBucket {
  apiKeyShort: string;
  model: string;
  provider: string | null;
}

export interface ClientMcpBucket extends BaseBucket {
  apiKeyShort: string;
  server: string;
  /** Per-tool call/failure counts on this (client, server). */
  byTool: Record<string, { calls: number; failures: number }>;
}

export type StatsWindow = "today" | "month" | "all";

export interface StatsSnapshot {
  byClient: Record<string, ClientBucket>;
  byAccount: Record<string, AccountBucket>;
  byApi: Record<string, ApiBucket>;
  byClientModel: Record<string, ClientModelBucket>;
  byClientMcp: Record<string, ClientMcpBucket>;
  totals: BaseBucket;
  window: StatsWindow;
  generated_at: string;
}

/** Either a preset window or an explicit UTC date range. */
export type StatsRange = { window: StatsWindow } | { from: string; to: string };

function rangeQuery(r: StatsRange): string {
  return "from" in r
    ? `from=${r.from}&to=${r.to}`
    : `window=${r.window}`;
}

export const fetchStats = (range: StatsRange = { window: "month" }) =>
  get<StatsSnapshot>(`/admin/stats?${rangeQuery(range)}`);

/* ── /admin/stats/timeseries ────────────────────────────────────────── */

export interface DailyBucket {
  date: string;             // "YYYY-MM-DD" UTC
  requests: number;
  totalTokens: number;
  totalCostUsd: number;
  byProvider: Record<
    string,
    { requests: number; totalTokens: number; totalCostUsd: number }
  >;
  /** MCP tool-call counts per upstream server for this day. */
  mcpByServer?: Record<string, number>;
}

export interface TimeseriesResp {
  days: DailyBucket[];
  window: { days: number } | { from: string; to: string };
  generated_at: string;
}

/** Fetch the daily time-series either by trailing N days or an explicit range. */
export const fetchTimeseries = (
  opts: { days: number } | { from: string; to: string } = { days: 30 },
) =>
  get<TimeseriesResp>(
    "days" in opts
      ? `/admin/stats/timeseries?days=${opts.days}`
      : `/admin/stats/timeseries?from=${opts.from}&to=${opts.to}`,
  );
