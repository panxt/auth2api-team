import { ProviderId } from "../auth/types";
import type { ModelPrice } from "./pricing";
import { billableTokens, computeCost } from "./pricing";
import { StatsEvent } from "../stats/recorder";
import { replayStatsEvents, statsFilePath } from "../stats/storage";

export interface Consumption {
  tokens: number;
  costUsd: number;
}

/** Calendar-month key in UTC, e.g. "2026-05". Resets happen at UTC month start. */
function monthKeyOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Month-to-date token + cost consumption per API key, used to enforce monthly
 * quotas. Mirrors StatsRecorder: it replays the same `stats.jsonl` on startup
 * (counting only the current calendar month) and is fed live events from the
 * stats finish-middleware, so it survives restarts without a second log.
 *
 * Cost is derived from each event's tokens via the same pricing the reports
 * use, so quota and reporting never disagree.
 */
export class QuotaTracker {
  private monthKey: string = monthKeyOf(new Date());
  private byKey = new Map<string, Consumption>();
  private overrides?: Record<string, ModelPrice>;

  constructor(pricingOverrides?: Record<string, ModelPrice>) {
    this.overrides = pricingOverrides;
  }

  /** Replay persisted events into the current-month aggregate. Non-fatal on error. */
  start(authDir: string): void {
    this.monthKey = monthKeyOf(new Date());
    const filePath = statsFilePath(authDir);
    try {
      replayStatsEvents(filePath, (ev) => this.applyEvent(ev));
    } catch (err: any) {
      console.error("[quota] replay failed:", err?.message);
    }
  }

  /** Live event from the stats finish-middleware. */
  record(ev: StatsEvent): void {
    this.rollIfNeeded();
    this.applyEvent(ev);
  }

  /** Month-to-date consumption for one API key (by sha256 hash). */
  consumed(apiKeyHash: string): Consumption {
    this.rollIfNeeded();
    return this.byKey.get(apiKeyHash) ?? { tokens: 0, costUsd: 0 };
  }

  /** Drop accumulated counts when the wall clock crosses into a new month. */
  private rollIfNeeded(): void {
    const mk = monthKeyOf(new Date());
    if (mk !== this.monthKey) {
      this.monthKey = mk;
      this.byKey.clear();
    }
  }

  /**
   * Fold one event into the aggregate, but only if it falls in the tracked
   * month — replayed history from prior months is ignored, and so are events
   * with no usage (failures, disconnects before any token was produced).
   */
  private applyEvent(ev: StatsEvent): void {
    if (monthKeyOf(new Date(ev.ts)) !== this.monthKey) return;
    if (!ev.usage) return;
    const provider = (ev.provider ?? undefined) as ProviderId | undefined;
    const tokens = billableTokens(ev.usage, provider);
    const cost = ev.model
      ? computeCost(ev.model, ev.usage, provider, this.overrides)
      : 0;
    const cur = this.byKey.get(ev.apiKeyHash) ?? { tokens: 0, costUsd: 0 };
    cur.tokens += tokens;
    cur.costUsd += cost;
    this.byKey.set(ev.apiKeyHash, cur);
  }
}
