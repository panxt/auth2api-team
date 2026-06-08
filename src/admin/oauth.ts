/**
 * UI-driven OAuth manual flow.
 *
 * Mirrors the CLI's `--login --manual` mode (src/index.ts:104-124) but
 * splits it into two HTTP calls so an admin can complete it from the
 * dashboard:
 *
 *   1. POST /admin/oauth/:provider/start
 *      → backend generates PKCE + state, remembers them in `pending`,
 *        returns the authUrl for the user to open in a new tab.
 *
 *   2. (user authenticates upstream; browser redirects to a
 *       localhost:54545 / 1455 callback that fails to load — expected.
 *       User copies the full URL from the address bar.)
 *
 *   3. POST /admin/oauth/:provider/exchange  { state, callbackUrl }
 *      → backend extracts the `code`, calls exchangeCode + addAccount,
 *        persists the token file, returns { email, expiresAt }.
 *
 * Out of scope: Cursor (deep-link PKCE; uses cursor.com/loginDeepControl
 * + a long-poll on api2.cursor.sh/auth/poll, not a redirect, so the
 * "paste callback URL" pattern doesn't apply). For Cursor use the CLI.
 */

import crypto from "crypto";
import { generatePKCECodes } from "../auth/pkce";
import { PKCECodes, ProviderId } from "../auth/types";
import { ProviderRegistry } from "../providers/registry";

const TTL_MS = 10 * 60 * 1000;          // states expire after 10 minutes
const CLEAN_INTERVAL_MS = 60 * 1000;    // sweep every minute

const SUPPORTED: ProviderId[] = ["anthropic", "codex"];

interface PendingEntry {
  providerId: ProviderId;
  pkce: PKCECodes;
  state: string;
  createdAt: number;
}

const pending = new Map<string, PendingEntry>();

// Periodic sweep — keeps the in-memory map bounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) {
    if (now - v.createdAt > TTL_MS) pending.delete(k);
  }
}, CLEAN_INTERVAL_MS).unref?.();

export interface StartResult {
  state: string;
  authUrl: string;
  /** Returned for the UI's "you'll see this URL load-fail in the new tab,
   *  copy from there" instruction. Anthropic = 54545, Codex = 1455. */
  callbackPort: number;
  /** TTL hint for the UI (ms). */
  ttlMs: number;
}

export function startOAuth(
  registry: ProviderRegistry,
  providerId: ProviderId,
): StartResult {
  if (!SUPPORTED.includes(providerId)) {
    throw new Error(
      `OAuth UI flow not supported for "${providerId}". Use the CLI: ` +
        `npm run login -- --provider=${providerId}`,
    );
  }
  const provider = registry.get(providerId);
  const pkce = generatePKCECodes();
  const state = crypto.randomBytes(16).toString("hex");
  pending.set(state, {
    providerId,
    pkce,
    state,
    createdAt: Date.now(),
  });
  return {
    state,
    authUrl: provider.buildAuthUrl(state, pkce),
    callbackPort: provider.oauth.callbackPort,
    ttlMs: TTL_MS,
  };
}

export interface ExchangeResult {
  provider: ProviderId;
  email: string;
  expiresAt: string;
}

export async function exchangeOAuth(
  registry: ProviderRegistry,
  state: string,
  callbackUrl: string,
): Promise<ExchangeResult> {
  if (!state || typeof state !== "string") {
    throw new Error("`state` is required");
  }
  if (!callbackUrl || typeof callbackUrl !== "string") {
    throw new Error("`callbackUrl` is required");
  }

  const entry = pending.get(state);
  if (!entry) {
    throw new Error(
      "state expired or unknown — restart the flow (you have 10 min to paste back)",
    );
  }
  // One-shot: consume immediately so a slow second submit can't double-exchange.
  pending.delete(state);

  let url: URL;
  try {
    url = new URL(callbackUrl.trim());
  } catch {
    throw new Error("invalid callback URL — paste the FULL address from the browser");
  }
  const code = url.searchParams.get("code") || "";
  const returnedState = url.searchParams.get("state") || "";
  if (!code) {
    throw new Error("no `code` query param in callback URL — did the browser redirect?");
  }

  const provider = registry.get(entry.providerId);
  const tokenData = await provider.exchangeCode(
    code,
    returnedState,
    entry.state,
    entry.pkce,
  );
  if (!tokenData.provider) tokenData.provider = provider.id;
  provider.manager.addAccount(tokenData);

  return {
    provider: provider.id,
    email: tokenData.email,
    expiresAt: tokenData.expiresAt,
  };
}
