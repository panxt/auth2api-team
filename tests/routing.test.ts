import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountManager } from "../src/accounts/manager";
import { resolveRoutingConfig } from "../src/config";

function mgr(weights: number[]): { m: AccountManager; emails: string[]; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-route-"));
  const m = new AccountManager(dir, { provider: "anthropic", refresh: async () => ({}) as any });
  const emails: string[] = [];
  weights.forEach((w, i) => {
    const email = `acct${i}@x.com`;
    emails.push(email);
    m.addAccount({
      accessToken: `tok${i}`,
      refreshToken: `r${i}`,
      email,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      accountUuid: `u${i}`,
      provider: "anthropic",
      concurrencyWeight: w,
    });
  });
  return { m, emails, dir };
}

/** Simulate N concurrent in-flight client requests (select + acquire, no release). */
function fanOut(m: AccountManager, n: number): void {
  for (let i = 0; i < n; i++) {
    const r = m.getNextAccount();
    if (r.account) m.acquireSlot(r.account.token.email);
  }
}

function inFlightByEmail(m: AccountManager): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of m.getSnapshots()) out[s.email] = s.inFlight;
  return out;
}

test("weighted-least-inflight: equal weights spread ~evenly across 3 accounts", () => {
  const { m } = mgr([1, 1, 1]);
  m.setRouting(resolveRoutingConfig({ strategy: "weighted-least-inflight" }));
  fanOut(m, 99);
  const f = Object.values(inFlightByEmail(m));
  // 99 across 3 → 33 each (deterministic least-inflight).
  for (const v of f) assert.equal(v, 33);
});

test("weighted-least-inflight: weight 1:1:3 → ~20/20/60", () => {
  const { m, emails } = mgr([1, 1, 3]);
  m.setRouting(resolveRoutingConfig({ strategy: "weighted-least-inflight" }));
  fanOut(m, 100);
  const f = inFlightByEmail(m);
  // The big account should carry ~3x each small one.
  assert.ok(f[emails[2]] > f[emails[0]] * 2, `big=${f[emails[2]]} small=${f[emails[0]]}`);
  assert.equal(f[emails[0]] + f[emails[1]] + f[emails[2]], 100);
});

test("acquire/release balances: release returns inFlight to zero", () => {
  const { m, emails } = mgr([1, 1, 1]);
  m.setRouting(resolveRoutingConfig({ strategy: "weighted-least-inflight" }));
  fanOut(m, 30);
  const before = inFlightByEmail(m);
  for (const e of emails) {
    const n = before[e];
    for (let i = 0; i < n; i++) m.releaseSlot(e);
  }
  for (const v of Object.values(inFlightByEmail(m))) assert.equal(v, 0);
  // release is clamped at 0 (idempotent past empty)
  m.releaseSlot(emails[0]);
  assert.equal(inFlightByEmail(m)[emails[0]], 0);
});

test("sticky strategy: piles onto one account (legacy behavior)", () => {
  const { m } = mgr([1, 1, 1]);
  m.setRouting(resolveRoutingConfig({ strategy: "sticky" }));
  fanOut(m, 30);
  const counts = Object.values(inFlightByEmail(m)).sort((a, b) => b - a);
  assert.equal(counts[0], 30); // all on the sticky account
});

test("per-account-max-inflight: full pool → no account (429 path)", () => {
  const { m } = mgr([1, 1, 1]);
  m.setRouting(
    resolveRoutingConfig({ strategy: "weighted-least-inflight", "per-account-max-inflight": 2 }),
  );
  fanOut(m, 6); // 2 per account = full
  const r = m.getNextAccount();
  assert.equal(r.account, null);
  const cap = m.capacitySummary();
  assert.equal(cap.usable, 0);
  assert.ok(cap.saturationRejects >= 1);
});

test("5h-utilization tiebreak: prefer the account with more remaining quota", () => {
  const { m, emails } = mgr([1, 1]);
  m.setRouting(
    resolveRoutingConfig({ strategy: "weighted-least-inflight", "use-5h-utilization": true }),
  );
  // both idle (inFlight 0); acct0 nearly full (0.9), acct1 nearly empty (0.1)
  m.recordRateLimit(
    emails[0],
    new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.9" }),
  );
  m.recordRateLimit(
    emails[1],
    new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.1" }),
  );
  const r = m.getNextAccount();
  assert.equal(r.account?.token.email, emails[1]);
});

test("capacitySummary: critical when all accounts cooled", () => {
  const { m, emails } = mgr([1, 1]);
  for (const e of emails) m.recordFailure(e, "rate_limit", "x");
  const cap = m.capacitySummary();
  assert.equal(cap.usable, 0);
  assert.equal(cap.level, "critical");
  assert.ok(cap.soonestResetAt !== null);
});
