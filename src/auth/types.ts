export type ProviderId = "anthropic" | "codex" | "cursor";

export interface PKCECodes {
  codeVerifier: string;
  codeChallenge: string;
}

export interface TokenData {
  accessToken: string;
  refreshToken: string;
  email: string;
  expiresAt: string; // ISO 8601
  accountUuid: string; // anthropic: data.account.uuid; codex: chatgpt_account_id
  provider?: ProviderId; // missing on legacy files → treated as "anthropic"
  idToken?: string; // codex only
  /** ISO 8601 of last successful refresh (or initial token issuance). */
  lastRefreshAt?: string;
  /** Codex only — raw chatgpt_plan_type claim from id_token (free/plus/pro/…). */
  planType?: string;
  /** Cursor only — stable machine id read from Cursor's local storage. */
  cursorServiceMachineId?: string;
  /** Cursor only — client version accepted by Cursor's internal API. */
  cursorClientVersion?: string;
  /** Cursor only — config version header value. */
  cursorConfigVersion?: string;
  /** Cursor only — OAuth client id used for refresh. */
  cursorClientId?: string;
  /** Cursor only — membership tier from Cursor local storage. */
  cursorMembershipType?: string;
  /** Operator flag — when true the account is kept loaded but skipped by
   *  `getNextAccount()` / `getAvailableAccount()` (no traffic, no refresh).
   *  Toggled via PATCH /admin/accounts/:provider/:email. */
  disabled?: boolean;
  /** Display-only monthly budget (USD) for this upstream account — the
   *  account page shows month-to-date cost against it as a progress bar.
   *  Set via PATCH /admin/accounts/:provider/:email. */
  monthlyBudgetUsd?: number;
  /** Display-only tier label, e.g. "$25" / "$125" / "Max". */
  tierLabel?: string;
  /** Load-balancing weight (default 1). Higher = takes proportionally more
   *  concurrent traffic under weighted-least-inflight scheduling. Lets a
   *  bigger-tier account ($125) carry more than a smaller one ($25). */
  concurrencyWeight?: number;
}

export interface TokenStorage {
  access_token: string;
  refresh_token: string;
  last_refresh: string;
  email: string;
  type: ProviderId | "claude"; // "claude" retained for legacy files
  expired: string; // ISO 8601
  account_uuid?: string;
  id_token?: string;
  plan_type?: string;
  cursor_service_machine_id?: string;
  cursor_client_version?: string;
  cursor_config_version?: string;
  cursor_client_id?: string;
  cursor_membership_type?: string;
  disabled?: boolean;
  monthly_budget_usd?: number;
  tier_label?: string;
  concurrency_weight?: number;
}
