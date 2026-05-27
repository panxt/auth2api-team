import express from "express";
import { Config, isDebugLevel, ApiKeyEntry } from "./config";
import { ProviderRegistry } from "./providers/registry";
import { extractApiKey, hashApiKey } from "./utils/common";
import {
  createChatCompletionsHandler,
  createResponsesHandler,
} from "./handlers/openai";
import {
  createMessagesHandler,
  createCountTokensHandler,
} from "./handlers/anthropic";
import { StatsRecorder } from "./stats/recorder";
import { QuotaTracker, secondsUntilMonthResetUTC } from "./usage/quota";
import {
  checkKeyRpm,
  acquireConcurrency,
  releaseConcurrency,
} from "./ratelimit/per-key";

// Simple in-memory rate limiter per IP
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// Cleanup stale entries every 5 minutes
const cleanupTimer = setInterval(
  () => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
      if (now > entry.resetAt) rateLimitMap.delete(ip);
    }
  },
  5 * 60 * 1000,
);
cleanupTimer.unref();

export function createServer(
  config: Config,
  registry: ProviderRegistry,
  statsRecorder?: StatsRecorder,
  quotaTracker?: QuotaTracker,
): express.Application {
  const app = express();
  // Stats slots are seeded whenever either subsystem needs them: the recorder
  // for reporting, the quota tracker for live consumption feed.
  const wantStatsSlot = !!statsRecorder || !!quotaTracker;

  app.use(express.json({ limit: config["body-limit"] }));

  if (isDebugLevel(config.debug, "verbose")) {
    app.use((req, res, next) => {
      const startedAt = Date.now();
      console.error(`[debug] ${req.method} ${req.originalUrl} started`);
      res.on("finish", () => {
        console.error(
          `[debug] ${req.method} ${req.originalUrl} -> ${res.statusCode} in ${Date.now() - startedAt}ms`,
        );
      });
      next();
    });
  }

  // CORS - restrict to localhost origins only
  const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  app.use((_req, res, next) => {
    const origin = _req.headers.origin;
    if (origin && LOCALHOST_RE.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, x-api-key",
    );
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Rate limiting middleware
  app.use("/v1", (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (!rateLimit(ip)) {
      res.status(429).json({ error: { message: "Too many requests" } });
      return;
    }
    next();
  });

  // API key auth middleware — accepts both OpenAI style (Authorization: Bearer)
  // and Anthropic style (x-api-key), so Claude Code and OpenAI clients both work
  const requireApiKey: express.RequestHandler = (req, res, next) => {
    const key = extractApiKey(req.headers);
    if (!key) {
      res.status(401).json({ error: { message: "Missing API key" } });
      return;
    }
    const entry = config["api-keys"].get(key);
    if (!entry || !entry.enabled) {
      res.status(403).json({ error: { message: "Invalid or disabled API key" } });
      return;
    }
    // Make the key's identity/policy available to downstream middleware
    // (quota, per-key rate limit) and handlers.
    res.locals.apiKey = entry;
    // Seed res.locals.stats so the stats-finish middleware can record this
    // request even if the downstream handler aborts before filling in the
    // upstream account / model / usage fields.
    if (wantStatsSlot) {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const ua = (req.headers["user-agent"] as string) || "";
      res.locals.stats = {
        apiKeyHash: hashApiKey(key),
        ip,
        ua,
        endpoint: `${req.method} ${req.baseUrl}${req.path}`,
        startedAt: Date.now(),
        model: null,
        provider: null,
        accountEmail: null,
        usage: null,
        failureKind: null,
      };
    }
    next();
  };

  // Record one stats event per request that made it past auth. `finish`
  // covers normal responses; `close` covers client disconnects before the
  // response completed. A guard prevents the normal finish->close sequence
  // from double-counting.
  const statsFinishMiddleware: express.RequestHandler = (req, res, next) => {
    if (!wantStatsSlot) return next();
    let recorded = false;
    const recordStats = (override?: {
      status: "success" | "failure";
      statusCode: number;
      failureKind: string | null;
    }) => {
      if (recorded) return;
      recorded = true;
      const ctx = res.locals.stats as
        | {
            apiKeyHash: string;
            ip: string;
            ua: string;
            endpoint: string;
            startedAt: number;
            model: string | null;
            provider: string | null;
            accountEmail: string | null;
            usage: any;
            failureKind: string | null;
          }
        | undefined;
      if (!ctx) return;
      const status: "success" | "failure" =
        override?.status ??
        (res.statusCode >= 200 && res.statusCode < 300 ? "success" : "failure");
      const input = {
        apiKeyHash: ctx.apiKeyHash,
        ip: ctx.ip,
        ua: ctx.ua,
        endpoint: ctx.endpoint,
        model: ctx.model,
        provider: ctx.provider as any,
        accountEmail: ctx.accountEmail,
        status,
        failureKind: override?.failureKind ?? ctx.failureKind,
        statusCode: override?.statusCode ?? res.statusCode,
        latencyMs: Date.now() - ctx.startedAt,
        usage: ctx.usage,
      };
      // Record to the persistent stats log (if enabled) and feed the same
      // event to the quota tracker (if enabled) so both stay in lockstep.
      const event = statsRecorder
        ? statsRecorder.record(input)
        : { v: 1 as const, ts: new Date().toISOString(), ...input };
      quotaTracker?.record(event);
    };
    res.on("finish", () => recordStats());
    res.on("close", () => {
      if (!res.writableEnded) {
        recordStats({
          status: "failure",
          statusCode: 499,
          failureKind: "client_disconnect",
        });
      }
    });
    next();
  };

  // Reject requests once the key's month-to-date consumption reaches its quota.
  // No quota configured, or no tracker, → pass through. 429 + Retry-After
  // (until the UTC month boundary) signals a temporary, time-bounded block.
  const requireQuota: express.RequestHandler = (req, res, next) => {
    const entry = res.locals.apiKey as ApiKeyEntry | undefined;
    if (!entry?.quota || !quotaTracker) return next();
    const consumed = quotaTracker.consumed(hashApiKey(entry.key));
    const q = entry.quota;
    const tokenCap = q["monthly-tokens"];
    const costCap = q["monthly-cost-usd"];
    if (tokenCap != null && consumed.tokens >= tokenCap) {
      res.setHeader("Retry-After", String(secondsUntilMonthResetUTC()));
      res
        .status(429)
        .json({
          error: { message: "Monthly token quota exceeded", type: "quota_exceeded" },
        });
      return;
    }
    if (costCap != null && consumed.costUsd >= costCap) {
      res.setHeader("Retry-After", String(secondsUntilMonthResetUTC()));
      res
        .status(429)
        .json({
          error: { message: "Monthly cost budget exceeded", type: "quota_exceeded" },
        });
      return;
    }
    next();
  };

  // Per-key RPM + concurrency, on top of the global per-IP limiter. Concurrency
  // slots are released on both finish and close (streaming clients disconnect
  // via close, not finish) with a once-guard so a slot is freed exactly once.
  const enforceKeyRateLimit: express.RequestHandler = (req, res, next) => {
    const entry = res.locals.apiKey as ApiKeyEntry | undefined;
    const rl = entry?.["rate-limit"];
    if (!rl) return next();
    const keyId = hashApiKey(entry!.key);
    if (rl.rpm != null && !checkKeyRpm(keyId, rl.rpm)) {
      res.setHeader("Retry-After", "60");
      res
        .status(429)
        .json({
          error: { message: "Per-key request rate limit exceeded", type: "rate_limit" },
        });
      return;
    }
    if (rl.concurrency != null) {
      if (!acquireConcurrency(keyId, rl.concurrency)) {
        res
          .status(429)
          .json({
            error: { message: "Per-key concurrency limit exceeded", type: "rate_limit" },
          });
        return;
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releaseConcurrency(keyId);
      };
      res.on("finish", release);
      res.on("close", release);
    }
    next();
  };

  // Health check (no account count to avoid info leak)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/admin", requireApiKey);
  app.use("/admin", statsFinishMiddleware);

  // GET /admin/stats — three-axis aggregated call statistics.
  //   byClient — keyed by sha256(api-key); show short hex prefix to operator
  //   byAccount — keyed by `${provider}:${email}` (upstream OAuth account)
  //   byApi — keyed by `${endpoint}|${model}|${provider}`
  app.get("/admin/stats", (_req, res) => {
    if (!statsRecorder) {
      res.json({ enabled: false });
      return;
    }
    res.json({
      ...statsRecorder.getSnapshot(),
      generated_at: new Date().toISOString(),
    });
  });

  app.get("/admin/accounts", (_req, res) => {
    const providers: Record<
      string,
      { accounts: unknown[]; account_count: number }
    > = {};
    for (const p of registry.all()) {
      providers[p.id] = {
        accounts: p.manager.getSnapshots(),
        account_count: p.manager.accountCount,
      };
    }
    res.json({
      providers,
      generated_at: new Date().toISOString(),
    });
  });

  // POST /admin/reload — re-reads token files from auth-dir and reconciles
  // each provider's in-memory state. Called automatically by `--login` after
  // a successful re-auth (see notifyServerReload in src/index.ts), and
  // available for manual use via curl. See AccountManager.reload() for
  // upsert semantics.
  app.post("/admin/reload", async (_req, res) => {
    const reloaded: Record<string, unknown> = {};
    for (const p of registry.all()) {
      try {
        reloaded[p.id] = await p.manager.reload();
      } catch (err: any) {
        reloaded[p.id] = { error: err?.message || String(err) };
      }
    }
    res.json({
      reloaded,
      generated_at: new Date().toISOString(),
    });
  });

  app.use("/v1", requireApiKey);
  app.use("/v1", statsFinishMiddleware);
  app.get("/v1/models", async (_req, res) => {
    const created = Math.floor(Date.now() / 1000);
    const providers = registry.withAccounts();
    const lists = await Promise.all(providers.map((p) => p.listModels()));
    const data = lists.flatMap((models) =>
      models.map((m) => ({
        id: m.id,
        object: "model",
        created,
        owned_by: m.owned_by,
      })),
    );
    res.json({ object: "list", data });
  });

  // Inference routes carry quota + per-key rate limiting; /v1/models above
  // stays cheap and unmetered.
  // Routes — OpenAI compatible
  app.post(
    "/v1/chat/completions",
    requireQuota,
    enforceKeyRateLimit,
    createChatCompletionsHandler(config, registry),
  );
  app.post(
    "/v1/responses",
    requireQuota,
    enforceKeyRateLimit,
    createResponsesHandler(config, registry),
  );

  // Routes — Anthropic native passthrough
  app.post(
    "/v1/messages",
    requireQuota,
    enforceKeyRateLimit,
    createMessagesHandler(config, registry),
  );
  app.post(
    "/v1/messages/count_tokens",
    requireQuota,
    enforceKeyRateLimit,
    createCountTokensHandler(config, registry),
  );

  return app;
}
