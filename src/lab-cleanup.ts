import type { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { now } from "./db";
import { logEvent } from "./events";
import { getTask } from "./tasks";
import { isTerminalTaskState, type Task } from "./schema";
import { childEnv } from "./child-env";

/**
 * ISH-845 — Task-owned external Lab cleanup.
 *
 * A coding Task may deploy an arbitrary containerlab topology on the shared
 * Network Lab. Relay does NOT model networks, NOS or topologies; it knows only
 * two things:
 *
 *   1. the Task's **owner identifier** — a stable, never-reused string derived
 *      from the Task (`labOwnerId(task)` = id + `created_at`), recorded durably
 *      when it is handed out (`lab.owner_assigned`), exposed to the Task as
 *      `RELAY_LAB_OWNER`, and used by the `network-lab` skill as the
 *      lab `--namespace` and `name:`; and
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
 * The `labctl` variables the trusted hook may receive from Relay's own
 * environment. `childEnv()` is a small startup allowlist and deliberately does
 * NOT carry these, so without this list a hook could never authenticate. They
 * are passed to the **hook only** (as `execFileSync` `env` extras) — never to a
 * dsh Run, which still gets exactly the explicit `-e` values Relay sets.
 */
export const LABCTL_ENV_ALLOWLIST = [
  "LABCTL_API",
  "LABCTL_USER",
  "LABCTL_PASSWORD",
  "LABCTL_PASSWORD_FILE",
  "LABCTL_TOKEN",
  "LABCTL_CA_CERT",
  "LABCTL_BIN",
] as const;

/**
 * The environment Relay gives the trusted hook: the owner id + Task id (for
 * attribution), plus the narrow {@link LABCTL_ENV_ALLOWLIST} copied from Relay's
 * environment. No task-prompt-derived value ever enters here.
 */
export function labCleanupHookEnv(
  ownerId: string,
  taskId: string,
  sourceEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = { RELAY_LAB_OWNER: ownerId, RELAY_TASK_ID: taskId };
  for (const k of LABCTL_ENV_ALLOWLIST) {
    const v = sourceEnv[k];
    if (typeof v === "string" && v.length > 0) env[k] = v;
  }
  return env;
}

/** The durable record that Relay assigned this Task's external Lab owner id. */
export const LAB_OWNER_ASSIGNED_EVENT = "lab.owner_assigned";

/**
 * The Task's external Lab owner identifier.
 *
 * It embeds the Task's `created_at` as well as its id so it is **never reused**:
 * `relay gc` can delete a terminal Task (freeing its id for `nextTaskId`), but a
 * later Task with the same id has a different `created_at`, so it can never take
 * over the earlier Task's Lab identity — and its cleanup can never target the
 * earlier Task's Lab. The value matches the containerlab/naming charset
 * (`[A-Za-z0-9._-]`).
 */
export function labOwnerId(task: Pick<Task, "id" | "created_at">): string {
  return `${task.id}-${task.created_at}`;
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

/** Whether a trusted Lab cleanup hook is configured for this process. */
export function labCleanupHookConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return ((env[LAB_CLEANUP_ENV] ?? "") as string).trim().length > 0;
}

/**
 * The owner id Relay actually handed out for this Task, or null when none was
 * ever assigned (the Task has no external Lab). Read from the durable
 * `lab.owner_assigned` record — never
 * recomputed — so a Task whose Lab owner was never handed out is never cleaned.
 */
export function assignedLabOwner(d: Database, taskId: string): string | null {
  const row = d
    .query(`SELECT payload_json FROM events WHERE task_id = ? AND type = ? ORDER BY rowid DESC LIMIT 1`)
    .get(taskId, LAB_OWNER_ASSIGNED_EVENT) as { payload_json: string } | undefined;
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payload_json) as { ownerId?: unknown };
    return typeof payload.ownerId === "string" && payload.ownerId.length > 0 ? payload.ownerId : null;
  } catch {
    return null;
  }
}

/** The non-terminal Run that still holds this Task (or null). */
export function findActiveTaskRun(d: Database, taskId: string): { id: string; state: string } | null {
  const row = d
    .query(`SELECT id, state FROM runs WHERE task_id = ? AND state IN ('starting','running') ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(taskId) as { id: string; state: string } | undefined;
  return row ?? null;
}

/**
 * Whether a Task has an unfinished Lab cleanup: Relay assigned an owner id (so a
 * lab *may* exist) and the latest `lab.*` event is not a success. Used by
 * `planGc` to refuse deleting such a Task, so its owner id stays addressable and
 * the cleanup stays re-runnable. A Task with no assignment is not pending.
 */
export function labCleanupPending(d: Database, taskId: string): boolean {
  const row = d
    .query(
      `SELECT type FROM events WHERE task_id = ? AND type IN (?, 'lab.cleaned', 'lab.cleanup_failed') ORDER BY rowid DESC LIMIT 1`
    )
    .get(taskId, LAB_OWNER_ASSIGNED_EVENT) as { type: string } | undefined;
  if (!row) return false;
  return row.type !== "lab.cleaned";
}

/**
 * Decide whether the Task's Lab cleanup is due, WITHOUT running anything.
 *
 * Guards, in order: a hook is configured; Relay actually assigned an owner id
 * (a Lab-unused Task is skipped — no external call); no Run still holds the
 * Task; and the Task has really ended (merged, or an explicit `--abort`). A Task
 * parked at `merge_ready` has NOT ended and is refused.
 */
export function planLabCleanup(d: Database, taskId: string, opts: LabCleanupOptions = {}): LabCleanupPlan {
  const task = getTask(d, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  const cmd = configuredCmd(opts);
  const reasons: string[] = [];
  const assigned = assignedLabOwner(d, taskId);
  const plan: LabCleanupPlan = {
    taskId,
    ownerId: assigned ?? labOwnerId(task),
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
  if (!assigned) {
    reasons.push("no lab owner assigned for this task (no external Lab)");
    return plan;
  }

  const active = findActiveTaskRun(d, taskId);
  if (active) reasons.push(`active run ${active.id} (${active.state}) still holds task ${taskId}`);

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
export function applyLabCleanup(d: Database, taskId: string, opts: LabCleanupOptions = {}): LabCleanupPlan {
  const plan = planLabCleanup(d, taskId, opts);
  if (!plan.apply) return plan;
  if (!plan.remove || !plan.cmd) {
    logEvent(d, {
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
    // The hook (only) receives the owner id and a narrow LABCTL_* set from
    // Relay's environment, so the referenced hook can authenticate.
    env: labCleanupHookEnv(plan.ownerId, taskId),
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

  logEvent(d, {
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
