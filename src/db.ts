import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SCHEMA } from "./schema";

export const STATE_DIR = ".relay";

export function defaultDbPath(cwd = process.cwd()): string {
  if (process.env.RELAY_DB) return resolve(process.env.RELAY_DB);
  return join(cwd, STATE_DIR, "state.db");
}

export function defaultSockPath(cwd = process.cwd()): string {
  if (process.env.RELAY_SOCK) return resolve(process.env.RELAY_SOCK);
  const dbPath = process.env.RELAY_DB ? resolve(process.env.RELAY_DB) : join(cwd, STATE_DIR, "state.db");
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
  // Per-spawn attach token (generation fencing for managed attaches).
  if (columnExists(db, "worker_runtimes", "id") && !columnExists(db, "worker_runtimes", "attach_token")) {
    db.exec("ALTER TABLE worker_runtimes ADD COLUMN attach_token TEXT;");
  }
  // Ownership: rows predating manual attach were all relay-spawned tabs.
  if (columnExists(db, "worker_runtimes", "id") && !columnExists(db, "worker_runtimes", "relay_owned")) {
    db.exec("ALTER TABLE worker_runtimes ADD COLUMN relay_owned INTEGER NOT NULL DEFAULT 1;");
  }
  if (columnExists(db, "worker_runtimes", "id") && !columnExists(db, "worker_runtimes", "workspace_id")) {
    db.exec("ALTER TABLE worker_runtimes ADD COLUMN workspace_id TEXT;");
  }
  // Bootstrap delivery bookkeeping: when the fresh generation last got its
  // bootstrap prompt (so a failed wake can be retried after a cooldown without
  // discarding the generation).
  if (columnExists(db, "worker_runtimes", "id") && !columnExists(db, "worker_runtimes", "bootstrap_sent_at")) {
    db.exec("ALTER TABLE worker_runtimes ADD COLUMN bootstrap_sent_at INTEGER;");
  }
  // NOTE: (worker_id, generation) is kept unique by application logic (the
  // monotonic `nextGeneration` helper), not by a DB constraint. Legacy rows may
  // legitimately share a generation (e.g. an active row plus a protected stale
  // duplicate from a botched spawn), so a UNIQUE index would reject valid
  // history. The fencing invariant only requires that a LIVE generation is
  // never re-created; that is enforced at the attach path.
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
  const dir = join(cwd, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  const dbPath = process.env.RELAY_DB ? resolve(process.env.RELAY_DB) : join(dir, "state.db");
  const dbExists = existsSync(dbPath);
  const db = openDb(dbPath);
  db.close();
  return `${dbExists ? "exists" : "created"}:${dbPath}`;
}

export function now(): number {
  return Date.now();
}
