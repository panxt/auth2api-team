import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server";
import { normalizeApiKeys, ApiKeyEntry } from "../src/config";
import { QuotaTracker } from "../src/usage/quota";
import { hashApiKey } from "../src/utils/common";
import { StatsEvent } from "../src/stats/recorder";
import {
  checkKeyRpm,
  acquireConcurrency,
  releaseConcurrency,
  currentConcurrency,
  _resetForTest,
} from "../src/ratelimit/per-key";

// ── per-key.ts unit tests ──

test("checkKeyRpm allows up to the limit then blocks within the window", () => {
  _resetForTest();
  assert.equal(checkKeyRpm("k", 2), true); // 1st
  assert.equal(checkKeyRpm("k", 2), true); // 2nd
  assert.equal(checkKeyRpm("k", 2), false); // 3rd over limit
  // a different key has its own window
  assert.equal(checkKeyRpm("other", 2), true);
});

test("checkKeyRpm with rpm=0 blocks every request including the first", () => {
  _resetForTest();
  assert.equal(checkKeyRpm("k", 0), false);
  assert.equal(checkKeyRpm("k", 0), false);
});

test("concurrency: acquire up to max, block beyond, release frees a slot", () => {
  _resetForTest();
  assert.equal(acquireConcurrency("k", 2), true);
  assert.equal(acquireConcurrency("k", 2), true);
  assert.equal(currentConcurrency("k"), 2);
  assert.equal(acquireConcurrency("k", 2), false); // at cap
  releaseConcurrency("k");
  assert.equal(currentConcurrency("k"), 1);
  assert.equal(acquireConcurrency("k", 2), true); // slot freed
});

test("releaseConcurrency never goes negative", () => {
  _resetForTest();
  releaseConcurrency("k");
  assert.equal(currentConcurrency("k"), 0);
});

// ── integration: quota + per-key rate limit through createServer ──

function makeConfig(authDir: string, keys: (string | any)[]): any {
  return {
    host: "",
    port: 0,
    "auth-dir": authDir,
    "api-keys": normalizeApiKeys(keys),
    "body-limit": "1mb",
    cloaking: {},
    timeouts: {
      "messages-ms": 1000,
      "stream-messages-ms": 1000,
      "count-tokens-ms": 1000,
    },
    stats: { enabled: false },
    debug: "off",
  };
}

function usageEvent(apiKeyHash: string, tokens: number): StatsEvent {
  return {
    v: 1,
    ts: new Date().toISOString(),
    apiKeyHash,
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
      inputTokens: tokens,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningOutputTokens: 0,
    },
  };
}

test("requireQuota: over-quota key is rejected with 429 quota_exceeded", async () => {
  _resetForTest();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-q-"));
  const key = "sk-capped";
  const entry: ApiKeyEntry = {
    key,
    enabled: true,
    admin: false,
    quota: { "monthly-tokens": 1000 },
  };
  const quota = new QuotaTracker();
  quota.record(usageEvent(hashApiKey(key), 1500)); // already over the 1000 cap

  const app = createServer(makeConfig(tmp, [entry]), {} as any, undefined, quota);
  const server = app.listen(0);
  try {
    const port = (server.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 429);
    assert.ok(res.headers.get("retry-after"));
    const body = await res.json();
    assert.equal(body.error.type, "quota_exceeded");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("requireQuota: under-quota key passes through to the handler", async () => {
  _resetForTest();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-q-"));
  const key = "sk-ok";
  const entry: ApiKeyEntry = {
    key,
    enabled: true,
    admin: false,
    quota: { "monthly-tokens": 1_000_000 },
  };
  const quota = new QuotaTracker();
  quota.record(usageEvent(hashApiKey(key), 10)); // well under cap

  const app = createServer(makeConfig(tmp, [entry]), {} as any, undefined, quota);
  const server = app.listen(0);
  try {
    const port = (server.address() as any).port;
    // Missing `messages` → handler returns 400 *after* passing the quota gate,
    // which proves the request was not blocked by quota. (registry is never
    // touched because the messages check precedes provider routing.)
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error.message, /messages is required/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("enforceKeyRateLimit: per-key rpm blocks the request over the limit", async () => {
  _resetForTest();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-q-"));
  const key = "sk-rpm";
  const entry: ApiKeyEntry = {
    key,
    enabled: true,
    admin: false,
    "rate-limit": { rpm: 1 },
  };
  const app = createServer(makeConfig(tmp, [entry]), {} as any);
  const server = app.listen(0);
  try {
    const port = (server.address() as any).port;
    const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    const body = JSON.stringify({ model: "claude-sonnet-4-6" }); // → 400 from handler
    const first = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", headers, body });
    assert.equal(first.status, 400); // within rpm budget, reaches handler
    const second = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", headers, body });
    assert.equal(second.status, 429); // over rpm
    const j = await second.json();
    assert.equal(j.error.type, "rate_limit");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("disabled key is rejected with 403", async () => {
  _resetForTest();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-q-"));
  const key = "sk-off";
  const entry: ApiKeyEntry = { key, enabled: false, admin: false };
  const app = createServer(makeConfig(tmp, [entry]), {} as any);
  const server = app.listen(0);
  try {
    const port = (server.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6" }),
    });
    assert.equal(res.status, 403);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
