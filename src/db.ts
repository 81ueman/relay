import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SCHEMA } from "./schema";

export function defaultDbPath(cwd = process.cwd()): string {
  if (process.env.AGENTCTL_DB) return resolve(process.env.AGENTCTL_DB);
  return join(cwd, ".agentctl", "state.db");
}

export function openDb(path?: string): Database {
  const p = path ?? defaultDbPath();
  mkdirSync(dirname(p), { recursive: true });
  const db = new Database(p, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
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
