import type { Database } from "bun:sqlite";
import { now } from "./db";
import { countIdleSinceProgress, logEvent } from "./events";
import type { Runtime } from "./runtime/runtime";
import {
  needsPlanner,
  needsReviewer,
  needsWorkerWakeup,
  planners,
  reviewers,
  stallMs,
  supervisorView,
  wakeableWorkers,
} from "./scheduler";
import { approveTask, expireLeases, getTask, reviewTasks, runnableTasks } from "./tasks";
import { getWorker, listWorkers, setWorkerState, touchSeen, type WorkerRow } from "./workers";

// Deterministic reconciler. No LLM: pure DB state + runtime transport.
// Callers pass full Worker rows; only the Runtime adapter maps to targets.

export const NEXT_NUDGE = "Run `agentctl next` now. Do not wait for instructions.";
export const CONTINUE_NUDGE = (taskId: string) =>
  `Your task ${taskId} is still running. ` +
  `Continue the next concrete action. ` +
  `If blocked, explicitly block it. ` +
  `Do not wait for instructions.`;
export const STALL_NUDGE = (taskId: string) =>
  `No progress on ${taskId} for a while. If you can proceed, continue now. If you are stuck, run \`agentctl block ${taskId} "<reason>"\` (or --human only when a human is truly required), then run \`agentctl next\`.`;
export const REVIEW_NUDGE = "There are tasks waiting for review. Run `agentctl next` to pick one up.";
export const PLANNER_NUDGE =
  "Task queue is running low. Decompose the next objective into small tasks with acceptance criteria (agentctl task add), then go idle. Do not monitor other workers.";

function wakeCooldownMs(): number {
  const v = Number(process.env.AGENTCTL_WAKE_COOLDOWN_MS ?? "30000");
  return Number.isFinite(v) && v >= 0 ? v : 30000;
}

function recentlyWoken(db: Database, workerId: string, at: number): boolean {
  const cd = wakeCooldownMs();
  if (cd === 0) return false;
  const r = db
    .query(`SELECT COUNT(*) AS n FROM events WHERE worker_id = ? AND type = 'worker.woken' AND timestamp > ?`)
    .get(workerId, at - cd) as { n: number };
  return r.n > 0;
}

async function tryWake(
  rt: Runtime, db: Database, w: WorkerRow, text: string, reason: string, at = now()
): Promise<boolean> {
  if (recentlyWoken(db, w.id, at)) return false;
  try {
    await rt.wake(w, text);
    logEvent(db, { source: "supervisor", workerId: w.id, type: "worker.woken", payload: { reason } });
    return true;
  } catch (e) {
    logEvent(db, { source: "supervisor", workerId: w.id, type: "worker.wake_failed", payload: { reason, error: String(e).slice(0, 200) } });
    return false;
  }
}

/** Mark a worker dead, release its task to queued with a bumped token. */
function releaseTaskOfDeadWorker(db: Database, workerId: string, taskId: string | null, at: number): string | null {
  if (!taskId) return null;
  const task = getTask(db, taskId);
  if (task && task.state === "running") {
    db.query(
      `UPDATE tasks SET state = 'queued', assignee = NULL, lease_token = lease_token + 1, lease_until = NULL, updated_at = ? WHERE id = ?`
    ).run(at, task.id);
    logEvent(db, { source: "supervisor", workerId, taskId: task.id, type: "task.requeued_dead_worker" });
    return task.id;
  }
  return null;
}

/** Restart a dead worker via a real fresh generation. Returns true when reachable again. */
async function restartWorker(db: Database, rt: Runtime, w: WorkerRow, at: number): Promise<boolean> {
  setWorkerState(db, w.id, "restarting");
  try {
    const target = await rt.restart(w);
    db.query(
      `UPDATE workers SET runtime_id = ?, generation = generation + 1, state = 'starting',
        current_task_id = NULL, nudged_at = NULL, updated_at = ? WHERE id = ?`
    ).run(target, at, w.id);
    logEvent(db, { source: "supervisor", workerId: w.id, type: "worker.restarted", payload: { target } });
    return true;
  } catch (e) {
    setWorkerState(db, w.id, "dead");
    logEvent(db, { source: "supervisor", workerId: w.id, type: "worker.restart_failed", payload: { error: String(e).slice(0, 200) } });
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
  const stallTimeout = stallMs();

  for (const w of listWorkers(db)) {
    const alive = await rt.isAlive(w).catch(() => false);
    const fresh = getWorker(db, w.id)!;

    if (!alive) {
      if (fresh.state !== "dead") {
        setWorkerState(db, w.id, "dead");
        logEvent(db, { source: "supervisor", workerId: w.id, type: "worker.dead" });
        actions.push(`dead:${w.id}`);
      }
      const requeued = releaseTaskOfDeadWorker(db, w.id, fresh.current_task_id, at);
      if (requeued) actions.push(`requeued:${requeued}`);
      db.query(`UPDATE workers SET current_task_id = NULL, updated_at = ? WHERE id = ?`).run(at, w.id);
      // Real recovery: spawn a fresh generation so someone can pick work up.
      if (await restartWorker(db, rt, { ...fresh, state: "dead" }, at)) {
        actions.push(`restarted:${w.id}`);
      } else {
        actions.push(`restart-failed:${w.id}`);
      }
      continue;
    }

    // Alive but DB moved on (task reassigned/completed elsewhere): resync to idle.
    if ((fresh.state === "working" || fresh.state === "waiting_input") && fresh.current_task_id) {
      const task = getTask(db, fresh.current_task_id);
      if (!task || (task.state !== "running" && task.state !== "review") || task.assignee !== w.id) {
        db.query(`UPDATE workers SET current_task_id = NULL, state = 'idle', updated_at = ? WHERE id = ?`).run(at, w.id);
        logEvent(db, { source: "supervisor", workerId: w.id, type: "worker.resynced", payload: { task: fresh.current_task_id } });
        actions.push(`resynced:${w.id}`);
        continue;
      }
      // Stalled: running + valid lease + stale progress + process alive.
      if (task.state === "running" && (task.lease_until ?? 0) >= at && at - fresh.last_progress_at > stallTimeout) {
        if (!fresh.nudged_at) {
          await tryWake(rt, db, fresh, STALL_NUDGE(task.id), "stall-nudge", at);
          db.query(`UPDATE workers SET nudged_at = ?, updated_at = ? WHERE id = ?`).run(at, at, w.id);
          actions.push(`nudge:${w.id}`);
        } else if (at - fresh.nudged_at > stallTimeout) {
          setWorkerState(db, w.id, "stalled");
          logEvent(db, { source: "supervisor", workerId: w.id, taskId: task.id, type: "worker.stalled" });
          try { await rt.interrupt(fresh); } catch { /* best effort */ }
          db.query(
            `UPDATE tasks SET state = 'queued', assignee = NULL, lease_token = lease_token + 1, lease_until = NULL, updated_at = ? WHERE id = ?`
          ).run(at, task.id);
          db.query(`UPDATE workers SET current_task_id = NULL, nudged_at = NULL, updated_at = ? WHERE id = ?`).run(at, w.id);
          if (await restartWorker(db, rt, { ...fresh, state: "stalled" }, at)) {
            actions.push(`stalled-restarted:${w.id}`);
          } else {
            actions.push(`stalled:${w.id}`);
          }
        }
      }
    }
  }

  // 3. Core invariant: runnable work + zero working workers => wake or start someone.
  const view = supervisorView(db);

  if (needsWorkerWakeup(view)) {
    const candidates = wakeableWorkers(db).sort((a, b) => a.id.localeCompare(b.id));
    let woken = false;
    for (const c of candidates) {
      const full = getWorker(db, c.id)!;
      if (await tryWake(rt, db, full, NEXT_NUDGE, "no-working-worker", at)) {
        actions.push(`woken:${c.id}`);
        woken = true;
        break; // one wake per pass; the loop repeats, with cooldown rotation.
      }
    }
    if (!woken) {
      // Nobody wakeable (all dead/stalled): restart one so work can move.
      const fallen = listWorkers(db)
        .filter((x) => x.state === "dead" || x.state === "stalled" || x.state === "restarting")
        .sort((a, b) => a.id.localeCompare(b.id))[0];
      if (fallen) {
        if (await restartWorker(db, rt, fallen, at)) actions.push(`restarted:${fallen.id}`);
        else actions.push(`restart-failed:${fallen.id}`);
      } else {
        logEvent(db, { source: "supervisor", type: "supervisor.no_workers", payload: { view } });
        actions.push("no-workers");
      }
    }
  }

  if (needsReviewer(view)) {
    if (autoApproveEnabled()) {
      for (const t of reviewTasks(db)) {
        approveTask(db, t.id, "supervisor");
        actions.push(`auto-approved:${t.id}`);
      }
    } else {
      for (const r of reviewers(db).filter((x) => x.state === "idle" || x.state === "starting")) {
        const full = getWorker(db, r.id)!;
        if (await tryWake(rt, db, full, REVIEW_NUDGE, "review-pending", at)) actions.push(`reviewer-woken:${r.id}`);
      }
    }
  }

  if (needsPlanner(view)) {
    for (const p of planners(db).filter((x) => x.state === "idle" || x.state === "starting")) {
      const full = getWorker(db, p.id)!;
      if (await tryWake(rt, db, full, PLANNER_NUDGE, "queue-low", at)) actions.push(`planner-woken:${p.id}`);
    }
  }

  return { view: supervisorView(db), actions };
}

/**
 * Handle a session.idle signal from a MANAGED session.
 * Idle is NEVER task completion: inspect the DB and nudge via the real runtime.
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
    // No task + runnable work -> wake to next.
    if (runnableTasks(db).length > 0) {
      await tryWake(rt, db, w, NEXT_NUDGE, "idle-no-task", at);
      return "woke-next";
    }
    if (reviewTasks(db).length > 0 && w.role === "reviewer") {
      await tryWake(rt, db, w, REVIEW_NUDGE, "idle-no-task-review", at);
      return "woke-review";
    }
    return "idle-no-work";
  }

  const task = getTask(db, w.current_task_id);
  if (!task) {
    db.query(`UPDATE workers SET current_task_id = NULL, state = 'idle', updated_at = ? WHERE id = ?`).run(at, workerId);
    if (runnableTasks(db).length > 0) {
      const fresh = getWorker(db, workerId)!;
      await tryWake(rt, db, fresh, NEXT_NUDGE, "idle-task-gone", at);
      return "woke-next";
    }
    return "task-gone";
  }

  if (task.state === "review" || task.state === "done") {
    const fresh0 = getWorker(db, workerId)!;
    await tryWake(rt, db, fresh0, NEXT_NUDGE, "idle-in-review", at);
    return "woke-next";
  }
  if (task.state === "blocked_human" || task.state === "blocked_internal") {
    // A human-blocked task never parks the worker: release + move on.
    db.query(`UPDATE workers SET current_task_id = NULL, state = 'idle', updated_at = ? WHERE id = ?`).run(at, workerId);
    const fresh = getWorker(db, workerId)!;
    if (runnableTasks(db).length > 0 || (reviewTasks(db).length > 0 && w.role === "reviewer")) {
      await tryWake(rt, db, fresh, NEXT_NUDGE, "idle-terminal-task", at);
      return "woke-next";
    }
    return "moved-on";
  }
  if (task.state === "running") {
    // Premature stop until proven otherwise: continue-nudge first.
    // Stalled verdicts need process-alive + stale progress + repeated idle
    // (handled by the reconciler pass, never by idle alone).
    const idleCount = countIdleSinceProgress(db, workerId);
    if (idleCount >= 3 && at - w.last_progress_at > stallMs()) {
      if (!w.nudged_at) {
        await tryWake(rt, db, w, STALL_NUDGE(task.id), "idle-stall-nudge", at);
        db.query(`UPDATE workers SET nudged_at = ?, updated_at = ? WHERE id = ?`).run(at, at, workerId);
        return "stall-nudged";
      }
      return "stall-suspect";
    }
    await tryWake(rt, db, w, CONTINUE_NUDGE(task.id), "idle-premature", at);
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
