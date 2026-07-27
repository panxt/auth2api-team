import type { StatsEvent } from "../stats/recorder";
import type { ApiKeyEntry } from "../config";

/**
 * Append-only log of per-request usage events. Both the stats aggregator and
 * the quota tracker rebuild their in-memory state by replaying this on
 * startup, then append live events to it.
 */
export interface EventLog {
  /** Persist one event durably. */
  append(event: StatsEvent): void;
  /** Replay every persisted event (insertion order) into `apply`. */
  replay(apply: (event: StatsEvent) => void): { events: number; skipped: number };
  /** Flush and release handles. */
  close(): Promise<void>;
}

/**
 * Persistence for UI-managed API keys. The full set is replaced on each
 * change (the set is tiny — a handful of keys), mirroring the JSONL-era
 * managed-keys.json semantics.
 */
export interface KeyRepository {
  loadAll(): ApiKeyEntry[];
  replaceAll(entries: ApiKeyEntry[]): void;
}

/**
 * One persisted per-request log record (for failure diagnosis). Stored
 * separately from the usage EventLog so retention can be pruned freely.
 * `errorDetail`/`requestId` are optional and governed by LoggingConfig.
 */
/**
 * Where a failure originated — lets the dashboard separate real problems from
 * benign noise:
 *   - "upstream": the model/provider returned an error (Anthropic/Codex 4xx/5xx).
 *   - "service": auth2api's own fault (no account, handler threw, our 5xx).
 *   - "policy":  a deliberate rejection (quota, model allow/deny, per-key rate).
 *   - "client":  client side (disconnect, bad request).
 *   - "ok":      success (only logged when capture=all).
 *   - "mcp":     MCP gateway tool call (audit trail; always logged when enabled).
 */
export type LogCategory =
  | "upstream"
  | "service"
  | "policy"
  | "client"
  | "ok"
  | "mcp";

export interface RequestLogRecord {
  ts: string; // ISO8601 UTC
  apiKeyHash: string; // full hash; redacted to a prefix at the API layer
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

/** Filter + pagination for a request-log query. Newest-first. */
export interface RequestLogFilter {
  limit: number; // capped by the caller
  cursor?: number | null; // return rows strictly older than this opaque cursor
  status?: "success" | "failure";
  category?: LogCategory;
  apiKeyPrefix?: string;
  /** Restrict to these full api-key hashes (used to resolve a name search to
   *  the keys that match). An empty array matches nothing. */
  apiKeyHashes?: string[];
  email?: string;
  model?: string;
  endpoint?: string;
  provider?: string;
  since?: string; // ts >= since
  until?: string; // ts <= until
  q?: string; // case-insensitive substring of errorDetail
}

export interface RequestLogPage {
  rows: (RequestLogRecord & { id: number })[];
  nextCursor: number | null; // pass back as `cursor` to load older rows
}

/** Pluggable store for the per-request log (sqlite indexed / file rolling). */
export interface RequestLogStore {
  append(rec: RequestLogRecord): void;
  query(filter: RequestLogFilter): RequestLogPage;
  /** Delete by age and/or row cap; returns number of records removed. */
  prune(opts: { maxAgeDays?: number; maxRows?: number }): number;
}

/** Tiny key→JSON settings store for runtime-editable config (logging, …). */
export interface SettingsStore {
  get<T = unknown>(key: string): T | null;
  set(key: string, value: unknown): void;
}

/**
 * One persisted window-prewarm run (scheduled or manual). Stored separately
 * from request logs so its retention is independent and it survives restarts.
 * `providers` is the opaque per-provider result payload (PrewarmResult[]).
 */
export interface PrewarmRunRecord {
  at: string; // ISO8601 UTC — when the run actually fired
  trigger: "schedule" | "manual";
  /** For scheduled runs: the configured "HH:MM" plan this run satisfies.
   *  null for manual runs. Lets the dashboard audit on-time vs missed. */
  scheduledTime: string | null;
  ok: number;
  total: number;
  providers: unknown;
}

export interface PrewarmRunPage {
  rows: (PrewarmRunRecord & { id: number })[];
  nextCursor: number | null; // pass back as `cursor` to load older rows
}

/** Append-only, newest-first store for prewarm run history. */
export interface PrewarmRunStore {
  append(rec: PrewarmRunRecord): void;
  list(opts: { limit: number; cursor?: number | null }): PrewarmRunPage;
  /** Keep only the newest `maxRows`; returns rows removed. */
  prune(opts: { maxRows?: number }): number;
}

/** A selected storage backend: the repositories plus a shared close(). */
export interface Storage {
  eventLog: EventLog;
  keyRepo: KeyRepository;
  requestLog: RequestLogStore;
  prewarmLog: PrewarmRunStore;
  settings: SettingsStore;
  close(): Promise<void>;
}

/** Defensive normalization of a stored key row into an ApiKeyEntry. */
export function normalizeKeyEntry(v: any): ApiKeyEntry | null {
  if (!v || typeof v.key !== "string") return null;
  return {
    key: v.key,
    label: v.label,
    owner: v.owner,
    enabled: v.enabled ?? true,
    admin: v.role ? v.role === "admin" : (v.admin ?? false),
    role: v.role,
    quota: v.quota,
    "rate-limit": v["rate-limit"],
    // These must round-trip too — otherwise UI-set model allow/deny lists are
    // silently dropped when managed keys are reloaded from disk on restart.
    "allowed-models": v["allowed-models"],
    "denied-models": v["denied-models"],
    "allowed-mcp": v["allowed-mcp"],
    "expires-at": v["expires-at"],
    "mcp-quota": v["mcp-quota"],
    "daily-override": v["daily-override"],
  };
}
