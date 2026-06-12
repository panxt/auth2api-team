import express from "express";
import path from "path";
import fs from "fs";
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
import { isModelAllowed } from "./usage/model-access";
import { resolveModel } from "./upstream/translator";
import {
  checkKeyRpm,
  acquireConcurrency,
  releaseConcurrency,
  cleanupRpm,
} from "./ratelimit/per-key";
import { ManagedKeyStore, ManagedKeyError } from "./keys/store";
import { startOAuth, exchangeOAuth } from "./admin/oauth";
import { ProviderId } from "./auth/types";

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

// Cleanup stale entries every 5 minutes — both the per-IP window map here and
// the per-key window map in ratelimit/per-key (otherwise stale entries for
// deleted/idle keys accumulate over a long-running process).
const cleanupTimer = setInterval(
  () => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
      if (now > entry.resetAt) rateLimitMap.delete(ip);
    }
    cleanupRpm(now);
  },
  5 * 60 * 1000,
);
cleanupTimer.unref();

/** Used/cap/remaining/percent for one quota dimension; nulls when no cap set. */
function pctRemaining(used: number, cap?: number) {
  if (cap == null) return { used, cap: null, remaining: null, percent: null };
  return {
    used,
    cap,
    remaining: Math.max(0, cap - used),
    percent: cap > 0 ? Math.min(1, used / cap) : null,
  };
}

export function createServer(
  config: Config,
  registry: ProviderRegistry,
  statsRecorder?: StatsRecorder,
  quotaTracker?: QuotaTracker,
  keyStore?: ManagedKeyStore,
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

  // Per-key model allowlist. Resolves the requested model the same way the
  // handlers do (body.model → alias resolution) and rejects with 403 when the
  // key restricts models and this one isn't on the list. No allowlist → pass.
  // Done in middleware so every inference route is covered uniformly.
  const requireModelAccess: express.RequestHandler = (req, res, next) => {
    const entry = res.locals.apiKey as ApiKeyEntry | undefined;
    const allow = entry?.["allowed-models"];
    if (!allow || allow.length === 0) return next();
    const requested = (req.body?.model as string | undefined) || "claude-sonnet-4-6";
    if (!isModelAllowed(entry, requested)) {
      res.status(403).json({
        error: {
          message: `Model '${resolveModel(requested)}' is not allowed for this API key`,
          type: "model_not_allowed",
        },
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

  // Key management is admin-only: creating/editing keys (incl. minting new
  // admin keys) is a privileged operation. Read-only stats keep the existing
  // any-valid-key behavior.
  const requireAdmin: express.RequestHandler = (_req, res, next) => {
    const entry = res.locals.apiKey as ApiKeyEntry | undefined;
    if (!entry?.admin) {
      res.status(403).json({ error: { message: "Admin API key required" } });
      return;
    }
    next();
  };

  // GET /admin/stats — three-axis aggregated call statistics.
  //   byClient — keyed by sha256(api-key); show short hex prefix to operator
  //   byAccount — keyed by `${provider}:${email}` (upstream OAuth account)
  //   byApi — keyed by `${endpoint}|${model}|${provider}`
  app.get("/admin/stats", (req, res) => {
    if (!statsRecorder) {
      res.json({ enabled: false });
      return;
    }
    // ?window=today|month|all — default "all" preserves the pre-2.x behavior
    // for any caller that doesn't pass the param.
    const w = req.query.window;
    const window =
      w === "today" || w === "month" || w === "all" ? w : "all";
    res.json({
      ...statsRecorder.getSnapshot(window),
      generated_at: new Date().toISOString(),
    });
  });

  // GET /admin/stats/timeseries?days=30 — daily aggregates for the dashboard.
  // Each bucket is one UTC day with totals + sub-totals by provider, for
  // stacked line / area charts.
  app.get("/admin/stats/timeseries", (req, res) => {
    if (!statsRecorder) {
      res.json({ enabled: false, days: [] });
      return;
    }
    const requested = Number(req.query.days);
    const days = Number.isFinite(requested) && requested > 0 ? Math.min(365, requested) : 30;
    res.json({
      days: statsRecorder.getTimeseries(days),
      window: { days },
      generated_at: new Date().toISOString(),
    });
  });

  // GET /admin/usage/keys — month-to-date consumption per API key vs its
  // quota. An admin key sees every key; a non-admin key sees only itself.
  // Raw keys are never returned — only the sha256 short prefix, plus the
  // operator-set label/owner. Consumption comes from the quota tracker (same
  // numbers that drive enforcement), so reports and limits never disagree.
  app.get("/admin/usage/keys", (_req, res) => {
    const requester = res.locals.apiKey as ApiKeyEntry | undefined;
    const isAdmin = !!requester?.admin;
    const keys = [];
    for (const entry of config["api-keys"].values()) {
      if (!isAdmin && entry.key !== requester?.key) continue;
      const consumed = quotaTracker
        ? quotaTracker.consumed(hashApiKey(entry.key))
        : null;
      const q = entry.quota;
      const usage =
        consumed && q
          ? {
              tokens: pctRemaining(consumed.tokens, q["monthly-tokens"]),
              cost: pctRemaining(consumed.costUsd, q["monthly-cost-usd"]),
            }
          : null;
      keys.push({
        apiKeyShort: hashApiKey(entry.key).slice(0, 12),
        label: entry.label ?? null,
        owner: entry.owner ?? null,
        admin: entry.admin,
        enabled: entry.enabled,
        quota: q ?? null,
        consumed,
        usage,
      });
    }
    res.json({
      keys,
      window: "month-to-date (UTC)",
      tracking: !!quotaTracker,
      generated_at: new Date().toISOString(),
    });
  });

  // ── Key management (admin-only) ──
  // Operates on managed-keys.json; config.yaml keys show up as read-only.
  if (keyStore) {
    const store = keyStore;

    const handleKeyError = (err: unknown, res: express.Response): void => {
      if (err instanceof ManagedKeyError) {
        const status =
          err.code === "not_found" ? 404 : err.code === "read_only" ? 409 : 400;
        res.status(status).json({ error: { message: err.message, type: err.code } });
        return;
      }
      console.error("[keys] unexpected error:", err);
      res.status(500).json({ error: { message: "Internal server error" } });
    };

    app.get("/admin/keys", requireAdmin, (_req, res) => {
      res.json({ keys: store.list(), generated_at: new Date().toISOString() });
    });

    // Returns the raw key ONCE so the operator can copy it; never again.
    app.post("/admin/keys", requireAdmin, (req, res) => {
      try {
        const entry = store.create(req.body || {});
        res.status(201).json({
          key: entry.key,
          id: hashApiKey(entry.key).slice(0, 12),
          label: entry.label ?? null,
          owner: entry.owner ?? null,
          enabled: entry.enabled,
          admin: entry.admin,
          quota: entry.quota ?? null,
          "rate-limit": entry["rate-limit"] ?? null,
        });
      } catch (err) {
        handleKeyError(err, res);
      }
    });

    app.patch("/admin/keys/:id", requireAdmin, (req, res) => {
      try {
        res.json(store.update(req.params.id, req.body || {}));
      } catch (err) {
        handleKeyError(err, res);
      }
    });

    app.delete("/admin/keys/:id", requireAdmin, (req, res) => {
      try {
        store.delete(req.params.id);
        res.status(204).end();
      } catch (err) {
        handleKeyError(err, res);
      }
    });
  }

  // DELETE /admin/accounts/:provider/:email — permanently remove an upstream
  // account (drops from memory + deletes the token file from auth-dir).
  // PATCH  /admin/accounts/:provider/:email — body { disabled: bool } toggles
  // the operator-disabled flag (skip in selection + refresh, but keep file).
  // Both admin-only.
  app.delete(
    "/admin/accounts/:provider/:email",
    requireAdmin,
    (req, res) => {
      const provider = registry.get(req.params.provider as ProviderId);
      if (!provider) {
        res.status(404).json({ error: { message: `unknown provider ${req.params.provider}` } });
        return;
      }
      const email = decodeURIComponent(req.params.email);
      const removed = provider.manager.removeAccount(email);
      if (!removed) {
        res.status(404).json({ error: { message: `no account ${email} loaded for ${provider.id}` } });
        return;
      }
      res.json({ ok: true, provider: provider.id, email });
    },
  );

  app.patch(
    "/admin/accounts/:provider/:email",
    requireAdmin,
    (req, res) => {
      const provider = registry.get(req.params.provider as ProviderId);
      if (!provider) {
        res.status(404).json({ error: { message: `unknown provider ${req.params.provider}` } });
        return;
      }
      const email = decodeURIComponent(req.params.email);
      const body = (req.body || {}) as { disabled?: unknown };
      if (typeof body.disabled !== "boolean") {
        res.status(400).json({ error: { message: "body must be { disabled: boolean }" } });
        return;
      }
      const next = provider.manager.setDisabled(email, body.disabled);
      if (next === null) {
        res.status(404).json({ error: { message: `no account ${email} loaded for ${provider.id}` } });
        return;
      }
      res.json({ ok: true, provider: provider.id, email, disabled: next });
    },
  );

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

  // POST /admin/prewarm — sends one cheap ping to every loaded upstream
  // account whose provider supports it (Anthropic only for now). Used to
  // (re)start the 5h rate-limit window so it aligns with working hours
  // instead of with whenever the first real user request lands.
  // Admin-only because it issues real upstream calls that count against
  // weekly caps.
  // POST /admin/oauth/:provider/start
  // POST /admin/oauth/:provider/exchange
  // Two-step manual-mode OAuth for the dashboard. See src/admin/oauth.ts
  // for full doc. Admin-only because completing the flow registers a new
  // upstream account against the proxy's auth-dir.
  app.post("/admin/oauth/:provider/start", requireAdmin, (req, res) => {
    try {
      const result = startOAuth(registry, req.params.provider as ProviderId);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: { message: err?.message || String(err) } });
    }
  });

  app.post("/admin/oauth/:provider/exchange", requireAdmin, async (req, res) => {
    try {
      const { state, callbackUrl } = (req.body || {}) as {
        state?: string;
        callbackUrl?: string;
      };
      const result = await exchangeOAuth(
        registry,
        state ?? "",
        callbackUrl ?? "",
      );
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: { message: err?.message || String(err) } });
    }
  });

  // GET /admin/ui/whoami — used by the dashboard SPA right after login to
  // verify the entered admin key, and to display the logged-in identity in
  // the sidebar. Returns the same shape as one row of /admin/usage/keys.
  app.get("/admin/ui/whoami", (_req, res) => {
    const entry = res.locals.apiKey as ApiKeyEntry | undefined;
    if (!entry) {
      res.status(401).json({ error: { message: "no api key in locals" } });
      return;
    }
    res.json({
      apiKeyShort: hashApiKey(entry.key).slice(0, 12),
      label: entry.label ?? null,
      owner: entry.owner ?? null,
      admin: entry.admin,
      enabled: entry.enabled,
    });
  });

  app.post("/admin/prewarm", requireAdmin, async (_req, res) => {
    const providers: unknown[] = [];
    for (const p of registry.all()) {
      if (!p.prewarm) continue;
      try {
        providers.push(await p.prewarm(config));
      } catch (err: any) {
        providers.push({
          provider: p.id,
          results: [],
          error: err?.message || String(err),
          generated_at: new Date().toISOString(),
        });
      }
    }
    res.json({
      providers,
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
    requireModelAccess,
    requireQuota,
    enforceKeyRateLimit,
    createChatCompletionsHandler(config, registry),
  );
  app.post(
    "/v1/responses",
    requireModelAccess,
    requireQuota,
    enforceKeyRateLimit,
    createResponsesHandler(config, registry),
  );

  // Routes — Anthropic native passthrough
  app.post(
    "/v1/messages",
    requireModelAccess,
    requireQuota,
    enforceKeyRateLimit,
    createMessagesHandler(config, registry),
  );
  app.post(
    "/v1/messages/count_tokens",
    requireModelAccess,
    requireQuota,
    enforceKeyRateLimit,
    createCountTokensHandler(config, registry),
  );

  // ── Admin dashboard SPA ─────────────────────────────────────────────
  // The /ui/ tree is the React build output. Bundle files (hashed assets)
  // are served as-is; any unknown /ui/* path falls back to index.html so
  // the SPA's BrowserRouter can handle deep links like /ui/users.
  // Loading the bundle is unauthenticated — the SPA itself prompts for an
  // admin key on first run and gates further /admin/* fetches via that.
  //
  // The compiled file lives at <repo>/web/dist (relative to <repo>/dist/server.js).
  const uiDir = path.resolve(__dirname, "..", "web", "dist");
  if (fs.existsSync(uiDir)) {
    app.use("/ui", express.static(uiDir, { index: "index.html" }));
    app.get(/^\/ui(?:\/.*)?$/, (_req, res) => {
      res.sendFile(path.join(uiDir, "index.html"));
    });
  } else {
    // Backend was built but `web/dist` is missing (no FE build run).
    // Surface a clear message instead of a 404.
    app.get(/^\/ui(?:\/.*)?$/, (_req, res) => {
      res
        .status(503)
        .type("text/plain")
        .send(
          "Admin dashboard is not built. Run `cd web && npm install && npm run build` " +
            "and restart the auth2api service.",
        );
    });
  }

  return app;
}
