/**
 * Namespacing for aggregated MCP tool/prompt names and resource URIs.
 * Qualified form is `<serverId>__<original>`. Server ids are guaranteed not to
 * contain "__" (enforced at registration), so the FIRST "__" splits the id off,
 * and the remainder (which may itself contain "__") is the original name/uri.
 */
const SEP = "__";

export function nsName(serverId: string, name: string): string {
  return `${serverId}${SEP}${name}`;
}

export function parseNs(
  qualified: string,
): { serverId: string; name: string } | null {
  const i = qualified.indexOf(SEP);
  if (i <= 0) return null;
  return { serverId: qualified.slice(0, i), name: qualified.slice(i + SEP.length) };
}
