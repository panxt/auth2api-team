import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QuotaTracker } from "../src/usage/quota";
import { StatsEvent } from "../src/stats/recorder";
import { computeCost } from "../src/usage/pricing";

function event(partial: Partial<StatsEvent>): StatsEvent {
  return {
    v: 1,
    ts: new Date().toISOString(),
    apiKeyHash: "hash-a",
    ip: "127.0.0.1",
    ua: "test",
    endpoint: "POST /v1/messages",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    accountEmail: "a@example.com",
    status: "success",
    failureKind: null,
    statusCode: 200,
    latencyMs: 10,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningOutputTokens: 0,
    },
    ...partial,
  };
}

test("QuotaTracker: accumulates tokens and cost per key for current month", () => {
  const q = new QuotaTracker();
  q.record(event({ apiKeyHash: "k1", usage: usage(1000, 500, 0, 0) }));
  q.record(event({ apiKeyHash: "k1", usage: usage(2000, 1000, 0, 0) }));
  q.record(event({ apiKeyHash: "k2", usage: usage(100, 50, 0, 0) }));

  const c1 = q.consumed("k1");
  // anthropic billable = input+output+cacheCreate+cacheRead
  assert.equal(c1.tokens, 1000 + 500 + 2000 + 1000);
  const expectedCost =
    computeCost("claude-sonnet-4-6", u(1000, 500), "anthropic") +
    computeCost("claude-sonnet-4-6", u(2000, 1000), "anthropic");
  assert.ok(Math.abs(c1.costUsd - expectedCost) < 1e-9);

  assert.equal(q.consumed("k2").tokens, 150);
});

test("QuotaTracker: ignores events from other calendar months", () => {
  const q = new QuotaTracker();
  q.record(event({ apiKeyHash: "k1", ts: "2020-01-15T00:00:00.000Z", usage: usage(9999, 0, 0, 0) }));
  q.record(event({ apiKeyHash: "k1", usage: usage(10, 0, 0, 0) }));
  assert.equal(q.consumed("k1").tokens, 10);
});

test("QuotaTracker: ignores events with no usage (failures/disconnects)", () => {
  const q = new QuotaTracker();
  q.record(event({ apiKeyHash: "k1", usage: null, status: "failure" }));
  assert.equal(q.consumed("k1").tokens, 0);
  assert.equal(q.consumed("k1").costUsd, 0);
});

test("QuotaTracker: codex billable tokens = input+output (no cached/reasoning double count)", () => {
  const q = new QuotaTracker();
  q.record(
    event({
      apiKeyHash: "k1",
      provider: "codex",
      model: "gpt-5.5",
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 300, // subset of input
        reasoningOutputTokens: 200, // subset of output
      },
    }),
  );
  assert.equal(q.consumed("k1").tokens, 1500);
});

test("QuotaTracker: unknown key returns zero", () => {
  const q = new QuotaTracker();
  assert.deepEqual(q.consumed("nope"), { tokens: 0, costUsd: 0 });
});

test("QuotaTracker: start() replays current-month events from stats.jsonl", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-quota-"));
  const file = path.join(dir, "stats.jsonl");
  const lines = [
    JSON.stringify(event({ apiKeyHash: "k1", usage: usage(1000, 0, 0, 0) })),
    JSON.stringify(event({ apiKeyHash: "k1", ts: "2019-06-01T00:00:00.000Z", usage: usage(5000, 0, 0, 0) })),
    "{ corrupted line",
    JSON.stringify(event({ apiKeyHash: "k2", usage: usage(0, 200, 0, 0) })),
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n");
  try {
    const q = new QuotaTracker();
    q.start(dir);
    assert.equal(q.consumed("k1").tokens, 1000); // old-month line excluded
    assert.equal(q.consumed("k2").tokens, 200);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// helpers
function usage(i: number, o: number, cc: number, cr: number) {
  return {
    inputTokens: i,
    outputTokens: o,
    cacheCreationInputTokens: cc,
    cacheReadInputTokens: cr,
    reasoningOutputTokens: 0,
  };
}
function u(i: number, o: number) {
  return usage(i, o, 0, 0);
}
