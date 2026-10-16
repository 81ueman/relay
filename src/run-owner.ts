import type { Database } from "bun:sqlite";
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

export function runOwnedError(run: Run, taskId: string): Error {
  return new Error(
    `${RUN_OWNED}: run ${run.id} (${run.state}) owns ${taskId} ${run.phase}/${run.attempt}; ` +
      `a Run-driven phase advances ONLY via a Run-bound submission (acceptRunSubmission), not a worker claim/submit`
  );
}
