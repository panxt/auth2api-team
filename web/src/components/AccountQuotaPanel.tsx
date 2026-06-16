import { AccountSnapshot } from "../api/accounts";

/**
 * Renders the per-account quota status panel:
 *   - 5h (短) window utilization + reset countdown
 *   - 7d (周) window utilization + reset countdown
 *   - Retry-After badge if the account is currently rate-limited
 *   - Fallback: locally-tracked windowResetAt(from recordAttempt anchor)
 *     when upstream did not surface unified-* headers.
 *
 * Anthropic OAuth subscriptions return the `unified-*` headers we parse
 * from upstream rate-limit responses. Codex / Cursor accounts probably
 * won't surface them, in which case fields stay empty and we render a
 * dash.
 */

function fmtPct(s: string | undefined): { pct: number; label: string } | null {
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const pct = Math.max(0, Math.min(100, n * 100));
  return { pct, label: pct >= 100 ? "100%" : `${pct.toFixed(1)}%` };
}

function fmtUnixToLocal(s: string | undefined): string {
  if (!s) return "—";
  const n = Number(s);
  if (!Number.isFinite(n)) return "—";
  return new Date(n * 1000).toLocaleString();
}

function fmtIsoToLocal(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function fmtCountdown(targetMs: number): string {
  const diff = targetMs - Date.now();
  if (diff <= 0) return "已到期";
  const h = Math.floor(diff / 3600_000);
  const m = Math.floor((diff % 3600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtUnixCountdown(s: string | undefined): string {
  if (!s) return "—";
  const n = Number(s);
  if (!Number.isFinite(n)) return "—";
  return fmtCountdown(n * 1000);
}

/** 悬浮信息提示:标题旁的 ⓘ 图标,鼠标悬停展开详细解释(纯 CSS,无依赖)。 */
export function InfoTip({ text }: { text: string }) {
  return (
    <span className="relative inline-flex items-center group align-middle">
      <span
        className="ml-1 w-3.5 h-3.5 inline-flex items-center justify-center rounded-full border border-ink-600 text-ink-500 text-[9px] leading-none cursor-help select-none group-hover:border-ink-400 group-hover:text-ink-300"
        aria-hidden
      >
        i
      </span>
      <span className="pointer-events-none absolute left-0 top-full mt-1.5 z-30 hidden w-72 group-hover:block rounded-md border border-ink-700 bg-ink-900 px-3 py-2 text-xs font-normal leading-relaxed text-ink-300 shadow-xl whitespace-pre-line">
        {text}
      </span>
    </span>
  );
}

function StatusBadge(props: { status: string | undefined }) {
  const s = props.status?.toLowerCase();
  if (s === "allowed" || s === "ok") {
    return <span className="badge-ok">{s}</span>;
  }
  if (s === "rejected" || s === "denied") {
    return <span className="badge-err">{s}</span>;
  }
  if (s === "warn" || s === "warning") {
    return <span className="badge-warn">{s}</span>;
  }
  if (!s) return <span className="text-ink-500">—</span>;
  return <span className="badge-muted">{s}</span>;
}

function UtilizationBar(props: { pct: number }) {
  const tone =
    props.pct >= 90
      ? "bg-rose-500"
      : props.pct >= 70
        ? "bg-amber-500"
        : "bg-emerald-500";
  return (
    <div className="h-1.5 bg-ink-800 rounded-full overflow-hidden">
      <div
        className={`h-full ${tone} transition-all`}
        style={{ width: `${Math.min(100, props.pct)}%` }}
      />
    </div>
  );
}

export function AccountQuotaPanel({ account }: { account: AccountSnapshot }) {
  const rl = account.rateLimit;
  const f = rl?.fields ?? {};

  // unified-5h-*
  const u5h = fmtPct(f["unified-5h-utilization"]);
  const r5h = f["unified-5h-reset"];
  const s5h = f["unified-5h-status"];

  // unified-7d-*
  const u7d = fmtPct(f["unified-7d-utilization"]);
  const r7d = f["unified-7d-reset"];
  const s7d = f["unified-7d-status"];

  // Retry-After (active rate limit)
  const retryAfter = rl?.retryAfterSec;
  const retryAt = retryAfter
    ? Date.now() + retryAfter * 1000
    : null;

  // Whether we have ANY upstream-supplied data
  const hasUpstream = !!rl && (u5h || u7d || retryAfter);

  return (
    <div className="space-y-3 text-sm">
      {/* Retry banner — only if currently throttled */}
      {retryAt && retryAt > Date.now() && (
        <div className="badge-err px-3 py-2 block">
          ⏱ 当前处于限流冷却,预计还需{" "}
          <b>{fmtCountdown(retryAt)}</b> 才能恢复
          (上游 Retry-After {retryAfter}s)
        </div>
      )}

      {/* 5h window */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-ink-300 font-medium inline-flex items-center">
            5 小时滚动窗口
            <InfoTip text="Anthropic 订阅账号按滚动时间窗口限流。此处为最近 5 小时内的额度占用率,达到 100% 将触发限流(HTTP 429),须等窗口向前滚动、释放出额度后才能恢复。重置时间为当前窗口内最早一笔用量的到期时刻。" />
          </span>
          {s5h && <StatusBadge status={s5h} />}
        </div>
        {u5h ? (
          <>
            <div className="flex justify-between text-xs text-ink-400 mb-1">
              <span>已用 {u5h.label}</span>
              <span>
                重置:{" "}
                <span className="text-ink-300">
                  {fmtUnixToLocal(r5h)}
                </span>{" "}
                (剩 {fmtUnixCountdown(r5h)})
              </span>
            </div>
            <UtilizationBar pct={u5h.pct} />
          </>
        ) : (
          <FallbackWindow account={account} />
        )}
      </div>

      {/* 7d window */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-ink-300 font-medium inline-flex items-center">
            7 天滚动窗口
            <InfoTip text="最近 7 天滚动统计的额度占用率,用于约束周级总用量。与 5 小时窗口相互独立,任一窗口达到 100% 都会触发限流。重置时间为窗口内最早一笔用量的到期时刻。" />
          </span>
          {s7d && <StatusBadge status={s7d} />}
        </div>
        {u7d ? (
          <>
            <div className="flex justify-between text-xs text-ink-400 mb-1">
              <span>已用 {u7d.label}</span>
              <span>
                重置:{" "}
                <span className="text-ink-300">
                  {fmtUnixToLocal(r7d)}
                </span>{" "}
                (剩 {fmtUnixCountdown(r7d)})
              </span>
            </div>
            <UtilizationBar pct={u7d.pct} />
          </>
        ) : (
          <div className="text-xs text-ink-500">
            上游未返回 7 天用量信息(该 provider 可能不支持)
          </div>
        )}
      </div>

      {/* Footer: 数据来源 + 观察时间 */}
      <div className="text-xs text-ink-500 pt-2 border-t border-ink-800">
        {rl ? (
          <>
            数据来源:Anthropic{" "}
            <code className="text-ink-300">unified-*</code> 响应头 · 采集于{" "}
            {fmtIsoToLocal(rl.observedAt)}
          </>
        ) : !hasUpstream && account.windowStartedAt ? (
          <>
            上游未返回限流响应头,以下为本地推算(基于首次请求时间)。
          </>
        ) : (
          <>暂无数据 — 账号未发起过请求</>
        )}
      </div>
    </div>
  );
}

/** Fallback when no unified-* headers are present: show locally-tracked window. */
function FallbackWindow({ account }: { account: AccountSnapshot }) {
  if (!account.windowStartedAt || !account.windowResetAt) {
    return (
      <div className="text-xs text-ink-500">
        未发起过请求,窗口未开启
      </div>
    );
  }
  const resetMs = new Date(account.windowResetAt).getTime();
  return (
    <div className="text-xs text-ink-400">
      <span className="text-ink-500">本地推算 · </span>
      窗口开始:{fmtIsoToLocal(account.windowStartedAt)}
      <br />
      reset:{" "}
      <span className="text-ink-300">{fmtIsoToLocal(account.windowResetAt)}</span>{" "}
      ({fmtCountdown(resetMs)})
      {account.windowExpired && (
        <span className="ml-2 badge-muted">已过期 — 下次请求开新窗口</span>
      )}
    </div>
  );
}
