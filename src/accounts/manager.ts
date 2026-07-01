import { ProviderId, TokenData } from "../auth/types";
import { saveToken, loadAllTokens, deleteToken } from "../auth/token-storage";
import { getDeviceId } from "../utils/common";
import { RefreshTokenExhaustedError } from "../auth/refresh-errors";
import { RoutingConfig, DEFAULT_ROUTING_CONFIG } from "../config";

// Reauth-required cooldown: long enough that the account doesn't keep
// hitting the upstream, but bounded so a re-login auto-recovers next sweep.
const REAUTH_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const DEFAULT_REFRESH_LEAD_MS = 4 * 60 * 60 * 1000; // anthropic default
const REFRESH_CHECK_INTERVAL_MS = 60 * 1000; // check every 60s

/**
 * Per-provider refresh trigger. Anthropic tokens have a known TTL so the
 * "expires-lead" policy works (refresh N ms before expiresAt). Codex tokens
 * have a short access-token TTL but a long refresh-token idle window, so
 * the official codex CLI refreshes once every 8 days regardless of TTL —
 * `since-last-refresh` mirrors that behaviour.
 */
export type RefreshPolicy =
  | { kind: "expires-lead"; leadMs: number }
  | { kind: "since-last-refresh"; maxAgeMs: number };

const DEFAULT_REFRESH_POLICY: RefreshPolicy = {
  kind: "expires-lead",
  leadMs: DEFAULT_REFRESH_LEAD_MS,
};

export type AccountFailureKind =
  | "rate_limit"
  | "auth"
  | "forbidden"
  | "server"
  | "network";

const FAILURE_BACKOFF: Record<
  AccountFailureKind,
  { baseMs: number; maxMs: number }
> = {
  rate_limit: { baseMs: 60 * 1000, maxMs: 15 * 60 * 1000 },
  auth: { baseMs: 10 * 60 * 1000, maxMs: 60 * 60 * 1000 },
  forbidden: { baseMs: 10 * 60 * 1000, maxMs: 60 * 60 * 1000 },
  server: { baseMs: 5 * 1000, maxMs: 5 * 60 * 1000 },
  network: { baseMs: 5 * 1000, maxMs: 5 * 60 * 1000 },
};

export interface UsageData {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** Reasoning-model output tokens (codex Responses output_tokens_details.reasoning_tokens). */
  reasoningOutputTokens: number;
}

/**
 * Extract usage from a non-streamed JSON response. Handles both Anthropic
 * Messages shape (input_tokens / cache_creation_input_tokens / …) and OpenAI
 * Responses shape (input_tokens_details.cached_tokens / …).
 */
export function extractUsage(resp: any): UsageData {
  const u = resp?.usage ?? resp?.response?.usage;
  if (!u) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningOutputTokens: 0,
    };
  }
  return {
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    // Anthropic-only field; OpenAI Responses has no equivalent.
    cacheCreationInputTokens: u.cache_creation_input_tokens || 0,
    // Anthropic: cache_read_input_tokens. OpenAI Responses: input_tokens_details.cached_tokens.
    cacheReadInputTokens:
      u.cache_read_input_tokens ?? u.input_tokens_details?.cached_tokens ?? 0,
    // OpenAI Responses only.
    reasoningOutputTokens: u.output_tokens_details?.reasoning_tokens || 0,
  };
}

/**
 * Snapshot of upstream rate-limit headers, normalized into a single object.
 * Anthropic returns `anthropic-ratelimit-{requests,tokens,input-tokens,
 * output-tokens}-{limit,remaining,reset}` plus `retry-after` on 429.
 * `null` means we haven't observed any rate-limit header from this account
 * yet (e.g., OAuth subscription channel didn't surface them).
 */
export interface RateLimitSnapshot {
  /** ISO when these values were observed (server-side). */
  observedAt: string;
  /** Raw retry-after seconds, if upstream sent it. */
  retryAfterSec?: number;
  /** Generic store of any `anthropic-ratelimit-*` header. Key without prefix. */
  fields: Record<string, string>;
}

/** Anthropic's per-account 5h rate-limit window is "first-message anchored"
 *  (see docs/ARCHITECTURE.md §5h window). 5 hours in ms. */
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 60 * 1000;

interface AccountState {
  token: TokenData;
  cooldownUntil: number;
  failureCount: number;
  lastFailureKind: AccountFailureKind | null;
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
  refreshPromise: Promise<boolean> | null;
  /** ISO timestamp of the first attempt in the current 5h rate-limit window.
   *  When `now - windowStartedAt > 5h`, the next attempt opens a new window. */
  windowStartedAt: string | null;
  /** Latest rate-limit header snapshot from upstream. */
  rateLimit: RateLimitSnapshot | null;
  /** Operator-disabled — kept loaded but skipped by account selection +
   *  auto-refresh. Persisted to token file so it survives restart. */
  disabled: boolean;
  /** Live in-flight client requests currently routed to this account. Drives
   *  weighted-least-inflight scheduling. acquireSlot/releaseSlot maintain it. */
  inFlight: number;
  /** Peak inFlight observed (for the dashboard). */
  peakInFlight: number;
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
  /** Codex only — chatgpt_plan_type claim ("plus", "pro", "free", …). */
  planType?: string;
  /** When the current 5h rate-limit window started (first message), or null
   *  if no traffic since startup. */
  windowStartedAt: string | null;
  /** When that window resets (= windowStartedAt + 5h), null if no window. */
  windowResetAt: string | null;
  /** Whether the window has expired already; next request opens a new one. */
  windowExpired: boolean;
  /** Latest rate-limit header snapshot observed from upstream, if any. */
  rateLimit: RateLimitSnapshot | null;
  /** When true the account is operator-disabled — token kept, but no traffic
   *  and no refresh. UI surfaces this as a separate badge from cooldown. */
  disabled: boolean;
  /** Display-only monthly budget (USD), or null if unset. */
  monthlyBudgetUsd: number | null;
  /** Display-only tier label (e.g. "$25"), or null if unset. */
  tierLabel: string | null;
  /** Load-balancing weight (default 1). */
  concurrencyWeight: number;
  /** Live in-flight client requests on this account. */
  inFlight: number;
  /** Peak in-flight observed. */
  peakInFlight: number;
}

/** Per-provider capacity summary for the dashboard alert. */
export interface CapacitySummary {
  total: number;
  /** Accounts usable right now (enabled, not cooled, under in-flight cap). */
  usable: number;
  /** Min cooldown-reset across non-usable accounts (ISO), or null. */
  soonestResetAt: string | null;
  /** Highest 5h-window utilization across accounts (0..1), or null. */
  maxUtil5h: number | null;
  /** Total in-flight across the pool. */
  inFlight: number;
  /** Saturation rejections since start (pool full → 429). */
  saturationRejects: number;
  /** ok | info | warn | critical */
  level: "ok" | "info" | "warn" | "critical";
}

/**
 * Aggregated quota for one rolling window (5h or 7d) across the pool.
 *
 * Anthropic exposes per-account *utilization* (0..1), not absolute token
 * ceilings, so the pool is summed as **weighted equivalent windows**: each
 * account contributes `weight` units of capacity (weight = concurrencyWeight,
 * so a $125 account counts more than a $25 one) and `weight×util` units used.
 * Remaining is therefore an estimate in "window units", not in tokens.
 */
export interface QuotaWindowPool {
  /** Accounts contributing utilization data to this window. */
  accounts: number;
  /** Σ weight — total weighted capacity (equivalent windows). */
  capacity: number;
  /** Σ weight×util — weighted used capacity. */
  used: number;
  /** capacity − used — weighted remaining (equivalent windows). */
  remainingUnits: number;
  /** 1 − used/capacity (0..1), or null if no data. */
  remainingPct: number | null;
  /** Highest single-account utilization in this window (0..1). */
  maxUtil: number | null;
  /** Earliest window reset across accounts — raw unix-seconds string, or null. */
  soonestReset: string | null;
  /** Pool-exhaustion level by used fraction. */
  level: "ok" | "info" | "warn" | "critical";
}

/** Both rolling windows aggregated across the pool; either may be null when
 *  no account has surfaced that window's headers (e.g. non-Anthropic pools). */
export interface QuotaPool {
  "5h": QuotaWindowPool | null;
  "7d": QuotaWindowPool | null;
}

export interface AvailableAccount {
  token: TokenData;
  deviceId: string;
  accountUuid: string;
  provider: ProviderId;
  chatgptAccountId?: string;
}

export type AccountResult =
  | { account: AvailableAccount }
  | {
      account: null;
      failureKind: AccountFailureKind | null;
      retryAfterMs: number | null;
    };

const STICKY_MIN_MS = 20 * 60 * 1000; // 20 minutes
const STICKY_MAX_MS = 60 * 60 * 1000; // 60 minutes

function randomStickyDuration(): number {
  return STICKY_MIN_MS + Math.random() * (STICKY_MAX_MS - STICKY_MIN_MS);
}

// Lower = more recoverable, preferred when all accounts are unavailable
const FAILURE_PRIORITY: Record<AccountFailureKind, number> = {
  rate_limit: 0,
  server: 1,
  network: 2,
  forbidden: 3,
  auth: 4,
};

export type RefreshFn = (refreshToken: string) => Promise<TokenData>;

export interface AccountManagerOptions {
  provider: ProviderId;
  refresh: RefreshFn;
  /** Default: expires-lead 4h. Codex should pass since-last-refresh 8d. */
  refreshPolicy?: RefreshPolicy;
}

export interface ReloadStats {
  /** Emails that were not in memory before reload — newly loaded from disk. */
  added: string[];
  /** Existing emails whose access token differed on disk and was replaced. */
  updated: string[];
  /** Existing emails identical to disk — no change. */
  unchanged: string[];
}

function buildAvailableAccount(
  authDir: string,
  email: string,
  token: TokenData,
  provider: ProviderId,
): AvailableAccount {
  return {
    token,
    deviceId: getDeviceId(authDir, email),
    accountUuid: token.accountUuid,
    provider,
    chatgptAccountId:
      provider === "codex" ? token.accountUuid || undefined : undefined,
  };
}

export class AccountManager {
  private accounts: Map<string, AccountState> = new Map();
  private accountOrder: string[] = []; // emails in insertion order for round-robin
  private lastUsedIndex: number = -1;
  private stickyUntil: number = 0; // timestamp until which current account is sticky
  private authDir: string;
  private refreshTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private refreshing = false;
  readonly provider: ProviderId;
  private refreshFn: RefreshFn;
  private refreshPolicy: RefreshPolicy;
  private reloadPromise: Promise<ReloadStats> | null = null;
  /** Live load-balancing policy (hot-swappable via setRouting). */
  private routing: RoutingConfig = DEFAULT_ROUTING_CONFIG;
  /** Count of requests rejected because the whole pool was saturated. */
  private saturationRejects = 0;

  constructor(authDir: string, opts: AccountManagerOptions) {
    this.authDir = authDir;
    this.provider = opts.provider;
    this.refreshFn = opts.refresh;
    this.refreshPolicy = opts.refreshPolicy ?? DEFAULT_REFRESH_POLICY;
  }

  load(): void {
    const tokens = loadAllTokens(this.authDir, this.provider);
    for (const token of tokens) {
      // Backfill provider in case storage layer missed it (defensive).
      if (!token.provider) token.provider = this.provider;
      this.accounts.set(token.email, this.createAccountState(token));
      this.accountOrder.push(token.email);
    }
    console.log(`[${this.provider}] loaded ${this.accounts.size} account(s)`);
  }

  /**
   * Re-read tokens from disk and reconcile with in-memory state. Used to pick
   * up new tokens written by `--login` while the server is running, fixing
   * the race where the server's pending refresh would otherwise consume a
   * just-rotated refresh token (codex `refresh_token_reused`).
   *
   * Semantics: upsert only.
   *   - new email on disk → added
   *   - existing email, accessToken changed → token replaced, cooldown +
   *     lastError cleared, stats preserved
   *   - existing email, accessToken identical → unchanged
   *   - existing in memory but absent on disk → kept (preserves stats; user
   *     must restart to drop)
   *
   * Concurrent calls share one in-flight promise. In-flight refreshes are
   * awaited first so a refresh's post-await `acct.token = newToken` cannot
   * clobber freshly reconciled state.
   */
  reload(): Promise<ReloadStats> {
    if (!this.reloadPromise) {
      this.reloadPromise = this.performReload().finally(() => {
        this.reloadPromise = null;
      });
    }
    return this.reloadPromise;
  }

  private async performReload(): Promise<ReloadStats> {
    // Wait for any in-flight refresh to finish before reconciling. Otherwise:
    //   t0  refresh in flight: acct.refreshPromise pending, awaiting refreshFn
    //   t1  reload reads disk, replaces acct.token = T_disk
    //   t2  refresh's await resolves with T_refresh, sets acct.token = T_refresh
    //       → reload's effect is silently overwritten
    const inFlight = Array.from(this.accounts.values())
      .map((a) => a.refreshPromise)
      .filter((p): p is Promise<boolean> => p !== null);
    if (inFlight.length) {
      await Promise.allSettled(inFlight);
    }

    const tokens = loadAllTokens(this.authDir, this.provider);
    const stats: ReloadStats = { added: [], updated: [], unchanged: [] };

    for (const token of tokens) {
      if (!token.provider) token.provider = this.provider;
      const existing = this.accounts.get(token.email);
      if (!existing) {
        this.accounts.set(token.email, this.createAccountState(token));
        this.accountOrder.push(token.email);
        stats.added.push(token.email);
        continue;
      }
      // Compare BOTH accessToken and refreshToken: the precise race we're
      // fixing is about a rotated refresh token, and OAuth doesn't forbid the
      // server returning the same access_token + a new refresh_token (rare in
      // OpenAI's current behaviour but defensive coding here costs nothing).
      const tokenChanged =
        existing.token.accessToken !== token.accessToken ||
        existing.token.refreshToken !== token.refreshToken;
      if (!tokenChanged) {
        stats.unchanged.push(token.email);
        continue;
      }
      // Token rotated on disk — replace in place and clear failure state, but
      // preserve stats (operational continuity for the operator).
      existing.token = token;
      existing.cooldownUntil = 0;
      existing.failureCount = 0;
      existing.lastFailureKind = null;
      existing.lastError = null;
      existing.lastFailureAt = null;
      stats.updated.push(token.email);
    }

    console.log(
      `[${this.provider}] reload: +${stats.added.length} added, ${stats.updated.length} updated, ${stats.unchanged.length} unchanged`,
    );
    return stats;
  }

  addAccount(token: TokenData): void {
    if (!token.provider) token.provider = this.provider;
    if (token.provider !== this.provider) {
      throw new Error(
        `addAccount: token.provider=${token.provider} does not match manager.provider=${this.provider}`,
      );
    }
    const existing = this.accounts.get(token.email);
    if (existing) {
      // Re-auth re-enables a disabled account: the operator intentionally
      // logged in again, so they want to use it. Clear the flag both in
      // memory and on the new token we're about to persist.
      token.disabled = false;
      existing.disabled = false;
      existing.token = token;
      existing.cooldownUntil = 0;
      existing.failureCount = 0;
      existing.lastFailureKind = null;
      existing.lastError = null;
      existing.lastFailureAt = null;
      existing.lastSuccessAt = new Date().toISOString();
      existing.lastRefreshAt = new Date().toISOString();
    } else {
      const state = this.createAccountState(token);
      state.lastSuccessAt = new Date().toISOString();
      state.lastRefreshAt = new Date().toISOString();
      this.accounts.set(token.email, state);
      this.accountOrder.push(token.email);
    }

    saveToken(this.authDir, token);
  }

  /** Hot-swap the routing/load-balancing policy (from SettingsStore/UI). */
  setRouting(cfg: RoutingConfig): void {
    this.routing = cfg;
  }

  /** Effective load-balancing weight for an account (default 1). */
  private weightOf(acct: AccountState): number {
    const w = acct.token.concurrencyWeight;
    return typeof w === "number" && w > 0 ? w : 1;
  }

  /** Parse a utilization header value (0..1), or null if unknown. May be a
   *  fraction (0.42) or a percent (42). */
  private parseUtil(raw: string | undefined): number | null {
    if (raw == null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return n > 1 ? n / 100 : n;
  }

  /** Parse 5h-window utilization (0..1) from captured rate-limit headers, or
   *  null if unknown. */
  private util5h(acct: AccountState): number | null {
    return this.parseUtil(acct.rateLimit?.fields?.["unified-5h-utilization"]);
  }

  private isUsable(acct: AccountState, now: number): boolean {
    if (acct.disabled || acct.cooldownUntil > now) return false;
    const cap = this.routing["per-account-max-inflight"];
    if (cap > 0 && acct.inFlight >= cap) return false;
    return true;
  }

  /**
   * Pick an upstream account for the next client request.
   *
   * Strategies (RoutingConfig):
   *   - "sticky": legacy — one global sticky account until cooldown/expiry.
   *   - "weighted-least-inflight": always pick min `inFlight/weight`
   *     (+ 5h-utilization penalty), no stickiness — maximal concurrency spread.
   *   - "adaptive" (default): keep the affinity (last-used) account while its
   *     inFlight < `stick-while-inflight-below` (cache-warm at low load), else
   *     fall back to weighted-least-inflight (spread under pressure).
   *
   * Pure selector: it does NOT increment inFlight — callers handling live
   * client traffic must call acquireSlot()/releaseSlot() around the request.
   */
  getNextAccount(): AccountResult {
    const count = this.accountOrder.length;
    if (count === 0) {
      return { account: null, failureKind: null, retryAfterMs: null };
    }
    const now = Date.now();
    const ok = (idx: number, email: string, acct: AccountState): AccountResult => {
      this.lastUsedIndex = idx;
      this.stickyUntil = now + randomStickyDuration();
      return {
        account: buildAvailableAccount(this.authDir, email, acct.token, this.provider),
      };
    };

    // ── sticky (legacy) ──
    if (this.routing.strategy === "sticky") {
      if (this.lastUsedIndex >= 0 && now < this.stickyUntil) {
        const email = this.accountOrder[this.lastUsedIndex];
        const acct = this.accounts.get(email)!;
        if (this.isUsable(acct, now)) return ok(this.lastUsedIndex, email, acct);
      }
      const startIdx = this.lastUsedIndex >= 0 ? this.lastUsedIndex + 1 : 0;
      for (let i = 0; i < count; i++) {
        const idx = (startIdx + i) % count;
        const email = this.accountOrder[idx];
        const acct = this.accounts.get(email)!;
        if (this.isUsable(acct, now)) return ok(idx, email, acct);
      }
      return this.noUsableAccount(now);
    }

    // ── adaptive: keep affinity account if lightly loaded ──
    if (this.routing.strategy === "adaptive" && this.lastUsedIndex >= 0) {
      const email = this.accountOrder[this.lastUsedIndex];
      const acct = this.accounts.get(email);
      if (
        acct &&
        this.isUsable(acct, now) &&
        acct.inFlight < this.routing["stick-while-inflight-below"]
      ) {
        return ok(this.lastUsedIndex, email, acct);
      }
    }

    // ── weighted least-in-flight (+ optional 5h-utilization penalty) ──
    let bestIdx = -1;
    let bestLoad = Infinity;
    for (let idx = 0; idx < count; idx++) {
      const email = this.accountOrder[idx];
      const acct = this.accounts.get(email)!;
      if (!this.isUsable(acct, now)) continue;
      let load = acct.inFlight / this.weightOf(acct);
      if (this.routing["use-5h-utilization"]) {
        const u = this.util5h(acct);
        if (u != null) load += u;
      }
      if (load < bestLoad) {
        bestLoad = load;
        bestIdx = idx;
      }
    }
    if (bestIdx >= 0) {
      const email = this.accountOrder[bestIdx];
      return ok(bestIdx, email, this.accounts.get(email)!);
    }
    return this.noUsableAccount(now);
  }

  /**
   * No account usable right now (all disabled / cooled / saturated). Returns
   * the most-recoverable failure kind + retry-after for the error response.
   */
  private noUsableAccount(now: number): AccountResult {
    this.saturationRejects++;
    const nonDisabled = this.accountOrder.filter(
      (e) => !this.accounts.get(e)!.disabled,
    );
    if (nonDisabled.length === 0) {
      return { account: null, failureKind: "auth", retryAfterMs: null };
    }
    const firstAcct = this.accounts.get(nonDisabled[0])!;
    let bestKind: AccountFailureKind = firstAcct.lastFailureKind ?? "network";
    let bestRemainingMs = Math.max(0, firstAcct.cooldownUntil - now);
    for (const email of nonDisabled.slice(1)) {
      const acct = this.accounts.get(email)!;
      const kind = acct.lastFailureKind ?? "network";
      const remainingMs = Math.max(0, acct.cooldownUntil - now);
      if (
        FAILURE_PRIORITY[kind] < FAILURE_PRIORITY[bestKind] ||
        (FAILURE_PRIORITY[kind] === FAILURE_PRIORITY[bestKind] &&
          remainingMs < bestRemainingMs)
      ) {
        bestKind = kind;
        bestRemainingMs = remainingMs;
      }
    }
    const isRecoverable = bestKind !== "auth" && bestKind !== "forbidden";
    return {
      account: null,
      failureKind: bestKind,
      retryAfterMs: isRecoverable ? bestRemainingMs : null,
    };
  }

  /** Increment in-flight for an account (call when a request starts using it). */
  acquireSlot(email: string): void {
    const acct = this.accounts.get(email);
    if (!acct) return;
    acct.inFlight++;
    if (acct.inFlight > acct.peakInFlight) acct.peakInFlight = acct.inFlight;
  }

  /** Decrement in-flight (call exactly once per acquireSlot, on request end). */
  releaseSlot(email: string): void {
    const acct = this.accounts.get(email);
    if (!acct) return;
    if (acct.inFlight > 0) acct.inFlight--;
  }

  /** Per-provider capacity summary for the dashboard alert. */
  capacitySummary(): CapacitySummary {
    const now = Date.now();
    let usable = 0;
    let inFlight = 0;
    let soonest = Infinity;
    let maxUtil: number | null = null;
    for (const acct of this.accounts.values()) {
      inFlight += acct.inFlight;
      if (this.isUsable(acct, now)) usable++;
      else if (!acct.disabled && acct.cooldownUntil > now) {
        soonest = Math.min(soonest, acct.cooldownUntil);
      }
      const u = this.util5h(acct);
      if (u != null) maxUtil = maxUtil == null ? u : Math.max(maxUtil, u);
    }
    const total = this.accountOrder.length;
    let level: CapacitySummary["level"] = "ok";
    if (total > 0 && usable === 0) level = "critical";
    else if (usable === 0) level = "critical";
    else if (maxUtil != null && maxUtil >= 0.9) level = "warn";
    else if (maxUtil != null && maxUtil >= 0.75) level = "info";
    return {
      total,
      usable,
      soonestResetAt: soonest === Infinity ? null : new Date(soonest).toISOString(),
      maxUtil5h: maxUtil,
      inFlight,
      saturationRejects: this.saturationRejects,
      level,
    };
  }

  /** Aggregate one rolling window across all enabled accounts that have its
   *  headers. Capacity is weighted by concurrencyWeight (equivalent windows);
   *  remaining is reported as a percentage + weighted units, never as tokens
   *  (Anthropic does not publish absolute quotas). Returns null if no account
   *  surfaces this window. */
  private windowPool(utilKey: string, resetKey: string): QuotaWindowPool | null {
    const now = Date.now();
    let accounts = 0;
    let capacity = 0;
    let used = 0;
    let maxUtil: number | null = null;
    let soonest: number | null = null;
    for (const acct of this.accounts.values()) {
      if (acct.disabled) continue;
      const u = this.parseUtil(acct.rateLimit?.fields?.[utilKey]);
      if (u == null) continue;
      const clamped = Math.min(Math.max(u, 0), 1);
      const w = this.weightOf(acct);
      accounts++;
      capacity += w;
      used += w * clamped;
      maxUtil = maxUtil == null ? u : Math.max(maxUtil, u);
      const r = Number(acct.rateLimit?.fields?.[resetKey]);
      if (Number.isFinite(r) && r * 1000 > now) {
        soonest = soonest == null ? r : Math.min(soonest, r);
      }
    }
    if (accounts === 0) return null;
    const round = (x: number) => Math.round(x * 100) / 100;
    const remainingPct =
      capacity > 0 ? Math.round((1 - used / capacity) * 10000) / 10000 : null;
    const usedPct = remainingPct == null ? 0 : 1 - remainingPct;
    let level: QuotaWindowPool["level"] = "ok";
    if (usedPct >= 0.95) level = "critical";
    else if (usedPct >= 0.9) level = "warn";
    else if (usedPct >= 0.75) level = "info";
    return {
      accounts,
      capacity: round(capacity),
      used: round(used),
      remainingUnits: round(capacity - used),
      remainingPct,
      maxUtil,
      soonestReset: soonest == null ? null : String(soonest),
      level,
    };
  }

  /** Pool-wide quota summary for the dashboard: 5h + 7d windows aggregated as
   *  weighted equivalent windows. Either window is null if no account exposes
   *  it (e.g. Codex/Cursor pools have no unified-* headers). */
  quotaPool(): QuotaPool {
    return {
      "5h": this.windowPool("unified-5h-utilization", "unified-5h-reset"),
      "7d": this.windowPool("unified-7d-utilization", "unified-7d-reset"),
    };
  }

  recordAttempt(email: string): void {
    const acct = this.accounts.get(email);
    if (!acct) return;
    acct.totalRequests++;
    // Anchor the 5h rate-limit window — ONLY for providers whose upstream has
    // a first-message-triggered tumbling window. Anthropic Pro/Max OAuth is
    // the only one today; Codex / Cursor use different quota models so the
    // 5h anchor doesn't apply (showing it in the UI would mislead).
    if (this.provider !== "anthropic") return;
    const now = Date.now();
    if (
      acct.windowStartedAt == null ||
      now - new Date(acct.windowStartedAt).getTime() > RATE_LIMIT_WINDOW_MS
    ) {
      acct.windowStartedAt = new Date(now).toISOString();
    }
  }

  /**
   * Capture upstream rate-limit headers verbatim. Called by proxyWithRetry
   * after every upstream response (success or error). Only fields with the
   * `anthropic-ratelimit-` prefix (or `retry-after`) are kept — strip the
   * provider prefix in the stored key for compactness.
   */
  recordRateLimit(email: string, headers: Headers): void {
    const acct = this.accounts.get(email);
    if (!acct) return;
    // Only the Anthropic upstream's `anthropic-ratelimit-*` (especially
    // `unified-*`) headers have semantics we can interpret today. Codex /
    // Cursor headers have different meanings and shouldn't be mixed into
    // the same Anthropic-keyed snapshot. Skip non-Anthropic providers to
    // avoid storing misleading rate-limit info. (Fix F10.)
    if (this.provider !== "anthropic") return;
    const fields: Record<string, string> = {};
    let retryAfterSec: number | undefined;
    headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (k === "retry-after") {
        const n = Number(value);
        if (Number.isFinite(n)) retryAfterSec = n;
      } else if (k.startsWith("anthropic-ratelimit-")) {
        fields[k.slice("anthropic-ratelimit-".length)] = value;
      } else if (k.startsWith("x-ratelimit-")) {
        fields[k.slice("x-ratelimit-".length)] = value;
      }
    });
    // Only store when we actually got something — never overwrite a valid
    // snapshot with an empty one.
    if (retryAfterSec === undefined && Object.keys(fields).length === 0) return;
    acct.rateLimit = {
      observedAt: new Date().toISOString(),
      retryAfterSec,
      fields,
    };
  }

  recordSuccess(email: string, usage?: UsageData): void {
    const acct = this.accounts.get(email);
    if (!acct) return;

    acct.cooldownUntil = 0;
    acct.failureCount = 0;
    acct.lastFailureKind = null;
    acct.lastError = null;
    acct.lastFailureAt = null;
    acct.lastSuccessAt = new Date().toISOString();
    acct.totalSuccesses++;

    if (usage) {
      acct.totalInputTokens += usage.inputTokens;
      acct.totalOutputTokens += usage.outputTokens;
      acct.totalCacheCreationInputTokens += usage.cacheCreationInputTokens;
      acct.totalCacheReadInputTokens += usage.cacheReadInputTokens;
      acct.totalReasoningOutputTokens += usage.reasoningOutputTokens;
    }
  }

  recordFailure(
    email: string,
    kind: AccountFailureKind,
    detail?: string,
  ): void {
    const acct = this.accounts.get(email);
    if (!acct) return;

    acct.failureCount++;
    acct.totalFailures++;
    acct.lastFailureKind = kind;
    acct.lastFailureAt = new Date().toISOString();
    acct.lastError = detail ? `${kind}: ${detail}` : kind;

    const { baseMs, maxMs } = FAILURE_BACKOFF[kind];
    const cooldownMs = Math.min(
      baseMs * 2 ** Math.max(0, acct.failureCount - 1),
      maxMs,
    );
    acct.cooldownUntil = Date.now() + cooldownMs;
    console.log(
      `[${this.provider}] account ${email} cooled down for ${Math.round(
        cooldownMs / 1000,
      )}s (${kind})`,
    );
  }

  /**
   * Refresh an account's token. Concurrent callers share a single in-flight
   * promise — critical for providers (e.g. Codex) where refresh tokens rotate
   * and any second concurrent refresh would invalidate the first.
   */
  refreshAccount(email: string): Promise<boolean> {
    const acct = this.accounts.get(email);
    if (!acct) return Promise.resolve(false);
    // Assignment must be synchronous (before any await) so concurrent callers
    // see the in-flight promise.
    if (!acct.refreshPromise) {
      acct.refreshPromise = this.performRefresh(acct);
    }
    return acct.refreshPromise;
  }

  /**
   * List all loaded account emails in insertion order. Read-only — does NOT
   * affect sticky routing. Used by /admin/prewarm to iterate the pool.
   */
  listEmails(): string[] {
    return [...this.accountOrder];
  }

  /**
   * Build a usable AvailableAccount handle for a specific email, bypassing
   * sticky / round-robin selection. Returns null if the email is unknown OR
   * the account is currently in cooldown (caller should treat as skipped).
   *
   * Critical: this is the only sanctioned way to address a specific account
   * for out-of-band calls (e.g. prewarm). Do NOT use it for client-facing
   * traffic — that path must go through getNextAccount().
   */
  getAvailableAccount(email: string): AvailableAccount | null {
    const acct = this.accounts.get(email);
    if (!acct) return null;
    if (acct.disabled) return null;
    if (acct.cooldownUntil > Date.now()) return null;
    return buildAvailableAccount(this.authDir, email, acct.token, this.provider);
  }

  /**
   * Toggle the operator-disabled flag. Persists by re-saving the token file
   * with the new `disabled` field (TokenStorage carries it). Returns the new
   * disabled state, or null if the email isn't loaded.
   *
   * Side effects when disabling:
   *   - Skipped by getNextAccount() / getAvailableAccount()
   *   - Skipped by auto-refresh loop
   *   - In-flight requests using this account are NOT aborted (they finish
   *     naturally; record* methods will still update stats)
   *   - If currently sticky, drop it so the next call rotates away
   */
  setDisabled(email: string, value: boolean): boolean | null {
    const acct = this.accounts.get(email);
    if (!acct) return null;
    if (acct.disabled === value) return value;
    acct.disabled = value;
    acct.token.disabled = value;
    saveToken(this.authDir, acct.token);
    if (value) {
      // Drop sticky pointer if it was on this account so the next request
      // doesn't keep trying to use it.
      const stickyIdx = this.lastUsedIndex;
      if (
        stickyIdx >= 0 &&
        this.accountOrder[stickyIdx] === email
      ) {
        this.lastUsedIndex = -1;
        this.stickyUntil = 0;
      }
    }
    console.log(
      `[${this.provider}] account ${email} ${value ? "disabled" : "enabled"}`,
    );
    return value;
  }

  /**
   * Set display-only budget / tier annotations on an account, persisted to the
   * token file. Pass undefined for a field to leave it unchanged; pass null to
   * clear it. Returns true if the account exists, false otherwise.
   */
  setBudget(
    email: string,
    opts: {
      monthlyBudgetUsd?: number | null;
      tierLabel?: string | null;
      concurrencyWeight?: number | null;
    },
  ): boolean {
    const acct = this.accounts.get(email);
    if (!acct) return false;
    if (opts.monthlyBudgetUsd !== undefined) {
      acct.token.monthlyBudgetUsd =
        opts.monthlyBudgetUsd === null ? undefined : opts.monthlyBudgetUsd;
    }
    if (opts.tierLabel !== undefined) {
      acct.token.tierLabel = opts.tierLabel === null ? undefined : opts.tierLabel;
    }
    if (opts.concurrencyWeight !== undefined) {
      acct.token.concurrencyWeight =
        opts.concurrencyWeight === null ? undefined : opts.concurrencyWeight;
    }
    saveToken(this.authDir, acct.token);
    return true;
  }

  /**
   * Permanently remove an account: drop from memory + delete its token file.
   * Returns true if removed, false if the email wasn't loaded.
   *
   * In-flight requests using this account see their record* calls become
   * no-ops (the email key is gone from this.accounts) — this is safe; stats
   * for that account are lost on purpose.
   */
  removeAccount(email: string): boolean {
    if (!this.accounts.has(email)) return false;
    this.accounts.delete(email);
    const orderIdx = this.accountOrder.indexOf(email);
    if (orderIdx >= 0) {
      this.accountOrder.splice(orderIdx, 1);
      // Sticky pointer can become stale if we just removed the sticky entry
      // or shifted indices around it. Easiest correct fix: drop sticky.
      if (this.lastUsedIndex === orderIdx || this.lastUsedIndex >= this.accountOrder.length) {
        this.lastUsedIndex = -1;
        this.stickyUntil = 0;
      } else if (this.lastUsedIndex > orderIdx) {
        this.lastUsedIndex--;
      }
    }
    deleteToken(this.authDir, this.provider, email);
    console.log(`[${this.provider}] account ${email} removed`);
    return true;
  }

  getSnapshots(): AccountSnapshot[] {
    const now = Date.now();
    const snapshots: AccountSnapshot[] = [];
    for (const acct of this.accounts.values()) {
      // Derive 5h window reset / expiry from the anchor.
      let windowResetAt: string | null = null;
      let windowExpired = false;
      if (acct.windowStartedAt) {
        const resetMs =
          new Date(acct.windowStartedAt).getTime() + RATE_LIMIT_WINDOW_MS;
        windowResetAt = new Date(resetMs).toISOString();
        windowExpired = now > resetMs;
      }
      snapshots.push({
        email: acct.token.email,
        available: acct.cooldownUntil <= now,
        cooldownUntil: acct.cooldownUntil,
        failureCount: acct.failureCount,
        lastError: acct.lastError,
        lastFailureAt: acct.lastFailureAt,
        lastSuccessAt: acct.lastSuccessAt,
        lastRefreshAt: acct.lastRefreshAt,
        totalRequests: acct.totalRequests,
        totalSuccesses: acct.totalSuccesses,
        totalFailures: acct.totalFailures,
        totalInputTokens: acct.totalInputTokens,
        totalOutputTokens: acct.totalOutputTokens,
        totalCacheCreationInputTokens: acct.totalCacheCreationInputTokens,
        totalCacheReadInputTokens: acct.totalCacheReadInputTokens,
        totalReasoningOutputTokens: acct.totalReasoningOutputTokens,
        expiresAt: acct.token.expiresAt,
        refreshing: acct.refreshPromise !== null,
        planType: acct.token.planType,
        windowStartedAt: acct.windowStartedAt,
        windowResetAt,
        windowExpired,
        rateLimit: acct.rateLimit,
        disabled: acct.disabled,
        monthlyBudgetUsd: acct.token.monthlyBudgetUsd ?? null,
        tierLabel: acct.token.tierLabel ?? null,
        concurrencyWeight: this.weightOf(acct),
        inFlight: acct.inFlight,
        peakInFlight: acct.peakInFlight,
      });
    }
    return snapshots;
  }

  startAutoRefresh(): void {
    const timer = setInterval(
      () =>
        this.refreshAll().catch((err) =>
          console.error(
            `[${this.provider}] refresh cycle failed:`,
            err.message,
          ),
        ),
      REFRESH_CHECK_INTERVAL_MS,
    );
    timer.unref();
    this.refreshTimer = timer;
    this.refreshAll().catch((err) =>
      console.error(`[${this.provider}] initial refresh failed:`, err.message),
    );
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  startStatsLogger(): void {
    const timer = setInterval(() => this.logStats(), 5 * 60 * 1000);
    timer.unref();
    this.statsTimer = timer;
  }

  stopStatsLogger(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  private logStats(): void {
    if (this.accounts.size === 0) return;
    console.log(
      `\n===== [${this.provider}] account stats (${new Date().toISOString()}) =====`,
    );
    for (const acct of this.accounts.values()) {
      const available = acct.cooldownUntil <= Date.now();
      console.log(
        `  ${acct.token.email}: ` +
          `available=${available}, ` +
          `requests=${acct.totalRequests}, ` +
          `successes=${acct.totalSuccesses}, ` +
          `failures=${acct.totalFailures}, ` +
          `input_tokens=${acct.totalInputTokens}, ` +
          `output_tokens=${acct.totalOutputTokens}, ` +
          `cache_creation=${acct.totalCacheCreationInputTokens}, ` +
          `cache_read=${acct.totalCacheReadInputTokens}, ` +
          `reasoning=${acct.totalReasoningOutputTokens}, ` +
          `total_tokens=${acct.totalInputTokens + acct.totalOutputTokens + acct.totalCacheCreationInputTokens + acct.totalCacheReadInputTokens}`,
      );
    }
    console.log(`====================================================\n`);
  }

  get accountCount(): number {
    return this.accounts.size;
  }

  private shouldRefresh(acct: AccountState, now: number): boolean {
    const policy = this.refreshPolicy;
    if (policy.kind === "expires-lead") {
      const expiresAt = new Date(acct.token.expiresAt).getTime();
      return expiresAt - now <= policy.leadMs;
    }
    // since-last-refresh: refresh when lastRefreshAt is older than maxAgeMs.
    // No timestamp known → treat as "fresh" (just loaded; give it time).
    if (!acct.lastRefreshAt) return false;
    const last = new Date(acct.lastRefreshAt).getTime();
    return now - last >= policy.maxAgeMs;
  }

  private async refreshAll(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const now = Date.now();
      for (const acct of this.accounts.values()) {
        // Skip disabled — token won't be used; refreshing it just wastes a
        // refresh-token rotation. Re-auth (via addAccount) clears `disabled`.
        if (acct.disabled) continue;
        if (this.shouldRefresh(acct, now)) {
          await this.refreshAccount(acct.token.email);
        }
      }
    } finally {
      this.refreshing = false;
    }
  }

  private async performRefresh(acct: AccountState): Promise<boolean> {
    try {
      console.log(
        `[${this.provider}] refreshing token for ${acct.token.email}…`,
      );
      const refreshed = await this.refreshFn(acct.token.refreshToken);
      const refreshAt = new Date().toISOString();
      // Compose the new token preserving fields the provider may not return.
      const newToken: TokenData = {
        ...acct.token,
        ...refreshed,
        email: refreshed.email || acct.token.email,
        provider: this.provider,
        // Some providers omit accountUuid on refresh — keep the original.
        accountUuid: refreshed.accountUuid || acct.token.accountUuid,
        lastRefreshAt: refreshAt,
      };
      // Persist BEFORE mutating in-memory state or releasing the lock — if the
      // disk write fails we want the old token to remain in-memory so the next
      // attempt can retry from a known state.
      saveToken(this.authDir, newToken);
      acct.token = newToken;
      acct.cooldownUntil = 0;
      acct.failureCount = 0;
      acct.lastFailureKind = null;
      acct.lastError = null;
      acct.lastFailureAt = null;
      acct.lastSuccessAt = refreshAt;
      acct.lastRefreshAt = refreshAt;
      console.log(
        `[${this.provider}] token refreshed for ${newToken.email}, expires ${newToken.expiresAt}`,
      );
      return true;
    } catch (err: any) {
      if (err instanceof RefreshTokenExhaustedError) {
        // Terminal — refresh token cannot be reused. Long cooldown + clear
        // operator-facing message; don't keep hammering the upstream.
        const message = `refresh token ${err.reason}; re-run \`auth2api --login --provider=${this.provider}\` to re-authorize`;
        acct.failureCount++;
        acct.totalFailures++;
        acct.lastFailureKind = "auth";
        acct.lastFailureAt = new Date().toISOString();
        acct.lastError = message;
        acct.cooldownUntil = Date.now() + REAUTH_COOLDOWN_MS;
        console.error(
          `[${this.provider}] account ${acct.token.email} needs re-auth: ${message}`,
        );
      } else {
        this.recordFailure(acct.token.email, "auth", err.message);
        console.error(
          `[${this.provider}] token refresh failed for ${acct.token.email}: ${err.message}`,
        );
      }
      return false;
    } finally {
      // Release the lock LAST so concurrent waiters always observe a completed
      // refresh (success: new token persisted; failure: cooldown set).
      acct.refreshPromise = null;
    }
  }

  private createAccountState(token: TokenData): AccountState {
    return {
      token,
      cooldownUntil: 0,
      failureCount: 0,
      lastFailureKind: null,
      lastError: null,
      lastFailureAt: null,
      lastSuccessAt: null,
      // Seed from the persisted last_refresh so refresh policies that depend
      // on the timestamp (e.g. codex's since-last-refresh) work after a restart.
      lastRefreshAt: token.lastRefreshAt ?? null,
      totalRequests: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationInputTokens: 0,
      totalCacheReadInputTokens: 0,
      totalReasoningOutputTokens: 0,
      refreshPromise: null,
      windowStartedAt: null,
      rateLimit: null,
      disabled: token.disabled === true,
      inFlight: 0,
      peakInFlight: 0,
    };
  }
}
