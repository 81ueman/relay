import type { Database } from "bun:sqlite";
import { now } from "./db";
import { logEvent } from "./events";
import { requestReconcile } from "./control";
import {
  findMergedResult,
  findPassingReview,
  findReviewForHead,
  findSubmissionForAttempt,
  findTaskResult,
  findUnresolvedNgAtHead,
  insertTaskResult,
  notifyGatewayTo,
} from "./results";
import type { CodePhase, ResultKind, Task, TaskState, VerifyOutcome } from "./schema";
import { INTEGRATOR_ROLE, REVIEWER_ROLE } from "./schema";
import {
  clearCurrentTaskOrRestoreParent,
  getTask,
  nextTaskId,
  recordChildBlocked,
  resolveHumanInterface,
  taskChildren,
} from "./tasks";
import { clearCurrentTask, getWorker, normalizeWorkerAfterTaskRelease, touchProgress } from "./workers";
import {
  gitHead,
  parseChecks,
  runChecks,
  serializeChecks,
  type CheckSpec,
  type CommandRunner,
  type ExecutedCheck,
} from "./verify";

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
/** ISH-759: a later OK at a head with an unresolved NG is refused. */
export const UNRESOLVED_NG = "UNRESOLVED_NG";
/** ISH-759: a result/nonce that no longer matches the live task (head moved). */
export const STALE_RESULT = "STALE_RESULT";

/**
 * ISH-759: the pseudo-role Relay itself takes while it MECHANICALLY verifies a
 * task. No worker has this role, so a Relay-run verify phase is never offered to
 * the claim machine (`RUNNABLE_TASK_SQL` excludes it) — no LLM waits on it.
 */
export const RELAY_ROLE = "relay";

/** The default review profile; a second profile is a genuinely different review. */
export const DEFAULT_REVIEW_PROFILE = "default";

// Re-exported so callers (daemon/tests) have one workflow entrypoint.
export { requestReconcile, reconcileRequestToken } from "./control";
export { recordChildBlocked } from "./tasks";
export { findTaskResult, findReviewForHead, findPassingReview, findUnresolvedNgAtHead, findMergedResult } from "./results";

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
  prRepo?: string;
  prBase?: string;
  prBaseSha?: string;
  prDiff?: string;
  /** The standard commands Relay runs mechanically in the verify phase. */
  checks?: CheckSpec[];
  /** The per-task worktree mechanical verify runs in. */
  worktree?: string;
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
    const linked = linkTask(db, existing.id, {
      prUrl: input.prUrl,
      branch: input.branch,
      headSha: input.headSha,
      prRepo: input.prRepo,
      prBase: input.prBase,
      prBaseSha: input.prBaseSha,
      prDiff: input.prDiff,
    });
    // A replayed intake may add the mechanical verify spec the first one lacked.
    if (input.checks && input.checks.length > 0) {
      db.query(`UPDATE tasks SET checks_json = ?, updated_at = ? WHERE id = ? AND code_change = 1`).run(
        serializeChecks(input.checks),
        now(),
        existing.id
      );
    }
    if (input.worktree) {
      db.query(`UPDATE tasks SET worktree = COALESCE(worktree, ?), updated_at = ? WHERE id = ? AND code_change = 1`).run(
        input.worktree,
        now(),
        existing.id
      );
    }
    return getTask(db, linked.id)!;
  }

  const t = now();
  const codeChange = input.codeChange === true;
  const id = nextTaskId(db);
  const dependsOn = [...new Set((input.dependsOn ?? []).map((d) => d.trim()).filter(Boolean))];
  const checksJson = input.checks && input.checks.length > 0 ? serializeChecks(input.checks) : null;
  try {
    db.transaction(() => {
      db.query(
        `INSERT INTO tasks
           (id, title, description, acceptance, state, priority, role, assignee,
            lease_token, lease_until, parent_task_id, plan_id,
            provider, issue_id, slice, code_change, phase, attempt, claim_role,
            pr_url, branch, head_sha, pr_repo, pr_base, pr_base_sha, pr_diff,
            checks_json, worktree, result_ref, review_profile, accepted_at,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, NULL, 0, NULL, ?, NULL,
                 ?, ?, ?, ?, ?, 0, NULL,
                 ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, NULL, NULL, NULL, ?, ?)`
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
        input.prRepo ?? null,
        input.prBase ?? null,
        input.prBaseSha ?? null,
        input.prDiff ?? null,
        checksJson,
        input.worktree ?? null,
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
 *
 * A TERMINAL task (done/failed, or already accepted) is NEVER re-opened by a
 * link/replay: its outcome is settled, so the update is ignored entirely.
 */
export function linkTask(
  db: Database,
  taskId: string,
  link: {
    prUrl?: string | null;
    branch?: string | null;
    headSha?: string | null;
    prRepo?: string | null;
    prBase?: string | null;
    prBaseSha?: string | null;
    prDiff?: string | null;
  }
): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  const terminal = task.state === "done" || task.state === "failed" || task.accepted_at !== null;
  if (terminal) {
    // Do not touch a settled task, and never invalidateReview it back to review.
    if (link.headSha !== undefined && link.headSha !== task.head_sha) {
      logEvent(db, {
        source: "workflow",
        taskId,
        type: "workflow.link_ignored_terminal",
        payload: { state: task.state, acceptedAt: task.accepted_at, fromHead: task.head_sha, toHead: link.headSha },
      });
    }
    return task;
  }
  const prUrl = link.prUrl ?? task.pr_url;
  const branch = link.branch ?? task.branch;
  const headSha = link.headSha ?? task.head_sha;
  const prRepo = link.prRepo ?? task.pr_repo;
  const prBase = link.prBase ?? task.pr_base;
  const prBaseSha = link.prBaseSha ?? task.pr_base_sha;
  const prDiff = link.prDiff ?? task.pr_diff;
  const headChanged = headSha !== task.head_sha;
  const linkChanged =
    headChanged ||
    prUrl !== task.pr_url ||
    branch !== task.branch ||
    prRepo !== task.pr_repo ||
    prBase !== task.pr_base ||
    prBaseSha !== task.pr_base_sha ||
    prDiff !== task.pr_diff;
  if (!linkChanged) return task;
  const updated = db.transaction(() => {
    db.query(
      `UPDATE tasks
          SET pr_url = ?, branch = ?, head_sha = ?, pr_repo = ?, pr_base = ?, pr_base_sha = ?, pr_diff = ?, updated_at = ?
        WHERE id = ?`
    ).run(prUrl, branch, headSha, prRepo, prBase, prBaseSha, prDiff, now(), taskId);
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

/** The standard commands Relay runs mechanically for this task (may be empty). */
export function taskChecks(task: Pick<Task, "checks_json">): CheckSpec[] {
  return parseChecks(task.checks_json);
}

/** True when verify is Mechanical (Relay runs the commands) rather than manual. */
export function hasMechanicalChecks(task: Pick<Task, "checks_json">): boolean {
  return taskChecks(task).length > 0;
}

/**
 * True when the task is being MECHANICALLY verified by Relay right now: a code
 * task at `verify` whose claim role is Relay's own (no worker owns it).
 */
export function isRelayVerifying(task: Pick<Task, "code_change" | "phase" | "claim_role">): boolean {
  return task.code_change === 1 && task.phase === "verify" && task.claim_role === RELAY_ROLE;
}

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
  // ISH-759: a task whose verify is MECHANICAL is owned by Relay, not a worker —
  // claim with Relay's own pseudo-role so the claim machine never offers it.
  const nextClaimRole =
    next === "verify" && hasMechanicalChecks(task) ? RELAY_ROLE : claimRoleForPhase(next, task.role);
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
      claimRole: nextClaimRole,
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

// ---------------------------------------------------------------------------
// ISH-759 mechanical verification (Relay runs the commands; no LLM waits)
// ---------------------------------------------------------------------------

export interface MechanicalVerifyOptions {
  checks: CheckSpec[];
  runner: CommandRunner;
  /** Working directory for the commands (the task's recorded worktree). */
  cwd: string;
  /** The head this verification judges; a moved head discards the run. */
  headSha?: string;
  /**
   * Reads the checkout's HEAD at `cwd`. Defaults to `git rev-parse HEAD`. A
   * mismatch with the recorded head BLOCKS (never PASS): the commands did not
   * run against the revision we would record.
   */
  headProbe?: (cwd: string) => string | null;
  /** Actor label for events (default: relay). */
  actor?: string;
}

/**
 * Quietly block a task for a human without a wake storm: state -> blocked_human,
 * ownership released, one ChildBlocked result, and the Gateway told at most once.
 * The block occurrence identity is the bumped lease token (see recordChildBlocked).
 */
export function quietBlock(db: Database, task: Task, reason: string, actor: string): Task {
  const t = now();
  const prev = task.assignee;
  db.transaction(() => {
    db.query(
      `UPDATE tasks
          SET state = 'blocked_human', assignee = NULL, lease_until = NULL,
              lease_token = lease_token + 1, updated_at = ?
        WHERE id = ?`
    ).run(t, task.id);
    db.query(
      `INSERT INTO task_notes (task_id, worker_id, kind, body, created_at) VALUES (?, ?, 'blocked_human', ?, ?)`
    ).run(task.id, actor, reason, t);
    // Release the owning worker EXACTLY like blockTask: clear (or restore its
    // parent) and normalize it, so it is not left `working` on a task it no
    // longer holds (the Linear-HOLD-on-a-running-task case).
    if (prev) {
      clearCurrentTaskOrRestoreParent(db, prev, task.id, t);
      normalizeWorkerAfterTaskRelease(db, prev, t);
    }
  })();
  recordChildBlocked(db, task.id, actor, reason, { notifyGateway: true });
  requestReconcile(db, `blocked:${task.id}`);
  return getTask(db, task.id)!;
}

/**
 * Run a task's standard commands and advance the phase from the PROCESS EXIT
 * RESULT — no LLM is waited on. PASS -> review (independent reviewer is
 * dispatched by the ordinary claim/wake machine). FAIL -> implement FIX at a new
 * attempt. NOT_RUN / INCONCLUSIVE for a REQUIRED check -> BLOCKED (never PASS).
 *
 * The run is bound to the head it STARTED on: if the task's head/phase/attempt
 * changed while the commands ran, the result is discarded as stale and nothing
 * advances (an old-HEAD result can never become PASS).
 */
export async function runMechanicalVerification(
  db: Database,
  taskId: string,
  opts: MechanicalVerifyOptions
): Promise<{ task: Task; outcome: VerifyOutcome; checks: ExecutedCheck[]; stale: boolean }> {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (!isCodeTask(task)) throw new Error(`${WORKFLOW_ERROR}: ${taskId} is not a code-change task`);
  if (phaseOf(task) !== "verify") {
    throw new Error(`${WORKFLOW_ERROR}: cannot mechanically verify ${taskId} in phase '${phaseOf(task)}'`);
  }
  const actor = opts.actor ?? RELAY_ROLE;
  const head = opts.headSha ?? task.head_sha;
  const probe = opts.headProbe ?? gitHead;

  // BIND THE RUN TO THE RECORDED HEAD. The commands run in a checkout; before
  // trusting any result we confirm that checkout IS the recorded revision. A
  // missing recorded head, an unreadable checkout, or a mismatch BLOCKS (never
  // PASS) — otherwise a PASS would be credited to a head the commands never saw.
  const treeHead = probe(opts.cwd);
  let bindingError: string | null = null;
  if (!head) {
    bindingError = "no recorded head_sha to bind the run to";
  } else if (!treeHead) {
    bindingError = `cwd '${opts.cwd}' is not a readable git checkout (git rev-parse HEAD failed)`;
  } else if (treeHead !== head) {
    bindingError = `checkout HEAD ${treeHead} != recorded head ${head}`;
  }

  let outcome: VerifyOutcome;
  let checks: ExecutedCheck[];
  if (bindingError) {
    outcome = "not_run";
    checks = [
      { name: "head-binding", required: true, outcome: "not_run", exitCode: null, output: bindingError, durationMs: 0 },
    ];
  } else {
    const run = await runChecks(opts.checks, opts.runner, opts.cwd);
    outcome = run.outcome;
    checks = run.checks;
  }

  // Re-read: the run may have raced a head move / a rework. Only advance if the
  // task is STILL the verify/attempt/head we started on.
  const live = getTask(db, taskId)!;
  const stale =
    live.phase !== "verify" ||
    live.attempt !== task.attempt ||
    (live.head_sha ?? null) !== (task.head_sha ?? null) ||
    (opts.headSha !== undefined && (live.head_sha ?? null) !== (head ?? null));
  if (stale) {
    logEvent(db, {
      source: "workflow",
      taskId,
      type: "workflow.verify_stale_discarded",
      payload: { outcome, startedHead: task.head_sha, liveHead: live.head_sha, livePhase: live.phase, liveAttempt: live.attempt },
    });
    return { task: live, outcome, checks, stale: true };
  }
  if (findTaskResult(db, taskId, "verify", task.attempt, "VerificationResult")) {
    throw new Error(`${DUPLICATE_DISPATCH}: VerificationResult already recorded for ${taskId} attempt ${task.attempt}`);
  }

  const evidence = checks
    .map((c) => `${c.name}=${c.outcome}${c.exitCode === null ? "" : `(exit ${c.exitCode})`}`)
    .join(" ");
  const payload = { outcome, checks: checks.map((c) => ({ ...c })) };

  if (outcome === "pass") {
    const updated = db.transaction(() => {
      const result = insertTaskResult(db, {
        taskId,
        phase: "verify",
        attempt: task.attempt,
        kind: "VerificationResult",
        workerId: actor,
        passed: true,
        headSha: head,
        evidenceRef: evidence,
        payload,
      });
      return applyPhase(db, task, "review", {
        state: "review",
        attempt: task.attempt,
        claimRole: REVIEWER_ROLE,
        resultRef: `result:${result.id}`,
      });
    })();
    requestReconcile(db, `verified:${taskId}`);
    return { task: updated, outcome, checks, stale: false };
  }

  if (outcome === "fail") {
    const updated = db.transaction(() => {
      const result = insertTaskResult(db, {
        taskId,
        phase: "verify",
        attempt: task.attempt,
        kind: "VerificationResult",
        workerId: actor,
        passed: false,
        headSha: head,
        evidenceRef: evidence,
        reason: evidence,
        payload,
      });
      return applyPhase(db, task, "implement", {
        state: "queued",
        attempt: task.attempt + 1,
        claimRole: claimRoleForPhase("implement", task.role),
        clearHead: true,
        resultRef: `result:${result.id}`,
      });
    })();
    requestReconcile(db, `verify-failed:${taskId}`);
    return { task: updated, outcome, checks, stale: false };
  }

  // not_run / inconclusive for a required check: BLOCK, do not PASS. The
  // VerificationResult records the outcome for evidence, then the task blocks.
  const blockReason = bindingError ?? `${outcome}: ${evidence}`;
  db.transaction(() => {
    insertTaskResult(db, {
      taskId,
      phase: "verify",
      attempt: task.attempt,
      kind: "VerificationResult",
      workerId: actor,
      passed: false,
      headSha: head,
      evidenceRef: evidence,
      reason: bindingError ?? `${outcome}: ${evidence}`,
      payload,
    });
  })();
  const blocked = quietBlock(db, getTask(db, taskId)!, `mechanical verify ${outcome}: ${blockReason}`, actor);
  return { task: blocked, outcome, checks, stale: false };
}

export interface ReviewOptions {
  /** `fail` is accepted as an alias of `fix` (ISH-758 vocabulary). */
  verdict: "pass" | "fix" | "fail" | "blocked";
  headSha?: string;
  profile?: string;
  reason?: string;
  evidence?: string;
  /**
   * The external reviewer's identity (a provider author), when the review came
   * from a GitHub verdict marker rather than a Relay worker. The worker-row
   * authority check is skipped for it — the identity was already validated
   * against the provider's authorized-reviewer set by `src/providers.ts`.
   */
  externalReviewer?: string;
  /** Source label for the result payload (e.g. "github-marker"). */
  source?: string;
  /**
   * ISH-759: explicitly SUPERSEDE an unresolved NG at this head by naming its
   * result id. Without it, a PASS at a head that still carries an NG is refused
   * (an unresolved NG never becomes PASS from a later OK alone).
   */
  supersedesResultId?: number;
}

/**
 * Record a structured ReviewResult. A PASS is invalid once the HEAD moves: the
 * reviewed head must match the task's current head, and a ReviewResult for the
 * same (task, head, profile) is refused as a duplicate dispatch.
 *
 * ISH-759 verdicts:
 *   pass    -> integration (a merge-ready candidate; acceptance still required)
 *   fix/fail-> implement FIX at a new attempt on the SAME task
 *   blocked -> a quiet human block (Gateway told once)
 *
 * An UNRESOLVED NG at the same HEAD is never cleared by a later OK alone: a pass
 * at a head that still carries an NG is refused unless it names the NG it
 * supersedes (`supersedesResultId`).
 *
 * Authority: the reviewer must hold the REVIEWER_ROLE (or the review claim taken
 * via `relay next`), and may not be the worker that recorded the TaskSubmitted
 * for this attempt. A provider-derived review (`externalReviewer`) skips the
 * worker-row lookup; the identity was validated against the provider's
 * authorized-reviewer set by `src/providers.ts`.
 */
export function recordReview(db: Database, taskId: string, reviewerId: string, opts: ReviewOptions): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (!isCodeTask(task)) throw new Error(`${WORKFLOW_ERROR}: ${taskId} is not a code-change task`);
  const phase = phaseOf(task);
  if (task.state !== "review" || phase !== "review") {
    throw new Error(`${WORKFLOW_ERROR}: cannot record a review for ${taskId} (state ${task.state}, phase ${phase})`);
  }
  const external = opts.externalReviewer?.trim();
  const identity = external ?? reviewerId;
  if (external) {
    if (!external) throw new Error(`${AUTHORITY_ERROR}: an external review needs a reviewer identity`);
    logEvent(db, {
      source: "workflow",
      taskId,
      type: "workflow.external_review",
      payload: { reviewer: external, source: opts.source ?? null, verdict: opts.verdict },
    });
  } else {
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
  // Unresolved NG at this head: a later OK must explicitly supersede it. Checked
  // after duplicate-dispatch so a re-review of the same profile is still a
  // DUPLICATE_DISPATCH; a *different profile's* later OK hits this rule instead.
  if (opts.verdict === "pass") {
    const ng = findUnresolvedNgAtHead(db, taskId, head);
    if (ng && ng.id !== opts.supersedesResultId) {
      throw new Error(
        `${UNRESOLVED_NG}: ${taskId} head ${head ?? "none"} still carries an unresolved NG (result ${ng.id}); ` +
        `a later OK alone does not clear it — fix the head or supersede the NG explicitly`
      );
    }
  }
  assertNoResult(db, taskId, phase, task.attempt, "ReviewResult");

  const basePayload = {
    source: opts.source ?? (external ? "external" : "worker"),
    reviewer: identity,
    ...(opts.supersedesResultId ? { supersedes: opts.supersedesResultId } : {}),
  };

  if (opts.verdict === "pass") {
    const updated = db.transaction(() => {
      const result = insertTaskResult(db, {
        taskId,
        phase,
        attempt: task.attempt,
        kind: "ReviewResult",
        workerId: identity,
        passed: true,
        headSha: head,
        profile,
        reason: opts.reason ?? null,
        evidenceRef: opts.evidence ?? null,
        payload: basePayload,
      });
      const u = applyPhase(db, task, "integration", {
        state: "queued",
        attempt: task.attempt,
        claimRole: INTEGRATOR_ROLE,
        resultRef: `result:${result.id}`,
      });
      if (!external) releaseWorker(db, reviewerId, taskId);
      return u;
    })();
    requestReconcile(db, `review-pass:${taskId}`);
    return updated;
  }

  if (opts.verdict === "blocked") {
    const updated = db.transaction(() => {
      const result = insertTaskResult(db, {
        taskId,
        phase,
        attempt: task.attempt,
        kind: "ReviewResult",
        workerId: identity,
        passed: false,
        headSha: head,
        profile,
        reason: opts.reason ?? null,
        evidenceRef: opts.evidence ?? null,
        payload: { ...basePayload, blocked: true },
      });
      return getTask(db, taskId)!;
    })();
    if (!external) releaseWorker(db, reviewerId, taskId);
    const blocked = quietBlock(
      db,
      updated,
      `review BLOCKED${opts.reason ? `: ${opts.reason}` : ""} (head ${head ?? "none"})`,
      identity
    );
    return blocked;
  }

  // fix (alias fail): rework on the SAME task at a new attempt, head cleared.
  const updated = db.transaction(() => {
    const result = insertTaskResult(db, {
      taskId,
      phase,
      attempt: task.attempt,
      kind: "ReviewResult",
      workerId: identity,
      passed: false,
      headSha: head,
      profile,
      reason: opts.reason ?? null,
      evidenceRef: opts.evidence ?? null,
      payload: basePayload,
    });
    const u = applyPhase(db, task, "implement", {
      state: "queued",
      attempt: task.attempt + 1,
      claimRole: claimRoleForPhase("implement", task.role),
      clearHead: true,
      resultRef: `result:${result.id}`,
    });
    if (!external) releaseWorker(db, reviewerId, taskId);
    return u;
  })();
  requestReconcile(db, `review-fix:${taskId}`);
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

export interface MergedOptions {
  /** The head GitHub reports as merged. A different head is not this work. */
  headSha?: string;
  repo?: string;
  actor?: string;
  reason?: string;
}

/**
 * ISH-759: confirm the bound PR was actually MERGED on the provider. This is the
 * ONLY signal that a code-change task is "truly done" for the issue; a review
 * PASS or an internal TaskAccepted is explicitly NOT a merge.
 *
 * Read-only w.r.t. GitHub (we observe a merge that already happened, we never
 * perform one). The merged head must match the recorded head, so an old-HEAD
 * merge can never be credited to the current attempt. Idempotent.
 */
export function confirmMerged(db: Database, taskId: string, opts: MergedOptions = {}): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (!isCodeTask(task)) throw new Error(`${WORKFLOW_ERROR}: ${taskId} is not a code-change task`);
  const phase = phaseOf(task);
  if (phase !== "merge_ready" && task.state !== "done") {
    throw new Error(
      `${GATE_ERROR}: cannot confirm a merge for ${taskId} at phase '${phase}' state '${task.state}'; ` +
      `a merge is credited only to a merge-ready (or accepted) task`
    );
  }
  const mergedHead = opts.headSha ?? task.head_sha;
  if (task.head_sha && mergedHead && mergedHead !== task.head_sha) {
    throw new Error(
      `${HEAD_MISMATCH}: merged head ${mergedHead} != task head ${task.head_sha} for ${taskId}; not this work`
    );
  }
  if (findMergedResult(db, taskId)) return task; // exactly once
  const t = now();
  const updated = db.transaction(() => {
    insertTaskResult(db, {
      taskId,
      phase,
      attempt: task.attempt,
      kind: "TaskMerged",
      workerId: opts.actor ?? null,
      headSha: mergedHead,
      reason: opts.reason ?? null,
      payload: { repo: opts.repo ?? task.pr_repo, head: mergedHead },
    });
    db.query(`UPDATE tasks SET merged_at = ?, updated_at = ? WHERE id = ?`).run(t, t, taskId);
    const next = getTask(db, taskId)!;
    // A confirmed merge may be the last thing a parent's children were waiting
    // for (a code child counts as complete only once merged), so re-run the
    // children-ready roll-up here too.
    notifyParentAccepted(db, next);
    return next;
  })();
  requestReconcile(db, `merged:${taskId}`);
  return updated;
}

// ---------------------------------------------------------------------------
// Child roll-up: the Gateway is notified only when needed
// ---------------------------------------------------------------------------

/**
 * True once a code task has satisfied its mandatory gate AND, when bound to a
 * real PR, been confirmed MERGED. A review PASS or an internal accept alone is
 * not "truly done" for a task that has a PR.
 */
export function codeChangeGateSatisfied(task: Task): boolean {
  if (!isCodeTask(task)) return true;
  if (!(derivePhase(task) === "merge_ready" && task.state === "done")) return false;
  if (task.pr_url && task.merged_at === null) return false;
  return true;
}

/**
 * True when a task counts as COMPLETE for a roll-up / dependency: `done` AND,
 * for a code task with a bound PR, the real merge confirmed. An internal accept
 * is not enough (ISH-759).
 */
export function taskComplete(task: Task): boolean {
  if (task.state !== "done") return false;
  if (!isCodeTask(task)) return true;
  return task.pr_url === null || task.merged_at !== null;
}

/**
 * On acceptance, tell the parent's Gateway ONLY when ALL direct children are
 * COMPLETE (children-ready aggregation). A code child with an unmerged PR does
 * NOT count as complete. Recorded as a durable ChildrenReady result so it fires
 * exactly once. Runs inside the caller's transaction.
 */
function notifyParentAccepted(db: Database, child: Task): void {
  const parentId = child.parent_task_id;
  if (!parentId) return;
  const parent = getTask(db, parentId);
  if (!parent) return;
  const kids = taskChildren(db, parentId);
  if (kids.length === 0) return;
  if (!kids.every((k) => taskComplete(k))) return; // not all complete yet
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
