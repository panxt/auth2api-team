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

/** Monthly budget for a single API key. Either limit (or both) may be set. */
export interface ApiKeyQuota {
  /** Reject once this many total tokens (input+output+cache) are used this calendar month. */
  "monthly-tokens"?: number;
  /** Reject once this much accrued cost (USD) is reached this calendar month. */
  "monthly-cost-usd"?: number;
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
      });
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
