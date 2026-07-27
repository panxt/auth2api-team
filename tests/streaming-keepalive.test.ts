import { test } from "node:test";
import assert from "node:assert";
import { handleStreamingResponse } from "../src/upstream/streaming";

/** Minimal Express-response double capturing writes. */
function fakeResp() {
  const writes: string[] = [];
  const handlers: Record<string, (() => void)[]> = {};
  return {
    writes,
    writableEnded: false,
    locals: {} as any,
    setHeader() {},
    flushHeaders() {},
    write(chunk: any) {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    },
    end() {
      (this as any).writableEnded = true;
    },
    on(ev: string, cb: () => void) {
      (handlers[ev] ??= []).push(cb);
    },
    off() {},
  };
}

/** Upstream whose single read() stays quiet for `quietMs`, then completes with
 *  no data — simulating a model that produces nothing for a while. */
function quietUpstream(quietMs: number) {
  let done = false;
  return {
    body: {
      getReader() {
        return {
          read() {
            if (done) return Promise.resolve({ done: true, value: undefined });
            return new Promise((resolve) => {
              setTimeout(() => {
                done = true;
                resolve({ done: true, value: undefined });
              }, quietMs);
            });
          },
          cancel() {
            return Promise.resolve();
          },
        };
      },
    },
  };
}

// The scheduler checks at max(1000ms, keepaliveMs/2), so use 1000ms here.
test("SSE keep-alive: quiet stream gets ': keep-alive' comments", async () => {
  const resp = fakeResp();
  await handleStreamingResponse(
    quietUpstream(2500) as any,
    resp as any,
    { keepaliveMs: 1000 },
  );
  const pings = resp.writes.filter((w) => w.includes(": keep-alive"));
  assert.ok(pings.length >= 1, `expected keep-alive pings, got writes: ${JSON.stringify(resp.writes)}`);
});

test("SSE keep-alive: disabled (0) emits no pings", async () => {
  const resp = fakeResp();
  await handleStreamingResponse(
    quietUpstream(2500) as any,
    resp as any,
    { keepaliveMs: 0 },
  );
  assert.equal(resp.writes.filter((w) => w.includes(": keep-alive")).length, 0);
});
