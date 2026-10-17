import type { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { now } from "./db";
import { logEvent } from "./events";
import { getTask } from "./tasks";
import { isTerminalTaskState } from "./schema";
import { childEnv } from "./child-env";

/**
 * ISH-845 — Task-owned external Lab cleanup.
 *
 * A coding Task may deploy an arbitrary containerlab topology on the shared
 * Network Lab. Relay does NOT model networks, NOS or topologies; it knows only
 * two things:
 *
 *   1. the Task's **owner identifier** — a stable string derived from the Task
 *      (`labOwnerId`), injected into the Coding Sandbox as `RELAY_LAB_OWNER` and
 *      used by the `network-lab` skill as the lab `--namespace` and `name:`; and
 *   2. that a cleanup is due **when the Task ends** (merged or explicitly
 *      aborted) — never merely because it reached `merge_ready`.
 *
 * The teardown itself is a single **trusted, pre-configured hook**:
 * `RELAY_LAB_CLEANUP_CMD`. Relay runs exactly `[cmd, ownerId]` — a fixed
 * executable with the owner id as its only argument. It never shells out
 * through a shell, never interpolates the Task prompt (or any URL/command taken
 * from a Run), and never grows a generic plugin registry or resident daemon.
 * The hook enumerates and destroys only the labs bound to that owner id.
 *
 * There is deliberately no `relay lab` command and no network-specific Task
 * schema.
 */

/** The env var holding the single trusted cleanup hook (an executable path). */
export const LAB_CLEANUP_ENV = "RELAY_LAB_CLEANUP_CMD";
/** Optional hook timeout in ms (default {@link DEFAULT_LAB_CLEANUP_TIMEOUT_MS}). */
export const LAB_CLEANUP_TIMEOUT_ENV = "RELAY_LAB_CLEANUP_TIMEOUT_MS";
export const DEFAULT_LAB_CLEANUP_TIMEOUT_MS = 120_000;

/**
 * The Task's external Lab owner identifier. Deterministic and Task-unique: two
 * Tasks can never share an owner id, so a cleanup for one Task can never name —
 * let alone destroy — another Task's Lab. This is the only "registration":
 * Relay already holds the Task id, and the sandbox learns the same value as
 * `RELAY_LAB_OWNER`.
 */
export function labOwnerId(taskId: string): string {
  return taskId;
}

export interface LabCleanupResult {
  ok: boolean;
  code: number | null;
  out: string;
  err: string;
  /** The hook was killed after the timeout. */
  timedOut: boolean;
}

export interface LabCleanupRunOptions {
  timeoutMs?: number;
  /** Extra environment for the hook (never the whole host env by default). */
  env?: Record<string, string>;
}

/** Injectable seam for the fixed hook process (tests use a fake). */
export interface LabCleanupRunner {
  run(argv: string[], opts?: LabCleanupRunOptions): LabCleanupResult;
}

export const realLabCleanupRunner: LabCleanupRunner = {
  run(argv, opts = {}) {
    const [cmd, ...args] = argv;
    try {
      const out = execFileSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: opts.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: childEnv(process.env, opts.env ?? {}),
      });
      return { ok: true, code: 0, out: out ?? "", err: "", timedOut: false };
    } catch (e) {
      const err = e as { status?: number | null; signal?: string | null; killed?: boolean; message?: string; stdout?: unknown; stderr?: unknown };
      const timedOut = err.signal === "SIGTERM" || err.killed === true || /timed? ?out/i.test(err.message ?? "");
      return {
        ok: false,
        code: typeof err.status === "number" ? err.status : null,
        out: String(err.stdout ?? ""),
        err: String(err.stderr ?? err.message ?? "hook failed"),
        timedOut,
      };
    }
  },
};

export type LabCleanupStatus = "skipped" | "dry-run" | "ok" | "failed" | "timeout";

export interface LabCleanupOptions {
  /** Actually run the hook (default: plan only). */
  apply?: boolean;
  /** Explicit abort reason: cleanup without a real merge. */
  abort?: string;
  /** Override the configured hook (defaults to $RELAY_LAB_CLEANUP_CMD). */
  cmd?: string;
  timeoutMs?: number;
  runner?: LabCleanupRunner;
}

export interface LabCleanupPlan {
  taskId: string;
  ownerId: string;
  /** The configured hook command, or null when none is configured. */
  cmd: string | null;
  /** True when the Task has ended and a hook is configured. */
  remove: boolean;
  apply: boolean;
  reasons: string[];
  /** True when the hook ran and exited 0. */
  cleaned: boolean;
  status: LabCleanupStatus;
  exitCode: number | null;
  error: string | null;
}

function configuredCmd(opts: LabCleanupOptions): string | null {
  const raw = (opts.cmd ?? process.env[LAB_CLEANUP_ENV] ?? "").trim();
  return raw.length > 0 ? raw : null;
}

/**
 * Decide whether the Task's Lab cleanup is due, WITHOUT running anything.
 *
 * Mirrors the worktree/sandbox cleanup guards: the Task must have really ended
 * (merged, or an explicit `--abort`). A Task parked at `merge_ready` has NOT
 * ended and is refused, and a Task with no configured hook is a pure no-op —
 * a Lab-unused Task therefore causes no subprocess and no external call.
 */
export function planLabCleanup(db: Database, taskId: string, opts: LabCleanupOptions = {}): LabCleanupPlan {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  const cmd = configuredCmd(opts);
  const reasons: string[] = [];
  const plan: LabCleanupPlan = {
    taskId,
    ownerId: labOwnerId(task.id),
    cmd,
    remove: false,
    apply: opts.apply === true,
    reasons,
    cleaned: false,
    status: "skipped",
    exitCode: null,
    error: null,
  };
  if (!cmd) {
    reasons.push(`no ${LAB_CLEANUP_ENV} configured (no external Lab cleanup hook)`);
    return plan;
  }

  const merged = task.merged_at !== null;
  const aborted = !!opts.abort;
  if (!merged && !aborted) {
    if (!isTerminalTaskState(task.state)) {
      reasons.push(`task has not ended (state=${task.state}${task.phase ? `, phase=${task.phase}` : ""})`);
    } else {
      reasons.push("task is terminal but not merged; pass --abort <reason> to reclaim its Lab");
    }
  }
  if (task.pr_url && !merged && !aborted) reasons.push(`open PR ${task.pr_url}`);

  plan.remove = reasons.length === 0;
  plan.status = plan.remove ? "dry-run" : "skipped";
  return plan;
}

/**
 * Run (with `apply`) the single trusted hook for exactly this Task's owner id.
 *
 * The hook is always invoked as `[cmd, ownerId]` — the owner id is the only
 * argument, so a hook can never be pointed at another Task's Lab. A non-zero
 * exit, a spawn failure or a timeout is RECORDED (an event) and reported,
 * never thrown: the Lab cleanup is re-runnable by simply invoking cleanup
 * again, and a failure must not abort the rest of Task teardown.
 */
export function applyLabCleanup(db: Database, taskId: string, opts: LabCleanupOptions = {}): LabCleanupPlan {
  const plan = planLabCleanup(db, taskId, opts);
  if (!plan.apply) return plan;
  if (!plan.remove || !plan.cmd) {
    logEvent(db, {
      source: "lab-cleanup",
      taskId,
      type: "lab.cleanup_skipped",
      payload: { ownerId: plan.ownerId, cmd: plan.cmd, reasons: plan.reasons },
    });
    return plan;
  }

  const runner = opts.runner ?? realLabCleanupRunner;
  const timeoutMs = opts.timeoutMs ?? envTimeoutMs();
  const result = runner.run([plan.cmd, plan.ownerId], {
    timeoutMs,
    env: { RELAY_LAB_OWNER: plan.ownerId, RELAY_TASK_ID: taskId },
  });

  plan.exitCode = result.code;
  if (result.timedOut) {
    plan.status = "timeout";
    plan.error = `lab cleanup hook timed out after ${timeoutMs}ms`;
  } else if (!result.ok) {
    plan.status = "failed";
    plan.error = (result.err || result.out || `exit ${result.code ?? "?"}`).slice(0, 500);
  } else {
    plan.status = "ok";
    plan.cleaned = true;
  }

  logEvent(db, {
    source: "lab-cleanup",
    taskId,
    type: plan.cleaned ? "lab.cleaned" : "lab.cleanup_failed",
    payload: {
      ownerId: plan.ownerId,
      cmd: plan.cmd,
      status: plan.status,
      exitCode: plan.exitCode,
      timeoutMs,
      error: plan.error,
      // Output is truncated so a hook cannot flood the durable log.
      out: result.out.slice(0, 2000),
      err: result.err.slice(0, 2000),
      at: now(),
    },
  });
  return plan;
}

function envTimeoutMs(): number {
  const raw = process.env[LAB_CLEANUP_TIMEOUT_ENV];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LAB_CLEANUP_TIMEOUT_MS;
}
