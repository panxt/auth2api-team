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
import { SqliteStorage } from "../src/storage/sqlite";
import { RequestLogger } from "../src/logging/logger";
import type { RequestLogRecord } from "../src/storage/types";

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

function logRow(apiKeyHash: string): RequestLogRecord {
  return {
    ts: new Date().toISOString(),
    apiKeyHash,
    ip: "127.0.0.1",
    endpoint: "POST /v1/messages",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    accountEmail: "a@x.com",
    status: "success",
    statusCode: 200,
    failureKind: null,
    category: "ok",
    latencyMs: 5,
    inputTokens: 1,
    outputTokens: 1,
    errorDetail: null,
    requestId: null,
  };
}

test("/admin/logs: admin sees all rows; member sees only own; auditor sees all", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-logs-"));
  const adminKey: ApiKeyEntry = { key: "sk-admin", enabled: true, admin: true };
  const auditorKey: ApiKeyEntry = { key: "sk-aud", enabled: true, admin: false, role: "auditor" };
  const devKey: ApiKeyEntry = { key: "sk-dev", label: "dev", enabled: true, admin: false, role: "member" };
  const storage = new SqliteStorage(path.join(tmp, "t.db"));
  storage.requestLog.append(logRow(hashApiKey("sk-admin")));
  storage.requestLog.append(logRow(hashApiKey("sk-dev")));
  storage.requestLog.append(logRow(hashApiKey("sk-dev")));
  // capture:"failures" so the successful /admin/logs GETs don't self-log and
  // inflate the row count between assertions.
  const logger = new RequestLogger(storage.requestLog, storage.settings, { enabled: true, capture: "failures" });

  const app = createServer(
    makeConfig(tmp, [adminKey, auditorKey, devKey]),
    { all: () => [], get: () => undefined } as any,
    undefined,
    undefined,
    undefined,
    logger,
  );
  const server = app.listen(0);
  try {
    const port = (server.address() as any).port;
    const get = async (key: string) => {
      const res = await fetch(`http://127.0.0.1:${port}/admin/logs?limit=100`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      return (await res.json()).logs as any[];
    };
    assert.equal((await get("sk-admin")).length, 3, "admin sees all 3");
    assert.equal((await get("sk-aud")).length, 3, "auditor sees all 3");
    const mine = await get("sk-dev");
    assert.equal(mine.length, 2, "member sees only its own 2 rows");
    assert.ok(
      mine.every((r) => r.apiKeyShort === hashApiKey("sk-dev").slice(0, 12)),
      "member rows are all its own key",
    );
    // member sees its own resolved name
    assert.equal(mine[0].keyName, "dev");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await storage.close();
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
