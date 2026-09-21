import type { Database } from "bun:sqlite";
import { findRuntime, getStartingRuntime } from "./runtimes";
import { getSession } from "./sessions";
import { reviewTasks, runnableTasks, taskCounts, unclaimableRunnableTasks, unfinishedCount } from "./tasks";
import { listWorkers, type WorkerRow } from "./workers";

export function stallMs(): number {
  const v = Number(process.env.RELAY_STALL_MS ?? "60000");
  return Number.isFinite(v) && v > 0 ? v : 60000;
}

export function lowWaterMark(): number {
  const v = Number(process.env.RELAY_LOW_WATER ?? "3");
  return Number.isFinite(v) && v >= 0 ? v : 3;
}

export type SystemStatus = "RUNNING" | "SYSTEM_WAITING_FOR_HUMAN";

export function systemStatus(db: Database): SystemStatus {
  const counts = taskCounts(db);
  const runnable = counts["queued"] ?? 0;
  const review = counts["review"] ?? 0;
  const unfinished = unfinishedCount(db);
  if (unfinished === 0) return "RUNNING";
  if (runnable === 0 && review === 0) {
    const blockedHuman = counts["blocked_human"] ?? 0;
    if (blockedHuman > 0 && blockedHuman === unfinished) return "SYSTEM_WAITING_FOR_HUMAN";
  }
  return "RUNNING";
}

/**
 * A worker is OPERATIONAL (supervisable) iff Relay currently manages a live
 * session for it, or it is mid-spawn for a relay-owned generation:
 *
 *   managed session bound (sessions.managed=1 for worker.opencode_session_id)
 *   OR worker.state == 'starting' with a relay-owned starting runtime
 *
 * A detached worker (relay `session detach` / agent_detach) keeps its row but
 * has NO managed session, so it is NOT operational: Relay never wakes, polls,
 * stalls or restarts it. The source of truth stays sessions.managed +
 * workers.opencode_session_id — no duplicate `workers.managed` flag.
 */
export function isOperationalWorker(db: Database, w: WorkerRow): boolean {
  if (w.retired_at !== null) return false; // retired = history only, never supervised
  if (w.opencode_session_id) {
    const s = getSession(db, w.opencode_session_id);
    if (s && s.managed === 1 && s.worker_id === w.id) return true;
  }
  if (w.state === "starting") {
    const sr = getStartingRuntime(db, w.id, w.generation);
    if (sr && sr.relay_owned === 1) return true;
  }
  return false;
}

/** All workers the supervisor may act on (managed session or relay-spawn start). */
export function operationalWorkers(db: Database): WorkerRow[] {
  return listWorkers(db).filter((w) => isOperationalWorker(db, w));
}

/**
 * A worker whose current generation FAILED but which Relay still owns and must
 * recover. This is the distinction between an attach-timeout / crashed spawn
 * generation and an explicitly detached worker:
 *
 *   - state is 'dead' or 'stalled' (a failed generation), AND
 *   - the worker's CURRENT generation has a relay-owned runtime row (proving
 *     Relay created the lifecycle and may replace it).
 *
 * A detached worker is state 'idle' with no relay-owned runtime for its current
 * generation (manual runtimes are relay_owned=false), so it is NEVER recoverable
 * and NEVER restarted.
 */
export function isRecoverableWorker(db: Database, w: WorkerRow): boolean {
  if (isOperationalWorker(db, w)) return false;
  if (w.state !== "dead" && w.state !== "stalled") return false;
  const rr = findRuntime(db, w.id, w.generation);
  return !!rr && rr.relay_owned === 1;
}

/**
 * The full supervision set: operational workers (live/managed or mid-spawn) plus
 * recoverable workers (a failed relay-owned generation still awaiting a fresh
 * one). Detached/plain workers are in neither set.
 */
export function isSupervisedWorker(db: Database, w: WorkerRow): boolean {
  return isOperationalWorker(db, w) || isRecoverableWorker(db, w);
}

export function supervisedWorkers(db: Database): WorkerRow[] {
  return listWorkers(db).filter((w) => isSupervisedWorker(db, w));
}

/**
 * Workers actually moving work: state == working AND holding a task.
 * Idle is NOT productive: an idle worker with runnable tasks around
 * must be woken, never counted as "someone is on it".
 */
export function workingWorkers(db: Database): { id: string; state: string }[] {
  return listWorkers(db).filter(
    (w) => w.state === "working" && w.current_task_id !== null && isOperationalWorker(db, w)
  );
}

/** @deprecated Use workingWorkers(). Idle does not count as productive. */
export function productiveWorkers(db: Database): { id: string; state: string }[] {
  return workingWorkers(db);
}

/**
 * Workers that can accept NEW work: state == idle AND holding no task.
 * waiting_input is explicitly NOT here: such a worker still owns its current
 * work and must never be told to `relay next`. starting workers
 * are not ready yet either, and detached workers are not schedulable at all.
 */
export function idleWorkers(db: Database): { id: string; role: string; state: string }[] {
  return listWorkers(db).filter(
    (w) => w.state === "idle" && w.current_task_id === null && isOperationalWorker(db, w)
  );
}

/** @deprecated Use idleWorkers(). Kept as the NEXT_NUDGE candidate set. */
export function wakeableWorkers(db: Database): { id: string; role: string; state: string }[] {
  return idleWorkers(db);
}

export function reviewers(db: Database): { id: string; state: string }[] {
  return listWorkers(db).filter((w) => w.role === "reviewer" && isOperationalWorker(db, w));
}

export function planners(db: Database): { id: string; state: string }[] {
  return listWorkers(db).filter((w) => w.role === "planner" && isOperationalWorker(db, w));
}

export interface SupervisorView {
  runnable: number;
  review: number;
  unfinished: number;
  working: number;
  status: SystemStatus;
  /** Runnable tasks whose non-null role matches no registered worker (strict only). */
  unclaimable: number;
}

export function supervisorView(db: Database): SupervisorView {
  return {
    runnable: runnableTasks(db).length,
    review: reviewTasks(db).length,
    unfinished: unfinishedCount(db),
    working: workingWorkers(db).length,
    status: systemStatus(db),
    unclaimable: unclaimableRunnableTasks(db).length,
  };
}

/**
 * Core invariant: runnable work exists => look for someone who can take it.
 *
 * This deliberately does NOT require `working === 0`. That older condition is
 * false as soon as ANY worker is busy, which is the normal state of a parallel
 * fleet: with six workers busy and a fresh role-gated child queued, an idle
 * role-matched worker would never be nudged and the child would sit until a
 * human ran `relay next`. Whether the fleet has zero or many working workers
 * says nothing about whether the *queued* work has a taker.
 *
 * The caller pairs this with a per-worker check
 * (`claimableRunnableTasks(candidate)`), so "runnable exists" here only means
 * "worth evaluating the candidates" — never "wake anybody".
 *
 * Rate limiting stays in `tryWake` (its per-worker wake cooldown), so relaxing
 * this gate cannot turn into a nudge storm.
 */
export function needsWorkerWakeup(v: SupervisorView): boolean {
  return v.runnable > 0;
}

export function needsPlanner(v: SupervisorView, plannerCount = 1): boolean {
  if (plannerCount === 0) return false;
  // A planner must not invent work out of thin air. Only top up the queue while
  // there is already work in flight, and never while the only thing left is a
  // human decision.
  if (v.status === "SYSTEM_WAITING_FOR_HUMAN") return false;
  if (v.unfinished === 0) return false;
  return v.runnable < lowWaterMark();
}

export function needsReviewer(v: SupervisorView): boolean {
  return v.review > 0;
}
