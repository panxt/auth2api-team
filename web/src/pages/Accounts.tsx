import { useEffect, useState, useCallback } from "react";
import {
  listAccounts,
  prewarm,
  deleteAccount,
  setAccountDisabled,
  setAccountBudget,
  AccountSnapshot,
  CapacitySummary,
  PrewarmResp,
} from "../api/accounts";
import { fetchStats } from "../api/stats";
import { fetchRoutingConfig, updateRoutingConfig, RoutingConfig } from "../api/routing";
import {
  fetchPrewarmConfig,
  updatePrewarmConfig,
  fetchPrewarmHistory,
  PrewarmConfig,
  PrewarmRun,
} from "../api/prewarm";
import { ApiError } from "../api/client";
import { AddAccountModal } from "../components/AddAccountModal";
import { AccountQuotaPanel, InfoTip } from "../components/AccountQuotaPanel";
import { Modal } from "../components/Modal";
import { useAuth } from "../lib/auth";
import { SupportedProvider } from "../api/oauth";

function fmtUsd(n: number): string {
  if (!n) return "$0";
  if (n >= 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function fmtTokens(n: number): string {
  if (!n) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / 86400_000)} 天前`;
}

function cooldownStatus(acct: AccountSnapshot): {
  badge: string;
  className: string;
  detail?: string;
} {
  const now = Date.now();
  if (acct.disabled) {
    return { badge: "disabled", className: "badge-muted" };
  }
  if (acct.cooldownUntil > now) {
    const remainMs = acct.cooldownUntil - now;
    const remainMin = Math.ceil(remainMs / 60_000);
    return {
      badge: `cooldown ${remainMin}min`,
      className: "badge-warn",
      detail: acct.lastError || undefined,
    };
  }
  if (!acct.available) {
    return { badge: "unavailable", className: "badge-err" };
  }
  return { badge: "ok", className: "badge-ok" };
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
  // Fallback: pull a clean message out of any embedded JSON, else truncate.
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

export function Accounts() {
  const { whoami } = useAuth();
  const isAdmin = !!whoami?.admin;

  const [data, setData] = useState<Record<string, AccountSnapshot[]>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [prewarming, setPrewarming] = useState(false);
  const [lastPrewarm, setLastPrewarm] = useState<PrewarmResp | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [reauth, setReauth] = useState<{
    provider: SupportedProvider;
    email: string;
  } | null>(null);
  const [budgetEdit, setBudgetEdit] = useState<{
    provider: string;
    acct: AccountSnapshot;
  } | null>(null);
  // Month-to-date cost per account, keyed by "provider:email" (from stats).
  const [monthCost, setMonthCost] = useState<Record<string, number>>({});
  // Per-provider capacity summary → drives the "上游已打满" alert.
  const [capacity, setCapacity] = useState<Record<string, CapacitySummary>>({});
  // "实时" — poll every 2s instead of 30s to watch concurrency spread live.
  const [realtime, setRealtime] = useState(false);

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    setErr(null);
    try {
      const [resp, stats] = await Promise.all([
        listAccounts(),
        // byAccount cost for the current month → drives the budget bars.
        fetchStats({ window: "month" }).catch(() => null),
      ]);
      const byProvider: Record<string, AccountSnapshot[]> = {};
      const caps: Record<string, CapacitySummary> = {};
      for (const [p, info] of Object.entries(resp.providers)) {
        if (info.account_count > 0) byProvider[p] = info.accounts;
        if (info.capacity) caps[p] = info.capacity;
      }
      setData(byProvider);
      setCapacity(caps);
      if (stats) {
        const costs: Record<string, number> = {};
        for (const [k, b] of Object.entries(stats.byAccount)) {
          costs[k] = b.totalCostUsd;
        }
        setMonthCost(costs);
      }
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      if (initial) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(true);
    // poll for fresh cooldown / in-flight counters; faster in realtime mode.
    const t = setInterval(() => load(false), realtime ? 2000 : 30_000);
    return () => clearInterval(t);
  }, [load, realtime]);

  async function onPrewarm() {
    setPrewarming(true);
    setLastPrewarm(null);
    try {
      const resp = await prewarm();
      setLastPrewarm(resp);
      // refresh account view after a moment so lastSuccessAt shows the ping
      setTimeout(load, 500);
    } catch (e) {
      alert(`prewarm 失败: ${(e as ApiError).message}`);
    } finally {
      setPrewarming(false);
    }
  }

  async function onToggleDisabled(providerId: string, acct: AccountSnapshot) {
    const target = !acct.disabled;
    if (target && !confirm(`停用 ${acct.email}? 停用后不再被分配新请求,可重新启用。`)) return;
    try {
      await setAccountDisabled(providerId, acct.email, target);
      load();
    } catch (e) {
      alert(`操作失败: ${(e as ApiError).message}`);
    }
  }

  async function onDelete(providerId: string, acct: AccountSnapshot) {
    if (
      !confirm(
        `永久删除 ${acct.email}? 不可逆 — 内存 + token 文件都会清掉。\n如需保留 token,改用"停用"。`,
      )
    )
      return;
    try {
      await deleteAccount(providerId, acct.email);
      load();
    } catch (e) {
      alert(`删除失败: ${(e as ApiError).message}`);
    }
  }

  function onReauth(providerId: string, acct: AccountSnapshot) {
    if (providerId !== "anthropic" && providerId !== "codex") {
      alert(
        "Cursor 走 deep-link PKCE,无法在 UI 重新认证 — 用 CLI:\n  npm run login -- --provider=cursor",
      );
      return;
    }
    setReauth({ provider: providerId as SupportedProvider, email: acct.email });
  }

  async function onSaveBudget(
    provider: string,
    email: string,
    monthlyBudgetUsd: number | null,
    tierLabel: string | null,
    concurrencyWeight: number | null,
  ) {
    try {
      await setAccountBudget(provider, email, {
        monthlyBudgetUsd,
        tierLabel,
        concurrencyWeight,
      });
      setBudgetEdit(null);
      setTimeout(() => load(false), 300);
    } catch (e) {
      alert(`保存失败: ${(e as ApiError).message}`);
    }
  }

  return (
    <div>
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">
            上游账号
            {!isAdmin && (
              <span className="ml-2 align-middle badge-muted text-xs">只读模式</span>
            )}
          </h1>
          <p className="text-sm text-ink-400 mt-1">
            {isAdmin
              ? "每个 OAuth 账号当前状态 + 累计统计。点 prewarm 可立即把所有 anthropic 账号的 5h 窗口往前对齐。"
              : "每个 OAuth 账号当前状态 + 累计统计。新增账号 / Prewarm 需 admin 权限,请联系管理员。"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm text-ink-400">
            <input
              type="checkbox"
              checked={realtime}
              onChange={(e) => setRealtime(e.target.checked)}
            />
            实时(2s)
          </label>
        {isAdmin && (
          <div className="flex gap-2">
            <button
              className="btn-secondary"
              onClick={() => setShowAdd(true)}
            >
              + 新增账号
            </button>
            <button
              className="btn-primary"
              onClick={onPrewarm}
              disabled={prewarming}
            >
              {prewarming ? "Prewarming..." : "⚡ 立即 Prewarm"}
            </button>
          </div>
        )}
        </div>
      </header>

      {/* 上游容量告警 + 解决办法 */}
      <CapacityAlerts capacity={capacity} onAdd={() => setShowAdd(true)} isAdmin={isAdmin} />

      {isAdmin && <RoutingCard />}

      {isAdmin && <PrewarmCard onManualRun={onPrewarm} prewarming={prewarming} />}

      {isAdmin && (
        <>
          <AddAccountModal
            open={showAdd}
            onClose={() => setShowAdd(false)}
            onAdded={() => {
              // Refresh after a moment so the new account appears.
              setTimeout(() => load(false), 500);
            }}
          />
          <AddAccountModal
            open={!!reauth}
            onClose={() => setReauth(null)}
            onAdded={() => {
              setReauth(null);
              setTimeout(load, 500);
            }}
            reauthProvider={reauth?.provider}
            reauthEmail={reauth?.email}
          />
          <BudgetModal
            edit={budgetEdit}
            onClose={() => setBudgetEdit(null)}
            onSave={onSaveBudget}
          />
        </>
      )}

      {lastPrewarm && (
        <div className="card mb-6">
          <div className="text-sm text-ink-300 mb-2 font-medium">
            上次 prewarm 结果
          </div>
          <div className="space-y-1">
            {lastPrewarm.providers.flatMap((p) => {
              if (p.results.length === 0) {
                return [
                  <div
                    key={p.provider}
                    className="flex items-center gap-2 text-sm"
                  >
                    <span className="badge-muted text-xs">{p.provider}</span>
                    <span className="text-ink-500">
                      {p.error ? p.error : "无可 prewarm 的账号"}
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

      {loading && <div className="text-ink-400">加载中...</div>}
      {err && <div className="badge-err px-3 py-2 inline-block">{err}</div>}

      {!loading && !err && Object.entries(data).map(([providerId, accounts]) => (
        <section key={providerId} className="mb-8">
          <h2 className="text-lg font-medium mb-3">
            {providerId}{" "}
            <span className="text-sm text-ink-500 font-normal">
              ({accounts.length} 账号)
            </span>
          </h2>
          <ConcurrencyBar accounts={accounts} />
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="bg-ink-900 text-ink-400">
                <tr className="text-left">
                  <th className="px-4 py-3 font-medium">Email</th>
                  <th className="px-4 py-3 font-medium">状态</th>
                  <th className="px-4 py-3 font-medium">本月请求</th>
                  <th className="px-4 py-3 font-medium">In / Out</th>
                  <th className="px-4 py-3 font-medium">Cache R/W</th>
                  <th className="px-4 py-3 font-medium">最近成功</th>
                  <th className="px-4 py-3 font-medium">Token 过期</th>
                  {isAdmin && (
                    <th className="px-4 py-3 font-medium text-right">操作</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800">
                {accounts.map((a) => {
                  const cd = cooldownStatus(a);
                  return (
                    <tr
                      key={a.email}
                      className={`hover:bg-ink-900/50 ${a.disabled ? "opacity-50" : ""}`}
                    >
                      <td className="px-4 py-3 font-medium">
                        {a.email}
                        {a.tierLabel && (
                          <span className="ml-2 badge-ok">{a.tierLabel}</span>
                        )}
                        {a.planType && (
                          <span className="ml-2 badge-muted">{a.planType}</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className={cd.className}>{cd.badge}</div>
                        {cd.detail && (
                          <div
                            className="text-xs text-ink-500 mt-0.5 truncate max-w-[16rem]"
                            title={cd.detail}
                          >
                            {cd.detail}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {a.totalRequests} / {a.totalSuccesses} ok
                        {a.totalFailures > 0 && (
                          <div className="text-xs text-rose-400">
                            {a.totalFailures} fail
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-ink-300">
                        {fmtTokens(a.totalInputTokens)} /{" "}
                        {fmtTokens(a.totalOutputTokens)}
                      </td>
                      <td className="px-4 py-3 text-ink-400">
                        {fmtTokens(a.totalCacheReadInputTokens)} R /{" "}
                        {fmtTokens(a.totalCacheCreationInputTokens)} W
                      </td>
                      <td className="px-4 py-3 text-ink-400">
                        {fmtRelative(a.lastSuccessAt)}
                      </td>
                      <td className="px-4 py-3 text-ink-400">
                        {a.refreshing
                          ? "refreshing..."
                          : fmtRelative(a.expiresAt)}
                      </td>
                      {isAdmin && (
                        <td className="px-4 py-3 text-right whitespace-nowrap space-x-1">
                          <button
                            className="btn-ghost text-xs"
                            onClick={() => onToggleDisabled(providerId, a)}
                            title={a.disabled ? "重新启用" : "暂停使用,token 保留"}
                          >
                            {a.disabled ? "启用" : "停用"}
                          </button>
                          <button
                            className="btn-ghost text-xs"
                            onClick={() => onReauth(providerId, a)}
                            title="OAuth 重新登录 — 用相同 email 登录会刷新 token"
                          >
                            重新认证
                          </button>
                          <button
                            className="btn-ghost text-xs"
                            onClick={() => setBudgetEdit({ provider: providerId, acct: a })}
                            title="设置月度预算 / 档位标签(展示用)"
                          >
                            预算
                          </button>
                          <button
                            className="btn-ghost text-xs text-rose-400 hover:text-rose-300"
                            onClick={() => onDelete(providerId, a)}
                            title="永久删除(不可逆)"
                          >
                            删除
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Per-account quota panel (5h / 7d windows + retry-after) */}
          <div className={`grid gap-4 mt-4 ${accounts.length > 1 ? "lg:grid-cols-2" : ""}`}>
            {accounts.map((a) => {
              const cost = monthCost[`${providerId}:${a.email}`] ?? 0;
              const budget = a.monthlyBudgetUsd;
              const pct = budget && budget > 0 ? (cost / budget) * 100 : 0;
              const tone =
                pct >= 90 ? "bg-rose-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
              return (
                <div key={a.email} className="card">
                  <div className="flex items-center justify-between mb-3">
                    <div className="font-medium">
                      {a.email}
                      {a.tierLabel && (
                        <span className="ml-2 badge-ok">{a.tierLabel}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-ink-400">
                      <span title="负载均衡权重">w={a.concurrencyWeight}</span>
                      {a.rateLimit?.fields?.["unified-5h-utilization"] && (
                        <span title="5h 窗口利用率">
                          5h {Math.round(Number(a.rateLimit.fields["unified-5h-utilization"]) * (Number(a.rateLimit.fields["unified-5h-utilization"]) <= 1 ? 100 : 1))}%
                        </span>
                      )}
                      {a.planType && <span className="badge-muted">{a.planType}</span>}
                    </div>
                  </div>

                  {/* 实时并发(处理中 / 峰值) */}
                  <div className="mb-3">
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-ink-400">实时并发(处理中)</span>
                      <span className="text-ink-300">
                        {a.inFlight}
                        <span className="text-ink-500"> · 峰值并发 {a.peakInFlight}</span>
                      </span>
                    </div>
                    <div className="h-2 bg-ink-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 transition-all"
                        style={{
                          width: `${Math.min(100, a.peakInFlight > 0 ? (a.inFlight / a.peakInFlight) * 100 : a.inFlight > 0 ? 100 : 0)}%`,
                        }}
                      />
                    </div>
                  </div>

                  {/* Monthly budget utilization (display-only) */}
                  <div className="mb-3">
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-ink-400">本月预算</span>
                      <span className="text-ink-400">
                        {fmtUsd(cost)}
                        {budget && budget > 0 ? (
                          <>
                            {" / "}${budget}{" "}
                            <span className={pct >= 90 ? "text-rose-400" : "text-ink-500"}>
                              ({pct.toFixed(0)}%)
                            </span>
                          </>
                        ) : (
                          <span className="text-ink-500"> / 未设预算</span>
                        )}
                      </span>
                    </div>
                    {budget && budget > 0 && (
                      <div className="h-2 bg-ink-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full ${tone} transition-all`}
                          style={{ width: `${Math.min(100, pct)}%` }}
                        />
                      </div>
                    )}
                  </div>

                  <AccountQuotaPanel account={a} />
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {!loading && !err && Object.keys(data).length === 0 && (
        <div className="card text-ink-500">
          没有上游账号。跑 <code className="text-ink-300">npm run login</code>{" "}
          添加一个,或在 v0.2 里用 UI 加。
        </div>
      )}
    </div>
  );
}

/* ─── Budget / tier editor modal ─────────────────────────────── */

function BudgetModal({
  edit,
  onClose,
  onSave,
}: {
  edit: { provider: string; acct: AccountSnapshot } | null;
  onClose: () => void;
  onSave: (
    provider: string,
    email: string,
    monthlyBudgetUsd: number | null,
    tierLabel: string | null,
    concurrencyWeight: number | null,
  ) => void;
}) {
  const [budget, setBudget] = useState("");
  const [tier, setTier] = useState("");
  const [weight, setWeight] = useState("");

  useEffect(() => {
    if (edit) {
      setBudget(
        edit.acct.monthlyBudgetUsd != null
          ? String(edit.acct.monthlyBudgetUsd)
          : "",
      );
      setTier(edit.acct.tierLabel ?? "");
      setWeight(
        edit.acct.concurrencyWeight && edit.acct.concurrencyWeight !== 1
          ? String(edit.acct.concurrencyWeight)
          : "",
      );
    }
  }, [edit]);

  if (!edit) return null;

  return (
    <Modal open={!!edit} onClose={onClose} title={`预算 / 档位 / 权重 — ${edit.acct.email}`}>
      <div className="space-y-4">
        <div>
          <label className="block text-sm text-ink-400 mb-1.5">
            月度预算(USD)<span className="text-ink-500">(留空 = 不设)</span>
          </label>
          <input
            className="input"
            type="number"
            min="0"
            step="1"
            placeholder="125"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
          <p className="text-xs text-ink-500 mt-1">
            展示用 —— 账号页按"本月已花 / 预算"画进度条,不强制限流。
          </p>
        </div>
        <div>
          <label className="block text-sm text-ink-400 mb-1.5">
            档位标签 <span className="text-ink-500">(例:$125 / Max)</span>
          </label>
          <input
            className="input"
            placeholder="$125"
            value={tier}
            onChange={(e) => setTier(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm text-ink-400 mb-1.5">
            负载均衡权重 <span className="text-ink-500">(留空 = 1;大档位账号设大些)</span>
          </label>
          <input
            className="input"
            type="number"
            min="0"
            step="1"
            placeholder="1"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
          />
          <p className="text-xs text-ink-500 mt-1">
            权重越大,高并发时分到越多请求(weighted-least-inflight 策略下)。
          </p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-secondary" onClick={onClose}>
            取消
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              const b = budget.trim() === "" ? null : Number(budget);
              const w = weight.trim() === "" ? null : Number(weight);
              onSave(
                edit.provider,
                edit.acct.email,
                b != null && !isNaN(b) && b > 0 ? b : null,
                tier.trim() === "" ? null : tier.trim(),
                w != null && !isNaN(w) && w > 0 ? w : null,
              );
            }}
          >
            保存
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ─── Concurrency distribution bar ───────────────────────────── */

function ConcurrencyBar({ accounts }: { accounts: AccountSnapshot[] }) {
  const total = accounts.reduce((s, a) => s + a.inFlight, 0);
  if (total === 0) return null;
  const palette = ["#3b82f6", "#10b981", "#a855f7", "#f59e0b", "#ef4444", "#06b6d4"];
  return (
    <div className="mb-3">
      <div className="flex justify-between text-xs text-ink-400 mb-1">
        <span>实时并发分布</span>
        <span>{total} 个处理中</span>
      </div>
      <div className="flex h-3 rounded-full overflow-hidden bg-ink-800">
        {accounts.map((a, i) =>
          a.inFlight > 0 ? (
            <div
              key={a.email}
              style={{
                width: `${(a.inFlight / total) * 100}%`,
                background: palette[i % palette.length],
              }}
              title={`${a.email}: ${a.inFlight}`}
            />
          ) : null,
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-xs text-ink-500">
        {accounts.map((a, i) => (
          <span key={a.email} className="flex items-center gap-1">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ background: palette[i % palette.length] }}
            />
            {a.email.split("@")[0]}: {a.inFlight}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ─── Capacity alert (上游打满 → 提示 + 解决办法) ───────────── */

function CapacityAlerts({
  capacity,
  onAdd,
  isAdmin,
}: {
  capacity: Record<string, CapacitySummary>;
  onAdd: () => void;
  isAdmin: boolean;
}) {
  const alerts = Object.entries(capacity).filter(
    ([, c]) => c.total > 0 && c.level !== "ok",
  );
  if (alerts.length === 0) return null;

  const fmtReset = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString() : "—";

  return (
    <div className="space-y-2 mb-4">
      {alerts.map(([provider, c]) => {
        const tone =
          c.level === "critical"
            ? "border-rose-600 bg-rose-950/40"
            : c.level === "warn"
              ? "border-amber-600 bg-amber-950/30"
              : "border-blue-600 bg-blue-950/20";
        const title =
          c.level === "critical"
            ? `🔴 ${provider}:所有账号当前不可用,新请求会被 429`
            : c.level === "warn"
              ? `🟠 ${provider}:账号池接近打满(${c.usable}/${c.total} 可用)`
              : `🟡 ${provider}:有账号 5h 窗口将用尽(利用率 ${Math.round((c.maxUtil5h ?? 0) * 100)}%)`;
        return (
          <div key={provider} className={`card border ${tone}`}>
            <div className="font-medium">{title}</div>
            <div className="text-sm text-ink-300 mt-1">
              最早恢复:{fmtReset(c.soonestResetAt)}
              {c.saturationRejects > 0 && (
                <span className="text-ink-500"> · 已拒绝 {c.saturationRejects} 次</span>
              )}
            </div>
            <div className="text-sm text-ink-400 mt-2">
              解决办法:
              <ol className="list-decimal list-inside mt-1 space-y-0.5">
                <li>等最近的窗口重置(见上方时间)</li>
                <li>
                  加上游账号
                  {isAdmin && (
                    <button className="ml-2 btn-ghost text-xs" onClick={onAdd}>
                      + 新增账号
                    </button>
                  )}
                  {!isAdmin && "(联系管理员)"}
                </li>
                <li>临时降低并发 / 错峰重试</li>
              </ol>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Routing settings card (admin) ──────────────────────────── */

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
    <div className="card mb-4">
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

/* ─── Prewarm scheduler card (admin) ─────────────────────────── */

const PREWARM_ALGO_TIP =
  "原理:Anthropic 的 5 小时限流窗口是『首条消息锚定』——窗口从你当天第一条请求那一刻开始计时,5 小时后自动重置、可再开一个新窗口。\n\n" +
  "若不暖机,窗口起点取决于当天第一个真实请求落在几点,边界随机、常常浪费掉上班前的额度。\n\n" +
  "定时暖机:每天固定时间(默认 08:00)自动发一条最便宜的 ping(Haiku, max_tokens=1, 成本≈0)主动锚定窗口。08:00 开窗 → 13:00 自动重置开第二个窗口,使工作时段(约 8:30–17:30)尽量跨越 2 个完整的 5h 窗口,相比冷启动理论可用配额上限提升约 +80%。\n\n" +
  "进阶:再加一个 13:00 时间点,可严格保证第二个窗口也被准点锚定(否则第二窗口要等当天 13:00 后的第一个真实请求才开)。周末也建议开启,避免周一从冷启动开始。\n\n" +
  "时间为服务器本地时间。ping 是真实计费请求但成本极低;账号处于冷却时会自动跳过。";

function PrewarmCard({
  onManualRun,
  prewarming,
}: {
  onManualRun: () => void;
  prewarming: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<PrewarmConfig | null>(null);
  const [runs, setRuns] = useState<PrewarmRun[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const loadHistory = useCallback(() => {
    fetchPrewarmHistory()
      .then((r) => setRuns(r.runs))
      .catch(() => setRuns([]));
  }, []);

  useEffect(() => {
    fetchPrewarmConfig().then(setCfg).catch(() => setCfg(null));
    loadHistory();
  }, [loadHistory]);

  // Refresh history when a manual prewarm run finishes.
  useEffect(() => {
    if (!prewarming) loadHistory();
  }, [prewarming, loadHistory]);

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

  const lastRun = runs[0];

  return (
    <div className="card mb-6">
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
              onClick={onManualRun}
              disabled={prewarming}
            >
              {prewarming ? "暖机中..." : "▶ 立即暖机一次"}
            </button>
            {msg && <span className="text-ink-400 text-sm">{msg}</span>}
          </div>

          {/* 实际暖机结果 */}
          <div className="border-t border-ink-800 pt-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-ink-300 font-medium">实际暖机结果</span>
              <button
                className="text-ink-500 hover:text-ink-300 text-xs"
                onClick={loadHistory}
              >
                ↻ 刷新
              </button>
            </div>

            {runs.length === 0 && (
              <div className="text-ink-500 text-sm">
                暂无记录 —— 进程启动后尚未触发过暖机(定时或手动)。
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
              <div className="text-xs text-ink-500 space-y-0.5">
                <div className="text-ink-400 mb-1">更早(最近 {runs.length} 次):</div>
                {runs.slice(1).map((r, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span>{r.trigger === "schedule" ? "定时" : "手动"}</span>
                    <span>· {fmtRelative(r.at)}</span>
                    <span
                      className={r.ok === r.total ? "text-emerald-400" : "text-amber-400"}
                    >
                      · {r.ok}/{r.total}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
