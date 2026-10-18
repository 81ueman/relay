import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { defaultDbPath, now, projectRoot } from "./db";
import { logEvent } from "./events";
import { getTask, claimTask } from "./tasks";
import { getWorker, registerWorker } from "./workers";
import { INTEGRATOR_ROLE, REVIEWER_ROLE } from "./schema";
import type { Run, RunState, Task, TaskState } from "./schema";
import { isCanonicalToken, processPgid, spawnIdentityToken } from "./proc-identity";
import { defaultRunner, type CheckSpec, type CommandRunner } from "./verify";
import { defaultVerifyTarget, type VerifyTarget } from "./sandbox-verify";
import { runMechanicalVerification, submitPhase, taskChecks } from "./workflow";
import { acceptRunSubmission, getRun, type DshSpawner } from "./dsh-runner";
import { launchTaskRun, type LaunchRunOptions } from "./run-lifecycle";
import { getSandbox, SANDBOX_ERROR, type SbxCli } from "./sandbox";
import {
  acceptSandboxSubmission,
  hostSandboxClientAlive,
  launchTaskSandboxRun,
  sweepOrphanedSandboxRuns,
  type LaunchSandboxOptions,
  type LaunchedSandboxRun,
} from "./sandbox-lifecycle";
import {
  DEFAULT_REVIEWER_WORKER,
  runHeadlessReview,
  type ReviewerSpawner,
  type ReviewerVerdict,
  type ReviewVerifyEvidence,
} from "./reviewer-runner";
import { checkMergeGate, type MergeGateDecision, type MergeGateDeps } from "./merge-gate";
import { prepareReadOnlyReviewWorktree, removeReviewWorktree } from "./review-workspace";
import type { NativeReviewDeps } from "./providers";
import { bindTaskPr, type PrBindingDeps } from "./pr-binding";

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

/** The integrator principal a Factory integration submission is made as. */
export const DEFAULT_INTEGRATOR_WORKER = "factory-integrator";

export interface FactoryDeps {
  /** The main checkout the Task worktree is created from. */
  repo?: string;
  worktreesRoot?: string;
  /** Real dsh binary (default `dsh`); a fake path in tests. */
  dshBin?: string;
  outputRoot?: string;
  permissionMode?: string;
  timeoutMs?: number;
  fastExitMs?: number;
  dshEnv?: Record<string, string>;
  /** Mechanical verify runner (default: the real command runner). */
  verifyRunner?: CommandRunner;
  /**
   * ISH-829: choose the VERIFY target for a Task (Coding Sandbox vs host). Null
   * falls back to `verifyRunner` in the Task worktree.
   */
  verifyTarget?: (db: Database, task: Task, checks: CheckSpec[]) => VerifyTarget | null;
  /** The independent reviewer process (default: real `claude`); fake in tests. */
  reviewerSpawner?: ReviewerSpawner;
  reviewerCommand?: string;
  reviewerModel?: string;
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
   * ISH-829: when set, the independent reviewer runs in a DETACHED read-only
   * worktree at the fixed head (created under this directory), not the writer's
   * live worktree. Unset -> existing behavior (the writer's worktree).
   */
  reviewWorktreeRoot?: string;
  /**
   * ISH-878: the `sbx` CLI used by the Sandbox-backed IMPLEMENT/FIX path
   * (default: the real `sbx`). Production always reuses ISH-828's
   * `launchTaskSandboxRun`; this is a test/operator seam.
   */
  sandboxCli?: SbxCli;
  /** ISH-878: test seam for the `sbx exec … dsh` process of a Sandbox Run. */
  sandboxSpawner?: DshSpawner;
  /**
   * ISH-883: post a NATIVE GitHub PR review and read it back for HEAD-bound
   * acceptance. Undefined -> the reviewer keeps the local structured-verdict
   * path and Relay performs no external write (backward compatible).
   */
  nativeReview?: NativeReviewDeps;
  /**
   * ISH-880: bind the produced commit to a GitHub PR before the Task enters the
   * review stage. Opt-in — unset keeps the read-only behaviour. When set, a Task
   * with a recorded `pr_repo`/`pr_url` must have its PR's live remote head equal
   * the produced commit before the reviewer runs; otherwise the Factory BLOCKS.
   */
  prBinding?: PrBindingDeps;
}

export interface FactoryAttempt {
  attempt: number;
  runId: string | null;
  baseHead: string | null;
  producedHead: string | null;
  verifyOutcome: string | null;
  reviewVerdict: string | null;
  phase: string | null;
}

export type FactoryOutcome =
  | "merge_ready"
  | "blocked"
  | "coding_failed"
  | "no_implementation"
  | "review_refused"
  | "no_checks"
  | "max_attempts"
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
}

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
 */
function markRunOrphan(db: Database, runId: string, reason: string): void {
  const t = now();
  db.query(
    `UPDATE runs SET state = 'failed', error = ?, ended_at = ?, updated_at = ? WHERE id = ? AND state IN ('running', 'starting')`
  ).run(reason, t, t, runId);
  logEvent(db, { source: "factory", type: "factory.run_orphaned", payload: { runId, reason } });
}

/**
 * The result of one IMPLEMENT step. `run` is null when the Task could not even
 * be bound to an execution target (a removed/failed Coding Sandbox): the Factory
 * fails closed WITHOUT launching anything (never a host fallback).
 */
interface ImplementResult {
  run: Run | null;
  producedHead: string | null;
  error: string | null;
}

/**
 * ISH-878: how the Factory EXECUTES an IMPLEMENT/FIX attempt for a Task.
 *   - "sandbox" — the Task has a durable Coding Sandbox binding: run INSIDE it
 *     via ISH-828's `launchTaskSandboxRun`;
 *   - "host"    — no sandbox row at all (a genuinely legacy/unmigrated Task):
 *     keep ISH-760's host-worktree behaviour;
 *   - "refused" — a sandbox row exists but is unusable (removed/failed): FAIL
 *     CLOSED. There is deliberately NO implicit Sandbox -> host fallback, which
 *     is exactly the execution gap ISH-878 closes.
 */
export type ImplementTarget = { kind: "sandbox" } | { kind: "host" } | { kind: "refused"; reason: string };

export function implementTarget(db: Database, task: Task): ImplementTarget {
  const sandbox = getSandbox(db, task.id);
  if (!sandbox) return { kind: "host" };
  if (sandbox.state === "removed") {
    return {
      kind: "refused",
      reason: `${SANDBOX_ERROR}: task ${task.id} Coding Sandbox ${sandbox.name} was removed; refusing to fall back to the host worktree`,
    };
  }
  if (sandbox.state === "failed") {
    return {
      kind: "refused",
      reason: `${SANDBOX_ERROR}: task ${task.id} Coding Sandbox ${sandbox.name} is failed; refusing to fall back to the host worktree`,
    };
  }
  return { kind: "sandbox" };
}

/**
 * One implement step: dispatch on the Task's durable execution binding, adopt a
 * live Run for this phase/attempt (never start a second writer on restart), else
 * launch ONE disposable Run (inside the Coding Sandbox, or the host worktree for
 * a legacy Task); wait for it to reach a terminal state; refuse unless it is a
 * clean exit 0 that produced a NEW commit; then advance ONLY via the structured
 * submission.
 */
async function implementOnce(
  db: Database,
  task: Task,
  deps: FactoryDeps
): Promise<ImplementResult> {
  const target = implementTarget(db, task);
  if (target.kind === "refused") {
    logEvent(db, { source: "factory", taskId: task.id, type: "factory.sandbox_unusable", payload: { reason: target.reason } });
    return { run: null, producedHead: null, error: `${CODING_FAILED}: ${target.reason}` };
  }
  if (target.kind === "sandbox") {
    return await implementInSandbox(db, task, deps);
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
    };
    const launched = await launchTaskRun(db, task.id, opts);
    run = await launched.handle.wait();
  }

  return finishImplement(db, run, deps);
}

/**
 * The shared tail of an IMPLEMENT step: a process exit is NOT a submission — the
 * Run must be a clean `exit 0` that produced a NEW commit, and the advance
 * happens ONLY through the structured submission. A Sandbox Run submits through
 * `acceptSandboxSubmission` (the ISH-760 fence plus the Sandbox identity/HEAD
 * fence); a host Run through `acceptRunSubmission`.
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
    if (run.sandbox_name) acceptSandboxSubmission(db, { runId: run.id });
    else acceptRunSubmission(db, { runId: run.id });
  } catch (e) {
    // A refused submission (stale/superseded run, moved head/phase, sandbox
    // mismatch) NEVER advances the Task; surface a fail-closed outcome.
    return {
      run,
      producedHead: run.head_sha,
      error: `${SUBMIT_REFUSED}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return { run, producedHead: run.head_sha, error: null };
}

/** ISH-878: the ISH-828 launch options for a Sandbox-backed IMPLEMENT/FIX run. */
function sandboxRunOptions(deps: FactoryDeps): LaunchSandboxOptions {
  return {
    // `sbx create --clone` must run from the MAIN checkout (never a linked worktree).
    source: deps.repo,
    outputRoot: deps.outputRoot,
    permissionMode: deps.permissionMode,
    timeoutMs: deps.timeoutMs,
    fastExitMs: deps.fastExitMs,
    env: deps.dshEnv,
    cli: deps.sandboxCli,
    spawner: deps.sandboxSpawner,
    // The host `dshBin` is deliberately NOT forwarded: inside the Sandbox the
    // pinned `dsh` (ISH-869) is probed/installed by the lifecycle itself.
  };
}

/**
 * ISH-878: adopt a still-live Sandbox IMPLEMENT Run after a restart/re-entry —
 * never start a second writer into the same clone.
 *
 * The recorded pid is the host `sbx exec` CLIENT; the in-VM dsh can outlive it.
 * Identity/signalling therefore reuses ISH-828's sweep: the Run is marked
 * terminal `failed` ONLY once the in-VM dsh is CONFIRMED gone, so the
 * single-writer fence is never released while a writer may still commit.
 */
async function adoptLiveSandboxRun(db: Database, live: Run, deps: FactoryDeps): Promise<ImplementResult> {
  logEvent(db, {
    source: "factory",
    taskId: live.task_id,
    type: "factory.run_adopted",
    payload: { runId: live.id, pid: live.pid, sandbox: live.sandbox_name },
  });
  if (!hostSandboxClientAlive(live)) {
    // Scope the sweep to THIS adopted Run: a concurrent Task's just-inserted
    // `starting` Run (pid still NULL) must never be swept from here.
    sweepOrphanedSandboxRuns(db, { apply: true, cli: deps.sandboxCli, runId: live.id });
    const r = getRun(db, live.id)!;
    if (RUN_TERMINAL_STATES.has(r.state)) {
      return {
        run: r,
        producedHead: r.head_sha,
        error: `${CODING_FAILED}: orphaned sandbox run ${live.id}: ${r.error ?? "no live sbx exec client"}`,
      };
    }
    return {
      run: r,
      producedHead: r.head_sha,
      error: `${CODING_FAILED}: sandbox run ${live.id} still holds the single-writer fence (in-VM dsh not confirmed gone)`,
    };
  }
  // The client is alive: bound the wait from the Run's OWN start + budget.
  const runTimeoutMs = deps.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const deadlineMs = (live.started_at || Date.now()) + runTimeoutMs;
  const { run: waited, timedOut } = await waitRunBounded(db, live.id, deadlineMs);
  if (timedOut) {
    return {
      run: waited,
      producedHead: waited.head_sha,
      error: `${CODING_FAILED}: adopted sandbox run ${live.id} exceeded its ${runTimeoutMs}ms budget (fence held for the ISH-828 sweep)`,
    };
  }
  return { run: waited, producedHead: waited.head_sha, error: null };
}

/**
 * ISH-878: the Sandbox-backed IMPLEMENT/FIX path. Adopts the Task's live Sandbox
 * Run (no duplicate writer), else launches ONE disposable `dsh` INSIDE the SAME
 * durable Task Sandbox. A FIX is simply another call here: the sandbox mapping
 * is reused (new Run, inherited findings) — never a second Factory.
 */
async function implementInSandbox(db: Database, task: Task, deps: FactoryDeps): Promise<ImplementResult> {
  const existing = latestRun(db, task.id, "implement", task.attempt);
  if (existing && isLive(existing) && existing.sandbox_name) {
    const adopted = await adoptLiveSandboxRun(db, existing, deps);
    if (adopted.error) return adopted;
    return finishImplement(db, adopted.run!, deps);
  }
  let launched: LaunchedSandboxRun;
  try {
    launched = await launchTaskSandboxRun(db, task.id, sandboxRunOptions(deps));
  } catch (e) {
    // A Sandbox that cannot be created/probed is fail-closed: never a host fallback.
    return { run: null, producedHead: null, error: `${CODING_FAILED}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const run = await launched.handle.wait();
  return finishImplement(db, run, deps);
}

/**
 * ISH-878: the DURABLE directory a Sandbox-backed Task's raw reviewer evidence is
 * written under. It mirrors the Run evidence root (`<control-plane>/runs`), so
 * the lifecycle's `outputRoot` and this agree — and a `task_results.evidence_ref`
 * never points into the temporary read-only review worktree.
 */
function reviewEvidenceBase(deps: FactoryDeps, taskId: string): string {
  return join(deps.outputRoot ?? join(dirname(defaultDbPath()), "runs"), taskId, "review");
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
}): string {  const summary = r.verdict?.summary?.trim() ?? "";
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

/**
 * Run the whole factory for one Task. Returns a structured result; it NEVER
 * merges, accepts, pushes, or writes to a provider/Linear.
 */
export async function runFactoryTask(
  db: Database,
  taskId: string,
  deps: FactoryDeps = {}
): Promise<FactoryResult> {
  const maxAttempts = Math.max(1, deps.maxAttempts ?? 4);
  const reviewerWorker = deps.reviewerWorker ?? DEFAULT_REVIEWER_WORKER;
  const integratorWorker = deps.integratorWorker ?? DEFAULT_INTEGRATOR_WORKER;
  // ISH-829: default to the durable-Coding-Sandbox VERIFY target. It returns null
  // for a Task with no sandbox row, so a worktree Task is unchanged; a
  // sandbox-backed Task can never silently fall back to host `bash -lc`.
  const resolveVerifyTarget = deps.verifyTarget ?? defaultVerifyTarget;
  if (!getWorker(db, reviewerWorker)) registerWorker(db, reviewerWorker, { role: REVIEWER_ROLE, agentKind: "claude" });
  if (!getWorker(db, integratorWorker)) registerWorker(db, integratorWorker, { role: INTEGRATOR_ROLE, agentKind: "relay" });

  const attempts: FactoryAttempt[] = [];
  const steps: string[] = [];
  const guardMax = maxAttempts * 6 + 12;
  let lastAttempt = -1;
  let current: FactoryAttempt | null = null;
  // ISH-830e: the mechanical VERIFY result for the CURRENT attempt, captured at
  // the (sandbox) verify step and handed to the host reviewer as context.
  let lastVerify: (ReviewVerifyEvidence & { attempt: number }) | null = null;

  const push = (s: string) => {
    steps.push(s);
    logEvent(db, { source: "factory", taskId, type: "factory.step", payload: { step: s } });
  };

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
      current = { attempt: task.attempt, runId: null, baseHead: null, producedHead: null, verifyOutcome: null, reviewVerdict: null, phase: task.phase };
      attempts.push(current);
    }
    if (atAttemptCap(attempts, maxAttempts)) {
      return { taskId, outcome: "max_attempts", head: task.head_sha, attempts, gate: null, reason: `exceeded ${maxAttempts} attempts`, steps };
    }
    const phase = task.phase;
    switch (phase) {
      case "implement": {
        const impl = await implementOnce(db, task, deps);
        if (current) {
          current.runId = impl.run?.id ?? null;
          current.baseHead = impl.run?.base_head_sha ?? null;
          current.producedHead = impl.producedHead;
        }
        if (impl.error) {
          const outcome: FactoryOutcome = impl.error.startsWith(NO_IMPLEMENTATION) ? "no_implementation" : "coding_failed";
          return { taskId, outcome, head: getTask(db, taskId)!.head_sha, attempts, gate: null, reason: impl.error, steps };
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
        // ISH-829/ISH-878: verify INSIDE the Task's Coding Sandbox when it has
        // one. A Sandbox-backed Task has NO host worktree, so the target's in-VM
        // clone path is the working directory; a legacy Task still requires its
        // recorded worktree.
        const target = resolveVerifyTarget(db, task, checks) ?? null;
        const cwd = target?.cwd ?? task.worktree;
        if (!cwd) return { taskId, outcome: "blocked", head: task.head_sha, attempts, gate: null, reason: "no worktree", steps };
        const v = await runMechanicalVerification(db, taskId, {
          checks,
          runner: target?.runner ?? deps.verifyRunner ?? defaultRunner,
          cwd,
          headSha: target?.headSha,
          headProbe: target?.headProbe,
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
        // ISH-830e: capture the sandbox VERIFY result (with the raw check output)
        // for the review brief — the host reviewer never sees the sandbox.
        lastVerify = {
          attempt: task.attempt,
          head: getTask(db, taskId)!.head_sha,
          outcome: v.outcome,
          checks: v.checks.map((c) => ({
            name: c.name,
            required: c.required,
            outcome: c.outcome,
            exitCode: c.exitCode,
            output: c.output,
          })),
        };
        continue;
      }
      case "review": {
        // ISH-880: BEFORE the review stage, bind the produced commit to a real
        // GitHub PR and require the PR's CURRENT remote head to equal it. This is
        // the only place a Sandbox-produced commit becomes a PR; if the PR cannot
        // be read, is unreadable/moved/unauthorized, the Factory BLOCKS and the
        // reviewer never runs (never a fake review_pass).
        const reviewHead = task.head_sha;
        if (deps.prBinding && reviewHead && (task.pr_repo || task.pr_url)) {
          const bind = bindTaskPr(db, taskId, { ...deps.prBinding, expectedHead: reviewHead });
          if (bind.status === "blocked") {
            push(`review:pr-binding-blocked ${bind.reason ?? ""}`);
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
        // ISH-829: the independent reviewer reads a DETACHED read-only checkout
        // at the fixed head (when configured), never the writer's live worktree.
        let reviewWorktree: string | undefined;
        if (deps.reviewWorktreeRoot && reviewHead) {
          const ws = prepareReadOnlyReviewWorktree(
            deps.repo ?? projectRoot(),
            reviewHead,
            join(deps.reviewWorktreeRoot, `${taskId}-${task.attempt}-${reviewHead.slice(0, 10)}`)
          );
          if (!ws.ok) {
            return { taskId, outcome: "blocked", head: reviewHead, attempts, gate: null, reason: `review workspace: ${ws.error}`, steps };
          }
          reviewWorktree = ws.path ?? undefined;
        }
        let r;
        try {
          r = await runHeadlessReview(db, taskId, {
            spawner: deps.reviewerSpawner,
            command: deps.reviewerCommand,
            model: deps.reviewerModel,
            reviewerWorker,
            reviewWorktree,
            // ISH-878: a Sandbox-backed Task has no host worktree, so pin the raw
            // reviewer evidence to a DURABLE per-Task directory (the read-only
            // review worktree is removed below — a recorded evidence_ref must not
            // dangle).
            evidenceBase: task.worktree ? undefined : reviewEvidenceBase(deps, taskId),
            nativeReview: deps.nativeReview,
            // ISH-830e: give the host reviewer the sandbox VERIFY evidence so it
            // can judge the code without re-running the lab.
            ...(lastVerify && lastVerify.attempt === task.attempt ? { verifyEvidence: lastVerify } : {}),
          });
        } finally {
          if (reviewWorktree) removeReviewWorktree(deps.repo ?? projectRoot(), reviewWorktree);
        }
        if (current) current.reviewVerdict = r.outcome === "refused" ? "refused" : r.outcome;
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
        const gate = checkMergeGate(db, taskId, deps.mergeGateDeps ?? {});
        push(`merge_ready:gate=${gate?.status ?? "unknown"}`);
        return { taskId, outcome: "merge_ready", head: getTask(db, taskId)!.head_sha, attempts, gate, reason: null, steps };
      }
      default: {
        return { taskId, outcome: "blocked", head: task.head_sha, attempts, gate: null, reason: `unhandled phase ${String(phase)}`, steps };
      }
    }
  }
  return { taskId, outcome: "max_attempts", head: getTask(db, taskId)!.head_sha, attempts, gate: null, reason: "guard exhausted", steps };
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
