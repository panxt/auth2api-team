import fs from "fs";
import path from "path";
import { Config } from "../config";
import { Storage } from "./types";
import {
  FileEventLog,
  FileKeyRepository,
  FileRequestLogStore,
  FileSettingsStore,
} from "./file";

export { Storage, EventLog, KeyRepository } from "./types";

function fileStorage(authDir: string): Storage {
  const eventLog = new FileEventLog(authDir);
  const keyRepo = new FileKeyRepository(authDir);
  const requestLog = new FileRequestLogStore(authDir);
  const settings = new FileSettingsStore(authDir);
  return { eventLog, keyRepo, requestLog, settings, close: () => eventLog.close() };
}

/** Expand ~ and resolve a relative sqlite-path against authDir (not cwd). */
function resolveDbPath(sqlitePath: string | undefined, authDir: string): string {
  if (!sqlitePath) return path.join(authDir, "auth2api.db");
  let p = sqlitePath;
  if (p.startsWith("~")) p = path.join(process.env.HOME || "/root", p.slice(1));
  return path.isAbsolute(p) ? p : path.join(authDir, p);
}

/**
 * Open the configured storage backend. "sqlite" (default) returns a single
 * DB-backed Storage; "file" returns the JSONL + managed-keys.json pair. The
 * caller owns the returned Storage and must close() it on shutdown.
 *
 * better-sqlite3 is loaded lazily and only for the sqlite backend, so a file
 * deployment never touches the native module. If sqlite is selected but its
 * native module can't load (e.g. musl/Alpine, arch mismatch), we log a clear
 * error and fall back to the file backend rather than failing to boot — the
 * default backend is sqlite, so a hard crash here would take down everything.
 */
export async function openStorage(
  config: Config,
  authDir: string,
): Promise<Storage> {
  if (config.storage.backend === "file") {
    return fileStorage(authDir);
  }
  const dbPath = resolveDbPath(config.storage["sqlite-path"], authDir);
  try {
    const { SqliteStorage } = await import("./sqlite");
    return new SqliteStorage(dbPath);
  } catch (err: any) {
    console.error(
      `[storage] sqlite backend unavailable (${err?.message}); falling back to file backend`,
    );
    // Move aside a half-created db file so the file backend starts clean.
    if (fs.existsSync(dbPath)) {
      try {
        fs.rmSync(dbPath, { force: true });
      } catch {
        /* ignore */
      }
    }
    return fileStorage(authDir);
  }
}
