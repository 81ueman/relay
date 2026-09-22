import type { Database } from "bun:sqlite";
import { now } from "./db";
import { logEvent } from "./events";
import type { Worker, WorkerState } from "./schema";

export type WorkerRow = Worker;

export function registerWorker(
  db: Database,
  id: string,
  opts: { role?: string; agentKind?: string; runtimeId?: string; sessionId?: string; cwd?: string; command?: string } = {}
): Worker {
  const t = now();
  const existing = db.query(`SELECT * FROM workers WHERE id = ?`).get(id) as Worker | null;
  if (existing) {
    // Re-registering a retired id revives it explicitly: bring it back into the
    // schedulable set rather than silently keeping a tombstone around.
    if (existing.retired_at !== null) {
      db.query(`UPDATE workers SET retired_at = NULL, retired_reason = NULL WHERE id = ?`).run(id);
      logEvent(db, { source: "cli", workerId: id, type: "worker.unretired", payload: { reason: "re-registered" } });
    }
    db.query(
      `UPDATE workers SET role = COALESCE(?, role), agent_kind = COALESCE(?, agent_kind),
        runtime_id = COALESCE(?, runtime_id),
        opencode_session_id = COALESCE(?, opencode_session_id),
        cwd = COALESCE(?, cwd), command = COALESCE(?, command), updated_at = ? WHERE id = ?`
    ).run(
      opts.role ?? null, opts.agentKind ?? null, opts.runtimeId ?? null, opts.sessionId ?? null,
      opts.cwd ?? null, opts.command ?? null, t, id
    );
    return getWorker(db, id)!;
  }
  db.query(
    `INSERT INTO workers (id, role, agent_kind, runtime_id, cwd, command, opencode_session_id, state, current_task_id,
      generation, last_seen_at, last_progress_at, nudged_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'starting', NULL, 0, ?, ?, NULL, ?, ?)`
  ).run(
    id, opts.role ?? "worker", opts.agentKind ?? "opencode", opts.runtimeId ?? null, opts.cwd ?? null, opts.command ?? null,
    opts.sessionId ?? null, t, t, t, t
  );
  logEvent(db, { source: "cli", workerId: id, type: "worker.registered", payload: { role: opts.role ?? "worker", agentKind: opts.agentKind ?? "opencode" } });
  return getWorker(db, id)!;
}

export function getWorker(db: Database, id: string): Worker | null {
  return (db.query(`SELECT * FROM workers WHERE id = ?`).get(id) as Worker | null) ?? null;
}

/** A retired worker is history only: never scheduled, listed or woken again. */
export function isRetired(w: Worker | null | undefined): boolean {
  return !!w && w.retired_at !== null;
}

/**
 * Retire a worker without deleting it. The row stays so historical events and
 * task references remain resolvable, but every operational surface excludes it.
 *
 * Refuses to retire a worker that still owns a task: retiring is a deliberate,
 * manual act, and silently taking a worker out from under durable work would
 * strand it. Release/submit the task first, then retire.
 */
export function retireWorker(db: Database, id: string, reason?: string): Worker {
  const w = getWorker(db, id);
  if (!w) throw new Error(`unknown worker: ${id}`);
  if (w.retired_at !== null) return w; // idempotent
  if (w.current_task_id) {
    throw new Error(`retire rejected: ${id} still owns ${w.current_task_id}; release/submit it first`);
  }
  const t = now();
  db.query(`UPDATE workers SET retired_at = ?, retired_reason = ?, updated_at = ? WHERE id = ?`).run(
    t, reason ?? null, t, id
  );
  logEvent(db, {
    source: "cli",
    workerId: id,
    type: "worker.retired",
    payload: { reason: reason ?? null, generation: w.generation, sessionId: w.opencode_session_id },
  });
  return getWorker(db, id)!;
}

/** Reverse a retirement (an un-retired worker becomes schedulable again). */
export function unretireWorker(db: Database, id: string): Worker {
  const w = getWorker(db, id);
  if (!w) throw new Error(`unknown worker: ${id}`);
  if (w.retired_at === null) return w; // idempotent
  db.query(`UPDATE workers SET retired_at = NULL, retired_reason = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
  logEvent(db, { source: "cli", workerId: id, type: "worker.unretired", payload: {} });
  return getWorker(db, id)!;
}

export function findWorkerBySession(db: Database, sessionId: string): Worker | null {
  return (
    (db.query(`SELECT * FROM workers WHERE opencode_session_id = ?`).get(sessionId) as Worker | null) ?? null
  );
}

export function listWorkers(db: Database, opts: { includeRetired?: boolean } = {}): Worker[] {
  const sql = opts.includeRetired
    ? `SELECT * FROM workers ORDER BY id ASC`
    : `SELECT * FROM workers WHERE retired_at IS NULL ORDER BY id ASC`;
  return db.query(sql).all() as Worker[];
}

export function setWorkerState(db: Database, id: string, state: WorkerState): void {
  db.query(`UPDATE workers SET state = ?, updated_at = ? WHERE id = ?`).run(state, now(), id);
}

export function touchSeen(db: Database, id: string, at = now()): void {
  db.query(`UPDATE workers SET last_seen_at = ?, updated_at = ? WHERE id = ?`).run(at, at, id);
}

export function touchProgress(db: Database, id: string, at = now()): void {
  // An explicit relay command is the strongest progress signal, and it can only
  // run when no tool is blocking the turn: drop any in-flight tool marker so a
  // backgrounded/finished tool whose `execute.after` was lost cannot linger.
  db.query(
    `UPDATE workers SET last_seen_at = ?, last_progress_at = ?, nudged_at = NULL,
       tool_name = NULL, tool_command = NULL, tool_started_at = NULL, tool_timeout_ms = NULL,
       updated_at = ? WHERE id = ?`
  ).run(at, at, at, id);
}

/**
 * A worker whose bounded quiet lease is active for its CURRENT task: it OWNS a
 * running task and has explicitly declared that it may stay runtime-idle until
 * `quiet_until`. A quiet lease that points at a different task is NOT active (it
 * can never leak onto another task).
 */
export function quietActive(w: Worker | null | undefined, at = now()): boolean {
  if (!w || w.quiet_until === null) return false;
  if (w.quiet_until <= at) return false;
  return !!w.quiet_task_id && w.quiet_task_id === w.current_task_id;
}

/**
 * Grant a bounded quiet lease. Does NOT change the worker's state, its task, or
 * its lease ownership — only the temporary permission to be runtime-idle.
 */
export function setQuiet(db: Database, workerId: string, taskId: string, until: number, reason: string): void {
  db.query(
    `UPDATE workers SET quiet_until = ?, quiet_reason = ?, quiet_task_id = ?, updated_at = ? WHERE id = ?`
  ).run(until, reason, taskId, now(), workerId);
}

/** Clear a quiet lease; true when one was actually cleared (for event logging). */
export function clearQuiet(db: Database, workerId: string): boolean {
  const w = getWorker(db, workerId);
  if (!w || w.quiet_until === null) return false;
  db.query(
    `UPDATE workers SET quiet_until = NULL, quiet_reason = NULL, quiet_task_id = NULL, updated_at = ? WHERE id = ?`
  ).run(now(), workerId);
  return true;
}

/**
 * Record the tool a worker is executing RIGHT NOW (`tool.started` from the
 * plugin). This is transport telemetry used for early detection/surfacing: it
 * never changes the worker's state, task ownership or lease. One agent loop runs
 * one tool at a time, so a single marker per worker is enough.
 */
export function setWorkerTool(
  db: Database,
  workerId: string,
  tool: { name: string; command?: string | null; timeoutMs?: number | null },
  at = now()
): void {
  db.query(
    `UPDATE workers SET tool_name = ?, tool_command = ?, tool_started_at = ?, tool_timeout_ms = ?, updated_at = ? WHERE id = ?`
  ).run(tool.name, tool.command ?? null, at, tool.timeoutMs ?? null, at, workerId);
}

/** Clear the in-flight tool marker; true when one was actually set. */
export function clearWorkerTool(db: Database, workerId: string): boolean {
  const w = getWorker(db, workerId);
  if (!w || w.tool_started_at === null) return false;
  db.query(
    `UPDATE workers SET tool_name = NULL, tool_command = NULL, tool_started_at = NULL, tool_timeout_ms = NULL, updated_at = ? WHERE id = ?`
  ).run(now(), workerId);
  return true;
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

/**
 * Normalize a worker that no longer holds a task. A worker with no
 * current_task_id must never stay `working`/`waiting_input`: those states imply
 * an owned task. starting/dead/stalled mean something else and are left alone.
 *
 * Called after every task-release path (submit/block/reject/approve/lease
 * expiry) so no half-state survives into the next reconcile pass.
 */
export function normalizeWorkerAfterTaskRelease(db: Database, id: string, at = now()): void {
  db.query(
    `UPDATE workers SET state = 'idle', updated_at = ?
      WHERE id = ? AND current_task_id IS NULL AND state IN ('working', 'waiting_input')`
  ).run(at, id);
}
