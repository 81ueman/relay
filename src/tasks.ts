import type { Database } from "bun:sqlite";
import { now } from "./db";
import { logEvent } from "./events";
import { clearCurrentTask, getWorker, normalizeWorkerAfterTaskRelease, touchProgress } from "./workers";
import type { Task, TaskState } from "./schema";

export const STALE_LEASE = "STALE_LEASE";

export function leaseMs(): number {
  const v = Number(process.env.AGENTCTL_LEASE_MS ?? "120000");
  return Number.isFinite(v) && v > 0 ? v : 120000;
}

function nextTaskId(db: Database): string {
  const r = db
    .query(`SELECT COALESCE(MAX(CAST(SUBSTR(id, 2) AS INTEGER)), 0) AS n FROM tasks WHERE id LIKE 'T%'`)
    .get() as { n: number };
  return `T${r.n + 1}`;
}

export function addTask(
  db: Database,
  input: {
    title: string;
    description?: string;
    acceptance?: string;
    priority?: number;
    role?: string;
    parentTaskId?: string;
  }
): Task {
  const t = now();
  const id = nextTaskId(db);
  db.query(
    `INSERT INTO tasks (id, title, description, acceptance, state, priority, role, assignee,
      lease_token, lease_until, parent_task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, NULL, 0, NULL, ?, ?, ?)`
  ).run(
    id,
    input.title,
    input.description ?? "",
    input.acceptance ?? "",
    input.priority ?? 0,
    input.role ?? null,
    input.parentTaskId ?? null,
    t,
    t
  );
  logEvent(db, { source: "cli", taskId: id, type: "task.created", payload: { title: input.title } });
  return getTask(db, id)!;
}

export function getTask(db: Database, id: string): Task | null {
  return (db.query(`SELECT * FROM tasks WHERE id = ?`).get(id) as Task | null) ?? null;
}

export function listTasks(db: Database, state?: string): Task[] {
  if (state) return db.query(`SELECT * FROM tasks WHERE state = ? ORDER BY priority DESC, created_at ASC`).all(state) as Task[];
  return db.query(`SELECT * FROM tasks ORDER BY created_at ASC`).all() as Task[];
}

export function taskCounts(db: Database): Record<string, number> {
  const rows = db.query(`SELECT state, COUNT(*) AS n FROM tasks GROUP BY state`).all() as {
    state: string;
    n: number;
  }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.state] = r.n;
  return out;
}

/**
 * Atomically claim the highest-priority runnable task for a worker.
 * Uses BEGIN IMMEDIATE so double-claim across processes is impossible.
 * Peer model: task `role` is an informational capability tag, not a gate.
 * Any worker may claim any queued task; reviewers check review first.
 */
export function claimNext(db: Database, workerId: string): Task | null {
  const worker = getWorker(db, workerId);
  if (!worker) throw new Error(`unknown worker: ${workerId}. Register first: agentctl worker register ${workerId}`);
  const t = now();

  db.run("BEGIN IMMEDIATE");
  try {
    if (worker.role === "reviewer") {
      const review = (db
        .query(`SELECT * FROM tasks WHERE state = 'review' ORDER BY priority DESC, created_at ASC LIMIT 1`)
        .get() as Task | null) ?? null;
      if (review) {
        db.query(`UPDATE tasks SET assignee = ?, updated_at = ? WHERE id = ?`).run(workerId, t, review.id);
        db.query(
          `UPDATE workers SET current_task_id = ?, state = 'working', last_seen_at = ?, last_progress_at = ?, updated_at = ? WHERE id = ?`
        ).run(review.id, t, t, t, workerId);
        logEvent(db, { source: "scheduler", workerId, taskId: review.id, type: "task.review_assigned" });
        db.run("COMMIT");
        return getTask(db, review.id)!;
      }
      // No reviews pending: fall through to queued work (peer, no hierarchy).
    }

    const task = (db
      .query(`SELECT * FROM tasks WHERE state = 'queued' ORDER BY priority DESC, created_at ASC LIMIT 1`)
      .get() as Task | null) ?? null;

    if (!task) {
      db.query(`UPDATE workers SET state = CASE WHEN current_task_id IS NULL THEN 'idle' ELSE state END, updated_at = ? WHERE id = ?`).run(t, workerId);
      db.run("COMMIT");
      return null;
    }

    db.query(
      `UPDATE tasks SET state = 'running', assignee = ?, lease_token = lease_token + 1,
        lease_until = ?, updated_at = ? WHERE id = ? AND state = 'queued'`
    ).run(workerId, t + leaseMs(), t, task.id);
    const changed = (db.query(`SELECT changes() AS n`).get() as { n: number }).n;
    if (changed === 0) {
      db.run("ROLLBACK");
      return null; // lost the race
    }
    db.query(
      `UPDATE workers SET current_task_id = ?, state = 'working', last_seen_at = ?, last_progress_at = ?, nudged_at = NULL, updated_at = ? WHERE id = ?`
    ).run(task.id, t, t, t, workerId);
    logEvent(db, { source: "scheduler", workerId, taskId: task.id, type: "task.claimed" });
    db.run("COMMIT");
    return getTask(db, task.id)!;
  } catch (e) {
    try { db.run("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}

/** Atomically claim one specific task (queued -> running). Peer model: any role may claim. */
export function claimTask(db: Database, taskId: string, workerId: string): Task {
  const worker = getWorker(db, workerId);
  if (!worker) throw new Error(`unknown worker: ${workerId}. Register first: agentctl worker register ${workerId}`);
  if (worker.role === "reviewer") throw new Error(`reviewers take review tasks via \`agentctl next\`, not claim`);
  const t = now();
  db.run("BEGIN IMMEDIATE");
  try {
    const task = getTask(db, taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    if (task.state !== "queued") throw new Error(`cannot claim task in state ${task.state}`);
    db.query(
      `UPDATE tasks SET state = 'running', assignee = ?, lease_token = lease_token + 1,
        lease_until = ?, updated_at = ? WHERE id = ? AND state = 'queued'`
    ).run(workerId, t + leaseMs(), t, taskId);
    db.query(
      `UPDATE workers SET current_task_id = ?, state = 'working', last_seen_at = ?, last_progress_at = ?, nudged_at = NULL, updated_at = ? WHERE id = ?`
    ).run(taskId, t, t, t, workerId);
    logEvent(db, { source: "scheduler", workerId, taskId, type: "task.claimed" });
    db.run("COMMIT");
    return getTask(db, taskId)!;
  } catch (e) {
    try { db.run("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}

export function addNote(db: Database, taskId: string, workerId: string, body: string, kind = "note"): void {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  const t = now();
  db.query(`INSERT INTO task_notes (task_id, worker_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    taskId, workerId, kind, body, t
  );
  // note = strongest progress signal: heartbeat + lease renewal.
  if (task.assignee === workerId && (task.state === "running" || task.state === "review")) {
    db.query(`UPDATE tasks SET lease_until = ?, updated_at = ? WHERE id = ?`).run(t + leaseMs(), t, taskId);
  }
  touchProgress(db, workerId, t);
  logEvent(db, { source: "worker", workerId, taskId, type: "task.note", payload: { kind } });
}

/** Release a blocked task back to queued so someone (or the same worker) can take it. */
export function unblockTask(db: Database, taskId: string, workerId: string): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (task.state !== "blocked_internal" && task.state !== "blocked_human") {
    throw new Error(`cannot unblock task in state ${task.state}`);
  }
  const t = now();
  // Fresh claim gets a new lease token; ensure no stale ownership lingers.
  db.query(`UPDATE tasks SET state = 'queued', assignee = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`).run(t, taskId);
  logEvent(db, { source: "worker", workerId, taskId, type: "task.unblocked" });
  return getTask(db, taskId)!;
}

export function getNotes(db: Database, taskId: string): { worker_id: string | null; kind: string; body: string; created_at: number }[] {
  return db.query(`SELECT worker_id, kind, body, created_at FROM task_notes WHERE task_id = ? ORDER BY id ASC`).all(taskId) as {
    worker_id: string | null; kind: string; body: string; created_at: number;
  }[];
}

/** Submit work for review. Fencing: assignee must match; explicit lease token must match. */
export function submitTask(
  db: Database,
  taskId: string,
  workerId: string,
  opts: { evidence?: string; leaseToken?: number } = {}
): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (task.assignee !== workerId) {
    throw new Error(`${STALE_LEASE}: task ${taskId} is owned by ${task.assignee ?? "nobody"} (token ${task.lease_token}), not ${workerId}`);
  }
  if (opts.leaseToken !== undefined && opts.leaseToken !== task.lease_token) {
    throw new Error(`${STALE_LEASE}: task ${taskId} token mismatch (have ${opts.leaseToken}, want ${task.lease_token})`);
  }
  if (task.state !== "running") {
    throw new Error(`cannot submit task in state ${task.state}`);
  }
  const t = now();
  if (opts.evidence) {
    db.query(`INSERT INTO task_notes (task_id, worker_id, kind, body, created_at) VALUES (?, ?, 'evidence', ?, ?)`).run(taskId, workerId, opts.evidence, t);
  }
  db.query(`UPDATE tasks SET state = 'review', updated_at = ? WHERE id = ?`).run(t, taskId);
  clearCurrentTask(db, workerId);
  touchProgress(db, workerId, t);
  normalizeWorkerAfterTaskRelease(db, workerId, t);
  logEvent(db, { source: "worker", workerId, taskId, type: "task.submitted" });
  return getTask(db, taskId)!;
}

export function approveTask(db: Database, taskId: string, workerId: string): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (task.state !== "review") throw new Error(`cannot approve task in state ${task.state}`);
  const t = now();
  db.query(`UPDATE tasks SET state = 'done', updated_at = ? WHERE id = ?`).run(t, taskId);
  if (task.assignee === workerId) clearCurrentTask(db, workerId);
  else if (task.assignee) clearCurrentTask(db, task.assignee);
  normalizeWorkerAfterTaskRelease(db, workerId, t);
  if (task.assignee && task.assignee !== workerId) normalizeWorkerAfterTaskRelease(db, task.assignee, t);
  touchProgress(db, workerId, t);
  logEvent(db, { source: "reviewer", workerId, taskId, type: "task.approved" });
  return getTask(db, taskId)!;
}

export function rejectTask(db: Database, taskId: string, workerId: string, reason: string): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (task.state !== "review") throw new Error(`cannot reject task in state ${task.state}`);
  const t = now();
  db.query(`INSERT INTO task_notes (task_id, worker_id, kind, body, created_at) VALUES (?, ?, 'reject', ?, ?)`).run(taskId, workerId, reason, t);
  db.query(
    `UPDATE tasks SET state = 'queued', assignee = NULL, lease_token = lease_token + 1, lease_until = NULL, updated_at = ? WHERE id = ?`
  ).run(t, taskId);
  if (task.assignee) {
    clearCurrentTask(db, task.assignee);
    normalizeWorkerAfterTaskRelease(db, task.assignee, t);
  }
  normalizeWorkerAfterTaskRelease(db, workerId, t);
  touchProgress(db, workerId, t);
  logEvent(db, { source: "reviewer", workerId, taskId, type: "task.rejected", payload: { reason } });
  return getTask(db, taskId)!;
}

export function blockTask(db: Database, taskId: string, workerId: string, reason: string, human: boolean): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  const t = now();
  db.query(`INSERT INTO task_notes (task_id, worker_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    taskId, workerId, human ? "blocked_human" : "blocked_internal", reason, t
  );
  const state: TaskState = human ? "blocked_human" : "blocked_internal";
  // Blocking releases ownership completely: no stale assignee/lease survives, so
  // the task cannot be "submitted" later by a worker that no longer owns it.
  db.query(
    `UPDATE tasks SET state = ?, assignee = NULL, lease_until = NULL, lease_token = lease_token + 1, updated_at = ? WHERE id = ?`
  ).run(state, t, taskId);
  // A blocked task never parks the worker: it must immediately take the next runnable task.
  if (task.assignee) {
    clearCurrentTask(db, task.assignee);
    normalizeWorkerAfterTaskRelease(db, task.assignee, t);
  }
  db.query(`UPDATE workers SET current_task_id = NULL WHERE id = ? AND current_task_id = ?`).run(workerId, taskId);
  normalizeWorkerAfterTaskRelease(db, workerId, t);
  touchProgress(db, workerId, t);
  logEvent(db, { source: "worker", workerId, taskId, type: human ? "task.blocked_human" : "task.blocked_internal", payload: { reason } });
  return getTask(db, taskId)!;
}

/** Revoke expired leases: running tasks whose lease lapsed return to queued with a bumped token. */
export function expireLeases(db: Database, at = now()): Task[] {
  const expired = db.query(`SELECT * FROM tasks WHERE state = 'running' AND lease_until IS NOT NULL AND lease_until < ?`).all(at) as Task[];
  for (const task of expired) {
    db.query(
      `UPDATE tasks SET state = 'queued', assignee = NULL, lease_token = lease_token + 1, lease_until = NULL, updated_at = ? WHERE id = ?`
    ).run(at, task.id);
    if (task.assignee) {
      db.query(`UPDATE workers SET current_task_id = NULL, updated_at = ? WHERE id = ? AND current_task_id = ?`).run(at, task.assignee, task.id);
      normalizeWorkerAfterTaskRelease(db, task.assignee, at);
    }
    logEvent(db, { source: "supervisor", workerId: task.assignee, taskId: task.id, type: "task.lease_expired" });
  }
  return expired;
}

export function runnableTasks(db: Database): Task[] {
  return db.query(`SELECT * FROM tasks WHERE state = 'queued' ORDER BY priority DESC, created_at ASC`).all() as Task[];
}

export function reviewTasks(db: Database): Task[] {
  return db.query(`SELECT * FROM tasks WHERE state = 'review' ORDER BY priority DESC, created_at ASC`).all() as Task[];
}

export function unfinishedCount(db: Database): number {
  const r = db.query(`SELECT COUNT(*) AS n FROM tasks WHERE state != 'done' AND state != 'failed'`).get() as { n: number };
  return r.n;
}
