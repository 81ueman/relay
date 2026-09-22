import type { Database } from "bun:sqlite";
import { findRuntime, getStartingRuntime } from "./runtimes";
import { getSession } from "./sessions";
import { claimableReviews, reviewTasks, runnableTasks, taskCounts, unclaimableRunnableTasks, unfinishedCount } from "./tasks";
import { listWorkers, type WorkerRow } from "./workers";

export function stallMs(): number {
  const v = Number(process.env.RELAY_STALL_MS ?? "60000");
  return Number.isFinite(v) && v > 0 ? v : 60000;
}

/**
 * Early-detection threshold for an in-flight tool (`workers.tool_started_at`).
 * Past this age relay logs `worker.tool_long` once and the dashboard/status
 * surface the running command — BEFORE the stall clock (which is blind while
 * Herdr reports `working`). This is a SURFACING threshold, not a state change:
 * relay does not nudge, interrupt or requeue because of it.
 *
 * Deliberately below OpenCode's 120s default `shell` timeout: the point is to
 * see the command (and, once a budget is known, that it is overdue) while it is
 * still running, not after the tool has already returned.
 */
export function toolWarnMs(): number {
  const v = Number(process.env.RELAY_TOOL_WARN_MS ?? "60000");
  return Number.isFinite(v) && v >= 0 ? v : 60000;
}

/**
 * Fallback budget when a tool reports no timeout. Used only to decide when an
 * in-flight marker is STALE because its finish event was lost (plugin reload /
 * crash), so a missed `tool.execute.after` cannot pin a worker forever. It is
 * not a kill deadline.
 */
export function toolMaxMs(): number {
  const v = Number(process.env.RELAY_TOOL_MAX_MS ?? "3600000");
  return Number.isFinite(v) && v > 0 ? v : 3600000;
}

/** Grace beyond a tool's own timeout before its marker is treated as stale. */
export function toolStaleGraceMs(): number {
  const v = Number(process.env.RELAY_TOOL_STALE_GRACE_MS ?? "60000");
  return Number.isFinite(v) && v >= 0 ? v : 60000;
}

/**
 * When to take the RECOVERY action for a hung foreground tool: send Ctrl-B
 * (`session.background`) so the blocking call moves to the background and the
 * session unblocks. This is the step past mere surfacing.
 *
 * A tool that declared its own `timeout` (the model asked for a long budget) is
 * left alone until it is OVERDUE by `toolStaleGraceMs()`; only a tool with no
 * declared budget falls back to this threshold. `0` disables the action.
 */
export function toolBackgroundMs(): number {
  const v = Number(process.env.RELAY_TOOL_BACKGROUND_MS ?? "180000");
  return Number.isFinite(v) && v >= 0 ? v : 180000;
}

/**
 * HARD CAP (T345): the absolute longest a foreground tool may block a turn,
 * regardless of the budget it declared. A tool that declared a long timeout but
 * is wedged (no output, no finish) is backgrounded once it reaches this, so a
 * blocking call cannot hold a worker (and the task behind it) for its whole
 * declared budget. `0` disables the cap.
 */
export function toolHardCapMs(): number {
  const v = Number(process.env.RELAY_TOOL_HARD_CAP_MS ?? "900000");
  return Number.isFinite(v) && v >= 0 ? v : 900000;
}

/**
 * A long-budget tool that has produced NO output for this long is treated as
 * WEDGED and surfaced as overdue (ATTENTION) even before the hard cap — a
 * budget is an intent, not evidence of progress. `0` disables the signal.
 */
export function toolNoOutputMs(): number {
  const v = Number(process.env.RELAY_TOOL_NO_OUTPUT_MS ?? "600000");
  return Number.isFinite(v) && v >= 0 ? v : 600000;
}

/**
 * Model context-window size used to turn `context_used_tokens` into a percent.
 * The managed model (`deepseek-v4.1-flash`) tops out at 1,000,000 tokens.
 * Overridable so a different model's limit does not require a code change.
 */
export function contextLimitTokens(): number {
  const v = Number(process.env.RELAY_CONTEXT_LIMIT_TOKENS ?? "1000000");
  return Number.isFinite(v) && v > 0 ? v : 1000000;
}

/**
 * Cooperative-handoff threshold as a percentage of the context limit. Past this
 * the worker is asked to checkpoint and is rotated to a fresh generation at a
 * task boundary. 80% leaves headroom before the ~91% degeneration observed live.
 */
export function contextRotatePercent(): number {
  const v = Number(process.env.RELAY_CONTEXT_ROTATE_PCT ?? "80");
  return Number.isFinite(v) && v > 0 && v <= 100 ? v : 80;
}

/**
 * Minimum spacing between cooperative rotations of the same worker. Guards
 * against a rotation storm if the fresh generation's first context reading is
 * somehow already high (e.g. a resumed/compacted prompt).
 */
export function contextRotateCooldownMs(): number {
  const v = Number(process.env.RELAY_CONTEXT_ROTATE_COOLDOWN_MS ?? "900000");
  return Number.isFinite(v) && v >= 0 ? v : 900000;
}

/**
 * How long to wait after the checkpoint directive for the worker to reach a turn
 * boundary before rotating anyway. A worker that owns a running task may never
 * report idle, so the grace is the fallback that guarantees the handoff happens.
 */
export function contextRotateGraceMs(): number {
  const v = Number(process.env.RELAY_CONTEXT_ROTATE_GRACE_MS ?? "180000");
  return Number.isFinite(v) && v >= 0 ? v : 180000;
}

/** Context occupancy of a worker as a percentage of the model limit (0 when unknown). */
export function contextPercent(w: WorkerRow): number {
  const used = w.context_used_tokens;
  if (used === null || used === undefined || !Number.isFinite(used) || used <= 0) return 0;
  return (used / contextLimitTokens()) * 100;
}

/**
 * Pure cooperative-handoff predicate: is this worker's context over the
 * threshold AND not inside a rotation cooldown, AND has a FRESH metric arrived
 * since the last rotation?
 *
 * The "fresh metric" condition is what stops an immediate re-request after a
 * rotation: the metric that triggered the rotation is cleared by
 * `setWorkerContextRotated`, and `context_rotated_at` fences any older reading
 * that might still be flushed by the superseded session.
 */
export function needsContextRotation(w: WorkerRow, at = Date.now()): boolean {
  if (contextPercent(w) < contextRotatePercent()) return false;
  if (w.context_rotated_at !== null) {
    if (at - w.context_rotated_at < contextRotateCooldownMs()) return false;
    if ((w.context_updated_at ?? 0) <= w.context_rotated_at) return false;
  }
  return true;
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
  /** Reviews a reviewer could actually take (not held by a live reviewer). */
  claimableReview: number;
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
    claimableReview: claimableReviews(db).length,
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
  // Eligibility-aware (T346): only nudge when a reviewer could ACTUALLY claim a
  // review. A review held by a live, actively-working reviewer is not up for
  // grabs, so waking idle reviewers for it is churn (they get NO_TASK).
  return v.claimableReview > 0;
}
