import { test } from "node:test";
import assert from "node:assert";
import { computeCost, resolvePrice } from "../src/usage/pricing";
import { UsageData } from "../src/accounts/manager";

function usage(partial: Partial<UsageData>): UsageData {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    reasoningOutputTokens: 0,
    ...partial,
  };
}

// ── Anthropic: input / cache-write / cache-read are independent buckets ──

test("computeCost: anthropic sums independent token buckets", () => {
  // claude-sonnet-4-6: in 3, out 15, cacheWrite 3.75, cacheRead 0.3 ($/MTok)
  const u = usage({
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreationInputTokens: 1_000_000,
    cacheReadInputTokens: 1_000_000,
  });
  const cost = computeCost("claude-sonnet-4-6", u, "anthropic");
  // 3 + 15 + 3.75 + 0.3 = 22.05
  assert.ok(Math.abs(cost - 22.05) < 1e-9, `got ${cost}`);
});

test("computeCost: resolves anthropic aliases (sonnet → claude-sonnet-4-6)", () => {
  const u = usage({ inputTokens: 1_000_000 });
  assert.equal(
    computeCost("sonnet", u, "anthropic"),
    computeCost("claude-sonnet-4-6", u, "anthropic"),
  );
});

// ── Codex/OpenAI: reasoning ⊂ output, cached ⊂ input (no double counting) ──

test("computeCost: codex does NOT double-count reasoning (already in output)", () => {
  const withReasoning = usage({
    outputTokens: 1_000_000,
    reasoningOutputTokens: 400_000,
  });
  const withoutReasoning = usage({ outputTokens: 1_000_000 });
  // reasoningOutputTokens is informational; cost depends only on outputTokens
  assert.equal(
    computeCost("gpt-5.5", withReasoning, "codex"),
    computeCost("gpt-5.5", withoutReasoning, "codex"),
  );
});

test("computeCost: codex treats cached tokens as a discounted subset of input", () => {
  const p = resolvePrice("gpt-5.5", "codex")!;
  // 1M input of which 250k are cache reads
  const u = usage({ inputTokens: 1_000_000, cacheReadInputTokens: 250_000 });
  const expected =
    (750_000 / 1_000_000) * p.inputPerMTok +
    (250_000 / 1_000_000) * p.cacheReadPerMTok;
  assert.ok(
    Math.abs(computeCost("gpt-5.5", u, "codex") - expected) < 1e-9,
    `got ${computeCost("gpt-5.5", u, "codex")}, expected ${expected}`,
  );
});

// ── Unknown model / provider → 0 (caller may warn) ──

test("computeCost: unknown model returns 0", () => {
  assert.equal(computeCost("totally-made-up-model", usage({ inputTokens: 1e6 }), "anthropic"), 0);
});

test("computeCost: cursor (experimental, unpriced) returns 0", () => {
  assert.equal(computeCost("some-cursor-model", usage({ inputTokens: 1e6 }), "cursor"), 0);
});

// ── Config overrides win over defaults ──

test("computeCost: override table replaces default price", () => {
  const overrides = {
    "claude-sonnet-4-6": {
      inputPerMTok: 1,
      outputPerMTok: 1,
      cacheWritePerMTok: 1,
      cacheReadPerMTok: 1,
    },
  };
  const u = usage({ inputTokens: 1_000_000 });
  assert.equal(computeCost("claude-sonnet-4-6", u, "anthropic", overrides), 1);
});
