/**
 * Per-API-key rate limiting, layered on top of the global per-IP limiter in
 * server.ts. Two independent controls: a requests-per-minute sliding window
 * and an in-flight concurrency cap. State is in-memory (single process) and
 * keyed by an opaque id the caller supplies (we use the sha256 api-key hash so
 * raw keys never enter these maps).
 */

const WINDOW_MS = 60 * 1000;

interface RpmEntry {
  count: number;
  resetAt: number;
}

const rpmMap = new Map<string, RpmEntry>();
const concurrencyMap = new Map<string, number>();

/**
 * Returns true if the request is within the key's per-minute budget (and
 * counts it). A fresh window opens lazily on the first request after reset.
 */
export function checkKeyRpm(keyId: string, rpm: number): boolean {
  const now = Date.now();
  const entry = rpmMap.get(keyId);
  if (!entry || now > entry.resetAt) {
    rpmMap.set(keyId, { count: 1, resetAt: now + WINDOW_MS });
    // Honor rpm:0 as "block everything" — the first request of a fresh window
    // must still respect the cap.
    return rpm >= 1;
  }
  entry.count++;
  return entry.count <= rpm;
}

/** Try to reserve a concurrency slot. Returns false if the key is at its cap. */
export function acquireConcurrency(keyId: string, max: number): boolean {
  const cur = concurrencyMap.get(keyId) ?? 0;
  if (cur >= max) return false;
  concurrencyMap.set(keyId, cur + 1);
  return true;
}

/** Release a previously acquired slot. Safe to call once per acquire. */
export function releaseConcurrency(keyId: string): void {
  const cur = concurrencyMap.get(keyId) ?? 0;
  if (cur <= 1) concurrencyMap.delete(keyId);
  else concurrencyMap.set(keyId, cur - 1);
}

/** Current in-flight count for a key (testing / introspection). */
export function currentConcurrency(keyId: string): number {
  return concurrencyMap.get(keyId) ?? 0;
}

/** Drop expired RPM windows so the map doesn't grow unbounded. */
export function cleanupRpm(now = Date.now()): void {
  for (const [id, entry] of rpmMap) {
    if (now > entry.resetAt) rpmMap.delete(id);
  }
}

/** Test-only reset of all in-memory state. */
export function _resetForTest(): void {
  rpmMap.clear();
  concurrencyMap.clear();
}
