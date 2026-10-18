import type { Database } from "bun:sqlite";
import { now } from "./db";
import { logEvent } from "./events";
import { RELAY_TAG, sendMessage } from "./messages";
import type { ResultKind, Task, TaskResult } from "./schema";

/**
 * Low-level structured-result storage (ISH-758). This module deliberately imports
 * NOTHING from `src/tasks.ts` or `src/workflow.ts`, so both the core task machine
 * (a blocked child) and the workflow transitions can record results without an
 * import cycle. It is pure SQL + notifications; the phase graph lives in
 * `src/workflow.ts`.
 */

export interface TaskResultInput {
  taskId: string;
  phase: string;
  attempt: number;
  kind: ResultKind;
  workerId?: string | null;
  passed?: boolean | null;
  headSha?: string | null;
  profile?: string | null;
  evidenceRef?: string | null;
  reason?: string | null;
  payload?: unknown;
  /**
   * ISH-904: a DELIBERATE replacement of the result with this id. Without it a
   * repeated write for the same (task, phase, attempt, kind) is idempotent (the
   * existing row is returned); with it the existing row is replaced in place so
   * a superseding verdict does not hit the identity UNIQUE constraint.
   */
  supersedes?: number;
}

/** The durable error code a failed result write reports (never a crash only). */
export const RESULT_WRITE_ERROR = "RESULT_WRITE_ERROR";

/** A structured-result write failed. Callers must not swallow this as a refusal. */
export class ResultWriteError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ResultWriteError";
  }
}

export function isResultWriteError(e: unknown): e is ResultWriteError {
  return e instanceof ResultWriteError;
}

/**
 * ISH-904: a failed result write must never leave a Task half-applied. Park it
 * `blocked_internal` with the concrete error (idempotent: the same reason is
 * recorded once). Deliberately a direct SQL write: this module must not import
 * the task/workflow machine (import cycle) and the block must survive even when
 * the caller's transaction rolls back — it is best-effort here and retried by
 * the Factory's own catch outside the failed transaction.
 */
export function markTaskBlockedInternal(db: Database, taskId: string, reason: string): void {
  try {
    const task = db.query(`SELECT state FROM tasks WHERE id = ?`).get(taskId) as { state: string } | null;
    if (!task) return;
    if (task.state === "done" || task.state === "failed" || task.state === "cancelled") return;
    const t = now();
    db.transaction(() => {
      db.query(
        `UPDATE tasks SET state = 'blocked_internal', assignee = NULL, lease_until = NULL,
           lease_token = lease_token + 1, updated_at = ? WHERE id = ?`
      ).run(t, taskId);
      const seen = db
        .query(`SELECT id FROM task_notes WHERE task_id = ? AND kind = 'blocked_internal' AND body = ? LIMIT 1`)
        .get(taskId, reason) as { id: number } | null;
      if (!seen) {
        db.query(`INSERT INTO task_notes (task_id, worker_id, kind, body, created_at) VALUES (?, 'relay', 'blocked_internal', ?, ?)`).run(
          taskId,
          reason,
          t
        );
      }
      logEvent(db, {
        source: "workflow",
        taskId,
        type: "task.blocked_internal",
        payload: { reason, source: "result-write" },
      });
    })();
  } catch {
    /* the original write failure is the actionable error; parking is best effort */
  }
}

export function getTaskResult(db: Database, id: number): TaskResult | null {
  return (db.query(`SELECT * FROM task_results WHERE id = ?`).get(id) as TaskResult | null) ?? null;
}

export function findTaskResult(
  db: Database,
  taskId: string,
  phase: string,
  attempt: number,
  kind: ResultKind
): TaskResult | null {
  return (
    (db
      .query(
        `SELECT * FROM task_results WHERE task_id = ? AND phase = ? AND attempt = ? AND kind = ?`
      )
      .get(taskId, phase, attempt, kind) as TaskResult | null) ?? null
  );
}

/**
 * ISH-761: the review EPOCH for a task at a head — the attempt of the latest
 * BASE-RETARGET (`reason = "base-changed"`) review invalidation recorded at that
 * head, or 0 when the review has never been re-opened by a retarget.
 *
 * A base retarget keeps the SAME HEAD but re-opens the review at a new attempt.
 * Reviews recorded before that attempt judged the OLD base's diff and must not make
 * a fresh review look like a duplicate. Keying on the epoch (the attempt) rather
 * than the base NAME also covers a revert (main -> release-1 -> main) and legacy
 * rows / rows recorded before the base was known (no base key at all).
 */
export function reviewEpochAttempt(db: Database, taskId: string, head: string | null): number {
  const row = db
    .query(
      `SELECT MAX(CAST(json_extract(payload_json, '$.attempt') AS INTEGER)) AS a
         FROM events
        WHERE task_id = ? AND type = 'workflow.review_invalidated'
          AND json_extract(payload_json, '$.reason') = 'base-changed'
          AND json_extract(payload_json, '$.toHead') IS ?`
    )
    .get(taskId, head) as { a: number | null } | null;
  return row?.a ?? 0;
}

/**
 * Any ReviewResult already recorded for this exact PR head + review profile IN
 * THE CURRENT REVIEW EPOCH.
 *
 * The duplicate guard is scoped by the review EPOCH (`reviewEpochAttempt`), NOT by
 * the base NAME: a base name can coincide again after a revert, and a review
 * recorded before the base was known (or a legacy row with no base key) would
 * otherwise act as an over-broad wildcard. Reviews from before the latest
 * base-retarget invalidation are ignored, so a fresh review of the retargeted diff
 * is accepted, while a rework that never retargeted is still refused as a duplicate.
 */
export function findReviewForHead(
  db: Database,
  taskId: string,
  headSha: string | null,
  profile: string
): TaskResult | null {
  if (!headSha) return null;
  const epoch = reviewEpochAttempt(db, taskId, headSha);
  return (
    (db
      .query(
        `SELECT * FROM task_results
          WHERE task_id = ? AND kind = 'ReviewResult' AND head_sha = ? AND profile = ? AND attempt >= ?
          ORDER BY id ASC LIMIT 1`
      )
      .get(taskId, headSha, profile, epoch) as TaskResult | null) ?? null
  );
}

/** The newest PASSING ReviewResult for a given attempt (the gate's authority). */
export function findPassingReview(db: Database, taskId: string, attempt: number): TaskResult | null {
  return (
    (db
      .query(
        `SELECT * FROM task_results
          WHERE task_id = ? AND attempt = ? AND kind = 'ReviewResult' AND passed = 1
          ORDER BY id DESC LIMIT 1`
      )
      .get(taskId, attempt) as TaskResult | null) ?? null
  );
}

/** The TaskSubmitted that started the current attempt (its author may not review). */
export function findSubmissionForAttempt(db: Database, taskId: string, attempt: number): TaskResult | null {
  return (
    (db
      .query(
        `SELECT * FROM task_results
          WHERE task_id = ? AND attempt = ? AND kind = 'TaskSubmitted'
          ORDER BY id DESC LIMIT 1`
      )
      .get(taskId, attempt) as TaskResult | null) ?? null
  );
}

/** Every ReviewResult recorded at an exact head, oldest first. */
export function listReviewsAtHead(db: Database, taskId: string, headSha: string | null): TaskResult[] {
  if (!headSha) return [];
  return db
    .query(
      `SELECT * FROM task_results
        WHERE task_id = ? AND kind = 'ReviewResult' AND head_sha = ?
        ORDER BY id ASC`
    )
    .all(taskId, headSha) as TaskResult[];
}

/**
 * ISH-759: an NG at this HEAD that no LATER review at the same head has cleared.
 * A later OK at the same head does not, by itself, clear it — the pass must
 * explicitly supersede the NG (see `recordReview({supersedesResultId})`).
 */
export function findUnresolvedNgAtHead(db: Database, taskId: string, headSha: string | null): TaskResult | null {
  const reviews = listReviewsAtHead(db, taskId, headSha);
  const last = reviews[reviews.length - 1];
  return last && last.passed === 0 ? last : null;
}

/** The TaskMerged result for a task, if the bound PR was confirmed merged. */
export function findMergedResult(db: Database, taskId: string): TaskResult | null {
  return (
    (db
      .query(`SELECT * FROM task_results WHERE task_id = ? AND kind = 'TaskMerged' ORDER BY id DESC LIMIT 1`)
      .get(taskId) as TaskResult | null) ?? null
  );
}

/**
 * Write one structured result.
 *
 * ISH-904: a repeated write for the same (task, phase, attempt, kind) is
 * IDEMPOTENT — the existing row is returned instead of crashing on the identity
 * UNIQUE constraint when a Factory retry/resume replays a stage. A caller that
 * deliberately REPLACES a result (a superseding review verdict) passes
 * `supersedes: <id>`; the row is then updated in place (same id, same
 * (task, phase, attempt, kind) identity), which is what makes `--supersedes`
 * actually accept the replacement verdict at the same attempt.
 *
 * On any OTHER write failure the Task is parked `blocked_internal` with the
 * concrete error and a `ResultWriteError` is thrown — callers must rethrow it
 * rather than treating it as a normal refusal, so a half-applied phase is never
 * left behind.
 */
export function insertTaskResult(db: Database, r: TaskResultInput): TaskResult {
  const existing = findTaskResult(db, r.taskId, r.phase, r.attempt, r.kind);
  if (existing && r.supersedes === undefined) {
    logEvent(db, {
      source: "workflow",
      workerId: r.workerId ?? null,
      taskId: r.taskId,
      type: "workflow.result.idempotent",
      payload: { id: existing.id, phase: r.phase, attempt: r.attempt, kind: r.kind },
    });
    return existing;
  }
  const t = now();
  try {
    if (existing && r.supersedes !== undefined) {
      // A deliberate replacement of an existing result row. The row id is kept so
      // a `result:<id>` reference and the attempt history stay resolvable.
      db.query(
        `UPDATE task_results
            SET worker_id = ?, passed = ?, head_sha = ?, profile = ?, evidence_ref = ?,
                reason = ?, payload_json = ?, created_at = ?
          WHERE id = ?`
      ).run(
        r.workerId ?? null,
        r.passed === undefined || r.passed === null ? null : r.passed ? 1 : 0,
        r.headSha ?? null,
        r.profile ?? null,
        r.evidenceRef ?? null,
        r.reason ?? null,
        JSON.stringify(r.payload ?? {}),
        t,
        existing.id
      );
      logEvent(db, {
        source: "workflow",
        workerId: r.workerId ?? null,
        taskId: r.taskId,
        type: "workflow.result.superseded",
        payload: { id: existing.id, phase: r.phase, attempt: r.attempt, kind: r.kind, supersedes: r.supersedes },
      });
      return getTaskResult(db, existing.id)!;
    }
    const row = db
      .query(
        `INSERT OR IGNORE INTO task_results
           (task_id, phase, attempt, kind, worker_id, passed, head_sha, profile, evidence_ref, reason, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        r.taskId,
        r.phase,
        r.attempt,
        r.kind,
        r.workerId ?? null,
        r.passed === undefined || r.passed === null ? null : r.passed ? 1 : 0,
        r.headSha ?? null,
        r.profile ?? null,
        r.evidenceRef ?? null,
        r.reason ?? null,
        JSON.stringify(r.payload ?? {}),
        t
      );
    // INSERT OR IGNORE: a concurrent writer may have won the identity race. The
    // row that exists is authoritative; never crash the caller for that.
    const id = Number(row.lastInsertRowid);
    if (!id || Number(row.changes) === 0) {
      const winner = findTaskResult(db, r.taskId, r.phase, r.attempt, r.kind);
      if (winner) {
        logEvent(db, {
          source: "workflow",
          workerId: r.workerId ?? null,
          taskId: r.taskId,
          type: "workflow.result.idempotent",
          payload: { id: winner.id, phase: r.phase, attempt: r.attempt, kind: r.kind },
        });
        return winner;
      }
      throw new Error("result insert was ignored and no existing row could be read");
    }
    logEvent(db, {
      source: "workflow",
      workerId: r.workerId ?? null,
      taskId: r.taskId,
      type: `workflow.result.${r.kind}`,
      payload: { id, phase: r.phase, attempt: r.attempt, passed: r.passed ?? null, head: r.headSha ?? null, reason: r.reason ?? null },
    });
    return getTaskResult(db, id)!;
  } catch (e) {
    if (isResultWriteError(e)) throw e;
    const detail = e instanceof Error ? e.message : String(e);
    const message = `${RESULT_WRITE_ERROR}: ${r.kind} for ${r.taskId} phase '${r.phase}' attempt ${r.attempt} failed: ${detail}`;
    // Best effort: when this runs inside the caller's transaction the block rolls
    // back with it; the Factory's catch re-applies it after the rollback.
    markTaskBlockedInternal(db, r.taskId, message);
    throw new ResultWriteError(message, e);
  }
}

/**
 * Send a durable message to an explicit recipient (the resolved Gateway). The
 * caller resolves the recipient so this module needs no task import.
 */
export function notifyGatewayTo(
  db: Database,
  recipient: string | null,
  task: Pick<Task, "id">,
  body: string,
  kind: string
): boolean {
  if (!recipient) {
    logEvent(db, { source: "workflow", taskId: task.id, type: "workflow.gateway_unrouted", payload: { kind } });
    return false;
  }
  sendMessage(db, "relay", recipient, `${RELAY_TAG}${body}`, { kind, taskId: task.id });
  logEvent(db, { source: "workflow", workerId: recipient, taskId: task.id, type: "workflow.gateway_notified", payload: { kind } });
  return true;
}
