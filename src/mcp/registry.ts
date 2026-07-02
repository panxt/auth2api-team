import type { SettingsStore } from "../storage/types";
import { UpstreamMcpClient } from "./upstream-client";
import type {
  McpServerConfig,
  McpServerInput,
  McpServerView,
  McpTransport,
} from "./types";

const SETTINGS_KEY = "mcp";
const TRANSPORTS: McpTransport[] = ["streamable-http", "sse"];
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export class McpError extends Error {
  constructor(
    public code: "not_found" | "conflict" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Owns the upstream MCP server registry: page-managed CRUD persisted to the
 * SettingsStore (key "mcp") — no config.yaml. Holds one UpstreamMcpClient per
 * server and hot-reconnects on change. Mirrors RoutingController's settings
 * model, generalized from a single config object to an array of servers.
 */
export class McpController {
  private servers: McpServerConfig[];
  private clients = new Map<string, UpstreamMcpClient>();

  constructor(private settings: SettingsStore) {
    const persisted = settings.get<{ servers?: unknown }>(SETTINGS_KEY);
    this.servers = normalizeServers(persisted?.servers);
    for (const s of this.servers) {
      this.clients.set(s.id, new UpstreamMcpClient(s));
    }
  }

  /** Best-effort connect of all enabled upstreams in the background. */
  start(): void {
    for (const s of this.servers) {
      if (s.enabled) this.clients.get(s.id)?.probe().catch(() => {});
    }
  }

  list(): McpServerView[] {
    return this.servers.map((s) => this.toView(s));
  }

  /** All registered server ids (for validating key grants). */
  ids(): string[] {
    return this.servers.map((s) => s.id);
  }

  /** Enabled server ids only. */
  enabledIds(): string[] {
    return this.servers.filter((s) => s.enabled).map((s) => s.id);
  }

  getClient(id: string): UpstreamMcpClient | undefined {
    return this.clients.get(id);
  }

  create(input: McpServerInput): McpServerView {
    const cfg = validateNew(input, this.servers);
    this.servers.push(cfg);
    this.clients.set(cfg.id, new UpstreamMcpClient(cfg));
    this.persist();
    if (cfg.enabled) this.clients.get(cfg.id)?.probe().catch(() => {});
    return this.toView(cfg);
  }

  update(id: string, patch: McpServerInput): McpServerView {
    const idx = this.servers.findIndex((s) => s.id === id);
    if (idx < 0) throw new McpError("not_found", `no MCP server "${id}"`);
    const next = validateUpdate(this.servers[idx], patch);
    this.servers[idx] = next;
    // Reconnect with the new config.
    void this.clients.get(id)?.close();
    this.clients.set(id, new UpstreamMcpClient(next));
    this.persist();
    if (next.enabled) this.clients.get(id)?.probe().catch(() => {});
    return this.toView(next);
  }

  remove(id: string): void {
    const idx = this.servers.findIndex((s) => s.id === id);
    if (idx < 0) throw new McpError("not_found", `no MCP server "${id}"`);
    this.servers.splice(idx, 1);
    void this.clients.get(id)?.close();
    this.clients.delete(id);
    this.persist();
  }

  /** Tool names + descriptions for one upstream (for the UI tool list + grant
   *  picker). Throws if the server is unknown; may throw if the upstream is
   *  unreachable (caller surfaces the error). */
  async tools(id: string): Promise<{ name: string; description?: string }[]> {
    const client = this.clients.get(id);
    if (!client) throw new McpError("not_found", `no MCP server "${id}"`);
    const list = await client.listTools();
    return list.map((t: any) => ({ name: t.name, description: t.description }));
  }

  async probe(id: string): Promise<McpServerView> {
    const client = this.clients.get(id);
    const cfg = this.servers.find((s) => s.id === id);
    if (!client || !cfg) throw new McpError("not_found", `no MCP server "${id}"`);
    await client.probe();
    return this.toView(cfg);
  }

  private toView(s: McpServerConfig): McpServerView {
    const health = this.clients.get(s.id)?.getHealth() ?? {
      status: s.enabled ? "connecting" : "disabled",
      toolCount: null,
      resourceCount: null,
      promptCount: null,
      lastError: null,
      lastConnectedAt: null,
    };
    return {
      id: s.id,
      label: s.label,
      transport: s.transport,
      url: s.url,
      headerKeys: Object.keys(s.headers ?? {}),
      enabled: s.enabled,
      health,
    };
  }

  private persist(): void {
    this.settings.set(SETTINGS_KEY, { servers: this.servers });
  }
}

/* ── validation / normalization ─────────────────────────────── */

function normalizeServers(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const s = item as Partial<McpServerConfig>;
    if (!s || typeof s.id !== "string" || !ID_RE.test(s.id) || s.id.includes("__") || seen.has(s.id)) continue;
    if (typeof s.url !== "string" || !s.url) continue;
    const transport = TRANSPORTS.includes(s.transport as McpTransport)
      ? (s.transport as McpTransport)
      : "streamable-http";
    seen.add(s.id);
    out.push({
      id: s.id,
      label: typeof s.label === "string" && s.label ? s.label : s.id,
      transport,
      url: s.url,
      headers:
        s.headers && typeof s.headers === "object"
          ? (s.headers as Record<string, string>)
          : undefined,
      enabled: s.enabled !== false,
    });
  }
  return out;
}

function validateShape(input: McpServerInput): {
  transport: McpTransport;
  url: string;
  headers?: Record<string, string>;
} {
  if (input.transport && !TRANSPORTS.includes(input.transport)) {
    throw new McpError("invalid", `transport must be one of ${TRANSPORTS.join(", ")}`);
  }
  if (input.url !== undefined) {
    try {
      // eslint-disable-next-line no-new
      new URL(input.url);
    } catch {
      throw new McpError("invalid", `invalid url "${input.url}"`);
    }
  }
  if (input.headers !== undefined) {
    if (typeof input.headers !== "object" || input.headers === null || Array.isArray(input.headers)) {
      throw new McpError("invalid", "headers must be an object of string values");
    }
    for (const v of Object.values(input.headers)) {
      if (typeof v !== "string") throw new McpError("invalid", "header values must be strings");
    }
  }
  return {
    transport: (input.transport as McpTransport) ?? "streamable-http",
    url: input.url as string,
    headers: input.headers,
  };
}

function validateNew(
  input: McpServerInput,
  existing: McpServerConfig[],
): McpServerConfig {
  if (!input.id || !ID_RE.test(input.id) || input.id.includes("__")) {
    throw new McpError(
      "invalid",
      "id required, lowercase [a-z0-9_-], starting alnum, ≤32 chars, no '__'",
    );
  }
  if (existing.some((s) => s.id === input.id)) {
    throw new McpError("conflict", `MCP server "${input.id}" already exists`);
  }
  if (!input.url) throw new McpError("invalid", "url required");
  const { transport, url, headers } = validateShape(input);
  return {
    id: input.id,
    label: input.label || input.id,
    transport,
    url,
    headers,
    enabled: input.enabled !== false,
  };
}

function validateUpdate(
  cur: McpServerConfig,
  patch: McpServerInput,
): McpServerConfig {
  if (patch.id !== undefined && patch.id !== cur.id) {
    throw new McpError("invalid", "id is immutable; delete and recreate to rename");
  }
  const shape = validateShape({ ...patch });
  return {
    id: cur.id,
    label: patch.label !== undefined ? patch.label || cur.id : cur.label,
    transport: patch.transport !== undefined ? shape.transport : cur.transport,
    url: patch.url !== undefined ? shape.url : cur.url,
    // headers: replace only when explicitly provided, else keep existing secret.
    headers: patch.headers !== undefined ? patch.headers : cur.headers,
    enabled: patch.enabled !== undefined ? patch.enabled : cur.enabled,
  };
}
