import type { McpController } from "./registry";
import { nsName, parseNs } from "./namespace";

/**
 * Stateless JSON-mode handler for the client-facing MCP endpoint. auth2api acts
 * as one MCP server that aggregates the caller's authorized upstreams:
 *   - list methods fan out to allowed upstreams and namespace results
 *     (<serverId>__<name/uri>);
 *   - call/read/get methods decode the namespace and route to the owning
 *     upstream (rejecting unauthorized/unknown ids).
 * Notifications get no response. Errors are returned as JSON-RPC error objects.
 */

const DEFAULT_PROTOCOL = "2025-06-18";

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

export interface GatewayCtx {
  /** Categories to fan out to (this key has some grant on them). */
  allowedServerIds: string[];
  /** Per-tool gate (whole-category or tool-scoped grant). */
  isToolAllowed: (serverId: string, tool: string) => boolean;
  /** Whole-category gate (prompts/resources are category-scoped). */
  isServerFull: (serverId: string) => boolean;
  controller: McpController;
  /** Called once per successful tools/call for usage/metering. */
  onToolCall?: (serverId: string, tool: string, ok: boolean) => void;
}

/** Returns a JSON-RPC response object, or null for notifications (no reply). */
export async function handleMcpRpc(
  req: JsonRpcRequest,
  ctx: GatewayCtx,
): Promise<object | null> {
  const id = req?.id ?? null;
  const method = req?.method ?? "";
  const params = req?.params ?? {};
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  // Notifications (initialized, cancelled, …) — acknowledge with no body.
  if (method.startsWith("notifications/")) return null;

  switch (method) {
    case "initialize":
      return ok({
        protocolVersion:
          typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : DEFAULT_PROTOCOL,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "auth2api-mcp-gateway", version: "1.0.0" },
      });

    case "ping":
      return ok({});

    case "tools/list":
      return ok({
        tools: await aggregate(ctx, async (sid, client) =>
          (await client.listTools())
            .filter((t: any) => ctx.isToolAllowed(sid, t.name))
            .map((t: any) => ({ ...t, name: nsName(sid, t.name) })),
        ),
      });

    case "prompts/list":
      return ok({
        prompts: await aggregate(ctx, async (sid, client) =>
          ctx.isServerFull(sid)
            ? (await client.listPrompts()).map((p: any) => ({
                ...p,
                name: nsName(sid, p.name),
              }))
            : [],
        ),
      });

    case "resources/list":
      return ok({
        resources: await aggregate(ctx, async (sid, client) =>
          ctx.isServerFull(sid)
            ? (await client.listResources()).map((r: any) => ({
                ...r,
                uri: nsName(sid, r.uri),
              }))
            : [],
        ),
      });

    case "tools/call": {
      const route = resolve(ctx, params.name);
      if ("error" in route) return err(-32602, route.error);
      if (!ctx.isToolAllowed(route.serverId, route.name)) {
        return err(-32602, `unauthorized tool: ${params.name}`);
      }
      try {
        const result = await route.client.callTool(route.name, params.arguments);
        ctx.onToolCall?.(route.serverId, route.name, true);
        return ok(result);
      } catch (e: any) {
        ctx.onToolCall?.(route.serverId, route.name, false);
        return err(-32603, e?.message || "tool call failed");
      }
    }

    case "prompts/get": {
      const route = resolve(ctx, params.name);
      if ("error" in route) return err(-32602, route.error);
      if (!ctx.isServerFull(route.serverId)) {
        return err(-32602, `unauthorized prompt: ${params.name}`);
      }
      try {
        return ok(await route.client.getPrompt(route.name, params.arguments));
      } catch (e: any) {
        return err(-32603, e?.message || "prompt get failed");
      }
    }

    case "resources/read": {
      const route = resolve(ctx, params.uri);
      if ("error" in route) return err(-32602, route.error);
      if (!ctx.isServerFull(route.serverId)) {
        return err(-32602, `unauthorized resource: ${params.uri}`);
      }
      try {
        return ok(await route.client.readResource(route.name));
      } catch (e: any) {
        return err(-32603, e?.message || "resource read failed");
      }
    }

    default:
      return err(-32601, `method not found: ${method}`);
  }
}

type Route =
  | { serverId: string; name: string; client: NonNullable<ReturnType<McpController["getClient"]>> }
  | { error: string };

function resolve(ctx: GatewayCtx, qualified: unknown): Route {
  if (typeof qualified !== "string") return { error: "missing name/uri" };
  const parsed = parseNs(qualified);
  if (!parsed) return { error: `unqualified name: ${qualified}` };
  if (!ctx.allowedServerIds.includes(parsed.serverId)) {
    return { error: `unauthorized or unknown category: ${parsed.serverId}` };
  }
  const client = ctx.controller.getClient(parsed.serverId);
  if (!client) return { error: `unknown server: ${parsed.serverId}` };
  return { serverId: parsed.serverId, name: parsed.name, client };
}

/** Fan out over the caller's allowed upstreams; skip any that error (unhealthy
 *  upstream must not break the whole aggregated list). */
async function aggregate<T>(
  ctx: GatewayCtx,
  fn: (serverId: string, client: NonNullable<ReturnType<McpController["getClient"]>>) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (const sid of ctx.allowedServerIds) {
    const client = ctx.controller.getClient(sid);
    if (!client) continue;
    try {
      out.push(...(await fn(sid, client)));
    } catch {
      /* skip unhealthy upstream */
    }
  }
  return out;
}
