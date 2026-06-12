import { ApiKeyEntry } from "../config";
import { resolveModel } from "../upstream/translator";

/**
 * Per-key model access check, combining an optional allowlist and denylist.
 * Both may list aliases ("opus") or canonical ids ("claude-opus-4-8"); we
 * resolve both sides through resolveModel() so matching is alias-insensitive.
 *
 * Rules:
 *   - denied-models takes precedence: if `model` is on it → false.
 *   - allowed-models, when non-empty, is a whitelist: `model` must be on it.
 *   - neither set → all models allowed (the common case).
 *
 * Returns true if `model` is permitted for `entry`. The caller turns a false
 * into a 403 response.
 */
export function isModelAllowed(
  entry: ApiKeyEntry | undefined,
  model: string,
): boolean {
  const allow = entry?.["allowed-models"];
  const deny = entry?.["denied-models"];
  const resolved = resolveModel(model);
  if (deny && deny.some((m) => resolveModel(m) === resolved)) return false;
  if (allow && allow.length > 0) {
    return allow.some((m) => resolveModel(m) === resolved);
  }
  return true;
}

/** True when a key has any model restriction configured (allow or deny). */
export function hasModelRestriction(entry: ApiKeyEntry | undefined): boolean {
  const allow = entry?.["allowed-models"];
  const deny = entry?.["denied-models"];
  return (!!allow && allow.length > 0) || (!!deny && deny.length > 0);
}
