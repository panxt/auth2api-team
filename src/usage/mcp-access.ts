import type { ApiKeyEntry } from "../config";

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
