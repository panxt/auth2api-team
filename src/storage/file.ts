import fs from "fs";
import path from "path";
import type { StatsEvent } from "../stats/recorder";
import type { ApiKeyEntry } from "../config";
import {
  StatsAppender,
  replayStatsEvents,
  statsFilePath,
} from "../stats/storage";
import { EventLog, KeyRepository, normalizeKeyEntry } from "./types";

/** EventLog backed by the legacy append-only stats.jsonl. */
export class FileEventLog implements EventLog {
  private appender: StatsAppender;
  private filePath: string;

  constructor(authDir: string) {
    this.filePath = statsFilePath(authDir);
    this.appender = new StatsAppender(this.filePath);
    this.appender.open();
  }

  append(event: StatsEvent): void {
    this.appender.append(event);
  }

  replay(apply: (event: StatsEvent) => void): { events: number; skipped: number } {
    const { lines, skipped } = replayStatsEvents(this.filePath, apply);
    return { events: lines - skipped, skipped };
  }

  close(): Promise<void> {
    return this.appender.close();
  }
}

const MANAGED_KEYS_FILENAME = "managed-keys.json";

/** KeyRepository backed by managed-keys.json. */
export class FileKeyRepository implements KeyRepository {
  private filePath: string;

  constructor(authDir: string) {
    this.filePath = path.join(authDir, MANAGED_KEYS_FILENAME);
  }

  loadAll(): ApiKeyEntry[] {
    if (!fs.existsSync(this.filePath)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
    } catch (err: any) {
      console.error(`[keys] failed to read ${this.filePath}: ${err?.message}`);
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeKeyEntry)
      .filter((e): e is ApiKeyEntry => e !== null);
  }

  replaceAll(entries: ApiKeyEntry[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.filePath, JSON.stringify(entries, null, 2), {
      mode: 0o600,
    });
  }
}
