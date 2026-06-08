import { get, post, patch, del } from "./client";

/* ── Shapes from /admin/usage/keys ─────────────────────────────────────── */

export interface KeyQuota {
  "monthly-tokens"?: number;
  "monthly-cost-usd"?: number;
}

export interface KeyRateLimit {
  rpm?: number;
  concurrency?: number;
}

/** A key view from /admin/usage/keys (covers BOTH config and managed). */
export interface UsageKey {
  apiKeyShort: string;          // sha256 prefix
  label: string | null;
  owner: string | null;
  admin: boolean;
  enabled: boolean;
  quota: KeyQuota | null;
  consumed: {
    requests?: number;
    tokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    costUsd?: number;
  } | null;
  usage: {
    tokens?: { used: number; limit: number; pct: number };
    cost?: { used: number; limit: number; pct: number };
  } | null;
}

export interface UsageKeysResp {
  keys: UsageKey[];
  window: string;
  tracking: boolean;
  generated_at: string;
}

/* ── Shapes from /admin/keys (managed only) ───────────────────────────── */

export interface ManagedKeyView {
  id: string;                    // hash prefix
  label: string | null;
  owner: string | null;
  enabled: boolean;
  admin: boolean;
  quota: KeyQuota | null;
  "rate-limit": KeyRateLimit | null;
  source: "managed" | "config";
}

export interface CreateKeyResponse {
  key: string;                   // RAW key — only returned once
  id: string;
  label: string | null;
  owner: string | null;
  enabled: boolean;
  admin: boolean;
  quota: KeyQuota | null;
  "rate-limit": KeyRateLimit | null;
}

export interface CreateKeyInput {
  label?: string;
  owner?: string;
  admin?: boolean;
  enabled?: boolean;
  quota?: KeyQuota;
  "rate-limit"?: KeyRateLimit;
}

export type PatchKeyInput = CreateKeyInput;

/* ── API methods ────────────────────────────────────────────────────────── */

export const listUsage = () => get<UsageKeysResp>("/admin/usage/keys");

export const listManaged = () =>
  get<{ keys: ManagedKeyView[]; generated_at: string }>("/admin/keys");

export const createKey = (input: CreateKeyInput) =>
  post<CreateKeyResponse>("/admin/keys", input);

export const updateKey = (id: string, input: PatchKeyInput) =>
  patch<ManagedKeyView>(`/admin/keys/${id}`, input);

export const deleteKey = (id: string) => del<null>(`/admin/keys/${id}`);
