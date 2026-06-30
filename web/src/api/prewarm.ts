import { get, put } from "./client";
import type { PrewarmRecord } from "./accounts";

export interface PrewarmConfig {
  /** Master switch for the in-process scheduler. */
  enabled: boolean;
  /** Local-time trigger points, "HH:MM" (24h). Each fires once per day. */
  times: string[];
  /** Provider ids to prewarm; empty = every provider that supports it. */
  providers: string[];
}

export interface PrewarmRun {
  trigger: "schedule" | "manual";
  at: string;
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

export const fetchPrewarmHistory = () =>
  get<{ runs: PrewarmRun[] }>("/admin/prewarm/history");
