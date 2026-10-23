import type { Database } from "bun:sqlite";
import { findTaskResult } from "./results";
import type { Task } from "./schema";
import { TERMINAL_TASK_STATES, isTerminalTaskState } from "./schema";
import { getTask } from "./tasks";
import { defaultRunner, type CommandRunner } from "./verify";
import { confirmMerged, runMechanicalVerification, taskChecks } from "./workflow";
import { runMergeGates } from "./merge-gate";
import {
  NO_AUTHORITY,
  reconcileTaskFromProvider,
  type ChecksReadOnly,
  type GitHubReadOnly,
  type LinearReadOnly,
  type ProviderAuthority,
} from "./providers";
import {
  PROVIDER_POLL_PHASES,
  currentProviderRateLimit,
  markProviderPolled,
  providerPollDue,
  providerPollMs,
} from "./provider-poll";
import { logProviderRateLimitOnce } from "./provider-rate-limit";

export { providerPollDue, providerPollMs } from "./provider-poll";

/** Terminal task states as an SQL `IN`/`NOT IN` list (done/failed/cancelled). */
const TERMINAL_STATE_SQL = TERMINAL_TASK_STATES.map((s) => `'${s}'`).join(",");

/**
 * ISH-759 workflow driver: the daemon-side glue that turns a structured result
 * into the NEXT event WITHOUT a waiting LLM.
 *
 *   submit -> [pending mechanical verify] -> run commands -> review
 *   provider poll -> bind PR / confirm merge / apply an authorized verdict
 *
 * The reconciler calls this each pass. Everything is idempotent and bounded:
 * a task with a VerificationResult for the current attempt is never re-run, and
 * a provider effect fires at most once per (task, head, verdict).
 */

export interface WorkflowDeps {
  /** The read-only command runner used by mechanical verify (default: real). */
  verifyRunner?: CommandRunner;
  /**
   * Fallback working directory for mechanical verify when a task records no
   * `worktree`. Prefer the per-task worktree; this is only a default.
   */
  verifyCwd?: string;
  /** Reads a checkout's HEAD for the pre-run binding check (default: git). */
  verifyHeadProbe?: (cwd: string) => string | null;
  github?: GitHubReadOnly;
  linear?: LinearReadOnly;
  /** ISH-761: HEAD-pinned required-check reader for the merge gate. */
  checks?: ChecksReadOnly;
  authorizedReviewers?: string[];
  authority?: ProviderAuthority;
  /**
   * ISH-1129: daemon shutdown. The provider poll and merge-gate walk stop
   * between Tasks when it aborts, and the readers' abortable exec cancels an
   * in-flight provider command — so exit time does not scale with Task count.
   */
  signal?: AbortSignal;
}

export const EMPTY_WORKFLOW_DEPS: WorkflowDeps = {};

/** Code tasks Relay must mechanically verify next: verify phase, Relay-owned, no result yet. */
export function pendingMechanicalVerifications(db: Database): Task[] {
  const candidates = db
    .query(
      `SELECT * FROM tasks
        WHERE code_change = 1 AND phase = 'verify' AND claim_role = 'relay'
          AND state = 'queued'
        ORDER BY priority DESC, created_at ASC`
    )
    .all() as Task[];
  return candidates.filter((t) => !findTaskResult(db, t.id, "verify", t.attempt, "VerificationResult"));
}

/**
 * Code tasks with a provider binding that may need reconciling this pass.
 *
 * ISH-1132: the poll admits only a Task that can still change — one with a LIVE
 * Run (mid-implementation PR/head binding), or one in review/merge_ready/
 * integration. The old unconditional `done` exception made every already-merged
 * Task spend `gh pr view`/`gh pr list`/`check-runs` calls forever.
 *
 * ISH-1138: a `done` Task accepted BEFORE its PR merged is still the one
 * exception — it has a bound PR, no `merged_at` yet, and no settled tombstone, so
 * its merge cannot be recorded otherwise. It stays a candidate, bounded by the
 * same per-Task interval, until `merged_at` is set or `pr_settled_at` records a
 * final observation (PR closed, or merged at a head this Task cannot credit);
 * then it leaves the poll set for good. Settled Tasks still spend zero provider
 * calls.
 */
export function providerBoundTasks(db: Database): Task[] {
  return db
    .query(
      `SELECT * FROM tasks t
        WHERE t.code_change = 1 AND t.provider IS NOT NULL
          AND (t.pr_url IS NOT NULL OR t.issue_id IS NOT NULL)
          AND t.merged_at IS NULL
          AND (
            -- ISH-1138: accept-before-merge, until the merge or a final PR
            -- observation (closed / merged at another head) is recorded.
            (t.state = 'done' AND t.pr_url IS NOT NULL AND t.pr_settled_at IS NULL)
            OR (
              -- ISH-1132: a non-terminal Task that can still change.
              t.state NOT IN (${TERMINAL_STATE_SQL})
              AND t.accepted_at IS NULL
              AND (
                t.phase IN (${PROVIDER_POLL_PHASES.map((p) => `'${p}'`).join(",")})
                OR EXISTS (
                  SELECT 1 FROM runs r
                   WHERE r.task_id = t.id AND r.state IN ('starting', 'running')
                )
              )
            )
          )
        ORDER BY t.priority DESC, t.created_at ASC`
    )
    .all() as Task[];
}

/**
 * Run every pending mechanical verification. Returns the action labels taken.
 * Verification is bound to the head it started on; a race discards the run.
 */
export async function runPendingMechanicalVerifications(
  db: Database,
  deps: WorkflowDeps
): Promise<string[]> {
  const actions: string[] = [];
  const runner = deps.verifyRunner ?? defaultRunner;
  const fallbackCwd = deps.verifyCwd ?? process.env.RELAY_VERIFY_CWD ?? process.cwd();
  for (const t of pendingMechanicalVerifications(db)) {
    // ISH-1129: shutdown stops the walk before the next checkout command.
    if (deps.signal?.aborted) break;
    const checks = taskChecks(t);
    if (checks.length === 0) continue; // nothing mechanical to run
    // Bind to the TASK's own worktree (or the fallback cwd).
    const cwd = t.worktree ?? fallbackCwd;
    try {
      const { outcome, stale } = await runMechanicalVerification(db, t.id, {
        checks,
        runner,
        cwd,
        headProbe: deps.verifyHeadProbe,
      });
      actions.push(stale ? `verify-stale:${t.id}` : `verify-${outcome}:${t.id}`);
    } catch (e) {
      actions.push(`verify-error:${t.id}`);
      const live = getTask(db, t.id);
      if (live) {
        // Leave the task in verify; the next pass retries. Never a PASS.
        actions.push(`verify-retry:${t.id}`);
      }
    }
  }
  return actions;
}

/** Reconcile every provider-bound task (read-only). Returns action labels. */
export async function reconcileProviderBound(db: Database, deps: WorkflowDeps): Promise<string[]> {
  if (!deps.github && !deps.linear) return [];
  const actions: string[] = [];
  const nowMs = Date.now();
  const pollMs = providerPollMs();
  for (const t of providerBoundTasks(db)) {
    // ISH-1129: SIGTERM during a long bound-PR walk stops BEFORE the next
    // command. Without this, N Tasks x one slow `gh` call delayed shutdown by
    // N times the per-command timeout.
    if (deps.signal?.aborted) break;
    // ISH-1132: one rate-limit episode backs off the whole pass. Check before
    // and after every Task so a 403 in the first call does not spend N more.
    const limited = currentProviderRateLimit(deps);
    if (limited) {
      logProviderRateLimitOnce(db, limited);
      break;
    }
    // Throttle: a provider poll makes real, rate-limited API calls, so skip a
    // task polled within the interval. `0` disables the throttle (tests).
    if (!providerPollDue(t, nowMs, pollMs)) continue;
    const taken = await reconcileTaskFromProvider(db, t.id, {
      github: deps.github,
      linear: deps.linear,
      authorizedReviewers: deps.authorizedReviewers,
      authority: deps.authority ?? NO_AUTHORITY,
      signal: deps.signal,
    });
    // ISH-1129: an aborted read is NOT a poll. Do not advance the throttle (and
    // do not attribute a partial observation): the next daemon retries it.
    if (deps.signal?.aborted) break;
    // ISH-1132: a rate-limited read is NOT a completed poll. Do not advance the
    // throttle; the reader refuses calls until the reported reset anyway.
    const after = currentProviderRateLimit(deps);
    if (after) {
      logProviderRateLimitOnce(db, after);
      break;
    }
    // ISH-1138: a `done` Task accepted before its PR merged is polled by THIS
    // pass only (the merge gate excludes terminal Tasks), so this pass owns its
    // interval. A non-terminal merge_ready Task is read by BOTH this pass (PR
    // link/retarget/marker) and the gate (the SAME PR + HEAD-pinned check-runs);
    // the gate owns the durable timestamp there, so the two reads stay one
    // interval's budget instead of starving the gate on the next tick.
    const gateOwnsPoll = t.phase === "merge_ready" && !isTerminalTaskState(t.state);
    if (!gateOwnsPoll) markProviderPolled(db, t.id, nowMs);
    for (const a of taken) actions.push(`${a.kind}:${a.taskId}`);
  }
  return actions;
}

/**
 * ISH-761: evaluate the read-only, HEAD-bound merge gate for every candidate and
 * raise `IntegrationRequired` on a real conflict. Logs each new decision identity
 * once. Pure observation: it never merges, rebases or writes a provider.
 */
export async function reconcileMergeGates(db: Database, deps: WorkflowDeps): Promise<string[]> {
  const actions: string[] = [];
  if (deps.signal?.aborted) return actions;
  const runs = await runMergeGates(db, {
    github: deps.github,
    linear: deps.linear,
    checks: deps.checks,
    authorizedReviewers: deps.authorizedReviewers,
    authority: deps.authority ?? NO_AUTHORITY,
    signal: deps.signal,
  });
  for (const r of runs) {
    if (r.logged) actions.push(`merge-gate-${r.decision.status.toLowerCase()}:${r.decision.taskId}`);
    if (r.integrationRaised) actions.push(`integration-required:${r.decision.taskId}`);
    // ISH-1132/ISH-1138: a non-terminal merge_ready Task IS also read by the PR
    // pass (`merge_ready` is in PROVIDER_POLL_PHASES); that pass deliberately
    // leaves the shared interval's timestamp to this gate so both reads fit one
    // budget. A merge observed here is credited exactly like the provider pass
    // credits one.
    if (r.decision.status === "MERGED" && r.decision.pr) {
      const live = getTask(db, r.decision.taskId);
      if (live && live.merged_at === null) {
        try {
          confirmMerged(db, live.id, {
            headSha: r.decision.pr.headSha,
            repo: r.decision.pr.ref.repo,
            actor: "provider:github",
          });
          actions.push(`merged:${live.id}`);
        } catch {
          // confirmMerged's refusal is recorded by the gate decision (and the
          // provider pass logs merge_not_credited); never crash the pass here.
        }
      }
    }
  }
  return actions;
}

/**
 * One workflow pass: mechanical verify first (so a fresh submit advances the
 * same tick), then provider reconciliation, then the read-only merge gate.
 * Never merges and never writes to a provider; authority-gated effects are out
 * of this path.
 */
export async function processWorkflow(db: Database, deps: WorkflowDeps = EMPTY_WORKFLOW_DEPS): Promise<string[]> {
  const actions: string[] = [];
  if (deps.signal?.aborted) return actions;
  actions.push(...(await runPendingMechanicalVerifications(db, deps)));
  // ISH-1129: each sub-pass stops between Tasks on shutdown, and the abortable
  // provider exec kills an in-flight command, so SIGTERM is bounded even with
  // hundreds of bound Tasks.
  if (deps.signal?.aborted) return actions;
  actions.push(...(await reconcileProviderBound(db, deps)));
  if (deps.signal?.aborted) return actions;
  actions.push(...(await reconcileMergeGates(db, deps)));
  return actions;
}
