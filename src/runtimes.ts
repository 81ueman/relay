import type { Database } from "bun:sqlite";
import { now } from "./db";
import { logEvent } from "./events";
import type { RuntimeState, WorkerRuntime } from "./schema";

// worker_runtimes is the history + cleanup authority for runtime generations.
// The workers row only ever points at the ACTIVE generation; this module is how
// the supervisor remembers (and later safely reaps) older ones.

/** Grace period between marking an old runtime stale/dead and reaping its tab. */
export function runtimeCleanupGraceMs(): number {
  const v = Number(process.env.AGENTCTL_RUNTIME_CLEANUP_GRACE_MS ?? "300000");
  return Number.isFinite(v) && v >= 0 ? v : 300000;
}

export interface RecordRuntimeInput {
  workerId: string;
  generation: number;
  runtimeId?: string | null;
  tabId?: string | null;
  paneId?: string | null;
  sessionId?: string | null;
  /** Per-spawn secret required to accept a relay-generation managed attach. */
  attachToken?: string | null;
  state?: RuntimeState;
  /** Absolute time after which a stale/dead runtime may be cleaned. */
  cleanupAfter?: number | null;
  createdAt?: number;
}

export function recordRuntime(db: Database, input: RecordRuntimeInput): WorkerRuntime {
  const t = input.createdAt ?? now();
  const state: RuntimeState = input.state ?? "starting";
  const cleanupAfter =
    input.cleanupAfter !== undefined
      ? input.cleanupAfter
      : state === "stale" || state === "dead"
        ? t + runtimeCleanupGraceMs()
        : null;
  const info = db
    .query(
      `INSERT INTO worker_runtimes
        (worker_id, generation, runtime_id, tab_id, pane_id, session_id, attach_token, state, created_at, stale_at, cleanup_after, cleaned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(
      input.workerId,
      input.generation,
      input.runtimeId ?? null,
      input.tabId ?? null,
      input.paneId ?? null,
      input.sessionId ?? null,
      input.attachToken ?? null,
      state,
      t,
      state === "stale" || state === "dead" ? t : null,
      cleanupAfter
    );
  const id = Number(info.lastInsertRowid);
  logEvent(db, {
    source: "supervisor",
    workerId: input.workerId,
    type: "runtime.recorded",
    payload: { generation: input.generation, runtimeId: input.runtimeId ?? null, state },
  });
  return getRuntime(db, id)!;
}

export function getRuntime(db: Database, id: number): WorkerRuntime | null {
  return (db.query(`SELECT * FROM worker_runtimes WHERE id = ?`).get(id) as WorkerRuntime | null) ?? null;
}

export function listRuntimes(
  db: Database,
  filter: { workerId?: string; state?: RuntimeState; generation?: number } = {}
): WorkerRuntime[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.workerId !== undefined) {
    clauses.push("worker_id = ?");
    params.push(filter.workerId);
  }
  if (filter.state !== undefined) {
    clauses.push("state = ?");
    params.push(filter.state);
  }
  if (filter.generation !== undefined) {
    clauses.push("generation = ?");
    params.push(filter.generation);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  return db
    .query(`SELECT * FROM worker_runtimes${where} ORDER BY id ASC`)
    .all(...(params as never[])) as WorkerRuntime[];
}

/** Latest runtime row for a worker (any state). */
export function latestRuntime(db: Database, workerId: string): WorkerRuntime | null {
  return (
    (db
      .query(`SELECT * FROM worker_runtimes WHERE worker_id = ? ORDER BY generation DESC, id DESC LIMIT 1`)
      .get(workerId) as WorkerRuntime | null) ?? null
  );
}

/** The runtime row the worker is currently using (state = 'active'), if any. */
export function getActiveRuntime(db: Database, workerId: string): WorkerRuntime | null {
  return (
    (db
      .query(
        `SELECT * FROM worker_runtimes WHERE worker_id = ? AND state = 'active' ORDER BY generation DESC, id DESC LIMIT 1`
      )
      .get(workerId) as WorkerRuntime | null) ?? null
  );
}

/** The freshly spawned runtime for (worker, generation) that is not yet active. */
export function getStartingRuntime(db: Database, workerId: string, generation: number): WorkerRuntime | null {
  return (
    (db
      .query(
        `SELECT * FROM worker_runtimes WHERE worker_id = ? AND generation = ? AND state = 'starting'
         ORDER BY id DESC LIMIT 1`
      )
      .get(workerId, generation) as WorkerRuntime | null) ?? null
  );
}

export function findRuntime(db: Database, workerId: string, generation: number): WorkerRuntime | null {
  return (
    (db
      .query(
        `SELECT * FROM worker_runtimes WHERE worker_id = ? AND generation = ? ORDER BY id DESC LIMIT 1`
      )
      .get(workerId, generation) as WorkerRuntime | null) ?? null
  );
}

/** Mark a runtime active and bind the OpenCode session that attached to it. */
export function markRuntimeActive(db: Database, id: number, sessionId: string | null, at = now()): WorkerRuntime | null {
  db.query(
    `UPDATE worker_runtimes SET state = 'active', session_id = COALESCE(?, session_id), cleanup_after = NULL WHERE id = ?`
  ).run(sessionId, id);
  return getRuntime(db, id);
}

/** Mark an old runtime stale: kept alive, eligible for cleanup after the grace period. */
export function markRuntimeStale(db: Database, id: number, at = now()): WorkerRuntime | null {
  db.query(
    `UPDATE worker_runtimes
       SET state = 'stale', stale_at = COALESCE(stale_at, ?),
           cleanup_after = COALESCE(cleanup_after, ?)
     WHERE id = ? AND state IN ('starting', 'active', 'stale')`
  ).run(at, at + runtimeCleanupGraceMs(), id);
  return getRuntime(db, id);
}

/** Mark a runtime dead (transport gone): cleanup-eligible after the grace period. */
export function markRuntimeDead(db: Database, id: number, at = now()): WorkerRuntime | null {
  db.query(
    `UPDATE worker_runtimes
       SET state = 'dead', stale_at = COALESCE(stale_at, ?),
           cleanup_after = COALESCE(cleanup_after, ?)
     WHERE id = ? AND state IN ('starting', 'active', 'stale', 'dead')`
  ).run(at, at + runtimeCleanupGraceMs(), id);
  return getRuntime(db, id);
}

export function markRuntimeCleaned(db: Database, id: number, at = now()): WorkerRuntime | null {
  db.query(`UPDATE worker_runtimes SET state = 'cleaned', cleaned_at = ? WHERE id = ?`).run(at, id);
  return getRuntime(db, id);
}

/**
 * Runtimes eligible for cleanup: explicitly stale/dead AND past their grace
 * period. Generation/ownership safety is enforced by the caller (reconciler).
 */
export function cleanupCandidates(db: Database, at = now()): WorkerRuntime[] {
  return db
    .query(
      `SELECT * FROM worker_runtimes
        WHERE state IN ('stale', 'dead') AND cleanup_after IS NOT NULL AND cleanup_after <= ?
        ORDER BY generation ASC, id ASC`
    )
    .all(at) as WorkerRuntime[];
}
