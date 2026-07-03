import { test } from "node:test";
import assert from "node:assert";
import { HealthMonitor } from "../src/monitor/health-monitor";

// Minimal fakes: a registry with one provider whose quotaPool() we drive, and a
// notifier capturing sends + a fixed pool threshold.
function harness(threshold = 90) {
  const sends: any[] = [];
  const notifier: any = {
    poolThreshold: () => threshold,
    send: (ev: any) => sends.push(ev),
  };
  let pool: any = { "5h": null, "7d": null };
  const registry: any = {
    all: () => [
      {
        id: "anthropic",
        manager: { getSnapshots: () => [], quotaPool: () => pool },
      },
    ],
  };
  const hm = new HealthMonitor(registry, undefined, notifier);
  return {
    sends,
    hm,
    setUsed(w: "5h" | "7d", usedPct: number) {
      const remainingPct = 1 - usedPct / 100;
      pool = {
        ...pool,
        [w]: { remainingPct, remainingUnits: remainingPct * 4, soonestReset: "1000", level: "ok" },
      };
    },
  };
}

test("pool alert: fires once at warn, escalates to exhausted, not repeated", () => {
  const h = harness(90);
  h.setUsed("5h", 50);
  h.hm.tick();
  assert.equal(h.sends.length, 0); // below threshold

  h.setUsed("5h", 92);
  h.hm.tick();
  assert.equal(h.sends.length, 1); // crosses 90% → warn
  assert.match(h.sends[0].title, /即将用尽/);

  h.hm.tick(); // still 92% → no repeat (edge already fired)
  assert.equal(h.sends.length, 1);

  h.setUsed("5h", 100);
  h.hm.tick();
  assert.equal(h.sends.length, 2); // escalates to exhausted
  assert.match(h.sends[1].title, /已用尽/);

  h.hm.tick(); // still exhausted → no repeat
  assert.equal(h.sends.length, 2);
});

test("pool alert: recovery (window reset) re-arms a fresh warn", () => {
  const h = harness(90);
  h.setUsed("5h", 95);
  h.hm.tick();
  assert.equal(h.sends.length, 1);

  h.setUsed("5h", 10); // window reset — pool refilled
  h.hm.tick();
  assert.equal(h.sends.length, 1); // recovery is silent

  h.setUsed("5h", 95); // crosses again → new warn
  h.hm.tick();
  assert.equal(h.sends.length, 2);
});

test("pool alert: null window (no data) never fires", () => {
  const h = harness(90);
  h.hm.tick();
  h.hm.tick();
  assert.equal(h.sends.length, 0);
});
