import type { Database } from "bun:sqlite";
import { findTaskResult } from "./results";
import type { Task } from "./schema";
import { TERMINAL_TASK_STATES } from "./schema";
import { getTask } from "./tasks";
import { defaultRunner, type CommandRunner } from "./verify";
import { runMechanicalVerification, taskChecks } from "./workflow";
import { runMergeGates } from "./merge-gate";
import {
  NO_AUTHORITY,
  reconcileTaskFromProvider,
  type ChecksReadOnly,
  type GitHubReadOnly,
  type LinearReadOnly,
  type ProviderAuthority,
} from "./providers";

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
 * A task bound to a PR is still polled after it is `done` until the merge is
 * confirmed (`merged_at` set), so an accept-then-merge flow still credits.
 */
export function providerBoundTasks(db: Database): Task[] {
  return db
    .query(
      `SELECT * FROM tasks
        WHERE code_change = 1 AND provider IS NOT NULL
          AND (pr_url IS NOT NULL OR issue_id IS NOT NULL)
          AND (
            state NOT IN (${TERMINAL_STATE_SQL})
            OR (state = 'done' AND pr_url IS NOT NULL AND merged_at IS NULL)
          )
        ORDER BY priority DESC, created_at ASC`
    )
    .all() as Task[];
}

/** Minimum spacing between provider polls of one task (default 60s). */
export function providerPollMs(): number {
  const v = Number(process.env.RELAY_PROVIDER_POLL_MS ?? "60000");
  return Number.isFinite(v) && v >= 0 ? v : 60000;
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
export function reconcileProviderBound(db: Database, deps: WorkflowDeps): string[] {
  if (!deps.github && !deps.linear) return [];
  const actions: string[] = [];
  const nowMs = Date.now();
  const pollMs = providerPollMs();
  for (const t of providerBoundTasks(db)) {
    // Throttle: a provider poll makes real, rate-limited API calls, so skip a
    // task polled within the interval. `0` disables the throttle (tests).
    if (pollMs > 0 && t.provider_polled_at !== null && nowMs - t.provider_polled_at < pollMs) continue;
    const taken = reconcileTaskFromProvider(db, t.id, {
      github: deps.github,
      linear: deps.linear,
      authorizedReviewers: deps.authorizedReviewers,
      authority: deps.authority ?? NO_AUTHORITY,
    });
    db.query(`UPDATE tasks SET provider_polled_at = ? WHERE id = ?`).run(nowMs, t.id);
    for (const a of taken) actions.push(`${a.kind}:${a.taskId}`);
  }
  return actions;
}

/**
 * ISH-761: evaluate the read-only, HEAD-bound merge gate for every candidate and
 * raise `IntegrationRequired` on a real conflict. Logs each new decision identity
 * once. Pure observation: it never merges, rebases or writes a provider.
 */
export function reconcileMergeGates(db: Database, deps: WorkflowDeps): string[] {
  const actions: string[] = [];
  const runs = runMergeGates(db, {
    github: deps.github,
    linear: deps.linear,
    checks: deps.checks,
    authorizedReviewers: deps.authorizedReviewers,
    authority: deps.authority ?? NO_AUTHORITY,
  });
  for (const r of runs) {
    if (r.logged) actions.push(`merge-gate-${r.decision.status.toLowerCase()}:${r.decision.taskId}`);
    if (r.integrationRaised) actions.push(`integration-required:${r.decision.taskId}`);
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
  actions.push(...(await runPendingMechanicalVerifications(db, deps)));
  actions.push(...reconcileProviderBound(db, deps));
  actions.push(...reconcileMergeGates(db, deps));
  return actions;
}
