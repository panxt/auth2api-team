import crypto from "crypto";
import { Request } from "express";
import type { Config } from "../config";
import { AvailableAccount } from "../accounts/manager";
import { extractApiKey, hashApiKey } from "../utils/common";
import {
  getSessionID,
  DEFAULT_CLI_VERSION,
  DEFAULT_ENTRYPOINT,
} from "./anthropic-api";

/**
 * Fingerprint algorithm — exact replica of Claude Code's utils/fingerprint.ts
 *
 * Algorithm: SHA256(SALT + msg[4] + msg[7] + msg[20] + version).slice(0, 3)
 * The salt and char indices must match the backend validator exactly.
 */
const FINGERPRINT_SALT = "59cf53e54c78";

function extractFirstUserMessageText(messages: any[]): string {
  if (!Array.isArray(messages)) return "";
  const first = messages.find((m: any) => m.role === "user");
  if (!first) return "";
  if (typeof first.content === "string") return first.content;
  if (Array.isArray(first.content)) {
    const textBlock = first.content.find((b: any) => b.type === "text");
    if (textBlock) return textBlock.text || "";
  }
  return "";
}

function computeFingerprint(messageText: string, version: string): string {
  const indices = [4, 7, 20];
  const chars = indices.map((i) => messageText[i] || "0").join("");
  const input = `${FINGERPRINT_SALT}${chars}${version}`;
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 3);
}

function generateBillingHeader(
  messages: any[],
  version: string,
  entrypoint: string,
  workload?: string,
): string {
  const msgText = extractFirstUserMessageText(messages);
  const fp = computeFingerprint(msgText, version);

  // cc_workload: optional workload tag (e.g., for cron-initiated requests)
  const workloadPair = workload ? ` cc_workload=${workload};` : "";

  return `x-anthropic-billing-header: cc_version=${version}.${fp}; cc_entrypoint=${entrypoint};${workloadPair}`;
}

/**
 * Build metadata.user_id — JSON-stringified object matching real Claude Code.
 *
 * - device_id: fixed per auth2api instance (one "installation")
 * - account_uuid: fixed per OAuth account
 * - session_id: varies per API key (each downstream user = separate CLI session)
 */
function buildUserId(
  deviceId: string,
  accountUuid: string,
  sessionId: string,
): string {
  return JSON.stringify({
    device_id: deviceId,
    account_uuid: accountUuid,
    session_id: sessionId,
  });
}

/** Checks if system block is a billing header */
function isBillingHeaderBlock(block: any): boolean {
  return (
    typeof block.text === "string" &&
    block.text.includes("x-anthropic-billing-header")
  );
}

/** Checks if system block is the CLI prefix */
function isPrefixBlock(block: any): boolean {
  return (
    typeof block.text === "string" && block.text.includes("You are Claude Code")
  );
}

/**
 * Apply Claude Code cloaking to the request body.
 *
 * Supports two modes:
 * 1. OpenAI-compatible clients: Injects billing header, prefix, and metadata
 * 2. Claude Code CLI clients: Detects existing prefix/billing header, avoids duplication
 *
 * Always injects metadata.user_id (since external clients don't have the auth2api device_id).
 */
export interface CloakingOptions {
  body?: any;
  request: Request;
  account: AvailableAccount;
  config: Config;
}

export function applyCloaking(options: CloakingOptions): any {
  const { request, account, config } = options;
  const body = structuredClone(options.body ?? request.body);
  const cloaking = config.cloaking;
  const cliVersion = cloaking["cli-version"] || DEFAULT_CLI_VERSION;
  const entrypoint = cloaking.entrypoint || DEFAULT_ENTRYPOINT;

  // --- System prompt injection ---
  // Ensures billing header and CLI prefix are present in the system blocks.
  // Claude Code CLI clients may already include these; if so, keep the originals.
  // For OpenAI-compatible clients we generate them from scratch.

  const existingSystem = body.system || [];
  const remaining: any[] = Array.isArray(existingSystem)
    ? [...existingSystem]
    : [{ type: "text", text: existingSystem }];

  // Extract existing billing header and prefix if present, removing them from remaining
  const billingIdx = remaining.findIndex(isBillingHeaderBlock);
  const billingBlock =
    billingIdx >= 0
      ? remaining.splice(billingIdx, 1)[0]
      : {
          type: "text",
          text: generateBillingHeader(
            body.messages || [],
            cliVersion,
            entrypoint,
          ),
        };

  const prefixIdx = remaining.findIndex(isPrefixBlock);
  const prefixBlock =
    prefixIdx >= 0
      ? remaining.splice(prefixIdx, 1)[0]
      : {
          type: "text",
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
          cache_control: { type: "ephemeral" },
        };

  // Reassemble: billing header (pos 0), prefix (pos 1), then the rest
  body.system = [billingBlock, prefixBlock, ...remaining];

  // --- Metadata injection ---
  // metadata.user_id identifies the device, account, and session to the upstream API.
  // Claude Code CLI clients may pass a session ID header; otherwise we derive one
  // from the downstream API key so each user gets a stable, rotating session.

  const apiKeyHash = hashApiKey(extractApiKey(request.headers));

  let sessionID = request.headers["x-claude-code-session-id"];
  sessionID =
    typeof sessionID === "string" ? sessionID : getSessionID(apiKeyHash);

  if (!body.metadata) body.metadata = {};

  body.metadata.user_id = buildUserId(
    account.deviceId,
    account.accountUuid,
    sessionID,
  );

  fixCacheControlOrder(body);

  return body;
}

/**
 * Anthropic enforces a strict ordering on prompt-caching breakpoints:
 *
 *   "a ttl='1h' cache_control block must not come after a ttl='5m' cache_control
 *    block. blocks are processed in the following order: tools, system, messages."
 *
 * Two ways this fails in practice:
 *   1. Some clients (notably the macOS Claude app and a few third-party
 *      desktop clients) build a body where a 1h breakpoint comes LATER than a
 *      5m one in the global processing order.
 *   2. `applyCloaking` itself injects a `cache_control: {type:"ephemeral"}`
 *      CLI-prefix block at the head of `system[]` (no ttl → Anthropic treats
 *      as 5m). If the client had a 1h breakpoint anywhere after that, we
 *      created the violation.
 *
 * Fix strategy is *reordering by swap*, not demotion: collect every
 * cache_control object across tools / system / messages in their natural
 * order, then reassign them in TTL-descending order. The breakpoint
 * positions stay where they were (no message reordering) — only which
 * cache_control object sits at each position changes. This preserves the
 * client's intent of "some block gets a 1h cache" instead of throwing away
 * the longer TTL.
 *
 * Called at the end of applyCloaking so the injected prefix is included in
 * the walk. Anthropic upstream is the only one that uses cache_control;
 * codex / cursor don't go through cloaking.
 *
 * Approach contributed by ops/prod team after observing the macOS Claude
 * app hit Anthropic's 400 through this proxy.
 */
function fixCacheControlOrder(body: any): void {
  const TTL_RANK: Record<string, number> = { "1h": 2, "5m": 1 };
  const refs: Array<{ obj: any; key: string }> = [];

  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      if (t?.cache_control) refs.push({ obj: t, key: "cache_control" });
    }
  }
  if (Array.isArray(body.system)) {
    for (const s of body.system) {
      if (s?.cache_control) refs.push({ obj: s, key: "cache_control" });
    }
  }
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      // Defensive: Anthropic docs only document cache_control on content
      // blocks, but some clients attach it to the message itself.
      if (m?.cache_control) refs.push({ obj: m, key: "cache_control" });
      if (Array.isArray(m?.content)) {
        for (const c of m.content) {
          if (c?.cache_control) refs.push({ obj: c, key: "cache_control" });
        }
      }
    }
  }

  if (refs.length < 2) return;
  const ttls = refs.map((r) => r.obj[r.key]);
  const sorted = [...ttls].sort(
    (a, b) => (TTL_RANK[b?.ttl] ?? 0) - (TTL_RANK[a?.ttl] ?? 0),
  );
  let changed = false;
  for (let i = 0; i < refs.length; i++) {
    if (refs[i].obj[refs[i].key] !== sorted[i]) {
      refs[i].obj[refs[i].key] = sorted[i];
      changed = true;
    }
  }
  if (changed) {
    console.log(
      "[cache_control] reordered TTLs:",
      ttls.map((t) => t?.ttl ?? "(default)"),
      "→",
      sorted.map((t) => t?.ttl ?? "(default)"),
    );
  }
}
