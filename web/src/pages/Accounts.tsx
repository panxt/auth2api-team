import { useEffect, useState, useCallback } from "react";
import {
  listAccounts,
  reload,
  refreshAccount,
  deleteAccount,
  setAccountDisabled,
  setAccountBudget,
  AccountSnapshot,
  CapacitySummary,
  QuotaPool,
  QuotaWindowPool,
} from "../api/accounts";
import { fetchStats } from "../api/stats";
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

/** Format a unix-seconds string as a short countdown ("剩 1h12m" / "已重置"). */
function fmtUnixCountdown(s: string | null): string {
  if (!s) return "—";
  const n = Number(s);
  if (!Number.isFinite(n)) return "—";
  const diff = n * 1000 - Date.now();
  if (diff <= 0) return "已重置";
  const h = Math.floor(diff / 3600_000);
  const m = Math.floor((diff % 3600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}天${h % 24}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

/** Format a unix-seconds string as a local time-of-day ("12:47"). */
function fmtUnixClock(s: string | null): string {
  if (!s) return "—";
  const n = Number(s);
  if (!Number.isFinite(n)) return "—";
  return new Date(n * 1000).toLocaleString();
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

export function Accounts() {
  const { whoami } = useAuth();
  const isAdmin = !!whoami?.admin;

  const [data, setData] = useState<Record<string, AccountSnapshot[]>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
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
  // Per-provider aggregated 5h/7d quota pool → drives the "额度池" summary.
  const [pools, setPools] = useState<Record<string, QuotaPool>>({});
  // 全局「刷新状态」按钮 in-flight, and per-account refresh ("provider:email").
  const [reloading, setReloading] = useState(false);
  const [refreshingOne, setRefreshingOne] = useState<string | null>(null);
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
      const pls: Record<string, QuotaPool> = {};
      for (const [p, info] of Object.entries(resp.providers)) {
        if (info.account_count > 0) byProvider[p] = info.accounts;
        if (info.capacity) caps[p] = info.capacity;
        if (info.quota_pool && (info.quota_pool["5h"] || info.quota_pool["7d"]))
          pls[p] = info.quota_pool;
      }
      setData(byProvider);
      setCapacity(caps);
      setPools(pls);
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

  // 全局刷新:重读 token 文件 + 和解整池(捡起 CLI/UI 新登录),再拉快照。
  async function onReloadAll() {
    setReloading(true);
    try {
      await reload();
      await load(false);
    } catch (e) {
      alert(`刷新失败: ${(e as ApiError).message}`);
    } finally {
      setReloading(false);
    }
  }

  // 单账号刷新:主动续该账号的 OAuth token,成功可清认证冷却。
  async function onRefreshOne(providerId: string, email: string) {
    const key = `${providerId}:${email}`;
    setRefreshingOne(key);
    try {
      const r = await refreshAccount(providerId, email);
      await load(false);
      if (!r.ok) {
        alert(
          `账号 ${email} 续期失败 —— 多半是 refresh token 已过期,需重新登录(点该账号的「重新认证」)。`,
        );
      }
    } catch (e) {
      alert(`刷新失败: ${(e as ApiError).message}`);
    } finally {
      setRefreshingOne(null);
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
              ? "每个 OAuth 账号当前状态 + 累计统计。负载均衡与窗口暖机配置见「设置」页。"
              : "每个 OAuth 账号当前状态 + 累计统计。新增账号需 admin 权限,请联系管理员。"}
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
          <button
            className="btn-secondary"
            onClick={onReloadAll}
            disabled={reloading}
            title="重读 token 文件并和解整池(捡起新登录的账号)"
          >
            {reloading ? "刷新中..." : "↻ 刷新状态"}
          </button>
        {isAdmin && (
          <div className="flex gap-2">
            <button
              className="btn-secondary"
              onClick={() => setShowAdd(true)}
            >
              + 新增账号
            </button>
          </div>
        )}
        </div>
      </header>

      {/* 上游容量告警 + 解决办法 */}
      <CapacityAlerts capacity={capacity} onAdd={() => setShowAdd(true)} isAdmin={isAdmin} />

      {/* 额度池汇总:全部账号 5h / 7d 加权等效窗口 */}
      <QuotaPoolSummary pools={pools} />

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
                            onClick={() => onRefreshOne(providerId, a.email)}
                            disabled={
                              refreshingOne === `${providerId}:${a.email}` ||
                              a.refreshing
                            }
                            title="主动续期该账号的 OAuth token(成功可清认证冷却)"
                          >
                            {refreshingOne === `${providerId}:${a.email}`
                              ? "刷新中..."
                              : "↻ 刷新"}
                          </button>
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

/* ─── Quota pool summary (5h / 7d aggregated) ─────────────────── */

const POOL_TIP =
  "把全部启用账号的额度汇总成一个『池子』。\n\n" +
  "Anthropic 只暴露每账号的『利用率%』,不公开绝对 token 配额,所以无法相加 token —— 这里用『加权等效窗口』口径:\n" +
  "• 每个账号按档位权重(并发权重)折算成若干『份』窗口容量;$125 账号比 $25 账号占更大份额。\n" +
  "• 池子已用 = Σ(权重 × 该账号利用率);剩余% = 1 − 已用/容量。\n\n" +
  "因此『剩余』是等效窗口份数的估算,不是精确 token 数。5h 与 7d 相互独立,任一打满都会限流。各账号窗口重置时间通常不同步(错峰反而能拉平供给),『最早重置』取池内最近的一个。\n\n" +
  "仅统计有 unified-* 数据的 Anthropic 订阅账号;Codex/Cursor 无此语义不计入。";

function poolBarColor(level: QuotaWindowPool["level"]): string {
  if (level === "critical") return "bg-rose-500";
  if (level === "warn") return "bg-amber-500";
  if (level === "info") return "bg-yellow-400";
  return "bg-emerald-500";
}

function PoolWindowRow({
  label,
  win,
}: {
  label: string;
  win: QuotaWindowPool | null;
}) {
  if (!win) {
    return (
      <div className="flex items-center gap-3 text-sm text-ink-500">
        <span className="w-16 shrink-0">{label}</span>
        <span>无数据</span>
      </div>
    );
  }
  const remainingPct = win.remainingPct ?? 0;
  const usedPct = Math.min(Math.max(1 - remainingPct, 0), 1);
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-16 shrink-0 text-ink-400">{label}</span>
      <div className="flex-1 min-w-[120px] h-2.5 rounded-full bg-ink-800 overflow-hidden">
        <div
          className={`h-full ${poolBarColor(win.level)}`}
          style={{ width: `${usedPct * 100}%` }}
          title={`已用 ${(usedPct * 100).toFixed(0)}%`}
        />
      </div>
      <span className="w-20 shrink-0 text-right text-ink-200">
        剩余 {(remainingPct * 100).toFixed(0)}%
      </span>
      <span className="w-24 shrink-0 text-right text-ink-500 font-mono text-xs">
        ≈ {win.remainingUnits}/{win.capacity} 份
      </span>
      <span className="w-32 shrink-0 text-right text-ink-500 text-xs">
        {win.soonestReset
          ? `重置 ${fmtUnixCountdown(win.soonestReset)}`
          : "—"}
      </span>
    </div>
  );
}

function QuotaPoolSummary({ pools }: { pools: Record<string, QuotaPool> }) {
  const entries = Object.entries(pools).filter(
    ([, p]) => p["5h"] || p["7d"],
  );
  if (entries.length === 0) return null;
  return (
    <div className="card mb-6">
      <div className="text-sm font-medium mb-3 inline-flex items-center">
        额度池汇总
        <InfoTip text={POOL_TIP} />
        <span className="ml-2 text-xs text-ink-500 font-normal">
          全部启用账号 · 加权等效窗口(估算)
        </span>
      </div>
      <div className="space-y-4">
        {entries.map(([provider, pool]) => {
          const accounts = pool["5h"]?.accounts ?? pool["7d"]?.accounts ?? 0;
          const soonest = pool["5h"]?.soonestReset ?? null;
          return (
            <div key={provider}>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="badge-muted text-xs">{provider}</span>
                <span className="text-xs text-ink-500">
                  {accounts} 账号
                  {soonest && ` · 5h 最早重置 ${fmtUnixClock(soonest)}`}
                </span>
              </div>
              <div className="space-y-1.5">
                <PoolWindowRow label="5h 窗口" win={pool["5h"]} />
                <PoolWindowRow label="7d 窗口" win={pool["7d"]} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
