import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { now, projectRoot } from "./db";
import { logEvent } from "./events";
import { getTask, claimTask } from "./tasks";
import { ensureHeadlessWorker, HEADLESS_AGENT_KIND } from "./workers";
import { INTEGRATOR_ROLE, REVIEWER_ROLE } from "./schema";
import type { Run, RunState, Task, TaskState } from "./schema";
import { isCanonicalToken, processPgid, spawnIdentityToken } from "./proc-identity";
import { defaultRunner, type CommandRunner } from "./verify";
import { runMechanicalVerification, submitPhase, taskChecks, blockImplementFailure, recordImplementRecovery, linkTask } from "./workflow";
import { findTaskResult, isResultWriteError, markTaskBlockedInternal } from "./results";
import { acceptRunSubmission, getRun, startDshRun, type DshRunHandle } from "./dsh-runner";
import { launchTaskRun, type LaunchRunOptions } from "./run-lifecycle";
import {
  classifyTransientRunFailure,
  classifyTransientReviewerFailure,
  classifyUnadoptableSession,
  readRunProviderEvidence,
  FACTORY_RUN_RESUMED,
  FACTORY_REVIEW_RESUMED,
  FACTORY_WAITING_TRANSIENT,
  type TransientFailure,
} from "./transient-failure";
import {
  buildFreshSessionResumePrompt,
  buildSessionResumePrompt,
  checkResumeFence,
  defaultProviderProbe,
  resolveTransientPolicy,
  waitForProviderRecovery,
  type TransientPolicy,
} from "./transient-recovery";
import {
  classifyImplementFailure,
  implementStopReason,
  IMPLEMENT_RECOVERY,
  terminalImplementRunSignature,
  type ImplementRecoveryDecision,
} from "./implement-recovery";
import {
  DEFAULT_REVIEWER_WORKER,
  runHeadlessReview,
  type HeadlessReviewResult,
  type ReviewerSpawner,
  type ReviewerVerdict,
  type ReviewRubric,
  type ReviewVerifyEvidence,
} from "./reviewer-runner";
import { checkMergeGate, type MergeGateDecision, type MergeGateDeps } from "./merge-gate";
import { importHeadIntoSource, prepareReadOnlyReviewWorktree, removeReviewWorktree } from "./review-workspace";
import type { ChecksReadOnly, NativeReviewDeps } from "./providers";
import { bindTaskPr, type PrBindingDeps } from "./pr-binding";
import { resolveTaskPrTarget } from "./pr-target";
import { recordFactoryOutcome, type FactoryFailureReport } from "./factory-failure";
import {
  PROVIDER_RATE_LIMITED,
  logProviderRateLimitOnce,
  providerRateLimitBackoffMs,
  providerRateLimitedReason,
  type ProviderRateLimitState,
} from "./provider-rate-limit";

/**
 * ISH-762 Factory driver.
 *
 * Drives ONE code-change Task through the whole factory WITHOUT hand-driving a
 * TUI/pane for the coding:
 *
 *   implement   — a real headless dsh Run edits the Task worktree, commits, exits;
 *                 the ONLY advance is the structured `acceptRunSubmission`;
 *   verify      — Relay runs the task's REQUIRED checks in the recorded worktree,
 *                 bound to the recorded HEAD (a required NOT_RUN never PASSes);
 *   review      — an INDEPENDENT headless Claude reviewer returns a structured
 *                 verdict; FIX -> a FRESH dsh Run on the SAME worktree with the
 *                 findings; PASS -> integration;
 *   integration — a structured integration submission reaches `merge_ready` at the
 *                 SAME (reviewed) HEAD — never an unreviewed head;
 *   merge_ready — the read-only HEAD-bound merge gate is evaluated; NOTHING is
 *                 merged, pushed, accepted or written to a provider.
 *
 * Every step is a REUSE of the ordinary phase machine (`acceptRunSubmission`,
 * `runMechanicalVerification`, `recordReview`, `submitPhase`); this module is
 * only the sequencing. It is idempotent/resumable: it reads the LIVE phase each
 * iteration, adopts an already-live implement Run instead of starting a second
 * writer, and never advances on a process exit alone.
 */

export const FACTORY_ERROR = "FACTORY_ERROR";
export const NO_IMPLEMENTATION = "NO_IMPLEMENTATION";
export const CODING_FAILED = "CODING_FAILED";
export const SUBMIT_REFUSED = "RUN_SUBMISSION_REFUSED";
export const FACTORY_NO_CHECKS = "FACTORY_NO_CHECKS";
/**
 * ISH-1087: the Factory requires a GitHub PR verdict when it is driving a
 * PR-bound Task. Without it a local PASS could reach MergeReady and be merged
 * with no independent verdict on the PR at all.
 */
export const FACTORY_NATIVE_REVIEW_REQUIRED = "FACTORY_NATIVE_REVIEW_REQUIRED";

/** The integrator principal a Factory integration submission is made as. */
export const DEFAULT_INTEGRATOR_WORKER = "factory-integrator";

export interface FactoryDeps {
  /** The main checkout the Task worktree is created from. */
  repo?: string;
  /**
   * ISH-1087: the GitHub repo (`owner/name`) the Task's PR belongs to, when the
   * Task itself records neither `pr_repo` nor `pr_url`. Resolution otherwise
   * falls back to the Task workspace/source `origin`.
   */
  prRepo?: string | null;
  worktreesRoot?: string;
  /** Real dsh binary (default `$HOME/.dsh/bin/dsh-model` when executable, else `dsh`); a fake path in tests. */
  dshBin?: string;
  outputRoot?: string;
  permissionMode?: string;
  timeoutMs?: number;
  fastExitMs?: number;
  dshEnv?: Record<string, string>;
  /** Mechanical verify runner (default: the real command runner). */
  verifyRunner?: CommandRunner;
  /** The independent reviewer process (default: real `claude`); fake in tests. */
  reviewerSpawner?: ReviewerSpawner;
  reviewerCommand?: string;
  reviewerModel?: string;
  /**
   * ISH-1135: the repo-owned review rubric read at the reviewed HEAD. Unset ->
   * resolved per reviewed repository (`RELAY_REVIEW_RUBRICS` /
   * `RELAY_REVIEW_RUBRIC`) or the default ishiul skill layout.
   */
  reviewRubric?: ReviewRubric;
  reviewerWorker?: string;
  integratorWorker?: string;
  /** Head-pinned merge-gate providers (read-only; default none). */
  mergeGateDeps?: MergeGateDeps;
  /** Hard cap on coding attempts before giving up (default 4). */
  maxAttempts?: number;
  /** A coding Run that produced no new commit is a NO_IMPLEMENTATION (default true). */
  noChangeIsFailure?: boolean;
  /**
   * Terminate an adopted Run's detached process group, returning true once the
   * leader is gone (default `terminateProcessGroup`). Test seam for the
   * "cannot-be-killed -> keep fencing" path.
   */
  terminateOrphan?: (pid: number) => Promise<boolean>;
  /**
   * ISH-829: when set, the independent reviewer runs in a disposable DETACHED
   * worktree at the fixed head (created under this directory), not the writer's
   * live worktree. Unset -> existing behavior (the writer's worktree).
   */
  reviewWorktreeRoot?: string;
  /**
   * ISH-883: post a NATIVE GitHub PR review and read it back for HEAD-bound
   * acceptance. Undefined -> the reviewer keeps the local structured-verdict
   * path and Relay performs no external write (backward compatible).
   */
  nativeReview?: NativeReviewDeps;
  /**
   * ISH-1087: refuse to run the reviewer (and therefore to reach MergeReady)
   * unless a native GitHub review is configured. Defaults to `true` whenever a
   * `prBinding` is configured (a GitHub PR workflow without a GitHub verdict is
   * exactly the failure this closes); an explicit `false` keeps the old
   * local-only binding fixtures possible.
   */
  requireNativeReview?: boolean;
  /**
   * ISH-880/1087: bind the produced commit to a GitHub PR before the Task enters
   * the review stage. When set, EVERY code Task with a produced head is bound:
   * the repo is resolved from the Task's identity, the workspace/source `origin`
   * or `prRepo`, so a Task that records only a branch still binds. A missing,
   * moved, unreadable or fork PR BLOCKS and the reviewer never runs.
   */
  prBinding?: PrBindingDeps;
  /**
   * ISH-904: receive non-fatal worktree/base warnings (e.g. the resolved base is
   * behind `origin/main`). The Factory also adds them to `steps`; the CLI prints
   * them to stderr so a stale base is never silent.
   */
  onWarning?: (message: string) => void;
  /**
   * ISH-1174: transient provider/network recovery. A transient IMPLEMENT
   * failure is waited out (probe + backoff) and continued in the SAME dsh
   * Session/worktree; a transient REVIEW_PROCESS_FAILED is re-run at the same
   * head. Caps default to 3 resumes per attempt and a 60 min wait.
   */
  maxResumes?: number;
  transientWaitMs?: number;
  transientBackoffMs?: number;
  transientMaxBackoffMs?: number;
  /**
   * ISH-1174: provider reachability probe (default: HEAD the configured probe
   * URL). Returning true means "resume now"; false keeps the bounded wait.
   */
  probeProvider?: (ctx: {
    taskId: string;
    cause: string | null;
    phase: string;
    attempt: number;
    resumeCount: number;
  }) => Promise<boolean>;
  /**
   * ISH-1174 test seam: called immediately before the resume fence is checked,
   * so a test can simulate another writer moving the worktree HEAD/branch.
   */
  beforeResume?: (ctx: {
    taskId: string;
    fromRunId: string;
    attempt: number;
    resumeCount: number;
    mode: "session" | "fresh";
  }) => void | Promise<void>;
}

export interface FactoryAttempt {
  attempt: number;
  runId: string | null;
  baseHead: string | null;
  producedHead: string | null;
  verifyOutcome: string | null;
  reviewVerdict: string | null;
  phase: string | null;
  /**
   * ISH-1012: why this attempt was issued a fresh Run after an IMPLEMENT
   * failure (null when it was the first attempt / a VERIFY/REVIEW FIX).
   */
  retryReason?: string | null;
}

export type FactoryOutcome =
  | "merge_ready"
  | "blocked"
  | "coding_failed"
  | "no_implementation"
  | "review_refused"
  | "no_checks"
  | "max_attempts"
  | "provider_rate_limited"
  | "terminal";

export interface FactoryResult {
  taskId: string;
  outcome: FactoryOutcome;
  head: string | null;
  attempts: FactoryAttempt[];
  /** Read-only gate decision at `merge_ready` (never a merge). */
  gate: MergeGateDecision | null;
  /** The fail-closed reason for a non-ready terminal outcome. */
  reason: string | null;
  steps: string[];
  /**
   * ISH-1013: the minimal operator classification + evidence + next action for
   * a non-ready outcome. `null` at `merge_ready`.
   */
  failure: FactoryFailureReport | null;
}

/** A Factory result BEFORE the ISH-1013 operator projection is attached. */
type RawFactoryResult = Omit<FactoryResult, "failure">;

function latestRun(db: Database, taskId: string, phase: string, attempt: number): Run | null {
  return (
    (db
      .query(
        `SELECT * FROM runs WHERE task_id = ? AND phase = ? AND attempt = ?
           ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(taskId, phase, attempt) as Run | null) ?? null
  );
}

function isLive(run: Run | null): boolean {
  return !!run && (run.state === "running" || run.state === "starting");
}

/**
 * ISH-1132: the active provider rate-limit backoff across the Factory's readers.
 * `nativeReview.rateLimited` is set when env detection could not finish because
 * of the exhausted budget; the reader checks catch a limit hit later.
 */
function factoryProviderRateLimit(deps: FactoryDeps): ProviderRateLimitState | null {
  const state =
    deps.nativeReview?.rateLimited ??
    deps.nativeReview?.github?.rateLimit?.() ??
    deps.prBinding?.github?.rateLimit?.() ??
    deps.mergeGateDeps?.github?.rateLimit?.() ??
    deps.mergeGateDeps?.checks?.rateLimit?.() ??
    null;
  // A stale env-detection observation that has already passed its reset no
  // longer blocks: the reader will retry normally on the next call.
  return state && state.resetAt > Date.now() ? state : null;
}

/** A typed, retryable PROVIDER_RATE_LIMITED Factory stop (the Task is untouched). */
function providerRateLimitedResult(
  db: Database,
  taskId: string,
  head: string | null,
  attempts: FactoryAttempt[],
  steps: string[],
  state: ProviderRateLimitState,
  gate: MergeGateDecision | null = null
): RawFactoryResult {
  const reason = providerRateLimitedReason(state);
  steps.push(`provider-rate-limited:${state.provider}`);
  logProviderRateLimitOnce(db, state, { source: "factory", taskId });
  return { taskId, outcome: "provider_rate_limited", head, attempts, gate, reason, steps };
}

/**
 * ISH-1012: the latest TERMINAL IMPLEMENT Run for the Task's CURRENT attempt, or
 * null. Once an attempt's Run is terminal it is CLOSED: a restart/re-entry must
 * reuse its recorded outcome (or finish its clean submission) and must NEVER
 * launch a second Run for the same attempt.
 */
function terminalAttemptRun(db: Database, task: Task): Run | null {
  const run = latestRun(db, task.id, "implement", task.attempt);
  return run && !isLive(run) ? run : null;
}

/**
 * ISH-1012: reconstruct the Factory error a CLOSED attempt represents, from the
 * Run row alone. This is what makes re-entry idempotent: the same classification
 * (and therefore the same bounded-retry/stop decision) is reached without
 * launching anything, and the decision is based on the ORIGINAL Run evidence.
 */
function closedAttemptError(run: Run): string {
  if (run.state === "submitted") {
    return `${SUBMIT_REFUSED}: attempt ${run.attempt} is closed: run ${run.id} was already submitted but the Task is still bound to it`;
  }
  if (run.state === "exited" && run.exit_code === 0) {
    return `${NO_IMPLEMENTATION}: attempt ${run.attempt} is closed: run ${run.id} exited 0 but produced no new commit (head ${run.head_sha ?? "none"} unchanged)`;
  }
  return `${CODING_FAILED}: attempt ${run.attempt} is closed: run ${run.id} is '${run.state}' (exit ${run.exit_code ?? "none"})${run.error ? `: ${run.error}` : ""}`;
}

/**
 * ISH-1012: reuse a CLOSED attempt without a second writer. A clean exit-0 Run
 * that was never submitted (a crash between the process exit and the structured
 * submission) is finished through the ordinary `finishImplement` submission
 * fence; every other terminal outcome is surfaced as its recorded failure so the
 * bounded-recovery policy can decide (and re-entry cannot relaunch it).
 */
function finishTerminalAttempt(db: Database, run: Run, deps: FactoryDeps): ImplementResult {
  if (run.state === "exited" && run.exit_code === 0) {
    return finishImplement(db, run, deps);
  }
  return { run, producedHead: run.head_sha, error: closedAttemptError(run) };
}

/**
 * ISH-1012: signatures of the OTHER failed IMPLEMENT Runs of this Task, most
 * recent first. The same signature means the same failure at the same base HEAD
 * — no progress — so the policy stops instead of looping. Derived from the
 * durable Run rows, so the check survives a restart/replay.
 */
function priorImplementFailureSignatures(db: Database, taskId: string, currentRunId: string | null): string[] {
  const rows = db
    .query(
      `SELECT * FROM runs WHERE task_id = ? AND phase = 'implement'
        ORDER BY created_at DESC, rowid DESC`
    )
    .all(taskId) as Run[];
  const out: string[] = [];
  for (const r of rows) {
    if (r.id === currentRunId) continue;
    const signature = terminalImplementRunSignature(r);
    if (signature) out.push(signature);
  }
  return out;
}

/** ISH-1012: the durable, human-readable reason a recovery decision carries. */
function recoveryRefusalReason(decision: ImplementRecoveryDecision): string {
  return implementStopReason(decision);
}

/** Run states that are terminal (an adopted Run in one of these needs no wait). */
const RUN_TERMINAL_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "exited",
  "failed",
  "cancelled",
  "timeout",
  "submitted",
]);

/**
 * Task states the Factory may drive. Anything else — including `blocked_internal`
 * (which `blockTask` writes while LEAVING `phase` unchanged) — is terminal for the
 * Factory: a durable block must never be erased by carrying the task to
 * MergeReady. Whitelisting runnable states (rather than blacklisting) is the
 * fail-closed form, so a NEW state is non-runnable by default.
 */
const FACTORY_RUNNABLE_STATES: ReadonlySet<TaskState> = new Set<TaskState>(["queued", "running", "review"]);

/**
 * ISH-904: a plain `relay task add` task (`code_change=0`, `phase=NULL`) is not
 * factory-runnable. The old fallthrough said only `unhandled phase null`, which
 * told an operator nothing. This is the ONE actionable refusal, used by the
 * up-front guard (before any worktree is created) and by the unhandled-phase
 * branch for a task that somehow becomes non-code/phase-less mid-run.
 */
export function factoryNotCodeChangeReason(task: Pick<Task, "id" | "code_change" | "phase">): string | null {
  if (task.code_change !== 1) {
    return `${FACTORY_ERROR}: task ${task.id} is not a code-change task: re-intake with \`relay task intake --code-change\``;
  }
  if (task.phase === null) {
    return `${FACTORY_ERROR}: task ${task.id} has no workflow phase (not a code-change task): re-intake with \`relay task intake --code-change\``;
  }
  return null;
}

/** True when the process id is a live process (EPERM means alive-but-not-ours). */
export function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Default run budget when the caller gives none (mirrors `relay run` 30m). */
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
/** SIGTERM -> SIGKILL grace for a terminated orphan process group. */
export const ORPHAN_SIGKILL_GRACE_MS = 5000;

/**
 * Bound an adopted Run's wait: return the row, or `timedOut` once the ABSOLUTE
 * `deadlineMs` passes. The deadline is derived from the Run's own `started_at` +
 * its run budget, not from the moment of adoption, so a Run that already spent
 * its budget before the restart expires immediately instead of getting a second
 * full window.
 */
async function waitRunBounded(
  db: Database,
  runId: string,
  deadlineMs: number,
  pollMs = 250
): Promise<{ run: Run; timedOut: boolean }> {
  for (;;) {
    const r = getRun(db, runId);
    if (!r) throw new Error(`unknown run: ${runId}`);
    if (RUN_TERMINAL_STATES.has(r.state)) return { run: r, timedOut: false };
    if (Date.now() > deadlineMs) return { run: r, timedOut: true };
    await new Promise((res) => setTimeout(res, pollMs));
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((res) => setTimeout(res, ms));
}

/** Wait until `pid` is gone, up to `budgetMs`; returns true when it is gone. */
async function waitPidGone(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(50);
  }
  return !pidAlive(pid);
}

/**
 * Terminate an adopted Run's DETACHED process group. dsh is spawned detached
 * (`setsid`), so `pid` is the group leader: `kill(-pid, ...)` reaches the whole
 * tree, exactly like `RunHandle.cancel`. SIGTERM first, then SIGKILL after a
 * grace period. Returns true only once the leader is actually gone.
 *
 * GROUP ONLY: there is deliberately NO `kill(pid)` fallback. A plain `kill(pid)`
 * would fire exactly when `pid` is NOT a group leader — which proves it is NOT
 * the setsid'd dsh — so it can only ever hit an innocent, reused PID. Callers
 * MUST prove the identity first (see `identifyRunProcess`) and MUST NOT release
 * the single-writer fence while this returns false.
 */
export async function terminateProcessGroup(pid: number, graceMs = ORPHAN_SIGKILL_GRACE_MS): Promise<boolean> {
  if (!pidAlive(pid)) return true;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* not a group leader / already gone — never fall back to kill(pid) */
  }
  if (await waitPidGone(pid, graceMs)) return true;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* not a group leader / already gone */
  }
  return waitPidGone(pid, 2000);
}

/** How the factory classified an adopted Run's recorded PID. */
export type OrphanIdentity = "dead" | "match" | "reused" | "undeterminable";

/**
 * Prove whether the recorded PID still belongs to the Run's dsh, BEFORE any
 * signal. Two independent identity properties are required:
 *
 *   1. it is a process-GROUP leader (`pgid === pid`) — dsh is spawned `detached`;
 *   2. the process START TIME equals the token stored on the Run row at spawn.
 *
 * Returns:
 *   "dead"           — the PID is gone (safe: nothing to signal);
 *   "reused"         — a live PID that is NOT this Run's dsh (pgid/≠token): never
 *                      signal it; treat like dead (the original dsh is gone);
 *   "match"          — provably this Run's process group: safe to terminate;
 *   "undeterminable" — a live PID we cannot identify (missing token / ps): never
 *                      signal it; leave the Run `running` so the fence holds.
 */
export function identifyRunProcess(run: Pick<Run, "pid" | "spawn_lstart">): OrphanIdentity {
  const pid = run.pid;
  if (!pid || !pidAlive(pid)) return "dead";
  const pgid = processPgid(pid);
  const token = spawnIdentityToken(pid);
  if (pgid === null || token === null || !run.spawn_lstart) return "undeterminable";
  // A token written before canonicalization (no version tag) cannot be compared
  // reliably across environments: never misread it as "reused" — hold the fence.
  if (!isCanonicalToken(run.spawn_lstart)) return "undeterminable";
  // Not a group leader => not the setsid'd dsh: a reused PID (or a child of a
  // shell). Never signal it.
  if (pgid !== pid) return "reused";
  // A different canonical start time proves the PID was reused since launch.
  if (token !== run.spawn_lstart) return "reused";
  return "match";
}

/**
 * Mark a still-live Run terminal `failed`. Used ONLY once the orphan's process
 * group is confirmed dead (or was never alive): the coroutine that would have
 * written the terminal state is lost, so nothing else releases the single-writer
 * fence. Never advances the Task. Callers must NOT call this while the process
 * may still be writing — that would free the fence for a second writer.
 *
 * ISH-1008: shared with the daemon's periodic Run liveness sweep. Returns true
 * only when this call performed the transition, so the sweep can avoid
 * announcing a death another writer already recorded.
 */
export function markRunOrphan(db: Database, runId: string, reason: string, at = now()): boolean {
  const r = db
    .query(
      `UPDATE runs SET state = 'failed', error = ?, ended_at = ?, updated_at = ? WHERE id = ? AND state IN ('running', 'starting')`
    )
    .run(reason, at, at, runId);
  if (r.changes === 0) return false;
  logEvent(db, { source: "factory", type: "factory.run_orphaned", payload: { runId, reason } });
  return true;
}

/** The result of one IMPLEMENT step. */
interface ImplementResult {
  run: Run | null;
  producedHead: string | null;
  error: string | null;
}

/**
 * One implement step: adopt a live Run for this phase/attempt (never start a
 * second writer on restart), else launch ONE disposable Run in the Task
 * worktree; wait for it to reach a terminal state; refuse unless it is a clean
 * exit 0 that produced a NEW commit; then advance ONLY via the structured
 * submission.
 */
async function implementOnce(
  db: Database,
  task: Task,
  deps: FactoryDeps
): Promise<ImplementResult> {
  // ISH-1012: a TERMINAL Run for this attempt CLOSES the attempt. Reuse it (a
  // clean unsubmitted Run is finished through the normal submission fence) and
  // NEVER launch a second writer for the same attempt on restart/re-entry.
  const closed = terminalAttemptRun(db, task);
  if (closed) {
    logEvent(db, {
      source: "factory",
      taskId: task.id,
      type: "factory.attempt_closed",
      payload: { runId: closed.id, state: closed.state, attempt: closed.attempt },
    });
    return finishTerminalAttempt(db, closed, deps);
  }

  const existing = latestRun(db, task.id, "implement", task.attempt);
  let run: Run;
  if (isLive(existing)) {
    const live = existing!;
    logEvent(db, { source: "factory", taskId: task.id, type: "factory.run_adopted", payload: { runId: live.id, pid: live.pid } });
    // Restart/reconcile MUST NOT hang on an orphaned Run. A detached dsh Run's
    // terminal state is written by the coroutine that launched it; if that
    // process died, the row stays `running` forever. Check the PID is alive; if
    // not, the owner is gone and the row can safely be marked terminal `failed`.
    if (!pidAlive(live.pid)) {
      const reason = `orphaned run ${live.id}: owner pid ${live.pid ?? "none"} is not alive`;
      markRunOrphan(db, live.id, reason);
      const r = getRun(db, live.id)!;
      return { run: r, producedHead: r.head_sha, error: `${CODING_FAILED}: ${reason}` };
    }
    // The Run is still ALIVE (a factory crash left the detached dsh running with
    // no in-process killer). Bound the wait from the Run's OWN start + budget.
    const runTimeoutMs = deps.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const deadlineMs = (live.started_at || Date.now()) + runTimeoutMs;
    const { run: waited, timedOut } = await waitRunBounded(db, live.id, deadlineMs);
    if (timedOut) {
      const reason = `adopted run ${live.id} exceeded its ${runTimeoutMs}ms budget (expired)`;
      // IDENTITY BEFORE ANY SIGNAL. A stale `pid` may have been REUSED by an
      // unrelated host process (reboot / long crash). Prove the PID is still this
      // Run's dsh (group leader + matching spawn start time) before terminating;
      // never signal a process we cannot prove is ours.
      const identity = identifyRunProcess({ pid: live.pid, spawn_lstart: live.spawn_lstart });
      if (identity === "reused") {
        // A live PID that is NOT this Run's dsh: the original dsh is gone. Take the
        // dead-PID path — mark the Run terminal — and send NO signal to the stranger.
        logEvent(db, {
          source: "factory",
          taskId: task.id,
          type: "factory.orphan_pid_reused",
          payload: { runId: live.id, pid: live.pid, reason },
        });
        markRunOrphan(db, live.id, `${reason}; recorded pid ${live.pid ?? "none"} is an unrelated process (reused)`);
        const r = getRun(db, live.id)!;
        return {
          run: r,
          producedHead: r.head_sha,
          error: `${CODING_FAILED}: ${reason} (recorded pid was reused; no signal sent)`,
        };
      }
      if (identity === "undeterminable") {
        // A live PID we cannot prove belongs to this Run: do NOT signal. Leave the
        // Run `running` so the single-writer fence keeps holding.
        logEvent(db, {
          source: "factory",
          taskId: task.id,
          type: "factory.orphan_identity_undeterminable",
          payload: { runId: live.id, pid: live.pid, reason, spawnLstart: live.spawn_lstart },
        });
        const r = getRun(db, live.id)!;
        return {
          run: r,
          producedHead: r.head_sha,
          error: `${CODING_FAILED}: ${reason}; orphan identity could not be proven (Run left running to keep the single-writer fence)`,
        };
      }
      if (identity === "dead") {
        markRunOrphan(db, live.id, `${reason}; owner pid is no longer alive`);
        const r = getRun(db, live.id)!;
        return { run: r, producedHead: r.head_sha, error: `${CODING_FAILED}: ${reason}` };
      }
      // identity === "match": provably this Run's dsh process group. KILL BEFORE
      // RELEASE — never free the single-writer fence while the old writer may still
      // be writing the worktree. Only a confirmed-dead leader lets us go terminal.
      const terminate = deps.terminateOrphan ?? ((pid: number) => terminateProcessGroup(pid));
      const dead = await terminate(live.pid!);
      if (!dead) {
        // Could not prove the writer is gone: leave the Run `running` so
        // `findActiveWriter` (and thus `launchTaskRun`) keeps returning
        // DUPLICATE_WRITER for this worktree/branch. Fail closed, never advance.
        logEvent(db, {
          source: "factory",
          taskId: task.id,
          type: "factory.orphan_unterminated",
          payload: { runId: live.id, pid: live.pid, reason },
        });
        const r = getRun(db, live.id)!;
        return {
          run: r,
          producedHead: r.head_sha,
          error: `${CODING_FAILED}: ${reason}; orphan process group could not be terminated (Run left running to keep the single-writer fence)`,
        };
      }
      markRunOrphan(db, live.id, reason);
      const r = getRun(db, live.id)!;
      return { run: r, producedHead: r.head_sha, error: `${CODING_FAILED}: ${reason}` };
    }
    run = waited;
  } else {
    const opts: LaunchRunOptions = {
      repo: deps.repo,
      worktreesRoot: deps.worktreesRoot,
      outputRoot: deps.outputRoot,
      dshBin: deps.dshBin,
      permissionMode: deps.permissionMode,
      timeoutMs: deps.timeoutMs,
      fastExitMs: deps.fastExitMs,
      env: deps.dshEnv,
      onWarning: deps.onWarning,
    };
    const launched = await launchTaskRun(db, task.id, opts);
    run = await launched.handle.wait();
  }

  return finishImplement(db, run, deps);
}

/**
 * The shared tail of an IMPLEMENT step: a process exit is NOT a submission — the
 * Run must be a clean `exit 0` that produced a NEW commit, and the advance
 * happens ONLY through the structured submission (`acceptRunSubmission`).
 */
function finishImplement(db: Database, run: Run, deps: FactoryDeps): ImplementResult {
  if (run.state !== "exited" || run.exit_code !== 0) {
    return { run, producedHead: run.head_sha, error: `${CODING_FAILED}: run ${run.id} is '${run.state}' (exit ${run.exit_code ?? "none"})` };
  }
  if ((deps.noChangeIsFailure ?? true) && run.head_sha !== null && run.head_sha === run.base_head_sha) {
    return {
      run,
      producedHead: run.head_sha,
      error: `${NO_IMPLEMENTATION}: run ${run.id} exited 0 but produced no commit (head ${run.head_sha ?? "none"} unchanged)`,
    };
  }
  try {
    acceptRunSubmission(db, { runId: run.id });
  } catch (e) {
    // ISH-904: a failed RESULT WRITE is not a submission refusal. Rethrow it so
    // the Factory's outer catch parks the Task `blocked_internal` with the real
    // error instead of reporting a misleading SUBMIT_REFUSED/coding failure.
    if (isResultWriteError(e)) throw e;
    // A refused submission (stale/superseded run, moved head/phase) NEVER
    // advances the Task; surface a fail-closed outcome.
    return {
      run,
      producedHead: run.head_sha,
      error: `${SUBMIT_REFUSED}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return { run, producedHead: run.head_sha, error: null };
}

/**
 * ISH-830e: the DURABLE mechanical VERIFY evidence for a review — read from the
 * `VerificationResult` row (SQLite is the only source of truth), never from
 * process memory, so a Factory resumed directly into `review` still hands the
 * host reviewer the VERIFY result. Only a PASSING verify at the EXACT reviewed
 * head is used; anything else yields no VERIFY section (fail closed to the old
 * behaviour: the reviewer sees only the declared checks).
 */
export function durableVerifyEvidence(
  db: Database,
  taskId: string,
  attempt: number,
  reviewHead: string | null
): ReviewVerifyEvidence | null {
  const row = findTaskResult(db, taskId, "verify", attempt, "VerificationResult");
  if (!row || row.passed !== 1 || !reviewHead || row.head_sha !== reviewHead) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const checksRaw = Array.isArray(p.checks) ? p.checks : [];
  const checks = checksRaw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && !Array.isArray(c))
    .map((c) => ({
      name: String(c.name ?? ""),
      required: c.required !== false,
      outcome: String(c.outcome ?? ""),
      exitCode: typeof c.exitCode === "number" ? c.exitCode : null,
      ...(typeof c.output === "string" ? { output: c.output } : {}),
    }));
  return {
    head: row.head_sha,
    outcome: typeof p.outcome === "string" ? p.outcome : "",
    checks,
  };
}

/**
 * ISH-830e: a BLOCKED VERIFY must name the fence that failed. `verify not_run`
 * alone is opaque (it hid a dirty-tree fence failure in the ISH-830 harness); the
 * per-check outcome + a bounded output tail make the block diagnosable.
 */
export function verifyChecksReason(
  checks: { name: string; outcome: string; exitCode: number | null; output?: string }[]
): string {
  const parts = checks.map(
    (c) =>
      `${c.name}=${c.outcome}${c.exitCode === null ? "" : `(exit ${c.exitCode})`}: ${(c.output ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300)}`
  );
  return parts.join("; ") || "no checks executed";
}

/**
 * ISH-830e: a BLOCKED review must yield a PRECISE, non-empty reason. The reviewer
 * may legitimately answer `{"verdict":"blocked","summary":""}` (or omit the
 * summary) when it cannot judge — collapsing that to `""` loses the only signal
 * the caller (and the ISH-830 harness) has, and looks like an unexplained block.
 * Prefer the reviewer's summary, then its findings, then a deterministic
 * description naming the verdict and the durable evidence path.
 */
export function reviewBlockedReason(r: {
  verdict: ReviewerVerdict | null;
  evidenceRef: string | null;
}): string {
  const summary = r.verdict?.summary?.trim() ?? "";
  const findings = (r.verdict?.findings ?? []).map(
    (f) => `[${f.severity}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""}: ` : ""}${f.message}`
  );
  const parts = [summary, ...findings].filter(Boolean);
  if (parts.length > 0) return parts.join("\n");
  const detail = r.verdict
    ? `reviewer returned verdict '${r.verdict.verdict}' with no summary or findings`
    : "reviewer returned no structured verdict";
  return `review blocked: ${detail}${r.evidenceRef ? ` (evidence: ${r.evidenceRef})` : ""}`;
}

/* -------------------------------------------------------------------------- */
/* ISH-1174: transient provider/network recovery                               */
/* -------------------------------------------------------------------------- */

function transientPolicyFor(deps: FactoryDeps): TransientPolicy {
  return resolveTransientPolicy({
    maxResumes: deps.maxResumes,
    waitMs: deps.transientWaitMs,
    backoffMs: deps.transientBackoffMs,
    maxBackoffMs: deps.transientMaxBackoffMs,
  });
}

/**
 * ISH-1174: a permanent/local failure (auth, disk, permission) ends transient
 * recovery even when its text also looks like an unadoptable Session ("login
 * session expired"). Those causes are fail-closed today and a resume would only
 * repeat them.
 */
function permanentTransientVeto(veto: TransientFailure["veto"] | undefined): boolean {
  return veto === "auth" || veto === "enospc" || veto === "permission";
}

/** The highest transient resume ordinal already recorded for one attempt. */
function terminalResumeCount(db: Database, taskId: string, phase: string, attempt: number): number {
  const row = db
    .query(`SELECT MAX(resume_count) AS n FROM runs WHERE task_id = ? AND phase = ? AND attempt = ?`)
    .get(taskId, phase, attempt) as { n: number | null } | null;
  return typeof row?.n === "number" ? row.n : 0;
}

/** How many transient reviewer re-runs are already recorded at this head. */
function reviewResumeCount(db: Database, taskId: string, attempt: number, head: string | null): number {
  const rows = db
    .query(`SELECT payload_json FROM events WHERE task_id = ? AND type = ?`)
    .all(taskId, FACTORY_REVIEW_RESUMED) as { payload_json: string }[];
  let n = 0;
  for (const row of rows) {
    try {
      const p = JSON.parse(row.payload_json) as { attempt?: unknown; head?: unknown };
      if (p.attempt === attempt && p.head === head) n++;
    } catch {
      /* a malformed historical payload is not a resume */
    }
  }
  return n;
}

/**
 * The tail of a resumed IMPLEMENT Run. Normally this is `finishImplement`, but a
 * resume that exits 0 with nothing NEW to commit still has the interrupted
 * Run's commit: submitting that head through the ordinary fence is correct and
 * must not be reported as NO_IMPLEMENTATION.
 */
function finishResumeImplement(db: Database, run: Run, deps: FactoryDeps, priorProgress: boolean): ImplementResult {
  if (run.state !== "exited" || run.exit_code !== 0) {
    return { run, producedHead: run.head_sha, error: `${CODING_FAILED}: run ${run.id} is '${run.state}' (exit ${run.exit_code ?? "none"})` };
  }
  const unchanged = run.head_sha !== null && run.head_sha === run.base_head_sha;
  if (!unchanged || !priorProgress) return finishImplement(db, run, deps);
  try {
    acceptRunSubmission(db, { runId: run.id });
  } catch (e) {
    if (isResultWriteError(e)) throw e;
    return {
      run,
      producedHead: run.head_sha,
      error: `${SUBMIT_REFUSED}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return { run, producedHead: run.head_sha, error: null };
}

interface TransientImplementOutcome {
  /** The last Run this recovery attempted (possibly the original failure). */
  last: ImplementResult;
  /** True when a resumed Run was cleanly submitted (the attempt may advance). */
  submitted: boolean;
  /** True when at least one resume was launched. */
  resumed: boolean;
  /**
   * True when the Task moved/cancelled under the recovery: the caller must
   * re-read the live Task instead of classifying the old Run.
   */
  taskMoved: boolean;
  /** Why recovery stopped before a submission (cap/wait/fence), or null. */
  stop: string | null;
}

/**
 * ISH-1174: bounded transient recovery for a failed IMPLEMENT attempt.
 *
 * The resume is issued on the SAME Task/phase/attempt (it never consumes the
 * factory attempt budget), in the SAME worktree. A session resume passes
 * `--session-id <failed sessionId>`; when the Session cannot be adopted (or no
 * id was recorded) the fallback is a FRESH session whose brief carries the
 * previous final text, `git status` and a diff summary. Every launch is
 * preceded by the stale-head fence and the resume cap.
 */
async function resumeTransientImplement(
  db: Database,
  taskId: string,
  first: ImplementResult,
  deps: FactoryDeps,
  push: (step: string) => void
): Promise<TransientImplementOutcome> {
  const policy = transientPolicyFor(deps);
  let current = first;
  let resumed = false;
  let resumeCount = terminalResumeCount(db, taskId, "implement", first.run?.attempt ?? 0);
  let priorProgress =
    !!first.run && first.run.head_sha !== null && first.run.base_head_sha !== null && first.run.head_sha !== first.run.base_head_sha;
  // Carry the last non-empty final text across the resume chain: the IMMEDIATE
  // failed Run may be the failed session-adoption attempt, which printed none.
  let carryFinalText: string | null = readRunProviderEvidence(first.run?.dsh_events_path).finalText;
  let waitDeadline: number | null = null;

  for (;;) {
    const task = getTask(db, taskId);
    if (!task) return { last: current, submitted: false, resumed, taskMoved: true, stop: "task missing" };
    if (!FACTORY_RUNNABLE_STATES.has(task.state) || task.state === "cancelled") {
      return { last: current, submitted: false, resumed, taskMoved: true, stop: `task state ${task.state}` };
    }
    const run = current.run;
    if (!run || task.phase !== "implement" || task.attempt !== run.attempt) {
      return { last: current, submitted: false, resumed, taskMoved: true, stop: "task phase/attempt moved" };
    }

    const transient = classifyTransientRunFailure({ run, error: current.error });
    const adoption = classifyUnadoptableSession({ run, error: current.error });
    if (!transient.transient && !adoption.unadoptable) {
      return { last: current, submitted: false, resumed, taskMoved: false, stop: null };
    }
    // An explicit cancel/timeout is a human/limit decision, never an outage.
    if (
      transient.veto === "cancelled" ||
      transient.veto === "timeout" ||
      run.state === "cancelled" ||
      run.state === "timeout" ||
      run.signal === "cancelled" ||
      run.signal === "timeout"
    ) {
      return { last: current, submitted: false, resumed, taskMoved: false, stop: "explicit cancel/timeout" };
    }
    // ISH-1174 fail-closed: auth/ENOSPC/permission never resume — not even via
    // the fresh-session fallback. `classifyUnadoptableSession` already ignores
    // an original Run, but a SESSION-mode resume can fail with AUTH and a
    // "login session expired" message; that is a permanent local cause.
    if (permanentTransientVeto(transient.veto)) {
      push(`implement:resume-vetoed@${task.attempt} ${transient.veto} ${transient.detail ?? ""}`);
      return { last: current, submitted: false, resumed, taskMoved: false, stop: null };
    }
    if (resumeCount >= policy.maxResumes) {
      push(
        `implement:resume-cap@${task.attempt} (${resumeCount}/${policy.maxResumes}) ` +
          `${transient.detail ?? adoption.detail ?? "transient failure"}`
      );
      logEvent(db, {
        source: "factory",
        taskId,
        type: "factory.transient_resume_capped",
        payload: {
          attempt: task.attempt,
          runId: run.id,
          resumeCount,
          maxResumes: policy.maxResumes,
          cause: transient.detail ?? adoption.detail,
        },
      });
      return { last: current, submitted: false, resumed, taskMoved: false, stop: "resume cap" };
    }

    // The Session to adopt: what this Run PASSED (a failed adoption reports no
    // `session_id`), else what dsh reported for the original Run.
    const adoptSessionId = run.resume_session_id ?? run.session_id;
    const fresh = adoption.unadoptable || !adoptSessionId;
    const cause =
      (fresh
        ? adoption.detail ?? (adoptSessionId ? transient.detail : "the previous dsh Session id was not recorded; starting a fresh session")
        : transient.detail) ?? "transient provider/network interruption";
    const nextCount = resumeCount + 1;

    // A test seam to simulate another writer BEFORE the fence below.
    await deps.beforeResume?.({
      taskId,
      fromRunId: run.id,
      attempt: task.attempt,
      resumeCount: nextCount,
      mode: fresh ? "fresh" : "session",
    });

    // Wait for the provider/transport to come back. The TOTAL budget is shared
    // across every wait inside this attempt (never a fresh hour per resume).
    if (transient.transient) {
      const waitUntil: number = waitDeadline ?? Date.now() + policy.waitMs;
      waitDeadline = waitUntil;
      const remaining = Math.max(0, waitUntil - Date.now());
      if (remaining <= 0) {
        push(`implement:transient-wait-expired@${task.attempt} after ${policy.waitMs}ms`);
        logEvent(db, {
          source: "factory",
          taskId,
          type: "factory.transient_wait_expired",
          payload: { attempt: task.attempt, runId: run.id, capMs: policy.waitMs, cause },
        });
        return { last: current, submitted: false, resumed, taskMoved: false, stop: "wait cap" };
      }
      const waited = await waitForProviderRecovery({
        probe: () =>
          deps.probeProvider
            ? Promise.resolve(deps.probeProvider({ taskId, cause, phase: "implement", attempt: task.attempt, resumeCount: nextCount }))
            : defaultProviderProbe(policy.probeUrl, policy.probeTimeoutMs),
        onWait: (e) => {
          logEvent(db, {
            source: "factory",
            taskId,
            type: FACTORY_WAITING_TRANSIENT,
            payload: {
              phase: e.phase,
              attempt: e.attempt,
              runId: e.runId,
              cause: e.cause,
              probe: e.probe,
              delayMs: e.delayMs,
              elapsedMs: e.elapsedMs,
              capMs: e.capMs,
              resumeCount: e.resumeCount,
            },
          });
          push(
            `implement:waiting-transient@${task.attempt} probe=${e.probe} delay=${e.delayMs}ms ` +
              `elapsed=${e.elapsedMs}ms/${e.capMs}ms (${e.cause ?? "provider"})`
          );
        },
        capMs: remaining,
        backoffMs: policy.backoffMs,
        maxBackoffMs: policy.maxBackoffMs,
        context: {
          taskId,
          runId: run.id,
          phase: "implement",
          attempt: task.attempt,
          cause,
          resumeCount: nextCount,
        },
      });
      if (!waited.recovered) {
        push(`implement:transient-wait-expired@${task.attempt} after ${waited.elapsedMs}ms/${policy.waitMs}ms`);
        logEvent(db, {
          source: "factory",
          taskId,
          type: "factory.transient_wait_expired",
          payload: { attempt: task.attempt, runId: run.id, capMs: policy.waitMs, elapsedMs: waited.elapsedMs, cause },
        });
        return { last: current, submitted: false, resumed, taskMoved: false, stop: "wait cap" };
      }
    }

    // Re-read the Task AFTER the wait: a cancel/HOLD/attempt advance lands here.
    const live = getTask(db, taskId);
    if (
      !live ||
      !FACTORY_RUNNABLE_STATES.has(live.state) ||
      live.state === "cancelled" ||
      live.phase !== "implement" ||
      live.attempt !== task.attempt
    ) {
      return { last: current, submitted: false, resumed, taskMoved: true, stop: "task moved during wait" };
    }
    // SAFETY: never resume into a worktree/branch another writer moved.
    const fence = checkResumeFence(db, live, run);
    if (!fence.ok) {
      logEvent(db, {
        source: "factory",
        taskId,
        type: "factory.resume_refused",
        payload: { runId: run.id, attempt: task.attempt, cause, reason: fence.reason, resumeCount: nextCount },
      });
      push(`implement:resume-refused@${task.attempt} ${fence.reason}`);
      return { last: current, submitted: false, resumed, taskMoved: false, stop: fence.reason };
    }

    const prompt = fresh
      ? buildFreshSessionResumePrompt(live, run, cause, { cwd: run.cwd, finalText: carryFinalText })
      : buildSessionResumePrompt(live, run, cause);
    // A launch refusal (disk guard, pinned-version guard, DUPLICATE_WRITER) is
    // the same environment error it is for the first Run: surface it, never
    // swallow it as a transient resume.
    const launched: DshRunHandle = await startDshRun(db, {
      taskId,
      cwd: run.cwd,
      prompt,
      outputRoot: deps.outputRoot,
      dshBin: deps.dshBin,
      permissionMode: deps.permissionMode,
      timeoutMs: deps.timeoutMs,
      fastExitMs: deps.fastExitMs,
      env: deps.dshEnv,
      ...(fresh ? {} : { resumeSessionId: adoptSessionId }),
      resumedFromRunId: run.id,
      resumeCount: nextCount,
      resumeCause: cause,
    });
    resumed = true;
    resumeCount = nextCount;
    logEvent(db, {
      source: "factory",
      taskId,
      type: FACTORY_RUN_RESUMED,
      payload: {
        runId: launched.id,
        fromRunId: run.id,
        attempt: task.attempt,
        sessionId: fresh ? null : adoptSessionId,
        cause,
        resumeCount: nextCount,
        mode: fresh ? "fresh" : "session",
        cwd: run.cwd,
        head: run.head_sha ?? run.base_head_sha,
      },
    });
    push(
      `implement:resume@${task.attempt} #${nextCount} -> ${launched.id} ` +
        `(${fresh ? "fresh session" : `session ${adoptSessionId}`}) ${cause}`
    );

    const finished = await launched.wait();
    priorProgress =
      priorProgress ||
      (finished.head_sha !== null && finished.base_head_sha !== null && finished.head_sha !== finished.base_head_sha);
    const finishedFinal = readRunProviderEvidence(finished.dsh_events_path).finalText;
    if (finishedFinal) carryFinalText = finishedFinal;
    current = finishResumeImplement(db, finished, deps, priorProgress);
    if (!current.error) {
      return { last: current, submitted: true, resumed, taskMoved: false, stop: null };
    }
    // The resumed Run failed too: classify it on the next iteration. A non-
    // transient failure falls through to the ordinary ISH-1012 policy.
  }
}

/**
 * Run the whole factory for one Task. Returns a structured result; it NEVER
 * merges, accepts, pushes, or writes to a provider/Linear.
 */
async function runFactoryTaskInner(
  db: Database,
  taskId: string,
  deps: FactoryDeps = {}
): Promise<RawFactoryResult> {
  const maxAttempts = Math.max(1, deps.maxAttempts ?? 4);
  const reviewerWorker = deps.reviewerWorker ?? DEFAULT_REVIEWER_WORKER;
  const integratorWorker = deps.integratorWorker ?? DEFAULT_INTEGRATOR_WORKER;
  // ISH-1087: when a GitHub PR workflow is configured, the Task's repo may live
  // only in the Factory's source checkout. Resolve it there; a purely local
  // Factory keeps no fallback.
  const prSourceRepo = deps.repo ?? (deps.prBinding ? projectRoot() : null);
  // ISH-904: refuse a NON-code-change / phase-less Task UP FRONT — before any
  // worktree is created — with the one actionable instruction. The old path fell
  // through to `unhandled phase null` and only then created nothing useful.
  const initial = getTask(db, taskId);
  if (!initial) throw new Error(`unknown task: ${taskId}`);
  const notCodeChange = factoryNotCodeChangeReason(initial);
  if (notCodeChange) {
    return { taskId, outcome: "blocked", head: initial.head_sha, attempts: [], gate: null, reason: notCodeChange, steps: [] };
  }
  // ISH-1087: record the GitHub PR target at Factory intake, derived from the
  // Task's explicit identity or from the workspace/source `origin`. The live
  // ishiul intake records only a branch, so without this the later read-only
  // bind (and `relay merge-check`) could never see the PR the worker opens.
  // Only `pr_repo` is seeded: the actual base is recorded from the PR view at
  // bind time, so seeding a guessed base cannot invalidate the review.
  const intakeTarget = resolveTaskPrTarget(initial, { repo: deps.prRepo ?? prSourceRepo });
  if (intakeTarget && initial.pr_repo !== intakeTarget.repo) {
    const seeded = linkTask(db, taskId, { prRepo: intakeTarget.repo });
    if (seeded.pr_repo === intakeTarget.repo) {
      logEvent(db, {
        source: "factory",
        taskId,
        type: "factory.pr_target",
        payload: { repo: intakeTarget.repo, source: intakeTarget.source, from: initial.pr_repo, to: seeded.pr_repo },
      });
    }
  }
  // ISH-904: these principals are headless — register them `idle` (never
  // `starting`) so neither surface reports a permanent stuck attach.
  ensureHeadlessWorker(db, reviewerWorker, { role: REVIEWER_ROLE, agentKind: HEADLESS_AGENT_KIND });
  ensureHeadlessWorker(db, integratorWorker, { role: INTEGRATOR_ROLE, agentKind: HEADLESS_AGENT_KIND });

  const attempts: FactoryAttempt[] = [];
  const steps: string[] = [];
  const guardMax = maxAttempts * 6 + 12;
  let lastAttempt = -1;
  let current: FactoryAttempt | null = null;
  /** ISH-1012: why the NEXT attempt was issued (applied when it is created). */
  let pendingRetryReason: string | null = null;

  const push = (s: string) => {
    steps.push(s);
    logEvent(db, { source: "factory", taskId, type: "factory.step", payload: { step: s } });
  };
  // Base/worktree warnings are part of the Factory result (steps) and are also
  // forwarded to an operator callback (the CLI prints them).
  const runDeps: FactoryDeps = {
    ...deps,
    onWarning: (m: string) => {
      push(`warning: ${m}`);
      deps.onWarning?.(m);
    },
  };

  try {
  for (let guard = 0; guard < guardMax; guard++) {
    const task = getTask(db, taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    // Fail closed on ANY non-runnable state — `blocked_internal` included, since
    // `blockTask` leaves `phase` unchanged and `isTerminalTaskState` does not
    // cover the blocked states. A durable block is never overwritten.
    if (!FACTORY_RUNNABLE_STATES.has(task.state)) {
      return { taskId, outcome: "terminal", head: task.head_sha, attempts, gate: null, reason: `state ${task.state}`, steps };
    }
    if (task.attempt !== lastAttempt) {
      lastAttempt = task.attempt;
      current = {
        attempt: task.attempt,
        runId: null,
        baseHead: null,
        producedHead: null,
        verifyOutcome: null,
        reviewVerdict: null,
        phase: task.phase,
        retryReason: pendingRetryReason,
      };
      pendingRetryReason = null;
      attempts.push(current);
    }
    if (atAttemptCap(attempts, maxAttempts)) {
      return { taskId, outcome: "max_attempts", head: task.head_sha, attempts, gate: null, reason: `exceeded ${maxAttempts} attempts`, steps };
    }
    const phase = task.phase;
    switch (phase) {
      case "implement": {
        let impl = await implementOnce(db, task, runDeps);
        if (current) {
          current.runId = impl.run?.id ?? null;
          current.baseHead = impl.run?.base_head_sha ?? null;
          current.producedHead = impl.producedHead;
        }
        if (impl.error) {
          // ISH-1174: a TRANSIENT provider/network failure is waited out and
          // continued in the SAME Session/worktree BEFORE the attempt-consuming
          // ISH-1012 policy. A resume never advances the factory attempt; only
          // its cap/wait expiry falls back to the ordinary stop.
          const preTransient = classifyTransientRunFailure({ run: impl.run, error: impl.error });
          const preAdoption = classifyUnadoptableSession({ run: impl.run, error: impl.error });
          // A permanent/local veto never enters recovery, not even when the
          // message also names a dead Session (e.g. "login session expired").
          const preRecoverable =
            preTransient.transient || (preAdoption.unadoptable && !permanentTransientVeto(preTransient.veto));
          if (preRecoverable) {
            push(
              `implement:transient@${task.attempt} ${preTransient.transient ? preTransient.cause : "session_unadoptable"} ` +
                `${preTransient.detail ?? preAdoption.detail ?? ""}`
            );
            const recovered = await resumeTransientImplement(db, taskId, impl, runDeps, push);
            impl = recovered.last;
            if (current) {
              current.runId = impl.run?.id ?? null;
              current.baseHead = impl.run?.base_head_sha ?? null;
              current.producedHead = impl.producedHead;
            }
            if (recovered.submitted) {
              push(`implement:resumed-submitted@${task.attempt} run ${impl.run?.id ?? "none"} head ${impl.producedHead ?? "none"}`);
              continue;
            }
            if (recovered.taskMoved) {
              // A cancel/HOLD/attempt advance landed during recovery: re-read the
              // Task at the top of the loop instead of classifying the old Run.
              push(`implement:resume-task-moved@${task.attempt} ${recovered.stop ?? ""}`);
              continue;
            }
            if (recovered.stop?.startsWith("STALE_HEAD:")) {
              // The resume fence refused: another writer moved the worktree or
              // the Task head. Never resume; stop at the recorded reason (the
              // factory-failure projection classifies it as STALE_HEAD).
              logEvent(db, {
                source: "factory",
                taskId,
                type: "factory.stale_head_refused",
                payload: { attempt: task.attempt, runId: impl.run?.id ?? null, reason: recovered.stop },
              });
              return {
                taskId,
                outcome: "coding_failed",
                head: getTask(db, taskId)?.head_sha ?? null,
                attempts,
                gate: null,
                reason: recovered.stop,
                steps,
              };
            }
            // resume cap / wait cap: fall through to today's stop classification
            // (never a second attempt-consuming retry path).
          }
          // ISH-1012: bounded recovery. Reuse the EXISTING Run evidence and the
          // ordinary phase/attempt transition; never start a new FSM.
          const decision = classifyImplementFailure({
            run: impl.run,
            error: impl.error,
            priorSignatures: priorImplementFailureSignatures(db, taskId, impl.run?.id ?? null),
          });
          if (decision.retry) {
            // `maxAttempts` is the JOINT budget with VERIFY/REVIEW FIX. At the
            // cap the retry is not issued at all (no phantom attempt/Run).
            if (task.attempt + 1 >= maxAttempts) {
              const reason = `exceeded ${maxAttempts} attempts; retry not issued: ${decision.kind}: ${decision.reason} [${IMPLEMENT_RECOVERY}/ATTEMPT_CAP]`;
              logEvent(db, {
                source: "factory",
                taskId,
                type: "factory.implement_retry_refused",
                payload: { runId: impl.run?.id ?? null, stop: "ATTEMPT_CAP", reason, attempt: task.attempt },
              });
              push(`implement:retry-cap@${task.attempt} ${decision.reason}`);
              return { taskId, outcome: "max_attempts", head: getTask(db, taskId)!.head_sha, attempts, gate: null, reason, steps };
            }
            try {
              // The transition itself re-proves: terminal Run, released
              // single-writer fence, run belongs to THIS attempt, non-empty
              // reason + evidence. A replay/stale call is refused.
              recordImplementRecovery(db, taskId, {
                runId: impl.run!.id,
                signature: decision.signature!,
                reason: decision.reason,
                evidence: decision.evidence,
              });
            } catch (e) {
              const detail = e instanceof Error ? e.message : String(e);
              const reason = `${IMPLEMENT_RECOVERY}/RETRY_REFUSED: ${detail}`;
              logEvent(db, {
                source: "factory",
                taskId,
                type: "factory.implement_retry_refused",
                payload: { runId: impl.run?.id ?? null, stop: "RETRY_REFUSED", reason, attempt: task.attempt },
              });
              push(`implement:retry-refused@${task.attempt} ${detail}`);
              // A HOLD/block that landed between the decision and the transition
              // is terminal for this run: report it as such, never as a coding
              // failure that invites an automatic retry.
              const live = getTask(db, taskId)!;
              const outcome: FactoryOutcome = FACTORY_RUNNABLE_STATES.has(live.state) ? "coding_failed" : "terminal";
              return { taskId, outcome, head: live.head_sha, attempts, gate: null, reason, steps };
            }
            pendingRetryReason = decision.reason;
            push(`implement:${decision.kind}@${task.attempt} -> retry attempt ${task.attempt + 1} (${decision.reason})`);
            continue;
          }

          // NOT recoverable: stop (and, for environment/invalid causes, park the
          // Task BLOCKED). Re-entry re-reads the same closed attempt and reaches
          // the same decision without launching a second Run.
          const reason = recoveryRefusalReason(decision);
          logEvent(db, {
            source: "factory",
            taskId,
            type: "factory.implement_retry_refused",
            payload: {
              runId: impl.run?.id ?? null,
              stop: decision.stop,
              action: decision.action,
              reason,
              evidence: decision.evidence,
              attempt: task.attempt,
            },
          });
          push(`implement:no-retry@${task.attempt} (${decision.stop}) ${decision.reason}`);
          if (decision.action === "block") {
            const blocked = blockImplementFailure(db, taskId, reason, "factory");
            return { taskId, outcome: "blocked", head: blocked.head_sha, attempts, gate: null, reason, steps };
          }
          const errorText = impl.error ?? "";
          const outcome: FactoryOutcome = errorText.startsWith(NO_IMPLEMENTATION) ? "no_implementation" : "coding_failed";
          return { taskId, outcome, head: getTask(db, taskId)!.head_sha, attempts, gate: null, reason, steps };
        }
        push(`implement:run ${impl.run?.id ?? "none"} -> submitted (head ${impl.run?.head_sha ?? "none"})`);
        continue;
      }
      case "verify": {
        const checks = taskChecks(task);
        // Require at least one REQUIRED check, not merely a non-empty list: an
        // all-optional list lets `aggregateOutcome` turn an optional NOT_RUN/
        // INCONCLUSIVE into a PASS, which the spec forbids (an unrun check must
        // never become PASS).
        if (!checks.some((c) => c.required !== false)) {
          return {
            taskId,
            outcome: "no_checks",
            head: task.head_sha,
            attempts,
            gate: null,
            reason: `${FACTORY_NO_CHECKS}: the Factory requires at least one REQUIRED mechanical check`,
            steps,
          };
        }
        // Mechanical VERIFY runs in the Task's own worktree at its recorded HEAD.
        const cwd = task.worktree;
        if (!cwd) return { taskId, outcome: "blocked", head: task.head_sha, attempts, gate: null, reason: "no worktree", steps };
        const v = await runMechanicalVerification(db, taskId, {
          checks,
          runner: deps.verifyRunner ?? defaultRunner,
          cwd,
        });
        if (current) current.verifyOutcome = v.outcome;
        if (v.stale) {
          push(`verify:stale@${task.attempt} discarded`);
          continue;
        }
        if (v.outcome !== "pass") {
          // fail -> implement (new attempt) for a real breakage; NOT_RUN -> blocked.
          const live = getTask(db, taskId)!;
          if (live.state === "blocked_human") {
            return { taskId, outcome: "blocked", head: live.head_sha, attempts, gate: null, reason: `verify ${v.outcome}: ${verifyChecksReason(v.checks)}`, steps };
          }
          push(`verify:${v.outcome}@${task.attempt} -> new attempt`);
          continue;
        }
        push(`verify:pass@${task.attempt}`);
        continue;
      }
      case "review": {
        // ISH-880/1087: BEFORE the review stage, bind the produced commit to a
        // real GitHub PR and require the PR's CURRENT remote head to equal it.
        // This is the only place a produced commit becomes a PR; if the PR
        // cannot be read, is unreadable/moved/unauthorized, or does not exist
        // yet, the Factory BLOCKS and the reviewer never runs (never a fake
        // review_pass). The target repo is resolved from the live Task, so a
        // Task that records only a branch still binds the worker's PR.
        const reviewHead = task.head_sha;
        // ISH-1132: an exhausted GitHub budget is NOT "native review not
        // configured". Stop BEFORE the binding read (which would otherwise look
        // like PR_UNREADABLE) with a typed, retryable PROVIDER_RATE_LIMITED.
        const providerLimit = factoryProviderRateLimit(deps);
        if (providerLimit) {
          return providerRateLimitedResult(db, taskId, reviewHead, attempts, steps, providerLimit);
        }
        if (deps.prBinding && reviewHead) {
          const live = getTask(db, taskId)!;
          const target = resolveTaskPrTarget(live, { repo: deps.prRepo ?? prSourceRepo });
          const bind = await bindTaskPr(db, taskId, {
            ...deps.prBinding,
            expectedHead: reviewHead,
            repo: deps.prBinding.repo ?? target?.repo ?? null,
          });
          if (bind.status === "blocked") {
            push(`review:pr-binding-blocked ${bind.reason ?? ""}`);
            if (bind.code === "PROVIDER_RATE_LIMITED") {
              const limited =
                factoryProviderRateLimit(deps) ?? {
                  provider: "github",
                  reason: bind.reason ?? "GitHub API rate limit",
                  observedAt: Date.now(),
                  resetAt: Date.now() + providerRateLimitBackoffMs(),
                };
              return providerRateLimitedResult(db, taskId, reviewHead, attempts, steps, limited);
            }
            return {
              taskId,
              outcome: "blocked",
              head: getTask(db, taskId)!.head_sha,
              attempts,
              gate: null,
              reason: bind.reason ?? `${bind.identity}`,
              steps,
            };
          }
          push(`review:pr-${bind.status} ${bind.ref?.repo ?? "-"}#${bind.ref?.number ?? "-"}@${(bind.remoteHead ?? "none").slice(0, 10)}`);
        }
        // ISH-1087: when the Factory is configured to require a PR verdict, the
        // reviewer MUST be able to post+read back a native GitHub review. Blocking
        // here (before spending a review process) prevents a local-only PASS from
        // reaching MergeReady and being merged with no verdict on the PR. A
        // configured `prBinding` implies GitHub mode; only an explicit `false`
        // opts a binding-only fixture out.
        if ((deps.requireNativeReview ?? deps.prBinding !== undefined) && !deps.nativeReview) {
          const reason =
            `${FACTORY_NATIVE_REVIEW_REQUIRED}: native GitHub review is required but no read-only GitHub reader is configured; ` +
            `authenticate the gh CLI (the Factory's default) or set RELAY_PROVIDER_GITHUB=gh. RELAY_GITHUB_REVIEW_WRITE=0 disables native review by design, and the Factory then blocks here`;
          push(`review:native-review-required`);
          logEvent(db, { source: "factory", taskId, type: "factory.native_review_required", payload: { head: reviewHead, reason } });
          return { taskId, outcome: "blocked", head: reviewHead, attempts, gate: null, reason, steps };
        }
        // A rate-limited DETECTION may leave the expected author unresolved. If
        // the reset has passed, the reader is usable but the identity is still
        // unknown: never run a native review with an empty expected author.
        if ((deps.requireNativeReview ?? deps.prBinding !== undefined) && deps.nativeReview && !deps.nativeReview.author) {
          const reason =
            `${FACTORY_NATIVE_REVIEW_REQUIRED}: native GitHub review is required but the expected reviewer login could not be resolved; ` +
            `set RELAY_REVIEW_AUTHOR or re-run after the GitHub rate-limit reset`;
          push(`review:native-review-required`);
          logEvent(db, { source: "factory", taskId, type: "factory.native_review_required", payload: { head: reviewHead, reason } });
          return { taskId, outcome: "blocked", head: reviewHead, attempts, gate: null, reason, steps };
        }
        // ISH-829: the independent reviewer reads a DETACHED read-only checkout
        // at the fixed head (when configured), never the writer's live worktree.
        // ISH-1174: a transient REVIEW_PROCESS_FAILED is re-run here at the SAME
        // head (fresh disposable checkout, same Task/attempt) under the resume
        // cap; no operator re-run is needed for a short provider outage.
        const runOneReview = async (): Promise<
          { kind: "blocked"; reason: string } | { kind: "review"; r: HeadlessReviewResult }
        > => {
          let reviewWorktree: string | undefined;
          if (deps.reviewWorktreeRoot && reviewHead) {
            // ISH-904: the Task workspace is a self-contained clone whose `origin`
            // is the GitHub remote, so the Run's produced HEAD is not in this
            // source repo yet. Import it first (local path fetch, no network).
            const reviewSource = importHeadIntoSource(deps.repo ?? projectRoot(), task.worktree, reviewHead);
            const ws = prepareReadOnlyReviewWorktree(
              reviewSource,
              reviewHead,
              join(deps.reviewWorktreeRoot, `${taskId}-${task.attempt}-${reviewHead.slice(0, 10)}`)
            );
            if (!ws.ok) return { kind: "blocked", reason: `review workspace: ${ws.error}` };
            reviewWorktree = ws.path ?? undefined;
          }
          try {
            const r = await runHeadlessReview(db, taskId, {
              spawner: deps.reviewerSpawner,
              command: deps.reviewerCommand,
              model: deps.reviewerModel,
              reviewerWorker,
              reviewWorktree,
              ...(deps.reviewRubric ? { reviewRubric: deps.reviewRubric } : {}),
              nativeReview: deps.nativeReview,
              // ISH-830e: give the host reviewer the VERIFY evidence so it need
              // not re-run the required checks wholesale. Sourced from the
              // DURABLE VerificationResult row (not process memory), so a resumed
              // Factory still carries it.
              ...(() => {
                const evidence = durableVerifyEvidence(db, taskId, task.attempt, reviewHead);
                return evidence ? { verifyEvidence: evidence } : {};
              })(),
            });
            return { kind: "review", r };
          } finally {
            if (reviewWorktree) removeReviewWorktree(deps.repo ?? projectRoot(), reviewWorktree);
          }
        };

        const reviewPolicy = transientPolicyFor(deps);
        let reviewResumes = reviewResumeCount(db, taskId, task.attempt, reviewHead);
        let reviewWaitDeadline: number | null = null;
        let r: HeadlessReviewResult;
        for (;;) {
          const one = await runOneReview();
          if (one.kind === "blocked") {
            return { taskId, outcome: "blocked", head: reviewHead, attempts, gate: null, reason: one.reason, steps };
          }
          r = one.r;
          if (current) current.reviewVerdict = r.outcome === "refused" ? "refused" : r.outcome;
          if (r.outcome !== "refused") break;
          const transient = classifyTransientReviewerFailure({
            error: r.error,
            raw: r.raw,
            stderr: r.stderr,
            stdout: r.stdout,
          });
          if (!transient.transient) break;
          if (reviewResumes >= reviewPolicy.maxResumes) {
            push(`review:resume-cap@${task.attempt} (${reviewResumes}/${reviewPolicy.maxResumes}) ${transient.detail ?? ""}`);
            logEvent(db, {
              source: "factory",
              taskId,
              type: "factory.review_resume_capped",
              payload: { head: reviewHead, attempt: task.attempt, resumeCount: reviewResumes, maxResumes: reviewPolicy.maxResumes, cause: transient.detail },
            });
            break;
          }
          const nextCount = reviewResumes + 1;
          // The reviewer's total wait budget is shared across its re-runs too.
          const reviewWaitUntil: number = reviewWaitDeadline ?? Date.now() + reviewPolicy.waitMs;
          reviewWaitDeadline = reviewWaitUntil;
          const reviewWaitRemaining = Math.max(0, reviewWaitUntil - Date.now());
          if (reviewWaitRemaining <= 0) {
            push(`review:transient-wait-expired@${task.attempt} after ${reviewPolicy.waitMs}ms`);
            logEvent(db, {
              source: "factory",
              taskId,
              type: "factory.transient_wait_expired",
              payload: { phase: "review", head: reviewHead, attempt: task.attempt, capMs: reviewPolicy.waitMs, cause: transient.detail },
            });
            break;
          }
          const waited = await waitForProviderRecovery({
            probe: () =>
              deps.probeProvider
                ? Promise.resolve(deps.probeProvider({ taskId, cause: transient.detail, phase: "review", attempt: task.attempt, resumeCount: nextCount }))
                : defaultProviderProbe(reviewPolicy.probeUrl, reviewPolicy.probeTimeoutMs),
            onWait: (e) => {
              logEvent(db, {
                source: "factory",
                taskId,
                type: FACTORY_WAITING_TRANSIENT,
                payload: {
                  phase: e.phase,
                  attempt: e.attempt,
                  runId: e.runId,
                  cause: e.cause,
                  probe: e.probe,
                  delayMs: e.delayMs,
                  elapsedMs: e.elapsedMs,
                  capMs: e.capMs,
                  resumeCount: e.resumeCount,
                  head: reviewHead,
                },
              });
              push(
                `review:waiting-transient@${task.attempt} probe=${e.probe} delay=${e.delayMs}ms ` +
                  `elapsed=${e.elapsedMs}ms/${e.capMs}ms (${e.cause ?? "reviewer"})`
              );
            },
            capMs: reviewWaitRemaining,
            backoffMs: reviewPolicy.backoffMs,
            maxBackoffMs: reviewPolicy.maxBackoffMs,
            context: {
              taskId,
              runId: null,
              phase: "review",
              attempt: task.attempt,
              cause: transient.detail,
              resumeCount: nextCount,
            },
          });
          if (!waited.recovered) {
            push(`review:transient-wait-expired@${task.attempt} after ${waited.elapsedMs}ms/${reviewPolicy.waitMs}ms`);
            logEvent(db, {
              source: "factory",
              taskId,
              type: "factory.transient_wait_expired",
              payload: { phase: "review", head: reviewHead, attempt: task.attempt, capMs: reviewPolicy.waitMs, elapsedMs: waited.elapsedMs, cause: transient.detail },
            });
            break;
          }
          reviewResumes = nextCount;
          logEvent(db, {
            source: "factory",
            taskId,
            type: FACTORY_REVIEW_RESUMED,
            payload: {
              head: reviewHead,
              attempt: task.attempt,
              sessionId: null,
              cause: transient.detail,
              resumeCount: nextCount,
              error: r.error,
            },
          });
          push(`review:resume@${task.attempt} #${nextCount} at head ${reviewHead?.slice(0, 10) ?? "none"} ${transient.detail ?? ""}`);
        }
        if (r.outcome === "refused") {
          return { taskId, outcome: "review_refused", head: getTask(db, taskId)!.head_sha, attempts, gate: null, reason: r.error, steps };
        }
        if (r.outcome === "blocked") {
          const live = getTask(db, taskId)!;
          return { taskId, outcome: "blocked", head: live.head_sha, attempts, gate: null, reason: reviewBlockedReason(r), steps };
        }
        push(`review:${r.outcome}@${task.attempt}`);
        continue;
      }
      case "integration": {
        // A structured integration submission at the REVIEWED head -> merge_ready.
        const cur = getTask(db, taskId)!;
        if (cur.assignee !== integratorWorker) {
          try {
            // Claim THIS task (not "next"): a strict role match on the phase's
            // `integrator` claim role, atomic in claimTask.
            claimTask(db, taskId, integratorWorker);
          } catch (e) {
            return {
              taskId,
              outcome: "blocked",
              head: cur.head_sha,
              attempts,
              gate: null,
              reason: `could not claim integration of ${taskId}: ${e instanceof Error ? e.message : String(e)}`,
              steps,
            };
          }
        }
        const owned = getTask(db, taskId)!;
        submitPhase(db, taskId, integratorWorker, { headSha: owned.head_sha ?? undefined });
        push(`integration:submitted (head ${owned.head_sha ?? "none"})`);
        continue;
      }
      case "merge_ready": {
        // ISH-1087: a Factory caller that configured a PR binding but no explicit
        // merge-gate deps must still see the bound PR (otherwise the gate reports
        // NO_PR/PROVIDER_UNREADABLE for a Task whose PR exists). Both readers are
        // the same read-only `gh` adapter; checks are only used when it implements
        // the HEAD-pinned check reader.
        const live = getTask(db, taskId)!;
        const gateDeps: MergeGateDeps =
          deps.mergeGateDeps ??
          (() => {
            const github = deps.prBinding?.github;
            if (!github) return {};
            const checks =
              typeof (github as Partial<ChecksReadOnly>).listChecks === "function"
                ? (github as unknown as ChecksReadOnly)
                : undefined;
            const repo = resolveTaskPrTarget(live, { repo: deps.prRepo ?? prSourceRepo })?.repo ?? null;
            return { github, ...(checks ? { checks } : {}), repo };
          })();
        const gate = await checkMergeGate(db, taskId, gateDeps);
        push(`merge_ready:gate=${gate?.status ?? "unknown"}`);
        // ISH-1132: MergeReady must not be reported when the only thing blocking
        // the gate is an exhausted provider budget; that is retryable, typed, and
        // not an accepted/verified state.
        if (gate?.reasons.some((r) => r.code === "PROVIDER_RATE_LIMITED")) {
          const limited =
            factoryProviderRateLimit(deps) ?? {
              provider: "github",
              reason: "GitHub API rate limit",
              observedAt: Date.now(),
              resetAt: Date.now() + providerRateLimitBackoffMs(),
            };
          return providerRateLimitedResult(db, taskId, getTask(db, taskId)!.head_sha, attempts, steps, limited, gate);
        }
        return { taskId, outcome: "merge_ready", head: getTask(db, taskId)!.head_sha, attempts, gate, reason: null, steps };
      }
      default: {
        const reason = factoryNotCodeChangeReason(task) ?? `unhandled phase ${String(phase)}`;
        return { taskId, outcome: "blocked", head: task.head_sha, attempts, gate: null, reason, steps };
      }
    }
  }
  } catch (e) {
    // ISH-904: ONLY a failed result write leaves a half-applied phase behind (the
    // Task may already have been advanced by the caller's transaction). Park that
    // `blocked_internal` with the concrete error. A transient worktree/git/dsh
    // launch failure is NOT a durable park: rethrow it so the Task stays runnable
    // and does not need a human to unblock.
    if (!isResultWriteError(e)) throw e;
    const detail = e instanceof Error ? e.message : String(e);
    const reason = detail.startsWith(FACTORY_ERROR) ? detail : `${FACTORY_ERROR}: ${detail}`;
    markTaskBlockedInternal(db, taskId, reason);
    logEvent(db, { source: "factory", taskId, type: "factory.blocked_internal", payload: { reason } });
    return {
      taskId,
      outcome: "blocked",
      head: getTask(db, taskId)?.head_sha ?? null,
      attempts,
      gate: null,
      reason,
      steps,
    };
  }
  return { taskId, outcome: "max_attempts", head: getTask(db, taskId)!.head_sha, attempts, gate: null, reason: "guard exhausted", steps };
}

/**
 * ISH-1013: run the Factory and attach the durable operator projection. The
 * Factory's outcome/transition logic is unchanged; the report is derived from
 * the rows it just wrote (Run, task_results, events) and logged as ONE
 * `factory.outcome` event so a restart and `relay run show/logs` see the same
 * classification. This never unblocks, retries, or releases an old attempt/HEAD.
 */
export async function runFactoryTask(
  db: Database,
  taskId: string,
  deps: FactoryDeps = {}
): Promise<FactoryResult> {
  const result = await runFactoryTaskInner(db, taskId, deps);
  const failure = recordFactoryOutcome(db, result);
  return { ...result, failure };
}

function atAttemptCap(attempts: FactoryAttempt[], maxAttempts: number): boolean {
  const current = attempts[attempts.length - 1];
  return !!current && current.attempt >= maxAttempts;
}

/** Convenience: a Factory result is "reached MergeReady" (read-only, not merged). */
export function reachedMergeReady(r: FactoryResult): boolean {
  return r.outcome === "merge_ready";
}

export { getRun };
