import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountManager } from "../src/accounts/manager";

function mgr(weights: number[]): { m: AccountManager; emails: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-pool-"));
  const m = new AccountManager(dir, {
    provider: "anthropic",
    refresh: async () => ({}) as any,
  });
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
  return { m, emails };
}

/** Feed unified-5h/7d headers for one account via recordRateLimit. */
function setUtil(
  m: AccountManager,
  email: string,
  opts: { u5h?: number; r5h?: number; u7d?: number; r7d?: number },
): void {
  const h: Record<string, string> = {};
  if (opts.u5h != null) h["anthropic-ratelimit-unified-5h-utilization"] = String(opts.u5h);
  if (opts.r5h != null) h["anthropic-ratelimit-unified-5h-reset"] = String(opts.r5h);
  if (opts.u7d != null) h["anthropic-ratelimit-unified-7d-utilization"] = String(opts.u7d);
  if (opts.r7d != null) h["anthropic-ratelimit-unified-7d-reset"] = String(opts.r7d);
  m.recordRateLimit(email, new Headers(h));
}

test("quotaPool: weighted equivalent windows aggregate correctly", () => {
  const { m, emails } = mgr([1, 1, 3]);
  setUtil(m, emails[0], { u5h: 0.5 });
  setUtil(m, emails[1], { u5h: 0.5 });
  setUtil(m, emails[2], { u5h: 0 });

  const p = m.quotaPool()["5h"];
  assert.ok(p);
  assert.equal(p.accounts, 3);
  assert.equal(p.capacity, 5); // 1+1+3
  assert.equal(p.used, 1); // 0.5+0.5+0
  assert.equal(p.remainingUnits, 4);
  assert.equal(p.remainingPct, 0.8); // 1 - 1/5
});

test("quotaPool: percent-form headers (42) are normalized to 0.42", () => {
  const { m, emails } = mgr([1, 1]);
  setUtil(m, emails[0], { u5h: 50 }); // percent form
  setUtil(m, emails[1], { u5h: 50 });
  const p = m.quotaPool()["5h"];
  assert.ok(p);
  assert.equal(p.used, 1); // 0.5 + 0.5
  assert.equal(p.remainingPct, 0.5);
});

test("quotaPool: disabled accounts excluded; 7d independent of 5h", () => {
  const { m, emails } = mgr([1, 1, 1]);
  setUtil(m, emails[0], { u5h: 0.2, u7d: 0.9 });
  setUtil(m, emails[1], { u5h: 0.2, u7d: 0.9 });
  setUtil(m, emails[2], { u5h: 0.2, u7d: 0.9 });
  m.setDisabled(emails[2], true);

  const pool = m.quotaPool();
  assert.equal(pool["5h"]?.accounts, 2, "disabled excluded");
  assert.equal(pool["5h"]?.capacity, 2);
  // 7d much fuller than 5h → independent windows (90% used → warn)
  assert.equal(pool["7d"]?.remainingPct, 0.1);
  assert.equal(pool["7d"]?.level, "warn");
});

test("quotaPool: soonestReset is the nearest future reset", () => {
  const { m, emails } = mgr([1, 1]);
  const now = Math.floor(Date.now() / 1000);
  setUtil(m, emails[0], { u5h: 0.3, r5h: now + 7200 });
  setUtil(m, emails[1], { u5h: 0.3, r5h: now + 3600 }); // nearer
  const p = m.quotaPool()["5h"];
  assert.equal(p?.soonestReset, String(now + 3600));
});

test("quotaPool: null when no account surfaces a window", () => {
  const { m } = mgr([1, 1]); // no recordRateLimit calls
  const pool = m.quotaPool();
  assert.equal(pool["5h"], null);
  assert.equal(pool["7d"], null);
});

test("quotaPool: idle accounts (no util header) count as free capacity", () => {
  // One maxed account + two idle (never requested). The idle ones must count as
  // full headroom, so the pool is NOT ~100% used. (Regression: they used to be
  // excluded, making the pool overstate exhaustion.)
  const { m, emails } = mgr([1, 1, 1]);
  setUtil(m, emails[0], { u5h: 1.0 }); // maxed
  // emails[1], emails[2] have no rate-limit headers → idle
  const p = m.quotaPool()["5h"];
  assert.ok(p);
  assert.equal(p.accounts, 3, "all enabled accounts count as capacity");
  assert.equal(p.capacity, 3);
  assert.equal(p.used, 1, "only the maxed account contributes used");
  assert.equal(p.remainingUnits, 2);
  assert.equal(p.remainingPct, 0.6667); // 1 - 1/3, rounded to 4 dp
});

test("quotaPool: expired window (reset in the past) counts as 0 used", () => {
  const { m, emails } = mgr([1, 1]);
  const past = Math.floor(Date.now() / 1000) - 60; // reset already passed
  const future = Math.floor(Date.now() / 1000) + 3600;
  setUtil(m, emails[0], { u5h: 1.0, r5h: past }); // stale 100% but window reset
  setUtil(m, emails[1], { u5h: 0.5, r5h: future });
  const p = m.quotaPool()["5h"];
  assert.ok(p);
  assert.equal(p.capacity, 2);
  assert.equal(p.used, 0.5, "expired account contributes 0, live account 0.5");
});
