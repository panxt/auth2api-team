import { ApiKeyEntry } from "../config";
import { resolveModel } from "../upstream/translator";

/**
 * Per-key model allowlist check.
 *
 * A key's `allowed-models` may list aliases ("opus") or canonical ids
 * ("claude-opus-4-8"); we resolve both sides through resolveModel() so the
 * comparison is alias-insensitive. An empty/omitted list means "all models
 * allowed" (the common case — most keys have no restriction).
 *
 * Returns true if `model` is permitted for `entry`. The caller is responsible
 * for turning a false into a 403 response.
 */
export function isModelAllowed(
  entry: ApiKeyEntry | undefined,
  model: string,
): boolean {
  const allow = entry?.["allowed-models"];
  if (!allow || allow.length === 0) return true;
  const resolved = resolveModel(model);
  return allow.some((m) => resolveModel(m) === resolved);
}
