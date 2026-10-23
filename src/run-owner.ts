import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import type { Run } from "./schema";

/**
 * ISH-762: the live Run is the ONLY control-plane writer for its
 * `(task, phase, attempt)`.
 *
 * The headless dsh process inherits the factory's environment — including
 * `RELAY_DB` and `PATH` — so it *can* reach the generic worker CLI
 * (`relay claim` / `relay submit`). Those generic mutations move the Task out of
 * `implement` without a submission bound to the Run/HEAD, which then makes the
 * factory's own `acceptRunSubmission` fail (`RUN_SUBMISSION_REFUSED`) and can
 * strand the Task. This module lets `claimTask`/`submitPhase` (and the runnable
 * gate) refuse while a `starting`/`running` Run owns the Task's current
 * phase/attempt — the Run-bound `acceptRunSubmission` stays the only advance.
 *
 * Kept dependency-free (types only) so both `src/tasks.ts` and `src/workflow.ts`
 * can import it without a cycle.
 */

export const RUN_OWNED = "RUN_OWNED";

/** The live (`starting`/`running`) Run that owns a task's current phase/attempt. */
export function findLiveRunFor(
  db: Database,
  taskId: string,
  phase: string | null,
  attempt: number
): Run | null {
  if (!phase) return null;
  return (
    db
      .query(
        `SELECT * FROM runs
          WHERE task_id = ? AND phase = ? AND attempt = ? AND state IN ('starting', 'running')
          ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(taskId, phase, attempt) as Run | null) ?? null;
}

/**
 * ISH-1125: has the Task's bound HEAD been overtaken by someone OTHER than this
 * Run?
 *
 * A submit-time HEAD fence compares the Task's bound head with the Run's
 * pre-run base. That is right for a Task whose head moved under the Run, but it
 * also rejected a Run's OWN work: since ISH-1087 the daemon's provider poll
 * copies a live PR head onto the Task mid-Run, so a worker that pushes its
 * branch and opens its PR before the Run ends leaves `task.head_sha` equal to
 * the Run's produced commit (not its base). THAT movement is the Run's own
 * output, not a foreign writer, so it must not be called stale.
 *
 * The two heads a Run may legitimately find on the Task are therefore:
 *   - the head it started at (the Task did not move), or
 *   - the head it produced (the provider poll observed this Run's own push).
 * Any OTHER bound head still means the Task moved under the Run and is refused;
 * a NULL Task head adopts the produced head, as before.
 */
export function taskHeadOvertakenByOtherWriter(
  taskHead: string | null,
  run: Pick<Run, "base_head_sha" | "head_sha">
): boolean {
  if (taskHead === null) return false;
  return taskHead !== (run.base_head_sha ?? null) && taskHead !== (run.head_sha ?? null);
}

export function runOwnedError(run: Run, taskId: string): Error {
  return new Error(
    `${RUN_OWNED}: run ${run.id} (${run.state}) owns ${taskId} ${run.phase}/${run.attempt}; ` +
      `a Run-driven phase advances ONLY via a Run-bound submission (acceptRunSubmission), not a worker claim/submit`
  );
}

/** The worktree/branch a candidate writer would hold (see `findActiveWriter`). */
export interface ActiveWriterQuery {
  /** The worktree the candidate writer would run in. */
  cwd: string;
  /** The branch the candidate writer would write (null when not a git checkout). */
  branch?: string | null;
  /** Ignore this Run (e.g. the row being re-checked). */
  excludeRunId?: string;
}

/**
 * The non-terminal Run that already holds a writer on the SAME worktree (by
 * resolved cwd) or the SAME branch, or null. The single definition of the
 * ISH-760 single-writer fence, kept here (types + node builtins only) so BOTH
 * `src/dsh-runner.ts` (launch guard) and `src/workflow.ts` (phase transitions)
 * can ask it without an import cycle.
 */
export function findActiveWriterRow(db: Database, q: ActiveWriterQuery): Run | null {
  const cwd = resolve(q.cwd);
  const rows = db
    .query(`SELECT * FROM runs WHERE state IN ('starting','running') ORDER BY created_at DESC, rowid DESC`)
    .all() as Run[];
  for (const r of rows) {
    if (q.excludeRunId && r.id === q.excludeRunId) continue;
    const sameWorktree = resolve(r.cwd) === cwd;
    const sameBranch = !!(q.branch && r.branch && q.branch === r.branch);
    if (sameWorktree || sameBranch) return r;
  }
  return null;
}
