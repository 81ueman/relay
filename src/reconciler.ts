import type { Database } from "bun:sqlite";
import { now } from "./db";
import { countIdleSinceProgress, logEvent } from "./events";
import type { Runtime, StartedRuntime } from "./runtime/runtime";
import {
  cleanupCandidates,
  findRuntime,
  getActiveRuntime,
  getStartingRuntime,
  listRuntimes,
  markBootstrapSent,
  markRuntimeActive,
  markRuntimeCleaned,
  markRuntimeDead,
  markRuntimeStale,
  nextGeneration,
  recordRuntime,
  runtimeCleanupGraceMs,
} from "./runtimes";
import {
  idleWorkers,
  isOperationalWorker,
  isSupervisedWorker,
  needsPlanner,
  needsReviewer,
  needsWorkerWakeup,
  operationalWorkers,
  planners,
  stallMs,
  supervisedWorkers,
  supervisorView,
} from "./scheduler";
import { BOOTSTRAP_PROMPT } from "./runtime/herdr";
import type { Session } from "./sessions";
import type { WorkerRuntime } from "./schema";
import {
  approveTask,
  claimableRunnableTasks,
  defaultLeaseAlive,
  expireLeases,
  getTask,
  reviewTasks,
  unclaimableRunnableTasks,
} from "./tasks";
import { getWorker, listWorkers, setWorkerState, touchSeen, type WorkerRow } from "./workers";

// Deterministic reconciler. No LLM: pure DB state + runtime transport.
// Callers pass full Worker rows; only the Runtime adapter maps to targets.

export const NEXT_NUDGE = "Run `relay next` now. Do not wait for instructions.";
export const CONTINUE_NUDGE = (taskId: string) =>
  `Your task ${taskId} is still running. ` +
  `Continue the next concrete action. ` +
  `If blocked, explicitly block it. ` +
  `Do not wait for instructions.`;
export const STALL_NUDGE = (taskId: string) =>
  `No progress on ${taskId} for a while. If you can proceed, continue now. If you are stuck, run \`relay block ${taskId} "<reason>"\` (or --human only when a human is truly required), then run \`relay next\`.`;
export const REVIEW_NUDGE = "There are tasks waiting for review. Run `relay next` to pick one up.";
export const PLANNER_NUDGE =
  "Task queue is running low. Decompose the next objective into small tasks with acceptance criteria (relay task add), then go idle. Do not monitor other workers.";

function wakeCooldownMs(): number {
  const v = Number(process.env.RELAY_WAKE_COOLDOWN_MS ?? "30000");
  return Number.isFinite(v) && v >= 0 ? v : 30000;
}

/** How long a fresh generation may wait for managed attach before we give up. */
function attachTimeoutMs(): number {
  const v = Number(process.env.RELAY_ATTACH_TIMEOUT_MS ?? "30000");
  return Number.isFinite(v) && v > 0 ? v : 30000;
}

/** Backoff between restart attempts for the same worker (avoids tab thrash). */
function restartCooldownMs(): number {
  const v = Number(process.env.RELAY_RESTART_COOLDOWN_MS ?? "30000");
  return Number.isFinite(v) && v >= 0 ? v : 30000;
}

/** Retry interval for a bootstrap prompt that failed to be delivered. */
function bootstrapRetryMs(): number {
  const v = Number(process.env.RELAY_BOOTSTRAP_RETRY_MS ?? "5000");
  return Number.isFinite(v) && v >= 0 ? v : 5000;
}

/** At most one `worker.bootstrap_failed` event per worker per window. */
function bootstrapFailureLogWindowMs(): number {
  const v = Number(process.env.RELAY_BOOTSTRAP_LOG_WINDOW_MS ?? "60000");
  return Number.isFinite(v) && v >= 0 ? v : 60000;
}

/** At most one `runtime.cleanup_failed` event per worker per window. */
function cleanupFailureLogWindowMs(): number {
  const v = Number(process.env.RELAY_CLEANUP_LOG_WINDOW_MS ?? "60000");
  return Number.isFinite(v) && v >= 0 ? v : 60000;
}

function recentlyEvent(db: Database, workerId: string, type: string, at: number, windowMs: number): boolean {
  if (windowMs === 0) return false;
  const r = db
    .query(`SELECT COUNT(*) AS n FROM events WHERE worker_id = ? AND type = ? AND timestamp > ?`)
    .get(workerId, type, at - windowMs) as { n: number };
  return r.n > 0;
}

function recentlyWoken(db: Database, workerId: string, at: number): boolean {
  return recentlyEvent(db, workerId, "worker.woken", at, wakeCooldownMs());
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

/**
 * Workers with a fresh-generation spawn currently in flight. `restartWorker`
 * awaits the transport (`rt.start`), so a second reconcile pass (the daemon loop
 * and the immediate reconcile on `session.error`/`session.execution.failed` can
 * overlap) would otherwise read the same `MAX(generation)` and spawn a second
 * tab for the SAME generation. A per-worker in-flight guard keeps generation
 * allocation single-writer; the commit-time re-check below covers the
 * cross-process case.
 */
const restartingWorkers = new Set<string>();

/**
 * Restart = CONTROL-PLANE policy, built from transport primitives:
 *   1. mark the current generation stale (history kept; tab NOT closed here)
 *   2. best-effort interrupt the old generation
 *   3. start a FRESH relay-owned generation (rt.start) — transport ONLY
 *   4. COMMIT the runtime row + worker pointer + event log in ONE transaction
 *   5. only THEN deliver the bootstrap prompt
 * If the fresh spawn fails we keep the old runtime metadata: only runtimes that
 * are explicitly stale/dead are ever cleanup-eligible. If only the BOOTSTRAP
 * delivery fails, the generation is KEPT (runtime still `starting`, worker
 * still supervised) and retried after a cooldown — a generation is never
 * discarded because a prompt could not be delivered.
 *
 * Generation is a per-worker fencing number. Exactly one fresh generation may be
 * allocated per worker at a time: concurrent passes must not each mint the same
 * number and leave two runtime rows for it (a plugin holding the losing token
 * could then never attach). A re-entrant pass is a no-op.
 */
async function restartWorker(db: Database, rt: Runtime, w: WorkerRow, at: number): Promise<boolean> {
  if (restartingWorkers.has(w.id)) return false;
  const cooldown = restartCooldownMs();
  // Back off both after a successful spawn and after a failure: otherwise a
  // failing spawn (e.g. a stale leftover agent name) retries every tick and
  // floods worker.restart_failed.
  if (
    recentlyEvent(db, w.id, "worker.restarting", at, cooldown) ||
    recentlyEvent(db, w.id, "worker.restart_failed", at, cooldown)
  ) {
    return false; // backoff: do not spawn a new tab every tick
  }
  restartingWorkers.add(w.id);
  try {
    return await spawnFreshGeneration(db, rt, w, at);
  } finally {
    restartingWorkers.delete(w.id);
  }
}

/** The generation-allocating body of `restartWorker`; callers must hold its guard. */
async function spawnFreshGeneration(db: Database, rt: Runtime, w: WorkerRow, at: number): Promise<boolean> {
  // 1. Old generation -> stale. The tab is never closed in the restart path.
  const active = getActiveRuntime(db, w.id);
  if (active) {
    markRuntimeStale(db, active.id, at);
  } else if (w.runtime_id || w.opencode_session_id) {
    // Legacy/manual runtime without history: capture it as stale. We cannot
    // prove we created it, so relay_owned=false => it is NEVER cleaned.
    const known = listRuntimes(db, { workerId: w.id }).some(
      (r) => r.state !== "cleaned" && (r.runtime_id === w.runtime_id || (r.runtime_id === null && r.generation === w.generation))
    );
    if (!known) {
      recordRuntime(db, {
        workerId: w.id,
        generation: w.generation,
        runtimeId: w.runtime_id,
        sessionId: w.opencode_session_id,
        relayOwned: 0,
        state: "stale",
        cleanupAfter: at + runtimeCleanupGraceMs(),
      });
    }
  }

  // 2. Best-effort interrupt of the OLD generation (targets the old runtime_id,
  //    not the worker id). A gone runtime simply ignores it.
  const oldTarget = active?.runtime_id ?? w.runtime_id;
  if (oldTarget) {
    try {
      await rt.interrupt({ ...w, runtime_id: oldTarget });
    } catch { /* already dead or unreachable */ }
  }

  // 3. Fresh generation: a transport primitive, not a runtime "restart".
  const generation = nextGeneration(db, w.id, w.generation);
  let started: StartedRuntime;
  try {
    started = await rt.start(w, generation);
  } catch (e) {
    setWorkerState(db, w.id, "dead");
    logEvent(db, {
      source: "supervisor",
      workerId: w.id,
      type: "worker.restart_failed",
      payload: { generation, error: String(e).slice(0, 200) },
    });
    return false;
  }

  // 4. Durable control-plane commit BEFORE any wake/prompt. The runtime row and
  //    the worker pointer move together (one transaction), so an attach racing
  //    the bootstrap ALWAYS finds a matching relay-owned/attach_token/starting row.
  //    The transaction also RE-CHECKS the generation: `nextGeneration` was read
  //    before the awaited `rt.start`, so another writer (a second daemon) may have
  //    taken this number. If so we refuse to create a duplicate runtime row.
  const runtimeRow = db.transaction(() => {
    if (findRuntime(db, w.id, generation)) return null;
    const rr = recordRuntime(db, {
      workerId: w.id,
      generation,
      runtimeId: started.runtimeId,
      tabId: started.tabId ?? null,
      paneId: started.paneId ?? null,
      workspaceId: started.workspaceId ?? null,
      attachToken: started.attachToken ?? null,
      relayOwned: 1,
      state: "starting",
    });
    db.query(
      `UPDATE workers SET generation = ?, runtime_id = ?, opencode_session_id = NULL,
         state = 'starting', current_task_id = NULL, nudged_at = NULL, updated_at = ? WHERE id = ?`
    ).run(generation, started.runtimeId, at, w.id);
    logEvent(db, {
      source: "supervisor",
      workerId: w.id,
      type: "worker.restarting",
      payload: { generation, runtimeId: started.runtimeId, tabId: started.tabId ?? null },
    });
    return rr;
  })();

  if (!runtimeRow) {
    // The generation was taken while we were starting the transport. Abandon our
    // duplicate (never record a second row for the same generation) and reap the
    // tab we just created; the next pass mints a strictly higher number.
    logEvent(db, {
      source: "supervisor",
      workerId: w.id,
      type: "worker.restart_failed",
      payload: { generation, error: "generation already allocated" },
    });
    try {
      await rt.cleanup({
        worker_id: w.id,
        generation,
        runtime_id: started.runtimeId,
        tab_id: started.tabId ?? null,
        pane_id: started.paneId ?? null,
        relay_owned: 1,
      });
    } catch { /* orphan reap in start() is the fallback */ }
    return false;
  }

  // 5. Bootstrap AFTER the commit. A delivery failure must not abandon the
  //    generation; activatePendingRuntimes retries it after a cooldown.
  await deliverBootstrap(db, rt, w.id, generation, runtimeRow, at);
  return true;
}

/**
 * Deliver the bootstrap prompt for a freshly committed generation. The caller
 * MUST have durably recorded the runtime row first. A failed delivery is retried
 * later; it never deletes the runtime or desupervises the worker.
 */
async function deliverBootstrap(
  db: Database, rt: Runtime, workerId: string, generation: number, row: WorkerRuntime, at: number
): Promise<boolean> {
  // A tokenless generation is never attachable, so prompting it is pointless.
  if (!row.attach_token) return false;
  const worker = getWorker(db, workerId);
  if (!worker) return false;
  try {
    await rt.wake(
      { ...worker, runtime_id: row.runtime_id ?? worker.runtime_id },
      BOOTSTRAP_PROMPT(workerId, generation, row.attach_token)
    );
    markBootstrapSent(db, row.id, at);
    return true;
  } catch (e) {
    if (!recentlyEvent(db, workerId, "worker.bootstrap_failed", at, bootstrapFailureLogWindowMs())) {
      logEvent(db, {
        source: "supervisor",
        workerId,
        type: "worker.bootstrap_failed",
        payload: { generation, error: String(e).slice(0, 200) },
      });
    }
    return false;
  }
}

/**
 * Promote freshly spawned generations to active once managed attach lands, and
 * time out the ones that never attach. Keeps workers starting until then: a tab
 * existing is NOT restart success.
 */
async function activatePendingRuntimes(db: Database, rt: Runtime, actions: string[], at: number): Promise<void> {
  for (const w of listWorkers(db)) {
    if (w.state !== "starting") continue;
    // Only Relay-owned spawns are ours to promote/time out; a detached or plain
    // registered worker is never supervised.
    if (!isOperationalWorker(db, w)) continue;
    const sr = getStartingRuntime(db, w.id, w.generation);
    if (!sr) continue;

    const sess = db
      .query(`SELECT * FROM sessions WHERE worker_id = ? AND managed = 1 AND generation = ? LIMIT 1`)
      .get(w.id, w.generation) as Session | null;

    if (sess) {
      markRuntimeActive(db, sr.id, sess.session_id, at);
      db.query(
        `UPDATE workers
           SET state = 'idle', opencode_session_id = ?, updated_at = ?
         WHERE id = ?`
      ).run(sess.session_id, at, w.id);
      logEvent(db, { source: "supervisor", workerId: w.id, type: "worker.active", payload: { generation: w.generation, sessionId: sess.session_id } });
      actions.push(`active:${w.id}:g${w.generation}`);
      continue;
    }

    // No managed attach yet. If the bootstrap was never SUCCESSFULLY delivered,
    // retry it — rate-limited by the failure-event log so a flapping daemon is
    // not hammered. A successful delivery is never repeated: a prompt that was
    // delivered but never attached is handled by the attach timeout below.
    if (
      sr.bootstrap_sent_at === null &&
      !recentlyEvent(db, w.id, "worker.bootstrap_failed", at, bootstrapRetryMs())
    ) {
      await deliverBootstrap(db, rt, w.id, w.generation, sr, at);
    }

    if (at - sr.created_at > attachTimeoutMs()) {
      markRuntimeDead(db, sr.id, at);
      setWorkerState(db, w.id, "dead");
      logEvent(db, { source: "supervisor", workerId: w.id, type: "worker.attach_timeout", payload: { generation: w.generation } });
      actions.push(`attach-timeout:${w.id}`);
    }
  }
}

/**
 * Reap old generations past their grace period. Hard safety gates: never the
 * current generation, never the current runtime, only explicit stale/dead, and
 * the adapter must prove relay tab ownership. A cleanup failure only logs and
 * retries later; it must never affect task execution or fresh workers.
 */
async function cleanupOldRuntimes(db: Database, rt: Runtime, actions: string[], at: number): Promise<void> {
  for (const c of cleanupCandidates(db, at)) {
    if (c.state !== "stale" && c.state !== "dead") continue;
    if (c.relay_owned !== 1) continue; // adopted/external runtimes are never closed
    if (c.cleanup_after === null || c.cleanup_after > at) continue;

    const w = getWorker(db, c.worker_id);
    if (w) {
      if (c.generation >= w.generation) continue; // never current/newer
      if (c.runtime_id && w.runtime_id && c.runtime_id === w.runtime_id) continue; // never current runtime
    }

    try {
      await rt.cleanup(c);
      markRuntimeCleaned(db, c.id, at);
      actions.push(`cleaned:${c.worker_id}:g${c.generation}`);
    } catch (e) {
      // A repeatedly failing cleanup must not flood the event log: record the
      // failure at most once per window, but always keep the row stale so the
      // next pass retries.
      if (!recentlyEvent(db, c.worker_id, "runtime.cleanup_failed", at, cleanupFailureLogWindowMs())) {
        logEvent(db, {
          source: "supervisor",
          workerId: c.worker_id,
          type: "runtime.cleanup_failed",
          payload: { generation: c.generation, runtimeId: c.runtime_id, error: String(e).slice(0, 200) },
        });
      }
      actions.push(`cleanup-failed:${c.worker_id}:g${c.generation}`);
      // Leave it stale/dead so the next pass retries.
    }
  }
}

function autoApproveEnabled(): boolean {
  return process.env.RELAY_AUTO_APPROVE === "true";
}

export interface ReconcileResult {
  view: ReturnType<typeof supervisorView>;
  actions: string[];
}

/** One deterministic reconcile pass. Safe to run every 1-2s. */
export async function reconcile(db: Database, rt: Runtime, at = now()): Promise<ReconcileResult> {
  const actions: string[] = [];

  // 1. Expire lapsed leases first (worker crash recovery). Only a missing or
  //    not-alive assignee is requeued; a live-but-slow worker keeps its lease.
  //    The transport-dead path in step 3 still requeues a crashed worker whose
  //    DB liveness still looks fresh.
  const expired = expireLeases(db, at, defaultLeaseAlive(db, at));
  for (const t of expired) actions.push(`lease-expired:${t.id}`);

  // 2. Promote fresh generations that have completed managed attach.
  await activatePendingRuntimes(db, rt, actions, at);

  // 3. Walk workers (starting is owned by step 2).
  const stallTimeout = stallMs();

  for (const w of listWorkers(db)) {
    const fresh = getWorker(db, w.id)!;
    if (fresh.state === "starting") continue;
    // Detached / never-attached workers are NOT supervised: skip liveness
    // polling, dead detection, stall detection and restart entirely.
    if (!isSupervisedWorker(db, fresh)) continue;

    // A failed generation (dead/stalled) is recovered even if the transport
    // process is still alive: the GENERATION, not the process, is the unit of
    // recovery. This is how an attach-timeout (agent up, never attached) or a
    // stalled worker gets a fresh generation. The old tab is not closed here;
    // restartWorker marks it stale and cleanup reaps it after the grace period.
    if (fresh.state === "dead" || fresh.state === "stalled") {
      const requeued = releaseTaskOfDeadWorker(db, w.id, fresh.current_task_id, at);
      if (requeued) actions.push(`requeued:${requeued}`);
      db.query(`UPDATE workers SET current_task_id = NULL, updated_at = ? WHERE id = ?`).run(at, w.id);
      if (await restartWorker(db, rt, fresh, at)) {
        actions.push(fresh.state === "stalled" ? `stalled-restarted:${w.id}` : `restarted:${w.id}`);
      } else {
        actions.push(fresh.state === "stalled" ? `stalled:${w.id}` : `restart-skipped:${w.id}`);
      }
      continue;
    }

    const alive = await rt.isAlive(fresh).catch(() => false);

    if (!alive) {
      setWorkerState(db, w.id, "dead");
      logEvent(db, { source: "supervisor", workerId: w.id, type: "worker.dead" });
      actions.push(`dead:${w.id}`);
      // Transport is gone; restartWorker marks the old generation stale before
      // spawning fresh (old metadata is never deleted here).
      const requeued = releaseTaskOfDeadWorker(db, w.id, fresh.current_task_id, at);
      if (requeued) actions.push(`requeued:${requeued}`);
      db.query(`UPDATE workers SET current_task_id = NULL, updated_at = ? WHERE id = ?`).run(at, w.id);
      // Real recovery: spawn a fresh generation so someone can pick work up.
      if (await restartWorker(db, rt, { ...fresh, state: "dead" }, at)) {
        actions.push(`restarted:${w.id}`);
      } else {
        actions.push(`restart-skipped:${w.id}`);
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

  // 4. Core invariant: runnable work + zero working workers => wake or start someone.
  const view = supervisorView(db);

  if (needsWorkerWakeup(view)) {
    // Only wake an idle worker for runnable work it can actually claim under the
    // active role policy: never tell a role=worker pane to take a queue that is
    // entirely role=dataplane-rust. Waiting_input workers are never candidates.
    const idle = idleWorkers(db)
      .filter((c) => claimableRunnableTasks(db, c.id).length > 0)
      .sort((a, b) => a.id.localeCompare(b.id));
    let woken = false;
    for (const c of idle) {
      const full = getWorker(db, c.id)!;
      if (await tryWake(rt, db, full, NEXT_NUDGE, "no-working-worker", at)) {
        actions.push(`woken:${c.id}`);
        woken = true;
        break; // one wake per pass; the loop repeats, with cooldown rotation.
      }
    }
    if (!woken) {
      // No idle worker can take it. Recover a fallen one that could, or wait for
      // a fresh generation to finish attaching.
      const fallen = supervisedWorkers(db)
        .filter((x) => x.state === "dead" || x.state === "stalled")
        .filter((x) => claimableRunnableTasks(db, x.id).length > 0)
        .sort((a, b) => a.id.localeCompare(b.id))[0];
      const stranded = unclaimableRunnableTasks(db);
      if (fallen) {
        if (await restartWorker(db, rt, fallen, at)) actions.push(`restarted:${fallen.id}`);
        else actions.push(`restart-skipped:${fallen.id}`);
      } else if (idle.length > 0) {
        actions.push("wake-suppressed");
      } else if (operationalWorkers(db).some((x) => x.state === "starting")) {
        actions.push("awaiting-start");
      } else if (stranded.length > 0) {
        // Runnable work exists but no registered worker role can claim it: make
        // the stranded task visible instead of looping on a wake that cannot help.
        logEvent(db, {
          source: "supervisor",
          type: "supervisor.unclaimable_work",
          payload: { tasks: stranded.map((t) => ({ id: t.id, role: t.role })) },
        });
        actions.push(`unclaimable:${stranded.map((t) => t.id).join(",")}`);
      } else {
        logEvent(db, { source: "supervisor", type: "supervisor.no_idle_worker", payload: { view } });
        actions.push("no-idle-worker");
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
      for (const r of idleWorkers(db).filter((x) => x.role === "reviewer")) {
        const full = getWorker(db, r.id)!;
        if (await tryWake(rt, db, full, REVIEW_NUDGE, "review-pending", at)) actions.push(`reviewer-woken:${r.id}`);
      }
    }
  }

  if (needsPlanner(view, planners(db).length)) {
    for (const p of idleWorkers(db).filter((x) => x.role === "planner")) {
      const full = getWorker(db, p.id)!;
      if (await tryWake(rt, db, full, PLANNER_NUDGE, "queue-low", at)) actions.push(`planner-woken:${p.id}`);
    }
  }

  // 5. Reap old generations, isolated from all of the above.
  await cleanupOldRuntimes(db, rt, actions, at);

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

  // waiting_input still owns its current work: never tell it to take new work.
  if (w.state === "waiting_input") return "waiting-input";

  if (!w.current_task_id) {
    // No task + runnable work this worker can actually claim -> wake to next.
    if (claimableRunnableTasks(db, workerId).length > 0) {
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
    if (claimableRunnableTasks(db, workerId).length > 0) {
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
    if (claimableRunnableTasks(db, workerId).length > 0 || (reviewTasks(db).length > 0 && w.role === "reviewer")) {
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
