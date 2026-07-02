import type { ApiKeyEntry } from "../config";

/**
 * MCP category authorization — **default-deny**. A key may access an upstream
 * MCP server only if that server's id is explicitly listed in its `allowed-mcp`.
 * Unset / empty ⇒ no access to any MCP (opposite of allowed-models, because MCP
 * tools are frequently write-capable and warrant explicit grants).
 */
export function isMcpAllowed(
  entry: ApiKeyEntry | undefined,
  serverId: string,
): boolean {
  const allow = entry?.["allowed-mcp"];
  if (!allow || allow.length === 0) return false;
  return allow.includes(serverId);
}

/** The subset of `registeredIds` this key may use (intersection with grant). */
export function allowedMcpIds(
  entry: ApiKeyEntry | undefined,
  registeredIds: string[],
): string[] {
  const allow = entry?.["allowed-mcp"];
  if (!allow || allow.length === 0) return [];
  const set = new Set(allow);
  return registeredIds.filter((id) => set.has(id));
}
