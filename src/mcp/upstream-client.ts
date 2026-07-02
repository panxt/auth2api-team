import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpServerConfig, McpHealth } from "./types";

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;

/**
 * One connection to an upstream MCP server. Lazily connects on first use,
 * caches capability counts for the dashboard, and degrades gracefully:
 * resources/prompts are optional MCP capabilities, so those lists return []
 * (not throw) when the upstream doesn't support them.
 */
export class UpstreamMcpClient {
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;
  private health: McpHealth;

  constructor(public readonly config: McpServerConfig) {
    this.health = {
      status: config.enabled ? "connecting" : "disabled",
      toolCount: null,
      resourceCount: null,
      promptCount: null,
      lastError: null,
      lastConnectedAt: null,
    };
  }

  getHealth(): McpHealth {
    return { ...this.health };
  }

  private buildTransport() {
    const url = new URL(this.config.url);
    const requestInit = this.config.headers
      ? { headers: this.config.headers }
      : undefined;
    return this.config.transport === "sse"
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit });
  }

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) this.connecting = this.doConnect();
    await this.connecting;
    if (!this.client) {
      throw new Error(this.health.lastError || "MCP upstream not connected");
    }
    return this.client;
  }

  private async doConnect(): Promise<void> {
    this.health.status = "connecting";
    try {
      const client = new Client(
        { name: "auth2api-gateway", version: "1.0.0" },
        { capabilities: {} },
      );
      await client.connect(this.buildTransport(), { timeout: CONNECT_TIMEOUT_MS });
      this.client = client;
      this.health.status = "connected";
      this.health.lastConnectedAt = new Date().toISOString();
      this.health.lastError = null;
    } catch (err: any) {
      this.health.status = "error";
      this.health.lastError = err?.message || String(err);
      this.client = null;
    } finally {
      this.connecting = null;
    }
  }

  async listTools() {
    const c = await this.ensureConnected();
    const r = await c.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
    this.health.toolCount = r.tools?.length ?? 0;
    return r.tools ?? [];
  }

  async listResources() {
    try {
      const c = await this.ensureConnected();
      const r = await c.listResources(undefined, { timeout: CALL_TIMEOUT_MS });
      this.health.resourceCount = r.resources?.length ?? 0;
      return r.resources ?? [];
    } catch {
      this.health.resourceCount = this.health.resourceCount ?? 0;
      return [];
    }
  }

  async listPrompts() {
    try {
      const c = await this.ensureConnected();
      const r = await c.listPrompts(undefined, { timeout: CALL_TIMEOUT_MS });
      this.health.promptCount = r.prompts?.length ?? 0;
      return r.prompts ?? [];
    } catch {
      this.health.promptCount = this.health.promptCount ?? 0;
      return [];
    }
  }

  async callTool(name: string, args: unknown) {
    const c = await this.ensureConnected();
    return c.callTool(
      { name, arguments: (args ?? {}) as Record<string, unknown> },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    );
  }

  async readResource(uri: string) {
    const c = await this.ensureConnected();
    return c.readResource({ uri }, { timeout: CALL_TIMEOUT_MS });
  }

  async getPrompt(name: string, args: unknown) {
    const c = await this.ensureConnected();
    return c.getPrompt(
      { name, arguments: (args ?? {}) as Record<string, string> },
      { timeout: CALL_TIMEOUT_MS },
    );
  }

  /** Force a connect + refresh capability counts for the dashboard. */
  async probe(): Promise<McpHealth> {
    if (!this.config.enabled) {
      this.health.status = "disabled";
      return this.getHealth();
    }
    try {
      await this.listTools();
      await this.listResources();
      await this.listPrompts();
    } catch {
      /* health.lastError already set by doConnect/listTools */
    }
    return this.getHealth();
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.connecting = null;
    this.health.status = this.config.enabled ? "connecting" : "disabled";
  }
}
