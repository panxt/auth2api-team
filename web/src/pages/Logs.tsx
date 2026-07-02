import { useEffect, useState, useCallback, Fragment } from "react";
import {
  fetchLogs,
  LogRow,
  LogFilter,
  LogCategory,
} from "../api/logs";
import { ApiError } from "../api/client";
import { listAccounts } from "../api/accounts";
import { useAuth } from "../lib/auth";

const PAGE = 100;

function statusTone(r: LogRow): string {
  if (r.status === "success") return "text-emerald-400";
  if (r.statusCode === 429) return "text-amber-400";
  return "text-rose-400";
}

const CAT_META: Record<LogCategory, { label: string; cls: string }> = {
  upstream: { label: "模型", cls: "badge-err" },
  service: { label: "服务", cls: "badge-warn" },
  policy: { label: "策略", cls: "badge-muted" },
  client: { label: "客户端", cls: "badge-muted" },
  ok: { label: "成功", cls: "badge-ok" },
  mcp: { label: "MCP", cls: "badge-ok" },
};

export function Logs() {
  const { whoami } = useAuth();
  const isAdmin = !!whoami?.admin;
  // admin + auditor see org-wide logs; members see only their own rows.
  const seeAll = isAdmin || whoami?.role === "auditor";

  const [rows, setRows] = useState<LogRow[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // filters (draft) — applied on 查询
  const [status, setStatus] = useState<"" | "failure" | "success">("failure");
  const [category, setCategory] = useState<LogCategory | "">("");
  const [keyName, setKeyName] = useState("");
  const [email, setEmail] = useState("");
  const [model, setModel] = useState("");
  const [q, setQ] = useState("");
  const [sinceDate, setSinceDate] = useState(""); // YYYY-MM-DD
  const [untilDate, setUntilDate] = useState("");
  const [applied, setApplied] = useState<LogFilter>({ status: "failure" });
  // Known upstream accounts → datalist options for the 上游账号 combobox.
  const [accountOpts, setAccountOpts] = useState<string[]>([]);

  useEffect(() => {
    listAccounts()
      .then((r) => {
        const emails: string[] = [];
        for (const info of Object.values(r.providers))
          for (const a of info.accounts) emails.push(a.email);
        setAccountOpts(emails);
      })
      .catch(() => setAccountOpts([]));
  }, []);

  const load = useCallback(
    async (reset: boolean) => {
      try {
        const resp = await fetchLogs({
          ...applied,
          limit: PAGE,
          cursor: reset ? undefined : cursor,
        });
        setRows((prev) => (reset ? resp.logs : [...prev, ...resp.logs]));
        setCursor(resp.nextCursor);
        setErr(null);
      } catch (e) {
        setErr((e as ApiError).message);
      } finally {
        setLoading(false);
      }
    },
    [applied, cursor],
  );

  // Reload from the top whenever the applied filter changes.
  useEffect(() => {
    setLoading(true);
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied]);

  // 30s poll — only refresh the top page (don't disturb pagination).
  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => load(true), 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, applied]);

  function applyFilters() {
    setApplied({
      status: status || undefined,
      category: category || undefined,
      keyName: keyName.trim() || undefined,
      email: email.trim() || undefined,
      model: model.trim() || undefined,
      q: q.trim() || undefined,
      // date inputs → UTC day bounds (inclusive)
      since: sinceDate ? `${sinceDate}T00:00:00.000Z` : undefined,
      until: untilDate ? `${untilDate}T23:59:59.999Z` : undefined,
    });
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">请求日志</h1>
          <p className="text-sm text-ink-400 mt-1">
            {seeAll
              ? "每条请求的结果与失败原因,按用户名归集。"
              : "仅显示你自己 key 的请求(全局日志需管理员 / 审计员权限)。"}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-400">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          30s 自动刷新
        </label>
      </header>

      {/* 日志策略设置已移至「设置」页 */}

      {/* Filter bar */}
      <div className="card flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-ink-500 mb-1">状态</label>
          <select
            className="input !py-1 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value as any)}
          >
            <option value="">全部</option>
            <option value="failure">仅失败</option>
            <option value="success">仅成功</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-ink-500 mb-1">类别</label>
          <select
            className="input !py-1 text-sm"
            value={category}
            onChange={(e) => setCategory(e.target.value as any)}
          >
            <option value="">全部</option>
            <option value="upstream">模型/上游</option>
            <option value="service">本服务</option>
            <option value="policy">策略</option>
            <option value="client">客户端</option>
            <option value="mcp">MCP</option>
          </select>
        </div>
        {seeAll && (
          <div>
            <label className="block text-xs text-ink-500 mb-1">用户</label>
            <input
              className="input !py-1 text-sm"
              placeholder="按用户名 / 备注搜索"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyFilters()}
            />
          </div>
        )}
        <div>
          <label className="block text-xs text-ink-500 mb-1">上游账号</label>
          <input
            className="input !py-1 text-sm"
            placeholder="选择或输入 email"
            list="account-options"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <datalist id="account-options">
            {accountOpts.map((e) => (
              <option key={e} value={e} />
            ))}
          </datalist>
        </div>
        <div>
          <label className="block text-xs text-ink-500 mb-1">模型</label>
          <input
            className="input !py-1 text-sm"
            placeholder="claude-opus-4-8"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-ink-500 mb-1">起(UTC)</label>
          <input
            type="date"
            className="input !py-1 text-sm"
            value={sinceDate}
            max={untilDate || undefined}
            onChange={(e) => setSinceDate(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-ink-500 mb-1">止(UTC)</label>
          <input
            type="date"
            className="input !py-1 text-sm"
            value={untilDate}
            min={sinceDate || undefined}
            onChange={(e) => setUntilDate(e.target.value)}
          />
        </div>
        <div className="flex-1 min-w-[12rem]">
          <label className="block text-xs text-ink-500 mb-1">错误文本包含</label>
          <input
            className="input !py-1 text-sm w-full"
            placeholder="rate limit / overloaded …"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applyFilters()}
          />
        </div>
        <button className="btn-primary text-sm" onClick={applyFilters}>
          查询
        </button>
      </div>

      {err && <div className="badge-err px-3 py-2 inline-block">{err}</div>}

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-ink-900 text-ink-400">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">时间</th>
              <th className="px-3 py-2 font-medium">类别</th>
              <th className="px-3 py-2 font-medium">用户</th>
              <th className="px-3 py-2 font-medium">端点</th>
              <th className="px-3 py-2 font-medium">模型</th>
              <th className="px-3 py-2 font-medium">账号</th>
              <th className="px-3 py-2 font-medium text-center">状态</th>
              <th className="px-3 py-2 font-medium text-right">延迟</th>
              <th className="px-3 py-2 font-medium">原因</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-800">
            {rows.map((r) => (
              <Fragment key={r.id}>
                <tr
                  className="hover:bg-ink-900/50 cursor-pointer"
                  onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                >
                  <td className="px-3 py-2 text-ink-400 whitespace-nowrap">
                    {new Date(r.ts).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`${CAT_META[r.category]?.cls ?? "badge-muted"} text-xs`}>
                      {CAT_META[r.category]?.label ?? r.category}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs" title={r.apiKeyShort}>
                    {r.keyName ? (
                      <span className="text-ink-200">{r.keyName}</span>
                    ) : (
                      <span className="font-mono text-ink-500">{r.apiKeyShort}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-ink-300">
                    {r.endpoint.replace(/^POST\s+/, "")}
                  </td>
                  <td className="px-3 py-2 text-ink-300">{r.model || "—"}</td>
                  <td className="px-3 py-2 text-ink-400">{r.accountEmail || "—"}</td>
                  <td className={`px-3 py-2 text-center ${statusTone(r)}`}>
                    {r.statusCode}
                    {r.failureKind && (
                      <div className="text-xs text-ink-500">{r.failureKind}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-ink-400">{r.latencyMs}ms</td>
                  <td className="px-3 py-2 max-w-[20rem] truncate text-rose-300">
                    {r.errorDetail || ""}
                  </td>
                </tr>
                {expanded === r.id && (
                  <tr className="bg-ink-900/40">
                    <td colSpan={9} className="px-4 py-3 text-xs space-y-1">
                      {r.errorDetail && (
                        <div className="font-mono whitespace-pre-wrap text-rose-300">
                          {r.errorDetail}
                        </div>
                      )}
                      <div className="text-ink-500">
                        request_id: {r.requestId || "—"} · IP: {r.ip} · in/out:{" "}
                        {r.inputTokens ?? "—"}/{r.outputTokens ?? "—"} · provider:{" "}
                        {r.provider || "—"}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-ink-500">
                  没有匹配的日志(若只看失败,说明这段时间没有失败请求)
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {cursor != null && (
        <div className="text-center">
          <button className="btn-secondary text-sm" onClick={() => load(false)}>
            加载更多
          </button>
        </div>
      )}
    </div>
  );
}
