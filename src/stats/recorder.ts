import { ProviderId } from "../auth/types";
import { UsageData } from "../accounts/manager";
import type { EventLog } from "../storage/types";

/**
 * One row in the JSONL stats log. Keep field names short — the file grows
 * one line per request and disk space matters more than self-documentation
 * here. `version` lets us evolve the schema without a manual migration:
 * loaders are free to skip lines whose version they don't understand.
 */
export interface StatsEvent {
  v: 1;
  ts: string;
  apiKeyHash: string;
  ip: string;
  ua: string;
  endpoint: string;
  model: string | null;
  provider: ProviderId | null;
  accountEmail: string | null;
  status: "success" | "failure";
  failureKind: string | null;
  statusCode: number;
  latencyMs: number;
  usage: UsageData | null;
}

interface BaseBucket {
  requests: number;
  successes: number;
  failures: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  totalReasoningOutputTokens: number;
  /** Accrued cost in USD, computed per-event via the injected cost function. */
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
  provider: ProviderId;
  email: string;
}

export interface ApiBucket extends BaseBucket {
  endpoint: string;
  model: string;
  provider: ProviderId | null;
}

/** Cross-axis: one bucket per (client, model). Powers the per-user × per-model
 *  cost/token breakdown. apiKeyShort lets the UI join a human label. */
export interface ClientModelBucket extends BaseBucket {
  apiKeyShort: string;
  model: string;
  provider: ProviderId | null;
}

/** Time window for a snapshot. "all" = cumulative since recorder start;
 *  "today"/"month" = rolled up from per-day facts (UTC); "range" = an explicit
 *  [from,to] date range (see getSnapshotRange). */
export type StatsWindow = "today" | "month" | "all" | "range";

export interface StatsSnapshot {
  byClient: Record<string, ClientBucket>;
  byAccount: Record<string, AccountBucket>;
  byApi: Record<string, ApiBucket>;
  byClientModel: Record<string, ClientModelBucket>;
  totals: BaseBucket;
  /** Echoes the window this snapshot was computed for. */
  window: StatsWindow;
}

function emptyBucket(now: string): BaseBucket {
  return {
    requests: 0,
    successes: 0,
    failures: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationInputTokens: 0,
    totalCacheReadInputTokens: 0,
    totalReasoningOutputTokens: 0,
    totalCostUsd: 0,
    totalLatencyMs: 0,
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

function applyBaseDelta(b: BaseBucket, ev: StatsEvent, costUsd: number): void {
  if (b.requests === 0) {
    b.firstSeenAt = ev.ts;
  }
  b.requests++;
  if (ev.status === "success") b.successes++;
  else b.failures++;
  b.totalLatencyMs += ev.latencyMs;
  b.totalCostUsd += costUsd;
  if (ev.usage) {
    b.totalInputTokens += ev.usage.inputTokens;
    b.totalOutputTokens += ev.usage.outputTokens;
    b.totalCacheCreationInputTokens += ev.usage.cacheCreationInputTokens;
    b.totalCacheReadInputTokens += ev.usage.cacheReadInputTokens;
    b.totalReasoningOutputTokens += ev.usage.reasoningOutputTokens;
  }
  b.lastSeenAt = ev.ts;
}

/** Fold one BaseBucket's totals into another (for windowed roll-ups). Keeps
 *  the earliest firstSeenAt / latest lastSeenAt across the merged sources. */
function mergeBase(target: BaseBucket, src: BaseBucket): void {
  if (target.requests === 0 || src.firstSeenAt < target.firstSeenAt) {
    target.firstSeenAt = src.firstSeenAt;
  }
  target.requests += src.requests;
  target.successes += src.successes;
  target.failures += src.failures;
  target.totalInputTokens += src.totalInputTokens;
  target.totalOutputTokens += src.totalOutputTokens;
  target.totalCacheCreationInputTokens += src.totalCacheCreationInputTokens;
  target.totalCacheReadInputTokens += src.totalCacheReadInputTokens;
  target.totalReasoningOutputTokens += src.totalReasoningOutputTokens;
  target.totalCostUsd += src.totalCostUsd;
  target.totalLatencyMs += src.totalLatencyMs;
  if (src.lastSeenAt > target.lastSeenAt) target.lastSeenAt = src.lastSeenAt;
}

/**
 * Three independent aggregate views — keyed by client (API key hash),
 * upstream account (provider + email), and API surface (endpoint + model
 * + provider). Each request increments exactly one bucket per view, so
 * memory usage is O(unique clients + unique accounts + unique
 * endpoint*model). No cross-products.
 */
/** Per-day bucket for the dashboard time-series. Updated on every event. */
export interface DailyBucket {
  /** UTC date in YYYY-MM-DD form. */
  date: string;
  requests: number;
  totalTokens: number;
  totalCostUsd: number;
  /** Sub-totals by provider for the stacked area chart. */
  byProvider: Record<
    string,
    { requests: number; totalTokens: number; totalCostUsd: number }
  >;
}

/**
 * Fine-grained per-day fact bucket — the single source that windowed
 * snapshots (today / month) roll up from. One bucket per
 * (date, client, endpoint, model, provider, account-email) tuple seen that
 * day. byClient / byApi / byClientModel / byAccount / totals for any window
 * are all derivable from these, guaranteeing the windowed views stay
 * mutually consistent.
 *
 * Cardinality assumption: this is an internal small-team tool (≤ dozens of
 * keys). Buckets older than DAY_FACT_RETENTION are pruned so memory stays
 * bounded; large multi-tenant deployments should move this to a SQL
 * GROUP BY instead.
 */
interface DayFactBucket extends BaseBucket {
  date: string;
  apiKeyHash: string;
  apiKeyShort: string;
  endpoint: string;
  model: string;
  provider: ProviderId | null;
  accountEmail: string | null;
  lastIp: string;
  lastUa: string;
}

/** Keep this many days of per-day facts in memory. Covers "today" + "month"
 *  plus custom ranges up to ~4 months back; older ranges fall back to partial
 *  data (the time-series line chart, backed by the unbounded `daily` map,
 *  still covers older history). */
const DAY_FACT_RETENTION = 120;

export class StatsRecorder {
  private byClient = new Map<string, ClientBucket>();
  private byAccount = new Map<string, AccountBucket>();
  private byApi = new Map<string, ApiBucket>();
  private byClientModel = new Map<string, ClientModelBucket>();
  private daily = new Map<string, DailyBucket>();
  /** Fine-grained per-day facts, key = date|hash|endpoint|model|provider|email. */
  private dayFacts = new Map<string, DayFactBucket>();
  /** Tracks the most recent date inserted so we only prune on date rollover. */
  private latestFactDate = "";
  private totals: BaseBucket = emptyBucket(new Date().toISOString());

  private log: EventLog | null = null;
  private enabled = false;
  private costFn: (ev: StatsEvent) => number;

  /**
   * @param costFn optional per-event cost (USD). Injected so the recorder
   * stays independent of pricing/config; defaults to 0 (cost columns will be
   * zero). Applied on both live records and replay, so a price change is
   * reflected retroactively the next time history is replayed.
   */
  constructor(costFn?: (ev: StatsEvent) => number) {
    this.costFn = costFn ?? (() => 0);
  }

  /**
   * Replay persisted events into the in-memory aggregate, then keep the log
   * for live appends. Replay errors are non-fatal — we'd rather start fresh
   * than fail to boot. The log's lifecycle (flush/close) is owned by the
   * caller's Storage, not by the recorder.
   */
  start(log: EventLog): void {
    this.log = log;
    try {
      const result = log.replay((ev) => this.applyEvent(ev));
      if (result.events > 0) {
        console.log(
          `[stats] replayed ${result.events} event(s) (${result.skipped} skipped)`,
        );
      }
    } catch (err: any) {
      console.error("[stats] replay failed:", err?.message);
    }
    this.enabled = true;
  }

  /** Stop recording. Does not close the log — Storage owns that. */
  async stop(): Promise<void> {
    this.enabled = false;
    this.log = null;
  }

  /**
   * Hot path called from the response-finish middleware. Aggregate first
   * (synchronous, cheap), then enqueue an append on the write stream so
   * the request response isn't blocked on fsync.
   */
  record(input: Omit<StatsEvent, "v" | "ts">): StatsEvent {
    const event: StatsEvent = {
      v: 1,
      ts: new Date().toISOString(),
      ...input,
    };
    if (!this.enabled) return event;
    this.applyEvent(event);
    if (this.log) {
      try {
        this.log.append(event);
      } catch (err: any) {
        console.error("[stats] append failed:", err?.message);
      }
    }
    return event;
  }

  /**
   * Aggregate snapshot for a time window.
   *   - "all"   → cumulative since recorder start (cheap; returns live maps).
   *   - "month" → current UTC calendar month, rolled up from per-day facts.
   *   - "today" → current UTC day, rolled up from per-day facts.
   * All windowed axes (byClient/byApi/byClientModel/byAccount/totals) are
   * derived from the same dayFacts source so they never disagree.
   */
  getSnapshot(window: StatsWindow = "all"): StatsSnapshot {
    if (window === "all") {
      return {
        byClient: Object.fromEntries(this.byClient),
        byAccount: Object.fromEntries(this.byAccount),
        byApi: Object.fromEntries(this.byApi),
        byClientModel: Object.fromEntries(this.byClientModel),
        totals: { ...this.totals },
        window,
      };
    }
    const now = new Date();
    const prefix =
      window === "today"
        ? now.toISOString().slice(0, 10) // YYYY-MM-DD
        : now.toISOString().slice(0, 7); // YYYY-MM
    return this.rollup((date) => date.startsWith(prefix), window);
  }

  /**
   * Snapshot for an explicit UTC date range [from, to] (inclusive,
   * YYYY-MM-DD). Rolled up from per-day facts, so it's bounded by
   * DAY_FACT_RETENTION — ranges older than that return partial/empty data
   * (the time-series line chart, backed by the unbounded `daily` map, still
   * covers older history).
   */
  getSnapshotRange(from: string, to: string): StatsSnapshot {
    return this.rollup((date) => date >= from && date <= to, "range");
  }

  /** Roll up byClient/byApi/byClientModel/byAccount/totals from the per-day
   *  facts whose date matches `inWindow`. */
  private rollup(
    inWindow: (date: string) => boolean,
    window: StatsWindow,
  ): StatsSnapshot {
    const nowIso = new Date().toISOString();
    const byClient = new Map<string, ClientBucket>();
    const byApi = new Map<string, ApiBucket>();
    const byClientModel = new Map<string, ClientModelBucket>();
    const byAccount = new Map<string, AccountBucket>();
    const totals = emptyBucket(nowIso);

    for (const f of this.dayFacts.values()) {
      if (!inWindow(f.date)) continue;
      mergeBase(totals, f);

      let cb = byClient.get(f.apiKeyHash);
      if (!cb) {
        cb = { ...emptyBucket(f.firstSeenAt), apiKeyShort: f.apiKeyShort, lastIp: f.lastIp, lastUa: f.lastUa };
        byClient.set(f.apiKeyHash, cb);
      }
      mergeBase(cb, f);
      cb.lastIp = f.lastIp || cb.lastIp;
      cb.lastUa = f.lastUa || cb.lastUa;

      const apiKey = `${f.endpoint}|${f.model}|${f.provider ?? "unknown"}`;
      let pb = byApi.get(apiKey);
      if (!pb) {
        pb = { ...emptyBucket(f.firstSeenAt), endpoint: f.endpoint, model: f.model, provider: f.provider };
        byApi.set(apiKey, pb);
      }
      mergeBase(pb, f);

      const cmKey = `${f.apiKeyHash}|${f.model}`;
      let cm = byClientModel.get(cmKey);
      if (!cm) {
        cm = { ...emptyBucket(f.firstSeenAt), apiKeyShort: f.apiKeyShort, model: f.model, provider: f.provider };
        byClientModel.set(cmKey, cm);
      }
      mergeBase(cm, f);

      if (f.provider && f.accountEmail) {
        const accKey = `${f.provider}:${f.accountEmail}`;
        let ab = byAccount.get(accKey);
        if (!ab) {
          ab = { ...emptyBucket(f.firstSeenAt), provider: f.provider, email: f.accountEmail };
          byAccount.set(accKey, ab);
        }
        mergeBase(ab, f);
      }
    }

    return {
      byClient: Object.fromEntries(byClient),
      byAccount: Object.fromEntries(byAccount),
      byApi: Object.fromEntries(byApi),
      byClientModel: Object.fromEntries(byClientModel),
      totals,
      window,
    };
  }

  /** Drop per-day facts older than DAY_FACT_RETENTION days (UTC). */
  private pruneDayFacts(): void {
    if (!this.latestFactDate) return;
    const cutoff = new Date(`${this.latestFactDate}T00:00:00Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - (DAY_FACT_RETENTION - 1));
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    for (const [k, f] of this.dayFacts) {
      if (f.date < cutoffStr) this.dayFacts.delete(k);
    }
  }

  /** Reset all in-memory aggregates. Doesn't touch the JSONL on disk. */
  reset(): void {
    this.byClient.clear();
    this.byAccount.clear();
    this.byApi.clear();
    this.byClientModel.clear();
    this.dayFacts.clear();
    this.latestFactDate = "";
    this.daily.clear();
    this.totals = emptyBucket(new Date().toISOString());
  }

  /** Test/replay-only entry point — does NOT touch the disk. */
  applyEvent(ev: StatsEvent): void {
    const cost = this.costFn(ev);
    applyBaseDelta(this.totals, ev, cost);

    const clientKey = ev.apiKeyHash;
    let cb = this.byClient.get(clientKey);
    if (!cb) {
      cb = {
        ...emptyBucket(ev.ts),
        apiKeyShort: ev.apiKeyHash.slice(0, 12),
        lastIp: ev.ip,
        lastUa: ev.ua,
      };
      this.byClient.set(clientKey, cb);
    }
    cb.lastIp = ev.ip || cb.lastIp;
    cb.lastUa = ev.ua || cb.lastUa;
    applyBaseDelta(cb, ev, cost);

    if (ev.provider && ev.accountEmail) {
      const accKey = `${ev.provider}:${ev.accountEmail}`;
      let ab = this.byAccount.get(accKey);
      if (!ab) {
        ab = {
          ...emptyBucket(ev.ts),
          provider: ev.provider,
          email: ev.accountEmail,
        };
        this.byAccount.set(accKey, ab);
      }
      applyBaseDelta(ab, ev, cost);
    }

    const apiModel = ev.model || "unknown";
    const apiProvider = ev.provider || null;
    const apiKey = `${ev.endpoint}|${apiModel}|${apiProvider ?? "unknown"}`;
    let pb = this.byApi.get(apiKey);
    if (!pb) {
      pb = {
        ...emptyBucket(ev.ts),
        endpoint: ev.endpoint,
        model: apiModel,
        provider: apiProvider,
      };
      this.byApi.set(apiKey, pb);
    }
    applyBaseDelta(pb, ev, cost);

    // Cumulative client × model cross-axis (powers per-user/per-model
    // breakdown for the "all" window; windowed views roll up from dayFacts).
    const cmKey = `${clientKey}|${apiModel}`;
    let cm = this.byClientModel.get(cmKey);
    if (!cm) {
      cm = {
        ...emptyBucket(ev.ts),
        apiKeyShort: ev.apiKeyHash.slice(0, 12),
        model: apiModel,
        provider: apiProvider,
      };
      this.byClientModel.set(cmKey, cm);
    }
    applyBaseDelta(cm, ev, cost);

    // Fine-grained per-day fact — the single source windowed snapshots roll
    // up from. Pruned to DAY_FACT_RETENTION days on date rollover.
    const factDate = ev.ts.slice(0, 10);
    const factKey = `${factDate}|${clientKey}|${ev.endpoint}|${apiModel}|${apiProvider ?? "unknown"}|${ev.accountEmail ?? ""}`;
    let fb = this.dayFacts.get(factKey);
    if (!fb) {
      fb = {
        ...emptyBucket(ev.ts),
        date: factDate,
        apiKeyHash: clientKey,
        apiKeyShort: ev.apiKeyHash.slice(0, 12),
        endpoint: ev.endpoint,
        model: apiModel,
        provider: apiProvider,
        accountEmail: ev.accountEmail,
        lastIp: ev.ip,
        lastUa: ev.ua,
      };
      this.dayFacts.set(factKey, fb);
    }
    fb.lastIp = ev.ip || fb.lastIp;
    fb.lastUa = ev.ua || fb.lastUa;
    applyBaseDelta(fb, ev, cost);
    if (factDate > this.latestFactDate) {
      this.latestFactDate = factDate;
      this.pruneDayFacts();
    }

    // Daily bucket for the dashboard time-series — UTC YYYY-MM-DD prefix
    // of the event timestamp. Capped via getTimeseries(days), so unbounded
    // memory is only a concern if someone keeps the server up for years.
    const date = ev.ts.slice(0, 10);
    let db = this.daily.get(date);
    if (!db) {
      db = {
        date,
        requests: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        byProvider: {},
      };
      this.daily.set(date, db);
    }
    const tokens =
      (ev.usage?.inputTokens ?? 0) +
      (ev.usage?.outputTokens ?? 0) +
      (ev.usage?.cacheCreationInputTokens ?? 0) +
      (ev.usage?.cacheReadInputTokens ?? 0) +
      (ev.usage?.reasoningOutputTokens ?? 0);
    db.requests += 1;
    db.totalTokens += tokens;
    db.totalCostUsd += cost;
    const p = ev.provider ?? "unknown";
    let pp = db.byProvider[p];
    if (!pp) {
      pp = { requests: 0, totalTokens: 0, totalCostUsd: 0 };
      db.byProvider[p] = pp;
    }
    pp.requests += 1;
    pp.totalTokens += tokens;
    pp.totalCostUsd += cost;
  }

  /**
   * Last `days` calendar days of activity, oldest → newest. Buckets with
   * zero events are NOT padded — callers fill gaps client-side if they
   * want a continuous x-axis.
   */
  getTimeseries(days: number): DailyBucket[] {
    if (days <= 0) return [];
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
    cutoff.setUTCHours(0, 0, 0, 0);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return Array.from(this.daily.values())
      .filter((b) => b.date >= cutoffStr)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Daily buckets within an explicit UTC date range [from, to] (inclusive,
   * YYYY-MM-DD), oldest → newest. Backed by the unbounded `daily` map, so it
   * covers history beyond the per-day-fact retention window.
   */
  getTimeseriesRange(from: string, to: string): DailyBucket[] {
    return Array.from(this.daily.values())
      .filter((b) => b.date >= from && b.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date));
  }
}

/**
 * Helpers for handlers to attach upstream-specific context to the per-
 * request stats slot on `res.locals`. The server's finish-middleware
 * reads these at response time. Both helpers no-op if stats is disabled
 * (res.locals.stats unset), so handlers don't need to branch on config.
 */
type ResLike = { locals: { stats?: any } };

export function tagStatsModel(
  res: ResLike,
  model: string,
  provider: ProviderId,
): void {
  if (!res.locals.stats) return;
  res.locals.stats.model = model;
  res.locals.stats.provider = provider;
}

export function tagStatsUsage(res: ResLike, usage: UsageData): void {
  if (!res.locals.stats) return;
  res.locals.stats.usage = usage;
}

/** Record a human-readable upstream/rejection error for the request log. */
export function tagStatsError(res: ResLike, detail: string): void {
  if (!res.locals.stats) return;
  res.locals.stats.errorDetail = detail;
}

/** Record the upstream request_id (Anthropic/OpenAI) for support tickets. */
export function tagStatsRequestId(res: ResLike, requestId: string): void {
  if (!res.locals.stats) return;
  res.locals.stats.requestId = requestId;
}
