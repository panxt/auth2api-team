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

/** A selected storage backend: the two repositories plus a shared close(). */
export interface Storage {
  eventLog: EventLog;
  keyRepo: KeyRepository;
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
    admin: v.admin ?? false,
    quota: v.quota,
    "rate-limit": v["rate-limit"],
  };
}
