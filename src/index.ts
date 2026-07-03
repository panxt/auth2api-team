import crypto from "crypto";
import readline from "readline";
import { Config, loadConfig, resolveAuthDir } from "./config";
import { ProviderId } from "./auth/types";
import { generatePKCECodes } from "./auth/pkce";
import { waitForCallback } from "./auth/callback-server";
import { importCursorTokenFromLocalStorage } from "./auth/cursor/storage";
import { runCursorBrowserLogin } from "./auth/cursor/browser-oauth";
import { buildRegistry, ProviderRegistry } from "./providers/registry";
import { createServer } from "./server";
import { notifyServerReload } from "./utils/notify-reload";
import { StatsRecorder } from "./stats/recorder";
import { QuotaTracker } from "./usage/quota";
import { computeCost } from "./usage/pricing";
import { ManagedKeyStore } from "./keys/store";
import { openStorage } from "./storage";
import { RequestLogger } from "./logging/logger";
import { RoutingController } from "./accounts/routing";
import { PrewarmScheduler } from "./accounts/prewarm";
import { McpController } from "./mcp/registry";
import { Notifier } from "./notify/notifier";
import { ExpirySweep } from "./keys/expiry-sweep";
import type { PrewarmResult } from "./providers/types";

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function parseProviderArg(args: string[]): ProviderId {
  const flag = args.find((a) => a.startsWith("--provider="));
  if (!flag) return "anthropic";
  const value = flag.split("=", 2)[1];
  if (value === "anthropic" || value === "codex" || value === "cursor")
    return value;
  throw new Error(
    `Unknown provider "${value}". Supported: anthropic, codex, cursor`,
  );
}

async function importCursorLogin(
  config: Config,
  registry: ProviderRegistry,
  storagePath?: string,
): Promise<void> {
  const provider = registry.get("cursor");
  const tokenData = importCursorTokenFromLocalStorage(storagePath);
  provider.manager.addAccount(tokenData);
  console.log("\nCursor local login imported.");
  console.log(`Account: ${tokenData.email}`);
  console.log(`Token expires: ${tokenData.expiresAt}`);
  console.log(
    "Note: Cursor provider support is experimental and uses non-public APIs.",
  );
  await notifyServerReload(config);
}

async function browserCursorLogin(
  config: Config,
  registry: ProviderRegistry,
): Promise<void> {
  const provider = registry.get("cursor");
  console.log("\nLogging in to cursor (browser flow).");
  const result = await runCursorBrowserLogin({
    pollTimeoutMs: 15 * 60 * 1000,
    onLoginUrl: (url) => {
      console.log("\nOpen this URL in your browser to authorize Cursor:\n");
      console.log(url);
      console.log(
        '\nAfter signing in, click "Yes, Log In" — auth2api will pick up the token automatically.\n',
      );
    },
  });
  provider.manager.addAccount(result.token);
  console.log("Cursor browser login complete.");
  console.log(`Account: ${result.token.email}`);
  console.log(`Token expires: ${result.token.expiresAt}`);
  console.log(
    "Note: Cursor provider support is experimental and uses non-public APIs.",
  );
  await notifyServerReload(config);
}

async function doLogin(
  config: Config,
  registry: ProviderRegistry,
  providerId: ProviderId,
  manual: boolean,
): Promise<void> {
  const provider = registry.get(providerId);

  const pkce = generatePKCECodes();
  const state = crypto.randomBytes(16).toString("hex");

  const authURL = provider.buildAuthUrl(state, pkce);
  console.log(`\nLogging in to ${provider.id}.`);
  console.log("Open this URL in your browser to login:\n");
  console.log(authURL);

  let code: string;
  let returnedState: string;

  if (manual) {
    console.log(
      "\nAfter login, your browser will redirect to a localhost URL that may fail to load.",
    );
    console.log(
      "Copy the FULL URL from your browser address bar and paste it here.\n",
    );
    const callbackURL = await prompt("Paste callback URL: ");

    const url = new URL(callbackURL);
    code = url.searchParams.get("code") || "";
    returnedState = url.searchParams.get("state") || "";

    if (!code) {
      console.error("Error: No authorization code found in URL");
      process.exit(1);
    }
    if (returnedState !== state) {
      console.error("Error: State mismatch — possible CSRF attack");
      process.exit(1);
    }
  } else {
    console.log("\nWaiting for OAuth callback...\n");
    const result = await waitForCallback({
      port: provider.oauth.callbackPort,
      callbackPath: provider.oauth.callbackPath,
    });
    code = result.code;
    returnedState = result.state;
  }

  console.log("Exchanging code for tokens...");
  const tokenData = await provider.exchangeCode(
    code,
    returnedState,
    state,
    pkce,
  );
  if (!tokenData.provider) tokenData.provider = provider.id;
  provider.manager.addAccount(tokenData);
  console.log(`\nLogin successful! Account: ${tokenData.email}`);
  console.log(`Token expires: ${tokenData.expiresAt}`);
  await notifyServerReload(config);
}

async function startServer(): Promise<void> {
  const configPath = process.argv
    .find((a) => a.startsWith("--config="))
    ?.split("=")[1];
  const config = loadConfig(configPath);
  const authDir = resolveAuthDir(config["auth-dir"]);

  // Open the configured storage backend (sqlite by default, or file). It
  // provides the usage event log and the managed-key repository.
  const storage = await openStorage(config, authDir);

  // Merge UI-managed keys into the live api-keys map before anything reads it
  // (quota detection, auth), so managed keys behave exactly like config keys.
  const keyStore = new ManagedKeyStore(storage.keyRepo, config["api-keys"]);
  keyStore.load();

  const registry = buildRegistry(authDir);
  for (const p of registry.all()) p.manager.load();

  const totalAccounts = registry
    .all()
    .reduce((sum, p) => sum + p.manager.accountCount, 0);
  if (totalAccounts === 0) {
    console.log(
      "No accounts found. Run with --login (and optionally --provider=codex) to add an account first.",
    );
    process.exit(1);
  }

  for (const p of registry.all()) {
    if (p.manager.accountCount > 0) {
      p.manager.startAutoRefresh();
      p.manager.startStatsLogger();
    }
  }

  const anyQuota = Array.from(config["api-keys"].values()).some(
    (e) => e.quota,
  );

  // The stats JSONL is also the quota tracker's durability: QuotaTracker
  // replays it on restart to recover month-to-date consumption. So the
  // recorder must run whenever stats are enabled OR any key has a quota —
  // otherwise quota would silently reset to zero on every restart and be
  // bypassable by restarting the process.
  let statsRecorder: StatsRecorder | undefined;
  if (config.stats.enabled || anyQuota) {
    if (!config.stats.enabled) {
      console.log(
        "[quota] stats.jsonl logging enabled because a key has a quota (required for quota persistence across restarts)",
      );
    }
    // Inject per-event cost so byClient/byAccount/byApi all carry accurate
    // cost (each event priced by its own model), retroactive on replay.
    statsRecorder = new StatsRecorder((ev) =>
      ev.model && ev.usage
        ? computeCost(ev.model, ev.usage, ev.provider ?? undefined, config.pricing)
        : 0,
    );
    statsRecorder.start(storage.eventLog);
  }

  // Run quota accounting when any key has a quota, or whenever stats are on
  // (so /admin/usage/keys can show month-to-date consumption either way). It
  // replays stats.jsonl for the current month and is fed live by the finish
  // middleware.
  let quotaTracker: QuotaTracker | undefined;
  if (anyQuota || config.stats.enabled) {
    quotaTracker = new QuotaTracker(config.pricing);
    quotaTracker.start(storage.eventLog);
  }

  // Per-request diagnostic log. Independent store + retention so pruning it
  // never affects quota replay. Config merges defaults < yaml < persisted.
  const requestLogger = new RequestLogger(
    storage.requestLog,
    storage.settings,
    config.logging,
  );
  requestLogger.startCleanup();

  // Account-selection / load-balancing policy. Resolves defaults < yaml <
  // persisted, and pushes it into every provider's manager (hot-swappable).
  const routingController = new RoutingController(
    storage.settings,
    (cfg) => {
      for (const p of registry.all()) p.manager.setRouting(cfg);
    },
    config.routing,
  );

  // Daily window-prewarm scheduler. Pings each prewarm-capable provider's pool
  // at the configured local times to anchor the 5h rate-limit window to
  // working hours. Replaces the external launchd cron; UI-configurable.
  let prewarmScheduler: PrewarmScheduler | undefined;
  const runPrewarm = async (): Promise<PrewarmResult[]> => {
    const filter = prewarmScheduler?.getConfig().providers ?? [];
    const out: PrewarmResult[] = [];
    for (const p of registry.all()) {
      if (!p.prewarm) continue;
      if (filter.length > 0 && !filter.includes(p.id)) continue;
      try {
        out.push(await p.prewarm(config));
      } catch (err: any) {
        out.push({
          provider: p.id,
          results: [],
          generated_at: new Date().toISOString(),
        });
        console.error(`[prewarm] ${p.id} failed:`, err?.message || err);
      }
    }
    return out;
  };
  prewarmScheduler = new PrewarmScheduler(
    storage.settings,
    runPrewarm,
    config.prewarm,
    storage.prewarmLog,
  );
  prewarmScheduler.start();

  // MCP aggregation gateway registry. Page-managed (SettingsStore); connects
  // enabled upstreams in the background.
  const mcpController = new McpController(storage.settings);
  mcpController.start();

  // Outbound notifier (飞书). Default-disabled; opt-in via UI. External egress.
  const notifier = new Notifier(storage.settings, config.notify);

  // Key-expiry sweep: disables expired managed keys + fires advance/expired
  // alerts. Hourly; also runs once at startup.
  const expirySweep = new ExpirySweep(keyStore, notifier);
  expirySweep.start();

  const app = createServer(
    config,
    registry,
    statsRecorder,
    quotaTracker,
    keyStore,
    requestLogger,
    routingController,
    prewarmScheduler,
    mcpController,
    notifier,
  );
  const host = config.host || "127.0.0.1";
  const port = config.port;

  app.listen(port, host, () => {
    console.log(`auth2api running on http://${host}:${port}`);
    console.log(`Endpoints:`);
    console.log(`  POST /v1/chat/completions`);
    console.log(`  POST /v1/responses`);
    console.log(`  POST /v1/messages`);
    console.log(`  POST /v1/messages/count_tokens`);
    console.log(`  GET  /v1/models`);
    console.log(`  GET  /admin/accounts`);
    if (statsRecorder) console.log(`  GET  /admin/stats`);
    console.log(`  GET  /admin/logs`);
    console.log(`  GET  /health`);
  });

  process.on("SIGINT", () => {
    for (const p of registry.all()) {
      p.manager.stopAutoRefresh();
      p.manager.stopStatsLogger();
    }
    // Flush/close the storage backend (file stream or sqlite db) before exit,
    // but never let a hung close keep SIGINT from being responsive.
    Promise.resolve(statsRecorder?.stop())
      .then(() => storage.close())
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => a.startsWith("--config="))?.split("=")[1];
  const config = loadConfig(configPath);
  const authDir = resolveAuthDir(config["auth-dir"]);

  if (args.includes("--login")) {
    const manual = args.includes("--manual");
    const providerId = parseProviderArg(args);
    const cursorStorage = args
      .find((a) => a.startsWith("--cursor-storage="))
      ?.split("=", 2)[1];
    const registry = buildRegistry(authDir);
    for (const p of registry.all()) p.manager.load();
    if (providerId === "cursor") {
      if (cursorStorage || args.includes("--cursor-import-local")) {
        await importCursorLogin(config, registry, cursorStorage);
      } else {
        await browserCursorLogin(config, registry);
      }
    } else {
      await doLogin(config, registry, providerId, manual);
    }
  } else {
    await startServer();
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
