import { ApiKeyEntry, generateApiKey } from "../config";
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
  quota?: ApiKeyEntry["quota"];
  "rate-limit"?: ApiKeyEntry["rate-limit"];
}

/** A key as shown to the UI — never includes the raw secret, only its id. */
export interface KeyView {
  id: string; // hashApiKey(key).slice(0, 12)
  source: "config" | "managed";
  label: string | null;
  owner: string | null;
  enabled: boolean;
  admin: boolean;
  quota: ApiKeyEntry["quota"] | null;
  "rate-limit": ApiKeyEntry["rate-limit"] | null;
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
    admin: v.admin ?? false,
    quota: v.quota,
    "rate-limit": v["rate-limit"],
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
    quota: entry.quota ?? null,
    "rate-limit": entry["rate-limit"] ?? null,
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
    const entry: ApiKeyEntry = {
      key,
      label: input.label,
      owner: input.owner,
      enabled: input.enabled ?? true,
      admin: input.admin ?? false,
      quota: input.quota,
      "rate-limit": input["rate-limit"],
    };
    this.managed.set(key, entry);
    this.live.set(key, entry);
    this.persist();
    return entry;
  }

  /** Patch a managed key by id. Config-sourced keys are read-only. */
  update(id: string, patch: KeyInput): KeyView {
    const entry = this.findManaged(id);
    if (patch.label !== undefined) entry.label = patch.label;
    if (patch.owner !== undefined) entry.owner = patch.owner;
    if (patch.enabled !== undefined) entry.enabled = patch.enabled;
    if (patch.admin !== undefined) entry.admin = patch.admin;
    if (patch.quota !== undefined) entry.quota = patch.quota;
    if (patch["rate-limit"] !== undefined) entry["rate-limit"] = patch["rate-limit"];
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
