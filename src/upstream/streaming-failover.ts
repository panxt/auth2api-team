/**
 * Mid-SSE-stream failover.
 *
 * The pre-stream side of proxyWithRetry only sees HTTP status codes —
 * it can rotate to a fresh account when upstream returns 4xx/5xx BEFORE
 * any bytes are sent to the client. But Anthropic (and OpenAI) increasingly
 * return `200 OK` and then put the error into the SSE stream as an
 * `event: error` payload. The client sees a broken stream and the
 * proxy never recovers.
 *
 * This module's contract:
 *   - Caller opens an SSE upstream for a streaming request.
 *   - Caller hands the Response off to `streamUntilCommitOrFailover`.
 *   - We BUFFER bytes from upstream, only inspecting SSE events, until
 *     we see either:
 *       (a) the first content-bearing event (e.g.
 *           `content_block_delta` for Anthropic, `response.output_text.delta`
 *           for OpenAI Responses, `chat.completion.chunk` with content
 *           for OpenAI Chat) — at which point we COMMIT: flush the buffer
 *           to the client and switch to pass-through.
 *       (b) an `event: error` whose payload classifies as failoverable
 *           (rate_limit_error, overloaded_error, etc.) — return
 *           `{ kind: "failover" }` so the caller can try the next account.
 *       (c) the upstream finishes cleanly (rare for stream=true) — flush
 *           buffer and end. `kind: "done"`.
 *       (d) a non-failoverable error or buffer overflow — flush + forward
 *           the error to the client as-is. `kind: "committed-error"`.
 *
 * Once committed, every subsequent byte is forwarded as-is until done.
 *
 * Buffer is capped at 64 KiB (configurable). Anthropic's first
 * content_block_delta lands within ~200-500ms in practice, so the buffer
 * stays small.
 */

import type { Response as ExpressResponse } from "express";
import type { AccountFailureKind, UsageData } from "../accounts/manager";

const DEFAULT_BUFFER_LIMIT = 64 * 1024;

export interface SseEvent {
  /** Event name (`event:` line), `"message"` if absent. */
  event: string;
  /** Data lines concatenated with `\n`. May be valid JSON or not. */
  data: string;
}

export type FailoverDecision =
  | { kind: "done" }
  | { kind: "failover"; errorKind: AccountFailureKind; detail: string }
  | { kind: "committed-error"; status: number }
  | { kind: "client-disconnected" };

export interface StreamFailoverOptions {
  /** Event names that mark the upstream as "committed" — once we see one,
   *  flush the buffer to the client and switch to pass-through. */
  contentEvents: Set<string>;
  /** Decide if an `event: error` payload should trigger failover. */
  classifyError: (event: SseEvent) => {
    failover: boolean;
    errorKind: AccountFailureKind;
    detail: string;
  } | null;
  /** Optional: invoked on every parsed event so the caller can extract
   *  upstream usage data for billing. Mutates the shared `usage` object. */
  onEvent?: (event: SseEvent, usage: UsageData) => void;
  /** Optional: per-event translator. When provided, the helper writes the
   *  TRANSLATED bytes to the client instead of the raw upstream bytes. Use
   *  this for endpoints where the inbound and upstream wire formats differ
   *  (e.g. OpenAI Chat client over Anthropic upstream). Return null to
   *  drop the event entirely. State (if any) is managed by the caller via
   *  closure. */
  transformEvent?: (event: SseEvent) => Uint8Array | string | null;
  /** Bound on how many bytes we'll buffer before forced commit (safety). */
  bufferLimit?: number;
}

export interface FailoverResult {
  decision: FailoverDecision;
  /** True if any byte was forwarded to the client. After commit a retry is
   *  no longer possible (client has seen partial output). */
  committed: boolean;
  /** Token usage accumulated by the onEvent callback (zeros if no callback). */
  usage: UsageData;
}

/**
 * Consume an upstream SSE Response, deciding mid-stream whether to commit
 * to the client or signal a failover. Does NOT manage account selection;
 * caller (proxyStreamingWithFailover below) does that.
 */
export async function streamUntilCommitOrFailover(
  upstream: globalThis.Response,
  outResp: ExpressResponse,
  options: StreamFailoverOptions,
): Promise<FailoverResult> {
  const limit = options.bufferLimit ?? DEFAULT_BUFFER_LIMIT;
  const usage: UsageData = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    reasoningOutputTokens: 0,
  };

  if (!upstream.body) {
    // No body — nothing to stream. Treat as a clean done.
    return { decision: { kind: "done" }, committed: false, usage };
  }

  // ── Stream headers: only set ONCE, the first time we commit ───────────
  let headersSent = false;
  let committed = false;
  const flushHeaders = () => {
    if (headersSent) return;
    headersSent = true;
    outResp.setHeader("Content-Type", "text/event-stream");
    outResp.setHeader("Cache-Control", "no-cache");
    outResp.setHeader("Connection", "keep-alive");
    outResp.setHeader("X-Accel-Buffering", "no");
    outResp.flushHeaders();
  };

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // Raw byte chunks held back from the client (waiting for commit / failover decision).
  // In translate mode, we hold pre-translated bytes here instead.
  const heldChunks: Uint8Array[] = [];
  let heldBytes = 0;
  // Parser state: text buffer + currently-accumulating event.
  let textBuffer = "";
  let curEventName = "";
  let curDataLines: string[] = [];

  const useTransform = !!options.transformEvent;

  let clientDisconnected = false;
  const onClose = () => {
    clientDisconnected = true;
    reader.cancel().catch(() => {});
  };
  outResp.on("close", onClose);

  const commitAndFlush = () => {
    committed = true;
    flushHeaders();
    for (const c of heldChunks) outResp.write(c);
    heldChunks.length = 0;
    heldBytes = 0;
  };

  /** Emit a transformed-event's bytes. Pre-commit: buffer. Post-commit: write. */
  const emitTransformed = (ev: SseEvent) => {
    if (!useTransform || !options.transformEvent) return;
    const out = options.transformEvent(ev);
    if (out == null) return;
    const bytes = typeof out === "string" ? encoder.encode(out) : out;
    if (committed) {
      outResp.write(bytes);
    } else {
      heldChunks.push(bytes);
      heldBytes += bytes.byteLength;
    }
  };

  /** Returns the failover/committed-error decision if applicable, else null. */
  const handleParsedEvent = (
    ev: SseEvent,
  ): FailoverDecision | null => {
    // Always let caller extract usage(both pre and post commit).
    options.onEvent?.(ev, usage);

    // In transform mode, we always re-emit (pre-commit buffer, post-commit write).
    // Pre-commit emits will be flushed on commit, or discarded on failover.
    if (useTransform) {
      // Only emit if this event passes the failover gate — translator decides shape.
      // We DEFER emission for "error" events until we know failoverability.
      if (ev.event !== "error") {
        emitTransformed(ev);
      }
    }

    if (committed) return null;

    if (ev.event === "error") {
      const classification = options.classifyError(ev);
      if (classification && classification.failover) {
        // Failover — DON'T translate the error to the client; the caller
        // will retry with a new account and emit the next attempt's stream.
        return {
          kind: "failover",
          errorKind: classification.errorKind,
          detail: classification.detail,
        };
      }
      // Non-failoverable error: commit + forward.
      if (useTransform) {
        emitTransformed(ev); // include translated error in client output
      }
      commitAndFlush();
      return null;
    }

    if (options.contentEvents.has(ev.event)) {
      commitAndFlush();
      return null;
    }

    return null;
  };

  try {
    while (!clientDisconnected) {
      const { done, value } = await reader.read();

      // Output mode:
      //   - raw passthrough: hold/forward upstream bytes verbatim.
      //   - translate mode:  IGNORE upstream bytes; emitTransformed() handles
      //                      output per-event. We only need to parse the SSE
      //                      below to drive event-level callbacks.
      if (!useTransform) {
        if (!committed && value) {
          heldChunks.push(value);
          heldBytes += value.byteLength;
          if (heldBytes > limit) {
            // Safety: don't hold indefinitely. Commit and pass-through.
            commitAndFlush();
          }
        } else if (committed && value) {
          outResp.write(value);
        }
      } else {
        // Translate mode safety: cap PARSED but not-yet-committed output.
        if (!committed && heldBytes > limit) {
          commitAndFlush();
        }
      }

      if (done) {
        // Final flush of any pending decoder bytes + buffer line.
        textBuffer += decoder.decode();
        // Process any tailing event we accumulated.
        const lines = textBuffer.split("\n");
        for (const raw of lines) {
          const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
          appendToCurrentEvent(line);
        }
        const tailEvent = takeCurrentEvent();
        if (tailEvent) {
          const dec = handleParsedEvent(tailEvent);
          if (dec) {
            outResp.removeListener("close", onClose);
            return { decision: dec, committed, usage };
          }
        }
        if (!committed) {
          // Stream ended without producing any content; flush whatever was buffered.
          commitAndFlush();
        }
        outResp.end();
        outResp.removeListener("close", onClose);
        return { decision: { kind: "done" }, committed, usage };
      }

      if (value) {
        textBuffer += decoder.decode(value, { stream: true });
      }

      // Drain whole-line(s) out of textBuffer. SSE delimits events with a
      // blank line; we walk each line and update parser state.
      const lines = textBuffer.split("\n");
      // Keep the last (possibly partial) line in the buffer.
      textBuffer = lines.pop() ?? "";

      for (const raw of lines) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (line === "") {
          // End of an event.
          const ev = takeCurrentEvent();
          if (ev) {
            const dec = handleParsedEvent(ev);
            if (dec) {
              outResp.removeListener("close", onClose);
              return { decision: dec, committed, usage };
            }
          }
        } else {
          appendToCurrentEvent(line);
        }
      }
    }

    // Client disconnected.
    outResp.removeListener("close", onClose);
    return { decision: { kind: "client-disconnected" }, committed, usage };
  } catch (err) {
    outResp.removeListener("close", onClose);
    // Mid-stream network / abort error. If we hadn't committed yet,
    // treat like a failover-worthy network failure.
    if (!committed) {
      return {
        decision: {
          kind: "failover",
          errorKind: "network",
          detail: (err as any)?.message || String(err),
        },
        committed: false,
        usage,
      };
    }
    // Committed already — can't retry. Just end and let client see broken stream.
    if (!outResp.writableEnded) outResp.end();
    return {
      decision: { kind: "committed-error", status: 502 },
      committed: true,
      usage,
    };
  }

  function appendToCurrentEvent(line: string) {
    if (line.startsWith("event:")) {
      curEventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      curDataLines.push(line.slice(5).trim());
    } else if (line.startsWith(":")) {
      // SSE comment — ignore.
    }
    // other lines (id:, retry:) also ignored
  }

  function takeCurrentEvent(): SseEvent | null {
    if (curEventName === "" && curDataLines.length === 0) return null;
    const ev: SseEvent = {
      event: curEventName || "message",
      data: curDataLines.join("\n"),
    };
    curEventName = "";
    curDataLines = [];
    return ev;
  }
}

/* ── Provider-specific error classifiers ─────────────────────────────── */

/** Anthropic SSE error event → failoverable classification. */
export function classifyAnthropicError(
  ev: SseEvent,
): { failover: boolean; errorKind: AccountFailureKind; detail: string } | null {
  if (ev.event !== "error") return null;
  let parsed: any = null;
  try {
    parsed = JSON.parse(ev.data);
  } catch {
    return { failover: false, errorKind: "server", detail: ev.data };
  }
  const errType = parsed?.error?.type ?? "";
  const message = parsed?.error?.message ?? "";

  // Failoverable: rate-limit and overloaded are account-scoped; rotating to
  // another account is the right call. Extra-usage 400 has the same root
  // cause (per-account quota exhausted).
  if (
    errType === "rate_limit_error" ||
    errType === "overloaded_error" ||
    /third-party apps now draw from extra usage/i.test(message)
  ) {
    return {
      failover: true,
      errorKind: errType === "rate_limit_error" ? "rate_limit" : "forbidden",
      detail: message,
    };
  }

  // Account-scoped auth errors: also failoverable.
  if (errType === "authentication_error" || errType === "permission_error") {
    return { failover: true, errorKind: "auth", detail: message };
  }

  // Anything else (invalid_request_error, api_error etc.) is request-scoped.
  return { failover: false, errorKind: "server", detail: message };
}

/** OpenAI Responses SSE error event → failoverable classification.
 *  Used for Codex/Cursor responses paths after the OpenAI->Anthropic
 *  translator emits anthropic-shaped errors, this won't match — those
 *  go through classifyAnthropicError. This is for native Responses passthrough. */
export function classifyOpenAIResponsesError(
  ev: SseEvent,
): { failover: boolean; errorKind: AccountFailureKind; detail: string } | null {
  if (ev.event !== "error" && ev.event !== "response.failed") return null;
  let parsed: any = null;
  try {
    parsed = JSON.parse(ev.data);
  } catch {
    return { failover: false, errorKind: "server", detail: ev.data };
  }
  const code = parsed?.error?.code ?? parsed?.code ?? "";
  const message = parsed?.error?.message ?? parsed?.message ?? "";

  if (
    code === "rate_limit_exceeded" ||
    code === "insufficient_quota" ||
    /rate limit/i.test(message) ||
    /usage limit/i.test(message)
  ) {
    return { failover: true, errorKind: "rate_limit", detail: message };
  }
  if (code === "invalid_api_key" || code === "unauthorized") {
    return { failover: true, errorKind: "auth", detail: message };
  }
  return { failover: false, errorKind: "server", detail: message };
}

/* ── Content-event sets for each upstream protocol ───────────────────── */

/** Events that, when seen, mean "real model output has started". */
export const ANTHROPIC_CONTENT_EVENTS = new Set<string>([
  "content_block_delta",
  "message_delta",
]);

export const OPENAI_RESPONSES_CONTENT_EVENTS = new Set<string>([
  "response.output_text.delta",
  "response.reasoning.delta",
  "response.output_item.added",
  "response.content_part.added",
]);

export const OPENAI_CHAT_CONTENT_EVENTS = new Set<string>([
  // OpenAI Chat Completions streams use `data:` lines without `event:`
  // (so event name is "message" by default). Content detection happens
  // by parsing the JSON `data` payload — handled by a separate predicate.
  // We include "message" so SOME content marker is checked; the real
  // gate is the classifier's own content-detection (TBD if we need it).
  "message",
]);

/* ── Top-level helper that combines pre-stream + mid-stream failover ─── */

import { AccountManager, AvailableAccount } from "../accounts/manager";
import { Config, isDebugLevel } from "../config";
import type { ProxyOptions } from "../utils/http";

export interface StreamingProxyOptions {
  /** Tag for logging (e.g., "Messages", "ChatCompletions"). */
  tag: string;
  manager: AccountManager;
  config: Config;
  /** Build/perform the upstream call for a given account. */
  upstream: (
    account: AvailableAccount,
    signal: AbortSignal,
  ) => Promise<globalThis.Response>;
  /** SSE content-event detection. */
  contentEvents: Set<string>;
  /** Failover-error classifier. */
  classifyError: StreamFailoverOptions["classifyError"];
  /** Per-event usage extractor. */
  onEvent?: StreamFailoverOptions["onEvent"];
  /** Per-event output translator (e.g. codex Responses → Anthropic Messages). */
  transformEvent?: StreamFailoverOptions["transformEvent"];
  /** Pre-stream error → client error body adapter (same as ProxyOptions). */
  errorAdapter?: ProxyOptions["errorAdapter"];
  /** Max number of (pre+mid) attempts across distinct accounts. Default 3. */
  maxAttempts?: number;
}

export interface StreamingProxyResult {
  /** Did the final stream complete cleanly? */
  completed: boolean;
  /** Was the client gone? */
  clientDisconnected: boolean;
  /** True if we wrote ANY bytes to the client (committed). After commit
   *  the result.usage still reflects what the upstream finally produced
   *  (or partial, on errors). */
  committed: boolean;
  /** Usage accumulated by onEvent (zeros if no callback). */
  usage: UsageData;
  /** The account whose stream the client actually saw, if any. */
  accountUsed: AvailableAccount | null;
}

/**
 * Run a streaming upstream call with both pre-stream AND mid-SSE-stream
 * failover. Use this in place of `proxyWithRetry` when the inbound request
 * is `stream: true` and the upstream emits SSE.
 *
 * On mid-stream errors that classify as failoverable AND haven't yet
 * flushed any bytes to the client, this loops and tries another account
 * (up to `maxAttempts`). Once any byte is flushed, the stream is
 * irrevocably bound to that account — subsequent errors are forwarded.
 */
export async function proxyStreamingWithFailover(
  resp: ExpressResponse,
  options: StreamingProxyOptions,
): Promise<StreamingProxyResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  const { manager, tag, config } = options;

  let attempts = 0;
  let lastFailoverDetail: string | null = null;
  const abort = new AbortController();

  // Make sure we abort the upstream connection if the client disconnects
  // before we commit.
  const onClientClose = () => abort.abort();
  resp.once("close", onClientClose);

  try {
    while (attempts < maxAttempts) {
      attempts++;
      const result = manager.getNextAccount();
      if (!result.account) {
        // No more healthy accounts. If we've already committed, the client
        // has a partial stream — just end. Otherwise return a structured
        // 503-style error to the client. We can't do that easily here
        // because flushHeaders hasn't been called; write a JSON body.
        if (!resp.headersSent) {
          resp.status(503).json({
            error: {
              message: lastFailoverDetail
                ? `All upstream accounts exhausted; last error: ${lastFailoverDetail}`
                : "No upstream account available",
              type: "no_account_for_provider",
              provider: manager.provider,
            },
          });
        } else if (!resp.writableEnded) {
          resp.end();
        }
        return {
          completed: false,
          clientDisconnected: false,
          committed: false,
          usage: emptyUsage(),
          accountUsed: null,
        };
      }
      const account = result.account;
      manager.recordAttempt(account.token.email);

      // Open the upstream.
      let upstream: globalThis.Response;
      try {
        upstream = await options.upstream(account, abort.signal);
      } catch (err: any) {
        manager.recordFailure(account.token.email, "network", err?.message);
        lastFailoverDetail = err?.message || String(err);
        if (isDebugLevel(config.debug, "errors")) {
          console.error(
            `${tag} streaming attempt ${attempts} network error: ${err?.message}`,
          );
        }
        continue;
      }

      // Capture rate-limit headers regardless of outcome.
      manager.recordRateLimit?.(account.token.email, upstream.headers);

      // Pre-stream HTTP error? Use the same classification proxyWithRetry uses.
      if (!upstream.ok) {
        const errBody = await upstream.text().catch(() => "");
        if (isDebugLevel(config.debug, "errors")) {
          console.error(
            `${tag} streaming attempt ${attempts} pre-stream ${upstream.status}: ${errBody}`,
          );
        }
        lastFailoverDetail = `HTTP ${upstream.status}`;
        // Cooldown + retry if it's account-scoped (auth/forbidden/rate_limit/server).
        if (
          upstream.status === 401 ||
          upstream.status === 403 ||
          upstream.status === 429 ||
          upstream.status >= 500
        ) {
          const kind: AccountFailureKind =
            upstream.status === 401
              ? "auth"
              : upstream.status === 403
                ? "forbidden"
                : upstream.status === 429
                  ? "rate_limit"
                  : "server";
          manager.recordFailure(account.token.email, kind, errBody.slice(0, 200));
          // Try next account (still pre-stream, headers not flushed).
          continue;
        }
        // Other 4xx: bad request. Surface to client as-is and stop.
        const body = options.errorAdapter
          ? options.errorAdapter(upstream.status, errBody)
          : safeJsonOrText(errBody);
        if (!resp.headersSent) resp.status(upstream.status).json(body);
        return {
          completed: false,
          clientDisconnected: false,
          committed: false,
          usage: emptyUsage(),
          accountUsed: account,
        };
      }

      // ── 200 OK — start consuming SSE with failover detection ──────────
      const { decision, committed, usage } = await streamUntilCommitOrFailover(
        upstream,
        resp,
        {
          contentEvents: options.contentEvents,
          classifyError: options.classifyError,
          onEvent: options.onEvent,
          transformEvent: options.transformEvent,
        },
      );

      if (decision.kind === "done") {
        manager.recordSuccess(account.token.email, usage);
        return {
          completed: true,
          clientDisconnected: false,
          committed,
          usage,
          accountUsed: account,
        };
      }
      if (decision.kind === "client-disconnected") {
        // Client gave up. Record as not-completed but not a real failure.
        if (!committed) {
          // Record nothing — we never started streaming back. The upstream
          // call already happened, so it counts as a request.
        }
        return {
          completed: false,
          clientDisconnected: true,
          committed,
          usage,
          accountUsed: account,
        };
      }
      if (decision.kind === "committed-error") {
        // Already committed; can't retry. Stream is over.
        return {
          completed: false,
          clientDisconnected: false,
          committed: true,
          usage,
          accountUsed: account,
        };
      }
      // decision.kind === "failover" — try next account.
      manager.recordFailure(
        account.token.email,
        decision.errorKind,
        decision.detail.slice(0, 200),
      );
      lastFailoverDetail = decision.detail;
      if (isDebugLevel(config.debug, "errors")) {
        console.error(
          `${tag} mid-stream failover from ${account.token.email}: ${decision.detail}`,
        );
      }
      // Loop to try next account.
    }

    // Exhausted attempts without committing.
    if (!resp.headersSent) {
      resp.status(503).json({
        error: {
          message: lastFailoverDetail
            ? `Mid-stream failover exhausted after ${attempts} attempts: ${lastFailoverDetail}`
            : "Mid-stream failover exhausted",
          type: "stream_failover_exhausted",
          provider: manager.provider,
        },
      });
    } else if (!resp.writableEnded) {
      resp.end();
    }
    return {
      completed: false,
      clientDisconnected: false,
      committed: resp.headersSent,
      usage: emptyUsage(),
      accountUsed: null,
    };
  } finally {
    resp.removeListener("close", onClientClose);
  }
}

function safeJsonOrText(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return { error: { message: s || "upstream error" } };
  }
}

function emptyUsage(): UsageData {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    reasoningOutputTokens: 0,
  };
}
