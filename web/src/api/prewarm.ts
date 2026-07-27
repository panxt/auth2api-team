import { get, put } from "./client";
import type { PrewarmRecord } from "./accounts";

export interface PrewarmConfig {
  /** Master switch for the in-process scheduler. */
  enabled: boolean;
  /** Local-time trigger points, "HH:MM" (24h). Each fires once per day. */
  times: string[];
  /** Provider ids to prewarm; empty = every provider that supports it. */
  providers: string[];
  /** IANA timezone the times are interpreted in; empty = server local. */
  timezone?: string;
}

export interface PrewarmRun {
  id?: number;
  trigger: "schedule" | "manual";
  at: string;
  scheduledTime: string | null;
  providers: Array<{
    provider: string;
    results: PrewarmRecord[];
    generated_at?: string;
    error?: string;
  }>;
  ok: number;
  total: number;
}

export const fetchPrewarmConfig = () =>
  get<PrewarmConfig>("/admin/prewarm/config");

export const updatePrewarmConfig = (patch: Partial<PrewarmConfig>) =>
  put<PrewarmConfig>("/admin/prewarm/config", patch);

export const fetchPrewarmHistory = (opts?: {
  limit?: number;
  cursor?: number | null;
}) => {
  const params = new URLSearchParams();
  params.set("limit", String(opts?.limit ?? 20));
  if (opts?.cursor != null) params.set("cursor", String(opts.cursor));
  return get<{ runs: PrewarmRun[]; nextCursor: number | null }>(
    `/admin/prewarm/history?${params.toString()}`,
  );
};
