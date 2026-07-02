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
    notion: fakeClient(["read"]),
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

test("tools/list aggregates + namespaces only allowed categories (multi-upstream)", async () => {
  // ≥2 authorized upstreams → namespaced; notion not granted → excluded.
  const r: any = await handleMcpRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, ctx(["gitlab", "jira"]));
  const names = r.result.tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, ["gitlab__create_issue", "gitlab__list_issues", "jira__search"]);
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

test("tools/call on unauthorized category → JSON-RPC error (multi-upstream)", async () => {
  // gitlab+jira granted (prefixed mode); notion is a registered but ungranted
  // category → must be rejected.
  const r: any = await handleMcpRpc(
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "notion__read", arguments: {} } },
    ctx(["gitlab", "jira"]),
  );
  assert.ok(r.error);
  assert.match(r.error.message, /unauthorized|unknown/);
});

test("per-tool grant (multi-upstream, prefixed): only the granted tool is listed + callable", async () => {
  // gitlab tool-scoped + jira whole → 2 servers → prefixed mode.
  const c = ctx(["gitlab__list_issues", "jira"]);
  const list: any = await handleMcpRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, c);
  const gitlabTools = list.result.tools.map((t: any) => t.name).filter((n: string) => n.startsWith("gitlab__"));
  assert.deepEqual(gitlabTools, ["gitlab__list_issues"]);
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

test("single-upstream key → flat mode: tools/list returns un-namespaced names", async () => {
  const c = ctx(["gitlab"]); // only one server authorized
  const list: any = await handleMcpRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, c);
  const names = list.result.tools.map((t: any) => t.name).sort();
  // no "gitlab__" prefix — raw upstream tool names
  assert.deepEqual(names, ["create_issue", "list_issues"]);
});

test("flat mode: tools/call accepts the bare tool name", async () => {
  const c = ctx(["gitlab"]);
  const r: any = await handleMcpRpc(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_issue", arguments: { title: "hi" } } },
    c,
  );
  assert.match(r.result.content[0].text, /^create_issue:/);
});

test("flat mode: also tolerates a cached namespaced name", async () => {
  const c = ctx(["gitlab"]);
  const r: any = await handleMcpRpc(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "gitlab__create_issue", arguments: {} } },
    c,
  );
  assert.match(r.result.content[0].text, /^create_issue:/);
});

test("flat mode still enforces tool-scoped grants", async () => {
  const c = ctx(["gitlab__list_issues"]); // single server, one tool
  const list: any = await handleMcpRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, c);
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ["list_issues"]); // un-namespaced
  const bad: any = await handleMcpRpc(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_issue" } },
    c,
  );
  assert.ok(bad.error); // sibling tool not granted
});

test("onToolCall metering hook fires with (serverId, tool, ok)", async () => {
  const seen: any[] = [];
  const c = ctx(["gitlab"]);
  c.onToolCall = (sid, tool, ok) => seen.push([sid, tool, ok]);
  await handleMcpRpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "gitlab__list_issues" } }, c);
  assert.deepEqual(seen, [["gitlab", "list_issues", true]]);
});
