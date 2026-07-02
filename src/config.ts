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
/**
 * Access role for an API key:
 *   - "admin":   full control (mutations + config + see everyone).
 *   - "auditor": org-wide READ-only (all usage/logs/accounts), no mutations.
 *   - "member":  self-only (own usage, rotate own key). Default.
 * `admin: true` is kept in sync for back-compat (admin ⟺ role === "admin").
 */
export type KeyRole = "admin" | "auditor" | "member";

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
  /** Access role. Optional for back-compat; falls back to admin?"admin":"member". */
  role?: KeyRole;
  quota?: ApiKeyQuota;
  "rate-limit"?: ApiKeyRateLimit;
  /**
   * Optional model allowlist. When set (non-empty), this key may only call
   * models in the list (compared after alias resolution via resolveModel);
   * any other model is rejected with 403. Empty/omitted = all models allowed.
   * Values may be aliases ("opus") or canonical ids ("claude-opus-4-8").
   */
  "allowed-models"?: string[];
  /**
   * Optional model denylist (blacklist). Models here are always rejected with
   * 403, even if the allowlist would permit them — deny takes precedence.
   * Use this for "allow everything except X". Same alias-insensitive matching.
   */
  "denied-models"?: string[];
  /**
   * MCP 类目授权(聚合网关)。**默认拒绝**:未设 / 空数组 = 看不到任何上游 MCP。
   * 值为已注册的 MCP server id。与 allowed-models「空=全允许」相反(MCP 工具多为
   * 写操作,默认拒绝更安全)。
   */
  "allowed-mcp"?: string[];
}

/** Raw object form of an api-key entry as parsed from YAML (before defaults). */
interface RawApiKeyEntry {
  key: string;
  label?: string;
  owner?: string;
  enabled?: boolean;
  admin?: boolean;
  role?: KeyRole;
  quota?: ApiKeyQuota;
  "rate-limit"?: ApiKeyRateLimit;
  "allowed-models"?: string[];
  "denied-models"?: string[];
  "allowed-mcp"?: string[];
}

/** Effective role of a key, with back-compat: an explicit role wins, else
 *  derive from the legacy admin flag. */
export function effectiveRole(entry: {
  role?: KeyRole;
  admin?: boolean;
}): KeyRole {
  if (entry.role) return entry.role;
  return entry.admin ? "admin" : "member";
}

/** Whether a key can read org-wide data (everyone's usage/logs/keys). */
export function canReadAll(entry: { role?: KeyRole; admin?: boolean }): boolean {
  const r = effectiveRole(entry);
  return r === "admin" || r === "auditor";
}

export type DebugMode = "off" | "errors" | "verbose";

/**
 * Per-request logging (for failure diagnosis). Stored separately from the
 * stats/quota event log so its retention can be pruned freely without
 * breaking month-to-date quota replay. Admin-editable at runtime via
 * /admin/logging/config (persisted to the SettingsStore); the config.yaml
 * `logging:` block, if present, only seeds the initial defaults.
 */
export interface LoggingConfig {
  /** Master switch. When false, nothing is written to the request log. */
  enabled: boolean;
  /** Which requests to log: every request, or only failures. */
  capture: "all" | "failures";
  /** How much of the upstream error to store. */
  "error-detail": "full" | "snippet" | "off";
  /** Max chars kept when error-detail is "snippet". */
  "snippet-length": number;
  /** Strip token-like secrets (sk-…, Bearer …, JWTs) from errorDetail. */
  redact: boolean;
  /** Persist the upstream request_id (handy for support tickets). */
  "store-request-id": boolean;
  /**
   * Which error categories to record. Lets you keep real problems
   * (upstream/service) and drop benign noise (policy rejections, client
   * disconnects). Applied on top of `capture`.
   */
  categories: {
    /** 模型/上游报错 */
    upstream: boolean;
    /** 本服务报错 */
    service: boolean;
    /** 策略拒绝(配额/白名单/限流)— 默认不记 */
    policy: boolean;
    /** 客户端断开/坏请求 — 默认不记 */
    client: boolean;
  };
  retention: {
    /** Delete records older than this many days (0 = no age limit). */
    "max-age-days": number;
    /** Hard cap on stored rows; oldest beyond this are deleted (0 = no cap). */
    "max-rows": number;
    /** How often the cleanup sweep runs. */
    "cleanup-interval-minutes": number;
  };
}

export const DEFAULT_LOGGING_CONFIG: LoggingConfig = {
  enabled: true,
  capture: "failures",
  "error-detail": "snippet",
  "snippet-length": 500,
  redact: true,
  "store-request-id": true,
  categories: {
    upstream: true, // 模型/上游报错 — 记
    service: true, // 本服务报错 — 记
    policy: false, // 策略拒绝 — 默认不记(非真错)
    client: false, // 客户端断开/坏请求 — 默认不记(非真错)
  },
  retention: {
    "max-age-days": 14,
    "max-rows": 200000,
    "cleanup-interval-minutes": 60,
  },
};

/**
 * Merge logging config sources in precedence order:
 *   built-in defaults  <  config.yaml `logging:`  <  persisted (UI) override.
 * Deep-merges the nested `retention` object so a partial override (e.g. just
 * max-age-days) keeps the other retention defaults.
 */
export function resolveLoggingConfig(
  ...layers: (Partial<LoggingConfig> | undefined | null)[]
): LoggingConfig {
  const out: LoggingConfig = {
    ...DEFAULT_LOGGING_CONFIG,
    categories: { ...DEFAULT_LOGGING_CONFIG.categories },
    retention: { ...DEFAULT_LOGGING_CONFIG.retention },
  };
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) continue;
      if ((k === "retention" || k === "categories") && v && typeof v === "object") {
        (out as any)[k] = { ...(out as any)[k], ...(v as object) };
      } else {
        (out as any)[k] = v;
      }
    }
  }
  return out;
}

/**
 * Account-selection / load-balancing policy. Controls how concurrent client
 * traffic is spread across the upstream account pool. Admin-editable at
 * runtime via /admin/routing/config (persisted to the SettingsStore); the
 * config.yaml `routing:` block, if present, only seeds the initial defaults.
 */
export interface RoutingConfig {
  /**
   * - "adaptive"(默认):偏好账号在飞数低于阈值时保持粘住(缓存友好),否则
   *   按 `inFlight/weight`(可选叠加 5h 利用率)选最小,实现并发分摊。
   * - "weighted-least-inflight":始终按 `inFlight/weight` 选最小,无粘性。
   * - "sticky":旧行为 —— 一个全局粘性账号直到冷却/到期。
   */
  strategy: "adaptive" | "weighted-least-inflight" | "sticky";
  /** adaptive:偏好(上次/亲和)账号在飞数 < 此值时保持粘住。 */
  "stick-while-inflight-below": number;
  /** 每账号在飞软上限;0 = 不限。满载账号在选择时被跳过,全满则 429。 */
  "per-account-max-inflight": number;
  /** 把上游 5h 窗口利用率(unified-5h-utilization)纳入打分。 */
  "use-5h-utilization": boolean;
}

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  strategy: "adaptive",
  "stick-while-inflight-below": 4,
  "per-account-max-inflight": 0,
  "use-5h-utilization": true,
};

/** Merge routing config: 默认 < config.yaml < 持久化(UI)覆盖。 */
export function resolveRoutingConfig(
  ...layers: (Partial<RoutingConfig> | undefined | null)[]
): RoutingConfig {
  const out: RoutingConfig = { ...DEFAULT_ROUTING_CONFIG };
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v !== undefined) (out as any)[k] = v;
    }
  }
  return out;
}

/**
 * Window-prewarm policy. Anthropic's 5h rate-limit window is "first-message
 * anchored", so sending one cheap ping at a fixed local time each day anchors
 * the window to working hours instead of to whenever the first real request
 * lands. Admin-editable at runtime via /admin/prewarm/config (persisted to the
 * SettingsStore); the config.yaml `prewarm:` block, if present, only seeds the
 * initial defaults. Replaces the external launchd cron with an in-process,
 * UI-configurable scheduler.
 */
export interface PrewarmConfig {
  /** Master switch for the in-process scheduler. */
  enabled: boolean;
  /** Local-time trigger points, "HH:MM" (24h). Each fires once per day. */
  times: string[];
  /** Provider ids to prewarm; empty = every provider that supports it. */
  providers: string[];
}

export const DEFAULT_PREWARM_CONFIG: PrewarmConfig = {
  enabled: true,
  times: ["08:00"],
  providers: [],
};

/** Validate & canonicalize "HH:MM" entries; drops blanks/dupes, sorts. */
export function normalizePrewarmTimes(times: unknown): string[] {
  if (!Array.isArray(times)) return [...DEFAULT_PREWARM_CONFIG.times];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of times) {
    if (typeof t !== "string") continue;
    const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
    if (!m) continue;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) continue;
    const norm = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    if (!seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  out.sort();
  return out;
}

/** Merge prewarm config: 默认 < config.yaml < 持久化(UI)覆盖。 */
export function resolvePrewarmConfig(
  ...layers: (Partial<PrewarmConfig> | undefined | null)[]
): PrewarmConfig {
  const out: PrewarmConfig = {
    ...DEFAULT_PREWARM_CONFIG,
    times: [...DEFAULT_PREWARM_CONFIG.times],
    providers: [...DEFAULT_PREWARM_CONFIG.providers],
  };
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v !== undefined) (out as any)[k] = v;
    }
  }
  out.times = normalizePrewarmTimes(out.times);
  if (!Array.isArray(out.providers)) out.providers = [];
  return out;
}

export interface Config {
  host: string;
  port: number;
  /**
   * Public-facing base URL members should use (e.g. the prod address
   * "http://172.16.13.203:8318" or an https reverse-proxy), used verbatim in
   * generated access docs. Optional — falls back to the dashboard's own origin
   * when unset. Lets an admin viewing the UI on localhost still hand out docs
   * that point at the real deployment.
   */
  "public-base-url"?: string;
  /**
   * https reverse-proxy address for the Claude desktop **Cowork** client (which
   * rejects plain http). Used in the access doc's "方式二" cert section. Optional
   * — when unset the doc shows a placeholder and tells the member to ask an
   * admin. e.g. "https://172.16.13.203:8443".
   */
  "cowork-base-url"?: string;
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
  /** Optional seed for the per-request logging config (UI overrides win). */
  logging?: Partial<LoggingConfig>;
  /** Optional seed for the account-selection / load-balancing policy. */
  routing?: Partial<RoutingConfig>;
  /** Optional seed for the daily window-prewarm scheduler. */
  prewarm?: Partial<PrewarmConfig>;
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
      const role = item.role;
      map.set(item.key, {
        key: item.key,
        label: item.label,
        owner: item.owner,
        enabled: item.enabled ?? true,
        // role wins; keep admin in sync for back-compat.
        admin: role ? role === "admin" : (item.admin ?? false),
        role,
        quota: item.quota,
        "rate-limit": item["rate-limit"],
        "allowed-models": item["allowed-models"],
        "denied-models": item["denied-models"],
        "allowed-mcp": item["allowed-mcp"],
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
