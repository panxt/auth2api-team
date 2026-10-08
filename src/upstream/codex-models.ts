import { AccountManager } from "../accounts/manager";
import { Config } from "../config";
import { buildCodexBaseHeaders, DEFAULT_CODEX_CLI_VERSION } from "./codex-api";

const BASE_URL = "https://chatgpt.com/backend-api";
const MODELS_PATH = "/codex/models";
const CACHE_TTL_MS = 5 * 60 * 1000; // matches codex-rs/models-manager DEFAULT_MODEL_CACHE_TTL

// Static fallback used when no account is loaded or the upstream /codex/models
// call fails. User-confirmed list of models currently accepted by the
// ChatGPT-account codex backend; kept private since the upstream proxy is the
// authoritative source — this list only papers over startup and outages.
// ChatGPT-account Codex currently advertises more slugs than /codex/responses
// will accept for this account type. Only expose models we have verified work,
// otherwise Claude Code's /model command can switch to a listed-but-rejected
// slug and fail on the validation request.
const SUPPORTED_CHATGPT_CODEX_MODELS = new Set(["gpt-5.5"]);

const FALLBACK_MODELS = ["gpt-5.5"];

function filterSupportedModels(models: UpstreamModel[]): UpstreamModel[] {
  return models.filter((m) => SUPPORTED_CHATGPT_CODEX_MODELS.has(m.slug));
}

function toModelList(
  models: UpstreamModel[],
): Array<{ id: string; owned_by: string }> {
  return filterSupportedModels(models).map((m) => ({
    id: m.slug,
    owned_by: "openai",
  }));
}

interface UpstreamModel {
  slug: string;
  display_name?: string;
  visibility?: string;
}

interface ModelsResponse {
  models: UpstreamModel[];
}

interface CacheEntry {
  fetchedAt: number;
  etag: string | null;
  models: UpstreamModel[];
}

let cache: CacheEntry | null = null;

function defaultCodexConfig(): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": "",
    "api-keys": new Map(),
    "body-limit": "200mb",
    cloaking: {},
    timeouts: {
      "messages-ms": 120000,
      "stream-messages-ms": 600000,
      "count-tokens-ms": 30000,
      "stream-keepalive-ms": 15000,
    },
    stats: { enabled: true },
    storage: { backend: "sqlite" },
    debug: "off",
  };
}

async function fetchUpstream(
  manager: AccountManager,
  config: Config,
): Promise<{ models: UpstreamModel[]; etag: string | null } | null> {
  const result = manager.getNextAccount();
  if (!result.account) return null;
  const account = result.account;

  const clientVersion =
    config.cloaking.codex?.["cli-version"] || DEFAULT_CODEX_CLI_VERSION;
  const url = `${BASE_URL}${MODELS_PATH}?client_version=${encodeURIComponent(clientVersion)}`;
  const headers = buildCodexBaseHeaders(account, false, config);
  headers.Accept = "application/json";
  if (cache?.etag) {
    headers["If-None-Match"] = cache.etag;
  }

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: any) {
    const cause = err?.cause;
    const detail = cause
      ? `${cause.code || cause.name || "error"}: ${cause.message || String(cause)}`
      : err?.message || String(err);
    console.error(`[codex] /codex/models fetch failed: ${detail}`);
    return null;
  }

  // 304 Not Modified — cache is still valid.
  if (resp.status === 304 && cache) {
    return { models: cache.models, etag: cache.etag };
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error(
      `[codex] /codex/models returned ${resp.status}: ${text.slice(0, 200)}`,
    );
    return null;
  }

  let parsed: ModelsResponse;
  try {
    parsed = (await resp.json()) as ModelsResponse;
  } catch (err: any) {
    console.error(`[codex] /codex/models JSON parse failed: ${err.message}`);
    return null;
  }
  if (!Array.isArray(parsed.models)) {
    console.error("[codex] /codex/models response missing 'models' array");
    return null;
  }
  const etag = resp.headers.get("etag");
  return { models: parsed.models, etag };
}

export async function listCodexModels(
  manager: AccountManager,
  config: Config = defaultCodexConfig(),
): Promise<Array<{ id: string; owned_by: string }>> {
  // Cache hit within TTL — return immediately.
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return toModelList(cache.models);
  }

  const fresh = await fetchUpstream(manager, config);
  if (fresh) {
    cache = {
      fetchedAt: Date.now(),
      etag: fresh.etag,
      models: fresh.models,
    };
    return toModelList(fresh.models);
  }

  // Stale-while-error: prefer slightly-stale cache over fallback if we have one.
  if (cache) {
    return toModelList(cache.models);
  }

  return FALLBACK_MODELS.map((id) => ({ id, owned_by: "openai" }));
}

/** @internal — test hook to reset the module-level cache between cases. */
export function __resetCodexModelsCache(): void {
  cache = null;
}
