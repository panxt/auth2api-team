import { test } from "node:test";
import assert from "node:assert";
import { handleMcpRpc, GatewayCtx } from "../src/mcp/gateway";
import { nsName, parseNs } from "../src/mcp/namespace";

// Fake upstream client + controller (no network).
function fakeClient(tools: string[]) {
  return {
    listTools: async () => tools.map((n) => ({ name: n, description: n })),
    listResources: async () => [{ uri: "res://x", name: "x" }],
    listPrompts: async () => [{ name: "p1" }],
    callTool: async (name: string, args: unknown) => ({ content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }] }),
    readResource: async (uri: string) => ({ contents: [{ uri, text: "data" }] }),
    getPrompt: async (name: string) => ({ messages: [{ role: "user", content: { type: "text", text: name } }] }),
  };
}

// Build a ctx from a grant list (entries: "gitlab" whole, or "gitlab__tool").
function ctx(grants: string[]): GatewayCtx {
  const clients: Record<string, any> = {
    gitlab: fakeClient(["create_issue", "list_issues"]),
    jira: fakeClient(["search"]),
  };
  const enabled = Object.keys(clients);
  const allowedServerIds = enabled.filter(
    (id) => grants.includes(id) || grants.some((g) => g.startsWith(`${id}__`)),
  );
  return {
    allowedServerIds,
    isToolAllowed: (sid, tool) =>
      grants.includes(sid) || grants.includes(`${sid}__${tool}`),
    isServerFull: (sid) => grants.includes(sid),
    controller: { getClient: (id: string) => clients[id] } as any,
  };
}

test("namespace: encode/decode round-trips, first '__' splits", () => {
  assert.equal(nsName("gitlab", "create_issue"), "gitlab__create_issue");
  assert.deepEqual(parseNs("gitlab__create_issue"), { serverId: "gitlab", name: "create_issue" });
  // tool name itself containing '__' stays intact after the first split
  assert.deepEqual(parseNs("gitlab__a__b"), { serverId: "gitlab", name: "a__b" });
  assert.equal(parseNs("nounderscore"), null);
});

test("initialize returns serverInfo + capabilities; echoes protocol", async () => {
  const r: any = await handleMcpRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, ctx([]));
  assert.equal(r.result.serverInfo.name, "auth2api-mcp-gateway");
  assert.equal(r.result.protocolVersion, "2025-06-18");
  assert.ok(r.result.capabilities.tools);
});

test("notifications get no reply", async () => {
  const r = await handleMcpRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx(["gitlab"]));
  assert.equal(r, null);
});

test("tools/list aggregates + namespaces only allowed categories", async () => {
  const r: any = await handleMcpRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, ctx(["gitlab"]));
  const names = r.result.tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, ["gitlab__create_issue", "gitlab__list_issues"]);
});

test("default-deny: empty allowedIds → no tools", async () => {
  const r: any = await handleMcpRpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, ctx([]));
  assert.deepEqual(r.result.tools, []);
});

test("tools/call routes to owning upstream, strips namespace", async () => {
  const r: any = await handleMcpRpc(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "gitlab__create_issue", arguments: { title: "hi" } } },
    ctx(["gitlab"]),
  );
  assert.match(r.result.content[0].text, /^create_issue:/);
});

test("tools/call on unauthorized category → JSON-RPC error", async () => {
  const r: any = await handleMcpRpc(
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "jira__search", arguments: {} } },
    ctx(["gitlab"]), // jira not granted
  );
  assert.ok(r.error);
  assert.match(r.error.message, /unauthorized|unknown/);
});

test("per-tool grant: only the granted tool is listed + callable", async () => {
  const c = ctx(["gitlab__list_issues"]); // tool-scoped, not whole category
  const list: any = await handleMcpRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, c);
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ["gitlab__list_issues"]);
  // granted tool callable
  const okCall: any = await handleMcpRpc(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "gitlab__list_issues" } },
    c,
  );
  assert.ok(okCall.result);
  // sibling tool (same category) NOT granted → error
  const bad: any = await handleMcpRpc(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "gitlab__create_issue" } },
    c,
  );
  assert.ok(bad.error);
  assert.match(bad.error.message, /unauthorized/);
});

test("onToolCall metering hook fires with (serverId, tool, ok)", async () => {
  const seen: any[] = [];
  const c = ctx(["gitlab"]);
  c.onToolCall = (sid, tool, ok) => seen.push([sid, tool, ok]);
  await handleMcpRpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "gitlab__list_issues" } }, c);
  assert.deepEqual(seen, [["gitlab", "list_issues", true]]);
});
