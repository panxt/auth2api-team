import { post } from "./client";

export interface StartResult {
  state: string;
  authUrl: string;
  callbackPort: number;
  ttlMs: number;
}

export interface ExchangeResult {
  provider: "anthropic" | "codex";
  email: string;
  expiresAt: string;
}

export type SupportedProvider = "anthropic" | "codex";

export const startOAuth = (provider: SupportedProvider) =>
  post<StartResult>(`/admin/oauth/${provider}/start`);

export const exchangeOAuth = (
  provider: SupportedProvider,
  state: string,
  callbackUrl: string,
) =>
  post<ExchangeResult>(`/admin/oauth/${provider}/exchange`, {
    state,
    callbackUrl,
  });
