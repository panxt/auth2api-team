import type { ApiKeyEntry } from "../config";
import type { QuotaTracker } from "./quota";

/**
 * MCP authorization — **default-deny**, with optional per-tool granularity.
 *
 * A key's `allowed-mcp` is a list of grants; each entry is either:
 *   - a whole category:   "gitlab"                    → all tools/prompts/resources
 *   - a specific tool:     "gitlab__search_repos"      → only that tool
 *
 * Unset / empty ⇒ no access to any MCP. Whole-category grant implies every
 * tool of that category; a tool-scoped grant exposes only the named tools (and
 * does NOT expose that category's prompts/resources).
 */

function grants(entry: ApiKeyEntry | undefined): string[] {
  return entry?.["allowed-mcp"] ?? [];
}

/** Server ids to connect/fan-out for this key (has any grant, whole or tool). */
export function mcpFanoutServerIds(
  entry: ApiKeyEntry | undefined,
  enabledIds: string[],
): string[] {
  const allow = grants(entry);
  if (allow.length === 0) return [];
  const whole = new Set(allow);
  return enabledIds.filter(
    (id) => whole.has(id) || allow.some((a) => a.startsWith(`${id}__`)),
  );
}

/** May this key call/see a specific tool of a category? */
export function isMcpToolAllowed(
  entry: ApiKeyEntry | undefined,
  serverId: string,
  tool: string,
): boolean {
  const allow = grants(entry);
  if (allow.length === 0) return false;
  return allow.includes(serverId) || allow.includes(`${serverId}__${tool}`);
}

/** Whole-category grant? (gates prompts/resources, which are category-scoped). */
export function isMcpServerFull(
  entry: ApiKeyEntry | undefined,
  serverId: string,
): boolean {
  return grants(entry).includes(serverId);
}

/**
 * MCP call-count quota check. Returns a human error string if calling a tool of
 * `serverId` now would exceed a cap (per-server first, then overall), else null.
 * Uses the CURRENT counts (before this call), so caps are inclusive: at count
 * == cap the next call is refused. Unset caps = unlimited.
 */
export function mcpQuotaError(
  entry: ApiKeyEntry | undefined,
  serverId: string,
  apiKeyHash: string,
  tracker: QuotaTracker | undefined,
): string | null {
  const q = entry?.["mcp-quota"];
  if (!q || !tracker) return null;
  const ps = q["per-server"]?.[serverId];
  const checks: Array<{ cap?: number; window: "day" | "month"; server?: string; label: string }> = [
    { cap: ps?.daily, window: "day", server: serverId, label: `${serverId} 日调用` },
    { cap: ps?.monthly, window: "month", server: serverId, label: `${serverId} 月调用` },
    { cap: q["daily-calls"], window: "day", label: "MCP 日调用总量" },
    { cap: q["monthly-calls"], window: "month", label: "MCP 月调用总量" },
  ];
  for (const c of checks) {
    if (c.cap == null) continue;
    const used = tracker.mcpCallCount(apiKeyHash, c.window, c.server);
    if (used >= c.cap) return `${c.label}配额已用尽 (${used}/${c.cap})`;
  }
  return null;
}
