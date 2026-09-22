import type { Database } from "bun:sqlite";
import { now } from "./db";
import { logEvent } from "./events";
import {
  clearCurrentTask,
  clearQuiet,
  getWorker,
  listWorkers,
  normalizeWorkerAfterTaskRelease,
  setQuiet,
  touchProgress,
} from "./workers";
import type { Task, TaskState } from "./schema";
import { RELAY_TAG, sendMessage } from "./messages";

export const STALE_LEASE = "STALE_LEASE";

// ---------------------------------------------------------------------------
// Runnable gating (declared prerequisites + the reviewer gate)
//
// A `queued` task is only RUNNABLE when:
//   1. every `task_deps` prerequisite is `done`; and
//   2. if it is a queued REVIEWER gate (role='reviewer' with NO declared
//      prerequisite) something is actually in `review`.
//
// (2) exists because a pre-created review task was otherwise runnable the
// instant it was queued: the scheduler woke an idle reviewer and `relay next`
// claimed it BEFORE its sibling implementation was submitted — claim/release
// churn on every nudge (observed live: the standing OSPF review gate T222, and
// the CP-W3 gate T153). A reviewer's PRIMARY path — claiming a task already in
// state='review' — is unaffected; this only gates the pre-created queued gate.
// A gate that declares its inputs as dependencies becomes runnable as soon as
// they are done, independent of the review queue.
//
// `RUNNABLE_TASK_SQL` must stay in sync with `isRunnableNow`.
// ---------------------------------------------------------------------------

const DEPS_DONE_SQL = `NOT EXISTS (
  SELECT 1 FROM task_deps dep
    LEFT JOIN tasks d ON d.id = dep.depends_on
   WHERE dep.task_id = t.id AND (d.id IS NULL OR d.state != 'done')
)`;
const REVIEW_GATE_SQL =
  `(t.role IS NOT 'reviewer'
    OR EXISTS (SELECT 1 FROM task_deps dep WHERE dep.task_id = t.id)
    OR EXISTS (SELECT 1 FROM tasks r WHERE r.state = 'review'))`;
const RUNNABLE_TASK_SQL = `t.state = 'queued' AND ${DEPS_DONE_SQL} AND ${REVIEW_GATE_SQL}`;

/**
 * Clear a worker's quiet lease after an explicit relay action (note/submit/block/
 * release/claim/approve) or a generation change, logging only when one existed.
 * A quiet lease must never survive "work resumed" and must never leak onto the
 * next task.
 */
function clearQuietLogged(db: Database, workerId: string, taskId?: string | null): void {
  if (clearQuiet(db, workerId)) {
    logEvent(db, { source: "worker", workerId, taskId: taskId ?? null, type: "worker.quiet_cleared", payload: {} });
  }
}

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
    /** Declared prerequisites: not runnable until every one is `done`. */
    dependsOn?: string[];
  }
): Task {
  const t = now();
  const id = nextTaskId(db);
  const deps = normalizeDeps(input.dependsOn);
  assertDependencies(db, id, deps);
  db.transaction(() => {
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
    for (const dep of deps) {
      db.query(`INSERT INTO task_deps (task_id, depends_on, created_at) VALUES (?, ?, ?)`).run(id, dep, t);
    }
  })();
  logEvent(db, {
    source: "cli", taskId: id, type: "task.created",
    payload: { title: input.title, plan: input.planId ?? null, dependsOn: deps },
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

// ---------------------------------------------------------------------------
// Declared prerequisites (task_deps): run gating for pre-created work
// ---------------------------------------------------------------------------

function normalizeDeps(deps?: string[]): string[] {
  return [...new Set((deps ?? []).map((d) => d.trim()).filter((d) => d.length > 0))];
}

/**
 * Reject unknown prerequisites and cycles up front: a cycle (A->B->A) would make
 * a task permanently un-runnable with no error surfaced at claim time.
 */
function assertDependencies(db: Database, taskId: string, deps: string[]): void {
  for (const dep of deps) {
    if (dep === taskId) throw new Error(`task ${taskId} cannot depend on itself`);
    if (!getTask(db, dep)) throw new Error(`unknown dependency task: ${dep}`);
  }
  // DFS from the PROPOSED edges; `onStack` catches a cycle back to taskId,
  // `visited` avoids re-walking a shared ancestor (which is not a cycle).
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const visit = (id: string, children: string[]): void => {
    if (onStack.has(id)) throw new Error(`dependency cycle involving ${id}`);
    if (visited.has(id)) return;
    onStack.add(id);
    for (const child of children) visit(child, taskDependencies(db, child));
    onStack.delete(id);
    visited.add(id);
  };
  visit(taskId, deps);
}

/** The prerequisites of a task, sorted. */
export function taskDependencies(db: Database, taskId: string): string[] {
  return (
    db.query(`SELECT depends_on FROM task_deps WHERE task_id = ? ORDER BY depends_on ASC`).all(taskId) as {
      depends_on: string;
    }[]
  ).map((r) => r.depends_on);
}

/** True when every declared prerequisite of `task` is `done` (unknown = unmet). */
export function dependenciesMet(db: Database, task: Task): boolean {
  const unmet = db
    .query(
      `SELECT COUNT(*) AS n FROM task_deps dep
         LEFT JOIN tasks d ON d.id = dep.depends_on
        WHERE dep.task_id = ? AND (d.id IS NULL OR d.state != 'done')`
    )
    .get(task.id) as { n: number };
  return unmet.n === 0;
}

/** Is anything currently in the review queue? (the reviewer-gate precondition) */
export function reviewPending(db: Database): boolean {
  return reviewTasks(db).length > 0;
}

/**
 * Single-task runnable check, mirroring RUNNABLE_TASK_SQL. `reviewExists` lets a
 * caller scanning many tasks avoid a review-queue query per task.
 */
export function isRunnableNow(db: Database, task: Task, reviewExists?: boolean): boolean {
  if (task.state !== "queued") return false;
  if (!dependenciesMet(db, task)) return false;
  if (task.role === "reviewer" && taskDependencies(db, task.id).length === 0) {
    return reviewExists ?? reviewPending(db);
  }
  return true;
}

/**
 * Queued tasks that exist but are NOT runnable yet: an unmet prerequisite, or a
 * pre-created reviewer gate with nothing in review. Surfaced by `relay status`
 * so gated work is visible instead of silently stranded.
 */
export function notYetRunnableTasks(db: Database): Task[] {
  const reviewExists = reviewPending(db);
  return (db.query(`SELECT * FROM tasks WHERE state = 'queued' ORDER BY priority DESC, created_at ASC`).all() as Task[])
    .filter((t) => !isRunnableNow(db, t, reviewExists));
}

/**
 * Replace a task's declared prerequisites in one transaction. An empty list (or
 * `--clear`) removes the gate. Validates existence and rejects cycles.
 */
export function setTaskDependencies(db: Database, taskId: string, deps: string[]): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  const next = normalizeDeps(deps);
  assertDependencies(db, taskId, next);
  const t = now();
  db.transaction(() => {
    db.query(`DELETE FROM task_deps WHERE task_id = ?`).run(taskId);
    for (const dep of next) {
      db.query(`INSERT INTO task_deps (task_id, depends_on, created_at) VALUES (?, ?, ?)`).run(taskId, dep, t);
    }
    db.query(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(t, taskId);
  })();
  logEvent(db, {
    source: "cli",
    taskId,
    type: next.length > 0 ? "task.depends_set" : "task.depends_cleared",
    payload: { dependsOn: next },
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

    // Apply the runnable gate and the role gate in SQL so selection stays atomic.
    // A queued task with an unmet prerequisite (or a reviewer gate with nothing
    // in review) is never selected. Under strict, only role IS NULL or
    // role = matchRole qualify.
    const queuedSql = strict
      ? `SELECT t.* FROM tasks t WHERE ${RUNNABLE_TASK_SQL} AND (t.role IS NULL OR t.role = ?) ORDER BY t.priority DESC, t.created_at ASC LIMIT 1`
      : `SELECT t.* FROM tasks t WHERE ${RUNNABLE_TASK_SQL} ORDER BY t.priority DESC, t.created_at ASC LIMIT 1`;
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
    // Run gating is orthogonal to the role gate and NOT bypassable by
    // --any-role: use `relay task depend` to declare/release the prerequisite.
    if (!dependenciesMet(db, task)) {
      throw new Error(
        `cannot claim task ${taskId}: not yet runnable — prerequisite ${taskDependencies(db, taskId).join(", ")} is not done`
      );
    }
    if (task.role === "reviewer" && taskDependencies(db, taskId).length === 0 && !reviewPending(db)) {
      throw new Error(
        `cannot claim task ${taskId}: not yet runnable — a reviewer gate needs something in review (or declared deps)`
      );
    }
    db.query(
      `UPDATE tasks SET state = 'running', assignee = ?, lease_token = lease_token + 1,
        lease_until = ?, updated_at = ? WHERE id = ? AND state = 'queued'`
    ).run(workerId, t + leaseMs(), t, taskId);
    db.query(
      `UPDATE workers SET current_task_id = ?, state = 'working', last_seen_at = ?, last_progress_at = ?, nudged_at = NULL, updated_at = ? WHERE id = ?`
    ).run(taskId, t, t, t, workerId);
    clearQuietLogged(db, workerId, taskId); // a new task never inherits an old quiet lease
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
  clearQuietLogged(db, workerId, taskId); // resumed work ends any quiet lease
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
  // Decision (T151): unblock deliberately clears the owner/lease. A `queued`
  // task is unowned by invariant, and `block` already released the worker, so
  // there is no owner to preserve — preserving a lease would hand the next
  // claim a stale fence. The follow-on `submit` therefore gets STALE_LEASE and
  // now says to re-claim (see submitTask).
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
  if (task.assignee) clearQuietLogged(db, task.assignee, taskId);
  if (workerId !== task.assignee) clearQuietLogged(db, workerId, taskId);
  logEvent(db, { source: "worker", workerId, taskId, type: "task.released", payload: { reason: body } });
  return getTask(db, taskId)!;
}

/**
 * Grant a BOUNDED quiet lease on a RUNNING task the caller owns. The worker
 * stays `working` and the task stays `running`; only a deadline is recorded, so
 * a deliberate session-idle is not treated as an anomaly. Also renews the
 * heartbeat and extends the lease past the quiet deadline so `relay wait` is not
 * immediately followed by a lease expiry. Ownership is validated: another
 * worker's task cannot be quieted.
 */
export function waitTask(
  db: Database,
  taskId: string,
  workerId: string,
  durationMs: number,
  reason: string
): { until: number } {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (task.state !== "running") throw new Error(`cannot wait on task in state ${task.state}`);
  if (task.assignee !== workerId) {
    throw new Error(`cannot wait on ${taskId}: owned by ${task.assignee ?? "nobody"}, not ${workerId}`);
  }
  const w = getWorker(db, workerId);
  if (!w) throw new Error(`unknown worker: ${workerId}`);
  if (w.current_task_id !== taskId) throw new Error(`cannot wait on ${taskId}: ${workerId} does not hold it`);
  if (!(durationMs > 0)) throw new Error("duration must be positive");
  const t = now();
  const until = t + durationMs;
  setQuiet(db, workerId, taskId, until, reason);
  touchProgress(db, workerId, t);
  db.query(`UPDATE tasks SET lease_until = MAX(COALESCE(lease_until, 0), ?), updated_at = ? WHERE id = ?`)
    .run(until + leaseMs(), t, taskId);
  logEvent(db, {
    source: "worker",
    workerId,
    taskId,
    type: "worker.quiet_started",
    payload: { task: taskId, until, reason },
  });
  return { until };
}

export function getNotes(db: Database, taskId: string): { worker_id: string | null; kind: string; body: string; created_at: number }[] {
  return db.query(`SELECT worker_id, kind, body, created_at FROM task_notes WHERE task_id = ? ORDER BY id ASC`).all(taskId) as {
    worker_id: string | null; kind: string; body: string; created_at: number;
  }[];
}

/**
 * A note that states an explicit APPROVE verdict. Anchored to the start of a
 * line (optionally after a `verdict:` label) so prose that merely mentions the
 * word — "I cannot approve this yet" — is not mistaken for a verdict.
 */
const APPROVE_VERDICT = /(?:^|\n)\s*(?:verdict\s*[:=-]\s*)?APPROVE[D]?\b/i;

/**
 * Read-only advisory: tasks whose notes claim APPROVE but that were never
 * transitioned to a terminal state. Regression for T151 — a reviewer wrote a
 * free-form note whose body was an explicit "APPROVE" verdict but did not call
 * `relay approve`, so the task stayed queued/unowned and looked unreviewed.
 *
 * This only surfaces the mismatch (status/dashboard); it never changes state.
 * We deliberately do NOT let `approve` accept a queued/running task: that would
 * let one call mark unreviewed work done and bypass the review gate.
 */
export function notesClaimingApproval(
  db: Database
): { task: Task; note: { worker_id: string | null; kind: string; body: string; created_at: number } }[] {
  const open = db
    .query(`SELECT * FROM tasks WHERE state NOT IN ('done','failed') ORDER BY updated_at DESC`)
    .all() as Task[];
  const out: { task: Task; note: { worker_id: string | null; kind: string; body: string; created_at: number } }[] = [];
  for (const task of open) {
    const note = getNotes(db, task.id).reverse().find((n) => APPROVE_VERDICT.test(n.body));
    if (note) out.push({ task, note });
  }
  return out;
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
    // A blocked task that was `unblock`ed comes back as queued and UNOWNED
    // (queued tasks never carry an assignee/lease), so a re-review cannot just
    // submit: the caller must re-claim it first. Say so instead of only naming
    // the absent owner (`owned by nobody`), which reads as a bug.
    const owner = task.assignee ?? "nobody";
    const hint =
      task.state === "queued" && !task.assignee
        ? ` (task is queued and unowned — claim it first: relay claim ${taskId})`
        : ` (task is ${task.state})`;
    throw new Error(`${STALE_LEASE}: task ${taskId} is owned by ${owner} (token ${task.lease_token}), not ${workerId}${hint}`);
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
  clearQuietLogged(db, workerId, taskId);
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
    if (task.assignee) clearQuietLogged(db, task.assignee, taskId);
    clearQuietLogged(db, workerId, taskId);
    logEvent(db, { source: "reviewer", workerId, taskId, type: "task.approved" });
    const done = getTask(db, taskId)!;
    // One-hop completion bubbling to the IMMEDIATE parent (no recursion).
    bubbleChildDone(db, done, workerId, t);
    // The submitter always learns their OWN task's outcome. When the submitter
    // is also the parent's assignee, the child_done message above already told
    // them, so skip the duplicate (never two notices to one mailbox for one
    // event).
    const parentAssignee = done.parent_task_id ? getTask(db, done.parent_task_id)?.assignee ?? null : null;
    notifySubmitter(db, done, "review_done", `${RELAY_TAG}${done.id} approved: ${done.title}`, parentAssignee);
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
      sendMessage(db, "relay", parent.assignee, `${RELAY_TAG}All direct children of ${parentId} are done (${counts.done}/${counts.total}).`, {
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

/**
 * Notify the SUBMITTER of a task's review outcome. The submitter is the task's
 * `assignee` at review time (`submitTask` keeps it). A TOP-LEVEL task has no
 * parent to bubble to, so without this its author never learns the verdict — the
 * live T188/T190/T197 reviews completed silently and the coordinator only found
 * out by polling.
 *
 * Durable message from `relay` (same machinery as child_done/child_blocked); the
 * reconciler's mail nudge delivers the wake. `skipRecipient` is the immediate
 * parent's assignee when the parent bubble already messaged them for this same
 * event, so we never drop two notices into one mailbox for one outcome.
 */
function notifySubmitter(
  db: Database,
  task: Task,
  kind: "review_done" | "review_rejected",
  body: string,
  skipRecipient: string | null
): void {
  const submitter = task.assignee;
  if (!submitter || submitter === skipRecipient) return;
  sendMessage(db, "relay", submitter, body, { kind, taskId: task.id });
  logEvent(db, {
    source: "supervisor",
    workerId: submitter,
    taskId: task.id,
    type: "task.review_outcome",
    payload: { kind },
  });
}

/**
 * One-hop roll-up of a BLOCKED/FAILED child, mirroring bubbleChildDone. A
 * supervisor must learn that a subtree is stuck without polling: record a
 * `child_blocked` note on the immediate parent (+ `children_blocked` when ALL
 * direct children are blocked/failed) and send a durable message to the parent's
 * current assignee. No recursion; no automatic parent state change.
 */
function bubbleChildBlocked(db: Database, child: Task, actor: string, reason: string, at: number): void {
  const parentId = child.parent_task_id;
  if (!parentId) return;
  const parent = getTask(db, parentId);
  if (!parent) return; // dangling parent: the child is still blocked
  const body = `${RELAY_TAG}${child.id} ${child.state}${reason ? `: ${reason}` : ""}`;
  db.query(
    `INSERT INTO task_notes (task_id, worker_id, kind, body, created_at) VALUES (?, ?, 'child_blocked', ?, ?)`
  ).run(parentId, actor, body, at);

  const counts = db
    .query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN state IN ('blocked_internal','blocked_human','failed') THEN 1 ELSE 0 END) AS blocked
         FROM tasks WHERE parent_task_id = ?`
    )
    .get(parentId) as { total: number; blocked: number };
  const allBlocked = counts.total > 0 && counts.blocked === counts.total;
  if (allBlocked) {
    db.query(
      `INSERT INTO task_notes (task_id, worker_id, kind, body, created_at) VALUES (?, ?, 'children_blocked', ?, ?)`
    ).run(parentId, actor, `${RELAY_TAG}All direct children of ${parentId} are blocked (${counts.blocked}/${counts.total}).`, at);
  }

  if (parent.assignee) {
    sendMessage(db, "relay", parent.assignee, body, { kind: "child_blocked", taskId: parentId });
    if (allBlocked) {
      sendMessage(db, "relay", parent.assignee, `${RELAY_TAG}All direct children of ${parentId} are blocked (${counts.blocked}/${counts.total}).`, {
        kind: "children_blocked",
        taskId: parentId,
      });
    }
  }
  logEvent(db, {
    source: "supervisor",
    taskId: parentId,
    type: "task.child_blocked",
    payload: { child: child.id, state: child.state, allBlocked, assignee: parent.assignee ?? null },
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
  if (task.assignee) clearQuietLogged(db, task.assignee, taskId);
  clearQuietLogged(db, workerId, taskId);
  logEvent(db, { source: "reviewer", workerId, taskId, type: "task.rejected", payload: { reason } });
  // The submitter learns the rejection even when the task is top-level (there is
  // no parent bubble on the reject path).
  notifySubmitter(db, task, "review_rejected", `${RELAY_TAG}${task.id} rejected: ${reason}`, null);
  return getTask(db, taskId)!;
}

export function blockTask(db: Database, taskId: string, workerId: string, reason: string, human: boolean): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  const t = now();
  const state: TaskState = human ? "blocked_human" : "blocked_internal";
  // Durable first, in ONE transaction: the block, its parent notification (note +
  // message) and the worker release either all commit or none do.
  db.transaction(() => {
    db.query(`INSERT INTO task_notes (task_id, worker_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      taskId, workerId, human ? "blocked_human" : "blocked_internal", reason, t
    );
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
    if (task.assignee) clearQuietLogged(db, task.assignee, taskId);
    clearQuietLogged(db, workerId, taskId);
    logEvent(db, { source: "worker", workerId, taskId, type: human ? "task.blocked_human" : "task.blocked_internal", payload: { reason } });
    // One-hop roll-up: the immediate parent assignee must learn a child is stuck.
    bubbleChildBlocked(db, getTask(db, taskId)!, workerId, reason, t);
  })();
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
  return db
    .query(`SELECT t.* FROM tasks t WHERE ${RUNNABLE_TASK_SQL} ORDER BY t.priority DESC, t.created_at ASC`)
    .all() as Task[];
}

export function reviewTasks(db: Database): Task[] {
  return db.query(`SELECT * FROM tasks WHERE state = 'review' ORDER BY priority DESC, created_at ASC`).all() as Task[];
}

export function unfinishedCount(db: Database): number {
  const r = db.query(`SELECT COUNT(*) AS n FROM tasks WHERE state != 'done' AND state != 'failed'`).get() as { n: number };
  return r.n;
}
