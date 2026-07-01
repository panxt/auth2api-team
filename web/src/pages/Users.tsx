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
  CreateKeyResponse,
  KeyQuota,
  KeyModelQuota,
  KeyRole,
} from "../api/keys";
import { ApiError } from "../api/client";
import { Modal } from "../components/Modal";
import { useAuth } from "../lib/auth";
import { buildAccessDoc, downloadAccessDoc } from "../lib/accessDoc";

interface MergedRow extends UsageKey {
  source: "managed" | "config";
  managedId: string | null;   // null = config-only key (read-only)
  role: KeyRole | null;       // from managed view; null for config-only
  allowedModels: string[] | null; // model allowlist (managed keys only)
  deniedModels: string[] | null;  // model denylist (managed keys only)
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
  const [createdKey, setCreatedKey] = useState<CreateKeyResponse | null>(null); // raw key + meta, shown once

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
        onCreated={(resp) => {
          setShowCreate(false);
          setCreatedKey(resp);
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
                    buildAccessDoc(createdKey.key, createdKey.label),
                  )
                }
              >
                复制接入文档
              </button>
              <button
                className="btn-secondary"
                onClick={() =>
                  downloadAccessDoc(createdKey.key, createdKey.label, createdKey.id)
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
            <details className="text-sm">
              <summary className="cursor-pointer text-ink-400 hover:text-ink-200">
                预览接入文档
              </summary>
              <pre className="mt-2 bg-ink-800 p-3 rounded-md text-xs whitespace-pre-wrap max-h-72 overflow-auto">
                {buildAccessDoc(createdKey.key, createdKey.label)}
              </pre>
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
  onClose,
  onCreated,
}: {
  open: boolean;
  models: string[];
  onClose: () => void;
  onCreated: (resp: CreateKeyResponse) => void;
}) {
  const [label, setLabel] = useState("");
  const [owner, setOwner] = useState("");
  const [role, setRole] = useState<KeyRole>("member");
  const [quota, setQuota] = useState<KeyQuota>({});
  const [allowedModels, setAllowedModels] = useState<string[]>([]);
  const [deniedModels, setDeniedModels] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function reset() {
    setLabel("");
    setOwner("");
    setRole("member");
    setQuota({});
    setAllowedModels([]);
    setDeniedModels([]);
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
  const [role, setRole] = useState<KeyRole>("member");
  const [quota, setQuota] = useState<KeyQuota>({});
  const [allowedModels, setAllowedModels] = useState<string[]>([]);
  const [deniedModels, setDeniedModels] = useState<string[]>([]);
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
