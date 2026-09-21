import type { Database } from "bun:sqlite";
import { now } from "./db";
import { logEvent } from "./events";
import {
  clearCurrentTask,
  getWorker,
  listWorkers,
  normalizeWorkerAfterTaskRelease,
  touchProgress,
} from "./workers";
import type { Task, TaskState } from "./schema";
import { RELAY_TAG, sendMessage } from "./messages";

export const STALE_LEASE = "STALE_LEASE";

export function leaseMs(): number {
  const v = Number(process.env.RELAY_LEASE_MS ?? "120000");
  return Number.isFinite(v) && v > 0 ? v : 120000;
}

/**
 * How long a worker may go without a liveness signal before its running task's
 * lease is revoked (crash recovery). Deliberately generous vs. RELAY_LEASE_MS:
 * the lease is a *heartbeat* window, the grace window is the *crash* window.
 */
export function leaseLivenessGraceMs(): number {
  const v = Number(process.env.RELAY_LEASE_LIVENESS_GRACE_MS ?? "300000");
  return Number.isFinite(v) && v > 0 ? v : 300000;
}

// ---------------------------------------------------------------------------
// Role-aware claiming policy
//
// A task's `role` is a real claim gate by default (strict). A task with a
// non-null role is claimable only by a worker whose role equals it; `role IS
// NULL` tasks stay claimable by anyone. Strict is the default; set
// RELAY_ROLE_STRICT=false (or pass --any-role) to restore the legacy
// any-worker behavior for recovery.
// ---------------------------------------------------------------------------

/** Strict role matching is the default; RELAY_ROLE_STRICT=false opts out. */
export function roleStrictDefault(): boolean {
  const v = process.env.RELAY_ROLE_STRICT;
  if (v === undefined || v === "") return true;
  return !/^(false|0|no|off)$/i.test(v);
}

export interface ClaimOptions {
  /** Explicit override role for this call (`relay next --role R`). */
  role?: string;
  /** false = escape hatch (--any-role); defaults to `roleStrictDefault()`. */
  strictRole?: boolean;
}

/** True when `matchRole` may claim a task tagged `taskRole` under the policy. */
export function roleMatches(taskRole: string | null, matchRole: string, strict: boolean): boolean {
  if (!strict) return true;
  if (taskRole === null) return true;
  return taskRole === matchRole;
}

/** Resolve the effective (matchRole, strict) for a worker + per-call options. */
function claimPolicy(workerRole: string, opts: ClaimOptions): { matchRole: string; strict: boolean } {
  return { matchRole: opts.role ?? workerRole, strict: opts.strictRole ?? roleStrictDefault() };
}

/** Queued tasks this worker could claim right now under the active policy. */
export function claimableRunnableTasks(db: Database, workerId: string, opts: ClaimOptions = {}): Task[] {
  const worker = getWorker(db, workerId);
  if (!worker) return [];
  const { matchRole, strict } = claimPolicy(worker.role, opts);
  return runnableTasks(db).filter((t) => roleMatches(t.role, matchRole, strict));
}

/**
 * Runnable tasks no registered worker role can claim (only meaningful under
 * strict). Surfaced in `relay status` / the supervisor view so a stranded task
 * is visible instead of silently unclaimable.
 */
export function unclaimableRunnableTasks(db: Database): Task[] {
  if (!roleStrictDefault()) return [];
  const roles = new Set(listWorkers(db).map((w) => w.role));
  return runnableTasks(db).filter((t) => t.role !== null && !roles.has(t.role));
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
    planId?: string;
  }
): Task {
  const t = now();
  const id = nextTaskId(db);
  db.query(
    `INSERT INTO tasks (id, title, description, acceptance, state, priority, role, assignee,
      lease_token, lease_until, parent_task_id, plan_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, NULL, 0, NULL, ?, ?, ?, ?)`
  ).run(
    id,
    input.title,
    input.description ?? "",
    input.acceptance ?? "",
    input.priority ?? 0,
    input.role ?? null,
    input.parentTaskId ?? null,
    input.planId ?? null,
    t,
    t
  );
  logEvent(db, {
    source: "cli", taskId: id, type: "task.created",
    payload: { title: input.title, plan: input.planId ?? null },
  });
  return getTask(db, id)!;
}

/**
 * Set (or clear, with null) the plan.json item this task belongs to.
 *
 * agent-status joins relay tasks to plan items on this column, so the linkage is
 * data instead of a title convention that breaks when someone rewords a title.
 */
export function setTaskPlan(db: Database, taskId: string, planId: string | null): Task {
  const t = getTask(db, taskId);
  if (!t) throw new Error(`unknown task: ${taskId}`);
  db.query(`UPDATE tasks SET plan_id = ?, updated_at = ? WHERE id = ?`).run(planId, now(), taskId);
  logEvent(db, {
    source: "cli",
    taskId,
    type: planId ? "task.plan_linked" : "task.plan_unlinked",
    payload: { plan: planId ?? null },
  });
  return getTask(db, taskId)!;
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
 * Peer ownership model: a task's `role` is a real claim gate by default. A
 * task tagged with a role is claimable only by a worker of that role;
 * `role IS NULL` tasks stay claimable by anyone. Reviewers still check the
 * review queue first (review tasks are only claimable by reviewers).
 *
 * `opts.role` overrides the match role for this call (`relay next --role R`);
 * `opts.strictRole: false` (or RELAY_ROLE_STRICT=false / --any-role) restores
 * the legacy any-worker behavior for recovery.
 */
export function claimNext(db: Database, workerId: string, opts: ClaimOptions = {}): Task | null {
  const worker = getWorker(db, workerId);
  if (!worker) throw new Error(`unknown worker: ${workerId}. Register first: relay worker register ${workerId}`);
  const t = now();
  const { matchRole, strict } = claimPolicy(worker.role, opts);

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
      // No reviews pending: fall through to queued work (role-gated below; a
      // reviewer also claims `role='reviewer'` queued tasks).
    }

    // Apply the role gate in SQL so selection stays atomic. Under strict, only
    // role IS NULL or role = matchRole qualify.
    const queuedSql = strict
      ? `SELECT * FROM tasks WHERE state = 'queued' AND (role IS NULL OR role = ?) ORDER BY priority DESC, created_at ASC LIMIT 1`
      : `SELECT * FROM tasks WHERE state = 'queued' ORDER BY priority DESC, created_at ASC LIMIT 1`;
    const task = (strict ? db.query(queuedSql).get(matchRole) : db.query(queuedSql).get()) as Task | null;

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

/**
 * Atomically claim one specific task (queued -> running). Peer ownership model,
 * role-gated by default: a task tagged with a role may only be claimed by a
 * worker of that role. `opts.role` overrides the match role; `opts.strictRole:
 * false` (or RELAY_ROLE_STRICT=false / --any-role) restores any-worker claiming.
 */
export function claimTask(db: Database, taskId: string, workerId: string, opts: ClaimOptions = {}): Task {
  const worker = getWorker(db, workerId);
  if (!worker) throw new Error(`unknown worker: ${workerId}. Register first: relay worker register ${workerId}`);
  if (worker.role === "reviewer") throw new Error(`reviewers take review tasks via \`relay next\`, not claim`);
  const t = now();
  db.run("BEGIN IMMEDIATE");
  try {
    const task = getTask(db, taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    if (task.state !== "queued") throw new Error(`cannot claim task in state ${task.state}`);
    const { matchRole, strict } = claimPolicy(worker.role, opts);
    if (!roleMatches(task.role, matchRole, strict)) {
      throw new Error(
        `cannot claim task ${taskId}: role '${task.role}' does not match worker role '${matchRole}' (use --any-role to override)`
      );
    }
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

/**
 * Clean hand-back of a RUNNING task (mis-claimed ownership) without fabricating
 * a block/reject note. The task returns to `queued` with a bumped fencing token
 * and no assignee/lease; the previous owner's `current_task_id` is cleared.
 *
 * Ownership rule (deliberate): the current assignee may release, and a human /
 * any other worker may also release — this is the recovery path used when the
 * owner is gone or has claimed the wrong role. There is intentionally no hard
 * fencing requirement here (that would defeat the recovery purpose); the task's
 * bumped lease_token still fences the old owner's later submit.
 */
export function releaseTask(db: Database, taskId: string, workerId: string, reason = ""): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (task.state !== "running") throw new Error(`cannot release task in state ${task.state}`);
  const t = now();
  const body = reason.trim() || `released by ${workerId}`;
  db.query(`INSERT INTO task_notes (task_id, worker_id, kind, body, created_at) VALUES (?, ?, 'release', ?, ?)`).run(
    taskId,
    workerId,
    body,
    t
  );
  db.query(
    `UPDATE tasks SET state = 'queued', assignee = NULL, lease_until = NULL,
       lease_token = lease_token + 1, updated_at = ? WHERE id = ?`
  ).run(t, taskId);
  if (task.assignee) {
    clearCurrentTask(db, task.assignee);
    normalizeWorkerAfterTaskRelease(db, task.assignee, t);
  }
  // A releasing non-owner (human/recovery) must not keep a stale pointer either.
  if (workerId !== task.assignee) {
    db.query(`UPDATE workers SET current_task_id = NULL WHERE id = ? AND current_task_id = ?`).run(workerId, taskId);
    normalizeWorkerAfterTaskRelease(db, workerId, t);
  }
  touchProgress(db, workerId, t);
  logEvent(db, { source: "worker", workerId, taskId, type: "task.released", payload: { reason: body } });
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
  // Durable state first, in ONE transaction: the child's completion and its
  // parent notification (note + message) either both commit or neither does — a
  // crash can never leave "child done but parent never told".
  db.transaction(() => {
    db.query(`UPDATE tasks SET state = 'done', updated_at = ? WHERE id = ?`).run(t, taskId);
    if (task.assignee === workerId) clearCurrentTask(db, workerId);
    else if (task.assignee) clearCurrentTask(db, task.assignee);
    normalizeWorkerAfterTaskRelease(db, workerId, t);
    if (task.assignee && task.assignee !== workerId) normalizeWorkerAfterTaskRelease(db, task.assignee, t);
    touchProgress(db, workerId, t);
    logEvent(db, { source: "reviewer", workerId, taskId, type: "task.approved" });
    const done = getTask(db, taskId)!;
    // One-hop completion bubbling to the IMMEDIATE parent (no recursion).
    bubbleChildDone(db, done, workerId, t);
  })();
  return getTask(db, taskId)!;
}

/**
 * Tell the IMMEDIATE parent that a child finished. Durable first: a `child_done`
 * note on the parent (plus `children_done` when ALL direct children are done),
 * and a durable message to the parent's current assignee if it has one. Wake is
 * left to the reconciler's mail nudge. No recursion, no automatic parent done,
 * no new queue — only `parent_task_id` + `task_notes` + `messages`.
 */
function bubbleChildDone(db: Database, child: Task, actor: string, at: number): void {
  const parentId = child.parent_task_id;
  if (!parentId) return;
  const parent = getTask(db, parentId);
  if (!parent) return; // dangling parent: the child still completes
  const body = `${RELAY_TAG}${child.id} done: ${child.title}`;
  db.query(
    `INSERT INTO task_notes (task_id, worker_id, kind, body, created_at) VALUES (?, ?, 'child_done', ?, ?)`
  ).run(parentId, actor, body, at);

  const counts = db
    .query(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN state = 'done' THEN 1 ELSE 0 END) AS done
         FROM tasks WHERE parent_task_id = ?`
    )
    .get(parentId) as { total: number; done: number };
  const allDone = counts.total > 0 && counts.done === counts.total;
  if (allDone) {
    db.query(
      `INSERT INTO task_notes (task_id, worker_id, kind, body, created_at) VALUES (?, ?, 'children_done', ?, ?)`
    ).run(parentId, actor, `${RELAY_TAG}All direct children of ${parentId} are done (${counts.done}/${counts.total}).`, at);
  }

  if (parent.assignee) {
    sendMessage(db, "relay", parent.assignee, body, { kind: "child_done", taskId: parentId });
    if (allDone) {
      sendMessage(db, "relay", parent.assignee, `All direct children of ${parentId} are done (${counts.done}/${counts.total}).`, {
        kind: "children_done",
        taskId: parentId,
      });
    }
  }
  logEvent(db, {
    source: "supervisor",
    taskId: parentId,
    type: "task.child_done",
    payload: { child: child.id, allDone, assignee: parent.assignee ?? null },
  });
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

/**
 * Default liveness predicate for lease expiry. A worker counts as ALIVE (so its
 * running task's lapse is NOT treated as a crash) when its row exists, its state
 * is not `dead`/`stalled`, and it has been seen/progressed within the grace
 * window. A missing row or a dead/stalled worker is NOT alive, so a genuine
 * crash still requeues.
 */
export function defaultLeaseAlive(db: Database, at: number): (workerId: string | null) => boolean {
  const grace = leaseLivenessGraceMs();
  return (workerId) => {
    if (!workerId) return false;
    const w = getWorker(db, workerId);
    if (!w) return false;
    if (w.state === "dead" || w.state === "stalled") return false;
    const last = Math.max(w.last_seen_at ?? 0, w.last_progress_at ?? 0);
    return last >= at - grace;
  };
}

/**
 * Revoke lapsed leases: running tasks whose lease lapsed return to queued with a
 * bumped token — but ONLY when the assignee is missing or not alive. A live but
 * slow worker keeps its lease (it renews on `note`; the stall detector, not
 * lease expiry, handles a live worker that has stopped progressing). Pass
 * `isAlive` to customize; by default the DB liveness rule above is used.
 */
export function expireLeases(
  db: Database,
  at = now(),
  isAlive?: (workerId: string | null) => boolean
): Task[] {
  const alive = isAlive ?? defaultLeaseAlive(db, at);
  const due = db
    .query(`SELECT * FROM tasks WHERE state = 'running' AND lease_until IS NOT NULL AND lease_until < ?`)
    .all(at) as Task[];
  const expired: Task[] = [];
  for (const task of due) {
    // Worker alive but slow: keep its lease; crash recovery is transport/DB driven.
    if (alive(task.assignee)) continue;
    db.query(
      `UPDATE tasks SET state = 'queued', assignee = NULL, lease_token = lease_token + 1, lease_until = NULL, updated_at = ? WHERE id = ?`
    ).run(at, task.id);
    if (task.assignee) {
      db.query(`UPDATE workers SET current_task_id = NULL, updated_at = ? WHERE id = ? AND current_task_id = ?`).run(at, task.assignee, task.id);
      normalizeWorkerAfterTaskRelease(db, task.assignee, at);
    }
    logEvent(db, { source: "supervisor", workerId: task.assignee, taskId: task.id, type: "task.lease_expired" });
    expired.push(task);
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
