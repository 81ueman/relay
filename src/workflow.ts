import type { Database } from "bun:sqlite";
import { now } from "./db";
import { logEvent } from "./events";
import { requestReconcile } from "./control";
import {
  findReviewForHead,
  findPassingReview,
  findSubmissionForAttempt,
  findTaskResult,
  insertTaskResult,
  notifyGatewayTo,
} from "./results";
import type { CodePhase, ResultKind, Task, TaskState } from "./schema";
import { INTEGRATOR_ROLE, REVIEWER_ROLE } from "./schema";
import { getTask, nextTaskId, resolveHumanInterface, taskChildren } from "./tasks";
import { clearCurrentTask, getWorker, normalizeWorkerAfterTaskRelease, touchProgress } from "./workers";

/**
 * ISH-758 minimal event-driven workflow core.
 *
 * The Task table is the single source of truth. A code-change task carries a
 * `phase` (implement -> verify -> review -> integration -> merge_ready) and the
 * existing `state` column stays the lifecycle (queued/running/review/blocked/
 * done/failed). A STRUCTURED RESULT (src/schema.ts RESULT_KINDS) is the only
 * thing that advances a phase — `relay send` prose is never parsed for it.
 *
 * Every transition (a) records the structured result, (b) updates the Task and
 * (c) releases the worker in ONE db.transaction, then bumps the reconcile token
 * so the daemon wakes IMMEDIATELY. There is no separate queue/outbox/engine.
 */

export const WORKFLOW_ERROR = "WORKFLOW";
export const GATE_ERROR = "CODE_CHANGE_GATE";
export const AUTHORITY_ERROR = "AUTHORITY";
export const STALE_ATTEMPT = "STALE_ATTEMPT";
export const DUPLICATE_DISPATCH = "DUPLICATE_DISPATCH";
export const HEAD_MISMATCH = "HEAD_MISMATCH";

/** The default review profile; a second profile is a genuinely different review. */
export const DEFAULT_REVIEW_PROFILE = "default";

// Re-exported so callers (daemon/tests) have one workflow entrypoint.
export { requestReconcile, reconcileRequestToken } from "./control";
export { recordChildBlocked } from "./tasks";
export { findTaskResult, findReviewForHead, findPassingReview } from "./results";

// ---------------------------------------------------------------------------
// Phase graph + authority
// ---------------------------------------------------------------------------

const NEXT_PHASE: Record<CodePhase, CodePhase | null> = {
  implement: "verify",
  verify: "review",
  review: "integration",
  integration: "merge_ready",
  merge_ready: null,
};

export function isCodeTask(task: Pick<Task, "code_change">): boolean {
  return task.code_change === 1;
}

/** The single next phase; `merge_ready` is terminal for the phase machine. */
export function nextPhase(phase: CodePhase): CodePhase | null {
  return NEXT_PHASE[phase];
}

/**
 * The functional authority a phase demands. Roles are defined by
 * task-type + authority (implement/verify/review/integrate/accept) rather than a
 * role per lane. Implement and verify share the task's declared role (an
 * independent verifier is a policy refinement, not a minimal-core requirement);
 * review demands the reviewer authority and integration/accept the integrator or
 * Gateway authority.
 */
export type Authority = "implement" | "verify" | "review" | "integrate" | "accept";

export function authorityForPhase(phase: CodePhase): Authority {
  switch (phase) {
    case "implement":
      return "implement";
    case "verify":
      return "verify";
    case "review":
      return "review";
    case "integration":
      return "integrate";
    case "merge_ready":
      return "accept";
  }
}

/** The role a queued phase presents as its claim gate (`claim_role`). */
export function claimRoleForPhase(phase: CodePhase, taskRole: string | null): string | null {
  if (phase === "review") return REVIEWER_ROLE;
  if (phase === "integration") return INTEGRATOR_ROLE;
  if (phase === "merge_ready") return null; // awaiting acceptance, not claimable
  return taskRole; // implement / verify: the task's own role (null = any worker)
}

/**
 * "Fill in missing phases from the current SQLite state": a code task that
 * predates the phase column (or was written by an older path) resolves its phase
 * from `state` instead of guessing.
 */
export function derivePhase(task: Task): CodePhase | null {
  if (!isCodeTask(task)) return null;
  if (task.phase) return task.phase;
  switch (task.state) {
    case "review":
      return "review";
    case "done":
      return "merge_ready";
    case "queued":
    case "running":
    default:
      return "implement";
  }
}

// ---------------------------------------------------------------------------
// Durable phase updates + worker release
// ---------------------------------------------------------------------------

interface PhaseUpdate {
  state: TaskState;
  attempt: number;
  claimRole: string | null;
  assignee?: string | null;
  /** When provided (not undefined), overwrite head_sha. */
  headSha?: string | null;
  /** Force head_sha to NULL (rework: the previous PASS no longer applies). */
  clearHead?: boolean;
  resultRef?: string | null;
  acceptedAt?: number | null;
}

/**
 * Apply a phase/state update and bump the lease token (fencing). Every phase
 * move releases ownership: `assignee` defaults to NULL and `lease_until` is
 * cleared, so a worker that still holds the pre-transition task can never submit
 * it again with a stale token.
 */
function applyPhase(db: Database, task: Task, phase: CodePhase, u: PhaseUpdate): Task {
  const t = now();
  const headProvided = u.headSha !== undefined ? 1 : 0;
  db.query(
    `UPDATE tasks
        SET phase = ?, state = ?, assignee = ?, claim_role = ?, attempt = ?,
            head_sha = CASE WHEN ? = 1 THEN NULL WHEN ? = 1 THEN ? ELSE head_sha END,
            result_ref = ?, accepted_at = ?,
            lease_token = lease_token + 1, lease_until = NULL, updated_at = ?
      WHERE id = ?`
  ).run(
    phase,
    u.state,
    u.assignee ?? null,
    u.claimRole,
    u.attempt,
    u.clearHead ? 1 : 0,
    headProvided,
    u.headSha ?? null,
    u.resultRef ?? null,
    u.acceptedAt ?? null,
    t,
    task.id
  );
  return getTask(db, task.id)!;
}

/**
 * A HEAD change after the review phase invalidates the pending/prior review:
 * send the task BACK to review at a new attempt, so a PASS can never survive a
 * moved HEAD. Must be called inside a transaction.
 */
function invalidateReview(db: Database, task: Task, newHead: string | null, reason: string, workerId?: string): Task {
  const t = now();
  db.query(
    `UPDATE tasks
        SET phase = 'review', state = 'review', claim_role = ?, assignee = NULL,
            attempt = attempt + 1, head_sha = ?,
            lease_token = lease_token + 1, lease_until = NULL, updated_at = ?
      WHERE id = ?`
  ).run(REVIEWER_ROLE, newHead, t, task.id);
  logEvent(db, {
    source: "workflow",
    taskId: task.id,
    type: "workflow.review_invalidated",
    payload: { reason, fromHead: task.head_sha, toHead: newHead, fromPhase: task.phase, attempt: task.attempt + 1 },
  });
  if (workerId) releaseWorker(db, workerId, task.id);
  return getTask(db, task.id)!;
}

function releaseWorker(db: Database, workerId: string, taskId: string, at = now()): void {
  const w = getWorker(db, workerId);
  if (w && w.current_task_id === taskId) clearCurrentTask(db, workerId);
  normalizeWorkerAfterTaskRelease(db, workerId, at);
  touchProgress(db, workerId, at);
}

function assertOwned(task: Task, workerId: string, leaseToken?: number): void {
  if (task.assignee !== workerId) {
    throw new Error(
      `STALE_LEASE: task ${task.id} is owned by ${task.assignee ?? "nobody"} (token ${task.lease_token}), not ${workerId}`
    );
  }
  if (leaseToken !== undefined && leaseToken !== task.lease_token) {
    throw new Error(
      `STALE_LEASE: task ${task.id} token mismatch (have ${leaseToken}, want ${task.lease_token})`
    );
  }
  if (task.state !== "running") {
    throw new Error(`${STALE_ATTEMPT}: task ${task.id} is ${task.state}, not running`);
  }
}

function phaseOf(task: Task): CodePhase {
  const p = derivePhase(task);
  if (!p) throw new Error(`${WORKFLOW_ERROR}: task ${task.id} is not a code-change task`);
  return p;
}

function assertNoResult(
  db: Database,
  taskId: string,
  phase: string,
  attempt: number,
  kind: ResultKind
): void {
  if (findTaskResult(db, taskId, phase, attempt, kind)) {
    throw new Error(
      `${DUPLICATE_DISPATCH}: ${kind} already recorded for ${taskId} phase '${phase}' attempt ${attempt}`
    );
  }
}

// ---------------------------------------------------------------------------
// Idempotent intake
// ---------------------------------------------------------------------------

export interface IntakeInput {
  provider: string;
  issueId: string;
  /** Slice of the issue; "" (the default) when omitted. */
  slice?: string | null;
  title?: string;
  description?: string;
  acceptance?: string;
  priority?: number;
  role?: string;
  codeChange?: boolean;
  parentTaskId?: string;
  prUrl?: string;
  branch?: string;
  headSha?: string;
  dependsOn?: string[];
}

function normalizeSlice(slice?: string | null): string {
  return (slice ?? "").trim();
}

export function findTaskByWorkIdentity(
  db: Database,
  provider: string,
  issueId: string,
  slice: string
): Task | null {
  return (
    (db
      .query(`SELECT * FROM tasks WHERE provider = ? AND issue_id = ? AND slice = ?`)
      .get(provider, issueId, slice) as Task | null) ?? null
  );
}

/**
 * Idempotent intake keyed by (provider, issue ID, slice). Replaying the same
 * intake returns the SAME Task; a different slice of the same issue is a
 * DIFFERENT Task. The unique index is the backstop for a concurrent insert.
 *
 * A replayed intake fills in any link (PR/branch/HEAD) it was previously missing
 * rather than creating a second row — and, per the HEAD invariant, a HEAD change
 * on a task already past review sends it back to review (see `linkTask`).
 */
export function intakeTask(db: Database, input: IntakeInput): Task {
  const provider = input.provider.trim();
  const issueId = input.issueId.trim();
  if (!provider) throw new Error(`${WORKFLOW_ERROR}: intake requires a provider`);
  if (!issueId) throw new Error(`${WORKFLOW_ERROR}: intake requires an issue id`);
  const slice = normalizeSlice(input.slice);

  const existing = findTaskByWorkIdentity(db, provider, issueId, slice);
  if (existing) {
    return linkTask(db, existing.id, {
      prUrl: input.prUrl,
      branch: input.branch,
      headSha: input.headSha,
    });
  }

  const t = now();
  const codeChange = input.codeChange === true;
  const id = nextTaskId(db);
  const dependsOn = [...new Set((input.dependsOn ?? []).map((d) => d.trim()).filter(Boolean))];
  try {
    db.transaction(() => {
      db.query(
        `INSERT INTO tasks
           (id, title, description, acceptance, state, priority, role, assignee,
            lease_token, lease_until, parent_task_id, plan_id,
            provider, issue_id, slice, code_change, phase, attempt, claim_role,
            pr_url, branch, head_sha, result_ref, review_profile, accepted_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, NULL, 0, NULL, ?, NULL,
                 ?, ?, ?, ?, ?, 0, NULL,
                 ?, ?, ?, NULL, NULL, NULL, ?, ?)`
      ).run(
        id,
        input.title ?? input.description ?? `${issueId}${slice ? `/${slice}` : ""}`,
        input.description ?? "",
        input.acceptance ?? "",
        input.priority ?? 0,
        input.role ?? null,
        input.parentTaskId ?? null,
        provider,
        issueId,
        slice,
        codeChange ? 1 : 0,
        codeChange ? "implement" : null,
        input.prUrl ?? null,
        input.branch ?? null,
        input.headSha ?? null,
        t,
        t
      );
      for (const dep of dependsOn) {
        db.query(`INSERT INTO task_deps (task_id, depends_on, created_at) VALUES (?, ?, ?)`).run(id, dep, t);
      }
    })();
  } catch (e) {
    // Lost an insert race: the winner's row is the task.
    const raced = findTaskByWorkIdentity(db, provider, issueId, slice);
    if (raced) return raced;
    throw e;
  }
  logEvent(db, {
    source: "workflow",
    taskId: id,
    type: "workflow.intake",
    payload: { provider, issueId, slice, codeChange },
  });
  requestReconcile(db, `intake:${id}`);
  return getTask(db, id)!;
}

/** Phases in which a HEAD change must send the task back to review. */
const REVIEW_PINNED_PHASES: CodePhase[] = ["review", "integration", "merge_ready"];

/**
 * Fill in / update the PR link on a task without clobbering existing values.
 *
 * HEAD is the review's identity: if the task is already at/past review and the
 * HEAD changes, the prior review no longer applies — the task is sent back to
 * review at a new attempt (a PASS can never survive a moved HEAD).
 */
export function linkTask(
  db: Database,
  taskId: string,
  link: { prUrl?: string | null; branch?: string | null; headSha?: string | null }
): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  const prUrl = link.prUrl ?? task.pr_url;
  const branch = link.branch ?? task.branch;
  const headSha = link.headSha ?? task.head_sha;
  const headChanged = headSha !== task.head_sha;
  if (!headChanged && prUrl === task.pr_url && branch === task.branch) return task;
  const updated = db.transaction(() => {
    db.query(`UPDATE tasks SET pr_url = ?, branch = ?, head_sha = ?, updated_at = ? WHERE id = ?`).run(
      prUrl,
      branch,
      headSha,
      now(),
      taskId
    );
    let next = getTask(db, taskId)!;
    const phase = derivePhase(task);
    if (headChanged && isCodeTask(task) && phase && REVIEW_PINNED_PHASES.includes(phase)) {
      next = invalidateReview(db, next, headSha, "head-changed");
    }
    return next;
  })();
  if (headChanged) requestReconcile(db, `link-head:${taskId}`);
  return updated;
}

// ---------------------------------------------------------------------------
// Transitions (structured results are the source of truth)
// ---------------------------------------------------------------------------

export interface SubmitOptions {
  evidence?: string;
  headSha?: string;
  leaseToken?: number;
}

/**
 * Record a TaskSubmitted for the current implement/integration phase and advance
 * to the next phase. A code task NEVER becomes `done` here — an implement submit
 * moves to `verify`, never to terminal.
 *
 * An integration submit that names a DIFFERENT HEAD invalidates the review PASS
 * (the task goes back to review) rather than advancing to merge_ready.
 */
export function submitPhase(db: Database, taskId: string, workerId: string, opts: SubmitOptions = {}): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (!isCodeTask(task)) {
    throw new Error(`${WORKFLOW_ERROR}: ${taskId} is not a code-change task; use \`relay submit\``);
  }
  const phase = phaseOf(task);
  if (phase !== "implement" && phase !== "integration") {
    throw new Error(
      `${WORKFLOW_ERROR}: cannot submit ${taskId} in phase '${phase}' (submit applies to implement/integration)`
    );
  }
  assertOwned(task, workerId, opts.leaseToken);

  // Integration names a moved HEAD: the reviewed head no longer applies.
  if (phase === "integration" && opts.headSha !== undefined && opts.headSha !== task.head_sha) {
    const invalidated = db.transaction(() =>
      invalidateReview(db, task, opts.headSha!, "integration-head-changed", workerId)
    )();
    requestReconcile(db, `head-changed:${taskId}`);
    return invalidated;
  }

  assertNoResult(db, taskId, phase, task.attempt, "TaskSubmitted");
  const next = nextPhase(phase)!;
  const updated = db.transaction(() => {
    const result = insertTaskResult(db, {
      taskId,
      phase,
      attempt: task.attempt,
      kind: "TaskSubmitted",
      workerId,
      headSha: opts.headSha ?? task.head_sha,
      evidenceRef: opts.evidence ?? null,
    });
    const u = applyPhase(db, task, next, {
      state: next === "review" ? "review" : "queued",
      attempt: task.attempt,
      claimRole: claimRoleForPhase(next, task.role),
      headSha: opts.headSha !== undefined ? opts.headSha : undefined,
      resultRef: `result:${result.id}`,
    });
    releaseWorker(db, workerId, taskId);
    return u;
  })();
  requestReconcile(db, `submit:${taskId}:${next}`);
  return updated;
}

export interface VerifyOptions {
  passed: boolean;
  evidence?: string;
  headSha?: string;
  leaseToken?: number;
}

/**
 * Record a VerificationResult. Verification is a real phase: a result submitted
 * while the task is in any OTHER phase is refused ("skipping a phase").
 */
export function recordVerification(
  db: Database,
  taskId: string,
  workerId: string,
  opts: VerifyOptions
): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (!isCodeTask(task)) throw new Error(`${WORKFLOW_ERROR}: ${taskId} is not a code-change task`);
  const phase = phaseOf(task);
  if (phase !== "verify") {
    throw new Error(`${WORKFLOW_ERROR}: cannot record a verification for ${taskId} in phase '${phase}'`);
  }
  assertOwned(task, workerId, opts.leaseToken);
  assertNoResult(db, taskId, phase, task.attempt, "VerificationResult");

  if (opts.passed) {
    const updated = db.transaction(() => {
      const result = insertTaskResult(db, {
        taskId,
        phase,
        attempt: task.attempt,
        kind: "VerificationResult",
        workerId,
        passed: true,
        headSha: opts.headSha ?? task.head_sha,
        evidenceRef: opts.evidence ?? null,
      });
      const u = applyPhase(db, task, "review", {
        state: "review",
        attempt: task.attempt,
        claimRole: REVIEWER_ROLE,
        headSha: opts.headSha !== undefined ? opts.headSha : undefined,
        resultRef: `result:${result.id}`,
      });
      releaseWorker(db, workerId, taskId);
      return u;
    })();
    requestReconcile(db, `verified:${taskId}`);
    return updated;
  }

  // Failed verification: rework. A new attempt, head cleared (the old head's
  // verification no longer applies).
  const updated = db.transaction(() => {
    const result = insertTaskResult(db, {
      taskId,
      phase,
      attempt: task.attempt,
      kind: "VerificationResult",
      workerId,
      passed: false,
      headSha: opts.headSha ?? task.head_sha,
      evidenceRef: opts.evidence ?? null,
    });
    const u = applyPhase(db, task, "implement", {
      state: "queued",
      attempt: task.attempt + 1,
      claimRole: claimRoleForPhase("implement", task.role),
      clearHead: true,
      resultRef: `result:${result.id}`,
    });
    releaseWorker(db, workerId, taskId);
    return u;
  })();
  requestReconcile(db, `verify-failed:${taskId}`);
  return updated;
}

export interface ReviewOptions {
  verdict: "pass" | "fail";
  headSha?: string;
  profile?: string;
  reason?: string;
  evidence?: string;
}

/**
 * Record a structured ReviewResult. A PASS is invalid once the HEAD moves: the
 * reviewed head must match the task's current head, and a ReviewResult for the
 * same (task, head, profile) is refused as a duplicate dispatch.
 *
 * Authority: the reviewer must hold the REVIEWER_ROLE (or the review claim taken
 * via `relay next`), and may not be the worker that recorded the TaskSubmitted
 * for this attempt.
 */
export function recordReview(db: Database, taskId: string, reviewerId: string, opts: ReviewOptions): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (!isCodeTask(task)) throw new Error(`${WORKFLOW_ERROR}: ${taskId} is not a code-change task`);
  const phase = phaseOf(task);
  if (task.state !== "review" || phase !== "review") {
    throw new Error(`${WORKFLOW_ERROR}: cannot record a review for ${taskId} (state ${task.state}, phase ${phase})`);
  }
  const reviewer = getWorker(db, reviewerId);
  if (!reviewer) throw new Error(`unknown worker: ${reviewerId}`);
  const holdsClaim = task.assignee === reviewerId;
  if (reviewer.role !== REVIEWER_ROLE && !holdsClaim) {
    throw new Error(
      `${AUTHORITY_ERROR}: ${reviewerId} (role '${reviewer.role}') may not review ${taskId}; ` +
      `need role '${REVIEWER_ROLE}' or the review claim taken via \`relay next\``
    );
  }
  const submission = findSubmissionForAttempt(db, taskId, task.attempt);
  if (submission && submission.worker_id === reviewerId) {
    throw new Error(
      `${AUTHORITY_ERROR}: ${reviewerId} recorded the TaskSubmitted for ${taskId} attempt ${task.attempt} and may not review its own work`
    );
  }
  if (task.assignee && task.assignee !== reviewerId) {
    throw new Error(`${WORKFLOW_ERROR}: review of ${taskId} is held by ${task.assignee}, not ${reviewerId}`);
  }
  const profile = (opts.profile ?? task.review_profile ?? DEFAULT_REVIEW_PROFILE).trim() || DEFAULT_REVIEW_PROFILE;

  // HEAD is the review's identity. A review that does not name the current head
  // cannot invalidate it; a mismatched one is a stale review of a moved head.
  const head = opts.headSha ?? task.head_sha;
  if (task.head_sha && opts.headSha && opts.headSha !== task.head_sha) {
    throw new Error(`${HEAD_MISMATCH}: review head ${opts.headSha} != task head ${task.head_sha} for ${taskId}`);
  }
  if (opts.verdict === "pass" && task.head_sha && !opts.headSha) {
    throw new Error(`${HEAD_MISMATCH}: a PASS must name the reviewed HEAD (task ${taskId} is at ${task.head_sha})`);
  }
  // Duplicate dispatch: the same PR+HEAD+profile is reviewed once.
  if (findReviewForHead(db, taskId, head, profile)) {
    throw new Error(`${DUPLICATE_DISPATCH}: ${taskId} head ${head} already has a review (profile '${profile}')`);
  }
  assertNoResult(db, taskId, phase, task.attempt, "ReviewResult");

  if (opts.verdict === "pass") {
    const updated = db.transaction(() => {
      const result = insertTaskResult(db, {
        taskId,
        phase,
        attempt: task.attempt,
        kind: "ReviewResult",
        workerId: reviewerId,
        passed: true,
        headSha: head,
        profile,
        reason: opts.reason ?? null,
        evidenceRef: opts.evidence ?? null,
      });
      const u = applyPhase(db, task, "integration", {
        state: "queued",
        attempt: task.attempt,
        claimRole: INTEGRATOR_ROLE,
        resultRef: `result:${result.id}`,
      });
      releaseWorker(db, reviewerId, taskId);
      return u;
    })();
    requestReconcile(db, `review-pass:${taskId}`);
    return updated;
  }

  const updated = db.transaction(() => {
    const result = insertTaskResult(db, {
      taskId,
      phase,
      attempt: task.attempt,
      kind: "ReviewResult",
      workerId: reviewerId,
      passed: false,
      headSha: head,
      profile,
      reason: opts.reason ?? null,
      evidenceRef: opts.evidence ?? null,
    });
    const u = applyPhase(db, task, "implement", {
      state: "queued",
      attempt: task.attempt + 1,
      claimRole: claimRoleForPhase("implement", task.role),
      clearHead: true,
      resultRef: `result:${result.id}`,
    });
    releaseWorker(db, reviewerId, taskId);
    return u;
  })();
  requestReconcile(db, `review-fail:${taskId}`);
  return updated;
}

/**
 * TaskAccepted — the ONLY way a code-change task becomes terminal. Requires:
 *   - the task at `merge_ready`;
 *   - a passing ReviewResult for the CURRENT attempt whose head equals the
 *     task's current head (a PASS cannot survive a moved HEAD);
 *   - Gateway/human or integrator authority.
 * A bare approve/auto-approve can never satisfy any of these.
 */
export function acceptTask(db: Database, taskId: string, actor: string): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (!isCodeTask(task)) throw new Error(`${WORKFLOW_ERROR}: ${taskId} is not a code-change task`);
  const phase = phaseOf(task);
  if (phase !== "merge_ready") {
    throw new Error(
      `${GATE_ERROR}: cannot accept ${taskId} at phase '${phase}'; the code-change gate is satisfied only at merge_ready`
    );
  }

  // Authority: the Gateway/human for the task, or an integrator.
  const actorW = getWorker(db, actor);
  const isIntegrator = actorW?.role === INTEGRATOR_ROLE;
  const gateway = resolveHumanInterface(db, task);
  const isGateway = gateway !== null && gateway === actor;
  if (!isIntegrator && !isGateway) {
    throw new Error(
      `${AUTHORITY_ERROR}: ${actor} may not accept ${taskId}; need the Gateway/human (${gateway ?? "unresolved"}) or role '${INTEGRATOR_ROLE}'`
    );
  }

  // The gate's evidence: a passing review of the CURRENT head + attempt.
  const pass = findPassingReview(db, taskId, task.attempt);
  if (!pass) {
    throw new Error(`${GATE_ERROR}: ${taskId} has no passing review for attempt ${task.attempt}`);
  }
  if ((pass.head_sha ?? null) !== (task.head_sha ?? null)) {
    throw new Error(
      `${GATE_ERROR}: ${taskId} HEAD changed since the passing review ` +
      `(reviewed ${pass.head_sha ?? "none"}, now ${task.head_sha ?? "none"}); re-review required`
    );
  }

  assertNoResult(db, taskId, phase, task.attempt, "TaskAccepted");
  const t = now();
  const updated = db.transaction(() => {
    const result = insertTaskResult(db, {
      taskId,
      phase,
      attempt: task.attempt,
      kind: "TaskAccepted",
      workerId: actor,
    });
    const u = applyPhase(db, task, phase, {
      state: "done",
      attempt: task.attempt,
      claimRole: null,
      acceptedAt: t,
      resultRef: `result:${result.id}`,
    });
    releaseWorker(db, actor, taskId, t);
    notifyParentAccepted(db, u);
    return u;
  })();
  requestReconcile(db, `accept:${taskId}`);
  return updated;
}

// ---------------------------------------------------------------------------
// Child roll-up: the Gateway is notified only when needed
// ---------------------------------------------------------------------------

/** True once a code task has satisfied its mandatory gate. */
export function codeChangeGateSatisfied(task: Task): boolean {
  if (!isCodeTask(task)) return true;
  return derivePhase(task) === "merge_ready" && task.state === "done";
}

/**
 * On acceptance, tell the parent's Gateway ONLY when ALL direct children are
 * accepted (children-ready aggregation). Recorded as a durable ChildrenReady
 * result so it fires exactly once. Runs inside the caller's transaction.
 */
function notifyParentAccepted(db: Database, child: Task): void {
  const parentId = child.parent_task_id;
  if (!parentId) return;
  const parent = getTask(db, parentId);
  if (!parent) return;
  const kids = taskChildren(db, parentId);
  if (kids.length === 0) return;
  if (!kids.every((k) => k.state === "done")) return; // not ready yet
  if (findTaskResult(db, parentId, "", 0, "ChildrenReady")) return; // already told
  insertTaskResult(db, {
    taskId: parentId,
    phase: "",
    attempt: 0,
    kind: "ChildrenReady",
    payload: { children: kids.map((k) => k.id) },
  });
  notifyGatewayTo(db, resolveHumanInterface(db, parent), parent, `${parentId}: all ${kids.length} child task(s) are ready.`, "children_ready");
}

// ---------------------------------------------------------------------------
// Duplicate-dispatch guards for callers that start a phase
// ---------------------------------------------------------------------------

/**
 * True when `phase`/`attempt` has not already produced a result and the task's
 * current phase/attempt actually is that one — i.e. the phase may be started.
 */
export function canStartPhase(db: Database, taskId: string, phase: CodePhase, attempt: number): boolean {
  const task = getTask(db, taskId);
  if (!task || !isCodeTask(task)) return false;
  if ((task.phase ?? derivePhase(task)) !== phase) return false;
  if (task.attempt !== attempt) return false;
  if (phase === "review") return !findReviewForHead(db, taskId, task.head_sha, task.review_profile ?? DEFAULT_REVIEW_PROFILE);
  return !findTaskResult(db, taskId, phase, attempt, "TaskSubmitted");
}

/** Refuse a second start for the same Task/phase/attempt. */
export function assertStartable(db: Database, taskId: string, phase: CodePhase, attempt: number): void {
  if (!canStartPhase(db, taskId, phase, attempt)) {
    throw new Error(
      `${DUPLICATE_DISPATCH}: ${taskId} phase '${phase}' attempt ${attempt} is already started or no longer current`
    );
  }
}
