import crypto from "crypto";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import type { ModelPrice } from "./usage/pricing";

/**
 * Cloaking configuration for request fingerprinting.
 * Controls how auth2api mimics Claude Code CLI's request signature.
 */
export interface CloakingConfig {
  /** CLI version to impersonate in User-Agent and fingerprint (default: 2.1.88) */
  "cli-version"?: string;
  /** Entrypoint value for billing header (default: cli) */
  entrypoint?: string;
  /**
   * Codex (ChatGPT) provider — protocol-required headers, NOT identity faking.
   * Strings live here so upstream flag-name drift can ship as a YAML edit.
   */
  codex?: {
    "user-agent"?: string;
    originator?: string;
    "cli-version"?: string;
    /** Optional: only set if upstream begins requiring an OpenAI-Beta header. */
    "openai-beta"?: string;
  };
  /**
   * Cursor provider — reverse-engineered, unstable headers for personal local
   * experiments only. Cursor version-gates requests, so keep these overrideable.
   */
  cursor?: {
    "client-version"?: string;
    "client-type"?: string;
    "agent-base-url"?: string;
    "api-base-url"?: string;
    "config-version"?: string;
    timezone?: string;
    "ghost-mode"?: string;
  };
}

export interface TimeoutConfig {
  "messages-ms": number;
  "stream-messages-ms": number;
  "count-tokens-ms": number;
}

export interface StatsConfig {
  /** Default true. Set false to disable per-request stats recording entirely. */
  enabled: boolean;
}

/**
 * Where usage events and UI-managed keys are persisted. "sqlite" (default)
 * keeps everything in a single DB file via better-sqlite3; "file" keeps the
 * legacy stats.jsonl + managed-keys.json. OAuth tokens are always plain files
 * regardless (they're the upstream login contract).
 */
export interface StorageConfig {
  backend: "sqlite" | "file";
  /** SQLite DB path; defaults to <auth-dir>/auth2api.db when omitted. */
  "sqlite-path"?: string;
}

/** Token + cost caps on one window. Any subset of fields may be set. */
export interface ApiKeyModelQuota {
  /** Reject once this many total tokens (input+output+cache) are used this UTC month. */
  "monthly-tokens"?: number;
  /** Reject once this much accrued cost (USD) is reached this UTC month. */
  "monthly-cost-usd"?: number;
  /** Reject once this many total tokens are used today (UTC). */
  "daily-tokens"?: number;
  /** Reject once this much accrued cost (USD) is reached today (UTC). */
  "daily-cost-usd"?: number;
}

/**
 * Usage budget for a single API key. The top-level fields cap the key's TOTAL
 * usage; `per-model` caps usage of a specific model (keyed by alias or
 * canonical id — resolved before comparison). Any subset may be set; a request
 * is rejected (429) the moment any applicable cap is reached.
 */
export interface ApiKeyQuota extends ApiKeyModelQuota {
  /** Per-model caps, keyed by model id/alias (e.g. "claude-opus-4-8" / "opus"). */
  "per-model"?: Record<string, ApiKeyModelQuota>;
}

/** Per-key rate limiting, layered on top of the global per-IP limiter. */
export interface ApiKeyRateLimit {
  /** Max requests per minute for this key. */
  rpm?: number;
  /** Max concurrent in-flight requests for this key. */
  concurrency?: number;
}

/**
 * An API key with identity and policy. The bare-string YAML form (a plain
 * key with no metadata) normalizes to `{ key, enabled: true, admin: false }`,
 * so old configs keep working unchanged.
 */
export interface ApiKeyEntry {
  key: string;
  /** Human label, e.g. "zhangsan / dev". Shown in admin reports. */
  label?: string;
  /** Owner identifier (email). */
  owner?: string;
  /** Disabled keys are rejected with 403. Default true. */
  enabled: boolean;
  /** Admin keys see all clients in usage reports; non-admin see only themselves. Default false. */
  admin: boolean;
  quota?: ApiKeyQuota;
  "rate-limit"?: ApiKeyRateLimit;
  /**
   * Optional model allowlist. When set (non-empty), this key may only call
   * models in the list (compared after alias resolution via resolveModel);
   * any other model is rejected with 403. Empty/omitted = all models allowed.
   * Values may be aliases ("opus") or canonical ids ("claude-opus-4-8").
   */
  "allowed-models"?: string[];
}

/** Raw object form of an api-key entry as parsed from YAML (before defaults). */
interface RawApiKeyEntry {
  key: string;
  label?: string;
  owner?: string;
  enabled?: boolean;
  admin?: boolean;
  quota?: ApiKeyQuota;
  "rate-limit"?: ApiKeyRateLimit;
  "allowed-models"?: string[];
}

export type DebugMode = "off" | "errors" | "verbose";

export interface Config {
  host: string;
  port: number;
  "auth-dir": string;
  "api-keys": Map<string, ApiKeyEntry>;
  "body-limit": string;
  cloaking: CloakingConfig;
  timeouts: TimeoutConfig;
  stats: StatsConfig;
  storage: StorageConfig;
  /**
   * Per-model price overrides (USD per 1M tokens), keyed by resolved model id.
   * Merged over DEFAULT_PRICING at cost time. Optional — omit to use defaults.
   */
  pricing?: Record<string, ModelPrice>;
  debug: DebugMode;
}

// Raw config shape from YAML: api-keys is an array of bare strings and/or
// objects; the rest matches Config.
interface RawConfig extends Omit<Config, "api-keys"> {
  "api-keys": (string | RawApiKeyEntry)[];
}

/**
 * Normalize the YAML `api-keys` array (mixed bare strings and objects) into a
 * `key -> ApiKeyEntry` map. Bare strings become enabled, non-admin entries
 * with no quota or rate limit. Malformed entries (object without a string
 * `key`) are skipped.
 */
export function normalizeApiKeys(
  raw: (string | RawApiKeyEntry)[],
): Map<string, ApiKeyEntry> {
  const map = new Map<string, ApiKeyEntry>();
  for (const item of raw || []) {
    if (typeof item === "string") {
      map.set(item, { key: item, enabled: true, admin: false });
    } else if (item && typeof item.key === "string") {
      map.set(item.key, {
        key: item.key,
        label: item.label,
        owner: item.owner,
        enabled: item.enabled ?? true,
        admin: item.admin ?? false,
        quota: item.quota,
        "rate-limit": item["rate-limit"],
        "allowed-models": item["allowed-models"],
      });
    } else {
      // Don't silently lose a misconfigured entry — a dropped key would just
      // fail auth later with a confusing 403.
      console.warn(
        `[config] ignoring malformed api-keys entry (missing string "key"): ${JSON.stringify(item)}`,
      );
    }
  }
  return map;
}

const DEFAULT_RAW: RawConfig = {
  host: "",
  port: 8317,
  "auth-dir": "~/.auth2api",
  "api-keys": [],
  "body-limit": "200mb",
  cloaking: {
    "cli-version": "2.1.88",
    entrypoint: "cli",
  },
  timeouts: {
    "messages-ms": 120000,
    "stream-messages-ms": 600000,
    "count-tokens-ms": 30000,
  },
  stats: {
    enabled: true,
  },
  storage: {
    backend: "sqlite",
  },
  debug: "off",
};

function normalizeDebugMode(value: unknown): DebugMode {
  if (value === true) return "errors";
  if (value === false || value == null) return "off";
  if (value === "off" || value === "errors" || value === "verbose")
    return value;
  return "off";
}

export function isDebugLevel(
  debug: DebugMode,
  level: Exclude<DebugMode, "off">,
): boolean {
  if (debug === "verbose") return true;
  return debug === level;
}

export function resolveAuthDir(dir: string): string {
  if (dir.startsWith("~")) {
    return path.join(process.env.HOME || "/root", dir.slice(1));
  }
  return path.resolve(dir);
}

export function generateApiKey(): string {
  return "sk-" + crypto.randomBytes(32).toString("hex");
}

export function loadConfig(configPath?: string): Config {
  const filePath = configPath || "config.yaml";
  let raw: RawConfig;

  if (!fs.existsSync(filePath)) {
    console.log(`Config file not found at ${filePath}, using defaults`);
    raw = { ...DEFAULT_RAW };
  } else {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = yaml.load(content) as Partial<RawConfig>;
    raw = {
      ...DEFAULT_RAW,
      ...parsed,
      cloaking: { ...DEFAULT_RAW.cloaking, ...(parsed.cloaking || {}) },
      timeouts: { ...DEFAULT_RAW.timeouts, ...(parsed.timeouts || {}) },
      stats: { ...DEFAULT_RAW.stats, ...(parsed.stats || {}) },
      storage: { ...DEFAULT_RAW.storage, ...(parsed.storage || {}) },
    };
  }

  raw.debug = normalizeDebugMode(raw.debug);

  // Auto-generate API key if none configured
  if (!raw["api-keys"] || raw["api-keys"].length === 0) {
    const key = generateApiKey();
    raw["api-keys"] = [key];
    fs.writeFileSync(filePath, yaml.dump(raw, { lineWidth: -1 }), {
      mode: 0o600,
    });
    console.log(`\nGenerated API key (saved to ${filePath}):\n\n  ${key}\n`);
  }

  return { ...raw, "api-keys": normalizeApiKeys(raw["api-keys"]) };
}
