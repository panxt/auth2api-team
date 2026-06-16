import fs from "fs";
import path from "path";
import type { StatsEvent } from "../stats/recorder";
import type { ApiKeyEntry } from "../config";
import {
  StatsAppender,
  replayStatsEvents,
  statsFilePath,
} from "../stats/storage";
import {
  EventLog,
  KeyRepository,
  normalizeKeyEntry,
  RequestLogStore,
  RequestLogRecord,
  RequestLogFilter,
  RequestLogPage,
  SettingsStore,
} from "./types";

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

/** SettingsStore backed by a single settings.json object file. */
export class FileSettingsStore implements SettingsStore {
  private filePath: string;
  constructor(authDir: string) {
    this.filePath = path.join(authDir, "settings.json");
  }
  private readAll(): Record<string, unknown> {
    if (!fs.existsSync(this.filePath)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.filePath, "utf-8")) ?? {};
    } catch {
      return {};
    }
  }
  get<T = unknown>(key: string): T | null {
    const all = this.readAll();
    return (all[key] as T) ?? null;
  }
  set(key: string, value: unknown): void {
    const all = this.readAll();
    all[key] = value;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.filePath, JSON.stringify(all, null, 2), { mode: 0o600 });
  }
}

/**
 * RequestLogStore backed by rolling daily JSONL files (`requests-YYYY-MM-DD.jsonl`).
 * The fallback backend — query is a newest-first linear scan over the relevant
 * day files with an offset cursor; sqlite is preferred for heavy log use.
 */
export class FileRequestLogStore implements RequestLogStore {
  private authDir: string;
  constructor(authDir: string) {
    this.authDir = authDir;
  }
  private fileFor(date: string): string {
    return path.join(this.authDir, `requests-${date}.jsonl`);
  }
  private dayFiles(): { date: string; file: string }[] {
    if (!fs.existsSync(this.authDir)) return [];
    return fs
      .readdirSync(this.authDir)
      .map((f) => /^requests-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ date: m[1], file: path.join(this.authDir, m[0]) }))
      .sort((a, b) => b.date.localeCompare(a.date)); // newest first
  }

  append(rec: RequestLogRecord): void {
    const date = rec.ts.slice(0, 10);
    fs.mkdirSync(this.authDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.fileFor(date), JSON.stringify(rec) + "\n", {
      mode: 0o600,
    });
  }

  query(filter: RequestLogFilter): RequestLogPage {
    const skip = typeof filter.cursor === "number" ? filter.cursor : 0;
    const sinceDate = filter.since?.slice(0, 10);
    const untilDate = filter.until?.slice(0, 10);
    const match = (r: RequestLogRecord): boolean => {
      if (filter.status && r.status !== filter.status) return false;
      if (filter.category && r.category !== filter.category) return false;
      if (filter.email && r.accountEmail !== filter.email) return false;
      if (filter.model && r.model !== filter.model) return false;
      if (filter.endpoint && r.endpoint !== filter.endpoint) return false;
      if (filter.provider && r.provider !== filter.provider) return false;
      if (filter.apiKeyPrefix && !r.apiKeyHash.startsWith(filter.apiKeyPrefix))
        return false;
      if (filter.since && r.ts < filter.since) return false;
      if (filter.until && r.ts > filter.until) return false;
      if (filter.q && !(r.errorDetail ?? "").toLowerCase().includes(filter.q.toLowerCase()))
        return false;
      return true;
    };

    const matched: RequestLogRecord[] = [];
    let seen = 0;
    const want = skip + filter.limit + 1; // +1 to detect "more"
    outer: for (const { date, file } of this.dayFiles()) {
      if (sinceDate && date < sinceDate) break; // files are newest-first
      if (untilDate && date > untilDate) continue;
      let lines: string[];
      try {
        lines = fs.readFileSync(file, "utf-8").split("\n");
      } catch {
        continue;
      }
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        let rec: RequestLogRecord;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (!match(rec)) continue;
        matched.push(rec);
        if (++seen >= want) break outer;
      }
    }

    const page = matched.slice(skip, skip + filter.limit);
    const hasMore = matched.length > skip + filter.limit;
    return {
      rows: page.map((r, i) => ({ ...r, id: skip + i })),
      nextCursor: hasMore ? skip + filter.limit : null,
    };
  }

  prune(opts: { maxAgeDays?: number; maxRows?: number }): number {
    // File backend prunes whole day files by age; row caps are sqlite-only.
    const maxAge = opts.maxAgeDays ?? 0;
    if (maxAge <= 0) return 0;
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - maxAge);
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    let removed = 0;
    for (const { date, file } of this.dayFiles()) {
      if (date < cutoffDate) {
        try {
          fs.rmSync(file, { force: true });
          removed++;
        } catch {
          /* ignore */
        }
      }
    }
    return removed; // count of files removed (not rows) for the file backend
  }
}
