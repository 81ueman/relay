import type { Database } from "bun:sqlite";
import { now } from "./db";
import { logEvent } from "./events";
import type { Task, Worker } from "./schema";

// ---------------------------------------------------------------------------
// `relay gc` — explicit, safe purge of HISTORICAL rows.
//
// There was no supported purge: fleet cleanup had to run raw SQL
// (`DELETE FROM worker_runtimes / sessions / tasks`). gc is:
//   - dry-run by DEFAULT (`--apply` to execute);
//   - refuses to delete a NON-RETIRED worker or a NON-TERMINAL task;
//   - never touches events / messages / task_notes unless `--with-history`.
//
// Tasks/sessions/runtimes are DISPOSABLE history; tasks are durable, so only
// `done`/`failed` tasks are ever eligible. A terminal task that a surviving task
// still depends on (or that has a non-terminal child) is SKIPPED, not deleted.
// ---------------------------------------------------------------------------

export interface GcSkip {
  kind: "worker" | "task" | "session" | "runtime";
  id: string;
  reason: string;
}

export interface GcPlan {
  /** When true the plan also removes events/messages/task_notes of purged rows. */
  withHistory: boolean;
  /** Rows newer than `now - olderThanMs` are skipped (0 = no grace). */
  olderThanMs: number;
  workers: string[];
  tasks: string[];
  sessions: string[];
  /** worker_runtimes.id */
  runtimes: number[];
  /** Counts of history rows that WOULD be removed (only computed with --with-history). */
  history: { events: number; messages: number; task_notes: number };
  skipped: GcSkip[];
  /** Dry-run: nothing has been deleted. */
  applied: boolean;
}

export interface GcOptions {
  withHistory?: boolean;
  olderThanMs?: number;
}

function inClause(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

/**
 * Compute the purge plan WITHOUT deleting anything. `applyGc` is the only
 * function that writes, and it re-checks every safety predicate in its DELETE.
 */
export function planGc(db: Database, opts: GcOptions = {}): GcPlan {
  const withHistory = opts.withHistory === true;
  const olderThanMs = Math.max(0, opts.olderThanMs ?? 0);
  const cutoff = now() - olderThanMs;
  const skipped: GcSkip[] = [];

  // 1. Workers: only RETIRED tombstones. A retired worker by definition owns no
  //    task (retire refuses), but re-check anyway.
  const workers: string[] = [];
  for (const w of db.query(`SELECT * FROM workers WHERE retired_at IS NOT NULL`).all() as Worker[]) {
    if (w.current_task_id) {
      skipped.push({ kind: "worker", id: w.id, reason: `still owns ${w.current_task_id}` });
      continue;
    }
    if (w.updated_at > cutoff) {
      skipped.push({ kind: "worker", id: w.id, reason: "within the grace window" });
      continue;
    }
    workers.push(w.id);
  }

  // 2. Tasks: only terminal (done/failed). A candidate is dropped when a task
  //    OUTSIDE the candidate set still depends on it, or it has a non-terminal
  //    child (deleting it would strand signalling/deps).
  const terminal = db.query(`SELECT * FROM tasks WHERE state IN ('done','failed')`).all() as Task[];
  const candidates: string[] = [];
  for (const t of terminal) {
    if (t.updated_at > cutoff) {
      skipped.push({ kind: "task", id: t.id, reason: "within the grace window" });
      continue;
    }
    const liveChildren = db
      .query(`SELECT id FROM tasks WHERE parent_task_id = ? AND state NOT IN ('done','failed')`)
      .all(t.id) as { id: string }[];
    if (liveChildren.length > 0) {
      skipped.push({ kind: "task", id: t.id, reason: `non-terminal child ${liveChildren.map((c) => c.id).join(",")}` });
      continue;
    }
    candidates.push(t.id);
  }
  const candidateSet = new Set(candidates);
  const tasks: string[] = [];
  for (const id of candidates) {
    const dependents = db
      .query(`SELECT task_id FROM task_deps WHERE depends_on = ?`)
      .all(id) as { task_id: string }[];
    const survivors = dependents.map((d) => d.task_id).filter((tid) => !candidateSet.has(tid));
    if (survivors.length > 0) {
      skipped.push({ kind: "task", id, reason: `still required by ${survivors.join(",")}` });
      continue;
    }
    tasks.push(id);
  }

  // 3. Runtime generations: terminal states only. An active/starting runtime is
  //    never history.
  const runtimes = (
    db
      .query(`SELECT id, created_at FROM worker_runtimes WHERE state IN ('stale','dead','cleaned')`)
      .all() as { id: number; created_at: number }[]
  )
    .filter((r) => r.created_at <= cutoff)
    .map((r) => r.id);

  // 4. Sessions: history only — unmanaged rows, or rows of a purged (retired)
  //    worker. Never the CURRENT session of a surviving worker.
  const sessionRows = db.query(`SELECT * FROM sessions`).all() as SessionRow[];
  const sessions: string[] = [];
  for (const s of sessionRows) {
    if (s.updated_at > cutoff) continue;
    const belongsToPurgedWorker = s.worker_id !== null && workers.includes(s.worker_id);
    if (s.managed !== 0 && !belongsToPurgedWorker) continue;
    const current = db
      .query(`SELECT 1 AS x FROM workers WHERE opencode_session_id = ? AND retired_at IS NULL LIMIT 1`)
      .get(s.session_id);
    if (current) continue; // a live worker is still bound to it
    sessions.push(s.session_id);
  }

  // 5. History counts (targeted: only rows referencing the purged workers/tasks).
  const history = { events: 0, messages: 0, task_notes: 0 };
  if (withHistory) {
    history.events = countWhere(db, "events", workerTaskPredicate(workers, tasks));
    history.messages = countWhere(db, "messages", messagePredicate(workers, tasks));
    history.task_notes = countWhere(db, "task_notes", workerTaskPredicate(workers, tasks));
  }

  return { withHistory, olderThanMs, workers, tasks, sessions, runtimes, history, skipped, applied: false };
}

interface SessionRow {
  session_id: string;
  managed: number;
  worker_id: string | null;
  updated_at: number;
}

interface Predicate {
  sql: string;
  params: unknown[];
}

/** events / task_notes reference a worker by `worker_id` and a task by `task_id`. */
function workerTaskPredicate(workers: string[], tasks: string[]): Predicate {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (workers.length > 0) {
    clauses.push(`worker_id IN (${inClause(workers.length)})`);
    params.push(...workers);
  }
  if (tasks.length > 0) {
    clauses.push(`task_id IN (${inClause(tasks.length)})`);
    params.push(...tasks);
  }
  return { sql: clauses.length > 0 ? clauses.join(" OR ") : "0", params };
}

/** messages reference a worker by sender/recipient and a task by `task_id`. */
function messagePredicate(workers: string[], tasks: string[]): Predicate {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (workers.length > 0) {
    const ph = inClause(workers.length);
    clauses.push(`sender IN (${ph})`, `recipient IN (${ph})`);
    params.push(...workers, ...workers);
  }
  if (tasks.length > 0) {
    clauses.push(`task_id IN (${inClause(tasks.length)})`);
    params.push(...tasks);
  }
  return { sql: clauses.length > 0 ? clauses.join(" OR ") : "0", params };
}

function countWhere(db: Database, table: string, pred: Predicate): number {
  const row = db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${pred.sql}`).get(...(pred.params as never[])) as {
    n: number;
  };
  return row.n;
}

/**
 * Execute a plan. Every DELETE re-asserts its safety predicate (retired worker,
 * terminal task, terminal runtime, unmanaged/retired session), so a plan that
 * was tampered with still cannot remove live state.
 */
export function applyGc(db: Database, plan: GcPlan): GcPlan {
  db.transaction(() => {
    for (const id of plan.workers) {
      db.query(`DELETE FROM workers WHERE id = ? AND retired_at IS NOT NULL AND current_task_id IS NULL`).run(id);
    }
    for (const id of plan.tasks) {
      // Dependency rows are gating metadata, not history: remove them with the
      // task so no dangling edge survives.
      db.query(`DELETE FROM task_deps WHERE task_id = ? OR depends_on = ?`).run(id, id);
      db.query(`DELETE FROM tasks WHERE id = ? AND state IN ('done','failed')`).run(id);
    }
    for (const sid of plan.sessions) {
      db.query(
        `DELETE FROM sessions WHERE session_id = ?
           AND NOT EXISTS (SELECT 1 FROM workers w WHERE w.opencode_session_id = sessions.session_id AND w.retired_at IS NULL)`
      ).run(sid);
    }
    for (const rid of plan.runtimes) {
      db.query(`DELETE FROM worker_runtimes WHERE id = ? AND state IN ('stale','dead','cleaned')`).run(rid);
    }
    if (plan.withHistory) {
      if (plan.workers.length > 0 || plan.tasks.length > 0) {
        const wt = workerTaskPredicate(plan.workers, plan.tasks);
        db.query(`DELETE FROM task_notes WHERE ${wt.sql}`).run(...(wt.params as never[]));
        db.query(`DELETE FROM events WHERE ${wt.sql}`).run(...(wt.params as never[]));
        const msg = messagePredicate(plan.workers, plan.tasks);
        db.query(`DELETE FROM messages WHERE ${msg.sql}`).run(...(msg.params as never[]));
      }
    }
  })();
  const applied: GcPlan = { ...plan, applied: true };
  logEvent(db, {
    source: "cli",
    type: "gc.applied",
    payload: {
      workers: plan.workers,
      tasks: plan.tasks,
      sessions: plan.sessions.length,
      runtimes: plan.runtimes.length,
      history: plan.withHistory ? plan.history : null,
    },
  });
  return applied;
}

/**
 * Convenience wrapper: plan then (only when `apply`) execute. Returns the plan
 * with `applied` set. Dry-run never writes.
 */
export function runGc(db: Database, opts: GcOptions & { apply?: boolean } = {}): GcPlan {
  const plan = planGc(db, opts);
  return opts.apply ? applyGc(db, plan) : plan;
}
