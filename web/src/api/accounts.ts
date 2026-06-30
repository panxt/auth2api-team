import { get, post, patch, del } from "./client";

export interface RateLimitSnapshot {
  observedAt: string;
  retryAfterSec?: number;
  /** Subset of fields actually returned by upstream. For Anthropic OAuth
   *  these are the `unified-*` family — e.g. `unified-5h-reset`,
   *  `unified-5h-utilization`, `unified-7d-utilization`, etc. */
  fields: Record<string, string>;
}

export interface AccountSnapshot {
  email: string;
  available: boolean;
  cooldownUntil: number;
  failureCount: number;
  lastError: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastRefreshAt: string | null;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  totalReasoningOutputTokens: number;
  expiresAt: string;
  refreshing: boolean;
  planType?: string;
  windowStartedAt: string | null;
  windowResetAt: string | null;
  windowExpired: boolean;
  rateLimit: RateLimitSnapshot | null;
  disabled: boolean;
  monthlyBudgetUsd: number | null;
  tierLabel: string | null;
  concurrencyWeight: number;
  inFlight: number;
  peakInFlight: number;
}

export interface CapacitySummary {
  total: number;
  usable: number;
  soonestResetAt: string | null;
  maxUtil5h: number | null;
  inFlight: number;
  saturationRejects: number;
  level: "ok" | "info" | "warn" | "critical";
}

/** Aggregated quota for one rolling window across the pool (weighted
 *  equivalent windows — see backend QuotaWindowPool). */
export interface QuotaWindowPool {
  accounts: number;
  capacity: number;
  used: number;
  remainingUnits: number;
  remainingPct: number | null;
  maxUtil: number | null;
  soonestReset: string | null;
  level: "ok" | "info" | "warn" | "critical";
}

export interface QuotaPool {
  "5h": QuotaWindowPool | null;
  "7d": QuotaWindowPool | null;
}

export interface AccountsResp {
  providers: Record<
    string,
    {
      accounts: AccountSnapshot[];
      account_count: number;
      capacity: CapacitySummary;
      quota_pool?: QuotaPool;
    }
  >;
  generated_at: string;
}

export interface PrewarmRecord {
  email: string;
  ok: boolean;
  error?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface PrewarmResp {
  providers: Array<{
    provider: string;
    results: PrewarmRecord[];
    generated_at?: string;
    error?: string;
  }>;
  generated_at: string;
}

export const listAccounts = () => get<AccountsResp>("/admin/accounts");

export const prewarm = () => post<PrewarmResp>("/admin/prewarm");

export const reload = () =>
  post<{ reloaded: Record<string, unknown>; generated_at: string }>(
    "/admin/reload",
  );

export const deleteAccount = (provider: string, email: string) =>
  del<{ ok: true; provider: string; email: string }>(
    `/admin/accounts/${provider}/${encodeURIComponent(email)}`,
  );

export const setAccountDisabled = (
  provider: string,
  email: string,
  disabled: boolean,
) =>
  patch<{ ok: true; provider: string; email: string; disabled: boolean }>(
    `/admin/accounts/${provider}/${encodeURIComponent(email)}`,
    { disabled },
  );

export const setAccountBudget = (
  provider: string,
  email: string,
  body: {
    monthlyBudgetUsd?: number | null;
    tierLabel?: string | null;
    concurrencyWeight?: number | null;
  },
) =>
  patch<{ ok: true; provider: string; email: string }>(
    `/admin/accounts/${provider}/${encodeURIComponent(email)}`,
    body,
  );
