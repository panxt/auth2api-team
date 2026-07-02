import { get, post, put, del } from "./client";

export type McpTransport = "streamable-http" | "sse";

export interface McpHealth {
  status: "connected" | "connecting" | "error" | "disabled";
  toolCount: number | null;
  resourceCount: number | null;
  promptCount: number | null;
  lastError: string | null;
  lastConnectedAt: string | null;
}

export interface McpServerView {
  id: string;
  label: string;
  transport: McpTransport;
  url: string;
  headerKeys: string[]; // names only — values never returned
  enabled: boolean;
  health: McpHealth;
}

export interface McpServerInput {
  id?: string;
  label?: string;
  transport?: McpTransport;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export const fetchMcpServers = () =>
  get<{ servers: McpServerView[]; generated_at: string }>("/admin/mcp/servers");

export const createMcpServer = (input: McpServerInput) =>
  post<McpServerView>("/admin/mcp/servers", input);

export const updateMcpServer = (id: string, patch: McpServerInput) =>
  put<McpServerView>(`/admin/mcp/servers/${encodeURIComponent(id)}`, patch);

export const deleteMcpServer = (id: string) =>
  del<void>(`/admin/mcp/servers/${encodeURIComponent(id)}`);

export const probeMcpServer = (id: string) =>
  post<McpServerView>(`/admin/mcp/servers/${encodeURIComponent(id)}/probe`);
