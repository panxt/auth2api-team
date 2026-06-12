import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStorage } from "../src/storage/sqlite";
import { StatsRecorder, StatsEvent } from "../src/stats/recorder";
import { QuotaTracker } from "../src/usage/quota";
import { ManagedKeyStore } from "../src/keys/store";
import { hashApiKey } from "../src/utils/common";
import { RequestLogger, redactSecrets } from "../src/logging/logger";
import type { RequestLogRecord } from "../src/storage/types";

function dbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-sql-"));
  return path.join(dir, "auth2api.db");
}

function event(p: Partial<StatsEvent>): StatsEvent {
  return {
    v: 1,
    ts: new Date().toISOString(),
    apiKeyHash: "h".repeat(64),
    ip: "127.0.0.1",
    ua: "t",
    endpoint: "POST /v1/messages",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    accountEmail: "a@x.com",
    status: "success",
    failureKind: null,
    statusCode: 200,
    latencyMs: 5,
    usage: {
      inputTokens: 1000,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningOutputTokens: 0,
    },
    ...p,
  };
}

test("SqliteStorage: event log append + replay roundtrips and survives reopen", async () => {
  const file = dbPath();
  try {
    const s1 = new SqliteStorage(file);
    s1.eventLog.append(event({ apiKeyHash: "k1" }));
    s1.eventLog.append(event({ apiKeyHash: "k2" }));
    await s1.close();

    // Reopen the same DB file → replay sees both events (durable, no flush dance).
    const s2 = new SqliteStorage(file);
    const seen: string[] = [];
    const res = s2.eventLog.replay((ev) => seen.push(ev.apiKeyHash));
    assert.equal(res.events, 2);
    assert.deepEqual(seen.sort(), ["k1", "k2"]);
    await s2.close();
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("SqliteStorage: StatsRecorder + QuotaTracker rebuild from the DB on restart", async () => {
  const file = dbPath();
  try {
    const s1 = new SqliteStorage(file);
    const rec = new StatsRecorder();
    rec.start(s1.eventLog);
    rec.record({
      apiKeyHash: "k1",
      ip: "1",
      ua: "t",
      endpoint: "POST /v1/messages",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      accountEmail: "a@x.com",
      status: "success",
      failureKind: null,
      statusCode: 200,
      latencyMs: 5,
      usage: {
        inputTokens: 1000,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        reasoningOutputTokens: 0,
      },
    });
    await s1.close();

    // Restart: fresh recorder + quota replay from the same DB.
    const s2 = new SqliteStorage(file);
    const rec2 = new StatsRecorder();
    rec2.start(s2.eventLog);
    assert.equal(rec2.getSnapshot().totals.totalInputTokens, 1000);

    const quota = new QuotaTracker();
    quota.start(s2.eventLog);
    assert.equal(quota.consumed("k1").tokens, 1000);
    await s2.close();
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("SqliteStorage: ManagedKeyStore persists keys to the DB across restart", async () => {
  const file = dbPath();
  try {
    const s1 = new SqliteStorage(file);
    const live1 = new Map();
    const store1 = new ManagedKeyStore(s1.keyRepo, live1);
    store1.load();
    const created = store1.create({ label: "alice" });
    await s1.close();

    // Reopen → the managed key is loaded back into the live map.
    const s2 = new SqliteStorage(file);
    const live2 = new Map();
    const store2 = new ManagedKeyStore(s2.keyRepo, live2);
    store2.load();
    assert.ok(live2.has(created.key));
    const view = store2
      .list()
      .find((v) => v.id === hashApiKey(created.key).slice(0, 12));
    assert.equal(view?.label, "alice");
    assert.equal(view?.source, "managed");
    await s2.close();
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("ManagedKeyStore: allowed/denied-models + quota survive a restart", () => {
  const file = dbPath();
  try {
    const s1 = new SqliteStorage(file);
    const store1 = new ManagedKeyStore(s1.keyRepo, new Map());
    store1.load();
    const created = store1.create({
      label: "restricted",
      "allowed-models": ["claude-sonnet-4-6"],
      "denied-models": ["claude-opus-4-8"],
      quota: { "monthly-cost-usd": 50 },
    });
    s1.close();

    // Reopen → the model lists (and quota) must still be there. Regression for
    // normalizeKeyEntry dropping the new fields on disk reload.
    const s2 = new SqliteStorage(file);
    const live2 = new Map();
    const store2 = new ManagedKeyStore(s2.keyRepo, live2);
    store2.load();
    const entry = live2.get(created.key);
    assert.deepEqual(entry["allowed-models"], ["claude-sonnet-4-6"]);
    assert.deepEqual(entry["denied-models"], ["claude-opus-4-8"]);
    assert.equal(entry.quota["monthly-cost-usd"], 50);
    s2.close();
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

function logRec(p: Partial<RequestLogRecord>): RequestLogRecord {
  return {
    ts: new Date().toISOString(),
    apiKeyHash: "abc123def456" + "0".repeat(52),
    ip: "127.0.0.1",
    endpoint: "POST /v1/messages",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    accountEmail: "a@x.com",
    status: "failure",
    statusCode: 429,
    failureKind: "rate_limit",
    latencyMs: 5,
    inputTokens: null,
    outputTokens: null,
    errorDetail: "rate limit",
    requestId: "req_123",
    ...p,
  };
}

test("RequestLogStore: filter by status + email, newest-first, cursor paginates", () => {
  const file = dbPath();
  try {
    const s = new SqliteStorage(file);
    // 3 failures for a@x, 1 success, 1 failure for b@x
    s.requestLog.append(logRec({ accountEmail: "a@x.com", status: "failure" }));
    s.requestLog.append(logRec({ accountEmail: "a@x.com", status: "success", statusCode: 200 }));
    s.requestLog.append(logRec({ accountEmail: "a@x.com", status: "failure" }));
    s.requestLog.append(logRec({ accountEmail: "b@x.com", status: "failure" }));
    s.requestLog.append(logRec({ accountEmail: "a@x.com", status: "failure" }));

    const failA = s.requestLog.query({ limit: 100, status: "failure", email: "a@x.com" });
    assert.equal(failA.rows.length, 3);
    // newest-first → ids descending
    assert.ok(failA.rows[0].id > failA.rows[1].id);

    // pagination: limit 2 → nextCursor set, page 2 returns the rest
    const p1 = s.requestLog.query({ limit: 2, status: "failure", email: "a@x.com" });
    assert.equal(p1.rows.length, 2);
    assert.ok(p1.nextCursor != null);
    const p2 = s.requestLog.query({ limit: 2, status: "failure", email: "a@x.com", cursor: p1.nextCursor });
    assert.equal(p2.rows.length, 1);
    assert.equal(p2.nextCursor, null);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("RequestLogStore: prune by max-rows keeps the newest", () => {
  const file = dbPath();
  try {
    const s = new SqliteStorage(file);
    for (let i = 0; i < 10; i++) s.requestLog.append(logRec({ errorDetail: `e${i}` }));
    const removed = s.requestLog.prune({ maxRows: 4 });
    assert.equal(removed, 6);
    const all = s.requestLog.query({ limit: 100 });
    assert.equal(all.rows.length, 4);
    assert.equal(all.rows[0].errorDetail, "e9"); // newest kept
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("RequestLogger: capture=failures skips successes; snippet truncates; redacts", () => {
  const file = dbPath();
  try {
    const s = new SqliteStorage(file);
    const logger = new RequestLogger(s.requestLog, s.settings, {
      capture: "failures",
      "error-detail": "snippet",
      "snippet-length": 20,
      redact: true,
    });
    const base = {
      ts: new Date().toISOString(),
      apiKeyHash: "h".repeat(64),
      ip: "1",
      endpoint: "POST /v1/messages",
      model: "m",
      provider: "anthropic",
      accountEmail: "a@x.com",
      latencyMs: 1,
      inputTokens: null,
      outputTokens: null,
      requestId: "r1",
    };
    // success is skipped under capture=failures
    logger.record({ ...base, status: "success", statusCode: 200, failureKind: null, errorDetail: "ok" });
    // failure with a long, secret-bearing message
    logger.record({
      ...base,
      status: "failure",
      statusCode: 401,
      failureKind: "auth",
      errorDetail: "bad token sk-abcdef1234567890 and more text that is quite long",
    });
    const rows = s.requestLog.query({ limit: 100 }).rows;
    assert.equal(rows.length, 1); // success skipped
    assert.equal(rows[0].status, "failure");
    assert.ok(!rows[0].errorDetail!.includes("sk-abcdef1234567890")); // redacted
    assert.ok(rows[0].errorDetail!.length <= 21); // snippet (20 + ellipsis)
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("redactSecrets strips sk-/Bearer/JWT", () => {
  assert.equal(redactSecrets("key sk-ABCDEFGH12345 end"), "key sk-*** end");
  assert.equal(redactSecrets("auth Bearer abc.def-123"), "auth Bearer ***");
  assert.match(redactSecrets("tok eyJhbGciOiJIUzI1Ni019.payloadpayloadpayload"), /\*\*\*jwt\*\*\*/);
});

test("RequestLogger: updateConfig persists to settings + survives reopen", () => {
  const file = dbPath();
  try {
    const s = new SqliteStorage(file);
    const l1 = new RequestLogger(s.requestLog, s.settings);
    l1.updateConfig({ capture: "all", "snippet-length": 123 });
    // New logger reading the same settings store sees the persisted override.
    const l2 = new RequestLogger(s.requestLog, s.settings);
    assert.equal(l2.getConfig().capture, "all");
    assert.equal(l2.getConfig()["snippet-length"], 123);
    // unspecified fields keep defaults
    assert.equal(l2.getConfig().retention["max-age-days"], 14);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
