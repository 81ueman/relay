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
  getTaskResult,
  insertTaskResult,
  notifyGatewayTo,
} from "./results";
import type { CodePhase, ResultKind, Run, Task, TaskResult, TaskState, VerifyOutcome } from "./schema";
import { INTEGRATOR_ROLE, REVIEWER_ROLE, TERMINAL_TASK_STATES, isTerminalTaskState } from "./schema";
import {
  clearCurrentTaskOrRestoreParent,
  getTask,
  nextTaskId,
  recordChildBlocked,
  resolveHumanInterface,
  taskChildren,
} from "./tasks";
import {
  findLiveRunFor,
  findActiveWriterRow,
  runHeadFenceRepos,
  runOwnedError,
  taskHeadOvertakenByOtherWriter,
} from "./run-owner";
import { runObservedOwnHeads } from "./run-heads";
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
import { taskCargoTarget } from "./scratch";

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
 * ISH-1122: a coordinator-authorised `merge_ready` -> `implement` rebase route
 * was refused (not merge_ready, the PR is mergeable, an unresolved reviewer
 * NG/HOLD is present, or the observed conflict does not match the bound HEAD).
 */
export const REBASE_REFUSED = "REBASE_REFUSED";
/**
 * ISH-1245: a result produced by work that started BEFORE the Task was closed
 * (cancelled / failed / done) was refused as a transition. The result row is
 * kept as evidence and `task.late_result_ignored` records why it did not move.
 */
export const LATE_RESULT_IGNORED = "LATE_RESULT_IGNORED";

/** Terminal task states as an SQL list; shares the definition with isTerminalTaskState. */
const TERMINAL_STATE_SQL = TERMINAL_TASK_STATES.map((s) => `'${s}'`).join(",");

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
  /**
   * ISH-1012: only move when the Task is still the phase/attempt the caller
   * judged. A conditional transition is what makes a recovery/repair step
   * idempotent under restart/re-entry: a second writer observes 0 changes and
   * is refused instead of bumping the attempt a second time.
   */
  expectPhase?: CodePhase;
  expectAttempt?: number;
}

/**
 * Apply a phase/state update and bump the lease token (fencing). Every phase
 * move releases ownership: `assignee` defaults to NULL and `lease_until` is
 * cleared, so a worker that still holds the pre-transition task can never submit
 * it again with a stale token.
 *
 * With `expectPhase`/`expectAttempt` the UPDATE is conditional and a mismatch
 * throws `STALE_ATTEMPT` — a concurrent/replayed recovery can never advance the
 * Task twice.
 *
 * ISH-1245: the UPDATE is ALSO conditional on the Task still being non-terminal.
 * `cancelTask` leaves phase/attempt untouched, so this is the write-time fence
 * that catches a close committed after the caller's entry check. It is a
 * backstop: the result paths call `applyResultPhase`, which records the late
 * result as evidence instead of rolling it back.
 */
function applyPhase(db: Database, task: Task, phase: CodePhase, u: PhaseUpdate): Task {
  const t = now();
  const headProvided = u.headSha !== undefined ? 1 : 0;
  const guards: string[] = [];
  const guardArgs: (string | number)[] = [];
  if (u.expectPhase !== undefined) {
    guards.push("AND phase = ?");
    guardArgs.push(u.expectPhase);
  }
  if (u.expectAttempt !== undefined) {
    guards.push("AND attempt = ?");
    guardArgs.push(u.expectAttempt);
  }
  const r = db.query(
    `UPDATE tasks
        SET phase = ?, state = ?, assignee = ?, claim_role = ?, attempt = ?,
            head_sha = CASE WHEN ? = 1 THEN NULL WHEN ? = 1 THEN ? ELSE head_sha END,
            result_ref = ?, accepted_at = ?,
            lease_token = lease_token + 1, lease_until = NULL, updated_at = ?
      WHERE id = ? AND state NOT IN (${TERMINAL_STATE_SQL}) ${guards.join(" ")}`
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
    task.id,
    ...guardArgs
  );
  if (r.changes !== 1) {
    const live = getTask(db, task.id);
    if (live && isTerminalTaskState(live.state)) {
      throw new Error(
        `${LATE_RESULT_IGNORED}: task ${task.id} was closed as '${live.state}' while the transition was in flight`
      );
    }
    throw new Error(
      `${STALE_ATTEMPT}: task ${task.id} is no longer phase '${u.expectPhase ?? task.phase}' attempt ${u.expectAttempt ?? task.attempt}; the transition is stale`
    );
  }
  return getTask(db, task.id)!;
}

/**
 * ISH-1245: record a result that arrived for an already-CLOSED Task as EVIDENCE
 * only. The Task's state/phase/head/attempt are untouched, and
 * `task.late_result_ignored` carries the verdict plus the result row id.
 *
 * MUST be called inside the transaction that wrote `result`, after that write:
 * the transaction then holds SQLite's write lock, so this re-read observes a
 * `cancel`/`fail`/`accept` committed while the work was in flight. (A pre-check
 * alone is not enough: another process can commit the close between the read
 * and the write, and `cancelTask` deliberately leaves phase/attempt unchanged.)
 *
 * Returns the live Task when it is terminal, or null when it is still live.
 */
function lateResultIgnored(
  db: Database,
  taskId: string,
  result: TaskResult,
  actor: string | null,
  detail: Record<string, unknown> = {}
): Task | null {
  const live = getTask(db, taskId);
  if (!live || !isTerminalTaskState(live.state)) return null;
  logEvent(db, {
    source: "workflow",
    workerId: actor ?? result.worker_id ?? null,
    taskId,
    type: "task.late_result_ignored",
    payload: {
      resultId: result.id,
      kind: result.kind,
      phase: result.phase,
      attempt: result.attempt,
      passed: result.passed === null ? null : result.passed === 1,
      head: result.head_sha,
      evidence: result.evidence_ref,
      reason: result.reason,
      taskState: live.state,
      ...detail,
    },
  });
  return live;
}

/**
 * ISH-1245: apply a phase transition backed by `result`, but ONLY while the Task
 * is still non-terminal at write time. MUST be called inside the same
 * transaction that wrote `result`.
 *
 * When the Task was closed while the result was in flight, the result row stays
 * committed as evidence and `task.late_result_ignored` records the refusal; this
 * returns null so the caller can skip the worker release / notification. A live
 * Task takes the ordinary `applyPhase` transition exactly as before.
 */
function applyResultPhase(
  db: Database,
  task: Task,
  phase: CodePhase,
  update: PhaseUpdate,
  result: TaskResult,
  actor: string | null
): Task | null {
  const live = getTask(db, task.id);
  if (!live) throw new Error(`unknown task: ${task.id}`);
  if (!isTerminalTaskState(live.state)) return applyPhase(db, task, phase, update);
  return lateResultIgnored(db, task.id, result, actor);
}

/**
 * A HEAD or BASE change after the review phase invalidates the pending/prior
 * review. A HEAD change ALSO invalidates the VERIFY evidence that backed it
 * (ISH-1140): the Task goes BACK to `verify` at the new HEAD and a new attempt,
 * so Relay re-runs the required checks before a reviewer judges the new tree.
 * A BASE-branch change alone keeps the same HEAD, so that HEAD's VERIFY still
 * applies and the Task goes straight back to `review`.
 *
 * A Task WITHOUT mechanical checks also returns to `verify` on a HEAD move: its
 * manual VerificationResult is HEAD-scoped too, and the merge gate refuses a
 * PASS that has no VERIFY at the recorded head (`VERIFY_MISSING`). Must be
 * called inside a transaction.
 */
function invalidateReview(db: Database, task: Task, newHead: string | null, reason: string, workerId?: string): Task {
  const t = now();
  // ISH-1245: a late HEAD/base observation must not reopen a CLOSED Task. The
  // callers take the write lock before this (a link/submit write), so this
  // re-read sees a close committed while the observation was in flight.
  const live = getTask(db, task.id);
  if (live && isTerminalTaskState(live.state)) {
    logEvent(db, {
      source: "workflow",
      taskId: task.id,
      type: "task.late_result_ignored",
      payload: {
        kind: "ReviewInvalidated",
        taskState: live.state,
        reason,
        fromHead: task.head_sha,
        toHead: newHead,
        fromPhase: task.phase,
      },
    });
    return live;
  }
  const headChanged = (newHead ?? null) !== (task.head_sha ?? null);
  const phase: CodePhase = headChanged ? "verify" : "review";
  const claimRole =
    phase === "verify"
      ? hasMechanicalChecks(task)
        ? RELAY_ROLE
        : claimRoleForPhase("verify", task.role)
      : REVIEWER_ROLE;
  db.query(
    `UPDATE tasks
        SET phase = ?, state = ?, claim_role = ?, assignee = NULL,
            attempt = attempt + 1, head_sha = ?,
            lease_token = lease_token + 1, lease_until = NULL, updated_at = ?
      WHERE id = ?`
  ).run(phase, phase === "review" ? "review" : "queued", claimRole, newHead, t, task.id);
  logEvent(db, {
    source: "workflow",
    taskId: task.id,
    type: "workflow.review_invalidated",
    payload: {
      reason,
      fromHead: task.head_sha,
      toHead: newHead,
      fromPhase: task.phase,
      toPhase: phase,
      attempt: task.attempt + 1,
    },
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
 * on a task already past review sends it back to verify (see `linkTask`).
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

/** Phases in which a HEAD change must invalidate the review (and its VERIFY). */
const REVIEW_PINNED_PHASES: CodePhase[] = ["review", "integration", "merge_ready"];

/**
 * Fill in / update the PR link on a task without clobbering existing values.
 *
 * HEAD is the review's identity: if the task is already at/past review and the
 * HEAD changes, the prior review (and the VERIFY that backed it) no longer
 * applies — the task is sent back to verify at a new attempt (a PASS can never
 * survive a moved HEAD). A base-branch change alone re-opens only the review.
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
  const terminal = isTerminalTaskState(task.state) || task.accepted_at !== null;
  if (terminal) {
    // Do not touch a settled task, and never invalidateReview it back into the
    // phase machine (verify/review).
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
  // A BASE BRANCH change is review-invalidating exactly like a HEAD change: the
  // review/verify judged a diff against the recorded base, and merging into a
  // different branch is a different diff. A base-SHA move alone is NOT (an
  // unrelated merge must not force a rebase/review loop).
  const baseBranchChanged = task.pr_base !== null && prBase !== null && prBase !== task.pr_base;
  const linkChanged =
    headChanged ||
    baseBranchChanged ||
    prUrl !== task.pr_url ||
    branch !== task.branch ||
    prRepo !== task.pr_repo ||
    prBase !== task.pr_base ||
    prBaseSha !== task.pr_base_sha ||
    prDiff !== task.pr_diff;
  if (!linkChanged) return task;
  const updated = db.transaction(() => {
    // ISH-1245: the link observation may have raced a close (e.g. a PR read
    // completed after `relay task cancel`). Take the write lock and re-read;
    // a closed Task records the binding as evidence and is never re-opened.
    const linked = db.query(
      `UPDATE tasks
          SET pr_url = ?, branch = ?, head_sha = ?, pr_repo = ?, pr_base = ?, pr_base_sha = ?, pr_diff = ?, updated_at = ?
        WHERE id = ? AND state NOT IN (${TERMINAL_STATE_SQL})`
    ).run(prUrl, branch, headSha, prRepo, prBase, prBaseSha, prDiff, now(), taskId);
    if (linked.changes !== 1) {
      const live = getTask(db, taskId)!;
      logEvent(db, {
        source: "workflow",
        taskId,
        type: "task.late_result_ignored",
        payload: {
          kind: "PrBinding",
          taskState: live.state,
          prUrl,
          branch,
          head: headSha,
          prRepo,
          prBase,
          prBaseSha,
          prDiff,
          reason: "late link ignored: task closed in flight",
        },
      });
      return live;
    }
    let next = getTask(db, taskId)!;
    const phase = derivePhase(task);
    if ((headChanged || baseBranchChanged) && isCodeTask(task) && phase && REVIEW_PINNED_PHASES.includes(phase)) {
      // Pass the PRE-update snapshot: `invalidateReview` compares its head with
      // `newHead` to decide verify-vs-review, and reports `fromHead`/`fromPhase`
      // from it. `next` already carries the new head after the UPDATE above.
      next = invalidateReview(db, task, headSha, baseBranchChanged ? "base-changed" : "head-changed");
    }
    return next;
  })();
  if (!isTerminalTaskState(updated.state) && (headChanged || baseBranchChanged)) {
    requestReconcile(db, `link-changed:${taskId}`);
  }
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
 * and the VERIFY that backed it (the task goes back to verify) rather than
 * advancing to merge_ready.
 */
export function submitPhase(db: Database, taskId: string, workerId: string, opts: SubmitOptions = {}): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (!isCodeTask(task)) {
    throw new Error(`${WORKFLOW_ERROR}: ${taskId} is not a code-change task; use \`relay submit\``);
  }
  // ISH-808: terminal (e.g. cancelled) tasks are CLOSED and must not be advanced.
  if (isTerminalTaskState(task.state)) {
    throw new Error(`${WORKFLOW_ERROR}: cannot submit terminal task ${taskId} (state=${task.state})`);
  }
  const phase = phaseOf(task);
  if (phase !== "implement" && phase !== "integration") {
    throw new Error(
      `${WORKFLOW_ERROR}: cannot submit ${taskId} in phase '${phase}' (submit applies to implement/integration)`
    );
  }
  // ISH-762: a live Run owns its (task, phase, attempt). A worker submit while the
  // Run is starting/running is refused (RUN_OWNED): a Run-driven phase advances
  // ONLY via the Run-bound `acceptRunSubmission`, never a generic worker submit.
  const liveRun = findLiveRunFor(db, task.id, phase, task.attempt);
  if (liveRun) throw runOwnedError(liveRun, task.id);
  assertOwned(task, workerId, opts.leaseToken);

  // Integration names a moved HEAD: the reviewed head no longer applies.
  if (phase === "integration" && opts.headSha !== undefined && opts.headSha !== task.head_sha) {
    const invalidated = db.transaction(() => {
      // ISH-1245: this submit may have lost a race with a close. Take the write
      // lock and re-read BEFORE invalidating; a late submit is evidence only.
      const guard = db
        .query(`UPDATE tasks SET updated_at = updated_at WHERE id = ? AND state NOT IN (${TERMINAL_STATE_SQL})`)
        .run(taskId);
      if (guard.changes !== 1) {
        const result = insertTaskResult(db, {
          taskId,
          phase,
          attempt: task.attempt,
          kind: "TaskSubmitted",
          workerId,
          headSha: opts.headSha ?? task.head_sha,
          evidenceRef: opts.evidence ?? null,
          reason: "late integration submit (task closed in flight)",
          payload: { source: "submitPhase", late: true, headChanged: opts.headSha },
        });
        return lateResultIgnored(db, taskId, result, workerId, { source: "submitPhase" }) ?? getTask(db, taskId)!;
      }
      return invalidateReview(db, task, opts.headSha!, "integration-head-changed", workerId);
    })();
    if (!isTerminalTaskState(invalidated.state)) requestReconcile(db, `head-changed:${taskId}`);
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
    const u = applyResultPhase(
      db,
      task,
      next,
      {
        state: next === "review" ? "review" : "queued",
        attempt: task.attempt,
        claimRole: nextClaimRole,
        headSha: opts.headSha !== undefined ? opts.headSha : undefined,
        resultRef: `result:${result.id}`,
      },
      result,
      workerId
    );
    if (!u) return getTask(db, taskId)!;
    releaseWorker(db, workerId, taskId);
    return u;
  })();
  if (!isTerminalTaskState(updated.state)) requestReconcile(db, `submit:${taskId}:${next}`);
  return updated;
}

/**
 * ISH-803: the binding a headless dsh Run's structured submission carries. The
 * Run row is the process record; the Task/phase/attempt/branch/HEAD below are
 * re-validated against the LIVE task so a submission for a Run whose HEAD/phase
 * has moved is refused (STALE_RESULT / HEAD_MISMATCH) instead of advancing it.
 */
export interface RunImplementation {
  runId: string;
  /** The phase the Run started in (must equal the task's current phase). */
  phase?: string;
  /** The attempt the Run started at (must equal the task's current attempt). */
  attempt?: number;
  /** The branch the Run produced (adopted by a task with none). */
  branch?: string | null;
  /**
   * The HEAD the Run PRODUCED (recorded on the Task / TaskSubmitted). dsh is
   * asked to commit, so this is the post-run revision, not the start revision.
   */
  headSha?: string | null;
  /**
   * The HEAD the Run STARTED at — the staleness fence. A task bound to a head
   * that is neither this base, the Run's produced head, nor an intermediate
   * commit on the Run's own history has moved since the Run began and is
   * refused (ISH-1087/ISH-1125).
   */
  baseHeadSha?: string | null;
  summary?: string;
  /** Output/evidence ref (the Run's output dir). */
  evidence?: string;
}

/**
 * Record a TaskSubmitted that came from a bound dsh Run and advance the phase.
 *
 * This is the ONLY path by which a headless Run advances a Task: a process
 * `exit 0` or the Run's final stdout text does NOT call it. Unlike `submitPhase`
 * it does not demand a worker-row lease (a headless Run is not a Herdr worker);
 * its authority is the Run binding the caller validated against the `runs` row
 * and re-validated here against the live Task. It still refuses a submission
 * whose phase/attempt/branch/HEAD no longer match the task.
 *
 * An INTEGRATION Run whose produced head differs from the reviewed head calls
 * `invalidateReview` (exactly like `submitPhase`) and sends the task back to
 * `verify` at a new attempt — Relay re-runs the mechanical checks there, then the
 * new head is reviewed; it never advances to `merge_ready` with an unreviewed
 * head.
 */
export function submitImplementationFromRun(db: Database, taskId: string, impl: RunImplementation): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (!isCodeTask(task)) throw new Error(`${WORKFLOW_ERROR}: ${taskId} is not a code-change task`);
  // ISH-808: a terminal task is CLOSED; a Run must never move it out of
  // `cancelled` (its phase is unchanged by the cancel, so the phase checks below
  // would otherwise pass).
  if (isTerminalTaskState(task.state)) {
    throw new Error(`${WORKFLOW_ERROR}: cannot submit a Run for terminal task ${taskId} (state=${task.state})`);
  }
  // ISH-1012: a user HOLD (blocked_human) is never bypassed by a Run that was
  // already in flight when the HOLD landed. The Run stays a recorded process,
  // but it cannot advance the HELD Task.
  if (task.state === "blocked_human") {
    throw new Error(`${WORKFLOW_ERROR}: cannot submit a Run for HELD task ${taskId} (state=blocked_human)`);
  }
  const phase = phaseOf(task);
  if (phase !== "implement" && phase !== "integration") {
    throw new Error(
      `${WORKFLOW_ERROR}: cannot submit a Run for ${taskId} in phase '${phase}' (submit applies to implement/integration)`
    );
  }
  if (impl.phase !== undefined && impl.phase !== phase) {
    throw new Error(`${STALE_RESULT}: run ${impl.runId} started in phase '${impl.phase}', task ${taskId} is '${phase}'`);
  }
  if (impl.attempt !== undefined && impl.attempt !== task.attempt) {
    throw new Error(`${STALE_RESULT}: run ${impl.runId} started at attempt ${impl.attempt}, task ${taskId} is attempt ${task.attempt}`);
  }
  // Branch: a task with none ADOPTS the Run's branch; an already-bound task must
  // match what the Run produced. (A NULL task branch is the normal implement
  // phase — the branch is not linked until a PR exists.)
  if (impl.branch !== undefined && task.branch !== null && (impl.branch ?? null) !== task.branch) {
    throw new Error(
      `${STALE_RESULT}: run ${impl.runId} produced branch ${impl.branch ?? "none"}, task ${taskId} is ${task.branch ?? "none"}`
    );
  }
  // HEAD fence vs produced head: the Run started at `baseHeadSha`; a task bound
  // to any OTHER revision than that base or a commit on the Run's own history
  // has moved since the Run began. The Run's own history includes its produced
  // head, any intermediate push the daemon's provider poll may have bound
  // mid-Run (ISH-1087/1125), and an own head the worker amended/force-pushed
  // away (observed by the poll; ISH-1128). The lineage is checked in the Run's
  // own repo so a foreign head is still refused.
  //
  // `baseHeadSha === undefined` (a direct caller, not `acceptRunSubmission`)
  // falls back to `headSha`, so BOTH fence heads are the produced head and only
  // that exact head (or NULL) can be accepted.
  const baseHead = impl.baseHeadSha !== undefined ? impl.baseHeadSha : impl.headSha;
  const producedHead = impl.headSha ?? null;
  const sourceRun = db.query(`SELECT * FROM runs WHERE id = ?`).get(impl.runId) as Run | null;
  if (
    taskHeadOvertakenByOtherWriter(
      task.head_sha,
      { base_head_sha: baseHead ?? null, head_sha: producedHead },
      sourceRun ? runHeadFenceRepos(sourceRun) : [],
      sourceRun ? runObservedOwnHeads(db, sourceRun.id) : []
    )
  ) {
    throw new Error(
      `${HEAD_MISMATCH}: run ${impl.runId} started at head ${baseHead ?? "none"} and produced ` +
        `${producedHead ?? "none"}, task ${taskId} is bound to ${task.head_sha}`
    );
  }
  // Adopt the Run's branch onto the task ONLY when the task has none.
  const adoptBranch = task.branch === null && impl.branch ? impl.branch : null;
  // An INTEGRATION Run that commits a DIFFERENT head invalidates the review that
  // PASSed the previous head. Mirror `submitPhase`: send the task BACK to review
  // at a new attempt instead of advancing to `merge_ready` with an unreviewed
  // head — a `merge_ready` task whose head no longer matches its passing review
  // dead-ends (the gate refuses to accept it and nothing re-routes it).
  if (phase === "integration" && (producedHead ?? null) !== (task.head_sha ?? null)) {
    const invalidated = db.transaction(() => {
      // ISH-1245: the Run may have finished after a close. Take the write lock
      // and re-read before invalidating; the late submission is evidence only.
      const guard = db
        .query(`UPDATE tasks SET updated_at = updated_at WHERE id = ? AND state NOT IN (${TERMINAL_STATE_SQL})`)
        .run(taskId);
      if (guard.changes !== 1) {
        const result = insertTaskResult(db, {
          taskId,
          phase,
          attempt: task.attempt,
          kind: "TaskSubmitted",
          workerId: `dsh-run:${impl.runId}`,
          headSha: producedHead,
          evidenceRef: impl.evidence ?? `run:${impl.runId}`,
          reason: impl.summary ?? null,
          payload: {
            runId: impl.runId,
            source: "dsh-headless",
            late: true,
            baseHead: impl.baseHeadSha ?? null,
            headChanged: producedHead,
          },
        });
        return lateResultIgnored(db, taskId, result, `dsh-run:${impl.runId}`, {
          source: "submitImplementationFromRun",
        }) ?? getTask(db, taskId)!;
      }
      if (adoptBranch) {
        db.query(`UPDATE tasks SET branch = ?, updated_at = ? WHERE id = ?`).run(adoptBranch, now(), taskId);
      }
      return invalidateReview(db, task, producedHead, "integration-head-changed");
    })();
    if (!isTerminalTaskState(invalidated.state)) requestReconcile(db, `head-changed:${taskId}`);
    return invalidated;
  }
  assertNoResult(db, taskId, phase, task.attempt, "TaskSubmitted");

  const next = nextPhase(phase)!;
  const nextClaimRole =
    next === "verify" && hasMechanicalChecks(task) ? RELAY_ROLE : claimRoleForPhase(next, task.role);
  const updated = db.transaction(() => {
    const result = insertTaskResult(db, {
      taskId,
      phase,
      attempt: task.attempt,
      kind: "TaskSubmitted",
      workerId: `dsh-run:${impl.runId}`,
      // The revision the Run PRODUCED (not the pre-run head).
      headSha: producedHead,
      evidenceRef: impl.evidence ?? `run:${impl.runId}`,
      reason: impl.summary ?? null,
      payload: { runId: impl.runId, source: "dsh-headless", baseHead: impl.baseHeadSha ?? null },
    });
    // ISH-1245: a Run that cleaned up after the Task was closed keeps its
    // submission as evidence; it must not adopt a branch or advance the phase.
    const late = lateResultIgnored(db, taskId, result, `dsh-run:${impl.runId}`, {
      source: "submitImplementationFromRun",
    });
    if (late) return late;
    if (adoptBranch) {
      db.query(`UPDATE tasks SET branch = ?, updated_at = ? WHERE id = ?`).run(adoptBranch, now(), taskId);
    }
    return applyPhase(db, task, next, {
      state: next === "review" ? "review" : "queued",
      attempt: task.attempt,
      claimRole: nextClaimRole,
      // Record the produced head on the task so verify/review judge the same
      // revision the Run committed (submitPhase does this with opts.headSha).
      headSha: producedHead,
      resultRef: `result:${result.id}`,
    });
  })();
  if (!isTerminalTaskState(updated.state)) requestReconcile(db, `run-submit:${taskId}:${next}`);
  return updated;
}

/**
 * ISH-1245: a cleanly exited Run that lost a race with a Task close keeps its
 * structured submission as EVIDENCE. The Task keeps its terminal state; the
 * caller (`acceptRunSubmission`) still refuses the Run with its ordinary
 * `RUN_SUBMISSION_REJECTED`, but the run's produced HEAD/summary are durable in
 * `task_results` and audited by `task.late_result_ignored`.
 */
export function recordLateRunSubmission(db: Database, task: Task, run: Run): TaskResult {
  return db.transaction(() => {
    const result = insertTaskResult(db, {
      taskId: task.id,
      phase: run.phase,
      attempt: run.attempt,
      kind: "TaskSubmitted",
      workerId: `dsh-run:${run.id}`,
      headSha: run.head_sha,
      evidenceRef: `run:${run.id}`,
      reason: `late submission for ${task.state} task ${task.id}`,
      payload: {
        runId: run.id,
        source: "dsh-headless",
        late: true,
        taskState: task.state,
        baseHead: run.base_head_sha,
      },
    });
    lateResultIgnored(db, task.id, result, `dsh-run:${run.id}`, {
      source: "acceptRunSubmission",
      baseHead: run.base_head_sha,
    });
    return result;
  })();
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
  if (isTerminalTaskState(task.state)) {
    throw new Error(`${WORKFLOW_ERROR}: cannot record a verification for terminal task ${taskId} (state=${task.state})`);
  }
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
      const u = applyResultPhase(
        db,
        task,
        "review",
        {
          state: "review",
          attempt: task.attempt,
          claimRole: REVIEWER_ROLE,
          headSha: opts.headSha !== undefined ? opts.headSha : undefined,
          resultRef: `result:${result.id}`,
        },
        result,
        workerId
      );
      if (!u) return getTask(db, taskId)!;
      releaseWorker(db, workerId, taskId);
      return u;
    })();
    if (!isTerminalTaskState(updated.state)) requestReconcile(db, `verified:${taskId}`);
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
    const u = applyResultPhase(
      db,
      task,
      "implement",
      {
        state: "queued",
        attempt: task.attempt + 1,
        claimRole: claimRoleForPhase("implement", task.role),
        clearHead: true,
        resultRef: `result:${result.id}`,
      },
      result,
      workerId
    );
    if (!u) return getTask(db, taskId)!;
    releaseWorker(db, workerId, taskId);
    return u;
  })();
  if (!isTerminalTaskState(updated.state)) requestReconcile(db, `verify-failed:${taskId}`);
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
 *
 * ISH-1012: `nextAttempt` lets an IMPLEMENT failure park the Task on the NEXT
 * attempt, so a later `unblock` starts a FRESH Run instead of reusing the
 * attempt whose Run already failed.
 */
export function quietBlock(
  db: Database,
  task: Task,
  reason: string,
  actor: string,
  opts: { nextAttempt?: number } = {}
): Task {
  // ISH-808: a terminal (e.g. cancelled) task is CLOSED and must not be parked
  // into blocked_human by a late verify/provider pass.
  if (isTerminalTaskState(task.state)) {
    throw new Error(`${WORKFLOW_ERROR}: cannot block terminal task ${task.id} (state=${task.state})`);
  }
  const t = now();
  const prev = task.assignee;
  const attempt = opts.nextAttempt ?? task.attempt;
  const blocked = db.transaction(() => {
    // ISH-1245: take the write lock and re-read before parking. A close that
    // committed after the caller's check must not be overwritten by a late HOLD.
    const guard = db
      .query(
        `UPDATE tasks
            SET state = 'blocked_human', assignee = NULL, lease_until = NULL,
                attempt = ?, lease_token = lease_token + 1, updated_at = ?
          WHERE id = ? AND state NOT IN (${TERMINAL_STATE_SQL})`
      )
      .run(attempt, t, task.id);
    if (guard.changes !== 1) {
      const live = getTask(db, task.id)!;
      logEvent(db, {
        source: "workflow",
        taskId: task.id,
        type: "task.late_result_ignored",
        payload: { kind: "ChildBlocked", taskState: live.state, reason, actor },
      });
      return live;
    }
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
    return null;
  })();
  if (blocked) return blocked;
  recordChildBlocked(db, task.id, actor, reason, { notifyGateway: true });
  requestReconcile(db, `blocked:${task.id}`);
  return getTask(db, task.id)!;
}

/**
 * ISH-1012: the terminal IMPLEMENT Run states. A recovery transition is refused
 * unless the previous Run is provably here — a still-live writer holds the fence.
 */
const IMPLEMENT_TERMINAL_RUN_STATES: ReadonlySet<string> = new Set(["exited", "failed", "cancelled", "timeout", "submitted"]);

export interface ImplementRecoveryTransition {
  /** The failed IMPLEMENT Run whose terminal state released the fence. */
  runId: string;
  /** Stable failure signature (same-failure stop; recorded for replay). */
  signature: string;
  /** Concrete, non-empty retry reason. */
  reason: string;
  /** Concrete evidence lines (Run state/exit/head/error). */
  evidence: string[];
  /** Actor label for events (default `factory`). */
  actor?: string;
}

/**
 * ISH-1012: route a FAILED IMPLEMENT attempt to a FRESH attempt on the SAME
 * Task/worktree. This is the ordinary phase/attempt transition VERIFY
 * FAIL already uses (`applyPhase`), NOT a new state machine:
 *
 *   implement@N (terminal failed Run) -> implement@N+1 (no Run yet)
 *
 * It refuses unless ALL of these hold:
 *   - the Task is still a runnable code-change Task in `implement`;
 *   - `runId` is THIS Task's CURRENT attempt's IMPLEMENT Run and is terminal;
 *   - no live Run owns the current `(task, implement, attempt)`;
 *   - the single-writer fence is released for the Run's worktree/branch;
 *   - a non-empty retry reason AND concrete evidence were supplied.
 *
 * The conditional UPDATE additionally makes the transition idempotent: a
 * replayed/concurrent call observes 0 changes and gets `STALE_ATTEMPT` instead of
 * bumping the attempt twice / starting a second Run for one attempt.
 */
export function recordImplementRecovery(db: Database, taskId: string, input: ImplementRecoveryTransition): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (!isCodeTask(task)) throw new Error(`${WORKFLOW_ERROR}: ${taskId} is not a code-change task`);
  if (isTerminalTaskState(task.state)) {
    throw new Error(`${WORKFLOW_ERROR}: cannot recover terminal task ${taskId} (state=${task.state})`);
  }
  if (task.phase !== "implement") {
    throw new Error(`${WORKFLOW_ERROR}: cannot recover implement on ${taskId} in phase '${task.phase ?? "none"}'`);
  }
  // A HOLD / durable block is never bypassed by an automatic recovery.
  if (task.state !== "queued" && task.state !== "running") {
    throw new Error(`${WORKFLOW_ERROR}: cannot recover implement on ${taskId} in state ${task.state} (a user HOLD/block stops recovery)`);
  }
  if (!input.reason.trim()) throw new Error(`${WORKFLOW_ERROR}: implement recovery requires a non-empty retry reason`);
  if (input.evidence.length === 0 || input.evidence.every((e) => !e.trim())) {
    throw new Error(`${WORKFLOW_ERROR}: implement recovery requires concrete evidence`);
  }
  const run = db.query(`SELECT * FROM runs WHERE id = ?`).get(input.runId) as Run | null;
  if (!run) throw new Error(`${WORKFLOW_ERROR}: unknown run ${input.runId}`);
  if (run.task_id !== taskId || run.phase !== "implement" || run.attempt !== task.attempt) {
    throw new Error(
      `${STALE_RESULT}: run ${run.id} is ${run.task_id} ${run.phase}/${run.attempt}, task ${taskId} is implement/${task.attempt}`
    );
  }
  if (!IMPLEMENT_TERMINAL_RUN_STATES.has(run.state)) {
    throw new Error(
      `${STALE_RESULT}: run ${run.id} is still '${run.state}'; the single-writer fence is held and no new attempt may start`
    );
  }
  const live = findLiveRunFor(db, taskId, "implement", task.attempt);
  if (live) {
    throw new Error(`${STALE_RESULT}: run ${live.id} is still live for ${taskId} implement/${task.attempt}; refusing a second writer`);
  }
  const writer = findActiveWriterRow(db, { cwd: run.cwd, branch: run.branch, excludeRunId: run.id });
  if (writer) {
    throw new Error(
      `${STALE_RESULT}: run ${writer.id} still holds the writer fence on ${writer.cwd}/${writer.branch ?? "none"}; refusing a new attempt`
    );
  }

  const updated = db.transaction(() => {
    // ISH-1245: recovery is a state transition too. Take the write lock and
    // re-read so a close committed after the entry check is never overwritten.
    const guard = db
      .query(`UPDATE tasks SET updated_at = updated_at WHERE id = ? AND state NOT IN (${TERMINAL_STATE_SQL})`)
      .run(taskId);
    if (guard.changes !== 1) {
      const live = getTask(db, taskId)!;
      logEvent(db, {
        source: "factory",
        taskId,
        type: "task.late_result_ignored",
        payload: {
          kind: "ImplementRecovery",
          taskState: live.state,
          runId: run.id,
          fromAttempt: task.attempt,
          signature: input.signature,
          reason: input.reason,
        },
      });
      return live;
    }
    logEvent(db, {
      source: "factory",
      taskId,
      type: "factory.implement_retry",
      payload: {
        runId: run.id,
        fromAttempt: task.attempt,
        toAttempt: task.attempt + 1,
        signature: input.signature,
        reason: input.reason,
        evidence: input.evidence,
        actor: input.actor ?? "factory",
      },
    });
    return applyPhase(db, task, "implement", {
      state: "queued",
      attempt: task.attempt + 1,
      claimRole: claimRoleForPhase("implement", task.role),
      clearHead: true,
      expectPhase: "implement",
      expectAttempt: task.attempt,
    });
  })();
  if (!isTerminalTaskState(updated.state)) requestReconcile(db, `implement-recovery:${taskId}`);
  return updated;
}

/**
 * ISH-1012: STOP a non-recoverable IMPLEMENT attempt as a BLOCKED Task. The
 * attempt is advanced BEFORE parking, so a later explicit `unblock` starts a
 * fresh Run instead of reusing the attempt whose Run already failed. A Task that
 * is already parked (e.g. a user HOLD landed first) is left untouched.
 */
export function blockImplementFailure(db: Database, taskId: string, reason: string, actor = "factory"): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (!isCodeTask(task)) throw new Error(`${WORKFLOW_ERROR}: ${taskId} is not a code-change task`);
  if (isTerminalTaskState(task.state)) return task;
  // A HOLD already parked it: never overwrite the human's reason.
  if (task.state !== "queued" && task.state !== "running") return task;
  if (task.phase !== "implement") return task;
  const blocked = quietBlock(db, task, reason, actor, { nextAttempt: task.attempt + 1 });
  logEvent(db, {
    source: "factory",
    taskId,
    type: "factory.implement_blocked",
    payload: { fromAttempt: task.attempt, toAttempt: task.attempt + 1, reason },
  });
  return blocked;
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
  // ISH-808: never mechanically verify a terminal (e.g. cancelled) task — the
  // NOT_RUN path would otherwise quietBlock it into blocked_human.
  if (isTerminalTaskState(task.state)) {
    throw new Error(`${WORKFLOW_ERROR}: cannot mechanically verify terminal task ${taskId} (state=${task.state})`);
  }
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
    // ISH-1225: VERIFY runs in the Task worktree and MUST use the SAME Task-level
    // Cargo cache as the implement/FIX Runs, even if the daemon inherited a host
    // CARGO_TARGET_DIR. The worktree's `target/` is Cargo's natural default, so
    // this is also what an unmodified check command would use.
    const cargoTargetDir = taskCargoTarget(opts.cwd);
    const run = await runChecks(opts.checks, opts.runner, opts.cwd, {
      env: {
        CARGO_TARGET_DIR: cargoTargetDir,
        RELAY_CARGO_TARGET_DIR: cargoTargetDir,
        RELAY_TASK_CARGO_TARGET_DIR: cargoTargetDir,
      },
    });
    outcome = run.outcome;
    checks = run.checks;
  }

  // Re-read: the run may have raced a head move / a rework. Only advance if the
  // task is STILL the verify/attempt/head we started on.
  const evidence = checks
    .map((c) => `${c.name}=${c.outcome}${c.exitCode === null ? "" : `(exit ${c.exitCode})`}`)
    .join(" ");
  const payload = { outcome, checks: checks.map((c) => ({ ...c })) };

  // ISH-1245: `cancelTask` leaves phase/attempt/head untouched, so the stale
  // fence below cannot notice a close. A result produced after one is recorded
  // as EVIDENCE (never applied) with `task.late_result_ignored`.
  const live = getTask(db, taskId)!;
  if (isTerminalTaskState(live.state)) {
    db.transaction(() => {
      const result = insertTaskResult(db, {
        taskId,
        phase: "verify",
        attempt: task.attempt,
        kind: "VerificationResult",
        workerId: actor,
        passed: outcome === "pass",
        headSha: head,
        evidenceRef: evidence,
        reason: outcome === "pass" ? null : bindingError ?? `${outcome}: ${evidence}`,
        payload,
      });
      lateResultIgnored(db, taskId, result, actor, { source: "mechanical-verify", outcome });
    })();
    return { task: live, outcome, checks, stale: true };
  }
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
      return applyResultPhase(
        db,
        task,
        "review",
        {
          state: "review",
          attempt: task.attempt,
          claimRole: REVIEWER_ROLE,
          resultRef: `result:${result.id}`,
        },
        result,
        actor
      ) ?? getTask(db, taskId)!;
    })();
    if (!isTerminalTaskState(updated.state)) requestReconcile(db, `verified:${taskId}`);
    return { task: updated, outcome, checks, stale: isTerminalTaskState(updated.state) };
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
      return applyResultPhase(
        db,
        task,
        "implement",
        {
          state: "queued",
          attempt: task.attempt + 1,
          claimRole: claimRoleForPhase("implement", task.role),
          clearHead: true,
          resultRef: `result:${result.id}`,
        },
        result,
        actor
      ) ?? getTask(db, taskId)!;
    })();
    if (!isTerminalTaskState(updated.state)) requestReconcile(db, `verify-failed:${taskId}`);
    return { task: updated, outcome, checks, stale: isTerminalTaskState(updated.state) };
  }

  // not_run / inconclusive for a required check: BLOCK, do not PASS. The
  // VerificationResult records the outcome for evidence, then the task blocks.
  const blockReason = bindingError ?? `${outcome}: ${evidence}`;
  const recorded = db.transaction(() => {
    const result = insertTaskResult(db, {
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
    return lateResultIgnored(db, taskId, result, actor, { source: "mechanical-verify", outcome }) ?? getTask(db, taskId)!;
  })();
  if (isTerminalTaskState(recorded.state)) return { task: recorded, outcome, checks, stale: true };
  const blocked = quietBlock(db, recorded, `mechanical verify ${outcome}: ${blockReason}`, actor);
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
   * ISH-759/ISH-904: explicitly SUPERSEDE an unresolved NG (a PASS at a head
   * that still carries an NG is otherwise refused), AND — on a `merge_ready`
   * task whose PR cannot be merged — name the PASS being replaced so the Task can
   * return to `implement` at attempt+1 with `reason` as the FIX brief. A
   * superseding result is written as a REPLACEMENT (same identity, same id)
   * instead of hitting DUPLICATE_DISPATCH/the identity UNIQUE constraint.
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
  const suppliedSupersede =
    opts.supersedesResultId !== undefined ? getTaskResult(db, opts.supersedesResultId) : null;
  if (opts.supersedesResultId !== undefined) {
    if (!suppliedSupersede) {
      throw new Error(`${WORKFLOW_ERROR}: --supersedes result ${opts.supersedesResultId} was not found`);
    }
    if (suppliedSupersede.task_id !== taskId || suppliedSupersede.kind !== "ReviewResult") {
      throw new Error(
        `${WORKFLOW_ERROR}: --supersedes result ${suppliedSupersede.id} is not a ReviewResult for ${taskId}`
      );
    }
  }
  // ISH-904: a `merge_ready` task whose PR cannot be merged has NO supported
  // route back. A superseding FAIL re-opens the SAME task at attempt+1 (the
  // reason becomes the FIX brief) instead of requiring SQLite surgery. Without
  // an explicit --supersedes the CURRENT passing review is the deliberate
  // replacement, so the operator does not need to know its result id.
  const reopenMergeReady =
    phase === "merge_ready" &&
    (opts.verdict === "fix" || opts.verdict === "fail") &&
    (task.state === "queued" || task.state === "review") &&
    task.merged_at === null;
  if (task.state !== "review" || phase !== "review") {
    if (!reopenMergeReady) {
      throw new Error(`${WORKFLOW_ERROR}: cannot record a review for ${taskId} (state ${task.state}, phase ${phase})`);
    }
  }
  let supersedeTarget = suppliedSupersede;
  if (reopenMergeReady) {
    supersedeTarget = supersedeTarget ?? findPassingReview(db, taskId, task.attempt);
    if (!supersedeTarget) {
      throw new Error(
        `${WORKFLOW_ERROR}: cannot re-open ${taskId} from merge_ready: no passing review for attempt ${task.attempt}`
      );
    }
    if (supersedeTarget.passed !== 1) {
      throw new Error(
        `${WORKFLOW_ERROR}: cannot re-open ${taskId} from merge_ready: result ${supersedeTarget.id} is not a PASS`
      );
    }
    if (!(opts.reason ?? "").trim()) {
      throw new Error(
        `${WORKFLOW_ERROR}: a merge_ready rework needs --reason "<why the PR is not mergeable>" (the FIX brief)`
      );
    }
    if (!task.head_sha || (supersedeTarget.head_sha ?? null) !== task.head_sha) {
      throw new Error(
        `${HEAD_MISMATCH}: cannot re-open ${taskId} from merge_ready: the superseded PASS is not at the current head ${task.head_sha ?? "none"}`
      );
    }
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
  // Duplicate dispatch: the same PR+HEAD+profile is reviewed once PER REVIEW
  // EPOCH. A base-branch retarget keeps the HEAD but re-opens the review at a new
  // attempt (the epoch); reviews from before that attempt are ignored, so a fresh
  // review of the retargeted diff is accepted while an unretargeted rework is still
  // refused. The base is recorded for evidence, but is NOT the identity (a base name
  // can recur on a revert).
  const base = task.pr_base ?? null;
  const resultPhase = reopenMergeReady ? supersedeTarget!.phase : phase;
  const resultAttempt = reopenMergeReady ? supersedeTarget!.attempt : task.attempt;
  const supersedesId = supersedeTarget?.id;
  // A DELIBERATE supersede is exactly what lets a replacement verdict through:
  // it skips duplicate-dispatch and is written as a replacement (same id) rather
  // than a second row for the same (task, phase, attempt, kind).
  if (!supersedesId && findReviewForHead(db, taskId, head, profile)) {
    throw new Error(
      `${DUPLICATE_DISPATCH}: ${taskId} head ${head} already has a review (profile '${profile}') in this review epoch`
    );
  }
  // Unresolved NG at this head: a later OK must explicitly supersede it. Checked
  // after duplicate-dispatch so a re-review of the same profile is still a
  // DUPLICATE_DISPATCH; a *different profile's* later OK hits this rule instead.
  if (opts.verdict === "pass") {
    const ng = findUnresolvedNgAtHead(db, taskId, head);
    if (ng && ng.id !== supersedesId) {
      throw new Error(
        `${UNRESOLVED_NG}: ${taskId} head ${head ?? "none"} still carries an unresolved NG (result ${ng.id}); ` +
        `a later OK alone does not clear it — fix the head or supersede the NG explicitly`
      );
    }
  }
  if (!supersedesId) assertNoResult(db, taskId, phase, task.attempt, "ReviewResult");

  const basePayload = {
    source: opts.source ?? (external ? "external" : "worker"),
    reviewer: identity,
    // The base BRANCH this review judged — recorded for evidence. The duplicate
    // guard uses the review EPOCH, not this value.
    base,
    ...(supersedesId ? { supersedes: supersedesId } : {}),
  };

  if (opts.verdict === "pass") {
    const updated = db.transaction(() => {
      const result = insertTaskResult(db, {
        taskId,
        phase: resultPhase,
        attempt: resultAttempt,
        kind: "ReviewResult",
        workerId: identity,
        passed: true,
        headSha: head,
        profile,
        reason: opts.reason ?? null,
        evidenceRef: opts.evidence ?? null,
        payload: basePayload,
        ...(supersedesId ? { supersedes: supersedesId } : {}),
      });
      const u = applyResultPhase(
        db,
        task,
        "integration",
        {
          state: "queued",
          attempt: task.attempt,
          claimRole: INTEGRATOR_ROLE,
          resultRef: `result:${result.id}`,
        },
        result,
        identity
      );
      if (!u) return getTask(db, taskId)!;
      if (!external) releaseWorker(db, reviewerId, taskId);
      return u;
    })();
    if (!isTerminalTaskState(updated.state)) requestReconcile(db, `review-pass:${taskId}`);
    return updated;
  }

  if (opts.verdict === "blocked") {
    const updated = db.transaction(() => {
      const result = insertTaskResult(db, {
        taskId,
        phase: resultPhase,
        attempt: resultAttempt,
        kind: "ReviewResult",
        workerId: identity,
        passed: false,
        headSha: head,
        profile,
        reason: opts.reason ?? null,
        evidenceRef: opts.evidence ?? null,
        payload: { ...basePayload, blocked: true },
        ...(supersedesId ? { supersedes: supersedesId } : {}),
      });
      // ISH-1245: a BLOCKED verdict that finished after a close is evidence
      // only; it must not park the Task into blocked_human.
      return lateResultIgnored(db, taskId, result, identity) ?? getTask(db, taskId)!;
    })();
    if (isTerminalTaskState(updated.state)) return updated;
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
  // ISH-904: from `merge_ready` this is the supported route back when the PR is
  // not mergeable — the superseded PASS is replaced by this FAIL, the reason is
  // the next FIX brief, and the attempt advances.
  const updated = db.transaction(() => {
    const result = insertTaskResult(db, {
      taskId,
      phase: resultPhase,
      attempt: resultAttempt,
      kind: "ReviewResult",
      workerId: identity,
      passed: false,
      headSha: head,
      profile,
      reason: opts.reason ?? null,
      evidenceRef: opts.evidence ?? null,
      payload: basePayload,
      ...(supersedesId ? { supersedes: supersedesId } : {}),
    });
    const u = applyResultPhase(
      db,
      task,
      "implement",
      {
        state: "queued",
        attempt: task.attempt + 1,
        claimRole: claimRoleForPhase("implement", task.role),
        clearHead: true,
        resultRef: `result:${result.id}`,
      },
      result,
      identity
    );
    if (!u) return getTask(db, taskId)!;
    if (!external) releaseWorker(db, reviewerId, taskId);
    return u;
  })();
  if (reopenMergeReady && !isTerminalTaskState(updated.state)) {
    logEvent(db, {
      source: "workflow",
      taskId,
      type: "workflow.review_reopened",
      payload: {
        from: "merge_ready",
        supersedes: supersedesId ?? null,
        attempt: task.attempt + 1,
        reason: opts.reason ?? null,
      },
    });
  }
  if (!isTerminalTaskState(updated.state)) requestReconcile(db, `review-fix:${taskId}`);
  return updated;
}

export interface MergeReadyRebaseOptions {
  /** The FIX brief the next implement Run inherits. */
  reason: string;
  /**
   * The OBSERVED mergeability of the bound PR. Only a real conflict can be
   * routed here; a mergeable/unknown PR is refused (never assumed conflicting).
   */
  prMergeable: "mergeable" | "conflicting" | "unknown";
  /** The PR head the observation was made at; it must match the recorded head. */
  prHeadSha?: string | null;
  /** A structured owner HOLD observed on Linear / a PR label, if any. */
  hold?: string | null;
  /** The caller's expected recorded HEAD (a stale caller is refused). */
  headSha?: string | null;
}

/**
 * ISH-1122: the coordinator-authorised REBASE FIX route.
 *
 * A Task parked at `merge_ready` whose bound PR has become CONFLICTING can be
 * returned to `implement` at attempt+1 with `reason` as the FIX brief. This is
 * deliberately NOT a review verdict:
 *
 *   - it never inserts/updates a ReviewResult (the prior PASS stays as history);
 *   - it refuses when an unresolved reviewer NG/HOLD exists at the current HEAD,
 *     so it can never clear or override one;
 *   - it refuses a structured owner HOLD (passed in from the provider read);
 *   - it clears the recorded HEAD and advances the attempt, so the prior PASS can
 *     never authorise a merge: the new head needs a fresh VERIFY + independent
 *     review.
 *
 * Authority: the Gateway/human for the Task, or an `integrator` identity. This is
 * exactly the same principal that may ACCEPT a merge_ready Task; the independent
 * reviewer role is not required (and is not impersonated by the coordinator).
 *
 * The provider observation (conflict / HOLD / PR head) is resolved by
 * `src/rebase.ts`, which reads the bound PR through the read-only GitHub reader.
 */
export function requestMergeReadyRebase(
  db: Database,
  taskId: string,
  actor: string,
  opts: MergeReadyRebaseOptions
): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (!isCodeTask(task)) throw new Error(`${WORKFLOW_ERROR}: ${taskId} is not a code-change task`);
  if (!actor.trim()) throw new Error(`${AUTHORITY_ERROR}: a rebase request needs an actor identity`);
  if (isTerminalTaskState(task.state)) {
    throw new Error(`${REBASE_REFUSED}: cannot rebase terminal task ${taskId} (state=${task.state})`);
  }
  const phase = phaseOf(task);
  if (phase !== "merge_ready") {
    throw new Error(
      `${REBASE_REFUSED}: cannot rebase ${taskId} at phase '${phase}'; the route applies only at merge_ready`
    );
  }
  if (task.state !== "queued" && task.state !== "review") {
    throw new Error(
      `${REBASE_REFUSED}: cannot rebase ${taskId} while it is ${task.state}; a merge_ready Task awaiting acceptance is ` +
      `queued (not held/running)`
    );
  }
  if (task.merged_at !== null) {
    throw new Error(`${REBASE_REFUSED}: ${taskId} is already merged; there is nothing to rebase`);
  }
  if (!task.head_sha) {
    throw new Error(`${REBASE_REFUSED}: ${taskId} records no HEAD; a conflict cannot be bound to a revision`);
  }
  if (opts.headSha && opts.headSha !== task.head_sha) {
    throw new Error(
      `${HEAD_MISMATCH}: rebase head ${opts.headSha} != task head ${task.head_sha} for ${taskId}`
    );
  }
  const reason = (opts.reason ?? "").trim();
  if (!reason) {
    throw new Error(
      `${REBASE_REFUSED}: a rebase needs --reason "<why the PR is not mergeable>" (it becomes the FIX brief)`
    );
  }
  if (opts.prMergeable !== "conflicting") {
    throw new Error(
      `${REBASE_REFUSED}: the bound PR is ${opts.prMergeable}, not conflicting; ` +
      `only a real merge conflict can route a merge_ready Task back for a rebase`
    );
  }
  if (opts.prHeadSha && opts.prHeadSha !== task.head_sha) {
    throw new Error(
      `${HEAD_MISMATCH}: the conflicting PR head ${opts.prHeadSha} != recorded head ${task.head_sha} for ${taskId}; ` +
      `the observation is not of this work`
    );
  }
  if (opts.hold) {
    throw new Error(`${REBASE_REFUSED}: ${taskId} is under an owner HOLD (${opts.hold}); a rebase cannot clear it`);
  }
  // An unresolved NG/HOLD at this HEAD is a reviewer decision, not a routing
  // problem. Refuse before touching anything: a rebase must never clear it.
  const unresolved = findUnresolvedNgAtHead(db, taskId, task.head_sha);
  if (unresolved) {
    throw new Error(
      `${REBASE_REFUSED}: ${taskId} HEAD ${task.head_sha} carries an unresolved reviewer NG/HOLD ` +
      `(result ${unresolved.id}); resolve or explicitly supersede it through the review path instead`
    );
  }
  // The transition inherits the reviewed merge_ready state. Requiring the PASS is
  // what makes "the old PASS no longer authorises a merge" a strict downgrade:
  // the row stays as history, but the task moves past it.
  const pass = findPassingReview(db, taskId, task.attempt);
  if (!pass) {
    throw new Error(
      `${REBASE_REFUSED}: ${taskId} has no passing review for attempt ${task.attempt}; a rebase is not a review`
    );
  }
  if ((pass.head_sha ?? null) !== task.head_sha) {
    throw new Error(
      `${HEAD_MISMATCH}: the passing review judged ${pass.head_sha ?? "none"}, not the current head ${task.head_sha} ` +
      `for ${taskId}; re-review is required before a rebase route`
    );
  }

  // Authority: the Gateway/human for the Task, or an integrator. This mirrors
  // acceptTask; a reviewer is deliberately not enough (and is never impersonated).
  const actorWorker = getWorker(db, actor);
  const isIntegrator = actorWorker?.role === INTEGRATOR_ROLE;
  const gateway = resolveHumanInterface(db, task);
  const isGateway = gateway !== null && gateway === actor;
  if (!isIntegrator && !isGateway) {
    throw new Error(
      `${AUTHORITY_ERROR}: ${actor} may not rebase ${taskId}; need the Gateway/human ` +
      `(${gateway ?? "unresolved"}) or role '${INTEGRATOR_ROLE}'`
    );
  }

  const fromAttempt = task.attempt;
  const toAttempt = fromAttempt + 1;
  const updated = db.transaction(() => {
    const t = now();
    // ISH-1245: a provider read (conflict/HOLD) is asynchronous, so the Task may
    // have been closed before this transition starts. Take the write lock and
    // re-read; a late rebase is evidence only and never re-opens the Task.
    const guard = db
      .query(`UPDATE tasks SET updated_at = updated_at WHERE id = ? AND state NOT IN (${TERMINAL_STATE_SQL})`)
      .run(task.id);
    if (guard.changes !== 1) {
      const live = getTask(db, task.id)!;
      logEvent(db, {
        source: "workflow",
        workerId: actor,
        taskId,
        type: "task.late_result_ignored",
        payload: {
          kind: "RebaseRequested",
          taskState: live.state,
          fromPhase: "merge_ready",
          fromHead: task.head_sha,
          fromAttempt,
          reason,
          prMergeable: opts.prMergeable,
          prHead: opts.prHeadSha ?? null,
          supersededPass: pass.id,
        },
      });
      return live;
    }
    db.query(
      `INSERT INTO task_notes (task_id, worker_id, kind, body, created_at)
       VALUES (?, ?, 'rebase', ?, ?)`
    ).run(task.id, actor, reason, t);
    const u = applyPhase(db, task, "implement", {
      state: "queued",
      attempt: toAttempt,
      claimRole: claimRoleForPhase("implement", task.role),
      // The new head is not known yet, and the prior PASS judged the old one.
      clearHead: true,
      resultRef: null,
      expectPhase: "merge_ready",
      expectAttempt: fromAttempt,
    });
    logEvent(db, {
      source: "workflow",
      workerId: actor,
      taskId,
      type: "workflow.rebase_requested",
      payload: {
        fromPhase: "merge_ready",
        fromHead: task.head_sha,
        fromAttempt,
        toAttempt,
        reason,
        prMergeable: opts.prMergeable,
        prHead: opts.prHeadSha ?? null,
        supersededPass: pass.id,
        hold: opts.hold ?? null,
      },
    });
    releaseWorker(db, actor, taskId, t);
    return u;
  })();
  if (!isTerminalTaskState(updated.state)) requestReconcile(db, `rebase:${taskId}`);
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
  // ISH-808: a cancelled task at merge_ready must not be accepted into `done`.
  if (isTerminalTaskState(task.state)) {
    throw new Error(`${GATE_ERROR}: cannot accept terminal task ${taskId} (state=${task.state})`);
  }
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
    // ISH-1245: an accept that lost a race with cancel must not turn a CLOSED
    // Task into `done` (or bubble a false completion to its parent).
    const u = applyResultPhase(
      db,
      task,
      phase,
      {
        state: "done",
        attempt: task.attempt,
        claimRole: null,
        acceptedAt: t,
        resultRef: `result:${result.id}`,
      },
      result,
      actor
    );
    if (!u) return getTask(db, taskId)!;
    releaseWorker(db, actor, taskId, t);
    notifyParentAccepted(db, u);
    return u;
  })();
  if (!isTerminalTaskState(updated.state) || updated.state === "done") requestReconcile(db, `accept:${taskId}`);
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
 * True when the Task has an explicit PR identity (`owner/repo#n`, a GitHub PR
 * URL, or `#n`/`n` with a `pr_repo`). A branch name is never an identity — only
 * a re-read/bound PR (or an intake URL) can make a merge creditable.
 */
function hasBoundPr(task: Pick<Task, "pr_url" | "pr_repo">): boolean {
  if (!task.pr_url) return false;
  if (/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i.test(task.pr_url)) return true;
  if (/^[^#\s]+\/[^#\s]+#\d+$/.test(task.pr_url)) return true;
  if (/#\d+$/.test(task.pr_url) || /^\d+$/.test(task.pr_url)) return !!task.pr_repo;
  return false;
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
  // ISH-808: never touch a cancelled/failed task. `done` is deliberately allowed
  // — accept-then-merge credits the merge on an already-accepted task.
  if (task.state === "cancelled" || task.state === "failed") {
    throw new Error(`${GATE_ERROR}: cannot confirm a merge for ${taskId} (state ${task.state})`);
  }
  const phase = phaseOf(task);
  // A merge may be observed any time AFTER the review passed (integration,
  // merge_ready) or once the task is internally accepted. A merge seen while the
  // task is still in review/implement is NOT credited (the reviewed head is not
  // settled yet) and is logged as not-credited instead.
  const postReview = phase === "integration" || phase === "merge_ready" || task.state === "done";
  if (!postReview) {
    throw new Error(
      `${GATE_ERROR}: cannot confirm a merge for ${taskId} at phase '${phase}' state '${task.state}'; ` +
      `a merge is credited only after the review passed (integration/merge_ready/accepted)`
    );
  }
  const mergedHead = opts.headSha ?? task.head_sha;
  if (task.head_sha && mergedHead && mergedHead !== task.head_sha) {
    throw new Error(
      `${HEAD_MISMATCH}: merged head ${mergedHead} != task head ${task.head_sha} for ${taskId}; not this work`
    );
  }
  if (findMergedResult(db, taskId)) return task; // exactly once
  // ISH-1087: a merge is credited ONLY against an explicitly bound PR. The live
  // failure was a Factory Task with NO PR at all being marked accepted+merged:
  // the merge gate was BLOCKED/NO_PR, so crediting the merge hid the bypass.
  // This is an observation guard, not a merge executor: `relay pr bind` the real
  // PR first, then credit its merge at the recorded head.
  if (!hasBoundPr(task)) {
    throw new Error(
      `${GATE_ERROR}: NO_PR: cannot confirm a merge for ${taskId}; no PR is bound ` +
        `(the merge gate would be BLOCKED). Run \`relay pr bind ${taskId}\` first; Relay never invents a merge.`
    );
  }
  const t = now();
  const updated = db.transaction(() => {
    // ISH-1245: a merge observation read from the provider can race a cancel.
    // `done` is deliberately still allowed (accept-then-merge), but a Task that
    // closed as cancelled/failed is never credited with a late merge.
    const guard = db
      .query(`UPDATE tasks SET updated_at = updated_at WHERE id = ? AND state NOT IN ('cancelled','failed')`)
      .run(taskId);
    if (guard.changes !== 1) {
      const live = getTask(db, taskId)!;
      logEvent(db, {
        source: "workflow",
        taskId,
        type: "task.late_result_ignored",
        payload: {
          kind: "TaskMerged",
          taskState: live.state,
          head: mergedHead,
          repo: opts.repo ?? task.pr_repo,
          reason: opts.reason ?? null,
        },
      });
      return live;
    }
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
  if (updated.state !== "cancelled" && updated.state !== "failed") requestReconcile(db, `merged:${taskId}`);
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
  if (phase === "review") {
    return !findReviewForHead(db, taskId, task.head_sha, task.review_profile ?? DEFAULT_REVIEW_PROFILE);
  }
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
