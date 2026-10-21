import type { Database } from "bun:sqlite";
import { now } from "./db";
import { logEvent } from "./events";
import { getTask, resolveHumanInterface } from "./tasks";
import { RELAY_TAG, sendMessage } from "./messages";
import type { Run, RunState } from "./schema";
import { identifyRunProcess, markRunOrphan, type OrphanIdentity } from "./factory";
import { launcherMayStillWrite } from "./run-launcher";
import { sweepOrphanedSandboxRuns } from "./sandbox-lifecycle";
import type { SbxCli } from "./sandbox";
import {
  classifyRunDeath,
  DEFAULT_RUN_FAILURE_TAIL_BYTES,
  type RunFailure,
  type RunFailureClass,
} from "./run-failure";

/**
 * ISH-1008: daemon Run liveness sweep.
 *
 * A Run's terminal state is normally written once by the coroutine that launched
 * it. If that process dies (crash, reboot, or an ENOSPC terminal write failure),
 * the durable row stays `starting`/`running` forever — the single-writer fence
 * then blocks re-entry and, worse, nobody is told the work died. Orphan
 * detection already existed for Factory adoption and the manual sandbox sweep,
 * but `reconcile()` never invoked it. This module is the periodic liveness pass.
 *
 * Safety rules (reused, never reimplemented):
 *   - the LAUNCHER must be gone before anything is declared: the child process
 *     can exit while the launching coroutine still runs `git rev-parse` or a
 *     sandbox `git fetch` before its terminal write. `launcherMayStillWrite`
 *     (PID + start token, plus an in-process active-launch registry) keeps the
 *     row live and the fence held while that coroutine may still write;
 *   - a LOCAL Run is only failed after `identifyRunProcess` proves the recorded
 *     process is dead or a reused PID (the original dsh is gone). A live PID is
 *     never signalled here, and an `undeterminable` identity keeps the fence;
 *   - a SANDBOX Run goes through `sweepOrphanedSandboxRuns({ apply: true })`,
 *     which only marks it terminal once the in-VM dsh is confirmed gone;
 *   - a `starting` row whose launch has not recorded a PID yet gets a grace
 *     window, so a sweep never races a concurrent launch.
 *
 * Every transition is `failed` with an `orphaned:` reason — never a success. The
 * cause is classified from the tail of the Run's own stderr/dsh evidence and
 * stored in `runs.error`; a `run.died` event and coordinator mail surface it.
 */

/** Durable throttle key: the last CLEAN sweep (see `maybeSweepRunLiveness`). */
export const RUN_LIVENESS_SWEPT_AT_KEY = "run_liveness_swept_at";
/** Default sweep cadence. The incident needed minutes, not a per-tick probe. */
export const DEFAULT_RUN_LIVENESS_MS = 45_000;

/** `RELAY_RUN_LIVENESS_MS` (default 45s; 0 disables throttling). */
export function runLivenessIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.RELAY_RUN_LIVENESS_MS ?? String(DEFAULT_RUN_LIVENESS_MS));
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_RUN_LIVENESS_MS;
}

/**
 * How long a `starting` row with NO recorded PID is left alone before it is
 * considered an abandoned launch. Defaults to two sweep intervals (at least 60s)
 * so a normal `insert -> spawn -> pid` window can never be swept.
 */
export function runStartGraceMs(
  intervalMs = runLivenessIntervalMs(),
  env: NodeJS.ProcessEnv = process.env
): number {
  const fallback = Math.max(60_000, intervalMs * 2);
  const v = Number(env.RELAY_RUN_START_GRACE_MS ?? String(fallback));
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export interface RunDeath {
  runId: string;
  taskId: string;
  sandbox: string | null;
  class: RunFailureClass;
  detail: string;
  reason: string;
  previousState: RunState;
}

export interface RunLivenessResult {
  /** True when the durable interval skipped this pass. */
  skipped: boolean;
  inspected: number;
  /** Runs that were (or, in a dry run, would be) failed as orphaned. */
  died: RunDeath[];
  /** Runs proven live / still fenced by an undeterminable identity. */
  live: number;
  /** Per-run soft failures. A non-empty list means the next pass must retry. */
  errors: string[];
}

export interface RunLivenessOptions {
  /** Perform the transition (default true); false is a dry run. */
  apply?: boolean;
  /** `sbx` seam for sandbox-backed Runs (default: the real CLI). */
  cli?: SbxCli;
  /** Clock seam. */
  at?: number;
  /** Throttle only (used by `maybeSweepRunLiveness`). */
  intervalMs?: number;
  /** Grace for a `starting` row that has not recorded a PID yet. */
  startGraceMs?: number;
  /** Restrict the pass to one Run (tests / a targeted operator path). */
  runId?: string;
  /** Evidence tail size (default 64 KiB). */
  tailBytes?: number;
  /**
   * Identity seam; defaults to the production `identifyRunProcess`. Tests inject
   * a deterministic identity where `ps` is unavailable, without changing the
   * production path.
   */
  identify?: (run: Pick<Run, "pid" | "spawn_lstart">) => OrphanIdentity;
}

const TERMINAL: ReadonlySet<RunState> = new Set<RunState>([
  "exited",
  "failed",
  "cancelled",
  "timeout",
  "submitted",
]);

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function withCause(base: string, failure: RunFailure): string {
  if (/(?:^|[;\s])cause=/.test(base)) return base;
  return `${base}; cause=${failure.class}: ${failure.detail}`;
}

/** The durable time of the last clean sweep (0 when none). */
export function lastRunLivenessSweepAt(db: Database): number {
  const row = db.query(`SELECT value FROM control WHERE key = ?`).get(RUN_LIVENESS_SWEPT_AT_KEY) as
    | { value: string }
    | null;
  const n = Number(row?.value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function recordRunLivenessSweepAt(db: Database, at: number): void {
  db.query(
    `INSERT INTO control (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(RUN_LIVENESS_SWEPT_AT_KEY, String(at), now());
}

/**
 * Emit the durable `run.died` event and notify the Run's responsible owner
 * (the nearest assigned ancestor or `RELAY_HUMAN`). Mail is best-effort: the
 * event is the durable record, and a disk-full failure must not undo the Run's
 * terminal state.
 */
function announceRunDeath(
  db: Database,
  run: Run,
  reason: string,
  failure: RunFailure,
  at: number,
  previousState: RunState = run.state
): void {
  const task = getTask(db, run.task_id);
  const recipient = task ? resolveHumanInterface(db, task) : null;
  let notified = false;
  if (recipient) {
    const body =
      `${RELAY_TAG}Run ${run.id} (task ${run.task_id}, ${run.phase}/${run.attempt}) DIED: ${reason}. ` +
      `Inspect with \`relay run show ${run.id}\`.`;
    try {
      sendMessage(db, "relay", recipient, body, { kind: "run_died", taskId: run.task_id });
      notified = true;
    } catch (e) {
      // The run.died event below is still written when possible; mail is a
      // secondary surface and must never crash the sweep.
      void e;
    }
  }
  logEvent(db, {
    source: "supervisor",
    taskId: run.task_id,
    type: "run.died",
    payload: {
      runId: run.id,
      taskId: run.task_id,
      sandbox: run.sandbox_name,
      class: failure.class,
      detail: failure.detail,
      reason,
      pid: run.pid,
      previousState,
      at,
      recipient,
      notified,
    },
  });
}

function deathOf(run: Run, reason: string, failure: RunFailure): RunDeath {
  return {
    runId: run.id,
    taskId: run.task_id,
    sandbox: run.sandbox_name,
    class: failure.class,
    detail: failure.detail,
    reason,
    previousState: run.state,
  };
}

/**
 * Sweep ONE non-terminal Run. Returns the death when the Run is provably gone;
 * returns null for a live/fenced Run or a launch still inside its grace window.
 */
function sweepOne(
  db: Database,
  run: Run,
  opts: Required<Pick<RunLivenessOptions, "apply" | "at" | "startGraceMs" | "tailBytes">> &
    Pick<RunLivenessOptions, "cli" | "identify">
): RunDeath | null {
  const identify = opts.identify ?? identifyRunProcess;
  const age = opts.at - run.started_at;

  // The child can be gone while the launcher is still finishing (git read/fetch
  // before its terminal write). Only a launcher that can no longer write makes
  // this row an orphan; otherwise leave it live and the fence held.
  if (launcherMayStillWrite(run)) return null;

  if (run.sandbox_name) {
    // A sandbox launch records its host `sbx exec` pid right after the Run row;
    // never sweep a just-inserted row that has not reached that point.
    if (run.pid === null && age < opts.startGraceMs) return null;
    return sweepSandboxRun(db, run, opts);
  }

  if (run.pid === null) {
    // A local launch inserts `starting` and immediately spawns; a stale row with
    // no pid after the grace window is a launch that never completed.
    if (age < opts.startGraceMs) return null;
    const failure = classifyRunDeath(run, { tailBytes: opts.tailBytes });
    const reason = withCause("orphaned: launch never recorded a pid", failure);
    if (!opts.apply) return deathOf(run, reason, failure);
    if (!markRunOrphan(db, run.id, reason, opts.at)) return null;
    announceRunDeath(db, run, reason, failure, opts.at);
    return deathOf(run, reason, failure);
  }

  const identity = identify({ pid: run.pid, spawn_lstart: run.spawn_lstart });
  if (identity === "match" || identity === "undeterminable") return null;
  // "reused" means the original dsh is gone and the recorded PID now belongs to
  // an unrelated process. It is treated like dead (the Run is over) but the
  // sweep never signals it. "dead" is simply gone.
  const base =
    identity === "reused"
      ? `orphaned: recorded pid ${run.pid} is an unrelated process (reused)`
      : `orphaned: owner pid ${run.pid} is not alive`;
  const failure = classifyRunDeath(run, { tailBytes: opts.tailBytes });
  const reason = withCause(base, failure);
  if (!opts.apply) return deathOf(run, reason, failure);
  if (!markRunOrphan(db, run.id, reason, opts.at)) return null;
  announceRunDeath(db, run, reason, failure, opts.at);
  return deathOf(run, reason, failure);
}

/**
 * Sandbox-backed Run: delegate the identity/in-VM-dsh proof to ISH-828's
 * fail-closed sweep, then annotate the durable error with the classified cause.
 * A still-alive (or `unknown`) in-VM dsh leaves the Run non-terminal, exactly as
 * the existing sweep does.
 */
function sweepSandboxRun(
  db: Database,
  run: Run,
  opts: RunLivenessOptions & {
    apply: boolean;
    at: number;
    startGraceMs: number;
    tailBytes: number;
  }
): RunDeath | null {
  let swept;
  try {
    swept = sweepOrphanedSandboxRuns(db, { apply: opts.apply, cli: opts.cli, runId: run.id });
  } catch (e) {
    // The sweep writes the terminal row BEFORE logging. If a disk-full event
    // write threw after that, finish the classified announcement from the
    // durable row instead of losing the death entirely.
    const fresh = db.query(`SELECT * FROM runs WHERE id = ?`).get(run.id) as Run | null;
    if (fresh && fresh.state === "failed" && /orphaned/i.test(fresh.error ?? "")) {
      return finishSandboxDeath(db, fresh, run.state, opts);
    }
    throw e;
  }
  const orphan = swept.orphaned[0];
  if (!orphan) return null; // host client still alive: the Run is live
  if (!orphan.resolved) return null; // in-VM dsh not confirmed gone: fence held
  if (!opts.apply) {
    const failure = classifyRunDeath(run, { tailBytes: opts.tailBytes });
    return deathOf(run, withCause(run.error ?? "orphaned", failure), failure);
  }
  const fresh = db.query(`SELECT * FROM runs WHERE id = ?`).get(run.id) as Run | null;
  if (!fresh || !TERMINAL.has(fresh.state) || fresh.state !== "failed") return null;
  return finishSandboxDeath(db, fresh, run.state, opts);
}

function finishSandboxDeath(
  db: Database,
  run: Run,
  previousState: RunState,
  opts: RunLivenessOptions & { apply: boolean; at: number; startGraceMs: number; tailBytes: number }
): RunDeath | null {
  if (run.state !== "failed") return null;
  const failure = classifyRunDeath(run, { tailBytes: opts.tailBytes });
  const base = run.error ?? "orphaned: no live sbx exec client";
  const reason = withCause(base, failure);
  if (opts.apply) {
    // The ISH-828 sweep already wrote the terminal state; only enrich the stored
    // error with the class (the write is idempotent).
    db.query(`UPDATE runs SET error = ?, updated_at = ? WHERE id = ?`).run(reason, opts.at, run.id);
    announceRunDeath(db, run, reason, failure, opts.at, previousState);
  }
  return {
    runId: run.id,
    taskId: run.task_id,
    sandbox: run.sandbox_name,
    class: failure.class,
    detail: failure.detail,
    reason,
    previousState,
  };
}

/**
 * One liveness pass. Never throws for a single Run: per-run failures are
 * collected in `errors`, so a full disk (or an `sbx` failure) cannot crash the
 * daemon or stop the remaining Runs from being inspected.
 */
export function sweepRunLiveness(db: Database, opts: RunLivenessOptions = {}): RunLivenessResult {
  const at = opts.at ?? now();
  const intervalMs = opts.intervalMs ?? runLivenessIntervalMs();
  const startGraceMs = opts.startGraceMs ?? runStartGraceMs(intervalMs);
  const tailBytes = opts.tailBytes ?? DEFAULT_RUN_FAILURE_TAIL_BYTES;
  const apply = opts.apply !== false;
  const result: RunLivenessResult = { skipped: false, inspected: 0, died: [], live: 0, errors: [] };

  let runs: Run[];
  try {
    runs = (
      opts.runId
        ? db
            .query(`SELECT * FROM runs WHERE id = ? AND state IN ('starting','running')`)
            .all(opts.runId)
        : db.query(`SELECT * FROM runs WHERE state IN ('starting','running') ORDER BY created_at ASC`).all()
    ) as Run[];
  } catch (e) {
    result.errors.push(`could not list live Runs: ${message(e)}`);
    return result;
  }

  for (const run of runs) {
    result.inspected++;
    try {
      const death = sweepOne(db, run, {
        apply,
        at,
        startGraceMs,
        tailBytes,
        cli: opts.cli,
        identify: opts.identify,
      });
      if (death) result.died.push(death);
      else result.live++;
    } catch (e) {
      result.errors.push(`run ${run.id}: ${message(e)}`);
    }
  }
  return result;
}

/**
 * Throttled pass used by `reconcile()`. The durable timestamp is only advanced
 * after a CLEAN pass: if a write failed (e.g. ENOSPC) the next reconcile tick
 * retries instead of waiting a whole interval.
 */
export function maybeSweepRunLiveness(db: Database, at = now(), opts: RunLivenessOptions = {}): RunLivenessResult {
  const intervalMs = opts.intervalMs ?? runLivenessIntervalMs();
  if (intervalMs > 0) {
    let last = 0;
    try {
      last = lastRunLivenessSweepAt(db);
    } catch {
      last = 0;
    }
    // A backwards clock never suppresses a pass.
    if (last > 0 && at >= last && at - last < intervalMs) {
      return { skipped: true, inspected: 0, died: [], live: 0, errors: [] };
    }
  }

  const result = sweepRunLiveness(db, { ...opts, at, intervalMs });
  result.skipped = false;
  if (result.errors.length === 0) {
    try {
      recordRunLivenessSweepAt(db, at);
    } catch (e) {
      result.errors.push(`could not record sweep time: ${message(e)}`);
    }
  }
  return result;
}
