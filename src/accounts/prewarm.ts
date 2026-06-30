import { PrewarmConfig, resolvePrewarmConfig } from "../config";
import type { SettingsStore } from "../storage/types";
import type { PrewarmResult } from "../providers/types";

const SETTINGS_KEY = "prewarm";
/** Timer granularity. Trigger points have minute resolution, so a 30s tick
 *  guarantees each configured "HH:MM" is observed within its minute. */
const TICK_MS = 30_000;
/** How many recent runs to keep in memory for the dashboard. */
const HISTORY_LIMIT = 20;

/** One recorded prewarm run (scheduled, manual, or startup). */
export interface PrewarmRun {
  /** What triggered this run. */
  trigger: "schedule" | "manual";
  /** ISO timestamp when the run finished. */
  at: string;
  /** Per-provider ping results. */
  providers: PrewarmResult[];
  /** Accounts successfully warmed across all providers. */
  ok: number;
  /** Accounts attempted across all providers. */
  total: number;
}

/**
 * In-process daily window-prewarm scheduler. Mirrors RoutingController's
 * config model (defaults < config.yaml < persisted UI override, hot-reload at
 * runtime, no restart) and adds:
 *   - a minute-granularity timer that runs `runPrewarm` at each configured
 *     "HH:MM" *local* time, once per day per time;
 *   - an in-memory ring buffer of recent run results so the dashboard can show
 *     what actually happened (which accounts warmed, latency, errors).
 *
 * Replaces the external launchd cron (`scripts/.../prewarm.plist`) with a
 * UI-configurable, cross-platform scheduler.
 */
export class PrewarmScheduler {
  private config: PrewarmConfig;
  private history: PrewarmRun[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guards against re-firing a time that already ran today (and double-fires
   *  within the same minute). Key = "YYYY-MM-DD HH:MM". Bounded. */
  private firedKeys = new Set<string>();

  constructor(
    private settings: SettingsStore,
    /** Sends the actual pings; returns one result per warmed provider. */
    private runPrewarm: () => Promise<PrewarmResult[]>,
    private yamlSeed?: Partial<PrewarmConfig>,
  ) {
    const persisted = settings.get<Partial<PrewarmConfig>>(SETTINGS_KEY);
    this.config = resolvePrewarmConfig(yamlSeed, persisted);
  }

  getConfig(): PrewarmConfig {
    return {
      ...this.config,
      times: [...this.config.times],
      providers: [...this.config.providers],
    };
  }

  getHistory(): PrewarmRun[] {
    return this.history.map((r) => ({ ...r }));
  }

  /** Persist + hot-apply a config patch. Validates `times` so a typo surfaces
   *  as a 400 instead of being silently dropped. */
  updateConfig(patch: Partial<PrewarmConfig>): PrewarmConfig {
    if (patch.times !== undefined) {
      if (!Array.isArray(patch.times))
        throw new Error("times must be an array of 'HH:MM' strings");
      for (const t of patch.times) {
        if (typeof t !== "string" || !/^\d{1,2}:\d{2}$/.test(t.trim()))
          throw new Error(`invalid time "${t}" — expected "HH:MM"`);
        const [h, m] = t.trim().split(":").map(Number);
        if (h > 23 || m > 59)
          throw new Error(`invalid time "${t}" — hour 0-23, minute 0-59`);
      }
    }
    const persisted = this.settings.get<Partial<PrewarmConfig>>(SETTINGS_KEY);
    const merged = resolvePrewarmConfig(this.yamlSeed, persisted, patch);
    this.settings.set(SETTINGS_KEY, merged);
    this.config = merged;
    return this.getConfig();
  }

  start(): void {
    if (this.timer) return;
    const timer = setInterval(() => this.tick(), TICK_MS);
    timer.unref();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (!this.config.enabled || this.config.times.length === 0) return;
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const hhmm = `${hh}:${mm}`;
    if (!this.config.times.includes(hhmm)) return;
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const key = `${day} ${hhmm}`;
    if (this.firedKeys.has(key)) return;
    this.firedKeys.add(key);
    if (this.firedKeys.size > 64) {
      // Keep only the most-recent keys to stay bounded.
      this.firedKeys = new Set(Array.from(this.firedKeys).slice(-32));
    }
    void this.trigger("schedule").catch((err) =>
      console.error("[prewarm] scheduled run failed:", err?.message || err),
    );
  }

  /** Run prewarm now and record the result in history. Used by the timer and
   *  by the manual POST /admin/prewarm endpoint. */
  async trigger(triggerKind: PrewarmRun["trigger"]): Promise<PrewarmRun> {
    const providers = await this.runPrewarm();
    let ok = 0;
    let total = 0;
    for (const p of providers) {
      for (const r of p.results) {
        total++;
        if (r.ok) ok++;
      }
    }
    const run: PrewarmRun = {
      trigger: triggerKind,
      at: new Date().toISOString(),
      providers,
      ok,
      total,
    };
    this.history.unshift(run);
    if (this.history.length > HISTORY_LIMIT)
      this.history.length = HISTORY_LIMIT;
    return run;
  }
}
