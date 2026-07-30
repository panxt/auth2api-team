import { useEffect, useState, useCallback } from "react";
import {
  listUsage,
  listManaged,
  listModels,
  createKey,
  updateKey,
  deleteKey,
  rotateKey,
  setDailyOverride,
  UsageKey,
  ManagedKeyView,
  CreateKeyInput,
  CreateKeyResponse,
  KeyQuota,
  KeyModelQuota,
  KeyRole,
  McpQuota,
} from "../api/keys";
import { fetchMcpServers, fetchMcpTools, McpServerView, McpTool } from "../api/mcp";
import { ApiError } from "../api/client";
import { Modal } from "../components/Modal";
import { useAuth } from "../lib/auth";
import { buildAccessDoc, downloadAccessDoc, renderAccessDocHtml } from "../lib/accessDoc";

interface MergedRow extends UsageKey {
  source: "managed" | "config";
  managedId: string | null;   // null = config-only key (read-only)
  role: KeyRole | null;       // from managed view; null for config-only
  allowedModels: string[] | null; // model allowlist (managed keys only)
  deniedModels: string[] | null;  // model denylist (managed keys only)
  allowedMcp: string[] | null;    // MCP category grants (managed keys only)
  expiresAt: string | null;       // ISO expiry (managed keys only)
  mcpQuota: McpQuota | null;      // MCP call-count quota (managed keys only)
}

function fmtUSD(n: number | undefined): string {
  if (n == null) return "$0.00";
  return `$${n.toFixed(2)}`;
}
function fmtTokens(n: number | undefined): string {
  if (!n) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Distinct upstream MCP servers a key is granted (grant may be "gitlab" whole
 *  or "gitlab__tool"). Count决定网关是否加命名空间前缀:1 个→免前缀,≥2→带前缀。 */
function mcpServersOf(allowedMcp: string[] | null): string[] {
  if (!allowedMcp || allowedMcp.length === 0) return [];
  return Array.from(new Set(allowedMcp.map((g) => g.split("__")[0])));
}

/** Today's (UTC) consumption vs the effective daily cap (temp override applied). */
function TodayCell({ today }: { today: UsageKey["today"] }) {
  if (!today) return <span className="text-ink-600 text-xs">—</span>;
  const cap = today.capCostUsd;
  const used = today.costUsd;
  const pct = cap && cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  const tone = pct >= 90 ? "bg-rose-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="min-w-[8rem]">
      <div className="flex items-center gap-1.5 text-sm">
        <span>{fmtUSD(used)}</span>
        {cap != null ? (
          <span className="text-ink-500">/ ${cap}</span>
        ) : (
          <span className="text-ink-600 text-xs">未设日额度</span>
        )}
        {today.overrideActive && (
          <span className="badge-ok text-xs" title="今日临时额度,明日自动恢复">今日临时</span>
        )}
      </div>
      {cap != null && cap > 0 && (
        <div className="h-1.5 bg-ink-800 rounded-full overflow-hidden mt-1">
          <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="text-xs text-ink-500 mt-0.5">{fmtTokens(today.tokens)} tok</div>
    </div>
  );
}

/** Renders a key's MCP grant summary + prefix mode badge for the table. */
function McpModeCell({ allowedMcp }: { allowedMcp: string[] | null }) {
  const servers = mcpServersOf(allowedMcp);
  if (servers.length === 0)
    return <span className="text-ink-500 text-xs">无(默认拒绝)</span>;
  const flat = servers.length === 1;
  return (
    <div className="flex flex-col gap-1 max-w-[14rem]">
      <div className="flex flex-wrap gap-1">
        {servers.map((s) => (
          <span key={s} className="badge-ok text-xs">
            {s}
          </span>
        ))}
      </div>
      <span
        className={`text-xs ${flat ? "text-emerald-400" : "text-amber-400"}`}
        title={
          flat
            ? "单上游 → 网关不加命名空间前缀,工具名与直连一致,迁移零改动"
            : "多上游 → 工具名带 <服务>__ 前缀防撞名"
        }
      >
        {flat ? "免前缀(单上游)" : `带前缀(${servers.length} 类)`}
      </span>
    </div>
  );
}

export function Users() {
  const { whoami } = useAuth();
  const isAdmin = !!whoami?.admin;

  const [rows, setRows] = useState<MergedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]); // for the allowlist picker
  const [mcpServers, setMcpServers] = useState<McpServerView[]>([]); // MCP categories

  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<MergedRow | null>(null);
  const [overriding, setOverriding] = useState<MergedRow | null>(null); // 今日加额目标
  const [createdKey, setCreatedKey] = useState<CreateKeyResponse | null>(null); // raw key + meta, shown once

  // ── Batch selection (managed keys only; config keys are read-only) ──
  const [selected, setSelected] = useState<Set<string>>(new Set()); // managedIds
  const [batchBusy, setBatchBusy] = useState(false);
  // Which batch modal is open: model allowlist / denylist / quota / none.
  const [batchModal, setBatchModal] = useState<"allow" | "deny" | "quota" | null>(
    null,
  );

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      // listUsage() hits /admin/usage/keys (any valid key; returns only the
      // caller's row for non-admin). listManaged() hits /admin/keys which is
      // admin-only, so for non-admin keys we skip it — the source/managedId
      // distinction is moot when the editor UI is hidden anyway.
      const usage = await listUsage();
      let managedByShort = new Map<string, ManagedKeyView>();
      if (isAdmin) {
        const managed = await listManaged();
        for (const m of managed.keys) {
          if (m.source === "managed") managedByShort.set(m.id, m);
        }
      }
      const merged: MergedRow[] = usage.keys.map((u) => {
        const m = managedByShort.get(u.apiKeyShort);
        return {
          ...u,
          source: m ? "managed" : "config",
          managedId: m ? m.id : null,
          role: m ? m.role : null,
          allowedModels: m ? m["allowed-models"] : null,
          deniedModels: m ? m["denied-models"] : null,
          allowedMcp: m ? m["allowed-mcp"] : null,
          expiresAt: m ? m["expires-at"] : null,
          mcpQuota: m ? m["mcp-quota"] : null,
        };
      });
      setRows(merged);
    } catch (e) {
      const error = e as ApiError;
      setErr(error.message);
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  // Drop selections whose key no longer exists after a reload (deleted, or
  // now config-only) so the batch toolbar never acts on a stale id.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(rows.filter((r) => r.managedId).map((r) => r.managedId!));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [rows]);

  // Fetch the available model list + registered MCP categories once (admin
  // only) for the allowlist / MCP-grant pickers.
  useEffect(() => {
    if (!isAdmin) return;
    listModels()
      .then((r) => setModels(r.data.map((m) => m.id)))
      .catch(() => setModels([]));
    fetchMcpServers()
      .then((r) => setMcpServers(r.servers))
      .catch(() => setMcpServers([]));
  }, [isAdmin]);

  async function onToggleEnabled(row: MergedRow) {
    if (!row.managedId) {
      alert("config.yaml 里的 key 是只读的,改请直接编辑文件并重启服务");
      return;
    }
    try {
      await updateKey(row.managedId, { enabled: !row.enabled });
      load();
    } catch (e) {
      alert(`操作失败: ${(e as ApiError).message}`);
    }
  }

  async function onRotate(row: MergedRow) {
    if (!row.managedId) {
      alert("config.yaml 里的 key 是只读的,无法重置");
      return;
    }
    if (
      !confirm(
        `重置 ${row.label || row.apiKeyShort}?\n旧 key 立即失效,所有用它的客户端都要换新 key(名称/角色/配额/MCP 授权不变)。`,
      )
    )
      return;
    try {
      const resp = await rotateKey(row.managedId);
      setCreatedKey(resp); // 复用"仅此一次明文"弹窗
      load();
    } catch (e) {
      alert(`重置失败: ${(e as ApiError).message}`);
    }
  }

  async function onDelete(row: MergedRow) {
    if (!row.managedId) {
      alert("config.yaml 里的 key 是只读的,删请直接编辑文件并重启服务");
      return;
    }
    if (!confirm(`确认删除 ${row.label || row.apiKeyShort}? 此操作不可逆`)) return;
    try {
      await deleteKey(row.managedId);
      load();
    } catch (e) {
      alert(`删除失败: ${(e as ApiError).message}`);
    }
  }

  // ── Batch helpers ────────────────────────────────────────────────────
  // Only managed keys are selectable; config keys are read-only.
  const selectableIds = rows
    .filter((r) => r.managedId)
    .map((r) => r.managedId!);
  const allSelected =
    selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const someSelected = selected.size > 0 && !allSelected;

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === selectableIds.length && selectableIds.length > 0
        ? new Set()
        : new Set(selectableIds),
    );
  }

  /** Run one op across all selected ids sequentially, tally failures, then
   *  reload and clear the selection. `perId` returns the key's label for the
   *  error summary. */
  async function runBatch(
    verb: string,
    perId: (id: string) => Promise<void>,
  ): Promise<void> {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBatchBusy(true);
    let ok = 0;
    const failures: string[] = [];
    for (const id of ids) {
      const label =
        rows.find((r) => r.managedId === id)?.label || id.slice(0, 8);
      try {
        await perId(id);
        ok++;
      } catch (e) {
        failures.push(`${label}: ${(e as ApiError).message}`);
      }
    }
    setBatchBusy(false);
    await load();
    setSelected(new Set());
    if (failures.length) {
      alert(
        `${verb}:成功 ${ok},失败 ${failures.length}\n\n` +
          failures.slice(0, 8).join("\n") +
          (failures.length > 8 ? `\n…还有 ${failures.length - 8} 条` : ""),
      );
    }
  }

  async function batchSetEnabled(enabled: boolean) {
    await runBatch(enabled ? "批量启用" : "批量禁用", async (id) => {
      await updateKey(id, { enabled });
    });
  }

  async function batchDelete() {
    const n = selected.size;
    if (
      !confirm(
        `确认删除选中的 ${n} 个 key?\n此操作不可逆,所有用这些 key 的客户端会立即失效。`,
      )
    )
      return;
    await runBatch("批量删除", async (id) => {
      await deleteKey(id);
    });
  }

  async function batchSetModels(kind: "allow" | "deny", list: string[]) {
    // 空数组 = 清空该名单(白名单空=允许全部;黑名单空=不禁任何)。
    const field = kind === "allow" ? "allowed-models" : "denied-models";
    await runBatch(
      kind === "allow" ? "批量设模型白名单" : "批量设模型黑名单",
      async (id) => {
        await updateKey(id, { [field]: list });
      },
    );
    setBatchModal(null);
  }

  async function batchSetQuota(quota: KeyQuota | null) {
    // null = 清空额度(改为不限);对象 = 覆盖为这套额度。
    await runBatch("批量设额度", async (id) => {
      await updateKey(id, { quota });
    });
    setBatchModal(null);
  }

  return (
    <div>
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">
            用户管理
            {!isAdmin && (
              <span className="ml-2 align-middle badge-muted text-xs">只读模式</span>
            )}
          </h1>
          <p className="text-sm text-ink-400 mt-1">
            {isAdmin
              ? "API key 增删改 + 配额 + 当月用量。config.yaml 里的 key 标灰只读。"
              : "当前 key 非 admin,仅能查看自己的用量。需要管理权限请联系管理员。"}
          </p>
        </div>
        {isAdmin && (
          <button
            className="btn-primary"
            onClick={() => setShowCreate(true)}
          >
            + 新增 key
          </button>
        )}
      </header>

      {loading && <div className="text-ink-400">加载中...</div>}
      {err && <div className="badge-err px-3 py-2 inline-block">{err}</div>}

      {/* Batch action bar — only when admin has ≥1 managed key selected */}
      {isAdmin && selected.size > 0 && (
        <div className="card mb-3 p-3 flex flex-wrap items-center gap-2 bg-ink-900 border-emerald-800">
          <span className="text-sm text-ink-300 mr-1">
            已选 <b className="text-emerald-400">{selected.size}</b> 个
          </span>
          <button
            className="btn-secondary text-xs"
            onClick={() => batchSetEnabled(true)}
            disabled={batchBusy}
          >
            批量启用
          </button>
          <button
            className="btn-secondary text-xs text-amber-400"
            onClick={() => batchSetEnabled(false)}
            disabled={batchBusy}
          >
            批量禁用
          </button>
          <button
            className="btn-secondary text-xs"
            onClick={() => setBatchModal("allow")}
            disabled={batchBusy}
            title="统一设置这些 key 的模型白名单(如只放开 gpt-5.5)"
          >
            批量设白名单
          </button>
          <button
            className="btn-secondary text-xs text-rose-400"
            onClick={() => setBatchModal("deny")}
            disabled={batchBusy}
            title="统一设置这些 key 的模型黑名单(列出的一律 403)"
          >
            批量设黑名单
          </button>
          <button
            className="btn-secondary text-xs"
            onClick={() => setBatchModal("quota")}
            disabled={batchBusy}
            title="统一设置这些 key 的额度(月/日 · 成本/Token)"
          >
            批量设额度
          </button>
          <button
            className="btn-danger text-xs"
            onClick={batchDelete}
            disabled={batchBusy}
          >
            批量删除
          </button>
          <button
            className="btn-ghost text-xs ml-auto"
            onClick={() => setSelected(new Set())}
            disabled={batchBusy}
          >
            取消选择
          </button>
          {batchBusy && <span className="text-xs text-ink-400">处理中…</span>}
        </div>
      )}

      {!loading && !err && (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-ink-900 text-ink-400">
              <tr className="text-left">
                {isAdmin && (
                  <th className="px-4 py-3 font-medium w-10">
                    <input
                      type="checkbox"
                      className="cursor-pointer align-middle"
                      checked={allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someSelected;
                      }}
                      onChange={toggleAll}
                      disabled={selectableIds.length === 0}
                      title="全选 / 取消全选(仅 managed key)"
                    />
                  </th>
                )}
                <th className="px-4 py-3 font-medium">Label</th>
                <th className="px-4 py-3 font-medium">来源</th>
                <th className="px-4 py-3 font-medium text-center">Admin</th>
                <th className="px-4 py-3 font-medium text-center">启用</th>
                <th className="px-4 py-3 font-medium">配额(月)</th>
                <th className="px-4 py-3 font-medium">本月用量</th>
                <th className="px-4 py-3 font-medium">今日用量 / 额度</th>
                <th className="px-4 py-3 font-medium">可用模型</th>
                <th className="px-4 py-3 font-medium">MCP 授权</th>
                <th className="px-4 py-3 font-medium">Owner</th>
                {isAdmin && (
                  <th className="px-4 py-3 font-medium text-right">操作</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-800">
              {rows.map((row) => {
                const cost = row.consumed?.costUsd ?? 0;
                const limit = row.quota?.["monthly-cost-usd"];
                return (
                  <tr
                    key={row.apiKeyShort}
                    className={`hover:bg-ink-900/50 ${
                      row.managedId && selected.has(row.managedId)
                        ? "bg-emerald-950/30"
                        : ""
                    }`}
                  >
                    {isAdmin && (
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          className={
                            row.managedId
                              ? "cursor-pointer align-middle"
                              : "cursor-not-allowed opacity-40 align-middle"
                          }
                          checked={!!row.managedId && selected.has(row.managedId)}
                          disabled={!row.managedId}
                          onChange={() =>
                            row.managedId && toggleOne(row.managedId)
                          }
                          title={
                            row.managedId ? "选中以批量操作" : "config 来源,只读"
                          }
                        />
                      </td>
                    )}
                    <td className="px-4 py-3 font-medium">
                      {row.label || (
                        <span className="text-ink-500">(unlabeled)</span>
                      )}
                      <div className="text-xs text-ink-500 mt-0.5">
                        {row.apiKeyShort}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          row.source === "managed" ? "badge-ok" : "badge-muted"
                        }
                      >
                        {row.source === "managed" ? "managed" : "config(只读)"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      {row.admin ? "✓" : "·"}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {isAdmin ? (
                        <button
                          onClick={() => onToggleEnabled(row)}
                          disabled={!row.managedId}
                          className={`text-lg ${
                            row.managedId
                              ? "cursor-pointer"
                              : "cursor-not-allowed opacity-50"
                          }`}
                          title={
                            row.managedId
                              ? "点击切换启停"
                              : "config 来源,只读"
                          }
                        >
                          {row.enabled ? "✓" : "✗"}
                        </button>
                      ) : (
                        <span className="text-lg">{row.enabled ? "✓" : "✗"}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {limit != null ? (
                        <span>${limit}</span>
                      ) : (
                        <span className="text-ink-500">unlimited</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div>{fmtUSD(cost)}</div>
                      <div className="text-xs text-ink-500">
                        {fmtTokens(row.consumed?.tokens)}{" "}
                        {limit && (
                          <span className="ml-1 text-amber-400">
                            ({Math.round((cost / limit) * 100)}%)
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <TodayCell today={row.today} />
                    </td>
                    <td className="px-4 py-3">
                      {(row.allowedModels && row.allowedModels.length > 0) ||
                      (row.deniedModels && row.deniedModels.length > 0) ? (
                        <div className="flex flex-wrap gap-1 max-w-[16rem]">
                          {row.allowedModels?.map((m) => (
                            <span key={`a-${m}`} className="badge-ok text-xs">
                              {m}
                            </span>
                          ))}
                          {row.deniedModels?.map((m) => (
                            <span
                              key={`d-${m}`}
                              className="badge-err text-xs"
                              title="黑名单 — 禁止使用"
                            >
                              🚫 {m}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-ink-500 text-xs">全部</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <McpModeCell allowedMcp={row.allowedMcp} />
                    </td>
                    <td className="px-4 py-3 text-ink-400">
                      {row.owner || "—"}
                    </td>
                    {isAdmin && (
                      <td className="px-4 py-3 text-right whitespace-nowrap space-x-2">
                        <button
                          className="btn-ghost text-xs"
                          onClick={() => setEditing(row)}
                          disabled={!row.managedId}
                          title={!row.managedId ? "config 来源,只读" : ""}
                        >
                          编辑
                        </button>
                        <button
                          className={`btn-ghost text-xs ${
                            row.enabled
                              ? "text-amber-400 hover:text-amber-300"
                              : "text-emerald-400 hover:text-emerald-300"
                          }`}
                          onClick={() => onToggleEnabled(row)}
                          disabled={!row.managedId}
                          title={!row.managedId ? "config 来源,只读" : "启用 / 禁用"}
                        >
                          {row.enabled ? "禁用" : "启用"}
                        </button>
                        <button
                          className="btn-ghost text-xs text-emerald-400 hover:text-emerald-300"
                          onClick={() => setOverriding(row)}
                          disabled={!row.managedId}
                          title={!row.managedId ? "config 来源,只读" : "今日临时额度(明日自动恢复)"}
                        >
                          今日加额
                        </button>
                        <button
                          className="btn-ghost text-xs"
                          onClick={() => onRotate(row)}
                          disabled={!row.managedId}
                          title={!row.managedId ? "config 来源,只读" : "重置(换新 key,旧的失效)"}
                        >
                          重置
                        </button>
                        <button
                          className="btn-ghost text-xs text-rose-400 hover:text-rose-300"
                          onClick={() => onDelete(row)}
                          disabled={!row.managedId}
                          title={!row.managedId ? "config 来源,只读" : ""}
                        >
                          删除
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={isAdmin ? 12 : 10}
                    className="px-4 py-8 text-center text-ink-500"
                  >
                    {isAdmin
                      ? "没有 key,点右上角\"新增\"创建一个"
                      : "暂无可见 key"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <CreateKeyModal
        open={showCreate}
        models={models}
        mcpServers={mcpServers}
        onClose={() => setShowCreate(false)}
        onCreated={(resp) => {
          setShowCreate(false);
          setCreatedKey(resp);
          load();
        }}
      />

      <EditKeyModal
        row={editing}
        models={models}
        mcpServers={mcpServers}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          load();
        }}
      />

      <DailyOverrideModal
        row={overriding}
        onClose={() => setOverriding(null)}
        onSaved={() => {
          setOverriding(null);
          load();
        }}
      />

      <BatchModelsModal
        kind={batchModal === "deny" ? "deny" : "allow"}
        open={batchModal === "allow" || batchModal === "deny"}
        count={selected.size}
        models={models}
        busy={batchBusy}
        onClose={() => setBatchModal(null)}
        onApply={(list) =>
          batchSetModels(batchModal === "deny" ? "deny" : "allow", list)
        }
      />

      <BatchQuotaModal
        open={batchModal === "quota"}
        count={selected.size}
        models={models}
        busy={batchBusy}
        onClose={() => setBatchModal(null)}
        onApply={batchSetQuota}
      />

      {createdKey && (
        <Modal
          open
          onClose={() => setCreatedKey(null)}
          title="✓ Key 已创建 — 这是唯一一次能看到明文"
          size="lg"
        >
          <div className="space-y-3">
            <p className="text-sm text-ink-300">
              立即复制保存,关掉这个对话框后**就再也看不到了**(后端只存 hash)。
              下方是为该用户生成的专属接入文档,可直接复制 / 下载发给成员。
            </p>
            <div className="bg-ink-800 p-3 rounded-md break-all font-mono text-sm">
              {createdKey.key}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="btn-primary"
                onClick={() => navigator.clipboard.writeText(createdKey.key)}
              >
                复制 key
              </button>
              <button
                className="btn-secondary"
                onClick={() =>
                  navigator.clipboard.writeText(
                    buildAccessDoc(createdKey.key, createdKey.label, whoami?.publicBaseUrl, whoami?.coworkBaseUrl, whoami?.brand),
                  )
                }
              >
                复制接入文档
              </button>
              <button
                className="btn-secondary"
                onClick={() =>
                  downloadAccessDoc(createdKey.key, createdKey.label, createdKey.id, whoami?.publicBaseUrl, whoami?.coworkBaseUrl, whoami?.brand)
                }
              >
                下载文档 (.md)
              </button>
              <button
                className="btn-secondary"
                onClick={() => setCreatedKey(null)}
              >
                我保存好了
              </button>
            </div>
            <details className="text-sm" open>
              <summary className="cursor-pointer text-ink-400 hover:text-ink-200">
                预览接入文档
              </summary>
              <div
                className="md-body mt-2 bg-ink-900 border border-ink-800 p-4 rounded-md max-h-96 overflow-auto"
                dangerouslySetInnerHTML={{
                  __html: renderAccessDocHtml(
                    buildAccessDoc(createdKey.key, createdKey.label, whoami?.publicBaseUrl, whoami?.coworkBaseUrl, whoami?.brand),
                  ),
                }}
              />
            </details>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ─── Create modal ───────────────────────────────────────────── */

function CreateKeyModal({
  open,
  models,
  mcpServers,
  onClose,
  onCreated,
}: {
  open: boolean;
  models: string[];
  mcpServers: McpServerView[];
  onClose: () => void;
  onCreated: (resp: CreateKeyResponse) => void;
}) {
  const [label, setLabel] = useState("");
  const [owner, setOwner] = useState("");
  const [role, setRole] = useState<KeyRole>("member");
  const [quota, setQuota] = useState<KeyQuota>({});
  const [allowedModels, setAllowedModels] = useState<string[]>([]);
  const [deniedModels, setDeniedModels] = useState<string[]>([]);
  const [allowedMcp, setAllowedMcp] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState("");
  const [mcpQuota, setMcpQuota] = useState<McpQuota>({});
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function reset() {
    setLabel("");
    setOwner("");
    setRole("member");
    setQuota({});
    setAllowedModels([]);
    setDeniedModels([]);
    setAllowedMcp([]);
    setExpiresAt("");
    setMcpQuota({});
    setErr(null);
  }

  async function onSubmit() {
    setSubmitting(true);
    setErr(null);
    try {
      const input: CreateKeyInput = { label, role, enabled: true };
      if (owner) input.owner = owner;
      const cleaned = cleanQuota(quota);
      if (cleaned) input.quota = cleaned;
      if (allowedModels.length > 0) input["allowed-models"] = allowedModels;
      if (deniedModels.length > 0) input["denied-models"] = deniedModels;
      if (allowedMcp.length > 0) input["allowed-mcp"] = allowedMcp;
      if (expiresAt) input["expires-at"] = `${expiresAt}T23:59:59Z`;
      if (Object.keys(mcpQuota).length > 0) input["mcp-quota"] = mcpQuota;
      const resp = await createKey(input);
      reset();
      onCreated(resp);
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="新增 API key"
    >
      <div className="space-y-4">
        <div>
          <label className="block text-sm text-ink-400 mb-1.5">
            Label <span className="text-ink-500">(例:lisi/dev)</span>
          </label>
          <input
            className="input"
            placeholder="zhangsan/dev"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm text-ink-400 mb-1.5">
            Owner email <span className="text-ink-500">(可选)</span>
          </label>
          <input
            className="input"
            placeholder="user@example.com"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-ink-500 mb-1">角色</label>
          <select
            className="input !py-1"
            value={role}
            onChange={(e) => setRole(e.target.value as KeyRole)}
          >
            <option value="member">成员(仅自己:查用量 / 重置自己的 key)</option>
            <option value="auditor">审计员(只读全局:用量 / 日志 / 账号)</option>
            <option value="admin">管理员(全部 /admin/* + 配置 + 增删改)</option>
          </select>
        </div>
        <QuotaEditor value={quota} onChange={setQuota} models={models} />
        <ModelAllowlistPicker
          models={models}
          selected={allowedModels}
          onChange={setAllowedModels}
        />
        <ModelAllowlistPicker
          models={models}
          selected={deniedModels}
          onChange={setDeniedModels}
          title="禁用模型(黑名单)"
          hint="(列出的一律 403,优先级高于白名单)"
          accent="rose"
        />
        <McpGrantPicker servers={mcpServers} selected={allowedMcp} onChange={setAllowedMcp} />
        <McpQuotaEditor servers={mcpServers} value={mcpQuota} onChange={setMcpQuota} />
        <ExpiryField value={expiresAt} onChange={setExpiresAt} />
        {err && <div className="badge-err px-3 py-2 block">{err}</div>}
        <div className="flex justify-end gap-2 pt-3 sticky bottom-0 -mx-5 -mb-5 px-5 py-3 bg-ink-900 border-t border-ink-800">
          <button
            className="btn-secondary"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            取消
          </button>
          <button
            className="btn-primary"
            onClick={onSubmit}
            disabled={submitting || !label.trim()}
          >
            {submitting ? "创建中..." : "创建"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ─── Edit modal ───────────────────────────────────────────── */

function EditKeyModal({
  row,
  models,
  mcpServers,
  onClose,
  onSaved,
}: {
  row: MergedRow | null;
  models: string[];
  mcpServers: McpServerView[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState("");
  const [owner, setOwner] = useState("");
  const [role, setRole] = useState<KeyRole>("member");
  const [quota, setQuota] = useState<KeyQuota>({});
  const [allowedModels, setAllowedModels] = useState<string[]>([]);
  const [deniedModels, setDeniedModels] = useState<string[]>([]);
  const [allowedMcp, setAllowedMcp] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState("");
  const [mcpQuota, setMcpQuota] = useState<McpQuota>({});
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (row) {
      setLabel(row.label || "");
      setOwner(row.owner || "");
      setRole(row.role ?? (row.admin ? "admin" : "member"));
      setQuota(row.quota ?? {});
      setAllowedModels(row.allowedModels ?? []);
      setDeniedModels(row.deniedModels ?? []);
      setAllowedMcp(row.allowedMcp ?? []);
      setExpiresAt(row.expiresAt ? row.expiresAt.slice(0, 10) : "");
      setMcpQuota(row.mcpQuota ?? {});
      setErr(null);
    }
  }, [row]);

  if (!row || !row.managedId) return null;

  async function onSubmit() {
    if (!row || !row.managedId) return;
    setSubmitting(true);
    setErr(null);
    try {
      await updateKey(row.managedId, {
        label,
        owner: owner || undefined,
        role,
        // null clears the quota; cleanQuota returns null when all caps empty.
        quota: cleanQuota(quota),
        // Always send: an empty array clears the list.
        "allowed-models": allowedModels,
        "denied-models": deniedModels,
        "allowed-mcp": allowedMcp,
        // Always send so clearing works: "" → null (never expires); {} → null.
        "expires-at": expiresAt ? `${expiresAt}T23:59:59Z` : null,
        "mcp-quota": Object.keys(mcpQuota).length > 0 ? mcpQuota : null,
      });
      onSaved();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={!!row} onClose={onClose} title={`编辑 ${row.label || row.apiKeyShort}`}>
      <div className="space-y-4">
        <div>
          <label className="block text-sm text-ink-400 mb-1.5">Label</label>
          <input
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm text-ink-400 mb-1.5">Owner</label>
          <input
            className="input"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm text-ink-400 mb-1.5">角色</label>
          <select
            className="input"
            value={role}
            onChange={(e) => setRole(e.target.value as KeyRole)}
          >
            <option value="member">成员(仅自己)</option>
            <option value="auditor">审计员(只读全局)</option>
            <option value="admin">管理员(全部)</option>
          </select>
        </div>
        <QuotaEditor value={quota} onChange={setQuota} models={models} />
        <ModelAllowlistPicker
          models={models}
          selected={allowedModels}
          onChange={setAllowedModels}
        />
        <ModelAllowlistPicker
          models={models}
          selected={deniedModels}
          onChange={setDeniedModels}
          title="禁用模型(黑名单)"
          hint="(列出的一律 403,优先级高于白名单)"
          accent="rose"
        />
        <McpGrantPicker servers={mcpServers} selected={allowedMcp} onChange={setAllowedMcp} />
        <McpQuotaEditor servers={mcpServers} value={mcpQuota} onChange={setMcpQuota} />
        <ExpiryField value={expiresAt} onChange={setExpiresAt} />
        {err && <div className="badge-err px-3 py-2 block">{err}</div>}
        <div className="flex justify-end gap-2 pt-3 sticky bottom-0 -mx-5 -mb-5 px-5 py-3 bg-ink-900 border-t border-ink-800">
          <button className="btn-secondary" onClick={onClose}>
            取消
          </button>
          <button
            className="btn-primary"
            onClick={onSubmit}
            disabled={submitting}
          >
            {submitting ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ─── 今日临时加额(明日自动恢复)──────────────────────────── */

function DailyOverrideModal({
  row,
  onClose,
  onSaved,
}: {
  row: MergedRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [cost, setCost] = useState("");
  const [tokens, setTokens] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (row) {
      // Prefill with the currently-effective daily caps (override or base).
      setCost(row.today?.capCostUsd != null ? String(row.today.capCostUsd) : "");
      setTokens(row.today?.capTokens != null ? String(row.today.capTokens) : "");
      setErr(null);
    }
  }, [row]);

  if (!row) return null;
  const baseCost = row.today?.baseCapCostUsd;
  const baseTokens = row.today?.baseCapTokens;
  const active = row.today?.overrideActive;

  async function apply(clear: boolean) {
    if (!row?.managedId) {
      setErr("config.yaml 里的 key 只读,无法设置");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await setDailyOverride(row.managedId, clear
        ? { clear: true }
        : {
            "daily-cost-usd": cost.trim() ? Number(cost) : null,
            "daily-tokens": tokens.trim() ? Number(tokens) : null,
          });
      onSaved();
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={!!row} onClose={onClose} title={`今日临时额度 · ${row.label || row.apiKeyShort}`}>
      <div className="space-y-4 text-sm">
        <p className="text-xs text-ink-500">
          只改<strong>今天(UTC)</strong>的日额度,<strong>明天自动恢复</strong>固定配额,无需手动调回。
          留空 = 该维度用回固定日额度。今日已用:{fmtUSD(row.today?.costUsd)} ·{" "}
          {fmtTokens(row.today?.tokens)} tok。
        </p>
        <div>
          <label className="block text-xs text-ink-500 mb-1">
            今日日成本上限($){" "}
            <span className="text-ink-600">
              固定值:{baseCost != null ? `$${baseCost}` : "未设"}
            </span>
          </label>
          <input
            className="input !py-1"
            type="number"
            min="0"
            placeholder={baseCost != null ? String(baseCost) : "留空=不限"}
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-ink-500 mb-1">
            今日日 Token 上限{" "}
            <span className="text-ink-600">
              固定值:{baseTokens != null ? fmtTokens(baseTokens) : "未设"}
            </span>
          </label>
          <input
            className="input !py-1"
            type="number"
            min="0"
            placeholder={baseTokens != null ? String(baseTokens) : "留空=不限"}
            value={tokens}
            onChange={(e) => setTokens(e.target.value)}
          />
        </div>
        {err && <div className="badge-err px-3 py-2 block">{err}</div>}
        <div className="flex justify-between gap-2 pt-1">
          <button
            className="btn-ghost text-xs text-ink-400"
            onClick={() => apply(true)}
            disabled={busy || !active}
            title={active ? "清除今日临时额度,立即恢复固定配额" : "当前无今日临时额度"}
          >
            清除今日临时额度
          </button>
          <div className="flex gap-2">
            <button className="btn-secondary" onClick={onClose}>取消</button>
            <button className="btn-primary" onClick={() => apply(false)} disabled={busy}>
              {busy ? "设置中..." : "设为今日额度"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ─── Quota editor (key-total + per-model, month + day) ──────── */

const CAP_FIELDS: Array<{ key: keyof KeyModelQuota; label: string; unit: string }> = [
  { key: "monthly-cost-usd", label: "月成本", unit: "$" },
  { key: "monthly-tokens", label: "月 Token", unit: "tok" },
  { key: "daily-cost-usd", label: "日成本", unit: "$" },
  { key: "daily-tokens", label: "日 Token", unit: "tok" },
];

/** Strip empty caps; return null when the whole quota is empty so the caller
 *  can omit it (or clear it on update). */
function cleanQuota(q: KeyQuota): KeyQuota | null {
  const out: KeyQuota = {};
  for (const f of CAP_FIELDS) {
    const v = q[f.key];
    if (typeof v === "number" && v > 0) out[f.key] = v;
  }
  if (q["per-model"]) {
    const pm: Record<string, KeyModelQuota> = {};
    for (const [model, caps] of Object.entries(q["per-model"])) {
      const c: KeyModelQuota = {};
      for (const f of CAP_FIELDS) {
        const v = caps[f.key];
        if (typeof v === "number" && v > 0) c[f.key] = v;
      }
      if (Object.keys(c).length > 0) pm[model] = c;
    }
    if (Object.keys(pm).length > 0) out["per-model"] = pm;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function CapRow({
  caps,
  onChange,
}: {
  caps: KeyModelQuota;
  onChange: (next: KeyModelQuota) => void;
}) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {CAP_FIELDS.map((f) => (
        <div key={f.key}>
          <label className="block text-[11px] text-ink-500 mb-0.5">
            {f.label}
          </label>
          <input
            className="input !py-1 text-sm"
            type="number"
            min="0"
            step={f.unit === "$" ? "1" : "1000"}
            placeholder="∞"
            value={caps[f.key] ?? ""}
            onChange={(e) => {
              const v = e.target.value === "" ? undefined : Number(e.target.value);
              onChange({ ...caps, [f.key]: v });
            }}
          />
        </div>
      ))}
    </div>
  );
}

/* ─── Batch: set model allow/deny list across selected keys ─────────── */

function BatchModelsModal({
  kind,
  open,
  count,
  models,
  busy,
  onClose,
  onApply,
}: {
  kind: "allow" | "deny";
  open: boolean;
  count: number;
  models: string[];
  busy: boolean;
  onClose: () => void;
  onApply: (list: string[]) => void;
}) {
  const [list, setList] = useState<string[]>([]);
  const isDeny = kind === "deny";

  // Reset the picker each time the modal opens — it applies to a fresh
  // selection, not whatever was left from last time.
  useEffect(() => {
    if (open) setList([]);
  }, [open, kind]);

  const noun = isDeny ? "黑名单" : "白名单";

  return (
    <Modal open={open} onClose={onClose} title={`批量设模型${noun} · ${count} 个 key`}>
      <div className="space-y-4">
        <div className="badge-warn px-3 py-2 text-xs block">
          将<b>覆盖</b>这 {count} 个 key 现有的模型{noun}(不是追加)。
          {isDeny
            ? "不选任何模型 = 清空黑名单(不再禁用任何模型)。白名单不受影响。"
            : "不选任何模型 = 清空白名单 = 允许全部。黑名单不受影响。"}
        </div>
        <ModelAllowlistPicker
          models={models}
          selected={list}
          onChange={setList}
          title={isDeny ? "禁用模型(黑名单)" : "可用模型(白名单)"}
          hint={
            isDeny
              ? "(列出的一律 403,优先级高于白名单)"
              : "(不选 = 清空为允许全部;选中后这些 key 仅允许这些模型)"
          }
          accent={isDeny ? "rose" : "emerald"}
        />
        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="btn-primary"
            onClick={() => onApply(list)}
            disabled={busy}
          >
            {busy
              ? "应用中…"
              : list.length === 0
                ? `清空${noun}(${count} 个)`
                : `应用到 ${count} 个 key`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ─── Batch: set quota across selected keys ─────────── */

function BatchQuotaModal({
  open,
  count,
  models,
  busy,
  onClose,
  onApply,
}: {
  open: boolean;
  count: number;
  models: string[];
  busy: boolean;
  onClose: () => void;
  onApply: (quota: KeyQuota | null) => void;
}) {
  const [quota, setQuota] = useState<KeyQuota>({});

  useEffect(() => {
    if (open) setQuota({});
  }, [open]);

  // A quota with no key-total caps AND no per-model caps is "empty" → clearing.
  const isEmpty =
    quota["monthly-cost-usd"] == null &&
    quota["monthly-tokens"] == null &&
    quota["daily-cost-usd"] == null &&
    quota["daily-tokens"] == null &&
    Object.keys(quota["per-model"] ?? {}).length === 0;

  return (
    <Modal open={open} onClose={onClose} title={`批量设额度 · ${count} 个 key`}>
      <div className="space-y-4">
        <div className="badge-warn px-3 py-2 text-xs block">
          将<b>覆盖</b>这 {count} 个 key 现有的额度(不是叠加)。
          全部留空 = 清空额度 = 改为不限。今日临时加额不受影响。
        </div>
        <QuotaEditor value={quota} onChange={setQuota} models={models} />
        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="btn-primary"
            onClick={() => onApply(isEmpty ? null : quota)}
            disabled={busy}
          >
            {busy
              ? "应用中…"
              : isEmpty
                ? `清空额度(${count} 个)`
                : `应用到 ${count} 个 key`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function QuotaEditor({
  value,
  onChange,
  models,
}: {
  value: KeyQuota;
  onChange: (next: KeyQuota) => void;
  models: string[];
}) {
  const perModel = value["per-model"] ?? {};
  const perModelKeys = Object.keys(perModel);

  const setKeyTotal = (caps: KeyModelQuota) => {
    onChange({ ...caps, "per-model": value["per-model"] });
  };
  const setModelCaps = (model: string, caps: KeyModelQuota) => {
    onChange({ ...value, "per-model": { ...perModel, [model]: caps } });
  };
  const addModelRow = () => {
    // pick first model not already configured
    const candidate = models.find((m) => !(m in perModel)) ?? models[0] ?? "";
    if (!candidate) return;
    onChange({ ...value, "per-model": { ...perModel, [candidate]: {} } });
  };
  const removeModelRow = (model: string) => {
    const next = { ...perModel };
    delete next[model];
    onChange({ ...value, "per-model": next });
  };
  const renameModelRow = (oldModel: string, newModel: string) => {
    if (oldModel === newModel) return;
    const next: Record<string, KeyModelQuota> = {};
    for (const [k, v] of Object.entries(perModel)) {
      next[k === oldModel ? newModel : k] = v;
    }
    onChange({ ...value, "per-model": next });
  };

  // key-total caps = value minus per-model
  const keyTotal: KeyModelQuota = {
    "monthly-cost-usd": value["monthly-cost-usd"],
    "monthly-tokens": value["monthly-tokens"],
    "daily-cost-usd": value["daily-cost-usd"],
    "daily-tokens": value["daily-tokens"],
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm text-ink-400 mb-1.5">
          额度 · 总额{" "}
          <span className="text-ink-500">(留空 = 不限;到额返回 429)</span>
        </label>
        <CapRow caps={keyTotal} onChange={setKeyTotal} />
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-sm text-ink-400">
            额度 · 按模型{" "}
            <span className="text-ink-500">(对单个模型单独限额)</span>
          </label>
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={addModelRow}
            disabled={models.length === 0}
          >
            + 添加模型
          </button>
        </div>
        {perModelKeys.length === 0 ? (
          <div className="text-xs text-ink-500">未配置按模型额度</div>
        ) : (
          <div className="space-y-2">
            {perModelKeys.map((model) => (
              <div key={model} className="bg-ink-900 rounded-md p-2 space-y-2">
                <div className="flex items-center gap-2">
                  <select
                    className="input !py-1 text-sm flex-1"
                    value={model}
                    onChange={(e) => renameModelRow(model, e.target.value)}
                  >
                    {models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                    {!models.includes(model) && (
                      <option value={model}>{model}</option>
                    )}
                  </select>
                  <button
                    type="button"
                    className="btn-ghost text-xs text-rose-400"
                    onClick={() => removeModelRow(model)}
                  >
                    移除
                  </button>
                </div>
                <CapRow
                  caps={perModel[model]}
                  onChange={(c) => setModelCaps(model, c)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── MCP 类目授权(默认拒绝)──────────────────────────────── */

/* ─── Expiry date field ──────────────────────────────────────── */

function ExpiryField({
  value,
  onChange,
}: {
  value: string; // "YYYY-MM-DD" or ""
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-sm text-ink-400 mb-1.5">
        过期时间{" "}
        <span className="text-ink-500">(留空 = 永不过期;到期当天结束后该 key 立即 401)</span>
      </label>
      <input
        type="date"
        className="input !py-1"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/* ─── MCP call-count quota editor ────────────────────────────── */

function McpQuotaEditor({
  servers,
  value,
  onChange,
}: {
  servers: McpServerView[];
  value: McpQuota;
  onChange: (v: McpQuota) => void;
}) {
  const num = (s: string): number | undefined => {
    const n = Number(s);
    return s.trim() === "" || !Number.isFinite(n) || n <= 0 ? undefined : n;
  };
  const setOverall = (k: "daily-calls" | "monthly-calls", s: string) => {
    const next = { ...value };
    const v = num(s);
    if (v === undefined) delete next[k];
    else next[k] = v;
    onChange(next);
  };
  const setPer = (id: string, k: "daily" | "monthly", s: string) => {
    const per = { ...(value["per-server"] ?? {}) };
    const cur = { ...(per[id] ?? {}) };
    const v = num(s);
    if (v === undefined) delete cur[k];
    else cur[k] = v;
    if (Object.keys(cur).length === 0) delete per[id];
    else per[id] = cur;
    const next = { ...value };
    if (Object.keys(per).length === 0) delete next["per-server"];
    else next["per-server"] = per;
    onChange(next);
  };
  const per = value["per-server"] ?? {};
  return (
    <div>
      <label className="block text-sm text-ink-400 mb-1.5">
        MCP 调用次数配额{" "}
        <span className="text-ink-500">(留空 = 不限制;按 UTC 日/月计数)</span>
      </label>
      <div className="border border-ink-800 rounded-md p-2 space-y-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-ink-400 w-16">整体</span>
          <input
            className="input !py-1 text-sm"
            placeholder="日上限"
            type="number"
            min="1"
            value={value["daily-calls"] ?? ""}
            onChange={(e) => setOverall("daily-calls", e.target.value)}
          />
          <input
            className="input !py-1 text-sm"
            placeholder="月上限"
            type="number"
            min="1"
            value={value["monthly-calls"] ?? ""}
            onChange={(e) => setOverall("monthly-calls", e.target.value)}
          />
        </div>
        {servers.length > 0 && (
          <div className="text-xs text-ink-500">按单个 MCP(可选,优先于整体):</div>
        )}
        {servers.map((s) => (
          <div key={s.id} className="flex items-center gap-2 text-sm">
            <span className="font-mono text-ink-300 w-16 truncate" title={s.id}>
              {s.id}
            </span>
            <input
              className="input !py-1 text-sm"
              placeholder="日上限"
              type="number"
              min="1"
              value={per[s.id]?.daily ?? ""}
              onChange={(e) => setPer(s.id, "daily", e.target.value)}
            />
            <input
              className="input !py-1 text-sm"
              placeholder="月上限"
              type="number"
              min="1"
              value={per[s.id]?.monthly ?? ""}
              onChange={(e) => setPer(s.id, "monthly", e.target.value)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function McpGrantPicker({
  servers,
  selected,
  onChange,
}: {
  servers: McpServerView[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [toolsCache, setToolsCache] = useState<Record<string, McpTool[]>>({});

  const has = (v: string) => selected.includes(v);
  const set = (v: string, on: boolean) =>
    onChange(on ? [...selected, v] : selected.filter((x) => x !== v));

  function toggleWhole(id: string) {
    const on = !has(id);
    // granting whole category clears any tool-scoped entries for it
    const cleaned = selected.filter((x) => x !== id && !x.startsWith(`${id}__`));
    onChange(on ? [...cleaned, id] : cleaned);
  }

  function expand(id: string) {
    setExpanded((cur) => (cur === id ? null : id));
    if (!toolsCache[id]) {
      fetchMcpTools(id)
        .then((r) => setToolsCache((c) => ({ ...c, [id]: r.tools })))
        .catch(() => setToolsCache((c) => ({ ...c, [id]: [] })));
    }
  }

  return (
    <div>
      <label className="block text-xs text-ink-500 mb-1">
        允许的 MCP 类目 / 工具{" "}
        <span className="text-ink-600">(默认拒绝:不勾选则看不到任何 MCP)</span>
      </label>
      {servers.length === 0 ? (
        <div className="text-xs text-ink-600">
          尚未注册 MCP 服务 —— 先到「设置 → MCP 服务」添加。
        </div>
      ) : (
        <div className="space-y-1.5 border border-ink-800 rounded-md p-2">
          {servers.map((s) => {
            const whole = has(s.id);
            const toolGrants = selected.filter((x) => x.startsWith(`${s.id}__`));
            const isOpen = expanded === s.id;
            return (
              <div key={s.id}>
                <div className="flex items-center gap-2 text-sm">
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={whole} onChange={() => toggleWhole(s.id)} />
                    <span className="text-ink-200">{s.label}</span>
                    <span className="text-ink-500 text-xs">({s.id} · 整个类目)</span>
                  </label>
                  <button
                    type="button"
                    className="text-ink-500 hover:text-ink-300 text-xs ml-auto"
                    onClick={() => expand(s.id)}
                  >
                    {isOpen ? "收起工具" : `按工具${toolGrants.length ? ` (${toolGrants.length})` : ""}`}
                  </button>
                </div>
                {isOpen && (
                  <div className="ml-6 mt-1 max-h-48 overflow-auto space-y-0.5">
                    {!toolsCache[s.id] && <div className="text-ink-600 text-xs">加载工具…</div>}
                    {toolsCache[s.id]?.length === 0 && (
                      <div className="text-ink-600 text-xs">无工具或上游不可用。</div>
                    )}
                    {toolsCache[s.id]?.map((t) => {
                      const key = `${s.id}__${t.name}`;
                      return (
                        <label key={key} className="flex items-center gap-1.5 text-xs">
                          <input
                            type="checkbox"
                            checked={whole || has(key)}
                            disabled={whole}
                            onChange={(e) => set(key, e.target.checked)}
                          />
                          <span className="font-mono text-ink-300">{t.name}</span>
                        </label>
                      );
                    })}
                    {whole && (
                      <div className="text-ink-600 text-xs">(已授权整个类目,含全部工具)</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Model allowlist picker ─────────────────────────────────── */

function ModelAllowlistPicker({
  models,
  selected,
  onChange,
  title = "可用模型",
  hint = "(不选 = 允许全部;选中后仅允许这些,其余 403)",
  accent = "emerald",
}: {
  models: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  title?: string;
  hint?: string;
  accent?: "emerald" | "rose";
}) {
  const onCls =
    accent === "rose"
      ? "bg-rose-600 border-rose-500 text-white"
      : "bg-emerald-600 border-emerald-500 text-white";
  const [custom, setCustom] = useState("");

  const toggle = (m: string) => {
    onChange(
      selected.includes(m)
        ? selected.filter((x) => x !== m)
        : [...selected, m],
    );
  };

  const addCustom = () => {
    const m = custom.trim();
    if (!m) return;
    if (!selected.includes(m)) onChange([...selected, m]);
    setCustom("");
  };

  // Show /v1/models options plus any already-selected entries that aren't in
  // that list (e.g. models from a provider not yet authed, or manual ones).
  const known = new Set(models);
  const extras = selected.filter((m) => !known.has(m));
  const chips = [...models, ...extras];

  return (
    <div>
      <label className="block text-sm text-ink-400 mb-1.5">
        {title} <span className="text-ink-500">{hint}</span>
      </label>
      {chips.length === 0 ? (
        <div className="text-xs text-ink-500 mb-2">
          模型列表加载中 — 也可在下方手动输入
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto p-2 bg-ink-900 rounded-md">
          {chips.map((m) => {
            const on = selected.includes(m);
            const isExtra = !known.has(m);
            return (
              <button
                key={m}
                type="button"
                onClick={() => toggle(m)}
                className={`text-xs px-2 py-1 rounded-md border ${
                  on ? onCls : "border-ink-700 text-ink-300 hover:bg-ink-800"
                }`}
                title={isExtra ? "手动添加 / 当前未在 /v1/models 中" : undefined}
              >
                {on ? "✓ " : ""}
                {m}
                {isExtra && <span className="ml-1 opacity-60">·手动</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* 手动输入(provider 尚未认证、或想预设别的模型时用) */}
      <div className="flex gap-2 mt-2">
        <input
          className="input !py-1 text-sm flex-1"
          placeholder="手动输入模型名,如 gpt-5.5 / claude-opus-4-8"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCustom();
            }
          }}
        />
        <button
          type="button"
          className="btn-secondary text-xs whitespace-nowrap"
          onClick={addCustom}
          disabled={!custom.trim()}
        >
          添加
        </button>
      </div>

      {selected.length > 0 && (
        <div className="text-xs text-ink-500 mt-1">
          已选 {selected.length} 个
          <button
            type="button"
            className="ml-2 text-ink-400 hover:text-ink-200 underline"
            onClick={() => onChange([])}
          >
            清空
          </button>
        </div>
      )}
    </div>
  );
}
