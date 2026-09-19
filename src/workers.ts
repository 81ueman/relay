import type { Database } from "bun:sqlite";
import { now } from "./db";
import { logEvent } from "./events";
import type { Worker, WorkerState } from "./schema";

export function registerWorker(
  db: Database,
  id: string,
  opts: { role?: string; runtimeId?: string; sessionId?: string } = {}
): Worker {
  const t = now();
  const existing = db.query(`SELECT * FROM workers WHERE id = ?`).get(id) as Worker | null;
  if (existing) {
    db.query(
      `UPDATE workers SET role = COALESCE(?, role), runtime_id = COALESCE(?, runtime_id),
        opencode_session_id = COALESCE(?, opencode_session_id), updated_at = ? WHERE id = ?`
    ).run(opts.role ?? null, opts.runtimeId ?? null, opts.sessionId ?? null, t, id);
    return getWorker(db, id)!;
  }
  db.query(
    `INSERT INTO workers (id, role, runtime_id, opencode_session_id, state, current_task_id,
      generation, last_seen_at, last_progress_at, nudged_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'starting', NULL, 0, ?, ?, NULL, ?, ?)`
  ).run(id, opts.role ?? "worker", opts.runtimeId ?? null, opts.sessionId ?? null, t, t, t, t);
  logEvent(db, { source: "cli", workerId: id, type: "worker.registered", payload: { role: opts.role ?? "worker" } });
  return getWorker(db, id)!;
}

export function getWorker(db: Database, id: string): Worker | null {
  return (db.query(`SELECT * FROM workers WHERE id = ?`).get(id) as Worker | null) ?? null;
}

export function findWorkerBySession(db: Database, sessionId: string): Worker | null {
  return (
    (db.query(`SELECT * FROM workers WHERE opencode_session_id = ?`).get(sessionId) as Worker | null) ?? null
  );
}

export function listWorkers(db: Database): Worker[] {
  return db.query(`SELECT * FROM workers ORDER BY id ASC`).all() as Worker[];
}

export function setWorkerState(db: Database, id: string, state: WorkerState): void {
  db.query(`UPDATE workers SET state = ?, updated_at = ? WHERE id = ?`).run(state, now(), id);
}

export function touchSeen(db: Database, id: string, at = now()): void {
  db.query(`UPDATE workers SET last_seen_at = ?, updated_at = ? WHERE id = ?`).run(at, at, id);
}

export function touchProgress(db: Database, id: string, at = now()): void {
  db.query(
    `UPDATE workers SET last_seen_at = ?, last_progress_at = ?, nudged_at = NULL, updated_at = ? WHERE id = ?`
  ).run(at, at, at, id);
}

export function bindSession(db: Database, id: string, sessionId: string): Worker {
  const w = getWorker(db, id);
  if (!w) throw new Error(`unknown worker: ${id}`);
  db.query(`UPDATE workers SET opencode_session_id = ?, updated_at = ? WHERE id = ?`).run(sessionId, now(), id);
  logEvent(db, { source: "cli", workerId: id, type: "worker.session_bound", payload: { sessionId } });
  return getWorker(db, id)!;
}

export function clearCurrentTask(db: Database, id: string): void {
  db.query(`UPDATE workers SET current_task_id = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
}
