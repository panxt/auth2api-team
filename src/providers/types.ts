import { Request } from "express";
import { ProviderId, PKCECodes, TokenData } from "../auth/types";
import { AccountManager, AvailableAccount } from "../accounts/manager";
import { Config } from "../config";

export type { ProviderId };

export type NativeFormat = "anthropic-messages" | "openai-responses";

export interface UpstreamCallContext {
  body?: any;
  request: Request;
  account: AvailableAccount;
  config: Config;
  structured?: boolean;
  signal?: AbortSignal;
}

export interface CloakingContext {
  body?: any;
  request: Request;
  account: AvailableAccount;
  config: Config;
}

/**
 * One row in the prewarm report — one upstream account.
 * `ok=true` means the ping reached the upstream and produced a normal
 * response, which implies the 5h rate-limit window has been triggered
 * (or refreshed) for this account.
 */
export interface PrewarmRecord {
  email: string;
  ok: boolean;
  /** Non-empty when ok=false. */
  error?: string;
  /** Round-trip latency to upstream, ms. */
  latencyMs?: number;
  /** Upstream-reported token usage of the prewarm ping itself. */
  inputTokens?: number;
  outputTokens?: number;
}

export interface PrewarmResult {
  provider: ProviderId;
  results: PrewarmRecord[];
  generated_at: string;
}

export interface ProviderOAuthInfo {
  callbackPort: number;
  callbackPath: string;
}

export interface Provider {
  id: ProviderId;
  /** Body format the provider's outbound API expects. */
  nativeFormat: NativeFormat;
  /** True if this provider should serve `model`. */
  matchesModel(model: string): boolean;
  /** Account pool for this provider. */
  manager: AccountManager;
  oauth: ProviderOAuthInfo;
  buildAuthUrl(state: string, pkce: PKCECodes): string;
  exchangeCode(
    code: string,
    returnedState: string,
    expectedState: string,
    pkce: PKCECodes,
  ): Promise<TokenData>;
  /** Models advertised on /v1/models when this provider has accounts. */
  listModels(): Promise<Array<{ id: string; owned_by: string }>>;
  /** Anthropic-Messages → upstream call. */
  callMessages(opts: UpstreamCallContext): Promise<Response>;
  /** Optional — undefined for codex (no count_tokens analog). */
  callCountTokens?(opts: UpstreamCallContext): Promise<Response>;
  /**
   * Optional pre-flight body mutation. Anthropic uses it to inject Claude
   * Code CLI cloaking. Codex deliberately has no cloaking.
   */
  applyCloaking?(opts: CloakingContext): any;
  /**
   * Optional: send a minimal best-effort request to each account in the pool
   * to (re)start their 5h rate-limit window. Only meaningful for providers
   * with a "first-message triggered" tumbling window (Anthropic). Codex /
   * Cursor providers should not implement this — their rate-limit semantics
   * are different.
   */
  prewarm?(config: Config): Promise<PrewarmResult>;
}
