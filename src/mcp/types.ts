/**
 * MCP aggregation gateway — shared types.
 *
 * auth2api registers N upstream MCP servers (each a "category"), aggregates
 * their tools/resources/prompts behind ONE MCP endpoint, and gates access
 * per-key. Registry is managed entirely via the Web UI and persisted to the
 * SettingsStore (key "mcp") — NOT config.yaml.
 */

/** Transport used to reach an upstream MCP server. `stdio` is deferred. */
export type McpTransport = "streamable-http" | "sse";

/** One registered upstream MCP server (a selectable "category"). */
export interface McpServerConfig {
  /** Namespace prefix + authorization unit. Immutable after create. */
  id: string;
  label: string;
  transport: McpTransport;
  url: string;
  /** Upstream auth headers (SECRET — stored in SettingsStore, never returned raw). */
  headers?: Record<string, string>;
  enabled: boolean;
}

/** Live connection health for one upstream. */
export interface McpHealth {
  status: "connected" | "connecting" | "error" | "disabled";
  toolCount: number | null;
  resourceCount: number | null;
  promptCount: number | null;
  lastError: string | null;
  lastConnectedAt: string | null;
}

/** Redacted view for the admin API / UI — header VALUES never leave the server. */
export interface McpServerView {
  id: string;
  label: string;
  transport: McpTransport;
  url: string;
  /** Header names only (values masked). */
  headerKeys: string[];
  enabled: boolean;
  health: McpHealth;
}

/** Body accepted by the admin create/update endpoints. */
export interface McpServerInput {
  id?: string;
  label?: string;
  transport?: McpTransport;
  url?: string;
  /** When present, replaces the stored headers; when absent on update, kept. */
  headers?: Record<string, string>;
  enabled?: boolean;
}
