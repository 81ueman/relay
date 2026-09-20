import type { Database } from "bun:sqlite";
import { getActiveRuntime } from "./runtimes";

/**
 * Resolve which worker the caller is acting as.
 *
 * In a SHARED checkout `.relay/worker-id` is not an identity: `relay worker
 * register` overwrites it with whichever worker registered last, so every other
 * agent silently borrows that id. Notes get misattributed, and because `submit`
 * requires `task.assignee === workerId`, a worker that forgets `--worker` either
 * fails the fence or (worse) acts as someone else.
 *
 * The caller's own Herdr pane IS an identity when a runtime is attached to it,
 * so prefer that, and refuse the shared file default when it provably names a
 * worker attached to a DIFFERENT live pane.
 *
 *   1. explicit `--worker`           (always wins)
 *   2. `$RELAY_WORKER`
 *   3. caller's pane -> the worker whose ACTIVE runtime uses that pane
 *   4. `.relay/worker-id`            (single-worker convenience), unless step 3
 *      proves the file's worker lives in another pane
 */
export function resolveWorkerIdentity(opts: {
  db: Database;
  explicit?: string;
  envWorker?: string;
  paneId?: string;
  fileDefault?: string;
}): string {
  const { db, explicit, envWorker, paneId, fileDefault } = opts;
  if (explicit) return explicit;
  if (envWorker) return envWorker;

  const byPane = paneId ? findWorkerByPane(db, paneId) : null;
  if (byPane) return byPane;

  if (fileDefault) {
    if (paneId) {
      const owner = activePaneOf(db, fileDefault);
      if (owner && owner !== paneId) {
        throw new Error(
          `refusing to act as '${fileDefault}': .relay/worker-id is the shared checkout ` +
          `default and '${fileDefault}' is attached to ${owner}, not this pane (${paneId}). ` +
          `Pass --worker <id> or set $RELAY_WORKER.`
        );
      }
    }
    return fileDefault;
  }
  throw new Error(
    "no worker identity: pass --worker <id>, set $RELAY_WORKER, or run `relay worker register`"
  );
}

/** The worker whose ACTIVE runtime is attached to this Herdr pane, if any. */
export function findWorkerByPane(db: Database, paneId: string): string | null {
  const row = db
    .query(
      `SELECT rt.worker_id
         FROM worker_runtimes rt
         JOIN workers w ON w.id = rt.worker_id
        WHERE rt.pane_id = ? AND rt.state = 'active' AND w.retired_at IS NULL
        ORDER BY rt.generation DESC, rt.id DESC
        LIMIT 1`
    )
    .get(paneId) as { worker_id: string } | null;
  return row?.worker_id ?? null;
}

/** The pane of a worker's active runtime, if any. */
function activePaneOf(db: Database, workerId: string): string | null {
  return getActiveRuntime(db, workerId)?.pane_id ?? null;
}
