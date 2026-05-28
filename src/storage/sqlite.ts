import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import type { StatsEvent } from "../stats/recorder";
import type { ApiKeyEntry } from "../config";
import { EventLog, KeyRepository, Storage, normalizeKeyEntry } from "./types";

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
    `);
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
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
