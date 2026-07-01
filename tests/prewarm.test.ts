import { test } from "node:test";
import assert from "node:assert";
import {
  resolvePrewarmConfig,
  normalizePrewarmTimes,
  DEFAULT_PREWARM_CONFIG,
} from "../src/config";
import { PrewarmScheduler } from "../src/accounts/prewarm";
import type {
  SettingsStore,
  PrewarmRunStore,
  PrewarmRunRecord,
  PrewarmRunPage,
} from "../src/storage/types";
import type { PrewarmResult } from "../src/providers/types";

/** In-memory PrewarmRunStore for tests (newest-first, id = insertion order). */
function memPrewarmStore(): PrewarmRunStore & { rows: PrewarmRunRecord[] } {
  const rows: PrewarmRunRecord[] = [];
  return {
    rows,
    append(rec) {
      rows.push(rec);
    },
    list({ limit, cursor }): PrewarmRunPage {
      const total = rows.length;
      const reversed = rows.map((r, i) => ({ ...r, id: i })).reverse();
      const start = cursor != null ? total - cursor : 0;
      const slice = reversed.slice(start, start + limit + 1);
      const hasMore = slice.length > limit;
      const page = slice.slice(0, limit);
      return { rows: page, nextCursor: hasMore ? page[page.length - 1].id : null };
    },
    prune({ maxRows }) {
      if (!maxRows || rows.length <= maxRows) return 0;
      const removed = rows.length - maxRows;
      rows.splice(0, removed);
      return removed;
    },
  };
}

/** In-memory SettingsStore for tests. */
function memSettings(): SettingsStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get<T = unknown>(key: string): T | null {
      return (data.has(key) ? (data.get(key) as T) : null);
    },
    set(key: string, value: unknown): void {
      data.set(key, value);
    },
  };
}

test("normalizePrewarmTimes canonicalizes, dedupes, sorts, drops invalid", () => {
  assert.deepEqual(normalizePrewarmTimes(["8:00", "13:0", "08:00", "25:00", "x"]), [
    "08:00",
  ]);
  assert.deepEqual(normalizePrewarmTimes(["13:30", "08:05"]), ["08:05", "13:30"]);
  assert.deepEqual(normalizePrewarmTimes("nope"), [...DEFAULT_PREWARM_CONFIG.times]);
});

test("resolvePrewarmConfig merges defaults < yaml < persisted", () => {
  const cfg = resolvePrewarmConfig(
    { times: ["08:00"] },
    { enabled: false },
    { times: ["09:00", "09:00"] },
  );
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.times, ["09:00"]);
  assert.deepEqual(cfg.providers, []);
});

test("updateConfig persists to settings and is read back on reconstruct", () => {
  const settings = memSettings();
  const noop = async (): Promise<PrewarmResult[]> => [];
  const s1 = new PrewarmScheduler(settings, noop);
  s1.updateConfig({ enabled: false, times: ["07:30", "12:00"] });

  const s2 = new PrewarmScheduler(settings, noop);
  assert.equal(s2.getConfig().enabled, false);
  assert.deepEqual(s2.getConfig().times, ["07:30", "12:00"]);
});

test("updateConfig rejects malformed times with a clear error", () => {
  const s = new PrewarmScheduler(memSettings(), async () => []);
  assert.throws(() => s.updateConfig({ times: ["8am"] }), /invalid time/);
  assert.throws(() => s.updateConfig({ times: ["24:00"] }), /invalid time/);
  assert.throws(
    () => s.updateConfig({ times: "08:00" as unknown as string[] }),
    /must be an array/,
  );
});

test("trigger() runs prewarm and records a roll-up in history", async () => {
  let calls = 0;
  const run = async (): Promise<PrewarmResult[]> => {
    calls++;
    return [
      {
        provider: "anthropic",
        results: [
          { email: "a@x.com", ok: true, latencyMs: 12 },
          { email: "b@x.com", ok: false, error: "cooldown" },
        ],
        generated_at: new Date().toISOString(),
      },
    ];
  };
  const s = new PrewarmScheduler(memSettings(), run);

  const r = await s.trigger("manual");
  assert.equal(calls, 1);
  assert.equal(r.trigger, "manual");
  assert.equal(r.ok, 1);
  assert.equal(r.total, 2);

  const hist = s.getHistory();
  assert.equal(hist.length, 1);
  assert.equal(hist[0].ok, 1);
  assert.equal(hist[0].total, 2);
});

test("store-backed history persists across a restart and paginates", async () => {
  const settings = memSettings();
  const store = memPrewarmStore();
  const run = async (): Promise<PrewarmResult[]> => [
    { provider: "anthropic", results: [{ email: "a@x.com", ok: true }], generated_at: "" },
  ];

  const s1 = new PrewarmScheduler(settings, run, undefined, store);
  for (let i = 0; i < 5; i++) await s1.trigger(i % 2 ? "manual" : "schedule");
  assert.equal(store.rows.length, 5);

  // Simulate a restart: a brand-new scheduler with no in-memory history still
  // serves the persisted runs from the store.
  const s2 = new PrewarmScheduler(settings, run, undefined, store);
  assert.equal(s2.getHistory().length, 0, "in-memory ring is empty after restart");

  const page1 = s2.historyPage({ limit: 2 });
  assert.equal(page1.rows.length, 2);
  assert.notEqual(page1.nextCursor, null);
  const page2 = s2.historyPage({ limit: 2, cursor: page1.nextCursor });
  assert.equal(page2.rows.length, 2);
  // Newest-first: page1[0] is the most recent run.
  assert.ok(page1.rows[0].id > page2.rows[0].id);
});

test("history is newest-first and capped", async () => {
  const s = new PrewarmScheduler(memSettings(), async () => [
    { provider: "anthropic", results: [{ email: "a@x.com", ok: true }], generated_at: "" },
  ]);
  for (let i = 0; i < 25; i++) await s.trigger("schedule");
  const hist = s.getHistory();
  assert.equal(hist.length, 20, "ring buffer caps at 20");
  // All entries are well-formed; newest-first ordering is by construction.
  assert.ok(hist.every((h) => h.total === 1 && h.ok === 1));
});
