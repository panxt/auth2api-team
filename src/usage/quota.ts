import { ProviderId } from "../auth/types";
import type { ModelPrice } from "./pricing";
import { billableTokens, computeCost } from "./pricing";
import { StatsEvent } from "../stats/recorder";
import type { EventLog } from "../storage/types";

export interface Consumption {
  tokens: number;
  costUsd: number;
}

/** Window selector for quota lookups. */
export type QuotaWindow = "month" | "day";

/** Calendar-month key in UTC, e.g. "2026-05". Resets at UTC month start. */
function monthKeyOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Calendar-day key in UTC, e.g. "2026-05-09". Resets at UTC midnight. */
function dayKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Seconds until the next UTC month boundary — used for the quota Retry-After. */
export function secondsUntilMonthResetUTC(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/** Seconds until the next UTC midnight — Retry-After for daily quotas. */
export function secondsUntilDayResetUTC(now = new Date()): number {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
  );
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

function emptyConsumption(): Consumption {
  return { tokens: 0, costUsd: 0 };
}

/** MCP gateway records each tool call as endpoint "MCP <server>/<tool>". Pull
 *  the upstream server id back out, or null for non-MCP endpoints. */
function mcpServerOf(endpoint: string): string | null {
  const PREFIX = "MCP ";
  if (!endpoint.startsWith(PREFIX)) return null;
  const rest = endpoint.slice(PREFIX.length);
  const slash = rest.indexOf("/");
  return slash < 0 ? rest : rest.slice(0, slash);
}

/**
 * Token + cost consumption per API key, tracked on two windows (current UTC
 * month and current UTC day) and at two grains (per-key total and
 * per-(key, model)). Drives quota enforcement — month/day × overall/per-model.
 *
 * Like StatsRecorder it replays the same `stats.jsonl` on startup (folding
 * each event into whichever windows it still belongs to) and is fed live
 * events from the stats finish-middleware, so it survives restarts without a
 * second log. Cost is derived from each event's tokens via the same pricing
 * the reports use, so quota and reporting never disagree.
 */
export class QuotaTracker {
  private monthKey: string = monthKeyOf(new Date());
  private dayKey: string = dayKeyOf(new Date());
  private monthByKey = new Map<string, Consumption>();
  private monthByKeyModel = new Map<string, Consumption>();
  private dayByKey = new Map<string, Consumption>();
  private dayByKeyModel = new Map<string, Consumption>();
  // Per-key MCP call counts (month window), broken down by upstream server id.
  // MCP tool calls carry no token usage, so they're tracked separately from
  // Consumption (which is token/cost only) — count only, keyed apiKeyHash→(server→n).
  private monthMcpByKey = new Map<string, Map<string, number>>();
  private overrides?: Record<string, ModelPrice>;

  constructor(pricingOverrides?: Record<string, ModelPrice>) {
    this.overrides = pricingOverrides;
  }

  /** Replay persisted events into the current-month/day aggregates. */
  start(log: EventLog): void {
    this.monthKey = monthKeyOf(new Date());
    this.dayKey = dayKeyOf(new Date());
    try {
      log.replay((ev) => this.applyEvent(ev));
    } catch (err: any) {
      console.error("[quota] replay failed:", err?.message);
    }
  }

  /** Live event from the stats finish-middleware. */
  record(ev: StatsEvent): void {
    this.rollIfNeeded();
    this.applyEvent(ev);
  }

  /**
   * Consumption for one API key. Defaults to month-to-date overall (the
   * original signature — back-compatible). Pass a window and/or model for the
   * finer-grained buckets used by per-model / daily quota enforcement.
   */
  consumed(
    apiKeyHash: string,
    opts?: { window?: QuotaWindow; model?: string },
  ): Consumption {
    this.rollIfNeeded();
    const window = opts?.window ?? "month";
    const model = opts?.model;
    if (model) {
      const map = window === "day" ? this.dayByKeyModel : this.monthByKeyModel;
      return map.get(`${apiKeyHash}|${model}`) ?? emptyConsumption();
    }
    const map = window === "day" ? this.dayByKey : this.monthByKey;
    return map.get(apiKeyHash) ?? emptyConsumption();
  }

  /** Month-to-date MCP tool-call counts for one API key, keyed by upstream
   *  server id. Empty object when the key made no MCP calls this month. */
  mcpConsumed(apiKeyHash: string): Record<string, number> {
    this.rollIfNeeded();
    const m = this.monthMcpByKey.get(apiKeyHash);
    return m ? Object.fromEntries(m) : {};
  }

  /** Drop accumulated counts when the wall clock crosses a window boundary. */
  private rollIfNeeded(): void {
    const now = new Date();
    const mk = monthKeyOf(now);
    if (mk !== this.monthKey) {
      this.monthKey = mk;
      this.monthByKey.clear();
      this.monthByKeyModel.clear();
      this.monthMcpByKey.clear();
    }
    const dk = dayKeyOf(now);
    if (dk !== this.dayKey) {
      this.dayKey = dk;
      this.dayByKey.clear();
      this.dayByKeyModel.clear();
    }
  }

  private add(map: Map<string, Consumption>, key: string, c: Consumption): void {
    const cur = map.get(key) ?? emptyConsumption();
    cur.tokens += c.tokens;
    cur.costUsd += c.costUsd;
    map.set(key, cur);
  }

  /**
   * Fold one event into whichever current windows it belongs to. Replayed
   * history outside the current month/day is ignored for that window, and
   * events with no usage (failures, disconnects before any token) are skipped.
   */
  private applyEvent(ev: StatsEvent): void {
    const evDate = new Date(ev.ts);
    const inMonth = monthKeyOf(evDate) === this.monthKey;
    const inDay = dayKeyOf(evDate) === this.dayKey;
    if (!inMonth && !inDay) return;

    // MCP tool calls have no token usage — count them (per key × server) and
    // return, since the token/cost aggregation below is a no-op for them.
    const mcpServer = mcpServerOf(ev.endpoint);
    if (mcpServer) {
      if (inMonth) {
        let m = this.monthMcpByKey.get(ev.apiKeyHash);
        if (!m) {
          m = new Map();
          this.monthMcpByKey.set(ev.apiKeyHash, m);
        }
        m.set(mcpServer, (m.get(mcpServer) ?? 0) + 1);
      }
      return;
    }
    if (!ev.usage) return;

    const provider = (ev.provider ?? undefined) as ProviderId | undefined;
    const tokens = billableTokens(ev.usage, provider);
    const cost = ev.model
      ? computeCost(ev.model, ev.usage, provider, this.overrides)
      : 0;
    const delta: Consumption = { tokens, costUsd: cost };
    const model = ev.model || "unknown";

    if (inMonth) {
      this.add(this.monthByKey, ev.apiKeyHash, delta);
      this.add(this.monthByKeyModel, `${ev.apiKeyHash}|${model}`, delta);
    }
    if (inDay) {
      this.add(this.dayByKey, ev.apiKeyHash, delta);
      this.add(this.dayByKeyModel, `${ev.apiKeyHash}|${model}`, delta);
    }
  }
}
