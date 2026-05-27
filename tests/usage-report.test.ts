import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server";
import { normalizeApiKeys, ApiKeyEntry } from "../src/config";
import { StatsRecorder, StatsEvent } from "../src/stats/recorder";
import { QuotaTracker } from "../src/usage/quota";
import { computeCost } from "../src/usage/pricing";
import { hashApiKey } from "../src/utils/common";

function event(partial: Partial<StatsEvent>): StatsEvent {
  return {
    v: 1,
    ts: new Date().toISOString(),
    apiKeyHash: "h".repeat(64),
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
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningOutputTokens: 0,
    },
    ...partial,
  };
}

// ── recorder cost augmentation ──

test("StatsRecorder: injected costFn populates totalCostUsd on every view", () => {
  const recorder = new StatsRecorder((ev) =>
    ev.model && ev.usage ? computeCost(ev.model, ev.usage, ev.provider ?? undefined) : 0,
  );
  recorder.applyEvent(event({})); // 1M input @ sonnet $3/MTok = $3
  const snap = recorder.getSnapshot();
  assert.ok(Math.abs(snap.totals.totalCostUsd - 3) < 1e-9);
  assert.ok(Math.abs(snap.byClient["h".repeat(64)].totalCostUsd - 3) < 1e-9);
  assert.ok(
    Math.abs(snap.byApi["POST /v1/messages|claude-sonnet-4-6|anthropic"].totalCostUsd - 3) < 1e-9,
  );
});

test("StatsRecorder: default (no costFn) yields zero cost", () => {
  const recorder = new StatsRecorder();
  recorder.applyEvent(event({}));
  assert.equal(recorder.getSnapshot().totals.totalCostUsd, 0);
});

// ── /admin/usage/keys ──

function makeConfig(authDir: string, keys: (string | ApiKeyEntry)[]): any {
  return {
    host: "",
    port: 0,
    "auth-dir": authDir,
    "api-keys": normalizeApiKeys(keys),
    "body-limit": "1mb",
    cloaking: {},
    timeouts: { "messages-ms": 1000, "stream-messages-ms": 1000, "count-tokens-ms": 1000 },
    stats: { enabled: false },
    debug: "off",
  };
}

test("/admin/usage/keys: admin key sees all keys with consumption vs quota", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-rep-"));
  const adminKey: ApiKeyEntry = { key: "sk-admin", enabled: true, admin: true };
  const devKey: ApiKeyEntry = {
    key: "sk-dev",
    label: "dev",
    enabled: true,
    admin: false,
    quota: { "monthly-tokens": 1_000_000 },
  };
  const quota = new QuotaTracker();
  quota.record(
    event({ apiKeyHash: hashApiKey("sk-dev"), usage: usage(250_000) }),
  );

  const app = createServer(makeConfig(tmp, [adminKey, devKey]), {} as any, undefined, quota);
  const server = app.listen(0);
  try {
    const port = (server.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/admin/usage/keys`, {
      headers: { Authorization: "Bearer sk-admin" },
    });
    const body = await res.json();
    assert.equal(body.keys.length, 2); // admin sees both
    const dev = body.keys.find((k: any) => k.label === "dev");
    assert.equal(dev.consumed.tokens, 250_000);
    assert.equal(dev.usage.tokens.cap, 1_000_000);
    assert.equal(dev.usage.tokens.remaining, 750_000);
    assert.ok(Math.abs(dev.usage.tokens.percent - 0.25) < 1e-9);
    // raw key is never exposed
    assert.ok(!JSON.stringify(body).includes("sk-dev"));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("/admin/usage/keys: non-admin key sees only itself", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-rep-"));
  const adminKey: ApiKeyEntry = { key: "sk-admin", enabled: true, admin: true };
  const devKey: ApiKeyEntry = { key: "sk-dev", enabled: true, admin: false };
  const app = createServer(makeConfig(tmp, [adminKey, devKey]), {} as any, undefined, new QuotaTracker());
  const server = app.listen(0);
  try {
    const port = (server.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/admin/usage/keys`, {
      headers: { Authorization: "Bearer sk-dev" },
    });
    const body = await res.json();
    assert.equal(body.keys.length, 1);
    assert.equal(body.keys[0].apiKeyShort, hashApiKey("sk-dev").slice(0, 12));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function usage(i: number) {
  return {
    inputTokens: i,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    reasoningOutputTokens: 0,
  };
}
