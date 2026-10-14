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

/** Any ReviewResult already recorded for this exact PR head + review profile. */
export function findReviewForHead(
  db: Database,
  taskId: string,
  headSha: string | null,
  profile: string
): TaskResult | null {
  if (!headSha) return null;
  return (
    (db
      .query(
        `SELECT * FROM task_results
          WHERE task_id = ? AND kind = 'ReviewResult' AND head_sha = ? AND profile = ?
          ORDER BY id ASC LIMIT 1`
      )
      .get(taskId, headSha, profile) as TaskResult | null) ?? null
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

export function insertTaskResult(db: Database, r: TaskResultInput): TaskResult {
  const t = now();
  const row = db
    .query(
      `INSERT INTO task_results
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
  const id = Number(row.lastInsertRowid);
  logEvent(db, {
    source: "workflow",
    workerId: r.workerId ?? null,
    taskId: r.taskId,
    type: `workflow.result.${r.kind}`,
    payload: { id, phase: r.phase, attempt: r.attempt, passed: r.passed ?? null, head: r.headSha ?? null, reason: r.reason ?? null },
  });
  return getTaskResult(db, id)!;
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
