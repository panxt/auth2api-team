import { useEffect, useState, useCallback } from "react";
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
          负载均衡、窗口暖机、日志策略。改动即时持久化并热生效,无需重启。仅 admin 可见。
        </p>
      </header>
      <div className="space-y-4">
        <RoutingCard />
        <PrewarmCard />
        <LoggingCard />
      </div>
    </div>
  );
}

/* ─── Routing settings card ──────────────────────────────────── */

function RoutingCard() {
  const [open, setOpen] = useState(true);
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
  const [open, setOpen] = useState(true);
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

          {/* 实际暖机结果 / 历史 */}
          <div className="border-t border-ink-800 pt-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-ink-300 font-medium">暖机日志(历史持久化)</span>
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

            {lastRun && (
              <div className="mb-3">
                <div className="text-xs text-ink-400 mb-1.5">
                  最近一次 ·{" "}
                  <span
                    className={
                      lastRun.trigger === "schedule"
                        ? "badge-ok text-xs"
                        : "badge-muted text-xs"
                    }
                  >
                    {lastRun.trigger === "schedule" ? "定时" : "手动"}
                  </span>{" "}
                  · {fmtRelative(lastRun.at)} · 成功 {lastRun.ok}/{lastRun.total}
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

            {runs.length > 1 && (
              <div className="text-xs text-ink-500">
                <div className="text-ink-400 mb-1">历史记录:</div>
                <div className="space-y-0.5">
                  {runs.slice(1).map((r) => (
                    <div key={r.id ?? r.at} className="flex items-center gap-2">
                      <span className="w-10">
                        {r.trigger === "schedule" ? "定时" : "手动"}
                      </span>
                      <span className="text-ink-400">{fmtRelative(r.at)}</span>
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
                {hasMore && (
                  <button
                    className="mt-2 text-ink-400 hover:text-ink-200"
                    onClick={() => loadHistory(false)}
                  >
                    加载更多 ↓
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
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
