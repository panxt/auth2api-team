import { UsageData } from "../accounts/manager";
import { ProviderId } from "../auth/types";
import { resolveModel } from "../upstream/translator";

/**
 * Per-model price in USD per 1,000,000 tokens. Cost accounting only — these
 * figures drive the internal usage reports and monthly quotas, not any real
 * payment. Override any entry via config.yaml `pricing:`.
 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Anthropic prompt-cache write. Unused by codex/cursor (no cache-write analog). */
  cacheWritePerMTok: number;
  /** Anthropic cache read, or OpenAI cached-input discounted rate. */
  cacheReadPerMTok: number;
}

const M = 1_000_000;

/**
 * Default prices, keyed by resolved (alias-expanded) model id.
 *
 * Anthropic figures track published Claude API rates; cache-write = 1.25x
 * input and cache-read = 0.1x input (Anthropic 5-minute cache).
 *
 * ⚠️ Codex (gpt-*) figures are ESTIMATES — the ChatGPT-account backend does
 * not publish per-token rates. Verify against your own billing and override
 * in config.yaml `pricing:` before trusting cost reports for these models.
 * Cursor is intentionally absent (experimental, unpriced → cost 0).
 */
export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  "claude-opus-4-7": {
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheWritePerMTok: 18.75,
    cacheReadPerMTok: 1.5,
  },
  "claude-opus-4-6": {
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheWritePerMTok: 18.75,
    cacheReadPerMTok: 1.5,
  },
  "claude-sonnet-4-6": {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheWritePerMTok: 3.75,
    cacheReadPerMTok: 0.3,
  },
  "claude-haiku-4-5-20251001": {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheWritePerMTok: 1.25,
    cacheReadPerMTok: 0.1,
  },
  // Codex estimates — override in config for accuracy.
  "gpt-5.5": {
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cacheWritePerMTok: 0,
    cacheReadPerMTok: 0.125,
  },
  "gpt-5.4": {
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cacheWritePerMTok: 0,
    cacheReadPerMTok: 0.125,
  },
  "gpt-5.4-mini": {
    inputPerMTok: 0.25,
    outputPerMTok: 2,
    cacheWritePerMTok: 0,
    cacheReadPerMTok: 0.025,
  },
  "gpt-5.3-codex": {
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cacheWritePerMTok: 0,
    cacheReadPerMTok: 0.125,
  },
  "gpt-5.2": {
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cacheWritePerMTok: 0,
    cacheReadPerMTok: 0.125,
  },
};

/**
 * Resolve a model's price. Order: explicit override → default table (after
 * alias expansion) → codex family fallback (any unknown `gpt-*` borrows a
 * gpt-5 rate, `*mini*` the mini rate). Returns null when nothing matches, so
 * callers can decide to warn rather than silently bill 0.
 */
export function resolvePrice(
  model: string,
  provider?: ProviderId,
  overrides?: Record<string, ModelPrice>,
): ModelPrice | null {
  const resolved = resolveModel(model);
  if (overrides?.[resolved]) return overrides[resolved];
  if (overrides?.[model]) return overrides[model];
  if (DEFAULT_PRICING[resolved]) return DEFAULT_PRICING[resolved];

  // Family fallback for codex gpt-* models not individually listed.
  if (provider === "codex" || resolved.startsWith("gpt-")) {
    if (resolved.includes("mini")) return DEFAULT_PRICING["gpt-5.4-mini"];
    if (resolved.startsWith("gpt-5")) return DEFAULT_PRICING["gpt-5.5"];
  }
  return null;
}

/**
 * Cost in USD for one request's token usage. The formula differs by provider
 * because the upstreams report tokens differently:
 *
 *  - Anthropic: input_tokens, cache_creation, cache_read are mutually
 *    exclusive buckets → sum each at its own rate.
 *  - Codex/OpenAI: input_tokens already INCLUDES cached input, and
 *    output_tokens already INCLUDES reasoning tokens. So we bill the
 *    non-cached input at the input rate, the cached subset at the cache-read
 *    rate, and the full output at the output rate. reasoningOutputTokens is
 *    informational only and is NOT added separately.
 *
 * Unknown model/provider → 0.
 */
export function computeCost(
  model: string,
  usage: UsageData,
  provider?: ProviderId,
  overrides?: Record<string, ModelPrice>,
): number {
  const p = resolvePrice(model, provider, overrides);
  if (!p) return 0;

  if (provider === "codex") {
    const cached = Math.min(usage.cacheReadInputTokens, usage.inputTokens);
    const nonCachedInput = usage.inputTokens - cached;
    return (
      (nonCachedInput / M) * p.inputPerMTok +
      (cached / M) * p.cacheReadPerMTok +
      (usage.outputTokens / M) * p.outputPerMTok
    );
  }

  // Anthropic (and default): independent buckets.
  return (
    (usage.inputTokens / M) * p.inputPerMTok +
    (usage.outputTokens / M) * p.outputPerMTok +
    (usage.cacheCreationInputTokens / M) * p.cacheWritePerMTok +
    (usage.cacheReadInputTokens / M) * p.cacheReadPerMTok
  );
}
