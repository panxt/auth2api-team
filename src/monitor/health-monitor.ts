import type { ProviderRegistry } from "../providers/registry";
import type { McpController } from "../mcp/registry";
import type { Notifier } from "../notify/notifier";

/**
 * Periodic health monitor for飞书 alerts. Edge-triggered: only fires when an
 * upstream account or MCP server transitions from healthy → unhealthy (so a
 * persistently-down resource doesn't spam). Notifier dedup is a second guard.
 * No-op when notifier disabled. Polls every 2 minutes.
 */
export class HealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private accountUp = new Map<string, boolean>();
  private mcpUp = new Map<string, boolean>();
  // Highest pool-alert level already fired per "provider:window" (0 none / 1
  // warn / 2 exhausted). Only alert on escalation; recovery (window reset)
  // lowers it silently so a fresh window can re-alert.
  private poolLevel = new Map<string, number>();

  constructor(
    private registry: ProviderRegistry,
    private mcp: McpController | undefined,
    private notifier: Notifier,
    private intervalMs = 120_000,
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

  tick(): void {
    try {
      for (const p of this.registry.all()) {
        for (const s of p.manager.getSnapshots()) {
          const id = `${p.id}:${s.email}`;
          const up = s.available;
          if (this.accountUp.get(id) === true && !up) {
            this.notifier.send({
              kind: "account-down",
              dedupKey: `acct:${id}`,
              title: "🔌 上游账号不可用",
              color: "red",
              fields: [
                { label: "Provider", value: p.id },
                { label: "账号", value: s.email },
                {
                  label: "原因",
                  value: (s as any).cooldownUntil > Date.now() ? "进入 cooldown" : "不可用 / 需重登",
                },
              ],
            });
          }
          this.accountUp.set(id, up);
        }
      }
      // Aggregate account-pool capacity ("总额度"): warn at pool-threshold%,
      // exhausted at ~100%. Per provider × window (5h/7d).
      const threshold = this.notifier.poolThreshold();
      for (const p of this.registry.all()) {
        const qp = (p.manager as any).quotaPool?.();
        if (!qp) continue;
        for (const w of ["5h", "7d"] as const) {
          const wp = qp[w];
          if (!wp || wp.remainingPct == null) continue;
          const usedPct = (1 - wp.remainingPct) * 100;
          const exhausted = wp.remainingUnits <= 0 || usedPct >= 99.9;
          const level = exhausted ? 2 : usedPct >= threshold ? 1 : 0;
          const id = `${p.id}:${w}`;
          const prev = this.poolLevel.get(id) ?? 0;
          if (level > prev) {
            this.notifier.send({
              kind: "pool-quota",
              dedupKey: `pool:${id}:${level}:${wp.soonestReset ?? ""}`,
              title: level === 2 ? "🚫 总额度已用尽" : "⚠️ 总额度即将用尽",
              color: level === 2 ? "red" : "orange",
              fields: [
                { label: "Provider", value: p.id },
                { label: "窗口", value: w },
                { label: "已用", value: `${usedPct.toFixed(1)}%` },
                {
                  label: "剩余",
                  value: `${wp.remainingUnits.toFixed(2)} 等效窗口`,
                },
              ],
            });
          }
          this.poolLevel.set(id, level);
        }
      }

      for (const v of this.mcp?.list() ?? []) {
        const up = v.health.status === "connected";
        if (this.mcpUp.get(v.id) === true && !up) {
          this.notifier.send({
            kind: "mcp-probe-fail",
            dedupKey: `mcp:${v.id}`,
            title: "🧩 MCP 上游探活失败",
            color: "red",
            fields: [
              { label: "MCP", value: `${v.label} · ${v.id}` },
              { label: "状态", value: v.health.status },
              { label: "错误", value: v.health.lastError || "-" },
            ],
          });
        }
        this.mcpUp.set(v.id, up);
      }
    } catch {
      /* never let monitoring break anything */
    }
  }
}
