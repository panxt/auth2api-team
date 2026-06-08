import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

export function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [key, setKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!key.trim()) return;
    setSubmitting(true);
    setError(null);
    const result = await login(key.trim());
    setSubmitting(false);
    if (result.ok) {
      nav("/users", { replace: true });
    } else {
      setError(result.error);
    }
  }

  return (
    <div className="min-h-screen bg-ink-950 text-ink-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md card">
        <div className="text-center mb-6">
          <div className="text-2xl font-semibold tracking-tight">auth2api</div>
          <div className="text-sm text-ink-400 mt-1">Admin Dashboard</div>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-ink-400 mb-1.5">
              Admin API Key
            </label>
            <input
              type="password"
              autoFocus
              className="input"
              placeholder="sk-..."
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <div className="text-xs text-ink-500 mt-1.5">
              一个 <code className="text-ink-300">admin: true</code> 的 API key。
              在 <code className="text-ink-300">config.yaml</code> 里找标了 admin 的。
            </div>
          </div>

          {error && (
            <div className="badge-err block px-3 py-2 rounded-md">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn-primary w-full"
            disabled={submitting || !key.trim()}
          >
            {submitting ? "验证中..." : "登录"}
          </button>
        </form>
      </div>
    </div>
  );
}
