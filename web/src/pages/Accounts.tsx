import { useEffect, useState, useCallback } from "react";
import {
  listAccounts,
  prewarm,
  AccountSnapshot,
  PrewarmResp,
} from "../api/accounts";
import { ApiError } from "../api/client";
import { AddAccountModal } from "../components/AddAccountModal";
import { AccountQuotaPanel } from "../components/AccountQuotaPanel";

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
  const [data, setData] = useState<Record<string, AccountSnapshot[]>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [prewarming, setPrewarming] = useState(false);
  const [lastPrewarm, setLastPrewarm] = useState<PrewarmResp | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const resp = await listAccounts();
      const byProvider: Record<string, AccountSnapshot[]> = {};
      for (const [p, info] of Object.entries(resp.providers)) {
        if (info.account_count > 0) byProvider[p] = info.accounts;
      }
      setData(byProvider);
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // poll every 30s so cooldown counters stay fresh
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

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

  return (
    <div>
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">上游账号</h1>
          <p className="text-sm text-ink-400 mt-1">
            每个 OAuth 账号当前状态 + 累计统计。点 prewarm 可立即把所有 anthropic 账号的 5h 窗口往前对齐。
          </p>
        </div>
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
      </header>

      <AddAccountModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onAdded={() => {
          // Refresh after a moment so the new account appears.
          setTimeout(load, 500);
        }}
      />

      {lastPrewarm && (
        <div className="card mb-6">
          <div className="text-sm text-ink-300 mb-2 font-medium">
            上次 prewarm 结果
          </div>
          <div className="space-y-1 text-sm">
            {lastPrewarm.providers.map((p) => (
              <div key={p.provider}>
                <span className="text-ink-400 mr-2">[{p.provider}]</span>
                {p.results.map((r) => (
                  <span key={r.email} className="mr-3">
                    {r.ok ? (
                      <span className="text-emerald-400">✓</span>
                    ) : (
                      <span className="text-rose-400">✗</span>
                    )}{" "}
                    {r.email}
                    {r.latencyMs && (
                      <span className="text-ink-500"> ({r.latencyMs}ms)</span>
                    )}
                    {r.error && (
                      <span className="text-rose-400"> {r.error}</span>
                    )}
                  </span>
                ))}
              </div>
            ))}
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
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800">
                {accounts.map((a) => {
                  const cd = cooldownStatus(a);
                  return (
                    <tr key={a.email} className="hover:bg-ink-900/50">
                      <td className="px-4 py-3 font-medium">
                        {a.email}
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
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Per-account quota panel (5h / 7d windows + retry-after) */}
          <div className={`grid gap-4 mt-4 ${accounts.length > 1 ? "lg:grid-cols-2" : ""}`}>
            {accounts.map((a) => (
              <div key={a.email} className="card">
                <div className="flex items-center justify-between mb-3">
                  <div className="font-medium">{a.email}</div>
                  {a.planType && (
                    <span className="badge-muted">{a.planType}</span>
                  )}
                </div>
                <AccountQuotaPanel account={a} />
              </div>
            ))}
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
