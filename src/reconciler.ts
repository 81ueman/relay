import type { Database } from "bun:sqlite";
import { now } from "./db";
import { countIdleSinceProgress, logEvent } from "./events";
import type { AgentStatus, Runtime, StartedRuntime } from "./runtime/runtime";
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
  toolBackgroundMs,
  toolHardCapMs,
  toolMaxMs,
  toolNoOutputMs,
  toolStaleGraceMs,
  toolWarnMs,
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
  hasClaimableReview,
  reviewTasks,
  unclaimableRunnableTasks,
} from "./tasks";
import { getWorker, listWorkers, setWorkerState, touchSeen, clearQuiet, clearWorkerTool, quietActive, reviveFailedWorkerIfAlive, type WorkerRow } from "./workers";
import { RELAY_TAG } from "./messages";
import { immediateKindSql, mailNudgeMs, ordinaryStarvationCapMs, starvationCapMs } from "./mail-policy";

// Deterministic reconciler. No LLM: pure DB state + runtime transport.
// Callers pass full Worker rows; only the Runtime adapter maps to targets.

export const NEXT_NUDGE = "relay: Run `relay next` now. Do not wait for instructions.";
export const CONTINUE_NUDGE = (taskId: string) =>
  `relay: Your task ${taskId} is still running. ` +
  `If you are only waiting on a long-running step (a background command, build or ` +
  `test run), declare it as a bounded quiet lease: ` +
  `\`relay wait ${taskId} --for <30s|2m|1h> "<reason>"\` — then no action is needed ` +
  `until it returns. Otherwise do the next concrete action; if you are blocked, run ` +
  `\`relay block ${taskId} "<reason>"\`, then \`relay next\`.`;
export const STALL_NUDGE = (taskId: string) =>
  `relay: No progress on ${taskId} for a while. ` +
  `If you are only waiting on a long-running step, declare a bounded quiet lease: ` +
  `\`relay wait ${taskId} --for <30s|2m|1h> "<reason>"\`. ` +
  `If you are working, no action is needed; relay will check again later. ` +
  `If you are actually stuck, run \`relay block ${taskId} "<reason>"\`, then \`relay next\`.`;
export const REVIEW_NUDGE = "relay: There are tasks waiting for review. Run `relay next` to pick one up.";
/**
 * Sent AFTER the supervisor moved a hung foreground tool to the background
 * (Ctrl-B). Its job is to make the worker CHECK the command, not to assume an
 * outcome: the command is still running, so the worker inspects its output and
 * decides whether it is progressing, hung, or needs a bounded wait.
 */
export const BACKGROUND_NUDGE = (tool: string, taskId: string | null) => {
  const head =
    `relay: Your ${tool} call did not return for a while, so the supervisor moved it to the ` +
    `BACKGROUND (Ctrl-B). It is still running${taskId ? `, and your claim on ${taskId} is unchanged` : ""}.\n` +
    `CHECK IT NOW — do not re-run it in the foreground:\n` +
    `  1. Look at the command's current output/status (the background shell's captured output) and ` +
    `whether it is still producing progress.\n`;
  if (!taskId) {
    return head +
      `  2. Still progressing? Note it, then continue when it returns.\n` +
      `  3. Hung (no new output / stuck child)? Stop it, then re-run the long step in the ` +
      `background (the shell tool's \`background: true\`, or redirect to a log and poll it).\n` +
      `  4. If you are blocked, run \`relay next\` for new work.`;
  }
  return head +
    `  2. Still progressing? Declare a bounded wait: ` +
    `\`relay wait ${taskId} --for <30s|2m|1h> "<reason>"\` and continue when it returns.\n` +
    `  3. Hung (no new output / stuck child)? Stop it, then re-run the long step in the ` +
    `background (the shell tool's \`background: true\`, or redirect to a log and poll it).\n` +
    `  4. Cannot make progress or need a human? \`relay block ${taskId} "<reason>"\` ` +
    `(add \`--human\` if needed), then \`relay next\`.`;
};
export const PLANNER_NUDGE =
  "relay: Task queue is running low. Decompose the next objective into small tasks with acceptance criteria (relay task add), then go idle. Do not monitor other workers.";

function wakeCooldownMs(): number {
  const v = Number(process.env.RELAY_WAKE_COOLDOWN_MS ?? "30000");
  return Number.isFinite(v) && v >= 0 ? v : 30000;
}

/**
 * How long an undelivered message waits before its recipient is nudged, and how
 * often the nudge repeats. Long enough to let the send-time wake land first.
 */
/** How long a fresh generation may wait for managed attach before we give up. */
function attachTimeoutMs(): number {
  const v = Number(process.env.RELAY_ATTACH_TIMEOUT_MS ?? "30000");
  return Number.isFinite(v) && v > 0 ? v : 30000;
}

/**
 * Runaway-spawn guard: at most this many fresh generations per worker inside
 * the cap window. A generation that keeps stalling must not spawn forever.
 */
function restartCap(): number {
  const v = Number(process.env.RELAY_RESTART_CAP ?? "3");
  return Number.isFinite(v) && v > 0 ? v : 3;
}
function restartCapWindowMs(): number {
  const v = Number(process.env.RELAY_RESTART_CAP_WINDOW_MS ?? "1800000");
  return Number.isFinite(v) && v > 0 ? v : 1800000;
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

/**
 * T393: how recent a managed-session event must be for the worker to count as
 * ALIVE even when a transport probe (`rt.isAlive`) reports it gone. A stale
 * Herdr target after an OpenCode server restart makes the probe false while the
 * session keeps emitting; that must never be read as "crashed".
 */
function sessionLivenessMs(): number {
  const v = Number(process.env.RELAY_SESSION_LIVENESS_MS ?? "120000");
  return Number.isFinite(v) && v >= 0 ? v : 120000;
}

/**
 * Timestamp of the newest event a managed SESSION emitted for this worker, 0
 * when none. Only genuine session-origin events count — the plugin/agent stream
 * (`tool.*`, `session.idle/status`, `permission.*`, `form.*`, `session.error`)
 * — so supervisor/probe bookkeeping that merely carries `source='opencode'`
 * (e.g. `worker.status_polled` for codex) cannot fake liveness.
 */
const SESSION_LIVENESS_TYPES = [
  "tool.started",
  "tool.execute.after",
  "session.idle",
  "session.status",
  "session.error",
  "session.viewed",
  "session.heartbeat",
  "session.execution.succeeded",
  "session.execution.interrupted",
  "session.execution.failed",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
];

function lastSessionEventAt(db: Database, workerId: string): number {
  const placeholders = SESSION_LIVENESS_TYPES.map(() => "?").join(", ");
  const r = db
    .query(
      `SELECT MAX(timestamp) AS t FROM events WHERE worker_id = ? AND type IN (${placeholders})`
    )
    .get(workerId, ...SESSION_LIVENESS_TYPES) as { t: number | null };
  return r.t ?? 0;
}

/** True when the worker's SESSION emitted an event within the liveness window. */
function sessionEventFresh(db: Database, workerId: string, at: number): boolean {
  return at - lastSessionEventAt(db, workerId) <= sessionLivenessMs();
}

function recentlyWoken(db: Database, workerId: string, at: number): boolean {
  return recentlyEvent(db, workerId, "worker.woken", at, wakeCooldownMs());
}

/**
 * The newest `worker.woken` timestamp for this worker + reason (0 if never).
 * Used to wake only for CHANGES since the last wake of that reason (T345(c)),
 * instead of re-waking an idle reviewer every cooldown for unchanged work.
 */
function lastWakeAt(db: Database, workerId: string, reason: string): number {
  const r = db
    .query(`SELECT MAX(timestamp) AS t FROM events WHERE worker_id = ? AND type = 'worker.woken' AND payload_json LIKE ?`)
    .get(workerId, `%"reason":"${reason}"%`) as { t: number | null };
  return r.t ?? 0;
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
    recentlyEvent(db, w.id, "worker.restart_failed", at, cooldown) ||
    // A refused restart (adopted generation relay cannot retire) must also back
    // off, or the walk retries it every tick and floods the event log.
    recentlyEvent(db, w.id, "worker.restart_refused", at, cooldown)
  ) {
    return false; // backoff: do not spawn a new tab every tick
  }
  // Runaway guard: cap the number of fresh generations inside a window, so a
  // generation that keeps stalling cannot spawn without bound.
  const spawns = db
    .query(`SELECT COUNT(*) AS n FROM events WHERE worker_id = ? AND type = 'worker.restarting' AND timestamp > ?`)
    .get(w.id, at - restartCapWindowMs()) as { n: number };
  if (spawns.n >= restartCap()) {
    logEvent(db, {
      source: "supervisor",
      workerId: w.id,
      type: "worker.restart_capped",
      payload: { spawns: spawns.n, windowMs: restartCapWindowMs() },
    });
    return false;
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
  // 0. Only a relay-OWNED current generation may be replaced. An adopted
  //    (manual, relay_owned=0) runtime can never be closed by relay, so spawning
  //    a replacement would leave TWO live agents on the same task — the old one
  //    still editing the same files. Refuse and surface it instead of silently
  //    creating a competing agent.
  const currentRuntime = findRuntime(db, w.id, w.generation) ?? getActiveRuntime(db, w.id);
  if (!currentRuntime || currentRuntime.relay_owned !== 1) {
    logEvent(db, {
      source: "supervisor",
      workerId: w.id,
      type: "worker.restart_refused",
      payload: {
        generation: w.generation,
        relayOwned: currentRuntime?.relay_owned ?? null,
        reason: "current generation is not relay-owned (adopted); relay cannot retire it",
      },
    });
    return false;
  }

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
    // Supersede the worker's previous session explicitly: its pointer is about to
    // be nulled, so a later attach could no longer fence the old session.
    if (w.opencode_session_id) {
      db.query(
        `UPDATE sessions SET managed = 0, detached_at = ?, updated_at = ? WHERE session_id = ? AND worker_id = ?`
      ).run(at, at, w.opencode_session_id, w.id);
    }
    db.query(
      `UPDATE workers SET generation = ?, runtime_id = ?, opencode_session_id = NULL,
         state = 'starting', current_task_id = NULL, nudged_at = NULL,
         tool_name = NULL, tool_command = NULL, tool_started_at = NULL, tool_timeout_ms = NULL,
         updated_at = ? WHERE id = ?`
    ).run(generation, started.runtimeId, at, w.id);
    // A generation change is a resumed-work signal: a quiet lease never crosses it.
    if (clearQuiet(db, w.id)) {
      logEvent(db, { source: "supervisor", workerId: w.id, type: "worker.quiet_cleared", payload: { reason: "restart" } });
    }
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

/**
 * Assignees whose running task's lease has lapsed but whose Herdr agent is
 * still present. Lease expiry is CRASH recovery, but "no relay command for a
 * while" also describes a healthy worker inside one long tool call (a cargo/go
 * build can outlast the liveness grace window), and churning its task back to
 * queued mid-build loses work. The live agent is the ground truth for "not a
 * crash"; stall detection still owns "alive but stopped progressing".
 *
 * Only at-risk assignees (lease already lapsed) are probed, so this costs a few
 * Herdr queries at most, and only when something is actually about to expire.
 */
async function transportAliveAssignees(
  db: Database, rt: Runtime, at: number
): Promise<Set<string>> {
  const atRisk = db
    .query(`SELECT DISTINCT assignee FROM tasks
             WHERE state = 'running' AND lease_until IS NOT NULL AND lease_until < ?
               AND assignee IS NOT NULL`)
    .all(at) as { assignee: string }[];
  const alive = new Set<string>();
  for (const { assignee } of atRisk) {
    const w = getWorker(db, assignee);
    if (!w) continue;
    if (await rt.isAlive(w).catch(() => false)) alive.add(assignee);
  }
  return alive;
}

/**
 * Surface undelivered mail — WITHOUT interrupting active work (T329/T339).
 *
 * Policy:
 *   - A worker that is MID-TURN is never interrupted: `state='working'`, a live
 *     tool (`tool_started_at`), or a live transport saying `isWorking()` all
 *     defer the nudge (logged as `worker.mail_nudge_deferred`, cooldown-limited).
 *     A bounded QUIET lease is the worker's explicit "resume me" signal, so a
 *     quiet worker is NOT deferred.
 *   - When the worker is IDLE (turn boundary) EVERY kind is delivered: ordinary
 *     peer mail is woken with the "not urgent" text, `--urgent`/completion
 *     notices with theirs. Ordinary mail is NOT never-nudged — deferring it
 *     while busy and delivering it at idle is the whole contract (T339
 *     corrected the earlier over-fix where ordinary mail was dropped entirely).
 *   - STARVATION CAP: a continuously busy worker is nudged once anyway after the
 *     cap, so mail can never be starved by a very long turn. Ordinary mail gets a
 *     LONGER cap than actionable mail (it may legitimately wait a whole turn).
 *
 * The clocks are per-class: `oldest_immediate` / `oldest_ordinary`. A stale
 * ordinary message must never set the IMMEDIATE clock (that re-enabled mid-turn
 * interrupts), and vice-versa.
 *
 * The nudge is cooldown-limited (one per window per recipient).
 */
async function nudgeUnreadMail(
  db: Database, rt: Runtime, actions: string[], at: number
): Promise<void> {
  const window = mailNudgeMs();
  const cap = starvationCapMs();
  const ordinaryCap = ordinaryStarvationCapMs();
  const rows = db
    .query(
      `SELECT recipient, COUNT(*) AS n,
              MIN(CASE WHEN kind IN (${immediateKindSql()}) THEN created_at END) AS oldest_immediate,
              MIN(CASE WHEN kind NOT IN (${immediateKindSql()}) THEN created_at END) AS oldest_ordinary,
              SUM(CASE WHEN kind IN (${immediateKindSql()}) THEN 1 ELSE 0 END) AS immediate
         FROM messages WHERE state = 'queued'
        GROUP BY recipient`
    )
    .all() as { recipient: string; n: number; oldest_immediate: number | null; oldest_ordinary: number | null; immediate: number }[];
  if (rows.length === 0) return;
  for (const { recipient, n, oldest_immediate, oldest_ordinary, immediate } of rows) {
    const w = getWorker(db, recipient);
    if (!w || w.retired_at !== null) continue;
    if (recentlyEvent(db, recipient, "worker.mail_nudged", at, window)) continue;

    // Per-class starvation: the older of the two classes decides `stale`, each
    // against its own cap. (An idle worker nudges regardless of `stale`.)
    const staleImmediate = oldest_immediate !== null && at - oldest_immediate >= cap;
    const staleOrdinary = oldest_ordinary !== null && at - oldest_ordinary >= ordinaryCap;
    const stale = staleImmediate || staleOrdinary;

    const quiet = quietActive(w, at);
    const busy =
      !quiet &&
      (w.state === "working" ||
        w.tool_started_at !== null ||
        (typeof rt.isWorking === "function" && (await rt.isWorking(w).catch(() => false))));
    if (busy && !stale) {
      // Cooldown the DEFERRED log itself: otherwise a worker that stays busy
      // logs one event per reconcile tick (log spam).
      if (!recentlyEvent(db, recipient, "worker.mail_nudge_deferred", at, window)) {
        logEvent(db, {
          source: "supervisor", workerId: recipient, type: "worker.mail_nudge_deferred",
          payload: { recipient, count: n, immediate, reason: w.state === "working" ? "working" : w.tool_started_at !== null ? "tool" : "busy" },
        });
      }
      continue;
    }
    // The wake text must match the message: an urgent interrupt is not "not
    // urgent — finish what you are doing".
    const urgent = db
      .query(`SELECT COUNT(*) AS n FROM messages WHERE recipient = ? AND state='queued' AND kind = 'urgent'`)
      .get(recipient) as { n: number };
    const body = urgent.n > 0
      ? `${RELAY_TAG}URGENT: you have ${n} unread durable message(s) needing attention now — run \`relay inbox --claim\`.`
      : `${RELAY_TAG}You have ${n} unread durable message(s). Not urgent — finish your current step, then run \`relay inbox --claim\` at a stopping point. Relay keeps reminding you until you read it.`;
    try {
      await rt.wake(w, body);
      logEvent(db, { source: "supervisor", workerId: recipient, type: "worker.mail_nudged", payload: { recipient, count: n, starvation: busy && stale, urgent: urgent.n > 0 } });
      actions.push(`mail-nudged:${recipient}`);
    } catch (e) {
      logEvent(db, { source: "supervisor", workerId: recipient, type: "worker.wake_failed", payload: { reason: "unread-mail", error: String(e).slice(0, 200) } });
    }
  }
}

/**
 * Quiet-lease maintenance. A quiet lease is temporary metadata: clear it when it
 * is stale (the worker no longer holds that task — it can never leak onto the
 * next task) or expired, then wake the owner to resume. Durable clear BEFORE the
 * wake. Quiet does NOT suppress crash recovery (that is isAlive-based).
 */
async function processQuietLeases(
  db: Database, rt: Runtime, actions: string[], at: number
): Promise<void> {
  for (const w of listWorkers(db)) {
    if (w.quiet_until === null) continue;
    const taskId = w.quiet_task_id;
    if (taskId && taskId !== w.current_task_id) {
      clearQuiet(db, w.id);
      logEvent(db, { source: "supervisor", workerId: w.id, taskId, type: "worker.quiet_cleared", payload: { reason: "task changed" } });
      actions.push(`quiet-cleared:${w.id}`);
      continue;
    }
    if (w.quiet_until > at) continue; // still active
    clearQuiet(db, w.id);
    logEvent(db, { source: "supervisor", workerId: w.id, taskId: taskId ?? null, type: "worker.quiet_expired", payload: { task: taskId, until: w.quiet_until } });
    actions.push(`quiet-expired:${w.id}`);
    const task = taskId ? getTask(db, taskId) : null;
    if (task && task.state === "running" && task.assignee === w.id) {
      try {
        await rt.wake(w, `${RELAY_TAG}Quiet wait expired for ${taskId}. Resume the task now, check the background result, then continue, submit, or explicitly block.`);
      } catch { /* best effort; the task is still owned by a live worker */ }
    }
  }
}

/**
 * In-flight tool maintenance (EARLY DETECTION + bounded recovery).
 *
 * A running command is invisible to the stall clock: `tool.execute.after` fires
 * only when it FINISHES, and Herdr reports `working` for the whole time, so
 * `!agentBusy` is false and the reconciler neither nudges nor stalls. The
 * plugin's `tool.started` marker fills that gap. This pass:
 *   - logs `worker.tool_long` ONCE per tool (at most once per tool start) when it
 *     has been running past `RELAY_TOOL_WARN_MS`; the dashboard/status project the
 *     same marker with the command text;
 *   - clears a marker that outlived its own timeout budget (+ grace), because a
 *     lost finish event (plugin reload/crash) must not pin a worker forever;
 *   - RECOVERY: once a tool is genuinely overdue, sends Ctrl-B
 *     (`session.background`) so the blocking call moves to the background and the
 *     session unblocks, then nudges the worker to CHECK the result. This is the
 *     one deliberate transport action here; it is rate-limited to once per tool.
 *
 * A tool that declared its own `timeout` is honoured (the model asked for a long
 * budget); only an overdue one is backgrounded. `RELAY_TOOL_BACKGROUND_MS=0`
 * disables the action entirely, leaving surfacing + stale cleanup.
 */
function toolEventLogged(db: Database, workerId: string, type: string, since: number): boolean {
  const r = db
    .query(`SELECT COUNT(*) AS n FROM events WHERE worker_id = ? AND type = ? AND timestamp >= ?`)
    .get(workerId, type, since) as { n: number };
  return r.n > 0;
}

/** Past its declared budget, or past the fallback threshold when it declared none. */
function shouldBackgroundTool(w: WorkerRow, age: number): boolean {
  if (toolBackgroundMs() <= 0) return false;
  // HARD CAP (T345): never let a declared budget keep a wedged tool blocking a
  // turn longer than the cap. `cap=0` disables the cap (legacy behaviour).
  const cap = toolHardCapMs();
  if (cap > 0 && age > cap) return true;
  if (w.tool_timeout_ms != null) return age > w.tool_timeout_ms + toolStaleGraceMs();
  return age > toolBackgroundMs();
}

/**
 * A tool is OVERDUE (surface it) when it is past the warn window AND either past
 * the HARD CAP or past the no-output window while declaring a long budget. This
 * is what makes a wedged long-budget tool visible in ATTENTION instead of only
 * being recovered when its full budget elapses (T345).
 */
function toolOverdue(w: WorkerRow, age: number): boolean {
  if (age <= toolWarnMs()) return false;
  const cap = toolHardCapMs();
  if (cap > 0 && age > cap) return true;
  const noOut = toolNoOutputMs();
  if (noOut > 0 && age > noOut) return true;
  return false;
}

async function processInFlightTools(db: Database, rt: Runtime, actions: string[], at: number): Promise<void> {
  const warn = toolWarnMs();
  for (const row of listWorkers(db)) {
    if (row.tool_started_at === null) continue;
    const startedAt = row.tool_started_at;
    const age = at - startedAt;
    // A lost finish event (plugin reload/crash) must not pin a worker forever.
    // Staleness is strictly LATER than the recovery point, so an overdue tool
    // gets its Ctrl-B first and is only discarded if it outlives that too.
    const grace = toolStaleGraceMs();
    const staleAfter = row.tool_timeout_ms != null
      ? row.tool_timeout_ms + grace * 2
      : toolMaxMs() + grace;
    if (age > staleAfter) {
      clearWorkerTool(db, row.id);
      logEvent(db, {
        source: "supervisor",
        workerId: row.id,
        type: "worker.tool_stale",
        payload: { tool: row.tool_name, ageMs: age, timeoutMs: row.tool_timeout_ms },
      });
      actions.push(`tool-stale:${row.id}`);
      continue;
    }
    if (age > warn && !toolEventLogged(db, row.id, "worker.tool_long", startedAt)) {
      logEvent(db, {
        source: "supervisor",
        workerId: row.id,
        taskId: row.current_task_id,
        type: "worker.tool_long",
        payload: { tool: row.tool_name, command: row.tool_command, ageMs: age, timeoutMs: row.tool_timeout_ms },
      });
      actions.push(`tool-long:${row.id}`);
    }
    // T345: an overdue tool (past the hard cap or the no-output window) is
    // surfaced for ATTENTION even if its declared budget has not elapsed, so a
    // wedged long-budget tool is visible instead of silently blocking a task.
    if (toolOverdue(row, age) && !toolEventLogged(db, row.id, "worker.tool_overdue", startedAt)) {
      logEvent(db, {
        source: "supervisor",
        workerId: row.id,
        taskId: row.current_task_id,
        type: "worker.tool_overdue",
        payload: { tool: row.tool_name, command: row.tool_command, ageMs: age, timeoutMs: row.tool_timeout_ms, hardCapMs: toolHardCapMs() },
      });
      actions.push(`tool-overdue:${row.id}`);
    }

    // Recovery: background the blocking tool so the turn can continue. Only for
    // supervised workers, and never while blocked on a permission prompt (that
    // is not a running tool: Ctrl-B would not answer it).
    if (!isOperationalWorker(db, row)) continue;
    const w = getWorker(db, row.id)!;
    if (w.state === "waiting_input") continue;
    if (!shouldBackgroundTool(w, age)) continue;
    if (toolEventLogged(db, w.id, "worker.tool_backgrounded", startedAt)) continue;
    if (toolEventLogged(db, w.id, "worker.tool_background_failed", startedAt)) continue;

    try {
      await rt.background(w);
    } catch (e) {
      logEvent(db, {
        source: "supervisor",
        workerId: w.id,
        type: "worker.tool_background_failed",
        payload: { tool: w.tool_name, error: String(e).slice(0, 200) },
      });
      actions.push(`tool-background-failed:${w.id}`);
      continue;
    }
    logEvent(db, {
      source: "supervisor",
      workerId: w.id,
      taskId: w.current_task_id,
      type: "worker.tool_backgrounded",
      payload: { tool: w.tool_name, command: w.tool_command, ageMs: age, timeoutMs: w.tool_timeout_ms },
    });
    actions.push(`tool-backgrounded:${w.id}`);
    // T345(a): after Ctrl-B the tool no longer BLOCKS the turn, but the marker
    // would keep `tool_started_at` set forever and mask the worker as busy (so
    // idleWorkers() never treats it as available and the overdue/no-output
    // signals keep firing). Clear the marker so state and the marker AGREE — the
    // background shell is intentionally untracked (there is no finish event for
    // it); its output is the worker's own responsibility to poll.
    clearWorkerTool(db, w.id);
    // A worker left with no task is genuinely idle now: normalize it so it is
    // schedulable instead of stuck "working" with no marker.
    if (w.current_task_id === null && w.state === "working") setWorkerState(db, w.id, "idle");
    if (await tryWake(rt, db, w, BACKGROUND_NUDGE(w.tool_name ?? "tool", w.current_task_id), "tool-backgrounded", at)) {
      actions.push(`woken:${w.id}`);
    }
  }
}

/** One deterministic reconcile pass. Safe to run every 1-2s. */
export async function reconcile(db: Database, rt: Runtime, at = now()): Promise<ReconcileResult> {
  const actions: string[] = [];

  // 0. Quiet leases: clear a stale one (the worker no longer holds that task) or
  //    an expired one, then wake. Durable clear BEFORE the wake.
  await processQuietLeases(db, rt, actions, at);

  // 0b. In-flight tool telemetry: surface a long-running command early, drop
  //     markers whose finish event was lost, and background a genuinely overdue
  //     blocking tool so the session can continue.
  await processInFlightTools(db, rt, actions, at);

  // 0b. Codex workers have no plugin event stream: poll Herdr agent status for
  //     liveness/idle/blocked before the transport-dead walk below.
  await pollCodexWorkers(db, rt, at);

  // 1. Expire lapsed leases first (worker crash recovery). Only a missing or
  //    not-alive assignee is requeued; a live-but-slow worker keeps its lease.
  //    The transport-dead path in step 3 still requeues a crashed worker whose
  //    DB liveness still looks fresh.
  //    A worker whose Herdr agent is still present is alive even without a
  //    recent relay command (long build), so its lapsed lease is held, not churned.
  const transportAlive = await transportAliveAssignees(db, rt, at);
  const dbAlive = defaultLeaseAlive(db, at);
  const expired = expireLeases(db, at, (wid) => (!!wid && transportAlive.has(wid)) || dbAlive(wid));
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
      // T393: a failed-state worker whose session is still emitting managed
      // events is ALIVE (the state is a stale verdict). Revive it in place —
      // restarting would spawn a DUPLICATE generation while the live session
      // keeps running unsupervised.
      if (sessionEventFresh(db, w.id, at)) {
        reviveFailedWorkerIfAlive(db, w.id, at);
        actions.push(`revived-by-event:${w.id}`);
        continue;
      }
      const requeued = releaseTaskOfDeadWorker(db, w.id, fresh.current_task_id, at);
      if (requeued) actions.push(`requeued:${requeued}`);
      // A failed generation cannot be executing anything: drop the tool marker.
      db.query(
        `UPDATE workers SET current_task_id = NULL, tool_name = NULL, tool_command = NULL,
           tool_started_at = NULL, tool_timeout_ms = NULL, updated_at = ? WHERE id = ?`
      ).run(at, w.id);

      const cur = findRuntime(db, w.id, fresh.generation) ?? getActiveRuntime(db, w.id);
      const relayOwned = !!cur && cur.relay_owned === 1;
      if (relayOwned) {
        // Relay owns this generation: replace it with a fresh one as before.
        if (await restartWorker(db, rt, fresh, at)) {
          actions.push(fresh.state === "stalled" ? `stalled-restarted:${w.id}` : `restarted:${w.id}`);
        } else {
          actions.push(fresh.state === "stalled" ? `stalled:${w.id}` : `restart-skipped:${w.id}`);
        }
        continue;
      }

      // Adopted (relay_owned=0) runtime: relay can NEVER replace it, so restart
      // is not an option. If the transport is actually alive the worker was
      // misclassified — REVIVE it (set idle + NEXT_NUDGE). This is the only
      // recovery for an externally-owned worker; without it a transient isAlive
      // failure leaves it dead forever and it never receives a wake.
      const alive = await rt.isAlive(fresh).catch(() => false);
      if (alive) {
        if (fresh.state === "stalled") {
          try { await rt.interrupt(fresh); } catch { /* best effort */ }
        }
        setWorkerState(db, w.id, "idle");
        logEvent(db, { source: "supervisor", workerId: w.id, type: "worker.revived", payload: { was: fresh.state } });
        actions.push(`revived:${w.id}`);
        if (claimableRunnableTasks(db, w.id).length > 0) {
          const full = getWorker(db, w.id)!;
          if (await tryWake(rt, db, full, NEXT_NUDGE, "revived", at)) actions.push(`woken:${w.id}`);
        }
        continue;
      }
      // Transport gone and relay cannot replace it: surface, leave to the operator.
      actions.push(fresh.state === "stalled" ? `stalled:${w.id}` : `restart-skipped:${w.id}`);
      continue;
    }

    const alive = await rt.isAlive(fresh).catch(() => false);

    if (!alive) {
      // T393: never declare dead while the SESSION is still emitting managed
      // events. After an OpenCode/Herdr restart the transport probe can fail on
      // a stale target while the session keeps running and producing output;
      // treating that as a crash orphans its running compute AND spawns a
      // DUPLICATE generation for the same worker. Only a probe failure with NO
      // recent session output is a real crash.
      if (sessionEventFresh(db, w.id, at)) {
        if (!recentlyEvent(db, w.id, "worker.alive_by_event", at, sessionLivenessMs())) {
          logEvent(db, {
            source: "supervisor",
            workerId: w.id,
            type: "worker.alive_by_event",
            payload: { probe: "isAlive=false", taskId: fresh.current_task_id },
          });
        }
        actions.push(`alive-by-event:${w.id}`);
        continue;
      }
      setWorkerState(db, w.id, "dead");
      logEvent(db, { source: "supervisor", workerId: w.id, type: "worker.dead" });
      actions.push(`dead:${w.id}`);
      // Transport is gone; restartWorker marks the old generation stale before
      // spawning fresh (old metadata is never deleted here).
      const requeued = releaseTaskOfDeadWorker(db, w.id, fresh.current_task_id, at);
      if (requeued) actions.push(`requeued:${requeued}`);
      db.query(
        `UPDATE workers SET current_task_id = NULL, tool_name = NULL, tool_command = NULL,
           tool_started_at = NULL, tool_timeout_ms = NULL, updated_at = ? WHERE id = ?`
      ).run(at, w.id);
      // Real recovery: spawn a fresh generation so someone can pick work up.
      if (await restartWorker(db, rt, { ...fresh, state: "dead" }, at)) {
        actions.push(`restarted:${w.id}`);
      } else {
        actions.push(`restart-skipped:${w.id}`);
      }
      continue;
    }

    // Alive but DB moved on (task reassigned/completed elsewhere): resync to idle.
    // An 'idle' worker that still holds a task is included: it is the same
    // "premature stop" state (e.g. a session rebind used to force idle), and if
    // it were skipped here nothing would ever revive it.
    if (
      (fresh.state === "working" || fresh.state === "waiting_input" || fresh.state === "idle") &&
      fresh.current_task_id
    ) {
      const task = getTask(db, fresh.current_task_id);
      if (!task || (task.state !== "running" && task.state !== "review") || task.assignee !== w.id) {
        db.query(`UPDATE workers SET current_task_id = NULL, state = 'idle', updated_at = ? WHERE id = ?`).run(at, w.id);
        logEvent(db, { source: "supervisor", workerId: w.id, type: "worker.resynced", payload: { task: fresh.current_task_id } });
        actions.push(`resynced:${w.id}`);
        continue;
      }
      // Stalled: running + stale progress + process alive.
      // A lapsed lease is NOT a reason to skip the nudge: lease expiry already
      // decided ownership (a live worker keeps its task), so a live-but-quiet
      // owner must still be revived even after it stopped running relay commands.
      // An agent Herdr reports as "working" is executing right now (e.g. a long
      // benchmark inside one tool call): that is PROGRESS for the stall clock, so
      // neither nudge nor release it — no relay command is expected mid-command.
      const agentBusy = await rt.isWorking(fresh).catch(() => false);
      const quiet = quietActive(fresh, at);
      if (task.state === "running" && !agentBusy && !quiet && at - fresh.last_progress_at > stallTimeout) {
        if (!fresh.nudged_at) {
          const woke = await tryWake(rt, db, fresh, STALL_NUDGE(task.id), "stall-nudge", at);
          db.query(`UPDATE workers SET nudged_at = ?, updated_at = ? WHERE id = ?`).run(at, at, w.id);
          // Record the outcome: a failed wake is logged as worker.wake_failed and
          // must not look like a delivered nudge.
          actions.push(woke ? `nudge:${w.id}` : `nudge-failed:${w.id}`);
        } else if (at - fresh.nudged_at > stallTimeout) {
          setWorkerState(db, w.id, "stalled");
          logEvent(db, { source: "supervisor", workerId: w.id, taskId: task.id, type: "worker.stalled" });
          try { await rt.interrupt(fresh); } catch { /* best effort */ }
          db.query(
            `UPDATE tasks SET state = 'queued', assignee = NULL, lease_token = lease_token + 1, lease_until = NULL, updated_at = ? WHERE id = ?`
          ).run(at, task.id);
          db.query(`UPDATE workers SET current_task_id = NULL, nudged_at = NULL, updated_at = ? WHERE id = ?`).run(at, w.id);
          // Only a GONE agent may be replaced. Spawning while the old one is
          // still alive is what produced duplicate, competing agents.
          const gone = !(await rt.isAlive(fresh).catch(() => false));
          if (gone) {
            if (await restartWorker(db, rt, { ...fresh, state: "stalled" }, at)) {
              actions.push(`stalled-restarted:${w.id}`);
            } else {
              actions.push(`stalled:${w.id}`);
            }
          } else {
            setWorkerState(db, w.id, "idle");
            logEvent(db, { source: "supervisor", workerId: w.id, type: "worker.stall_released" });
            actions.push(`stall-released:${w.id}`);
          }
        }
      }
    }
  }

  // 4. Runnable work exists => make sure every idle worker that could take some
  //    is nudged. The old gate required `working === 0`; with a parallel fleet
  //    that is false almost always, so idle role-matched workers were skipped and
  //    their queued work sat until a human ran `relay next` (see needsWorkerWakeup).
  const view = supervisorView(db);

  if (needsWorkerWakeup(view)) {
    // Only wake an idle worker for runnable work it can actually claim under the
    // active role policy: never tell a role=worker pane to take a queue that is
    // entirely role=dataplane-rust. Waiting_input workers are never candidates.
    const idle = idleWorkers(db)
      .filter((c) => claimableRunnableTasks(db, c.id).length > 0)
      .sort((a, b) => a.id.localeCompare(b.id));
    // Wake EVERY eligible candidate, not just the first: two idle workers of the
    // same role each own a different queued task, and waking only one leaves the
    // other's work stalled. `tryWake` is the storm guard (per-worker wake
    // cooldown), so this stays one wake per worker, not one wake per tick.
    let woken = false;
    await Promise.all(
      idle.map(async (c) => {
        const full = getWorker(db, c.id)!;
        if (await tryWake(rt, db, full, NEXT_NUDGE, "no-working-worker", at)) {
          actions.push(`woken:${c.id}`);
          woken = true;
        }
      })
    );
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
      // T345(c): wake an idle reviewer only when there is review work it has NOT
      // been woken about yet. Without this, an idle reviewer is re-woken every
      // wake-cooldown (30s) for as long as anything sits in review — pure churn.
      // We compare the newest review-task change against the last review wake.
      const newestReviewAt = reviewTasks(db).reduce((max, t) => Math.max(max, t.updated_at), 0);
      for (const r of idleWorkers(db).filter((x) => x.role === "reviewer")) {
        const full = getWorker(db, r.id)!;
        const lastWake = lastWakeAt(db, r.id, "review-pending");
        if (newestReviewAt <= lastWake) continue; // already told about this work
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

  // 5. Nudge recipients with undelivered mail (a durable safety net for a missed
  //    send-time wake; peer messages and completion notices alike).
  await nudgeUnreadMail(db, rt, actions, at);

  // 6. Reap old generations, isolated from all of the above.
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
  // A session-idle turn-complete means no tool is executing any more: drop the
  // in-flight marker even if its `tool.execute.after` was lost.
  clearWorkerTool(db, workerId);
  logEvent(db, { source: "opencode", workerId, type: "session.idle" });

  // waiting_input still owns its current work: never tell it to take new work.
  if (w.state === "waiting_input") return "waiting-input";

  if (!w.current_task_id) {
    // No task + runnable work this worker can actually claim -> wake to next.
    if (claimableRunnableTasks(db, workerId).length > 0) {
      await tryWake(rt, db, w, NEXT_NUDGE, "idle-no-task", at);
      return "woke-next";
    }
    if (hasClaimableReview(db) && w.role === "reviewer") {
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
    if (claimableRunnableTasks(db, workerId).length > 0 || (hasClaimableReview(db) && w.role === "reviewer")) {
      await tryWake(rt, db, fresh, NEXT_NUDGE, "idle-terminal-task", at);
      return "woke-next";
    }
    return "moved-on";
  }
  if (task.state === "running") {
    // A bounded quiet lease makes a deliberate session-idle intentional: no
    // nudge, no idle marking, no stall.
    if (quietActive(w, at)) return "quiet";
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

export async function pollCodexWorker(db: Database, rt: Runtime, workerId: string, at = now()): Promise<string> {
  const w = getWorker(db, workerId);
  if (!w) return "unknown-worker";
  if (w.agent_kind !== "codex") return "not-codex";
  if (typeof rt.agentStatus !== "function") return "unsupported";
  const status = await rt.agentStatus(w).catch(() => "unknown" as AgentStatus);
  logEvent(db, { source: "opencode", workerId, type: "worker.status_polled", payload: { status } });

  if (status === "dead") {
    setWorkerState(db, workerId, "dead");
    logEvent(db, { source: "supervisor", workerId, type: "worker.dead" });
    return "dead";
  }
  if (status === "working") {
    touchSeen(db, workerId, at); // executing right now = progress
    return "working";
  }
  if (status === "blocked") {
    touchSeen(db, workerId, at);
    if (w.state === "working" || w.state === "idle") setWorkerState(db, workerId, "waiting_input");
    return "blocked";
  }
  if (status === "idle") {
    touchSeen(db, workerId, at);
    // The idle transition (clear a stale tool marker, nudge to the next task or
    // continue a running one) is the same machine an idle event runs. It is
    // idempotent: a worker that already moved on yields "idle-no-work".
    return await handleIdleSignal(db, rt, workerId, at);
  }
  return "unknown";
}

/**
 * Poll every managed codex worker. Codex has no plugin event stream, so this is
 * its liveness/idle source; opencode workers are untouched.
 */
async function pollCodexWorkers(db: Database, rt: Runtime, at: number): Promise<void> {
  for (const w of listWorkers(db)) {
    if (w.agent_kind !== "codex") continue;
    if (!isSupervisedWorker(db, w)) continue;
    await pollCodexWorker(db, rt, w.id, at).catch(() => "poll-error");
  }
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
