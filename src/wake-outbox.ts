import type { Database } from "bun:sqlite";
import { now } from "./db";
import { wakeViaPlugin } from "./harness";
import type { Runtime } from "./runtime/runtime";
import type { Worker } from "./schema";

// Durable wake outbox for PLUGIN-woken harnesses.
//
// Relay normally nudges a worker by typing into its Herdr pane (`rt.wake`). A
// server harness (dsh) has no input pane, so the nudge is instead queued in
// `worker_wakes` and PULLED by that harness's relay plugin over the unix socket
// (`worker.wake.await`). The queue is durable so a nudge survives a daemon
// restart or a momentarily-disconnected plugin, and it is PULL-based so the
// daemon needs no reverse connection into the harness.
//
// One row per worker: the newest nudge REPLACES the old one. A stale
// instruction ("continue task T") is worse than none, and the supervisor
// recomputes the right nudge from current DB state on its next pass; relay's
// existing wake cooldown bounds the rate.

export interface PendingWake {
  reason: string;
  text: string;
  created_at: number;
}

/** Queue (or replace) the pending nudge for a plugin-woken worker. */
export function enqueueWake(db: Database, workerId: string, text: string, reason = "wake"): void {
  db.query(
    `INSERT INTO worker_wakes (worker_id, reason, text, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(worker_id) DO UPDATE SET reason = excluded.reason, text = excluded.text, created_at = excluded.created_at`
  ).run(workerId, reason, text, now());
}

/** Take and CLEAR the pending nudge, or null when there is none. */
export function takeWake(db: Database, workerId: string): PendingWake | null {
  const row = db
    .query(`SELECT reason, text, created_at FROM worker_wakes WHERE worker_id = ?`)
    .get(workerId) as PendingWake | null;
  if (!row) return null;
  db.query(`DELETE FROM worker_wakes WHERE worker_id = ?`).run(workerId);
  return row;
}

/** Drop any pending nudge WITHOUT delivering it (detach/retire cleanup). */
export function clearWake(db: Database, workerId: string): void {
  db.query(`DELETE FROM worker_wakes WHERE worker_id = ?`).run(workerId);
}

/** Pending nudge count for a worker (projections/tests). */
export function pendingWake(db: Database, workerId: string): PendingWake | null {
  return (
    (db
      .query(`SELECT reason, text, created_at FROM worker_wakes WHERE worker_id = ?`)
      .get(workerId) as PendingWake | null) ?? null
  );
}

/**
 * Long-poll for the next nudge, up to `waitMs` milliseconds. The DB is re-read
 * on a short interval (not an in-process event) so a nudge enqueued by ANOTHER
 * process — `relay send` runs in the CLI, not the daemon — is picked up too.
 * Returns null on timeout.
 */
export async function awaitWake(db: Database, workerId: string, waitMs: number): Promise<PendingWake | null> {
  const deadline = now() + Math.max(0, waitMs);
  for (;;) {
    const row = takeWake(db, workerId);
    if (row) return row;
    const left = deadline - now();
    if (left <= 0) return null;
    await Bun.sleep(Math.min(POLL_MS, left));
  }
}

const POLL_MS = 250;

/**
 * Deliver a nudge by the worker's harness: a plugin-woken harness gets a durable
 * outbox row; everything else is typed into its Herdr pane. This is the single
 * routing point, so a server harness never silently loses a nudge to a pane it
 * cannot read.
 */
export async function wakeWorker(rt: Runtime, db: Database, w: Worker, text: string, reason = "wake"): Promise<void> {
  if (wakeViaPlugin(w.agent_kind)) {
    enqueueWake(db, w.id, text, reason);
    return;
  }
  await rt.wake(w, text);
}
