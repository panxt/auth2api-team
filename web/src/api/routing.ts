import { get, put } from "./client";

export interface RoutingConfig {
  strategy: "adaptive" | "weighted-least-inflight" | "sticky";
  "stick-while-inflight-below": number;
  "per-account-max-inflight": number;
  "use-5h-utilization": boolean;
}

export const fetchRoutingConfig = () =>
  get<RoutingConfig>("/admin/routing/config");

export const updateRoutingConfig = (patch: Partial<RoutingConfig>) =>
  put<RoutingConfig>("/admin/routing/config", patch);
