import { NotifyConfig, resolveNotifyConfig } from "../config";
import type { SettingsStore } from "../storage/types";
import { buildCard, sendFeishu, FeishuCardField } from "./feishu";

const SETTINGS_KEY = "notify";

/** Which alert toggle (under NotifyConfig.alerts) gates an event kind. */
export type NotifyKind =
  | "quota"
  | "account-down"
  | "prewarm-fail"
  | "mcp-probe-fail"
  | "key-expiry";

const KIND_TOGGLE: Record<NotifyKind, keyof NotifyConfig["alerts"]> = {
  quota: "quota-thresholds", // presence of thresholds gates it (see shouldFire)
  "account-down": "account-down",
  "prewarm-fail": "prewarm-fail",
  "mcp-probe-fail": "mcp-probe-fail",
  "key-expiry": "key-expiry",
};

export interface NotifyEvent {
  kind: NotifyKind;
  /** Stable identity for dedup (e.g. "quota:cost:abcd:month:80"). */
  dedupKey: string;
  title: string;
  fields: FeishuCardField[];
  color?: "red" | "orange" | "green" | "grey";
}

/**
 * Outbound notifier (飞书). Config-backed (SettingsStore, hot-reloaded like the
 * request logger). All sends are fire-and-forget and swallow errors — a broken
 * webhook must never break the request path. Default config is disabled, so
 * this is a no-op until an operator opts in.
 */
export class Notifier {
  private config: NotifyConfig;
  private lastSent = new Map<string, number>();

  constructor(
    private settings: SettingsStore,
    private yamlSeed?: Partial<NotifyConfig>,
  ) {
    const persisted = settings.get<Partial<NotifyConfig>>(SETTINGS_KEY);
    this.config = resolveNotifyConfig(yamlSeed, persisted);
  }

  getConfig(): NotifyConfig {
    // Redact the secret in the returned view (like managed keys).
    const c = JSON.parse(JSON.stringify(this.config)) as NotifyConfig;
    if (c.feishu.secret) c.feishu.secret = "";
    return c;
  }

  /** Raw config incl. secret — internal use only (sending). */
  private raw(): NotifyConfig {
    return this.config;
  }

  updateConfig(patch: Partial<NotifyConfig>): NotifyConfig {
    // Preserve the existing secret when the patch omits it or sends the masked
    // empty string (the UI never re-sends the real secret).
    const persisted =
      this.settings.get<Partial<NotifyConfig>>(SETTINGS_KEY) ?? {};
    const p: any = { ...patch };
    if (p.feishu && (p.feishu.secret === "" || p.feishu.secret === undefined)) {
      const keep = this.config.feishu.secret;
      p.feishu = { ...p.feishu };
      if (keep) p.feishu.secret = keep;
      else delete p.feishu.secret;
    }
    const merged = resolveNotifyConfig(this.yamlSeed, persisted, p);
    this.settings.set(SETTINGS_KEY, merged);
    this.config = merged;
    return this.getConfig();
  }

  /** True if this kind is enabled and not within its dedup cooldown. */
  private shouldFire(kind: NotifyKind, dedupKey: string): boolean {
    const c = this.config;
    if (!c.enabled || !c.feishu["webhook-url"]) return false;
    if (kind === "quota") {
      if (!c.alerts["quota-thresholds"]?.length) return false;
    } else if (!c.alerts[KIND_TOGGLE[kind]]) {
      return false;
    }
    const now = Date.now();
    const prev = this.lastSent.get(dedupKey);
    const cooldownMs = Math.max(0, c["dedup-minutes"]) * 60_000;
    if (prev !== undefined && now - prev < cooldownMs) return false;
    this.lastSent.set(dedupKey, now);
    return true;
  }

  /** Fire-and-forget notify. No-op when disabled / gated / deduped. */
  send(ev: NotifyEvent): void {
    if (!this.shouldFire(ev.kind, ev.dedupKey)) return;
    const { "webhook-url": url, secret } = this.raw().feishu;
    const card = buildCard(ev.title, ev.fields, ev.color ?? "orange");
    void sendFeishu(url, secret, card).catch((e) => {
      console.error("[notify] feishu send failed:", e?.message || e);
    });
  }

  /** Configured quota alert thresholds (percent), sorted ascending. */
  quotaThresholds(): number[] {
    return [...(this.config.alerts["quota-thresholds"] ?? [])].sort((a, b) => a - b);
  }

  /** Advance-notice lead time for key expiry, in days. */
  expiryWarnDays(): number {
    return Math.max(0, this.config["expiry-warn-days"] ?? 0);
  }

  /** Send a test card NOW — bypasses enabled + dedup, needs a webhook. Throws
   *  on failure so the admin endpoint can report it. */
  async test(): Promise<void> {
    const { "webhook-url": url, secret } = this.raw().feishu;
    if (!url) throw new Error("请先配置飞书 webhook-url");
    const card = buildCard(
      "auth2api 通知测试",
      [
        { label: "状态", value: "✅ webhook 连通正常" },
        { label: "说明", value: "这是一条来自 auth2api 的测试通知。" },
      ],
      "green",
    );
    await sendFeishu(url, secret, card);
  }
}
