import type { Database } from "bun:sqlite";
import { reviewTasks, runnableTasks, taskCounts, unfinishedCount } from "./tasks";
import { listWorkers } from "./workers";

export function stallMs(): number {
  const v = Number(process.env.AGENTCTL_STALL_MS ?? "60000");
  return Number.isFinite(v) && v > 0 ? v : 60000;
}

export function lowWaterMark(): number {
  const v = Number(process.env.AGENTCTL_LOW_WATER ?? "3");
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
 * Workers actually moving work: state == working AND holding a task.
 * Idle is NOT productive: an idle worker with runnable tasks around
 * must be woken, never counted as "someone is on it".
 */
export function workingWorkers(db: Database): { id: string; state: string }[] {
  return listWorkers(db).filter((w) => w.state === "working" && w.current_task_id !== null);
}

/** @deprecated Use workingWorkers(). Idle does not count as productive. */
export function productiveWorkers(db: Database): { id: string; state: string }[] {
  return workingWorkers(db);
}

/**
 * Workers that can accept NEW work: state == idle AND holding no task.
 * waiting_input is explicitly NOT here: such a worker still owns its current
 * work and must never be told to `agentctl next`. starting/restarting workers
 * are not ready yet either.
 */
export function idleWorkers(db: Database): { id: string; role: string; state: string }[] {
  return listWorkers(db).filter((w) => w.state === "idle" && w.current_task_id === null);
}

/** @deprecated Use idleWorkers(). Kept as the NEXT_NUDGE candidate set. */
export function wakeableWorkers(db: Database): { id: string; role: string; state: string }[] {
  return idleWorkers(db);
}

export function reviewers(db: Database): { id: string; state: string }[] {
  return listWorkers(db).filter((w) => w.role === "reviewer");
}

export function planners(db: Database): { id: string; state: string }[] {
  return listWorkers(db).filter((w) => w.role === "planner");
}

export interface SupervisorView {
  runnable: number;
  review: number;
  unfinished: number;
  working: number;
  status: SystemStatus;
}

export function supervisorView(db: Database): SupervisorView {
  return {
    runnable: runnableTasks(db).length,
    review: reviewTasks(db).length,
    unfinished: unfinishedCount(db),
    working: workingWorkers(db).length,
    status: systemStatus(db),
  };
}

/** Core invariant: runnable work with zero working workers => wake or start someone. */
export function needsWorkerWakeup(v: SupervisorView): boolean {
  return v.runnable > 0 && v.working === 0;
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
