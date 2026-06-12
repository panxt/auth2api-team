import { useEffect, useState, useCallback } from "react";
import {
  listUsage,
  listManaged,
  listModels,
  createKey,
  updateKey,
  deleteKey,
  UsageKey,
  ManagedKeyView,
  CreateKeyInput,
} from "../api/keys";
import { ApiError } from "../api/client";
import { Modal } from "../components/Modal";
import { useAuth } from "../lib/auth";

interface MergedRow extends UsageKey {
  source: "managed" | "config";
  managedId: string | null;   // null = config-only key (read-only)
  allowedModels: string[] | null; // model allowlist (managed keys only)
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

export function Users() {
  const { whoami } = useAuth();
  const isAdmin = !!whoami?.admin;

  const [rows, setRows] = useState<MergedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]); // for the allowlist picker

  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<MergedRow | null>(null);
  const [createdKey, setCreatedKey] = useState<string | null>(null); // raw key shown once

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
          allowedModels: m ? m["allowed-models"] : null,
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

  // Fetch the available model list once (admin only) for the allowlist picker.
  useEffect(() => {
    if (!isAdmin) return;
    listModels()
      .then((r) => setModels(r.data.map((m) => m.id)))
      .catch(() => setModels([]));
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

      {!loading && !err && (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-ink-900 text-ink-400">
              <tr className="text-left">
                <th className="px-4 py-3 font-medium">Label</th>
                <th className="px-4 py-3 font-medium">来源</th>
                <th className="px-4 py-3 font-medium text-center">Admin</th>
                <th className="px-4 py-3 font-medium text-center">启用</th>
                <th className="px-4 py-3 font-medium">配额(月)</th>
                <th className="px-4 py-3 font-medium">本月用量</th>
                <th className="px-4 py-3 font-medium">可用模型</th>
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
                  <tr key={row.apiKeyShort} className="hover:bg-ink-900/50">
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
                      {row.allowedModels && row.allowedModels.length > 0 ? (
                        <div className="flex flex-wrap gap-1 max-w-[14rem]">
                          {row.allowedModels.map((m) => (
                            <span key={m} className="badge-muted text-xs">
                              {m}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-ink-500 text-xs">全部</span>
                      )}
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
                    colSpan={isAdmin ? 9 : 8}
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
        onClose={() => setShowCreate(false)}
        onCreated={(rawKey) => {
          setShowCreate(false);
          setCreatedKey(rawKey);
          load();
        }}
      />

      <EditKeyModal
        row={editing}
        models={models}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          load();
        }}
      />

      {createdKey && (
        <Modal
          open
          onClose={() => setCreatedKey(null)}
          title="✓ Key 已创建 — 这是唯一一次能看到明文"
        >
          <div className="space-y-3">
            <p className="text-sm text-ink-300">
              立即复制保存,关掉这个对话框后**就再也看不到了**(后端只存 hash)。
            </p>
            <div className="bg-ink-800 p-3 rounded-md break-all font-mono text-sm">
              {createdKey}
            </div>
            <div className="flex gap-2">
              <button
                className="btn-primary"
                onClick={() => {
                  navigator.clipboard.writeText(createdKey);
                }}
              >
                复制
              </button>
              <button
                className="btn-secondary"
                onClick={() => setCreatedKey(null)}
              >
                我保存好了
              </button>
            </div>
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
  onClose,
  onCreated,
}: {
  open: boolean;
  models: string[];
  onClose: () => void;
  onCreated: (rawKey: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [owner, setOwner] = useState("");
  const [admin, setAdmin] = useState(false);
  const [quotaUsd, setQuotaUsd] = useState("");
  const [allowedModels, setAllowedModels] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function reset() {
    setLabel("");
    setOwner("");
    setAdmin(false);
    setQuotaUsd("");
    setAllowedModels([]);
    setErr(null);
  }

  async function onSubmit() {
    setSubmitting(true);
    setErr(null);
    try {
      const input: CreateKeyInput = { label, admin, enabled: true };
      if (owner) input.owner = owner;
      const usd = parseFloat(quotaUsd);
      if (!isNaN(usd) && usd > 0) {
        input.quota = { "monthly-cost-usd": usd };
      }
      if (allowedModels.length > 0) input["allowed-models"] = allowedModels;
      const resp = await createKey(input);
      reset();
      onCreated(resp.key);
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
        <div className="flex items-center gap-2">
          <input
            id="admin"
            type="checkbox"
            checked={admin}
            onChange={(e) => setAdmin(e.target.checked)}
          />
          <label htmlFor="admin" className="text-sm">
            Admin key(可调 /admin/* 全部接口)
          </label>
        </div>
        <div>
          <label className="block text-sm text-ink-400 mb-1.5">
            月度配额(USD)<span className="text-ink-500">(可选)</span>
          </label>
          <input
            className="input"
            type="number"
            min="0"
            step="1"
            placeholder="50"
            value={quotaUsd}
            onChange={(e) => setQuotaUsd(e.target.value)}
          />
        </div>
        <ModelAllowlistPicker
          models={models}
          selected={allowedModels}
          onChange={setAllowedModels}
        />
        {err && <div className="badge-err px-3 py-2 block">{err}</div>}
        <div className="flex justify-end gap-2 pt-2">
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
  onClose,
  onSaved,
}: {
  row: MergedRow | null;
  models: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState("");
  const [owner, setOwner] = useState("");
  const [admin, setAdmin] = useState(false);
  const [quotaUsd, setQuotaUsd] = useState("");
  const [allowedModels, setAllowedModels] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (row) {
      setLabel(row.label || "");
      setOwner(row.owner || "");
      setAdmin(row.admin);
      const q = row.quota?.["monthly-cost-usd"];
      setQuotaUsd(q != null ? String(q) : "");
      setAllowedModels(row.allowedModels ?? []);
      setErr(null);
    }
  }, [row]);

  if (!row || !row.managedId) return null;

  async function onSubmit() {
    if (!row || !row.managedId) return;
    setSubmitting(true);
    setErr(null);
    try {
      const usd = parseFloat(quotaUsd);
      const quota =
        !isNaN(usd) && usd > 0 ? { "monthly-cost-usd": usd } : undefined;
      await updateKey(row.managedId, {
        label,
        owner: owner || undefined,
        admin,
        quota,
        // Always send: an empty array clears the allowlist (= all allowed).
        "allowed-models": allowedModels,
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
        <div className="flex items-center gap-2">
          <input
            id="edit-admin"
            type="checkbox"
            checked={admin}
            onChange={(e) => setAdmin(e.target.checked)}
          />
          <label htmlFor="edit-admin" className="text-sm">
            Admin key
          </label>
        </div>
        <div>
          <label className="block text-sm text-ink-400 mb-1.5">
            月度配额(USD,留空 = 无限)
          </label>
          <input
            className="input"
            type="number"
            min="0"
            step="1"
            value={quotaUsd}
            onChange={(e) => setQuotaUsd(e.target.value)}
          />
        </div>
        <ModelAllowlistPicker
          models={models}
          selected={allowedModels}
          onChange={setAllowedModels}
        />
        {err && <div className="badge-err px-3 py-2 block">{err}</div>}
        <div className="flex justify-end gap-2 pt-2">
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

/* ─── Model allowlist picker ─────────────────────────────────── */

function ModelAllowlistPicker({
  models,
  selected,
  onChange,
}: {
  models: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (m: string) => {
    onChange(
      selected.includes(m)
        ? selected.filter((x) => x !== m)
        : [...selected, m],
    );
  };
  return (
    <div>
      <label className="block text-sm text-ink-400 mb-1.5">
        可用模型{" "}
        <span className="text-ink-500">
          (不选 = 允许全部;选中后仅允许这些,其余 403)
        </span>
      </label>
      {models.length === 0 ? (
        <div className="text-xs text-ink-500">模型列表加载中或不可用</div>
      ) : (
        <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto p-2 bg-ink-900 rounded-md">
          {models.map((m) => {
            const on = selected.includes(m);
            return (
              <button
                key={m}
                type="button"
                onClick={() => toggle(m)}
                className={`text-xs px-2 py-1 rounded-md border ${
                  on
                    ? "bg-emerald-600 border-emerald-500 text-white"
                    : "border-ink-700 text-ink-300 hover:bg-ink-800"
                }`}
              >
                {on ? "✓ " : ""}
                {m}
              </button>
            );
          })}
        </div>
      )}
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
