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

export interface StatsSnapshot {
  byClient: Record<string, ClientBucket>;
  byAccount: Record<string, AccountBucket>;
  byApi: Record<string, ApiBucket>;
  totals: BaseBucket;
  generated_at: string;
}

export const fetchStats = () => get<StatsSnapshot>("/admin/stats");

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
}

export interface TimeseriesResp {
  days: DailyBucket[];
  window: { days: number };
  generated_at: string;
}

export const fetchTimeseries = (days = 30) =>
  get<TimeseriesResp>(`/admin/stats/timeseries?days=${days}`);
