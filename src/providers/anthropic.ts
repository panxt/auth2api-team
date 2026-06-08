import type { Request } from "express";
import { PKCECodes, TokenData } from "../auth/types";
import {
  generateAuthURL,
  exchangeCodeForTokens,
  refreshTokensWithRetry,
} from "../auth/oauth";
import { AccountManager, extractUsage } from "../accounts/manager";
import {
  callAnthropicMessages,
  callAnthropicCountTokens,
} from "../upstream/anthropic-api";
import { applyCloaking } from "../upstream/cloaking";
import { Config } from "../config";
import {
  Provider,
  UpstreamCallContext,
  CloakingContext,
  ProviderOAuthInfo,
  PrewarmRecord,
  PrewarmResult,
} from "./types";

/**
 * The cheapest Anthropic request that still triggers / refreshes the 5h
 * rate-limit window. Haiku is the lowest-cost model; max_tokens=1 caps the
 * billable output to a single token. We don't care about the response
 * content — only that the upstream accepted the call.
 */
const PREWARM_BODY = {
  model: "claude-haiku-4-5",
  max_tokens: 1,
  messages: [{ role: "user", content: "ping" }],
  stream: false,
};

/**
 * Build a minimal fake Express Request for out-of-band upstream calls
 * (e.g. prewarm). `callAnthropicMessages` only touches `request.headers`
 * for client-passthrough header forwarding and apiKeyHash bookkeeping;
 * empty headers are fine.
 */
function buildPrewarmRequest(): Request {
  return { headers: {} } as unknown as Request;
}

async function prewarmOne(
  manager: AccountManager,
  email: string,
  config: Config,
): Promise<PrewarmRecord> {
  const account = manager.getAvailableAccount(email);
  if (!account) {
    return { email, ok: false, error: "account not found or in cooldown" };
  }
  // Mirror the bookkeeping path of a normal upstream call so /admin/accounts
  // shows the prewarm in totalRequests too, not just in totalSuccesses.
  manager.recordAttempt(email);
  const start = Date.now();
  try {
    const upstream = await callAnthropicMessages({
      body: PREWARM_BODY,
      request: buildPrewarmRequest(),
      account,
      config,
      signal: AbortSignal.timeout(15_000),
    });
    const latencyMs = Date.now() - start;

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return {
        email,
        ok: false,
        error: `HTTP ${upstream.status}${text ? `: ${text.slice(0, 180)}` : ""}`,
        latencyMs,
      };
    }
    const json = await upstream.json().catch(() => ({}) as any);
    const usage = extractUsage(json);
    // Record on the manager so /admin/accounts reflects the ping and the
    // sliding-counter state stays consistent with reality.
    manager.recordSuccess(email, usage);
    return {
      email,
      ok: true,
      latencyMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
  } catch (err: any) {
    return {
      email,
      ok: false,
      error: err?.message || String(err),
      latencyMs: Date.now() - start,
    };
  }
}

const ANTHROPIC_OAUTH: ProviderOAuthInfo = {
  callbackPort: 54545,
  callbackPath: "/callback",
};

const MODEL_RE = /^claude-/i;

const ADVERTISED_MODELS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-haiku-4-5",
  "opus",
  "sonnet",
  "haiku",
];

export function buildAnthropicProvider(authDir: string): Provider {
  const manager = new AccountManager(authDir, {
    provider: "anthropic",
    refresh: async (rt: string): Promise<TokenData> => {
      const token = await refreshTokensWithRetry(rt);
      return { ...token, provider: "anthropic" };
    },
  });

  return {
    id: "anthropic",
    nativeFormat: "anthropic-messages",
    manager,
    oauth: ANTHROPIC_OAUTH,
    matchesModel: (model: string) => MODEL_RE.test(model),
    buildAuthUrl: (state: string, pkce: PKCECodes) =>
      generateAuthURL(state, pkce),
    exchangeCode: async (code, returnedState, expectedState, pkce) => {
      const token = await exchangeCodeForTokens(
        code,
        returnedState,
        expectedState,
        pkce,
      );
      return { ...token, provider: "anthropic" };
    },
    listModels: async () =>
      ADVERTISED_MODELS.map((id) => ({ id, owned_by: "anthropic" })),
    callMessages: (opts: UpstreamCallContext) => callAnthropicMessages(opts),
    callCountTokens: (opts: UpstreamCallContext) =>
      callAnthropicCountTokens({
        request: opts.request,
        account: opts.account,
        config: opts.config,
        signal: opts.signal,
      }),
    applyCloaking: (opts: CloakingContext) => applyCloaking(opts),
    prewarm: async (config: Config): Promise<PrewarmResult> => {
      const emails = manager.listEmails();
      // Parallel — each prewarm hits a different upstream account, no
      // serialization needed (and we want the 5h windows for all accounts
      // to start at ~the same wall-clock moment).
      const results = await Promise.all(
        emails.map((email) => prewarmOne(manager, email, config)),
      );
      return {
        provider: "anthropic",
        results,
        generated_at: new Date().toISOString(),
      };
    },
  };
}
