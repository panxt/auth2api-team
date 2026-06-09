import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import {
  startOAuth,
  exchangeOAuth,
  SupportedProvider,
} from "../api/oauth";
import { ApiError } from "../api/client";

type Step = "choose" | "authorize" | "exchange" | "done";

export function AddAccountModal({
  open,
  onClose,
  onAdded,
  // Re-auth mode: locks provider, jumps straight to authorize step, and shows
  // a banner telling the operator "log in with the SAME email" so the manager's
  // addAccount() upsert path replaces the existing token instead of creating
  // a sibling account.
  reauthProvider,
  reauthEmail,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (email: string) => void;
  reauthProvider?: SupportedProvider;
  reauthEmail?: string;
}) {
  const [step, setStep] = useState<Step>("choose");
  const [provider, setProvider] = useState<SupportedProvider>(
    reauthProvider ?? "anthropic",
  );
  const [authUrl, setAuthUrl] = useState("");
  const [state, setState] = useState("");
  const [callbackPort, setCallbackPort] = useState(0);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [addedEmail, setAddedEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function reset() {
    setStep("choose");
    setProvider(reauthProvider ?? "anthropic");
    setAuthUrl("");
    setState("");
    setCallbackPort(0);
    setCallbackUrl("");
    setAddedEmail("");
    setErr(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  // In re-auth mode we skip the "choose provider" step entirely — provider is
  // locked, and clicking "重新认证" should land directly on the authorize page
  // with the OAuth URL already requested. Trigger when the modal opens.
  useEffect(() => {
    if (!open || !reauthProvider || step !== "choose" || busy || authUrl) return;
    let cancelled = false;
    setBusy(true);
    setErr(null);
    startOAuth(reauthProvider)
      .then((r) => {
        if (cancelled) return;
        setState(r.state);
        setAuthUrl(r.authUrl);
        setCallbackPort(r.callbackPort);
        setStep("authorize");
      })
      .catch((e) => {
        if (!cancelled) setErr((e as ApiError).message);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, reauthProvider, step, busy, authUrl]);

  async function onStart() {
    setBusy(true);
    setErr(null);
    try {
      const r = await startOAuth(provider);
      setState(r.state);
      setAuthUrl(r.authUrl);
      setCallbackPort(r.callbackPort);
      setStep("authorize");
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function onExchange() {
    if (!callbackUrl.trim()) {
      setErr("把浏览器地址栏的完整 URL 粘进来");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await exchangeOAuth(provider, state, callbackUrl.trim());
      setAddedEmail(r.email);
      setStep("done");
      onAdded(r.email);
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={reauthProvider ? `重新认证 ${reauthEmail ?? ""}` : "新增上游账号"}
      size="lg"
    >
      {step === "choose" && (
        <div className="space-y-4">
          <p className="text-sm text-ink-300">
            选择要登录的 provider。OAuth 授权页会在新标签打开,**用你想新增的账号登录**(确保浏览器是无痕窗口或者已经登出当前账号,避免错登)。
          </p>
          <div className="space-y-2">
            {(["anthropic", "codex"] as const).map((p) => (
              <label
                key={p}
                className="flex items-center gap-3 p-3 rounded-md border border-ink-700 hover:border-emerald-600 cursor-pointer transition-colors"
              >
                <input
                  type="radio"
                  name="provider"
                  value={p}
                  checked={provider === p}
                  onChange={() => setProvider(p)}
                />
                <div>
                  <div className="font-medium">
                    {p === "anthropic" ? "Anthropic (Claude)" : "OpenAI (Codex / ChatGPT)"}
                  </div>
                  <div className="text-xs text-ink-500 mt-0.5">
                    {p === "anthropic"
                      ? "Pro / Max 订阅,负责 claude-* 模型"
                      : "ChatGPT Plus / Pro,负责 gpt-5* / codex-* 模型"}
                  </div>
                </div>
              </label>
            ))}
            <div className="flex items-center gap-3 p-3 rounded-md border border-ink-800 opacity-50">
              <input type="radio" disabled />
              <div>
                <div className="font-medium">Cursor</div>
                <div className="text-xs text-ink-500 mt-0.5">
                  Cursor 走 deep-link PKCE,不能在 UI 完成 — 用 CLI:
                  <code className="text-ink-300">npm run login -- --provider=cursor</code>
                </div>
              </div>
            </div>
          </div>

          {err && <div className="badge-err block px-3 py-2">{err}</div>}

          <div className="flex justify-end gap-2 pt-2">
            <button className="btn-secondary" onClick={handleClose}>
              取消
            </button>
            <button
              className="btn-primary"
              onClick={onStart}
              disabled={busy}
            >
              {busy ? "请求中..." : "开始授权"}
            </button>
          </div>
        </div>
      )}

      {step === "authorize" && (
        <div className="space-y-4">
          {reauthProvider && reauthEmail && (
            <div className="badge-warn px-3 py-2 block text-sm">
              ⚠️ 请用 <code className="font-mono">{reauthEmail}</code> 这个账号登录,否则会被当作新增账号入池。
            </div>
          )}
          <ol className="space-y-3 text-sm text-ink-300 list-decimal list-inside">
            <li>
              点下方"打开"按钮(或复制 URL 在新标签贴入),用{reauthProvider ? "**相同**的" : "要新增的"}{" "}
              <b>{provider === "anthropic" ? "Claude" : "ChatGPT"}</b>{" "}
              账号完成授权。
            </li>
            <li>
              授权完成后,浏览器会跳转到{" "}
              <code className="text-ink-200">
                http://localhost:{callbackPort}/callback?code=...
              </code>
              。<b>这个页面会显示"加载失败"</b>,这是预期的(代理没在 localhost
              监听那个端口)。
            </li>
            <li>
              <b>从地址栏复制完整 URL</b>(从 <code>http://localhost</code> 开头到末尾)
              ,粘到下面文本框 → 点"完成"。
            </li>
          </ol>

          <div className="space-y-2">
            <label className="block text-xs text-ink-400">授权 URL</label>
            <div className="flex gap-2">
              <input
                readOnly
                className="input font-mono text-xs"
                value={authUrl}
              />
              <button
                className="btn-secondary text-xs whitespace-nowrap"
                onClick={() => navigator.clipboard.writeText(authUrl)}
              >
                复制
              </button>
              <a
                href={authUrl}
                target="_blank"
                rel="noreferrer"
                className="btn-primary text-xs whitespace-nowrap"
              >
                打开 ↗
              </a>
            </div>
          </div>

          <div>
            <label className="block text-xs text-ink-400 mb-1.5">
              从浏览器地址栏粘贴回调 URL
            </label>
            <textarea
              className="input font-mono text-xs"
              rows={3}
              placeholder={`http://localhost:${callbackPort}/callback?code=xxxx&state=xxxx`}
              value={callbackUrl}
              onChange={(e) => setCallbackUrl(e.target.value)}
            />
          </div>

          {err && <div className="badge-err block px-3 py-2">{err}</div>}

          <div className="flex justify-between gap-2 pt-2">
            <button
              className="btn-ghost text-xs"
              onClick={() => setStep("choose")}
            >
              ← 返回
            </button>
            <div className="flex gap-2">
              <button className="btn-secondary" onClick={handleClose}>
                取消
              </button>
              <button
                className="btn-primary"
                onClick={onExchange}
                disabled={busy || !callbackUrl.trim()}
              >
                {busy ? "交换中..." : "完成 →"}
              </button>
            </div>
          </div>
        </div>
      )}

      {step === "done" && (
        <div className="space-y-4 text-center">
          <div className="text-5xl">✓</div>
          <div className="text-lg font-medium">账号已添加</div>
          <div className="text-sm text-ink-400">
            <span className="text-ink-200 font-mono">{addedEmail}</span>{" "}
            已加入{" "}
            <span className="badge-ok">
              {provider}
            </span>{" "}
            的账号池。token 已落到 <code className="text-ink-300">~/.auth2api/</code>。
          </div>
          <div className="flex justify-center gap-2 pt-2">
            <button className="btn-secondary" onClick={() => {
              reset();
              setStep("choose");
            }}>
              再加一个
            </button>
            <button className="btn-primary" onClick={handleClose}>
              完成
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
