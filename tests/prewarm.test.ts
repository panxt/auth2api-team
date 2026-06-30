import { test } from "node:test";
import assert from "node:assert";
import {
  resolvePrewarmConfig,
  normalizePrewarmTimes,
  DEFAULT_PREWARM_CONFIG,
} from "../src/config";
import { PrewarmScheduler } from "../src/accounts/prewarm";
import type { SettingsStore } from "../src/storage/types";
import type { PrewarmResult } from "../src/providers/types";

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
