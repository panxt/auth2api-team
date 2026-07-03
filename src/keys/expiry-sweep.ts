import type { ManagedKeyStore } from "./store";
import type { Notifier } from "../notify/notifier";

const DAY_MS = 86_400_000;

/**
 * Periodic sweep for key expiry. On each tick:
 *   - expired managed keys still enabled → disabled + "expired" alert;
 *   - managed keys within the notifier's advance-notice window → "expiring soon".
 * Dedup is handled by the Notifier's cooldown (per dedupKey). Config-sourced
 * keys are read-only and skipped. Runs once at start, then hourly.
 */
export class ExpirySweep {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private keyStore: ManagedKeyStore,
    private notifier: Notifier,
    private intervalMs = 3_600_000,
  ) {}

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests / manual trigger. Returns count of keys disabled. */
  tick(): number {
    const now = Date.now();
    const warnMs = this.notifier.expiryWarnDays() * DAY_MS;
    let disabled = 0;
    let views;
    try {
      views = this.keyStore.list();
    } catch {
      return 0;
    }
    for (const v of views) {
      if (v.source !== "managed" || !v["expires-at"]) continue;
      const t = Date.parse(v["expires-at"]);
      if (Number.isNaN(t)) continue;
      const who = `${v.label || "(unlabeled)"} · ${v.id}`;
      if (now >= t) {
        // Alert only on the actual enabled→disabled transition, so an
        // already-disabled expired key doesn't re-alert every tick (dedup is
        // in-memory and resets on restart / cooldown).
        if (v.enabled) {
          try {
            this.keyStore.update(v.id, { enabled: false });
            disabled++;
            this.notifier.send({
              kind: "key-expiry",
              dedupKey: `expiry:expired:${v.id}`,
              title: "🔑 API key 已过期并停用",
              color: "red",
              fields: [
                { label: "Key", value: who },
                { label: "到期时间", value: v["expires-at"]! },
              ],
            });
          } catch {
            /* ignore — config key or gone */
          }
        }
      } else if (warnMs > 0 && t - now <= warnMs) {
        const days = Math.ceil((t - now) / DAY_MS);
        this.notifier.send({
          kind: "key-expiry",
          dedupKey: `expiry:soon:${v.id}:${v["expires-at"]}`,
          title: "⏰ API key 即将过期",
          color: "orange",
          fields: [
            { label: "Key", value: who },
            { label: "到期时间", value: v["expires-at"]! },
            { label: "剩余", value: `${days} 天` },
          ],
        });
      }
    }
    return disabled;
  }
}
