import type { Database } from "bun:sqlite";
import { logEvent } from "./events";
import { getTask, claimTask } from "./tasks";
import { getWorker, registerWorker } from "./workers";
import { INTEGRATOR_ROLE, REVIEWER_ROLE } from "./schema";
import type { Task } from "./schema";
import { defaultRunner, type CommandRunner } from "./verify";
import { runMechanicalVerification, submitPhase, taskChecks } from "./workflow";
import { acceptRunSubmission, getRun, waitDshRun } from "./dsh-runner";
import type { Run } from "./schema";
import { launchTaskRun, type LaunchRunOptions } from "./run-lifecycle";
import {
  DEFAULT_REVIEWER_WORKER,
  runHeadlessReview,
  type ReviewerSpawner,
} from "./reviewer-runner";
import { checkMergeGate, type MergeGateDecision, type MergeGateDeps } from "./merge-gate";

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

/**
 * One implement step: adopt a live Run for this phase/attempt (never start a
 * second writer on restart), else launch ONE disposable dsh Run; wait for it to
 * reach a terminal state; refuse unless it is a clean exit 0 that produced a NEW
 * commit; then advance ONLY via the structured submission.
 */
async function implementOnce(
  db: Database,
  task: Task,
  deps: FactoryDeps
): Promise<{ run: Run; producedHead: string | null; error: string | null }> {
  const existing = latestRun(db, task.id, "implement", task.attempt);
  let run: Run;
  if (isLive(existing)) {
    logEvent(db, { source: "factory", taskId: task.id, type: "factory.run_adopted", payload: { runId: existing!.id } });
    run = await waitDshRun(db, existing!.id);
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

  if (run.state !== "exited" || run.exit_code !== 0) {
    // A process exit is NOT a submission: nothing advances.
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
    // A refused submission (stale/superseded run, moved head/phase) NEVER
    // advances the Task; surface it as a fail-closed Factory outcome.
    return {
      run,
      producedHead: run.head_sha,
      error: `${SUBMIT_REFUSED}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return { run, producedHead: run.head_sha, error: null };
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
  if (!getWorker(db, reviewerWorker)) registerWorker(db, reviewerWorker, { role: REVIEWER_ROLE, agentKind: "claude" });
  if (!getWorker(db, integratorWorker)) registerWorker(db, integratorWorker, { role: INTEGRATOR_ROLE, agentKind: "relay" });

  const attempts: FactoryAttempt[] = [];
  const steps: string[] = [];
  const guardMax = maxAttempts * 6 + 12;
  let lastAttempt = -1;
  let current: FactoryAttempt | null = null;

  const push = (s: string) => {
    steps.push(s);
    logEvent(db, { source: "factory", taskId, type: "factory.step", payload: { step: s } });
  };

  for (let guard = 0; guard < guardMax; guard++) {
    const task = getTask(db, taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    if (task.state === "blocked_human" || task.state === "failed" || task.state === "cancelled" || task.state === "done") {
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
          current.runId = impl.run.id;
          current.baseHead = impl.run.base_head_sha;
          current.producedHead = impl.producedHead;
        }
        if (impl.error) {
          const outcome: FactoryOutcome = impl.error.startsWith(NO_IMPLEMENTATION) ? "no_implementation" : "coding_failed";
          return { taskId, outcome, head: getTask(db, taskId)!.head_sha, attempts, gate: null, reason: impl.error, steps };
        }
        push(`implement:run ${impl.run.id} -> submitted (head ${impl.run.head_sha ?? "none"})`);
        continue;
      }
      case "verify": {
        const checks = taskChecks(task);
        if (checks.length === 0) {
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
            return { taskId, outcome: "blocked", head: live.head_sha, attempts, gate: null, reason: `verify ${v.outcome}`, steps };
          }
          push(`verify:${v.outcome}@${task.attempt} -> new attempt`);
          continue;
        }
        push(`verify:pass@${task.attempt}`);
        continue;
      }
      case "review": {
        const r = await runHeadlessReview(db, taskId, {
          spawner: deps.reviewerSpawner,
          command: deps.reviewerCommand,
          model: deps.reviewerModel,
          reviewerWorker,
        });
        if (current) current.reviewVerdict = r.outcome === "refused" ? "refused" : r.outcome;
        if (r.outcome === "refused") {
          return { taskId, outcome: "review_refused", head: getTask(db, taskId)!.head_sha, attempts, gate: null, reason: r.error, steps };
        }
        if (r.outcome === "blocked") {
          const live = getTask(db, taskId)!;
          return { taskId, outcome: "blocked", head: live.head_sha, attempts, gate: null, reason: r.verdict?.summary ?? "review blocked", steps };
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
