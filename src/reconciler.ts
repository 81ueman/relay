import type { Database } from "bun:sqlite";
import { now } from "./db";
import { countIdleSinceProgress, logEvent } from "./events";
import type { Runtime } from "./runtime/runtime";
import {
  needsPlanner,
  needsReviewer,
  needsWorkerWakeup,
  stallMs,
  supervisorView,
} from "./scheduler";
import { approveTask, expireLeases, getTask, reviewTasks, runnableTasks } from "./tasks";
import { getWorker, listWorkers, setWorkerState, touchSeen } from "./workers";

// Deterministic reconciler. No LLM: pure DB state + runtime transport.

export const NEXT_NUDGE = "You have runnable work waiting. Run `agentctl next` now. Do not wait for instructions.";
export const CONTINUE_NUDGE = (taskId: string) =>
  `Your current task ${taskId} is still running. Check task state and continue the next concrete action. Do not start over; do not wait.`;
export const STALL_NUDGE = (taskId: string) =>
  `No progress on ${taskId} for a while. If you can proceed, continue now. If you are stuck, run \`agentctl block ${taskId} "<reason>"\` (or --human only when a human is truly required), then run \`agentctl next\`.`;
export const REVIEW_NUDGE = "There are tasks waiting for review. Run `agentctl next` to pick one up.";
export const PLANNER_NUDGE =
  "Task queue is running low. Decompose the next objective into small tasks with acceptance criteria (agentctl task add), then go idle. Do not monitor other workers.";

async function tryWake(rt: Runtime, db: Database, workerId: string, text: string, reason: string): Promise<boolean> {
  try {
    await rt.wake(workerId, text);
    logEvent(db, { source: "supervisor", workerId, type: "worker.woken", payload: { reason } });
    return true;
  } catch (e) {
    logEvent(db, { source: "supervisor", workerId, type: "worker.wake_failed", payload: { reason, error: String(e) } });
    return false;
  }
}

function autoApproveEnabled(): boolean {
  return process.env.AGENTCTL_AUTO_APPROVE === "true";
}

export interface ReconcileResult {
  view: ReturnType<typeof supervisorView>;
  actions: string[];
}

/** One deterministic reconcile pass. Safe to run every 1-2s. */
export async function reconcile(db: Database, rt: Runtime, at = now()): Promise<ReconcileResult> {
  const actions: string[] = [];

  // 1. Expire stale leases first (worker crash recovery).
  const expired = expireLeases(db, at);
  for (const t of expired) actions.push(`lease-expired:${t.id}`);

  // 2. Walk workers.
  const workers = listWorkers(db);
  const stallTimeout = stallMs();

  for (const w of workers) {
    const alive = await rt.isAlive(w.id).catch(() => false);
    const fresh = getWorker(db, w.id)!;

    // Dead worker holding (or not holding) work -> mark dead, release task, restart.
    if (!alive) {
      if (fresh.state !== "dead") {
        setWorkerState(db, w.id, "dead");
        logEvent(db, { source: "supervisor", workerId: w.id, type: "worker.dead" });
        actions.push(`dead:${w.id}`);
      }
      if (fresh.current_task_id) {
        const task = getTask(db, fresh.current_task_id);
        if (task && task.state === "running") {
          db.query(
            `UPDATE tasks SET state = 'queued', assignee = NULL, lease_token = lease_token + 1, lease_until = NULL, updated_at = ? WHERE id = ?`
          ).run(at, task.id);
          logEvent(db, { source: "supervisor", workerId: w.id, taskId: task.id, type: "task.requeued_dead_worker" });
          actions.push(`requeued:${task.id}`);
        }
        db.query(`UPDATE workers SET current_task_id = NULL, updated_at = ? WHERE id = ?`).run(at, w.id);
      }
      // Restart so a replacement can pick work up; restart failure is recorded, task stays queued.
      try {
        await rt.restart(w.id);
        setWorkerState(db, w.id, "restarting");
        actions.push(`restarted:${w.id}`);
      } catch (e) {
        logEvent(db, { source: "supervisor", workerId: w.id, type: "worker.restart_failed", payload: { error: String(e) } });
      }
      continue;
    }

    // Alive worker claiming work but lease-less task gone (e.g. DB moved on): resync to idle.
    if ((fresh.state === "working" || fresh.state === "waiting_input") && fresh.current_task_id) {
      const task = getTask(db, fresh.current_task_id);
      if (!task || (task.state !== "running" && task.state !== "review") || task.assignee !== w.id) {
        db.query(`UPDATE workers SET current_task_id = NULL, state = 'idle', updated_at = ? WHERE id = ?`).run(at, w.id);
        logEvent(db, { source: "supervisor", workerId: w.id, type: "worker.resynced", payload: { task: fresh.current_task_id } });
        actions.push(`resynced:${w.id}`);
        continue;
      }
      // Stalled detection: running + valid lease + no progress + process alive.
      if (task.state === "running" && (task.lease_until ?? 0) >= at && at - fresh.last_progress_at > stallTimeout) {
        if (!fresh.nudged_at) {
          await tryWake(rt, db, w.id, STALL_NUDGE(task.id), "stall-nudge");
          db.query(`UPDATE workers SET nudged_at = ?, updated_at = ? WHERE id = ?`).run(at, at, w.id);
          actions.push(`nudge:${w.id}`);
        } else if (at - fresh.nudged_at > stallTimeout) {
          setWorkerState(db, w.id, "stalled");
          logEvent(db, { source: "supervisor", workerId: w.id, taskId: task.id, type: "worker.stalled" });
          try { await rt.interrupt(w.id); } catch { /* best effort */ }
          db.query(
            `UPDATE tasks SET state = 'queued', assignee = NULL, lease_token = lease_token + 1, lease_until = NULL, updated_at = ? WHERE id = ?`
          ).run(at, task.id);
          db.query(`UPDATE workers SET current_task_id = NULL, nudged_at = NULL, updated_at = ? WHERE id = ?`).run(at, w.id);
          try { await rt.restart(w.id); } catch { /* best effort */ }
          actions.push(`stalled:${w.id}`);
        }
      }
    }
  }

  // 3. Invariants.
  const view = supervisorView(db);

  if (needsWorkerWakeup(view)) {
    // Wake (or restart) one worker so at least one agent moves forward.
    const candidates = listWorkers(db).sort((a, b) => a.id.localeCompare(b.id));
    const target = candidates.find((c) => c.state === "idle" || c.state === "starting" || c.state === "waiting_input")
      ?? candidates.find((c) => c.state === "stalled" || c.state === "dead" || c.state === "restarting")
      ?? candidates[0];
    if (target) {
      if (target.state === "dead" || target.state === "stalled" || target.state === "restarting") {
        try {
          await rt.restart(target.id);
          setWorkerState(db, target.id, "restarting");
          actions.push(`restarted:${target.id}`);
        } catch {
          actions.push(`restart-failed:${target.id}`);
        }
      } else {
        if (await tryWake(rt, db, target.id, NEXT_NUDGE, "no-productive-worker")) actions.push(`woken:${target.id}`);
      }
    } else {
      logEvent(db, { source: "supervisor", type: "supervisor.no_workers", payload: { view } });
      actions.push("no-workers");
    }
  }

  if (needsReviewer(view)) {
    if (autoApproveEnabled()) {
      for (const t of reviewTasks(db)) {
        approveTask(db, t.id, "supervisor");
        actions.push(`auto-approved:${t.id}`);
      }
    } else {
      const reviewers = listWorkers(db).filter((w) => w.role === "reviewer" && (w.state === "idle" || w.state === "starting"));
      for (const r of reviewers) {
        if (await tryWake(rt, db, r.id, REVIEW_NUDGE, "review-pending")) actions.push(`reviewer-woken:${r.id}`);
      }
    }
  }

  if (needsPlanner(view)) {
    const planners = listWorkers(db).filter((w) => w.role === "planner" && (w.state === "idle" || w.state === "starting"));
    for (const p of planners) {
      if (await tryWake(rt, db, p.id, PLANNER_NUDGE, "queue-low")) actions.push(`planner-woken:${p.id}`);
    }
  }

  return { view: supervisorView(db), actions };
}

/**
 * Handle a session.idle signal. Idle is NEVER task completion: inspect the DB
 * and nudge accordingly. Returns a short description of what was done.
 */
export async function handleIdleSignal(db: Database, rt: Runtime, workerId: string, at = now()): Promise<string> {
  const w = getWorker(db, workerId);
  if (!w) {
    logEvent(db, { source: "opencode", workerId, type: "session.idle_unknown_worker" });
    return "unknown-worker";
  }
  touchSeen(db, workerId, at);
  logEvent(db, { source: "opencode", workerId, type: "session.idle" });

  if (!w.current_task_id) {
    // Case 1: no task + runnable work -> wake to next.
    if (runnableTasks(db).length > 0) {
      await tryWake(rt, db, workerId, NEXT_NUDGE, "idle-no-task");
      return "woke-next";
    }
    if ((reviewTasks(db).length > 0) && w.role === "reviewer") {
      await tryWake(rt, db, workerId, REVIEW_NUDGE, "idle-no-task-review");
      return "woke-review";
    }
    return "idle-no-work";
  }

  const task = getTask(db, w.current_task_id);
  if (!task) {
    db.query(`UPDATE workers SET current_task_id = NULL, state = 'idle', updated_at = ? WHERE id = ?`).run(at, workerId);
    if (runnableTasks(db).length > 0) {
      await tryWake(rt, db, workerId, NEXT_NUDGE, "idle-task-gone");
      return "woke-next";
    }
    return "task-gone";
  }

  // Case 3: review -> worker must move on.
  if (task.state === "review") {
    await tryWake(rt, db, workerId, NEXT_NUDGE, "idle-in-review");
    return "woke-next";
  }
  // Case 4: blocked_human -> never park the worker.
  if (task.state === "blocked_human" || task.state === "blocked_internal" || task.state === "done") {
    db.query(`UPDATE workers SET current_task_id = NULL, state = 'idle', updated_at = ? WHERE id = ?`).run(at, workerId);
    if (runnableTasks(db).length > 0 || (reviewTasks(db).length > 0 && w.role === "reviewer")) {
      await tryWake(rt, db, workerId, NEXT_NUDGE, "idle-terminal-task");
      return "woke-next";
    }
    return "moved-on";
  }
  // Case 2: still running -> premature stop. Nudge to continue, unless
  // repeated idles with no progress indicate a stall.
  if (task.state === "running") {
    const idleCount = countIdleSinceProgress(db, workerId);
    if (idleCount >= 3 && at - w.last_progress_at > stallMs()) {
      if (!w.nudged_at) {
        await tryWake(rt, db, workerId, STALL_NUDGE(task.id), "idle-stall-nudge");
        db.query(`UPDATE workers SET nudged_at = ?, updated_at = ? WHERE id = ?`).run(at, at, workerId);
        return "stall-nudged";
      }
      return "stall-suspect";
    }
    await tryWake(rt, db, workerId, CONTINUE_NUDGE(task.id), "idle-premature");
    return "nudged-continue";
  }
  return "noop";
}

/** Record session.error: suspect/dead candidate, caller should reconcile immediately. */
export function handleErrorSignal(db: Database, workerId: string, error: string): string {
  const w = getWorker(db, workerId);
  if (!w) {
    logEvent(db, { source: "opencode", workerId, type: "session.error_unknown_worker", payload: { error } });
    return "unknown-worker";
  }
  touchSeen(db, workerId);
  logEvent(db, { source: "opencode", workerId, type: "session.error", payload: { error } });
  return "recorded";
}
