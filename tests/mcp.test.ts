import { test } from "node:test";
import assert from "node:assert";
import { McpController, McpError } from "../src/mcp/registry";
import type { SettingsStore } from "../src/storage/types";

function memSettings(): SettingsStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get<T = unknown>(k: string): T | null {
      return data.has(k) ? (data.get(k) as T) : null;
    },
    set(k: string, v: unknown): void {
      data.set(k, v);
    },
  };
}

const base = { transport: "streamable-http" as const, url: "http://127.0.0.1:9/mcp", enabled: false };

test("McpController: create validates + persists + masks secrets in view", () => {
  const s = memSettings();
  const c = new McpController(s);
  const v = c.create({ id: "gitlab", label: "GitLab", ...base, headers: { "Private-Token": "secret" } });
  assert.equal(v.id, "gitlab");
  assert.deepEqual(v.headerKeys, ["Private-Token"]);
  // view carries no header VALUES
  assert.ok(!JSON.stringify(v).includes("secret"));
  // but the raw secret IS persisted (needed to connect upstream)
  const persisted = s.get<{ servers: any[] }>("mcp");
  assert.equal(persisted!.servers[0].headers["Private-Token"], "secret");
});

test("McpController: id validation + uniqueness + immutability", () => {
  const c = new McpController(memSettings());
  assert.throws(() => c.create({ id: "Bad Id", ...base }), (e) => e instanceof McpError && e.code === "invalid");
  assert.throws(() => c.create({ id: "ok", url: "not-a-url", transport: "streamable-http" }), (e) => e instanceof McpError && e.code === "invalid");
  c.create({ id: "dup", ...base });
  assert.throws(() => c.create({ id: "dup", ...base }), (e) => e instanceof McpError && e.code === "conflict");
  assert.throws(() => c.update("dup", { id: "renamed" }), (e) => e instanceof McpError && e.code === "invalid");
});

test("McpController: update keeps headers when omitted, replaces when provided", () => {
  const s = memSettings();
  const c = new McpController(s);
  c.create({ id: "j", label: "Jira", ...base, headers: { A: "1" } });
  // omit headers → keep
  c.update("j", { label: "Jira2" });
  let raw = s.get<{ servers: any[] }>("mcp")!.servers[0];
  assert.equal(raw.label, "Jira2");
  assert.deepEqual(raw.headers, { A: "1" });
  // provide headers → replace
  c.update("j", { headers: { B: "2" } });
  raw = s.get<{ servers: any[] }>("mcp")!.servers[0];
  assert.deepEqual(raw.headers, { B: "2" });
});

test("McpController: remove + reconstruct from settings persists across restart", () => {
  const s = memSettings();
  const c1 = new McpController(s);
  c1.create({ id: "a", ...base });
  c1.create({ id: "b", ...base });
  c1.remove("a");
  assert.deepEqual(c1.ids(), ["b"]);
  assert.throws(() => c1.remove("a"), (e) => e instanceof McpError && e.code === "not_found");

  // new controller reads the same settings (simulated restart)
  const c2 = new McpController(s);
  assert.deepEqual(c2.ids(), ["b"]);
});

test("McpController: enabledIds reflects enabled flag; disabled health", () => {
  const s = memSettings();
  const c = new McpController(s);
  c.create({ id: "on", ...base, enabled: true });
  c.create({ id: "off", ...base, enabled: false });
  assert.deepEqual(c.enabledIds().sort(), ["on"]);
  const off = c.list().find((v) => v.id === "off")!;
  assert.equal(off.health.status, "disabled");
});
