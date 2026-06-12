import {
  LoggingConfig,
  resolveLoggingConfig,
  DEFAULT_LOGGING_CONFIG,
} from "../config";
import type {
  RequestLogStore,
  RequestLogRecord,
  RequestLogFilter,
  RequestLogPage,
  SettingsStore,
} from "../storage/types";

const SETTINGS_KEY = "logging";

/** Fields the request-log write path needs from a finished request. */
export interface RequestLogInput {
  ts: string;
  apiKeyHash: string;
  ip: string;
  endpoint: string;
  model: string | null;
  provider: string | null;
  accountEmail: string | null;
  status: "success" | "failure";
  statusCode: number;
  failureKind: string | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  errorDetail?: string | null;
  requestId?: string | null;
}

/**
 * Strip token-like secrets from an error string before it's persisted:
 * proxy/upstream keys (sk-…), Bearer headers, and long JWT-ish blobs. Best
 * effort — the goal is to avoid accidentally logging a credential, not to be
 * a complete DLP filter.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .replace(/\beyJ[A-Za-z0-9._-]{20,}/g, "***jwt***"); // JWT (header starts eyJ)
}

/**
 * Owns the per-request log: the store, the live (UI-editable) LoggingConfig,
 * and the periodic retention sweep. Construction merges
 * defaults < config.yaml < persisted override; updateConfig() persists and
 * reschedules cleanup live.
 */
export class RequestLogger {
  private store: RequestLogStore;
  private settings: SettingsStore;
  private yamlSeed?: Partial<LoggingConfig>;
  private config: LoggingConfig;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    store: RequestLogStore,
    settings: SettingsStore,
    yamlSeed?: Partial<LoggingConfig>,
  ) {
    this.store = store;
    this.settings = settings;
    this.yamlSeed = yamlSeed;
    const persisted = settings.get<Partial<LoggingConfig>>(SETTINGS_KEY);
    this.config = resolveLoggingConfig(yamlSeed, persisted);
  }

  getConfig(): LoggingConfig {
    return JSON.parse(JSON.stringify(this.config));
  }

  /** Merge a partial update over the current config, persist, reschedule. */
  updateConfig(patch: Partial<LoggingConfig>): LoggingConfig {
    // Persist the merged (yaml+persisted+patch) result so a later yaml change
    // doesn't silently override an explicit UI choice.
    const persisted = this.settings.get<Partial<LoggingConfig>>(SETTINGS_KEY);
    const merged = resolveLoggingConfig(this.yamlSeed, persisted, patch);
    this.settings.set(SETTINGS_KEY, merged);
    this.config = merged;
    this.startCleanup(); // reschedule at the (possibly new) interval
    return this.getConfig();
  }

  /** Apply capture/detail/redact policy and write one record (best effort). */
  record(input: RequestLogInput): void {
    const cfg = this.config;
    if (!cfg.enabled) return;
    if (cfg.capture === "failures" && input.status !== "failure") return;

    let errorDetail: string | null = null;
    if (cfg["error-detail"] !== "off" && input.errorDetail) {
      let d = input.errorDetail;
      if (cfg.redact) d = redactSecrets(d);
      if (cfg["error-detail"] === "snippet") {
        const n = cfg["snippet-length"];
        if (d.length > n) d = d.slice(0, n) + "…";
      }
      errorDetail = d;
    }

    const rec: RequestLogRecord = {
      ts: input.ts,
      apiKeyHash: input.apiKeyHash,
      ip: input.ip,
      endpoint: input.endpoint,
      model: input.model,
      provider: input.provider,
      accountEmail: input.accountEmail,
      status: input.status,
      statusCode: input.statusCode,
      failureKind: input.failureKind,
      latencyMs: input.latencyMs,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      errorDetail,
      requestId: cfg["store-request-id"] ? (input.requestId ?? null) : null,
    };
    try {
      this.store.append(rec);
    } catch (err: any) {
      console.error("[reqlog] append failed:", err?.message);
    }
  }

  query(filter: RequestLogFilter): RequestLogPage {
    return this.store.query(filter);
  }

  /** (Re)start the retention sweep timer using the current interval. */
  startCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    const minutes =
      this.config.retention["cleanup-interval-minutes"] ||
      DEFAULT_LOGGING_CONFIG.retention["cleanup-interval-minutes"];
    const runSweep = () => {
      try {
        const removed = this.store.prune({
          maxAgeDays: this.config.retention["max-age-days"],
          maxRows: this.config.retention["max-rows"],
        });
        if (removed > 0) console.log(`[reqlog] pruned ${removed} record(s)`);
      } catch (err: any) {
        console.error("[reqlog] prune failed:", err?.message);
      }
    };
    const timer = setInterval(runSweep, Math.max(1, minutes) * 60 * 1000);
    timer.unref();
    this.cleanupTimer = timer;
    // Sweep once on (re)start so a tightened retention takes effect promptly.
    runSweep();
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
