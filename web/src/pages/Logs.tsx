import { useEffect, useState, useCallback, Fragment } from "react";
import {
  fetchLogs,
  fetchLoggingConfig,
  updateLoggingConfig,
  LogRow,
  LogFilter,
  LoggingConfig,
} from "../api/logs";
import { ApiError } from "../api/client";
import { useAuth } from "../lib/auth";

const PAGE = 100;

function statusTone(r: LogRow): string {
  if (r.status === "success") return "text-emerald-400";
  if (r.statusCode === 429) return "text-amber-400";
  return "text-rose-400";
}

export function Logs() {
  const { whoami } = useAuth();
  const isAdmin = !!whoami?.admin;

  const [rows, setRows] = useState<LogRow[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // filters (draft) — applied on 查询
  const [status, setStatus] = useState<"" | "failure" | "success">("failure");
  const [email, setEmail] = useState("");
  const [model, setModel] = useState("");
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState<LogFilter>({ status: "failure" });

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
      email: email.trim() || undefined,
      model: model.trim() || undefined,
      q: q.trim() || undefined,
    });
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">请求日志</h1>
          <p className="text-sm text-ink-400 mt-1">
            每条请求的结果与失败原因。仅 admin 可见。
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

      {isAdmin && <SettingsCard />}

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
          <label className="block text-xs text-ink-500 mb-1">上游账号</label>
          <input
            className="input !py-1 text-sm"
            placeholder="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
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
              <th className="px-3 py-2 font-medium">客户端</th>
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
                  <td className="px-3 py-2 font-mono text-xs">{r.apiKeyShort}</td>
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
                    <td colSpan={8} className="px-4 py-3 text-xs space-y-1">
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
                <td colSpan={8} className="px-4 py-8 text-center text-ink-500">
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

/* ─── Logging settings card (admin) ─────────────────────────── */

function SettingsCard() {
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
