import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyOpenAIResponsesError,
  type SseEvent,
} from "../src/upstream/streaming-failover";
import { AccountManager } from "../src/accounts/manager";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function errEvent(payload: unknown): SseEvent {
  return { event: "error", data: JSON.stringify(payload) };
}

// ── classifyOpenAIResponsesError ──────────────────────────────

test("non-error events are ignored", () => {
  assert.equal(
    classifyOpenAIResponsesError({ event: "response.output_text.delta", data: "{}" }),
    null,
  );
});

test("rate-limit → failover, rate_limit kind", () => {
  const c = classifyOpenAIResponsesError(
    errEvent({ error: { code: "rate_limit_exceeded", message: "rate limit" } }),
  );
  assert.deepEqual(c, {
    failover: true,
    errorKind: "rate_limit",
    detail: "rate limit",
  });
});

test("context-window overflow → NO failover, client kind (not the account's fault)", () => {
  // The real codex message — note it ends with "…try again", which must NOT
  // be mistaken for the retryable-server heuristic.
  const msg =
    "Your input exceeds the context window of this model. Please adjust your input and try again.";
  const c = classifyOpenAIResponsesError(
    errEvent({ error: { message: msg } }),
  );
  assert.equal(c?.failover, false);
  assert.equal(c?.errorKind, "client");
});

test("context-window via code → client kind", () => {
  const c = classifyOpenAIResponsesError(
    errEvent({ error: { code: "context_length_exceeded", message: "too long" } }),
  );
  assert.equal(c?.errorKind, "client");
  assert.equal(c?.failover, false);
});

test("transient 'you can retry' 500 → failover, server kind", () => {
  const msg =
    "An error occurred while processing your request. You can retry your request, or contact us through our help center if the error persists.";
  const c = classifyOpenAIResponsesError(
    errEvent({ error: { message: msg } }),
  );
  assert.equal(c?.failover, true);
  assert.equal(c?.errorKind, "server");
});

test("server_error code → failover, server kind", () => {
  const c = classifyOpenAIResponsesError(
    errEvent({ error: { code: "server_error", message: "boom" } }),
  );
  assert.equal(c?.failover, true);
  assert.equal(c?.errorKind, "server");
});

test("unknown error → no failover, server kind (conservative default)", () => {
  const c = classifyOpenAIResponsesError(
    errEvent({ error: { message: "some unrecognized thing" } }),
  );
  assert.equal(c?.failover, false);
  assert.equal(c?.errorKind, "server");
});

// ── recordFailure: client kind must never cool down an account ────────

test("recordFailure('client') does not cool down or count against the account", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-clientfail-"));
  try {
    const m = new AccountManager(dir, {
      provider: "codex",
      refresh: async () => ({}) as any,
    });
    m.addAccount({
      accessToken: "tok",
      refreshToken: "r",
      email: "c@x.com",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      provider: "codex",
    });
    m.recordFailure("c@x.com", "client", "context window exceeded");
    const snap = m.getSnapshots()[0];
    assert.equal(snap.failureCount, 0, "client fault must not bump failureCount");
    assert.equal(snap.available, true, "account must stay available");
    assert.equal(snap.cooldownUntil, 0, "no cooldown for a client fault");
    // A real server failure that follows should back off from base, not from
    // an inflated count.
    m.recordFailure("c@x.com", "server", "boom");
    assert.equal(m.getSnapshots()[0].failureCount, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("server-failure cooldown is capped at 30s even at high failure counts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-servercap-"));
  try {
    const m = new AccountManager(dir, {
      provider: "codex",
      refresh: async () => ({}) as any,
    });
    m.addAccount({
      accessToken: "tok",
      refreshToken: "r",
      email: "c@x.com",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      provider: "codex",
    });
    // Hammer 10 server failures → without a cap the backoff would be minutes.
    for (let i = 0; i < 10; i++) m.recordFailure("c@x.com", "server", "boom");
    const snap = m.getSnapshots()[0];
    const remainingMs = snap.cooldownUntil - Date.now();
    assert.ok(
      remainingMs <= 30_000 + 1000,
      `cooldown should be capped ~30s, got ${Math.round(remainingMs / 1000)}s`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
