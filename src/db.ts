import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SCHEMA } from "./schema";

export function defaultDbPath(cwd = process.cwd()): string {
  if (process.env.AGENTCTL_DB) return resolve(process.env.AGENTCTL_DB);
  return join(cwd, ".agentctl", "state.db");
}

export function defaultSockPath(cwd = process.cwd()): string {
  if (process.env.AGENTCTL_SOCK) return resolve(process.env.AGENTCTL_SOCK);
  const dbPath = process.env.AGENTCTL_DB ? resolve(process.env.AGENTCTL_DB) : join(cwd, ".agentctl", "state.db");
  return join(dirname(dbPath), "relay.sock");
}

function columnExists(db: Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

/** Idempotent migrations for DBs created by older versions. */
function migrate(db: Database): void {
  if (columnExists(db, "workers", "id")) {
    if (!columnExists(db, "workers", "cwd")) {
      db.exec("ALTER TABLE workers ADD COLUMN cwd TEXT;");
    }
    if (!columnExists(db, "workers", "command")) {
      db.exec("ALTER TABLE workers ADD COLUMN command TEXT;");
    }
  }
  // `claimed` task state was removed: anything left there is runnable work.
  try {
    db.exec("UPDATE tasks SET state = 'queued' WHERE state = 'claimed';");
  } catch { /* tasks table may not exist yet on first init */ }
}

export function openDb(path?: string): Database {
  const p = path ?? defaultDbPath();
  mkdirSync(dirname(p), { recursive: true });
  const db = new Database(p, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Initialize a fresh control plane directory (idempotent). */
export function initControlPlane(cwd = process.cwd()): string {
  const dir = join(cwd, ".agentctl");
  mkdirSync(dir, { recursive: true });
  const dbPath = process.env.AGENTCTL_DB ? resolve(process.env.AGENTCTL_DB) : join(dir, "state.db");
  const dbExists = existsSync(dbPath);
  const db = openDb(dbPath);
  db.close();
  return `${dbExists ? "exists" : "created"}:${dbPath}`;
}

export function now(): number {
  return Date.now();
}
