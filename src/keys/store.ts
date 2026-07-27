import { ApiKeyEntry, KeyRole, generateApiKey, DailyOverride } from "../config";
import { hashApiKey } from "../utils/common";
import type { KeyRepository } from "../storage/types";

/**
 * Runtime-managed API keys. Keys created/edited through the admin UI are
 * persisted via the configured KeyRepository (SQLite table or
 * managed-keys.json) — kept separate from config.yaml so the hand-written
 * YAML (and its comments) is never rewritten. At startup the managed keys are
 * merged into the live config map (managed wins on conflict); config.yaml keys
 * remain read-only from the UI's perspective so a delete can't be silently
 * resurrected by the next restart.
 */

/** Fields the UI may set when creating or editing a key. */
export interface KeyInput {
  label?: string;
  owner?: string;
  enabled?: boolean;
  admin?: boolean;
  role?: KeyRole;
  // null explicitly clears a previously-set quota.
  quota?: ApiKeyEntry["quota"] | null;
  "rate-limit"?: ApiKeyEntry["rate-limit"];
  "allowed-models"?: ApiKeyEntry["allowed-models"];
  "denied-models"?: ApiKeyEntry["denied-models"];
  "allowed-mcp"?: ApiKeyEntry["allowed-mcp"];
  "expires-at"?: ApiKeyEntry["expires-at"] | null;
  "mcp-quota"?: ApiKeyEntry["mcp-quota"] | null;
}

/** A key as shown to the UI — never includes the raw secret, only its id. */
export interface KeyView {
  id: string; // hashApiKey(key).slice(0, 12)
  source: "config" | "managed";
  label: string | null;
  owner: string | null;
  enabled: boolean;
  admin: boolean;
  role: KeyRole;
  quota: ApiKeyEntry["quota"] | null;
  "rate-limit": ApiKeyEntry["rate-limit"] | null;
  "allowed-models": ApiKeyEntry["allowed-models"] | null;
  "denied-models": ApiKeyEntry["denied-models"] | null;
  "allowed-mcp": ApiKeyEntry["allowed-mcp"] | null;
  "expires-at": ApiKeyEntry["expires-at"] | null;
  "mcp-quota": ApiKeyEntry["mcp-quota"] | null;
  "daily-override": ApiKeyEntry["daily-override"] | null;
}

function keyId(key: string): string {
  return hashApiKey(key).slice(0, 12);
}

function isValidEntry(v: any): v is ApiKeyEntry {
  return v && typeof v.key === "string";
}

function normalizeEntry(v: any): ApiKeyEntry {
  return {
    key: v.key,
    label: v.label,
    owner: v.owner,
    enabled: v.enabled ?? true,
    admin: v.role ? v.role === "admin" : (v.admin ?? false),
    role: v.role,
    quota: v.quota,
    "rate-limit": v["rate-limit"],
    "allowed-models": v["allowed-models"],
    "denied-models": v["denied-models"],
    "allowed-mcp": v["allowed-mcp"],
    "expires-at": v["expires-at"],
    "mcp-quota": v["mcp-quota"],
    "daily-override": v["daily-override"],
  };
}

function toView(entry: ApiKeyEntry, source: "config" | "managed"): KeyView {
  return {
    id: keyId(entry.key),
    source,
    label: entry.label ?? null,
    owner: entry.owner ?? null,
    enabled: entry.enabled,
    admin: entry.admin,
    role: entry.role ?? (entry.admin ? "admin" : "member"),
    quota: entry.quota ?? null,
    "rate-limit": entry["rate-limit"] ?? null,
    "allowed-models": entry["allowed-models"] ?? null,
    "denied-models": entry["denied-models"] ?? null,
    "allowed-mcp": entry["allowed-mcp"] ?? null,
    "expires-at": entry["expires-at"] ?? null,
    "mcp-quota": entry["mcp-quota"] ?? null,
    "daily-override": entry["daily-override"] ?? null,
  };
}

export class ManagedKeyError extends Error {
  constructor(
    public code: "not_found" | "read_only" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

export class ManagedKeyStore {
  private repo: KeyRepository;
  /** The live map shared with the running server (config["api-keys"]). */
  private live: Map<string, ApiKeyEntry>;
  /** Keys owned by this store (subset of `live`), keyed by raw key. */
  private managed = new Map<string, ApiKeyEntry>();

  constructor(repo: KeyRepository, live: Map<string, ApiKeyEntry>) {
    this.repo = repo;
    this.live = live;
  }

  /** Load managed keys and merge into the live map (managed overrides). */
  load(): void {
    for (const raw of this.repo.loadAll()) {
      if (!isValidEntry(raw)) continue;
      const entry = normalizeEntry(raw);
      this.managed.set(entry.key, entry);
      this.live.set(entry.key, entry);
    }
  }

  /** All keys (config + managed) as redacted views. */
  list(): KeyView[] {
    const views: KeyView[] = [];
    for (const entry of this.live.values()) {
      views.push(toView(entry, this.managed.has(entry.key) ? "managed" : "config"));
    }
    return views;
  }

  /**
   * Create a new managed key. Returns the entry WITH its raw key — the only
   * time the secret is exposed; callers must surface it to the operator once.
   */
  create(input: KeyInput): ApiKeyEntry {
    const key = generateApiKey();
    const role: KeyRole =
      input.role ?? (input.admin ? "admin" : "member");
    const entry: ApiKeyEntry = {
      key,
      label: input.label,
      owner: input.owner,
      enabled: input.enabled ?? true,
      admin: role === "admin",
      role,
      quota: input.quota ?? undefined,
      "rate-limit": input["rate-limit"],
      "allowed-models": input["allowed-models"],
      "denied-models": input["denied-models"],
      "allowed-mcp": input["allowed-mcp"],
      "expires-at": input["expires-at"] ?? undefined,
      "mcp-quota": input["mcp-quota"] ?? undefined,
    };
    this.managed.set(key, entry);
    this.live.set(key, entry);
    this.persist();
    return entry;
  }

  /**
   * Rotate a managed key by id: issue a NEW secret carrying the same metadata
   * (label/owner/role/quota/limits), drop the old one. Returns the new entry
   * WITH its raw key (surface once). Self-service "reset my key" uses this.
   * Config-sourced keys can't be rotated (read-only).
   */
  rotate(id: string): ApiKeyEntry {
    const old = this.findManaged(id);
    const fresh = generateApiKey();
    const entry: ApiKeyEntry = { ...old, key: fresh };
    this.managed.delete(old.key);
    this.live.delete(old.key);
    this.managed.set(fresh, entry);
    this.live.set(fresh, entry);
    this.persist();
    return entry;
  }

  /** Patch a managed key by id. Config-sourced keys are read-only. */
  update(id: string, patch: KeyInput): KeyView {
    const entry = this.findManaged(id);
    if (patch.label !== undefined) entry.label = patch.label;
    if (patch.owner !== undefined) entry.owner = patch.owner;
    if (patch.enabled !== undefined) entry.enabled = patch.enabled;
    if (patch.role !== undefined) {
      entry.role = patch.role;
      entry.admin = patch.role === "admin";
    } else if (patch.admin !== undefined) {
      entry.admin = patch.admin;
      entry.role = patch.admin ? "admin" : "member";
    }
    // null clears the quota; an object replaces it; undefined leaves it as-is.
    if (patch.quota !== undefined) entry.quota = patch.quota ?? undefined;
    if (patch["rate-limit"] !== undefined) entry["rate-limit"] = patch["rate-limit"];
    if (patch["allowed-models"] !== undefined)
      entry["allowed-models"] = patch["allowed-models"];
    if (patch["denied-models"] !== undefined)
      entry["denied-models"] = patch["denied-models"];
    if (patch["allowed-mcp"] !== undefined)
      entry["allowed-mcp"] = patch["allowed-mcp"];
    if (patch["expires-at"] !== undefined)
      entry["expires-at"] = patch["expires-at"] ?? undefined;
    if (patch["mcp-quota"] !== undefined)
      entry["mcp-quota"] = patch["mcp-quota"] ?? undefined;
    this.live.set(entry.key, entry);
    this.persist();
    return toView(entry, "managed");
  }

  /** Set (or clear, with null) a key's one-day daily-cap override. Passing an
   *  override without a `date` stamps today (UTC) so it auto-reverts tomorrow.
   *  Config-sourced keys are read-only. */
  setDailyOverride(id: string, override: DailyOverride | null): KeyView {
    const entry = this.findManaged(id);
    if (override === null) {
      delete entry["daily-override"];
    } else {
      entry["daily-override"] = {
        date: override.date || new Date().toISOString().slice(0, 10),
        "daily-cost-usd": override["daily-cost-usd"],
        "daily-tokens": override["daily-tokens"],
      };
    }
    this.live.set(entry.key, entry);
    this.persist();
    return toView(entry, "managed");
  }

  /** Remove a managed key by id. Config-sourced keys are read-only. */
  delete(id: string): void {
    const entry = this.findManaged(id);
    this.managed.delete(entry.key);
    this.live.delete(entry.key);
    this.persist();
  }

  private findManaged(id: string): ApiKeyEntry {
    for (const entry of this.managed.values()) {
      if (keyId(entry.key) === id) return entry;
    }
    // Distinguish "exists but read-only" from "unknown" for a clearer 4xx.
    for (const entry of this.live.values()) {
      if (keyId(entry.key) === id) {
        throw new ManagedKeyError(
          "read_only",
          "This key comes from config.yaml and cannot be edited via the API; edit the file instead.",
        );
      }
    }
    throw new ManagedKeyError("not_found", `No key with id ${id}`);
  }

  private persist(): void {
    this.repo.replaceAll([...this.managed.values()]);
  }
}
