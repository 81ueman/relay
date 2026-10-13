import type { Database } from "bun:sqlite";
import { now } from "./db";
import { logEvent } from "./events";
import { RELAY_TAG, sendMessage } from "./messages";
import type { CodePhase, ResultKind, Task, TaskResult, TaskState } from "./schema";
import { INTEGRATOR_ROLE, REVIEWER_ROLE } from "./schema";
import {
  effectiveTaskRole,
  getTask,
  nextTaskId,
  resolveHumanInterface,
  taskChildren,
  taskDependencies,
} from "./tasks";
import {
  clearCurrentTask,
  getWorker,
  normalizeWorkerAfterTaskRelease,
  touchProgress,
} from "./workers";

/**
 * ISH-758 minimal event-driven workflow core.
 *
 * The Task table is the single source of truth. A code-change task carries a
 * `phase` (implement -> verify -> review -> integration -> merge_ready) and the
 * existing `state` column stays the lifecycle (queued/running/review/blocked/
 * done/failed). A STRUCTURED RESULT (src/schema.ts RESULT_KINDS) is the only
 * thing that advances a phase — `relay send` prose is never parsed for it.
 *
 * Every transition (a) records the structured result durably, (b) updates the
 * Task, and (c) bumps the reconcile-request token so the daemon wakes
 * IMMEDIATELY rather than waiting for its periodic tick. There is no separate
 * queue/outbox/engine: one SQLite DB, one control row.
 */

export const WORKFLOW_ERROR = "WORKFLOW";
export const GATE_ERROR = "CODE_CHANGE_GATE";
export const STALE_ATTEMPT = "STALE_ATTEMPT";
export const DUPLICATE_DISPATCH = "DUPLICATE_DISPATCH";
export const HEAD_MISMATCH = "HEAD_MISMATCH";

/** The default review profile; a second profile is a genuinely different review. */
export const DEFAULT_REVIEW_PROFILE = "default";

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
 * review and integration demand the dedicated reviewer/integrator authority.
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
// Structured results (durable, append-only)
// ---------------------------------------------------------------------------

export interface ResultInput {
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

export function getResult(db: Database, id: number): TaskResult | null {
  return (db.query(`SELECT * FROM task_results WHERE id = ?`).get(id) as TaskResult | null) ?? null;
}

export function findResult(
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

function assertNoResult(
  db: Database,
  taskId: string,
  phase: string,
  attempt: number,
  kind: ResultKind
): void {
  if (findResult(db, taskId, phase, attempt, kind)) {
    throw new Error(
      `${DUPLICATE_DISPATCH}: ${kind} already recorded for ${taskId} phase '${phase}' attempt ${attempt}`
    );
  }
}

function insertResult(db: Database, r: ResultInput): TaskResult {
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
  return getResult(db, id)!;
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
 * rather than creating a second row.
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

/** Fill in / update the PR link on a task without clobbering existing values. */
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
  if (prUrl === task.pr_url && branch === task.branch && headSha === task.head_sha) return task;
  db.query(`UPDATE tasks SET pr_url = ?, branch = ?, head_sha = ?, updated_at = ? WHERE id = ?`).run(
    prUrl,
    branch,
    headSha,
    now(),
    taskId
  );
  return getTask(db, taskId)!;
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
 * moves to `verify` (or `review`), never to terminal.
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
  assertNoResult(db, taskId, phase, task.attempt, "TaskSubmitted");

  const result = insertResult(db, {
    taskId,
    phase,
    attempt: task.attempt,
    kind: "TaskSubmitted",
    workerId,
    headSha: opts.headSha ?? task.head_sha,
    evidenceRef: opts.evidence ?? null,
  });

  const next = nextPhase(phase)!;
  const updated = applyPhase(db, task, next, {
    state: next === "review" ? "review" : "queued",
    attempt: task.attempt,
    claimRole: claimRoleForPhase(next, task.role),
    headSha: opts.headSha !== undefined ? opts.headSha : undefined,
    resultRef: `result:${result.id}`,
  });
  releaseWorker(db, workerId, taskId);
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

  const result = insertResult(db, {
    taskId,
    phase,
    attempt: task.attempt,
    kind: "VerificationResult",
    workerId,
    passed: opts.passed,
    headSha: opts.headSha ?? task.head_sha,
    evidenceRef: opts.evidence ?? null,
  });

  if (opts.passed) {
    const updated = applyPhase(db, task, "review", {
      state: "review",
      attempt: task.attempt,
      claimRole: REVIEWER_ROLE,
      headSha: opts.headSha !== undefined ? opts.headSha : undefined,
      resultRef: `result:${result.id}`,
    });
    releaseWorker(db, workerId, taskId);
    requestReconcile(db, `verified:${taskId}`);
    return updated;
  }
  // Failed verification: rework. A new attempt, head cleared (the old head's
  // verification no longer applies).
  const updated = applyPhase(db, task, "implement", {
    state: "queued",
    attempt: task.attempt + 1,
    claimRole: claimRoleForPhase("implement", task.role),
    clearHead: true,
    resultRef: `result:${result.id}`,
  });
  releaseWorker(db, workerId, taskId);
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
  if (task.assignee && task.assignee !== reviewerId) {
    throw new Error(`${WORKFLOW_ERROR}: review of ${taskId} is held by ${task.assignee}, not ${reviewerId}`);
  }
  const profile = (opts.profile ?? task.review_profile ?? DEFAULT_REVIEW_PROFILE).trim() || DEFAULT_REVIEW_PROFILE;

  // HEAD is the review's identity. A review that does not name the current head
  // cannot invalidate it; a mismatched one is a stale review of a moved head.
  const head = opts.headSha ?? task.head_sha;
  if (task.head_sha && opts.headSha && opts.headSha !== task.head_sha) {
    throw new Error(
      `${HEAD_MISMATCH}: review head ${opts.headSha} != task head ${task.head_sha} for ${taskId}`
    );
  }
  if (opts.verdict === "pass" && task.head_sha && !opts.headSha) {
    throw new Error(`${HEAD_MISMATCH}: a PASS must name the reviewed HEAD (task ${taskId} is at ${task.head_sha})`);
  }
  // Duplicate dispatch: the same PR+HEAD+profile is reviewed once.
  if (findReviewForHead(db, taskId, head, profile)) {
    throw new Error(`${DUPLICATE_DISPATCH}: ${taskId} head ${head} already has a review (profile '${profile}')`);
  }
  assertNoResult(db, taskId, phase, task.attempt, "ReviewResult");

  const result = insertResult(db, {
    taskId,
    phase,
    attempt: task.attempt,
    kind: "ReviewResult",
    workerId: reviewerId,
    passed: opts.verdict === "pass",
    headSha: head,
    profile,
    reason: opts.reason ?? null,
    evidenceRef: opts.evidence ?? null,
  });

  if (opts.verdict === "pass") {
    const updated = applyPhase(db, task, "integration", {
      state: "queued",
      attempt: task.attempt,
      claimRole: INTEGRATOR_ROLE,
      resultRef: `result:${result.id}`,
    });
    releaseWorker(db, reviewerId, taskId);
    requestReconcile(db, `review-pass:${taskId}`);
    return updated;
  }
  const updated = applyPhase(db, task, "implement", {
    state: "queued",
    attempt: task.attempt + 1,
    claimRole: claimRoleForPhase("implement", task.role),
    clearHead: true,
    resultRef: `result:${result.id}`,
  });
  releaseWorker(db, reviewerId, taskId);
  requestReconcile(db, `review-fail:${taskId}`);
  return updated;
}

/**
 * TaskAccepted — the ONLY way a code-change task becomes terminal. Requires the
 * task to be at `merge_ready`; a bare approve/auto-approve can never get here.
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
  assertNoResult(db, taskId, phase, task.attempt, "TaskAccepted");
  const t = now();
  const result = insertResult(db, {
    taskId,
    phase,
    attempt: task.attempt,
    kind: "TaskAccepted",
    workerId: actor,
  });
  const updated = applyPhase(db, task, phase, {
    state: "done",
    attempt: task.attempt,
    claimRole: null,
    acceptedAt: t,
    resultRef: `result:${result.id}`,
  });
  releaseWorker(db, actor, taskId, t);
  notifyParentAccepted(db, updated);
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

function notifyGateway(db: Database, task: Task, body: string, kind: string): boolean {
  const recipient = resolveHumanInterface(db, task);
  if (!recipient) {
    logEvent(db, { source: "workflow", taskId: task.id, type: "workflow.gateway_unrouted", payload: { kind } });
    return false;
  }
  sendMessage(db, "relay", recipient, `${RELAY_TAG}${body}`, { kind, taskId: task.id });
  logEvent(db, { source: "workflow", workerId: recipient, taskId: task.id, type: "workflow.gateway_notified", payload: { kind } });
  return true;
}

/**
 * On acceptance, tell the parent's Gateway ONLY when ALL direct children are
 * accepted (children-ready aggregation). Recorded as a durable ChildrenReady
 * result so it fires exactly once.
 */
function notifyParentAccepted(db: Database, child: Task): void {
  const parentId = child.parent_task_id;
  if (!parentId) return;
  const parent = getTask(db, parentId);
  if (!parent) return;
  const kids = taskChildren(db, parentId);
  if (kids.length === 0) return;
  if (!kids.every((k) => k.state === "done")) return; // not ready yet
  if (findResult(db, parentId, "", 0, "ChildrenReady")) return; // already told
  insertResult(db, {
    taskId: parentId,
    phase: "",
    attempt: 0,
    kind: "ChildrenReady",
    payload: { children: kids.map((k) => k.id) },
  });
  notifyGateway(db, parent, `${parentId}: all ${kids.length} child task(s) are ready.`, "children_ready");
}

/**
 * Record a ChildBlocked notification for a blocked child and reach the Gateway
 * exactly once. Used by the code-change block path; the legacy parent-assignee
 * bubbling is untouched.
 */
export function recordChildBlocked(db: Database, childId: string, actor: string, reason: string): boolean {
  const child = getTask(db, childId);
  if (!child) throw new Error(`unknown task: ${childId}`);
  const phase = derivePhase(child) ?? "";
  if (findResult(db, childId, phase, child.attempt, "ChildBlocked")) return false;
  insertResult(db, {
    taskId: childId,
    phase,
    attempt: child.attempt,
    kind: "ChildBlocked",
    workerId: actor,
    reason,
  });
  const parentId = child.parent_task_id;
  const target = parentId ? getTask(db, parentId) ?? child : child;
  return notifyGateway(db, target, `${childId} is blocked${reason ? `: ${reason}` : ""}.`, "child_blocked");
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
  return !findResult(db, taskId, phase, attempt, "TaskSubmitted");
}

/** Refuse a second start for the same Task/phase/attempt. */
export function assertStartable(db: Database, taskId: string, phase: CodePhase, attempt: number): void {
  if (!canStartPhase(db, taskId, phase, attempt)) {
    throw new Error(
      `${DUPLICATE_DISPATCH}: ${taskId} phase '${phase}' attempt ${attempt} is already started or no longer current`
    );
  }
}

// ---------------------------------------------------------------------------
// Immediate daemon reconcile
// ---------------------------------------------------------------------------

export const RECONCILE_KEY = "reconcile_request";

/**
 * Bump the durable reconcile-request token. The daemon polls this one row on its
 * 250ms tick (not the 1500ms reconcile interval) and reconciles IMMEDIATELY on a
 * change — a task-state update never waits for a periodic pass.
 */
export function requestReconcile(db: Database, reason = ""): number {
  const t = now();
  db.query(
    `INSERT INTO control (key, value, updated_at) VALUES (?, '1', ?)
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at`
  ).run(RECONCILE_KEY, t);
  const row = db.query(`SELECT value FROM control WHERE key = ?`).get(RECONCILE_KEY) as { value: string };
  logEvent(db, { source: "workflow", type: "workflow.reconcile_requested", payload: { reason, token: row.value } });
  return Number(row.value);
}

/** The current reconcile-request token ("" when never requested). */
export function reconcileRequestToken(db: Database): string {
  const row = db.query(`SELECT value FROM control WHERE key = ?`).get(RECONCILE_KEY) as { value: string } | null;
  return row?.value ?? "";
}
