import { useEffect, useState, useCallback, useMemo } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";
import { Line, Doughnut, Bar } from "react-chartjs-2";
import { fetchStats, fetchTimeseries, StatsSnapshot, DailyBucket } from "../api/stats";
import { listUsage, UsageKey } from "../api/keys";
import { listAccounts, AccountSnapshot } from "../api/accounts";
import { ApiError } from "../api/client";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
);

/* ── formatters ─────────────────────────────────────────────────────── */

function fmtUsd(n: number): string {
  if (n == null) return "$0";
  if (n >= 1000) return `$${(n / 1000).toFixed(2)}K`;
  if (n >= 10) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}
function fmtTokens(n: number): string {
  if (!n) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
function fmtInt(n: number): string {
  return n.toLocaleString();
}

/* ── color palette ───────────────────────────────────────────────────── */

const PALETTE = [
  "#10b981", // emerald
  "#3b82f6", // blue
  "#a855f7", // purple
  "#f59e0b", // amber
  "#ef4444", // rose
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
  "#f97316", // orange
  "#8b5cf6", // violet
];
const colorAt = (i: number) => PALETTE[i % PALETTE.length];

/* ── chart common options ────────────────────────────────────────────── */

const COMMON_CHART_OPTS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { labels: { color: "#a1a1aa", font: { size: 11 } } },
    tooltip: {
      backgroundColor: "#27272a",
      titleColor: "#fafafa",
      bodyColor: "#d4d4d8",
      borderColor: "#3f3f46",
      borderWidth: 1,
    },
  },
  scales: {
    x: {
      ticks: { color: "#71717a", font: { size: 10 } },
      grid: { color: "rgba(82, 82, 91, 0.2)" },
    },
    y: {
      ticks: { color: "#71717a", font: { size: 10 } },
      grid: { color: "rgba(82, 82, 91, 0.2)" },
    },
  },
};

/* ── component ─────────────────────────────────────────────────────── */

export function Stats() {
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [daily, setDaily] = useState<DailyBucket[]>([]);
  const [usage, setUsage] = useState<UsageKey[]>([]);
  const [accounts, setAccounts] = useState<AccountSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const load = useCallback(async () => {
    try {
      const [s, t, u, a] = await Promise.all([
        fetchStats(),
        fetchTimeseries(30),
        listUsage(),
        listAccounts(),
      ]);
      setStats(s);
      setDaily(t.days);
      setUsage(u.keys);
      const flatAccounts: AccountSnapshot[] = [];
      for (const info of Object.values(a.providers)) {
        flatAccounts.push(...info.accounts);
      }
      setAccounts(flatAccounts);
      setErr(null);
      setLastRefresh(new Date());
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);  // 30s refresh
    return () => clearInterval(t);
  }, [load]);

  /* ── derive: line chart data ─────────────────────────────────────── */

  const lineData = useMemo(() => {
    if (!daily.length) return null;
    const providers = new Set<string>();
    daily.forEach((d) => Object.keys(d.byProvider).forEach((p) => providers.add(p)));
    const providerList = Array.from(providers).sort();
    return {
      labels: daily.map((d) => d.date.slice(5)),  // "MM-DD"
      datasets: providerList.map((p, i) => ({
        label: p,
        data: daily.map((d) => d.byProvider[p]?.totalCostUsd ?? 0),
        backgroundColor: colorAt(i) + "55",  // 33% alpha
        borderColor: colorAt(i),
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointRadius: 3,
      })),
    };
  }, [daily]);

  /* ── derive: cost-by-model doughnut ─────────────────────────────── */

  const modelDoughnut = useMemo(() => {
    if (!stats) return null;
    const acc = new Map<string, number>();
    for (const b of Object.values(stats.byApi)) {
      acc.set(b.model, (acc.get(b.model) ?? 0) + b.totalCostUsd);
    }
    const sorted = Array.from(acc.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
    return {
      labels: sorted.map(([m]) => m),
      datasets: [
        {
          data: sorted.map(([, v]) => Number(v.toFixed(4))),
          backgroundColor: sorted.map((_, i) => colorAt(i)),
          borderColor: "#18181b",
          borderWidth: 2,
        },
      ],
    };
  }, [stats]);

  /* ── derive: requests-by-endpoint doughnut ──────────────────────── */

  const endpointDoughnut = useMemo(() => {
    if (!stats) return null;
    const acc = new Map<string, number>();
    for (const b of Object.values(stats.byApi)) {
      acc.set(b.endpoint, (acc.get(b.endpoint) ?? 0) + b.requests);
    }
    const sorted = Array.from(acc.entries()).sort((a, b) => b[1] - a[1]);
    return {
      labels: sorted.map(([e]) => e.replace(/^POST\s+/, "")),
      datasets: [
        {
          data: sorted.map(([, v]) => v),
          backgroundColor: sorted.map((_, i) => colorAt(i + 3)),
          borderColor: "#18181b",
          borderWidth: 2,
        },
      ],
    };
  }, [stats]);

  /* ── derive: top 10 clients by cost ─────────────────────────────── */

  const topClients = useMemo(() => {
    if (!stats) return null;
    // join byClient with usage keys to get labels
    const labels = new Map<string, string>();
    for (const u of usage) {
      labels.set(u.apiKeyShort, u.label || u.apiKeyShort);
    }
    const sorted = Object.values(stats.byClient)
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd)
      .slice(0, 10);
    return {
      labels: sorted.map(
        (c) => labels.get(c.apiKeyShort) || c.apiKeyShort.slice(0, 8),
      ),
      datasets: [
        {
          label: "Cost (USD)",
          data: sorted.map((c) => Number(c.totalCostUsd.toFixed(2))),
          backgroundColor: sorted.map((_, i) => colorAt(i)),
          borderRadius: 4,
        },
      ],
    };
  }, [stats, usage]);

  /* ── stats KPI ──────────────────────────────────────────────────── */

  const kpi = useMemo(() => {
    if (!stats) return null;
    const t = stats.totals;
    const tokens =
      t.totalInputTokens +
      t.totalOutputTokens +
      t.totalCacheCreationInputTokens +
      t.totalCacheReadInputTokens +
      t.totalReasoningOutputTokens;
    const successRate = t.requests
      ? Math.round((t.successes / t.requests) * 100)
      : 100;
    const avgLatency = t.requests
      ? Math.round(t.totalLatencyMs / t.requests)
      : 0;
    return {
      cost: t.totalCostUsd,
      tokens,
      requests: t.requests,
      successRate,
      avgLatency,
      accountsHealthy: accounts.filter((a) => a.available).length,
      accountsTotal: accounts.length,
    };
  }, [stats, accounts]);

  /* ── render ─────────────────────────────────────────────────────── */

  if (loading) {
    return <div className="text-ink-400">加载中...</div>;
  }
  if (err) {
    return <div className="badge-err px-3 py-2 inline-block">{err}</div>;
  }
  if (!stats || !kpi) return null;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">用量看板</h1>
          <p className="text-sm text-ink-400 mt-1">
            全量历史(自首次启动 / 最近一次清空起)。每 30 秒自动刷新。
          </p>
        </div>
        <div className="text-xs text-ink-500">
          最近刷新:{lastRefresh.toLocaleTimeString()}
        </div>
      </header>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Kpi
          label="总成本"
          value={fmtUsd(kpi.cost)}
          sub={`${fmtInt(kpi.requests)} 次请求`}
          tint="text-emerald-300"
        />
        <Kpi
          label="总 token"
          value={fmtTokens(kpi.tokens)}
          sub={`input + output + cache`}
          tint="text-blue-300"
        />
        <Kpi
          label="成功率"
          value={`${kpi.successRate}%`}
          sub={`${stats.totals.failures} 次失败`}
          tint={kpi.successRate >= 95 ? "text-emerald-300" : "text-amber-300"}
        />
        <Kpi
          label="平均延迟"
          value={`${kpi.avgLatency}ms`}
          sub={`端到端 e2e`}
          tint="text-purple-300"
        />
        <Kpi
          label="账号"
          value={`${kpi.accountsHealthy} / ${kpi.accountsTotal}`}
          sub={
            kpi.accountsHealthy === kpi.accountsTotal
              ? "全部可用"
              : `${kpi.accountsTotal - kpi.accountsHealthy} 个在 cooldown`
          }
          tint={
            kpi.accountsHealthy === kpi.accountsTotal
              ? "text-emerald-300"
              : "text-amber-300"
          }
        />
      </div>

      {/* Line chart: daily cost stacked by provider */}
      <section className="card">
        <h2 className="text-lg font-medium mb-3">
          近 30 天每日成本(按 provider 分组)
        </h2>
        <div className="h-72">
          {lineData ? (
            <Line
              data={lineData}
              options={{
                ...COMMON_CHART_OPTS,
                scales: {
                  ...COMMON_CHART_OPTS.scales,
                  y: {
                    ...COMMON_CHART_OPTS.scales.y,
                    stacked: true,
                    title: { display: true, text: "USD", color: "#a1a1aa" },
                  },
                  x: {
                    ...COMMON_CHART_OPTS.scales.x,
                    stacked: true,
                  },
                },
              }}
            />
          ) : (
            <div className="h-full grid place-items-center text-ink-500">
              暂无数据
            </div>
          )}
        </div>
      </section>

      {/* Doughnuts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="card">
          <h2 className="text-lg font-medium mb-3">成本分布 · 按模型 Top 8</h2>
          <div className="h-72">
            {modelDoughnut ? (
              <Doughnut
                data={modelDoughnut}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: {
                    legend: {
                      position: "right",
                      labels: { color: "#a1a1aa", font: { size: 11 }, boxWidth: 14 },
                    },
                    tooltip: COMMON_CHART_OPTS.plugins.tooltip,
                  },
                }}
              />
            ) : (
              <div className="h-full grid place-items-center text-ink-500">
                暂无数据
              </div>
            )}
          </div>
        </section>

        <section className="card">
          <h2 className="text-lg font-medium mb-3">请求分布 · 按端点</h2>
          <div className="h-72">
            {endpointDoughnut ? (
              <Doughnut
                data={endpointDoughnut}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: {
                    legend: {
                      position: "right",
                      labels: { color: "#a1a1aa", font: { size: 11 }, boxWidth: 14 },
                    },
                    tooltip: COMMON_CHART_OPTS.plugins.tooltip,
                  },
                }}
              />
            ) : (
              <div className="h-full grid place-items-center text-ink-500">
                暂无数据
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Top clients bar */}
      <section className="card">
        <h2 className="text-lg font-medium mb-3">Top 10 客户端 · 成本</h2>
        <div className="h-80">
          {topClients ? (
            <Bar
              data={topClients}
              options={{
                ...COMMON_CHART_OPTS,
                indexAxis: "y" as const,
                plugins: {
                  legend: { display: false },
                  tooltip: COMMON_CHART_OPTS.plugins.tooltip,
                },
              }}
            />
          ) : (
            <div className="h-full grid place-items-center text-ink-500">
              暂无数据
            </div>
          )}
        </div>
      </section>

      {/* Quota progress */}
      {usage.some((u) => u.quota) && (
        <section className="card">
          <h2 className="text-lg font-medium mb-3">配额完成度</h2>
          <div className="space-y-3">
            {usage
              .filter((u) => u.quota)
              .map((u) => {
                const used = u.consumed?.costUsd ?? 0;
                const limit = u.quota?.["monthly-cost-usd"] ?? 0;
                const pct = limit ? (used / limit) * 100 : 0;
                const tone =
                  pct >= 90
                    ? "bg-rose-500"
                    : pct >= 70
                      ? "bg-amber-500"
                      : "bg-emerald-500";
                return (
                  <div key={u.apiKeyShort}>
                    <div className="flex justify-between text-sm mb-1">
                      <span>{u.label || u.apiKeyShort}</span>
                      <span className="text-ink-400">
                        {fmtUsd(used)} / ${limit}{" "}
                        <span
                          className={pct >= 90 ? "text-rose-400" : "text-ink-500"}
                        >
                          ({pct.toFixed(1)}%)
                        </span>
                      </span>
                    </div>
                    <div className="h-2 bg-ink-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full ${tone} transition-all`}
                        style={{ width: `${Math.min(100, pct)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
          </div>
        </section>
      )}

      {/* Account health */}
      <section className="card overflow-x-auto p-0">
        <div className="px-5 py-3 border-b border-ink-800">
          <h2 className="text-lg font-medium">上游账号健康</h2>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-ink-900 text-ink-400">
            <tr className="text-left">
              <th className="px-4 py-2 font-medium">Email</th>
              <th className="px-4 py-2 font-medium">状态</th>
              <th className="px-4 py-2 font-medium">请求</th>
              <th className="px-4 py-2 font-medium">Tokens</th>
              <th className="px-4 py-2 font-medium">最近成功</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-800">
            {accounts.map((a) => {
              const now = Date.now();
              const inCd = a.cooldownUntil > now;
              const cdMin = inCd ? Math.ceil((a.cooldownUntil - now) / 60_000) : 0;
              const total =
                a.totalInputTokens +
                a.totalOutputTokens +
                a.totalCacheCreationInputTokens +
                a.totalCacheReadInputTokens;
              return (
                <tr key={a.email}>
                  <td className="px-4 py-2 font-medium">{a.email}</td>
                  <td className="px-4 py-2">
                    {inCd ? (
                      <span className="badge-warn">cooldown {cdMin}min</span>
                    ) : a.available ? (
                      <span className="badge-ok">ok</span>
                    ) : (
                      <span className="badge-err">unavailable</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {fmtInt(a.totalSuccesses)} ok
                    {a.totalFailures > 0 && (
                      <span className="text-rose-400 ml-1">
                        / {a.totalFailures} fail
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-ink-400">{fmtTokens(total)}</td>
                  <td className="px-4 py-2 text-ink-500 text-xs">
                    {a.lastSuccessAt
                      ? new Date(a.lastSuccessAt).toLocaleString()
                      : "—"}
                  </td>
                </tr>
              );
            })}
            {accounts.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-ink-500">
                  无账号
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/* ── KPI card subcomponent ──────────────────────────────────────── */

function Kpi(props: { label: string; value: string; sub: string; tint: string }) {
  return (
    <div className="card !p-4">
      <div className="text-xs text-ink-500 uppercase tracking-wide">
        {props.label}
      </div>
      <div className={`text-3xl font-bold mt-1 ${props.tint}`}>
        {props.value}
      </div>
      <div className="text-xs text-ink-500 mt-1">{props.sub}</div>
    </div>
  );
}
