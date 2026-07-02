import { useEffect, useState, useCallback, useMemo, Fragment } from "react";
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
import { Line, Doughnut } from "react-chartjs-2";
import {
  fetchStats,
  fetchTimeseries,
  StatsSnapshot,
  DailyBucket,
} from "../api/stats";
import { listUsage, UsageKey } from "../api/keys";
import { useTheme } from "../lib/theme";
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

/* ── MCP endpoint helpers ────────────────────────────────────────────── */
// MCP 网关的每次 tools/call 记为 endpoint = "MCP <server>/<tool>"(无 token/成本)。
// 看板据此把 MCP 调用从模型调用中拆出来单独统计。

const MCP_PREFIX = "MCP ";
const isMcpEndpoint = (endpoint: string) => endpoint.startsWith(MCP_PREFIX);

function parseMcpEndpoint(
  endpoint: string,
): { server: string; tool: string } | null {
  if (!isMcpEndpoint(endpoint)) return null;
  const rest = endpoint.slice(MCP_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return { server: rest, tool: "" };
  return { server: rest.slice(0, slash), tool: rest.slice(slash + 1) };
}

/* ── color palette ───────────────────────────────────────────────────── */

// 图显色系:亮橙主导,配以薄荷绿及暖色补色(明/暗两种主题下都清晰)。
const PALETTE = [
  "#FF8A3D", // bright orange 亮橙(主)
  "#5FC9B0", // mint 薄荷
  "#FFB067", // light orange
  "#3C9C86", // deep mint
  "#F97316", // orange
  "#A8E0D2", // pale mint
  "#FF6B35", // red-orange
  "#2E7D6B", // teal
  "#FFC999", // apricot
  "#8AD8C4", // aqua mint
];
const colorAt = (i: number) => PALETTE[i % PALETTE.length];

/** Read a CSS `--ink-N` variable off <html> as a concrete rgb() string, so
 *  chart canvas colors (which can't use CSS vars) follow the active theme. */
function inkColor(n: number, alpha = 1): string {
  if (typeof window === "undefined") return `rgb(0 0 0 / ${alpha})`;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(`--ink-${n}`)
    .trim();
  return v ? `rgb(${v} / ${alpha})` : `rgb(0 0 0 / ${alpha})`;
}

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
  const { pref: themePref } = useTheme();
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [daily, setDaily] = useState<DailyBucket[]>([]);
  const [usage, setUsage] = useState<UsageKey[]>([]);
  const [accounts, setAccounts] = useState<AccountSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  // 时间窗口:预设(当天/当月/全部)或自定义区间;作用全页。
  const [mode, setMode] = useState<"today" | "month" | "all" | "custom">("month");
  // 视图:模型调用 vs MCP 调用 —— 两类分开看,不混在一起。
  const [view, setView] = useState<"model" | "mcp">("model");
  // 下钻展开的 key:"tool:<server>:<tool>"(看谁调的)或 "who:<short>:<server>"(看调了哪些工具)
  const [drill, setDrill] = useState<string | null>(null);
  // committed custom range (drives fetches); drafts live in the inputs below.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");

  // Translate the current selection into the stats + timeseries fetch args.
  const ranges = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    if (mode === "today")
      return { stats: { window: "today" as const }, ts: { from: today, to: today } };
    if (mode === "month") {
      const first = today.slice(0, 8) + "01";
      return { stats: { window: "month" as const }, ts: { from: first, to: today } };
    }
    if (mode === "all")
      return { stats: { window: "all" as const }, ts: { days: 365 } };
    // custom — fall back to month until both endpoints are set
    if (from && to)
      return { stats: { from, to }, ts: { from, to } };
    return { stats: { window: "month" as const }, ts: { days: 30 } };
  }, [mode, from, to]);

  const load = useCallback(async () => {
    try {
      const [s, t, u, a] = await Promise.all([
        fetchStats(ranges.stats),
        fetchTimeseries(ranges.ts),
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
  }, [ranges]);

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
      if (isMcpEndpoint(b.endpoint)) continue; // MCP 调用单独统计,不混入模型成本
      acc.set(b.model, (acc.get(b.model) ?? 0) + b.totalCostUsd);
    }
    const sorted = Array.from(acc.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
    return {
      labels: sorted.map(([m]) => m),
      datasets: [
        {
          data: sorted.map(([, v]) => Number(v.toFixed(4))),
          backgroundColor: sorted.map((_, i) => colorAt(i)),
          borderColor: inkColor(900), // 分段间隙用卡片色,随主题切换
          borderWidth: 2,
        },
      ],
    };
  }, [stats, themePref]);

  /* ── derive: requests-by-endpoint doughnut ──────────────────────── */

  const endpointDoughnut = useMemo(() => {
    if (!stats) return null;
    const acc = new Map<string, number>();
    for (const b of Object.values(stats.byApi)) {
      if (isMcpEndpoint(b.endpoint)) continue; // MCP 调用单独统计
      acc.set(b.endpoint, (acc.get(b.endpoint) ?? 0) + b.requests);
    }
    const sorted = Array.from(acc.entries()).sort((a, b) => b[1] - a[1]);
    return {
      labels: sorted.map(([e]) => e.replace(/^POST\s+/, "")),
      datasets: [
        {
          data: sorted.map(([, v]) => v),
          backgroundColor: sorted.map((_, i) => colorAt(i + 3)),
          borderColor: inkColor(900), // 分段间隙用卡片色,随主题切换
          borderWidth: 2,
        },
      ],
    };
  }, [stats, themePref]);

  /* ── derive: MCP 调用统计(按次数,独立于模型调用)──────────────── */

  const mcpStats = useMemo(() => {
    if (!stats) return null;
    // 每条 byApi 桶的 endpoint 形如 "MCP <server>/<tool>"。按 server 汇总,
    // 并保留每个 tool 的调用次数;成本/token 不参与(MCP 计量口径 = 次数)。
    const servers = new Map<
      string,
      {
        server: string;
        calls: number;
        successes: number;
        failures: number;
        lastSeenAt: string;
        tools: Map<string, { tool: string; calls: number; failures: number }>;
      }
    >();
    let totalCalls = 0;
    let totalFailures = 0;
    for (const b of Object.values(stats.byApi)) {
      const parsed = parseMcpEndpoint(b.endpoint);
      if (!parsed) continue;
      totalCalls += b.requests;
      totalFailures += b.failures;
      let g = servers.get(parsed.server);
      if (!g) {
        g = {
          server: parsed.server,
          calls: 0,
          successes: 0,
          failures: 0,
          lastSeenAt: b.lastSeenAt,
          tools: new Map(),
        };
        servers.set(parsed.server, g);
      }
      g.calls += b.requests;
      g.successes += b.successes;
      g.failures += b.failures;
      if (b.lastSeenAt > g.lastSeenAt) g.lastSeenAt = b.lastSeenAt;
      let t = g.tools.get(parsed.tool);
      if (!t) {
        t = { tool: parsed.tool, calls: 0, failures: 0 };
        g.tools.set(parsed.tool, t);
      }
      t.calls += b.requests;
      t.failures += b.failures;
    }
    const rows = Array.from(servers.values())
      .map((s) => ({
        ...s,
        tools: Array.from(s.tools.values()).sort((a, b) => b.calls - a.calls),
      }))
      .sort((a, b) => b.calls - a.calls);
    return { totalCalls, totalFailures, servers: rows };
  }, [stats]);

  /* ── label lookup: apiKeyShort → human label ─────────────────────── */

  const labelFor = useCallback(
    (short: string) => {
      for (const u of usage) {
        if (u.apiKeyShort === short) return u.label || short.slice(0, 8);
      }
      return short.slice(0, 8);
    },
    [usage],
  );

  // 管理员视角:key 的 owner(用户名 / 邮箱),无则空。
  const ownerFor = useCallback(
    (short: string) => {
      for (const u of usage) {
        if (u.apiKeyShort === short) return u.owner || "";
      }
      return "";
    },
    [usage],
  );

  // 客户端标识渲染:label · owner · 指纹(owner 存在才显示)。
  const ClientCell = useCallback(
    ({ short, label }: { short: string; label: string }) => {
      const owner = ownerFor(short);
      return (
        <>
          {label}
          {owner && (
            <span className="text-xs text-emerald-400 ml-2">{owner}</span>
          )}
          <span className="text-xs text-ink-500 ml-2">{short}</span>
        </>
      );
    },
    [ownerFor],
  );

  /* ── derive: MCP 调用「谁在调用」(按客户端 × MCP 服务)──────────── */

  const mcpByClient = useMemo(() => {
    if (!stats?.byClientMcp) return [];
    const clients = new Map<
      string,
      {
        short: string;
        total: number;
        failures: number;
        servers: Array<{
          server: string;
          calls: number;
          failures: number;
          tools: Array<{ tool: string; calls: number; failures: number }>;
        }>;
      }
    >();
    for (const b of Object.values(stats.byClientMcp)) {
      let g = clients.get(b.apiKeyShort);
      if (!g) {
        g = { short: b.apiKeyShort, total: 0, failures: 0, servers: [] };
        clients.set(b.apiKeyShort, g);
      }
      g.total += b.requests;
      g.failures += b.failures;
      const tools = Object.entries(b.byTool ?? {})
        .map(([tool, v]) => ({ tool, calls: v.calls, failures: v.failures }))
        .sort((a, b) => b.calls - a.calls);
      g.servers.push({ server: b.server, calls: b.requests, failures: b.failures, tools });
    }
    const rows = Array.from(clients.values()).map((c) => ({
      ...c,
      label: labelFor(c.short),
      servers: c.servers.sort((a, b) => b.calls - a.calls),
    }));
    rows.sort((a, b) => b.total - a.total);
    return rows;
  }, [stats, labelFor]);

  // 反向索引:某个 (服务, 工具) 被哪些客户端各调了多少次 —— 供「MCP 调用统计」
  // 卡里点击工具次数时下钻「谁调的」。
  const mcpToolCallers = useMemo(() => {
    const idx: Record<string, Record<string, Array<{ short: string; label: string; calls: number }>>> = {};
    if (!stats?.byClientMcp) return idx;
    for (const b of Object.values(stats.byClientMcp)) {
      for (const [tool, v] of Object.entries(b.byTool ?? {})) {
        ((idx[b.server] ??= {})[tool] ??= []).push({
          short: b.apiKeyShort,
          label: labelFor(b.apiKeyShort),
          calls: v.calls,
        });
      }
    }
    for (const srv of Object.values(idx))
      for (const arr of Object.values(srv)) arr.sort((a, b) => b.calls - a.calls);
    return idx;
  }, [stats, labelFor]);

  /* ── derive: MCP 每日调用趋势(按服务堆叠)──────────────────────── */

  const mcpLineData = useMemo(() => {
    if (!daily.length) return null;
    const servers = new Set<string>();
    for (const d of daily) for (const s of Object.keys(d.mcpByServer ?? {})) servers.add(s);
    if (servers.size === 0) return null;
    const labels = daily.map((d) => d.date.slice(5));
    const list = Array.from(servers);
    return {
      labels,
      datasets: list.map((srv, i) => ({
        label: srv,
        data: daily.map((d) => d.mcpByServer?.[srv] ?? 0),
        backgroundColor: colorAt(i),
        borderColor: colorAt(i),
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointRadius: 3,
      })),
    };
  }, [daily]);

  /* ── derive: MCP 调用分布 · 按服务 / 按工具 doughnuts ────────────── */

  const mcpServerDoughnut = useMemo(() => {
    if (!mcpStats || mcpStats.servers.length === 0) return null;
    const rows = mcpStats.servers;
    return {
      labels: rows.map((s) => s.server),
      datasets: [
        {
          data: rows.map((s) => s.calls),
          backgroundColor: rows.map((_, i) => colorAt(i)),
          borderColor: inkColor(900),
          borderWidth: 2,
        },
      ],
    };
  }, [mcpStats, themePref]);

  const mcpToolDoughnut = useMemo(() => {
    if (!mcpStats || mcpStats.servers.length === 0) return null;
    const tools: Array<{ name: string; calls: number }> = [];
    for (const s of mcpStats.servers)
      for (const t of s.tools) tools.push({ name: `${s.server}/${t.tool}`, calls: t.calls });
    tools.sort((a, b) => b.calls - a.calls);
    const top = tools.slice(0, 8);
    if (top.length === 0) return null;
    return {
      labels: top.map((t) => t.name),
      datasets: [
        {
          data: top.map((t) => t.calls),
          backgroundColor: top.map((_, i) => colorAt(i + 2)),
          borderColor: inkColor(900),
          borderWidth: 2,
        },
      ],
    };
  }, [mcpStats, themePref]);

  /* ── derive: top 10 clients by cost (cost + tokens + requests) ───── */

  const topClients = useMemo(() => {
    if (!stats) return [];
    return Object.values(stats.byClient)
      .map((c) => ({
        label: labelFor(c.apiKeyShort),
        short: c.apiKeyShort,
        cost: c.totalCostUsd,
        tokens:
          c.totalInputTokens +
          c.totalOutputTokens +
          c.totalCacheCreationInputTokens +
          c.totalCacheReadInputTokens +
          c.totalReasoningOutputTokens,
        requests: c.requests,
      }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 10);
  }, [stats, labelFor]);

  /* ── derive: per-user × per-model breakdown (cost + tokens) ──────── */

  const clientModelRows = useMemo(() => {
    if (!stats) return [];
    // Group byClientModel under each client, so the table shows每人 then
    // each model they used with cost + tokens.
    const byClient = new Map<
      string,
      {
        label: string;
        short: string;
        totalCost: number;
        models: Array<{ model: string; cost: number; tokens: number; requests: number }>;
      }
    >();
    for (const b of Object.values(stats.byClientModel)) {
      // MCP 调用记为 model="unknown"(无 token/成本),不进模型明细表 —— 见下方
      // 独立的「MCP 调用」卡。真实代理调用一律带模型名。
      if (b.model === "unknown") continue;
      let g = byClient.get(b.apiKeyShort);
      if (!g) {
        g = { label: labelFor(b.apiKeyShort), short: b.apiKeyShort, totalCost: 0, models: [] };
        byClient.set(b.apiKeyShort, g);
      }
      const tokens =
        b.totalInputTokens +
        b.totalOutputTokens +
        b.totalCacheCreationInputTokens +
        b.totalCacheReadInputTokens +
        b.totalReasoningOutputTokens;
      g.totalCost += b.totalCostUsd;
      g.models.push({ model: b.model, cost: b.totalCostUsd, tokens, requests: b.requests });
    }
    const rows = Array.from(byClient.values());
    rows.sort((a, b) => b.totalCost - a.totalCost);
    rows.forEach((r) => r.models.sort((a, b) => b.cost - a.cost));
    return rows;
  }, [stats, labelFor]);

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
    // 模型请求数 = 总请求 - MCP 调用(MCP 单独统计,不计入成本类指标)
    const mcpCalls = mcpStats?.totalCalls ?? 0;
    return {
      cost: t.totalCostUsd,
      tokens,
      requests: Math.max(0, t.requests - mcpCalls),
      successRate,
      avgLatency,
      accountsHealthy: accounts.filter((a) => a.available).length,
      accountsTotal: accounts.length,
    };
  }, [stats, accounts, mcpStats]);

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
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">用量看板</h1>
          <p className="text-sm text-ink-400 mt-1">
            {mode === "today"
              ? "今天(UTC)。"
              : mode === "month"
                ? "本月至今(UTC)。"
                : mode === "all"
                  ? "全量历史(自首次启动 / 最近一次清空起)。"
                  : from && to
                    ? `自定义区间 ${from} ~ ${to}(UTC)。`
                    : "选择起止日期后点应用。"}
            每 30 秒自动刷新。
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-3">
            {/* 视图段控:模型调用 vs MCP 调用 */}
            <div className="inline-flex rounded-md border border-ink-700 overflow-hidden text-sm">
              {([
                ["model", "模型调用"],
                ["mcp", "MCP 调用"],
              ] as const).map(([v, txt]) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`px-3 py-1.5 ${
                    view === v
                      ? "bg-emerald-600 text-white"
                      : "text-ink-300 hover:bg-ink-800"
                  }`}
                >
                  {txt}
                </button>
              ))}
            </div>
            {/* 时间窗口段控 */}
            <div className="inline-flex rounded-md border border-ink-700 overflow-hidden text-sm">
              {([
                ["today", "当天"],
                ["month", "当月"],
                ["all", "全部"],
                ["custom", "自定义"],
              ] as const).map(([w, txt]) => (
                <button
                  key={w}
                  onClick={() => setMode(w)}
                  className={`px-3 py-1.5 ${
                    mode === w
                      ? "bg-emerald-600 text-white"
                      : "text-ink-300 hover:bg-ink-800"
                  }`}
                >
                  {txt}
                </button>
              ))}
            </div>
            <div className="text-xs text-ink-500">
              最近刷新:{lastRefresh.toLocaleTimeString()}
            </div>
          </div>
          {mode === "custom" && (
            <div className="flex items-center gap-2 text-sm">
              <input
                type="date"
                className="input !py-1 text-sm"
                value={draftFrom}
                max={draftTo || undefined}
                onChange={(e) => setDraftFrom(e.target.value)}
              />
              <span className="text-ink-500">~</span>
              <input
                type="date"
                className="input !py-1 text-sm"
                value={draftTo}
                min={draftFrom || undefined}
                onChange={(e) => setDraftTo(e.target.value)}
              />
              <button
                className="btn-primary text-xs"
                disabled={!draftFrom || !draftTo}
                onClick={() => {
                  setFrom(draftFrom);
                  setTo(draftTo);
                }}
              >
                应用
              </button>
            </div>
          )}
        </div>
      </header>

      {view === "model" && (
      <>
      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Kpi
          label="总成本"
          value={fmtUsd(kpi.cost)}
          sub={`${fmtInt(kpi.requests)} 次模型请求`}
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
          每日成本(按 provider 分组)·{" "}
          {mode === "today"
            ? "今天"
            : mode === "month"
              ? "本月"
              : mode === "all"
                ? "近 365 天"
                : from && to
                  ? `${from} ~ ${to}`
                  : "本月"}
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
      </>
      )}

      {view === "mcp" && (
      <>
      {/* MCP KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Kpi
          label="MCP 总调用"
          value={fmtInt(mcpStats?.totalCalls ?? 0)}
          sub="按调用次数计"
          tint="text-cyan-300"
        />
        <Kpi
          label="失败"
          value={fmtInt(mcpStats?.totalFailures ?? 0)}
          sub="上游错误 / 被拒"
          tint={mcpStats && mcpStats.totalFailures > 0 ? "text-rose-300" : "text-emerald-300"}
        />
        <Kpi
          label="MCP 服务"
          value={fmtInt(mcpStats?.servers.length ?? 0)}
          sub="已被调用的类目"
          tint="text-emerald-300"
        />
        <Kpi
          label="调用方"
          value={fmtInt(mcpByClient.length)}
          sub="发起调用的 key"
          tint="text-blue-300"
        />
      </div>

      {/* MCP 每日调用趋势(按服务堆叠) */}
      <section className="card">
        <h2 className="text-lg font-medium mb-3">
          每日 MCP 调用(按服务分组)·{" "}
          {mode === "today"
            ? "今天"
            : mode === "month"
              ? "本月"
              : mode === "all"
                ? "近 365 天"
                : from && to
                  ? `${from} ~ ${to}`
                  : "本月"}
        </h2>
        <div className="h-72">
          {mcpLineData ? (
            <Line
              data={mcpLineData}
              options={{
                ...COMMON_CHART_OPTS,
                scales: {
                  ...COMMON_CHART_OPTS.scales,
                  y: {
                    ...COMMON_CHART_OPTS.scales.y,
                    stacked: true,
                    title: { display: true, text: "调用次数", color: "#a1a1aa" },
                  },
                  x: { ...COMMON_CHART_OPTS.scales.x, stacked: true },
                },
              }}
            />
          ) : (
            <div className="h-full grid place-items-center text-ink-500">
              暂无 MCP 调用
            </div>
          )}
        </div>
      </section>

      {/* MCP 分布环形图:按服务 / 按工具 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="card">
          <h2 className="text-lg font-medium mb-3">调用分布 · 按 MCP 服务</h2>
          <div className="h-72">
            {mcpServerDoughnut ? (
              <Doughnut
                data={mcpServerDoughnut}
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
          <h2 className="text-lg font-medium mb-3">调用分布 · 按工具 Top 8</h2>
          <div className="h-72">
            {mcpToolDoughnut ? (
              <Doughnut
                data={mcpToolDoughnut}
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

      {/* MCP 调用 — 独立于模型调用,计量口径 = 调用次数 */}
      <section className="card p-0">
        <div className="px-5 py-3 border-b border-ink-800 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium">MCP 调用统计</h2>
            <p className="text-xs text-ink-500 mt-0.5">
              MCP 网关按「调用次数」计量(不计 token / 成本),与模型调用分开统计。
            </p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-cyan-300">
              {fmtInt(mcpStats?.totalCalls ?? 0)}
            </div>
            <div className="text-xs text-ink-500">
              总调用
              {mcpStats && mcpStats.totalFailures > 0 && (
                <span className="text-rose-400 ml-1">
                  / {fmtInt(mcpStats.totalFailures)} 失败
                </span>
              )}
            </div>
          </div>
        </div>
        {mcpStats && mcpStats.servers.length > 0 ? (
          <div className="divide-y divide-ink-800">
            {mcpStats.servers.map((s) => (
              <div key={s.server} className="px-5 py-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="font-medium">
                    <span className="font-mono text-ink-200">{s.server}</span>
                    <span className="text-xs text-ink-500 ml-2">
                      {s.tools.length} 个工具
                    </span>
                  </div>
                  <div className="text-sm tabular-nums">
                    <span className="text-cyan-300 font-medium">
                      {fmtInt(s.calls)}
                    </span>
                    <span className="text-ink-500"> 次</span>
                    {s.failures > 0 && (
                      <span className="text-rose-400 ml-2">
                        {fmtInt(s.failures)} 失败
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {s.tools.map((t) => {
                    const key = `tool:${s.server}:${t.tool}`;
                    const open = drill === key;
                    return (
                      <button
                        key={t.tool}
                        type="button"
                        onClick={() => setDrill(open ? null : key)}
                        className={`text-xs tabular-nums rounded px-1 -mx-1 hover:bg-ink-800 ${
                          open ? "bg-ink-800" : ""
                        }`}
                        title="点击看谁调用了这个工具"
                      >
                        <span className="font-mono text-ink-300">{t.tool}</span>
                        <span className="text-cyan-400 ml-1.5 underline decoration-dotted">
                          {fmtInt(t.calls)}
                        </span>
                        {t.failures > 0 && (
                          <span className="text-rose-400 ml-1">✕{fmtInt(t.failures)}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {/* 下钻:某工具被谁调用了多少次 */}
                {s.tools.map((t) => {
                  const key = `tool:${s.server}:${t.tool}`;
                  if (drill !== key) return null;
                  const callers = mcpToolCallers[s.server]?.[t.tool] ?? [];
                  return (
                    <div key={`d-${t.tool}`} className="mt-2 ml-3 pl-3 border-l-2 border-cyan-800 space-y-1">
                      <div className="text-xs text-ink-500">
                        <span className="font-mono text-ink-300">{t.tool}</span> 谁调用了:
                      </div>
                      {callers.map((c) => (
                        <div key={c.short} className="text-xs flex items-center gap-2">
                          <span className="text-ink-200">{c.label}</span>
                          <span className="text-ink-500">{c.short}</span>
                          <span className="text-cyan-300 tabular-nums ml-auto">
                            {fmtInt(c.calls)} 次
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ) : (
          <div className="px-5 py-6 text-center text-ink-500 text-sm">
            本窗口暂无 MCP 调用。给 key 授权 MCP 类目 / 工具后,通过 /mcp
            端点发起的调用会在这里按次数统计。
          </div>
        )}
      </section>

      {/* MCP 谁在调用 — 按客户端 × MCP 服务 */}
      <section className="card overflow-x-auto p-0">
        <div className="px-5 py-3 border-b border-ink-800">
          <h2 className="text-lg font-medium">谁在调用 · 按客户端 × MCP 服务</h2>
          <p className="text-xs text-ink-500 mt-0.5">
            每个 key 调用了哪些 MCP 服务、各多少次(随时间窗口联动)。
          </p>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-ink-900 text-ink-400">
            <tr className="text-left">
              <th className="px-4 py-2 font-medium">客户端</th>
              <th className="px-4 py-2 font-medium">MCP 服务</th>
              <th className="px-4 py-2 font-medium text-right">调用次数</th>
              <th className="px-4 py-2 font-medium text-right">失败</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-800">
            {mcpByClient.flatMap((c) =>
              c.servers.map((s, si) => {
                const key = `who:${c.short}:${s.server}`;
                const open = drill === key;
                return (
                  <Fragment key={key}>
                    <tr className="hover:bg-ink-900/50">
                      <td className="px-4 py-2 font-medium">
                        {si === 0 ? (
                          <ClientCell short={c.short} label={c.label} />
                        ) : (
                          <span className="text-ink-700">↳</span>
                        )}
                      </td>
                      <td className="px-4 py-2 font-mono text-ink-300">{s.server}</td>
                      <td className="px-4 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => setDrill(open ? null : key)}
                          className="text-cyan-300 tabular-nums underline decoration-dotted hover:text-cyan-200"
                          title="点击看这个 key 在该 MCP 上调了哪些工具"
                        >
                          {fmtInt(s.calls)}
                        </button>
                      </td>
                      <td className="px-4 py-2 text-right">
                        {s.failures > 0 ? (
                          <span className="text-rose-400">{fmtInt(s.failures)}</span>
                        ) : (
                          <span className="text-ink-600">0</span>
                        )}
                      </td>
                    </tr>
                    {open && (
                      <tr className="bg-ink-900/40">
                        <td colSpan={4} className="px-4 py-2">
                          <div className="ml-3 pl-3 border-l-2 border-cyan-800 flex flex-wrap gap-x-4 gap-y-1">
                            {s.tools.map((t) => (
                              <div key={t.tool} className="text-xs tabular-nums">
                                <span className="font-mono text-ink-300">{t.tool}</span>
                                <span className="text-cyan-400 ml-1.5">{fmtInt(t.calls)}</span>
                                {t.failures > 0 && (
                                  <span className="text-rose-400 ml-1">✕{fmtInt(t.failures)}</span>
                                )}
                              </div>
                            ))}
                            {s.tools.length === 0 && (
                              <span className="text-xs text-ink-500">无明细</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              }),
            )}
            {mcpByClient.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-ink-500">
                  本窗口暂无 MCP 调用。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
      </>
      )}

      {view === "model" && (
      <>
      {/* Top clients — cost + tokens + requests */}
      <section className="card overflow-x-auto p-0">
        <div className="px-5 py-3 border-b border-ink-800">
          <h2 className="text-lg font-medium">Top 10 客户端 · 成本 + Token</h2>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-ink-900 text-ink-400">
            <tr className="text-left">
              <th className="px-4 py-2 font-medium">#</th>
              <th className="px-4 py-2 font-medium">客户端</th>
              <th className="px-4 py-2 font-medium text-right">成本</th>
              <th className="px-4 py-2 font-medium text-right">Token</th>
              <th className="px-4 py-2 font-medium text-right">请求</th>
              <th className="px-4 py-2 font-medium">占比</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-800">
            {topClients.map((c, i) => {
              // 占比 = 该客户端成本 / 全部客户端总成本(本窗口)
              const totalCost = stats.totals.totalCostUsd || 1;
              const share = (c.cost / totalCost) * 100;
              return (
                <tr key={c.short} className="hover:bg-ink-900/50">
                  <td className="px-4 py-2 text-ink-500">{i + 1}</td>
                  <td className="px-4 py-2 font-medium">
                    <ClientCell short={c.short} label={c.label} />
                  </td>
                  <td className="px-4 py-2 text-right text-emerald-300">{fmtUsd(c.cost)}</td>
                  <td className="px-4 py-2 text-right text-blue-300">{fmtTokens(c.tokens)}</td>
                  <td className="px-4 py-2 text-right text-ink-400">{fmtInt(c.requests)}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-2 bg-ink-800 rounded-full overflow-hidden w-24 shrink-0">
                        <div
                          className="h-full bg-emerald-500"
                          style={{ width: `${Math.min(100, share)}%` }}
                        />
                      </div>
                      <span className="text-xs text-ink-400 tabular-nums w-12 text-right">
                        {share.toFixed(1)}%
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
            {topClients.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-ink-500">
                  暂无数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {/* Per-user × per-model breakdown */}
      <section className="card overflow-x-auto p-0">
        <div className="px-5 py-3 border-b border-ink-800">
          <h2 className="text-lg font-medium">每人 · 各模型 成本 / Token 明细</h2>
          <p className="text-xs text-ink-500 mt-0.5">
            每个客户端在每个模型上的消耗(随上方时间窗口联动)。
          </p>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-ink-900 text-ink-400">
            <tr className="text-left">
              <th className="px-4 py-2 font-medium">客户端</th>
              <th className="px-4 py-2 font-medium">模型</th>
              <th className="px-4 py-2 font-medium text-right">成本</th>
              <th className="px-4 py-2 font-medium text-right">Token</th>
              <th className="px-4 py-2 font-medium text-right">请求</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-800">
            {clientModelRows.flatMap((r) =>
              r.models.map((m, mi) => (
                <tr key={`${r.short}|${m.model}`} className="hover:bg-ink-900/50">
                  <td className="px-4 py-2 font-medium">
                    {mi === 0 ? (
                      <ClientCell short={r.short} label={r.label} />
                    ) : (
                      <span className="text-ink-700">↳</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-ink-300">{m.model}</td>
                  <td className="px-4 py-2 text-right text-emerald-300">{fmtUsd(m.cost)}</td>
                  <td className="px-4 py-2 text-right text-blue-300">{fmtTokens(m.tokens)}</td>
                  <td className="px-4 py-2 text-right text-ink-400">{fmtInt(m.requests)}</td>
                </tr>
              )),
            )}
            {clientModelRows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-ink-500">
                  暂无数据
                </td>
              </tr>
            )}
          </tbody>
        </table>
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
      </>
      )}
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
