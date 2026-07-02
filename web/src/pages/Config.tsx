import { useEffect, useState, useCallback, useMemo } from "react";
import { ApiError } from "../api/client";
import { InfoTip } from "../components/AccountQuotaPanel";
import { fetchRoutingConfig, updateRoutingConfig, RoutingConfig } from "../api/routing";
import {
  fetchPrewarmConfig,
  updatePrewarmConfig,
  fetchPrewarmHistory,
  PrewarmConfig,
  PrewarmRun,
} from "../api/prewarm";
import { prewarm } from "../api/accounts";
import {
  fetchLoggingConfig,
  updateLoggingConfig,
  LoggingConfig,
} from "../api/logs";
import {
  fetchMcpServers,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  probeMcpServer,
  fetchMcpTools,
  McpServerView,
  McpServerInput,
  McpTransport,
  McpTool,
} from "../api/mcp";
import { Modal } from "../components/Modal";

/* ── shared small formatters (local copies) ────────────────────── */

function fmtRelative(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86400_000)} 天前`;
}

/**
 * Turn a prewarm result into a short, human reason instead of dumping the raw
 * upstream 429 JSON. Rate-limit on prewarm is expected when the 5h window is
 * already active, so it's shown amber (informational), not red.
 */
function prewarmOutcome(r: { ok: boolean; error?: string; latencyMs?: number }): {
  label: string;
  tone: string;
} {
  if (r.ok) {
    return {
      label: r.latencyMs ? `成功 · ${r.latencyMs}ms` : "成功",
      tone: "text-emerald-400",
    };
  }
  const e = r.error || "";
  if (/cooldown|not found/i.test(e)) {
    return { label: "未加载 / 冷却中", tone: "text-ink-500" };
  }
  const status = e.match(/\b(\d{3})\b/)?.[1] ?? null;
  if (status === "429" || /rate_limit/i.test(e)) {
    return { label: "已限流 · 5h 窗口暂满", tone: "text-amber-400" };
  }
  if (status === "401" || /unauthor|invalid_token|invalid_grant/i.test(e)) {
    return { label: "认证失效 · 需重新认证", tone: "text-rose-400" };
  }
  let msg = e;
  const brace = e.indexOf("{");
  if (brace >= 0) {
    try {
      const obj = JSON.parse(e.slice(brace));
      msg = obj?.error?.message || obj?.message || e;
    } catch {
      /* keep raw */
    }
  }
  if (msg.length > 80) msg = msg.slice(0, 80) + "…";
  return { label: `${status ? status + " · " : ""}${msg || "失败"}`, tone: "text-rose-400" };
}

/** Local YYYY-MM-DD for a run timestamp. */
function localDate(at: string): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** Local HH:MM:SS for a run's actual fire time. */
function localClock(at: string): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}
/** Whether a planned (date, "HH:MM") slot is already in the past (local). */
function isPastSlot(date: string, time: string): boolean {
  return new Date(`${date}T${time}`).getTime() < Date.now();
}

const PREWARM_ALGO_TIP =
  "原理:Anthropic 的 5 小时限流窗口是『首条消息锚定』——窗口从你当天第一条请求那一刻开始计时,5 小时后自动重置、可再开一个新窗口。\n\n" +
  "若不暖机,窗口起点取决于当天第一个真实请求落在几点,边界随机、常常浪费掉上班前的额度。\n\n" +
  "定时暖机:每天固定时间(默认 08:00)自动发一条最便宜的 ping(Haiku, max_tokens=1, 成本≈0)主动锚定窗口。08:00 开窗 → 13:00 自动重置开第二个窗口,使工作时段(约 8:30–17:30)尽量跨越 2 个完整的 5h 窗口,相比冷启动理论可用配额上限提升约 +80%。\n\n" +
  "进阶:再加一个 13:00 时间点,可严格保证第二个窗口也被准点锚定(否则第二窗口要等当天 13:00 后的第一个真实请求才开)。周末也建议开启,避免周一从冷启动开始。\n\n" +
  "时间为服务器本地时间。ping 是真实计费请求但成本极低;账号处于冷却时会自动跳过。";

/* ─── Page ──────────────────────────────────────────────────── */

export function Config() {
  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">设置</h1>
        <p className="text-sm text-ink-400 mt-1">
          负载均衡、窗口暖机、日志策略、MCP 服务。改动即时持久化并热生效,无需重启。仅 admin 可见。
        </p>
      </header>
      <div className="space-y-4">
        <RoutingCard />
        <PrewarmCard />
        <McpCard />
        <LoggingCard />
      </div>
    </div>
  );
}

/* ─── Routing settings card ──────────────────────────────────── */

function RoutingCard() {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<RoutingConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetchRoutingConfig().then(setCfg).catch(() => setCfg(null));
  }, []);

  function patch(p: Partial<RoutingConfig>) {
    setCfg((c) => (c ? { ...c, ...p } : c));
  }

  async function save() {
    if (!cfg) return;
    setSaving(true);
    setMsg(null);
    try {
      const next = await updateRoutingConfig(cfg);
      setCfg(next);
      setMsg("已保存");
      setTimeout(() => setMsg(null), 2000);
    } catch (e) {
      setMsg(`保存失败: ${(e as ApiError).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <button
        className="flex items-center justify-between w-full text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="font-medium">⚙️ 负载均衡设置</span>
        <span className="text-ink-500 text-sm">{open ? "收起" : "展开"}</span>
      </button>
      {open && cfg && (
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <label className="block text-xs text-ink-500 mb-1">调度策略</label>
            <select
              className="input !py-1"
              value={cfg.strategy}
              onChange={(e) => patch({ strategy: e.target.value as any })}
            >
              <option value="adaptive">自适应(低并发粘账号,高并发分摊)</option>
              <option value="weighted-least-inflight">加权最少处理中(始终分摊)</option>
              <option value="sticky">粘性(旧行为,挤一个)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-ink-500 mb-1 inline-flex items-center">
              粘性阈值(处理中 &lt; 此值才粘账号)
              <InfoTip text={"账号当前『处理中』请求数低于此值时,新请求继续打到同一账号,以命中 Anthropic 的 prompt 缓存、降低延迟与成本;超过此值即视为该账号拥堵,调度器把请求溢出分摊到其他账号。\n\n调大 = 更省:更黏一个账号、缓存命中高,但单账号易先打满限流。\n调小 = 更稳:更早分摊、并发更均衡,但缓存命中率下降。\n\n默认 4 适合多数场景;压测/批量可调到 1~2 尽快摊开。仅对『自适应』策略生效。"} />
            </label>
            <input
              className="input !py-1"
              type="number"
              min="1"
              value={cfg["stick-while-inflight-below"]}
              onChange={(e) =>
                patch({ "stick-while-inflight-below": Number(e.target.value) })
              }
            />
          </div>
          <div>
            <label className="block text-xs text-ink-500 mb-1 inline-flex items-center">
              每账号并发上限(0 = 不限)
              <InfoTip text="单个账号同时『处理中』的请求数硬上限。达到后该账号不再接新请求,溢出请求改派其他账号;全部账号都满则快速返回 429(带 Retry-After),避免把请求堆在某个账号上拖垮它、触发上游限流冷却。0 表示不设上限。" />
            </label>
            <input
              className="input !py-1"
              type="number"
              min="0"
              value={cfg["per-account-max-inflight"]}
              onChange={(e) =>
                patch({ "per-account-max-inflight": Number(e.target.value) })
              }
            />
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={cfg["use-5h-utilization"]}
              onChange={(e) => patch({ "use-5h-utilization": e.target.checked })}
            />
            <span className="inline-flex items-center">
              纳入 5 小时窗口利用率打分
              <InfoTip text={"开启后,选账号不只看『处理中』请求数,还把各账号上游 5 小时滚动窗口的已用额度计入打分:剩余额度越少的账号越不优先,从而提前避开快打满限流的账号、让用量在账号间更均衡。\n\n数据来自上游返回的 unified-5h-utilization,仅 Anthropic 订阅账号有;无此数据的账号(Codex/Cursor)按纯并发分摊,不受影响。\n\n关闭则只按加权处理中数分摊。"} />
            </span>
          </label>
          <div className="md:col-span-2 flex items-center gap-3">
            <button className="btn-primary text-sm" onClick={save} disabled={saving}>
              {saving ? "保存中..." : "保存设置"}
            </button>
            {msg && <span className="text-ink-400 text-sm">{msg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Prewarm scheduler card ─────────────────────────────────── */

function PrewarmCard() {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<PrewarmConfig | null>(null);
  const [runs, setRuns] = useState<PrewarmRun[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [prewarming, setPrewarming] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const loadHistory = useCallback(async (reset = true) => {
    try {
      const r = await fetchPrewarmHistory({
        limit: 20,
        cursor: reset ? null : cursor,
      });
      setRuns((prev) => (reset ? r.runs : [...prev, ...r.runs]));
      setCursor(r.nextCursor);
      setHasMore(r.nextCursor != null);
    } catch {
      if (reset) setRuns([]);
    }
  }, [cursor]);

  useEffect(() => {
    fetchPrewarmConfig().then(setCfg).catch(() => setCfg(null));
    loadHistory(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function patch(p: Partial<PrewarmConfig>) {
    setCfg((c) => (c ? { ...c, ...p } : c));
  }
  function setTime(i: number, v: string) {
    setCfg((c) =>
      c ? { ...c, times: c.times.map((t, j) => (j === i ? v : t)) } : c,
    );
  }
  function addTime() {
    setCfg((c) => (c ? { ...c, times: [...c.times, "13:00"] } : c));
  }
  function removeTime(i: number) {
    setCfg((c) => (c ? { ...c, times: c.times.filter((_, j) => j !== i) } : c));
  }
  function applyRecommended() {
    patch({ enabled: true, times: ["08:00"] });
  }

  async function save() {
    if (!cfg) return;
    setSaving(true);
    setMsg(null);
    try {
      const next = await updatePrewarmConfig({
        enabled: cfg.enabled,
        times: cfg.times,
      });
      setCfg(next);
      setMsg("已保存");
      setTimeout(() => setMsg(null), 2000);
    } catch (e) {
      setMsg(`保存失败: ${(e as ApiError).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    setPrewarming(true);
    setMsg(null);
    try {
      await prewarm();
      await loadHistory(true);
    } catch (e) {
      setMsg(`暖机失败: ${(e as ApiError).message}`);
    } finally {
      setPrewarming(false);
    }
  }

  const lastRun = runs[0];

  // ── 执行情况表(按天 × 计划时刻)──
  const scheduledRuns = useMemo(
    () => runs.filter((r) => r.trigger === "schedule" && r.scheduledTime),
    [runs],
  );
  const manualRuns = useMemo(
    () => runs.filter((r) => r.trigger === "manual"),
    [runs],
  );
  // Columns = configured times ∪ any scheduledTime seen in history (so renamed
  // schedules still show their past runs).
  const cols = useMemo(() => {
    const s = new Set<string>(cfg?.times ?? []);
    for (const r of scheduledRuns) if (r.scheduledTime) s.add(r.scheduledTime);
    return [...s].sort();
  }, [cfg?.times, scheduledRuns]);
  // Rows = days seen in history + today, newest first.
  const days = useMemo(() => {
    const s = new Set<string>(scheduledRuns.map((r) => localDate(r.at)));
    s.add(localDate(new Date().toISOString()));
    return [...s].sort().reverse();
  }, [scheduledRuns]);
  const cellRun = (day: string, time: string) =>
    scheduledRuns.find(
      (r) => localDate(r.at) === day && r.scheduledTime === time,
    );

  return (
    <div className="card">
      <button
        className="flex items-center justify-between w-full text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="font-medium inline-flex items-center">
          ⚡ 窗口暖机调度 (Prewarm)
          <InfoTip text={PREWARM_ALGO_TIP} />
          {cfg && (
            <span
              className={`ml-2 text-xs ${cfg.enabled ? "badge-ok" : "badge-muted"}`}
            >
              {cfg.enabled ? `已启用 · ${cfg.times.join(" / ") || "无时间"}` : "已停用"}
            </span>
          )}
        </span>
        <span className="text-ink-500 text-sm">{open ? "收起" : "展开"}</span>
      </button>

      {open && cfg && (
        <div className="mt-4 space-y-4 text-sm">
          <p className="text-ink-400 leading-relaxed">
            5h 限流窗口按『首条消息锚定』。每天定时发一条几乎零成本的 ping 主动开窗,
            让窗口边界对齐工作时段而非随机落点 —— 工作时段尽量跨越 2 个完整窗口,
            理论可用配额上限相比冷启动约 <span className="text-ink-200">+80%</span>。
            悬停标题旁的 ⓘ 看完整算法。
          </p>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={cfg.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            <span>启用定时暖机</span>
          </label>

          <div>
            <div className="text-xs text-ink-500 mb-1.5 inline-flex items-center">
              触发时间(服务器本地时间,每个时间点每天触发一次)
              <InfoTip text="每天到点自动给所有支持暖机的账号发一次 ping。常见配置:仅 08:00(上班前开窗);08:00 + 13:00(严格保证两个窗口都准点锚定)。" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {cfg.times.map((t, i) => (
                <span key={i} className="inline-flex items-center gap-1">
                  <input
                    type="time"
                    className="input !py-1 !w-auto"
                    value={t}
                    onChange={(e) => setTime(i, e.target.value)}
                  />
                  <button
                    className="text-ink-500 hover:text-rose-400 text-sm px-1"
                    onClick={() => removeTime(i)}
                    title="删除该时间点"
                  >
                    ✕
                  </button>
                </span>
              ))}
              <button className="btn-secondary text-sm" onClick={addTime}>
                + 添加时间
              </button>
            </div>
            {cfg.times.length === 0 && (
              <div className="text-amber-400 text-xs mt-1">
                未设置任何时间 —— 即使启用也不会触发。
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button className="btn-primary text-sm" onClick={save} disabled={saving}>
              {saving ? "保存中..." : "保存设置"}
            </button>
            <button className="btn-secondary text-sm" onClick={applyRecommended}>
              套用推荐(启用 · 08:00)
            </button>
            <button
              className="btn-secondary text-sm"
              onClick={runNow}
              disabled={prewarming}
            >
              {prewarming ? "暖机中..." : "▶ 立即暖机一次"}
            </button>
            {msg && <span className="text-ink-400 text-sm">{msg}</span>}
          </div>

          {/* 暖机执行审计:定时任务到点跑没跑 + 结果 */}
          <div className="border-t border-ink-800 pt-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-ink-300 font-medium inline-flex items-center">
                定时执行情况
                <InfoTip text={"按『日期 × 计划时刻』核对定时任务有没有按时跑。\n\n✓ 按时执行(显示成功/总数)· ⚠ 部分成功 · ✗ 失败 · ✗漏跑 = 到点了却没有任何记录(进程当时未运行/未触发)· · 待跑(今天尚未到的时刻)。\n\n手动触发单列在下方,不计入按时考核。记录持久化,跨重启保留。"} />
              </span>
              <button
                className="text-ink-500 hover:text-ink-300 text-xs"
                onClick={() => loadHistory(true)}
              >
                ↻ 刷新
              </button>
            </div>

            {runs.length === 0 && (
              <div className="text-ink-500 text-sm">
                暂无记录 —— 尚未触发过暖机(定时或手动)。
              </div>
            )}

            {/* 执行情况表 */}
            {cols.length > 0 && (
              <div className="overflow-x-auto">
                <table className="text-sm">
                  <thead className="text-ink-500 text-xs">
                    <tr>
                      <th className="text-left font-medium px-2 py-1">日期</th>
                      {cols.map((t) => (
                        <th key={t} className="font-medium px-2 py-1">
                          {t}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {days.map((day) => (
                      <tr key={day} className="border-t border-ink-800/60">
                        <td className="px-2 py-1 text-ink-400 whitespace-nowrap">
                          {day}
                        </td>
                        {cols.map((t) => {
                          const run = cellRun(day, t);
                          if (run) {
                            const full = run.total > 0 && run.ok === run.total;
                            const none = run.ok === 0;
                            const cls = full
                              ? "text-emerald-400"
                              : none
                                ? "text-rose-400"
                                : "text-amber-400";
                            const mark = full ? "✓" : none ? "✗" : "⚠";
                            return (
                              <td
                                key={t}
                                className={`px-2 py-1 text-center ${cls}`}
                                title={`实际 ${localClock(run.at)} · ${run.ok}/${run.total} 成功`}
                              >
                                {run.total === 0 ? "⚠ 无账号" : `${mark} ${run.ok}/${run.total}`}
                              </td>
                            );
                          }
                          // no run for this slot
                          if (isPastSlot(day, t)) {
                            return (
                              <td
                                key={t}
                                className="px-2 py-1 text-center text-rose-400/80"
                                title="到点未见任何记录(进程当时未运行或未触发)"
                              >
                                ✗ 漏跑
                              </td>
                            );
                          }
                          return (
                            <td key={t} className="px-2 py-1 text-center text-ink-600">
                              ·
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* 最近一次的逐账号结果详情 */}
            {lastRun && (
              <div className="mt-3">
                <div className="text-xs text-ink-400 mb-1.5">
                  最近一次 ·{" "}
                  <span
                    className={
                      lastRun.trigger === "schedule"
                        ? "badge-ok text-xs"
                        : "badge-muted text-xs"
                    }
                  >
                    {lastRun.trigger === "schedule"
                      ? `定时 ${lastRun.scheduledTime ?? ""}`
                      : "手动"}
                  </span>{" "}
                  · {fmtRelative(lastRun.at)}({localClock(lastRun.at)}) · 成功{" "}
                  {lastRun.ok}/{lastRun.total}
                </div>
                <div className="space-y-1">
                  {lastRun.providers.flatMap((p) => {
                    if (p.results.length === 0) {
                      return [
                        <div
                          key={p.provider}
                          className="flex items-center gap-2 text-sm"
                        >
                          <span className="badge-muted text-xs">{p.provider}</span>
                          <span className="text-ink-500">
                            {p.error ? p.error : "无可暖机的账号"}
                          </span>
                        </div>,
                      ];
                    }
                    return p.results.map((r) => {
                      const o = prewarmOutcome(r);
                      return (
                        <div
                          key={`${p.provider}:${r.email}`}
                          className="flex items-center gap-2 text-sm"
                        >
                          <span className="badge-muted text-xs">{p.provider}</span>
                          <span className="font-mono text-ink-300">{r.email}</span>
                          <span className={o.tone}>· {o.label}</span>
                        </div>
                      );
                    });
                  })}
                </div>
              </div>
            )}

            {/* 手动触发(不计入按时考核)*/}
            {manualRuns.length > 0 && (
              <div className="mt-3 text-xs text-ink-500">
                <div className="text-ink-400 mb-1">手动触发:</div>
                <div className="space-y-0.5">
                  {manualRuns.slice(0, 8).map((r) => (
                    <div key={r.id ?? r.at} className="flex items-center gap-2">
                      <span className="text-ink-400">
                        {localDate(r.at)} {localClock(r.at)}
                      </span>
                      <span
                        className={
                          r.ok === r.total ? "text-emerald-400" : "text-amber-400"
                        }
                      >
                        {r.ok}/{r.total}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {hasMore && (
              <button
                className="mt-2 text-ink-400 hover:text-ink-200 text-xs"
                onClick={() => loadHistory(false)}
              >
                加载更多历史 ↓
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── MCP 服务(聚合网关上游)管理卡 ───────────────────────── */

function mcpHealthBadge(h: McpServerView["health"]): { cls: string; text: string } {
  switch (h.status) {
    case "connected":
      return { cls: "badge-ok", text: `已连接 · ${h.toolCount ?? "?"} 工具` };
    case "connecting":
      return { cls: "badge-muted", text: "连接中…" };
    case "error":
      return { cls: "badge-err", text: "连接失败" };
    default:
      return { cls: "badge-muted", text: "已停用" };
  }
}

function McpCard() {
  const [open, setOpen] = useState(false);
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [editing, setEditing] = useState<
    { mode: "new" } | { mode: "edit"; server: McpServerView } | null
  >(null);
  const [probing, setProbing] = useState<string | null>(null);
  const [viewingTools, setViewingTools] = useState<McpServerView | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchMcpServers()
      .then((r) => setServers(r.servers))
      .catch(() => setServers([]));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function onProbe(id: string) {
    setProbing(id);
    try {
      await probeMcpServer(id);
      load();
    } catch (e) {
      setMsg(`探活失败: ${(e as ApiError).message}`);
    } finally {
      setProbing(null);
    }
  }

  async function onDelete(s: McpServerView) {
    if (!confirm(`删除 MCP 服务 "${s.label}" (${s.id})? 已授权此类目的 key 将失去访问。`)) return;
    try {
      await deleteMcpServer(s.id);
      load();
    } catch (e) {
      setMsg(`删除失败: ${(e as ApiError).message}`);
    }
  }

  return (
    <div className="card">
      <button
        className="flex items-center justify-between w-full text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="font-medium inline-flex items-center">
          🧩 MCP 服务(聚合网关)
          <InfoTip text={"注册上游 MCP 服务(每个=一个『类目』)。auth2api 把它们聚合到统一 MCP 端点,客户端用 key 访问已授权的类目。\n\n本期支持 Streamable HTTP / SSE 远程 MCP;stdio(本地进程)后续。\n\n默认拒绝:key 需在『用户』页显式勾选类目才能看到 / 调用。"} />
          {servers && (
            <span className="ml-2 text-xs text-ink-500 font-normal">
              {servers.length} 个
            </span>
          )}
        </span>
        <span className="text-ink-500 text-sm">{open ? "收起" : "展开"}</span>
      </button>

      {open && (
        <div className="mt-4 space-y-3 text-sm">
          {servers === null && <div className="text-ink-500">加载中…</div>}
          {servers && servers.length === 0 && (
            <div className="text-ink-500">尚未注册任何 MCP 服务。</div>
          )}
          {servers && servers.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-ink-500">
                  <tr>
                    <th className="text-left font-medium px-2 py-1">类目 id</th>
                    <th className="text-left font-medium px-2 py-1">名称</th>
                    <th className="text-left font-medium px-2 py-1">传输</th>
                    <th className="text-left font-medium px-2 py-1">地址</th>
                    <th className="text-left font-medium px-2 py-1">状态</th>
                    <th className="px-2 py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {servers.map((s) => {
                    const b = mcpHealthBadge(s.health);
                    return (
                      <tr key={s.id} className="border-t border-ink-800/60">
                        <td className="px-2 py-1 font-mono text-ink-300">{s.id}</td>
                        <td className="px-2 py-1 text-ink-200">{s.label}</td>
                        <td className="px-2 py-1 text-ink-400">{s.transport}</td>
                        <td className="px-2 py-1 text-ink-400 font-mono max-w-[16rem] truncate" title={s.url}>
                          {s.url}
                        </td>
                        <td className="px-2 py-1">
                          <span className={`${b.cls} text-xs`} title={s.health.lastError || ""}>
                            {b.text}
                          </span>
                        </td>
                        <td className="px-2 py-1 text-right whitespace-nowrap space-x-1">
                          <button
                            className="btn-ghost text-xs"
                            onClick={() => onProbe(s.id)}
                            disabled={probing === s.id}
                          >
                            {probing === s.id ? "探活…" : "↻ 探活"}
                          </button>
                          <button
                            className="btn-ghost text-xs"
                            onClick={() => setViewingTools(s)}
                          >
                            工具
                          </button>
                          <button
                            className="btn-ghost text-xs"
                            onClick={() => setEditing({ mode: "edit", server: s })}
                          >
                            编辑
                          </button>
                          <button
                            className="btn-ghost text-xs text-rose-400 hover:text-rose-300"
                            onClick={() => onDelete(s)}
                          >
                            删除
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center gap-3">
            <button className="btn-primary text-sm" onClick={() => setEditing({ mode: "new" })}>
              + 新增 MCP 服务
            </button>
            {msg && <span className="text-ink-400 text-xs">{msg}</span>}
          </div>
        </div>
      )}

      {editing && (
        <McpServerModal
          edit={editing.mode === "edit" ? editing.server : null}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {viewingTools && (
        <McpToolsModal server={viewingTools} onClose={() => setViewingTools(null)} />
      )}
    </div>
  );
}

function McpToolsModal({
  server,
  onClose,
}: {
  server: McpServerView;
  onClose: () => void;
}) {
  const [tools, setTools] = useState<McpTool[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetchMcpTools(server.id)
      .then((r) => {
        setTools(r.tools);
        if (r.error) setErr(r.error);
      })
      .catch((e) => setErr((e as ApiError).message));
  }, [server.id]);
  return (
    <Modal open onClose={onClose} title={`${server.label} 的工具`} size="lg">
      <div className="text-sm space-y-2">
        {tools === null && !err && <div className="text-ink-500">加载中…</div>}
        {err && <div className="text-rose-400 text-xs">上游返回:{err}</div>}
        {tools && tools.length === 0 && !err && (
          <div className="text-ink-500">该服务未暴露工具。</div>
        )}
        {tools && tools.length > 0 && (
          <>
            <div className="text-xs text-ink-500">
              共 {tools.length} 个。工具名对外形如{" "}
              <code>{server.id}__&lt;工具&gt;</code>。授权时可整类目或按单个工具勾选(在「用户」页)。
            </div>
            <div className="max-h-96 overflow-auto divide-y divide-ink-800/60">
              {tools.map((t) => (
                <div key={t.name} className="py-1.5">
                  <div className="font-mono text-ink-200 text-xs">{t.name}</div>
                  {t.description && (
                    <div className="text-ink-500 text-xs mt-0.5 line-clamp-2">{t.description}</div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function McpServerModal({
  edit,
  onClose,
  onSaved,
}: {
  edit: McpServerView | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [id, setId] = useState(edit?.id ?? "");
  const [label, setLabel] = useState(edit?.label ?? "");
  const [transport, setTransport] = useState<McpTransport>(edit?.transport ?? "streamable-http");
  const [url, setUrl] = useState(edit?.url ?? "");
  const [headersText, setHeadersText] = useState("");
  const [enabled, setEnabled] = useState(edit?.enabled ?? true);
  const [jsonText, setJsonText] = useState("");
  const [jsonMsg, setJsonMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Parse common MCP config JSON shapes and fill the form. Accepts a full
  // { "mcpServers": { "<id>": {...} } } object, or a single server object.
  function importFromJson() {
    setJsonMsg(null);
    let obj: any;
    try {
      obj = JSON.parse(jsonText);
    } catch {
      setJsonMsg("JSON 解析失败");
      return;
    }
    let sid = "";
    let s: any = obj;
    if (obj && obj.mcpServers && typeof obj.mcpServers === "object") {
      const keys = Object.keys(obj.mcpServers);
      if (keys.length === 0) {
        setJsonMsg("mcpServers 为空");
        return;
      }
      sid = keys[0];
      s = obj.mcpServers[sid];
    } else if (obj && typeof obj === "object" && obj.id) {
      sid = String(obj.id);
    }
    const rawUrl = s.url || s.serverUrl || s.base_url || s.baseUrl || s.href;
    if (!rawUrl) {
      setJsonMsg("未找到 url(支持 url / serverUrl / base_url)");
      return;
    }
    const rawType = String(s.type || s.transport || "").toLowerCase();
    const tp: McpTransport = rawType.includes("sse") ? "sse" : "streamable-http";
    const hdrs = s.headers || s.env_http_headers || s.env || {};
    if (!edit && sid) setId(sid);
    if (sid) setLabel((l) => l || sid);
    setUrl(rawUrl);
    setTransport(tp);
    if (hdrs && typeof hdrs === "object") {
      const lines = Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`);
      if (lines.length) setHeadersText(lines.join("\n"));
    }
    setJsonMsg("已填充,请核对下方字段(尤其密钥)后保存");
  }

  function parseHeaders(): Record<string, string> | undefined {
    const lines = headersText.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return undefined; // untouched → keep existing (edit)
    const out: Record<string, string> = {};
    for (const line of lines) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
  }

  async function save() {
    setBusy(true);
    setErr(null);
    const input: McpServerInput = { label, transport, url, enabled };
    const headers = parseHeaders();
    if (headers) input.headers = headers;
    try {
      if (edit) {
        await updateMcpServer(edit.id, input);
      } else {
        input.id = id;
        await createMcpServer(input);
      }
      onSaved();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={edit ? `编辑 MCP 服务 ${edit.id}` : "新增 MCP 服务"} size="lg">
      <div className="space-y-3 text-sm">
        <details className="rounded-md border border-ink-800 p-2">
          <summary className="cursor-pointer text-ink-400 hover:text-ink-200 text-xs">
            📋 从 JSON 粘贴导入(mcpServers 配置 / 单个服务对象)
          </summary>
          <div className="mt-2 space-y-2">
            <textarea
              className="input w-full font-mono text-xs h-24"
              placeholder={'{"mcpServers":{"gitlab":{"url":"http://.../mcp","headers":{"Private-Token":"glpat-xxx"}}}}'}
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <button className="btn-secondary text-xs" onClick={importFromJson} disabled={!jsonText.trim()}>
                解析并填充
              </button>
              {jsonMsg && <span className="text-ink-400 text-xs">{jsonMsg}</span>}
            </div>
          </div>
        </details>
        <div>
          <label className="block text-xs text-ink-500 mb-1">类目 id(小写字母/数字/-_,创建后不可改)</label>
          <input
            className="input !py-1 font-mono"
            value={id}
            disabled={!!edit}
            placeholder="gitlab"
            onChange={(e) => setId(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-ink-500 mb-1">名称</label>
          <input className="input !py-1" value={label} placeholder="GitLab" onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-ink-500 mb-1">传输</label>
            <select className="input !py-1" value={transport} onChange={(e) => setTransport(e.target.value as McpTransport)}>
              <option value="streamable-http">streamable-http</option>
              <option value="sse">sse</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs text-ink-500 mb-1">地址 URL</label>
            <input
              className="input !py-1 font-mono"
              value={url}
              placeholder="http://172.18.11.231:3333/mcp"
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
        </div>
        <div>
          <label className="block text-xs text-ink-500 mb-1 inline-flex items-center">
            上游鉴权 Headers(每行 <code className="mx-1">Name: value</code>)
            <InfoTip text={edit ? "留空 = 保持原有(密钥不回显)。填写则整体替换。" : "上游 MCP 需要的鉴权头,如 Private-Token: xxxx。视为密钥,存储加密目录、不回显、日志脱敏。"} />
          </label>
          <textarea
            className="input w-full font-mono text-xs h-20"
            value={headersText}
            placeholder={edit && edit.headerKeys.length ? `原有:${edit.headerKeys.join(", ")}(留空保持)` : "Private-Token: glpat-xxxx"}
            onChange={(e) => setHeadersText(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          启用(连接并纳入聚合)
        </label>
        <div className="flex items-center gap-3">
          <button className="btn-primary text-sm" onClick={save} disabled={busy || (!edit && !id) || !url}>
            {busy ? "保存中…" : "保存"}
          </button>
          {err && <span className="text-rose-400 text-xs">{err}</span>}
        </div>
      </div>
    </Modal>
  );
}

/* ─── Logging settings card ──────────────────────────────────── */

function LoggingCard() {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<LoggingConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetchLoggingConfig().then(setCfg).catch(() => setCfg(null));
  }, []);

  function patch(p: Partial<LoggingConfig>) {
    setCfg((c) => (c ? { ...c, ...p } : c));
  }
  function patchRetention(p: Partial<LoggingConfig["retention"]>) {
    setCfg((c) => (c ? { ...c, retention: { ...c.retention, ...p } } : c));
  }
  function patchCategories(p: Partial<LoggingConfig["categories"]>) {
    setCfg((c) => (c ? { ...c, categories: { ...c.categories, ...p } } : c));
  }

  async function save() {
    if (!cfg) return;
    setSaving(true);
    setMsg(null);
    try {
      const next = await updateLoggingConfig(cfg);
      setCfg(next);
      setMsg("已保存");
      setTimeout(() => setMsg(null), 2000);
    } catch (e) {
      setMsg(`保存失败: ${(e as ApiError).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <button
        className="flex items-center justify-between w-full text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="font-medium">⚙️ 日志设置</span>
        <span className="text-ink-500 text-sm">{open ? "收起" : "展开"}</span>
      </button>
      {open && cfg && (
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={cfg.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            启用日志
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={cfg.redact}
              onChange={(e) => patch({ redact: e.target.checked })}
            />
            脱敏(剥离 sk-/Bearer/JWT)
          </label>
          <div>
            <label className="block text-xs text-ink-500 mb-1">记录范围</label>
            <select
              className="input !py-1"
              value={cfg.capture}
              onChange={(e) => patch({ capture: e.target.value as any })}
            >
              <option value="failures">仅失败</option>
              <option value="all">全部请求</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-ink-500 mb-1">错误详情</label>
            <select
              className="input !py-1"
              value={cfg["error-detail"]}
              onChange={(e) => patch({ "error-detail": e.target.value as any })}
            >
              <option value="full">全文</option>
              <option value="snippet">片段</option>
              <option value="off">不记</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-ink-500 mb-1">片段长度</label>
            <input
              className="input !py-1"
              type="number"
              min="50"
              value={cfg["snippet-length"]}
              onChange={(e) => patch({ "snippet-length": Number(e.target.value) })}
            />
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={cfg["store-request-id"]}
              onChange={(e) => patch({ "store-request-id": e.target.checked })}
            />
            存 request_id
          </label>

          <div className="md:col-span-2">
            <label className="block text-xs text-ink-500 mb-1">
              记录类别(关掉的不入库 — 默认只记真错)
            </label>
            <div className="flex flex-wrap gap-3">
              {([
                ["upstream", "模型/上游报错"],
                ["service", "本服务报错"],
                ["policy", "策略拒绝(配额/白名单/限流)"],
                ["client", "客户端断开/坏请求"],
                ["mcp", "MCP 工具调用(审计留痕)"],
              ] as const).map(([k, txt]) => (
                <label key={k} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={cfg.categories[k]}
                    onChange={(e) => patchCategories({ [k]: e.target.checked })}
                  />
                  {txt}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs text-ink-500 mb-1">保留天数</label>
            <input
              className="input !py-1"
              type="number"
              min="0"
              value={cfg.retention["max-age-days"]}
              onChange={(e) => patchRetention({ "max-age-days": Number(e.target.value) })}
            />
          </div>
          <div>
            <label className="block text-xs text-ink-500 mb-1">行数上限</label>
            <input
              className="input !py-1"
              type="number"
              min="0"
              value={cfg.retention["max-rows"]}
              onChange={(e) => patchRetention({ "max-rows": Number(e.target.value) })}
            />
          </div>
          <div>
            <label className="block text-xs text-ink-500 mb-1">清理间隔(分钟)</label>
            <input
              className="input !py-1"
              type="number"
              min="1"
              value={cfg.retention["cleanup-interval-minutes"]}
              onChange={(e) =>
                patchRetention({ "cleanup-interval-minutes": Number(e.target.value) })
              }
            />
          </div>
          <div className="md:col-span-2 flex items-center gap-3">
            <button className="btn-primary text-sm" onClick={save} disabled={saving}>
              {saving ? "保存中..." : "保存设置"}
            </button>
            {msg && <span className="text-ink-400 text-sm">{msg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
