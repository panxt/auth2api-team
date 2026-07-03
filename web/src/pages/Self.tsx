import { useEffect, useState } from "react";
import { listUsage, rotateSelfKey, UsageKey, CreateKeyResponse } from "../api/keys";
import { ApiError } from "../api/client";
import { useAuth } from "../lib/auth";
import { Modal } from "../components/Modal";
import { buildAccessDoc, downloadAccessDoc, renderAccessDocHtml } from "../lib/accessDoc";

const ROLE_LABEL: Record<string, string> = {
  admin: "管理员",
  auditor: "审计员",
  member: "成员",
};

function fmtUSD(n: number | undefined): string {
  if (n == null) return "$0";
  return n >= 10 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}
function fmtTokens(n: number | undefined): string {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function Self() {
  const { whoami } = useAuth();
  const [mine, setMine] = useState<UsageKey | null>(null);
  const [loading, setLoading] = useState(true);
  const [rotated, setRotated] = useState<CreateKeyResponse | null>(null);
  const [rotating, setRotating] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    listUsage()
      .then((r) => {
        // members get only their own row; admins/auditors may get many — match
        // ours by the whoami hash prefix.
        const own =
          r.keys.find((k) => k.apiKeyShort === whoami?.apiKeyShort) ??
          r.keys[0] ??
          null;
        setMine(own);
      })
      .catch((e) => setErr((e as ApiError).message))
      .finally(() => setLoading(false));
  }, [whoami?.apiKeyShort]);

  async function doRotate() {
    setRotating(true);
    setErr(null);
    try {
      const resp = await rotateSelfKey();
      setConfirmRotate(false);
      setRotated(resp);
    } catch (e) {
      setErr(`重置失败: ${(e as ApiError).message}`);
      setConfirmRotate(false);
    } finally {
      setRotating(false);
    }
  }

  const isConfigKey = whoami?.source === "config";

  return (
    <div className="max-w-2xl">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">我的</h1>
        <p className="text-sm text-ink-400 mt-1">
          查看自己的身份与用量,自助重置 key。
        </p>
      </header>

      {/* 身份 */}
      <div className="card mb-4">
        <div className="text-sm space-y-1">
          <div className="flex gap-2">
            <span className="text-ink-500 w-20">名称</span>
            <span>{whoami?.label || "(未命名)"}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-ink-500 w-20">角色</span>
            <span className="badge-ok">
              {ROLE_LABEL[whoami?.role ?? (whoami?.admin ? "admin" : "member")] ??
                "成员"}
            </span>
          </div>
          <div className="flex gap-2">
            <span className="text-ink-500 w-20">Key 指纹</span>
            <span className="font-mono text-ink-400">{whoami?.apiKeyShort}…</span>
          </div>
        </div>
      </div>

      {/* 用量 */}
      <div className="card mb-4">
        <div className="text-sm font-medium mb-2">本月用量</div>
        {loading && <div className="text-ink-500 text-sm">加载中...</div>}
        {!loading && !mine && (
          <div className="text-ink-500 text-sm">暂无用量数据。</div>
        )}
        {mine && (
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-ink-500 text-xs">请求数</div>
              <div className="text-lg">{mine.consumed?.requests ?? 0}</div>
            </div>
            <div>
              <div className="text-ink-500 text-xs">花费(预估)</div>
              <div className="text-lg">{fmtUSD(mine.consumed?.costUsd)}</div>
            </div>
            <div>
              <div className="text-ink-500 text-xs">输入 token</div>
              <div className="text-lg">{fmtTokens(mine.consumed?.tokens)}</div>
            </div>
            <div>
              <div className="text-ink-500 text-xs">配额</div>
              <div className="text-lg">
                {mine.quota?.["monthly-cost-usd"]
                  ? `≤ $${mine.quota["monthly-cost-usd"]}/月`
                  : mine.quota?.["monthly-tokens"]
                    ? `≤ ${fmtTokens(mine.quota["monthly-tokens"])} tok/月`
                    : "不限"}
              </div>
            </div>
          </div>
        )}
        {err && <div className="text-rose-400 text-sm mt-2">{err}</div>}
      </div>

      {/* MCP 调用(按次数,不计 token / 成本;按不同 MCP 分开)*/}
      {mine && (
        <div className="card mb-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium">MCP 调用(本月)</div>
            <div className="text-xs text-ink-500">按调用次数计</div>
          </div>
          {(() => {
            const mcp = mine.mcp ?? {};
            const entries = Object.entries(mcp).sort((a, b) => b[1] - a[1]);
            const total = entries.reduce((s, [, n]) => s + n, 0);
            if (entries.length === 0) {
              return (
                <div className="text-ink-500 text-sm">
                  本月暂无 MCP 调用。授权的 MCP 类目 / 工具经 /mcp 端点调用后在此按次数统计。
                </div>
              );
            }
            return (
              <div className="space-y-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-cyan-300">{total}</span>
                  <span className="text-xs text-ink-500">总调用次数</span>
                </div>
                <div className="divide-y divide-ink-800">
                  {entries.map(([server, n]) => {
                    const pct = total ? (n / total) * 100 : 0;
                    return (
                      <div key={server} className="flex items-center gap-3 py-1.5 text-sm">
                        <span className="font-mono text-ink-200 w-32 truncate">{server}</span>
                        <div className="h-2 bg-ink-800 rounded-full overflow-hidden flex-1">
                          <div
                            className="h-full bg-cyan-500"
                            style={{ width: `${Math.min(100, pct)}%` }}
                          />
                        </div>
                        <span className="text-cyan-300 tabular-nums w-16 text-right">
                          {n} 次
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* 重置 key */}
      <div className="card">
        <div className="text-sm font-medium mb-1">重置我的 key</div>
        <p className="text-xs text-ink-400 mb-3">
          生成一个新 key 并立即作废旧 key(名称/角色/配额不变)。怀疑泄漏时用。
          {isConfigKey && (
            <span className="text-amber-400">
              {" "}
              你的 key 来自 config.yaml,只读,无法自助重置——请联系管理员。
            </span>
          )}
        </p>
        <button
          className="btn-primary text-sm"
          onClick={() => setConfirmRotate(true)}
          disabled={isConfigKey}
        >
          重置我的 key
        </button>
      </div>

      {/* 确认 */}
      <Modal
        open={confirmRotate}
        onClose={() => setConfirmRotate(false)}
        title="确认重置 key?"
      >
        <div className="space-y-3 text-sm">
          <p className="text-ink-300">
            旧 key 会<strong>立即失效</strong>,所有用它的客户端都需换成新 key。继续?
          </p>
          <div className="flex gap-2">
            <button className="btn-primary" onClick={doRotate} disabled={rotating}>
              {rotating ? "重置中..." : "确认重置"}
            </button>
            <button className="btn-secondary" onClick={() => setConfirmRotate(false)}>
              取消
            </button>
          </div>
        </div>
      </Modal>

      {/* 新 key + 接入文档 */}
      {rotated && (
        <Modal
          open
          onClose={() => setRotated(null)}
          title="✓ 新 key 已生成 — 仅此一次明文"
          size="lg"
        >
          <div className="space-y-3">
            <p className="text-sm text-ink-300">
              立即复制保存。旧 key 已失效。下方是更新后的接入文档。
            </p>
            <div className="bg-ink-800 p-3 rounded-md break-all font-mono text-sm">
              {rotated.key}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="btn-primary"
                onClick={() => navigator.clipboard.writeText(rotated.key)}
              >
                复制 key
              </button>
              <button
                className="btn-secondary"
                onClick={() =>
                  navigator.clipboard.writeText(
                    buildAccessDoc(rotated.key, rotated.label, whoami?.publicBaseUrl, whoami?.coworkBaseUrl, whoami?.brand),
                  )
                }
              >
                复制接入文档
              </button>
              <button
                className="btn-secondary"
                onClick={() => downloadAccessDoc(rotated.key, rotated.label, rotated.id, whoami?.publicBaseUrl, whoami?.coworkBaseUrl, whoami?.brand)}
              >
                下载文档 (.md)
              </button>
              <button className="btn-secondary" onClick={() => setRotated(null)}>
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
                    buildAccessDoc(rotated.key, rotated.label, whoami?.publicBaseUrl, whoami?.coworkBaseUrl, whoami?.brand),
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
