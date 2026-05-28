import path from "path";
import { Config, resolveAuthDir } from "../config";
import { Storage } from "./types";
import { FileEventLog, FileKeyRepository } from "./file";
import { SqliteStorage } from "./sqlite";

export { Storage, EventLog, KeyRepository } from "./types";

/**
 * Open the configured storage backend. "sqlite" (default) returns a single
 * DB-backed Storage; "file" returns the JSONL + managed-keys.json pair. The
 * caller owns the returned Storage and must close() it on shutdown.
 */
export function openStorage(config: Config, authDir: string): Storage {
  if (config.storage.backend === "file") {
    const eventLog = new FileEventLog(authDir);
    const keyRepo = new FileKeyRepository(authDir);
    return { eventLog, keyRepo, close: () => eventLog.close() };
  }
  const dbPath = config.storage["sqlite-path"]
    ? resolveAuthDir(config.storage["sqlite-path"])
    : path.join(authDir, "auth2api.db");
  return new SqliteStorage(dbPath);
}
