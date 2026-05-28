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
