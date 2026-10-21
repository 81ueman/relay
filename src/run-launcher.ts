import type { Database } from "bun:sqlite";
import { isCanonicalToken, spawnIdentityToken } from "./proc-identity";
import type { Run } from "./schema";

/**
 * ISH-1008: who owns a Run's terminal write?
 *
 * A Run row is inserted by the coroutine that launches it, and that same
 * coroutine writes the terminal state after the dsh exits. The row can stay
 * `running` for a noticeable window after the child is gone: a local Run still
 * runs `git rev-parse`, and a sandbox Run still fetches the produced commit out
 * of the VM. During that window the child PID is dead while the launcher is very
 * much alive and about to write the real outcome.
 *
 * The periodic liveness sweep must therefore prove BOTH processes are gone —
 * the child (dsh) and the launcher (the coroutine that owns the terminal row).
 * This module records a durable launcher lease on the Run row
 * (`launcher_pid`/`launcher_lstart`) and answers "may the launcher still write?".
 *
 *   - a launch in THIS process is tracked in memory (`active`/`done`), so the
 *     sweep can distinguish "still finishing" from "coroutine already returned";
 *   - a launch in ANOTHER process is checked by PID + canonical start-time
 *     token, exactly like `identifyRunProcess` checks the dsh itself;
 *   - a live launcher we cannot identify keeps the fence (conservative);
 *   - the lease is cleared as soon as the launcher coroutine is done, even when
 *     its terminal write failed, so the next sweep can retry that write.
 */

interface LauncherFields {
  launcher_pid: number;
  launcher_lstart: string | null;
}

type LaunchState = "active" | "done";

/**
 * Launches owned by this process. `done` entries are kept briefly so a sweep in
 * the same process does not fall back to the (still-alive) launcher PID after
 * the coroutine has already finished. Bounded to avoid unbounded growth in a
 * long-lived daemon/test process.
 */
const launches = new Map<string, LaunchState>();
const MAX_TRACKED_LAUNCHES = 4096;

function trimLaunches(): void {
  if (launches.size <= MAX_TRACKED_LAUNCHES) return;
  for (const [id, state] of launches) {
    if (launches.size <= MAX_TRACKED_LAUNCHES) return;
    if (state === "done") launches.delete(id);
  }
}

/**
 * The process start token never changes, so read it at most once per process.
 * `null` (ps unavailable) is cached too: the sweep then keeps the conservative
 * "live but unidentifiable" fence instead of racing a launcher.
 */
let cachedLstart: string | null | undefined;

/** The identity to persist on a Run row at insert time (this process). */
export function launcherFields(): LauncherFields {
  if (cachedLstart === undefined) cachedLstart = spawnIdentityToken(process.pid);
  return { launcher_pid: process.pid, launcher_lstart: cachedLstart };
}

/** Mark a Run as being launched by THIS process (before its `done` coroutine). */
export function beginRunLaunch(runId: string): void {
  launches.set(runId, "active");
  trimLaunches();
}

/** The launcher coroutine is done (successful write, failure, or stuck return). */
export function endRunLaunch(runId: string): void {
  if (launches.get(runId) === "active") {
    launches.set(runId, "done");
    trimLaunches();
  }
}

/**
 * Clear the durable launcher lease. Called in the launcher's `finally`: from
 * then on the row has no writer, so the sweep may finish it if the terminal
 * write did not land (e.g. ENOSPC). Best-effort: a full disk must not throw out
 * of an already-settled launch coroutine, and process exit also ends the lease.
 */
export function releaseRunLauncher(db: Database, runId: string): void {
  try {
    db.query(`UPDATE runs SET launcher_pid = NULL, launcher_lstart = NULL WHERE id = ?`).run(runId);
  } catch {
    /* ENOSPC / closed DB: the same-process registry or process exit still ends it */
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * True when the launcher recorded on `run` may still write its terminal row.
 * The sweep MUST NOT orphan the Run while this is true.
 */
export function launcherMayStillWrite(run: Pick<Run, "id" | "launcher_pid" | "launcher_lstart">): boolean {
  const tracked = launches.get(run.id);
  if (tracked === "active") return true;
  if (tracked === "done") return false;

  const pid = run.launcher_pid;
  if (pid === null || pid === undefined) return false; // no lease: legacy row or done
  if (!pidAlive(pid)) return false;

  // The PID is alive. Prove it is the SAME launcher (not a reused PID). A token
  // we cannot read/compare is undeterminable: hold the fence rather than risk a
  // false death announcement for a launcher that is still finishing.
  if (run.launcher_lstart && isCanonicalToken(run.launcher_lstart)) {
    const token = spawnIdentityToken(pid);
    if (token !== null) return token === run.launcher_lstart;
  }
  return true;
}
