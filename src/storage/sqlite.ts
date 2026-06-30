import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import type { StatsEvent } from "../stats/recorder";
import type { ApiKeyEntry } from "../config";
import {
  EventLog,
  KeyRepository,
  Storage,
  normalizeKeyEntry,
  RequestLogStore,
  RequestLogRecord,
  RequestLogFilter,
  RequestLogPage,
  PrewarmRunStore,
  PrewarmRunRecord,
  PrewarmRunPage,
  SettingsStore,
} from "./types";

/**
 * Single SQLite database (better-sqlite3, synchronous) holding usage events
 * and managed keys. Events are stored as a JSON blob plus a `ts` column for
 * ordering — replay reconstructs the exact StatsEvent, while json_extract()
 * remains available for ad-hoc SQL later. WAL mode keeps reads/writes from
 * blocking each other.
 */
export class SqliteStorage implements Storage {
  private db: Database.Database;
  readonly eventLog: EventLog;
  readonly keyRepo: KeyRepository;
  readonly requestLog: RequestLogStore;
  readonly prewarmLog: PrewarmRunStore;
  readonly settings: SettingsStore;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);
      CREATE TABLE IF NOT EXISTS managed_keys (
        key TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        api_key_hash TEXT,
        ip TEXT,
        endpoint TEXT,
        model TEXT,
        provider TEXT,
        account_email TEXT,
        status TEXT,
        status_code INTEGER,
        failure_kind TEXT,
        category TEXT,
        latency_ms INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        error_detail TEXT,
        request_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_rl_ts ON request_logs(ts);
      CREATE INDEX IF NOT EXISTS idx_rl_status ON request_logs(status);
      CREATE INDEX IF NOT EXISTS idx_rl_account ON request_logs(account_email);
      CREATE INDEX IF NOT EXISTS idx_rl_key ON request_logs(api_key_hash);
      CREATE INDEX IF NOT EXISTS idx_rl_model ON request_logs(model);
      CREATE TABLE IF NOT EXISTS prewarm_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        trigger TEXT,
        ok INTEGER,
        total INTEGER,
        providers TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pw_at ON prewarm_runs(at);
    `);
    // Migration: add `category` to a pre-existing request_logs table (older
    // installs created before the column existed). CREATE TABLE IF NOT EXISTS
    // won't alter an existing table, so add the column when missing.
    {
      const cols = this.db
        .prepare("PRAGMA table_info(request_logs)")
        .all() as { name: string }[];
      if (!cols.some((c) => c.name === "category")) {
        this.db.exec("ALTER TABLE request_logs ADD COLUMN category TEXT");
      }
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_rl_category ON request_logs(category)",
    );
    // The DB file itself holds secrets (managed keys) — lock it down.
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      /* best effort */
    }

    const insertEvent = this.db.prepare(
      "INSERT INTO usage_events (ts, data) VALUES (?, ?)",
    );
    const selectEvents = this.db.prepare(
      "SELECT data FROM usage_events ORDER BY id ASC",
    );

    this.eventLog = {
      append: (event: StatsEvent) => {
        insertEvent.run(event.ts, JSON.stringify(event));
      },
      replay: (apply) => {
        let events = 0;
        let skipped = 0;
        for (const row of selectEvents.iterate() as IterableIterator<{
          data: string;
        }>) {
          try {
            const ev = JSON.parse(row.data);
            if (ev && ev.v === 1) {
              apply(ev as StatsEvent);
              events++;
            } else {
              skipped++;
            }
          } catch {
            skipped++;
          }
        }
        return { events, skipped };
      },
      close: async () => {
        /* shared db closed by SqliteStorage.close() */
      },
    };

    const selectKeys = this.db.prepare("SELECT data FROM managed_keys");
    const deleteAllKeys = this.db.prepare("DELETE FROM managed_keys");
    const insertKey = this.db.prepare(
      "INSERT INTO managed_keys (key, data) VALUES (?, ?)",
    );
    const replaceAllKeys = this.db.transaction((entries: ApiKeyEntry[]) => {
      deleteAllKeys.run();
      for (const e of entries) insertKey.run(e.key, JSON.stringify(e));
    });

    this.keyRepo = {
      loadAll: () => {
        const rows = selectKeys.all() as { data: string }[];
        const out: ApiKeyEntry[] = [];
        for (const row of rows) {
          try {
            const entry = normalizeKeyEntry(JSON.parse(row.data));
            if (entry) out.push(entry);
          } catch {
            /* skip corrupt row */
          }
        }
        return out;
      },
      replaceAll: (entries: ApiKeyEntry[]) => replaceAllKeys(entries),
    };

    // ── Settings (key → JSON) ──
    const getSetting = this.db.prepare(
      "SELECT value FROM app_settings WHERE key = ?",
    );
    const upsertSetting = this.db.prepare(
      "INSERT INTO app_settings (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    this.settings = {
      get: <T = unknown>(key: string): T | null => {
        const row = getSetting.get(key) as { value: string } | undefined;
        if (!row) return null;
        try {
          return JSON.parse(row.value) as T;
        } catch {
          return null;
        }
      },
      set: (key: string, value: unknown) => {
        upsertSetting.run(key, JSON.stringify(value));
      },
    };

    // ── Request logs ──
    const insertLog = this.db.prepare(
      `INSERT INTO request_logs
        (ts, api_key_hash, ip, endpoint, model, provider, account_email,
         status, status_code, failure_kind, category, latency_ms, input_tokens,
         output_tokens, error_detail, request_id)
       VALUES (@ts, @apiKeyHash, @ip, @endpoint, @model, @provider,
         @accountEmail, @status, @statusCode, @failureKind, @category, @latencyMs,
         @inputTokens, @outputTokens, @errorDetail, @requestId)`,
    );
    this.requestLog = {
      append: (rec: RequestLogRecord) => {
        insertLog.run(rec as any);
      },
      query: (filter: RequestLogFilter): RequestLogPage => {
        const where: string[] = [];
        const params: any[] = [];
        if (filter.cursor != null) {
          where.push("id < ?");
          params.push(filter.cursor);
        }
        if (filter.status) {
          where.push("status = ?");
          params.push(filter.status);
        }
        if (filter.category) {
          where.push("category = ?");
          params.push(filter.category);
        }
        if (filter.email) {
          where.push("account_email = ?");
          params.push(filter.email);
        }
        if (filter.model) {
          where.push("model = ?");
          params.push(filter.model);
        }
        if (filter.endpoint) {
          where.push("endpoint = ?");
          params.push(filter.endpoint);
        }
        if (filter.provider) {
          where.push("provider = ?");
          params.push(filter.provider);
        }
        if (filter.apiKeyPrefix) {
          where.push("api_key_hash LIKE ?");
          params.push(`${filter.apiKeyPrefix}%`);
        }
        if (filter.apiKeyHashes) {
          if (filter.apiKeyHashes.length === 0) {
            where.push("0"); // matches nothing
          } else {
            where.push(
              `api_key_hash IN (${filter.apiKeyHashes.map(() => "?").join(",")})`,
            );
            params.push(...filter.apiKeyHashes);
          }
        }
        if (filter.since) {
          where.push("ts >= ?");
          params.push(filter.since);
        }
        if (filter.until) {
          where.push("ts <= ?");
          params.push(filter.until);
        }
        if (filter.q) {
          where.push("error_detail LIKE ?");
          params.push(`%${filter.q}%`);
        }
        const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
        // Fetch limit+1 to detect whether older rows remain.
        const rows = this.db
          .prepare(
            `SELECT * FROM request_logs ${clause} ORDER BY id DESC LIMIT ?`,
          )
          .all(...params, filter.limit + 1) as any[];
        const hasMore = rows.length > filter.limit;
        const page = rows.slice(0, filter.limit);
        return {
          rows: page.map((r) => ({
            id: r.id,
            ts: r.ts,
            apiKeyHash: r.api_key_hash,
            ip: r.ip,
            endpoint: r.endpoint,
            model: r.model,
            provider: r.provider,
            accountEmail: r.account_email,
            status: r.status,
            statusCode: r.status_code,
            failureKind: r.failure_kind,
            category: r.category ?? "service",
            latencyMs: r.latency_ms,
            inputTokens: r.input_tokens,
            outputTokens: r.output_tokens,
            errorDetail: r.error_detail,
            requestId: r.request_id,
          })),
          nextCursor: hasMore ? page[page.length - 1].id : null,
        };
      },
      prune: (opts: { maxAgeDays?: number; maxRows?: number }): number => {
        let removed = 0;
        if (opts.maxAgeDays && opts.maxAgeDays > 0) {
          const cutoff = new Date();
          cutoff.setUTCDate(cutoff.getUTCDate() - opts.maxAgeDays);
          const info = this.db
            .prepare("DELETE FROM request_logs WHERE ts < ?")
            .run(cutoff.toISOString());
          removed += info.changes;
        }
        if (opts.maxRows && opts.maxRows > 0) {
          // Keep the newest maxRows ids; delete everything older.
          const info = this.db
            .prepare(
              `DELETE FROM request_logs WHERE id <= (
                 SELECT id FROM request_logs ORDER BY id DESC LIMIT 1 OFFSET ?
               )`,
            )
            .run(opts.maxRows);
          removed += info.changes;
        }
        return removed;
      },
    };

    // ── Prewarm run history ──
    const insertPrewarm = this.db.prepare(
      `INSERT INTO prewarm_runs (at, trigger, ok, total, providers)
       VALUES (@at, @trigger, @ok, @total, @providers)`,
    );
    this.prewarmLog = {
      append: (rec: PrewarmRunRecord) => {
        insertPrewarm.run({
          at: rec.at,
          trigger: rec.trigger,
          ok: rec.ok,
          total: rec.total,
          providers: JSON.stringify(rec.providers ?? []),
        });
      },
      list: ({ limit, cursor }): PrewarmRunPage => {
        const where = cursor != null ? "WHERE id < ?" : "";
        const params: any[] = cursor != null ? [cursor] : [];
        const rows = this.db
          .prepare(
            `SELECT * FROM prewarm_runs ${where} ORDER BY id DESC LIMIT ?`,
          )
          .all(...params, limit + 1) as any[];
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        return {
          rows: page.map((r) => ({
            id: r.id,
            at: r.at,
            trigger: r.trigger,
            ok: r.ok,
            total: r.total,
            providers: safeParse(r.providers),
          })),
          nextCursor: hasMore ? page[page.length - 1].id : null,
        };
      },
      prune: ({ maxRows }): number => {
        if (!maxRows || maxRows <= 0) return 0;
        const info = this.db
          .prepare(
            `DELETE FROM prewarm_runs WHERE id <= (
               SELECT id FROM prewarm_runs ORDER BY id DESC LIMIT 1 OFFSET ?
             )`,
          )
          .run(maxRows);
        return info.changes;
      },
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

function safeParse(s: unknown): unknown {
  if (typeof s !== "string") return [];
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
}
