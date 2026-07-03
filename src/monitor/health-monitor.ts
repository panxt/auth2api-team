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
