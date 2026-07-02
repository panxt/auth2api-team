import { get, post, patch, del } from "./client";

/* ── Shapes from /admin/usage/keys ─────────────────────────────────────── */

export interface KeyModelQuota {
  "monthly-tokens"?: number;
  "monthly-cost-usd"?: number;
  "daily-tokens"?: number;
  "daily-cost-usd"?: number;
}

export interface KeyQuota extends KeyModelQuota {
  "per-model"?: Record<string, KeyModelQuota>;
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
  /** Month-to-date MCP tool-call counts per upstream server id (call-count
   *  metering; no tokens). Empty/absent when the key made no MCP calls. */
  mcp?: Record<string, number>;
}

export interface UsageKeysResp {
  keys: UsageKey[];
  window: string;
  tracking: boolean;
  generated_at: string;
}

/* ── Shapes from /admin/keys (managed only) ───────────────────────────── */

export type KeyRole = "admin" | "auditor" | "member";

export interface ManagedKeyView {
  id: string;                    // hash prefix
  label: string | null;
  owner: string | null;
  enabled: boolean;
  admin: boolean;
  role: KeyRole;
  quota: KeyQuota | null;
  "rate-limit": KeyRateLimit | null;
  "allowed-models": string[] | null;
  "denied-models": string[] | null;
  "allowed-mcp": string[] | null;
  source: "managed" | "config";
}

export interface CreateKeyResponse {
  key: string;                   // RAW key — only returned once
  id: string;
  label: string | null;
  owner: string | null;
  enabled: boolean;
  admin: boolean;
  role: KeyRole;
  quota: KeyQuota | null;
  "rate-limit": KeyRateLimit | null;
  "allowed-models"?: string[] | null;
  "denied-models"?: string[] | null;
}

export interface CreateKeyInput {
  label?: string;
  owner?: string;
  admin?: boolean;
  role?: KeyRole;
  enabled?: boolean;
  // null explicitly clears a previously-set quota on PATCH.
  quota?: KeyQuota | null;
  "rate-limit"?: KeyRateLimit;
  "allowed-models"?: string[];
  "denied-models"?: string[];
  "allowed-mcp"?: string[];
}

export type PatchKeyInput = CreateKeyInput;

/** Self-service: rotate the CALLING key — reissue with a fresh secret. */
export const rotateSelfKey = () =>
  post<CreateKeyResponse>("/admin/keys/self/rotate");

/* ── /v1/models (for the model allowlist picker) ──────────────────────── */

export interface ModelInfo {
  id: string;
  object?: string;
}

export const listModels = () =>
  get<{ object: string; data: ModelInfo[] }>("/v1/models");

/* ── API methods ────────────────────────────────────────────────────────── */

export const listUsage = () => get<UsageKeysResp>("/admin/usage/keys");

export const listManaged = () =>
  get<{ keys: ManagedKeyView[]; generated_at: string }>("/admin/keys");

export const createKey = (input: CreateKeyInput) =>
  post<CreateKeyResponse>("/admin/keys", input);

export const updateKey = (id: string, input: PatchKeyInput) =>
  patch<ManagedKeyView>(`/admin/keys/${id}`, input);

export const deleteKey = (id: string) => del<null>(`/admin/keys/${id}`);

/** Admin: rotate ANY managed key — reissue with a fresh secret. */
export const rotateKey = (id: string) =>
  post<CreateKeyResponse>(`/admin/keys/${id}/rotate`);
