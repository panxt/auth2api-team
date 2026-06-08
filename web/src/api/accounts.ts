import { get, post } from "./client";

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
}

export interface AccountsResp {
  providers: Record<
    string,
    {
      accounts: AccountSnapshot[];
      account_count: number;
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
