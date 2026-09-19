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

/** Workers currently able to make progress (not dead/stalled/waiting). */
export function productiveWorkers(db: Database): { id: string; state: string }[] {
  return listWorkers(db).filter((w) => w.state === "working" || w.state === "idle" || w.state === "starting");
}

export interface SupervisorView {
  runnable: number;
  review: number;
  unfinished: number;
  productive: number;
  status: SystemStatus;
}

export function supervisorView(db: Database): SupervisorView {
  return {
    runnable: runnableTasks(db).length,
    review: reviewTasks(db).length,
    unfinished: unfinishedCount(db),
    productive: productiveWorkers(db).length,
    status: systemStatus(db),
  };
}

export function needsWorkerWakeup(v: SupervisorView): boolean {
  return v.runnable > 0 && v.productive === 0;
}

export function needsPlanner(v: SupervisorView): boolean {
  return v.runnable < lowWaterMark() && v.unfinished > 0;
}

export function needsReviewer(v: SupervisorView): boolean {
  return v.review > 0;
}
