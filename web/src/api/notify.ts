import { get, put, post } from "./client";

export interface NotifyConfig {
  enabled: boolean;
  feishu: {
    "webhook-url": string;
    secret: string; // always returned masked ("")
  };
  alerts: {
    "quota-thresholds": number[];
    "account-down": boolean;
    "prewarm-fail": boolean;
    "mcp-probe-fail": boolean;
    "key-expiry": boolean;
    "pool-quota": boolean;
  };
  "expiry-warn-days": number;
  "pool-threshold": number;
  "dedup-minutes": number;
}

export const fetchNotifyConfig = () => get<NotifyConfig>("/admin/notify/config");

export const updateNotifyConfig = (patch: Partial<NotifyConfig>) =>
  put<NotifyConfig>("/admin/notify/config", patch);

export const testNotify = () => post<{ ok: boolean }>("/admin/notify/test");
