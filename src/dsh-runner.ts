import type { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultDbPath, now } from "./db";
import { logEvent } from "./events";
import { getTask } from "./tasks";
import type { Run, RunState, Task } from "./schema";
import { gitHead } from "./verify";
import { submitImplementationFromRun, type RunImplementation } from "./workflow";

/**
 * ISH-803 — one-shot headless dsh coding runner.
 *
 * 1 Run = 1 `dsh --profile headless` process = 1 coding attempt. Starting /
 * running / finishing a dsh attempt must NOT require a Herdr pane, a TUI, the
 * `dsh web` server, the Cordis wake plugin, or a manual attach. This module owns
 * ONLY one Run's launch / observe / terminate; Task worktrees, single-writer
 * control and FIX re-entry are ISH-760.
 *
 * PINNED CLI CONTRACT (dsh 0.1.5-rc.1, dsh-headless 0.1.5-rc.2): the app is
 * `dsh --profile headless <task...>` (multiple words joined by spaces). It
 * streams provider reasoning to STDERR, prints the final assistant text to
 * STDOUT, and exits 0 only when the turn completed (`turn/end` reason
 * `completed`); any other outcome exits 1. There is NO `--json`/JSONL output in
 * this version and no machine-readable event field to parse, so the runner
 * treats stdout/stderr as text and records its own lifecycle JSONL. See
 * `docs/dsh-headless-runner.md`. No unverified option/field is used.
 *
 * `exit 0` is NOT a submission: only a structured `acceptRunSubmission` (bound
 * to the Run/Task/phase/attempt/branch/HEAD) advances the Task.
 */

export const DEFAULT_FAST_EXIT_MS = 1500;
/** dsh's default permission mode: writes are confined to the Run cwd. */
export const DEFAULT_PERMISSION_MODE = "workspace-write";
const SESSION_ID_RE = /\bsession-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** One line of the Run's own lifecycle JSONL (`events.jsonl`). */
export interface RunEvent {
  t: string;
  [k: string]: unknown;
}

/** The minimal process surface the runner needs (Bun.spawn in prod, a fake in tests). */
export interface DshProcess {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number | null>;
  kill(signal?: NodeJS.Signals): void;
}

export interface DshSpawner {
  spawn(argv: string[], opts: { cwd: string; env: Record<string, string> }): DshProcess;
}

/** Real spawner: a new process GROUP so cancel/timeout can kill the whole tree. */
export const bunDshSpawner: DshSpawner = {
  spawn(argv, opts) {
    const proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env: opts.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    return {
      pid: proc.pid,
      stdout: proc.stdout as ReadableStream<Uint8Array>,
      stderr: proc.stderr as ReadableStream<Uint8Array>,
      exited: proc.exited as Promise<number | null>,
      kill(signal: NodeJS.Signals = "SIGKILL") {
        try {
          process.kill(-proc.pid, signal);
        } catch {
          try {
            proc.kill(signal);
          } catch {
            /* already gone */
          }
        }
      },
    };
  },
};

export interface StartRunOptions {
  taskId: string;
  /** Override cwd (default: task.worktree, else the daemon cwd). */
  cwd?: string;
  /** Override the task text handed to dsh (default: built from the Task). */
  prompt?: string;
  /** Root for `<root>/<run-id>/`; default `<control-plane>/runs`. */
  outputRoot?: string;
  /** dsh executable (default `dsh`, or $RELAY_DSH_BIN). */
  dshBin?: string;
  /** Permission boundary passed as $DSH_PERMISSION_MODE. */
  permissionMode?: string;
  /** Hard budget; on expiry the process group is killed and the Run is timeout. */
  timeoutMs?: number;
  /** A Run shorter than this is flagged `fast_exit` (still not a submission). */
  fastExitMs?: number;
  /** Extra env for the child (merged over process.env). */
  env?: Record<string, string>;
  /** Test seam. */
  spawner?: DshSpawner;
}

export interface DshRunHandle {
  readonly id: string;
  wait(): Promise<Run>;
  cancel(reason?: string): void;
}

// ---------------------------------------------------------------------------
// Durable Run storage (SQLite; output files stay under the Run's directory)
// ---------------------------------------------------------------------------

export function getRun(db: Database, id: string): Run | null {
  return (db.query(`SELECT * FROM runs WHERE id = ?`).get(id) as Run | null) ?? null;
}

export function listRuns(
  db: Database,
  opts: { taskId?: string; state?: RunState; limit?: number } = {}
): Run[] {
  const limit = Math.min(opts.limit ?? 50, 500);
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.taskId) {
    where.push("task_id = ?");
    args.push(opts.taskId);
  }
  if (opts.state) {
    where.push("state = ?");
    args.push(opts.state);
  }
  const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`;
  return db.query(sql).all(...args, limit) as Run[];
}

interface InsertRunInput {
  id: string;
  taskId: string;
  phase: string;
  attempt: number;
  generation: number;
  cwd: string;
  branch: string | null;
  headSha: string | null;
  prompt: string;
  specPath: string;
  outputDir: string;
  stdoutPath: string;
  stderrPath: string;
  eventsPath: string;
}

function insertRun(db: Database, r: InsertRunInput): Run {
  const t = now();
  db.query(
    `INSERT INTO runs
       (id, task_id, phase, attempt, generation, cwd, branch, head_sha, prompt,
        spec_path, output_dir, state, stdout_path, stderr_path, events_path,
        fast_exit, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?, 0, ?, ?, ?)`
  ).run(
    r.id,
    r.taskId,
    r.phase,
    r.attempt,
    r.generation,
    r.cwd,
    r.branch,
    r.headSha,
    r.prompt,
    r.specPath,
    r.outputDir,
    r.stdoutPath,
    r.stderrPath,
    r.eventsPath,
    t,
    t,
    t
  );
  return getRun(db, r.id)!;
}

interface RunPatch {
  state?: RunState;
  pid?: number;
  exit_code?: number | null;
  signal?: string | null;
  session_id?: string | null;
  error?: string | null;
  fast_exit?: number;
  ended_at?: number | null;
}

function updateRun(db: Database, id: string, patch: RunPatch): Run {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  const put = (col: string, v: string | number | null) => {
    sets.push(`${col} = ?`);
    args.push(v);
  };
  if (patch.state !== undefined) put("state", patch.state);
  if (patch.pid !== undefined) put("pid", patch.pid);
  if (patch.exit_code !== undefined) put("exit_code", patch.exit_code);
  if (patch.signal !== undefined) put("signal", patch.signal);
  if (patch.session_id !== undefined) put("session_id", patch.session_id);
  if (patch.error !== undefined) put("error", patch.error);
  if (patch.fast_exit !== undefined) put("fast_exit", patch.fast_exit);
  if (patch.ended_at !== undefined) put("ended_at", patch.ended_at);
  put("updated_at", now());
  args.push(id);
  db.query(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...(args as (string | number | null)[]));
  return getRun(db, id)!;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") out[k] = v;
  return out;
}

/** The current branch of `cwd`, or null (detached / not a git checkout). */
export function gitBranch(cwd: string): string | null {
  try {
    const p = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (p.exitCode !== 0) return null;
    const b = p.stdout.toString().trim();
    return b && b !== "HEAD" ? b : null;
  } catch {
    return null;
  }
}

/** The task text handed to dsh: the durable Task spec, not a chat prompt. */
export function buildTaskPrompt(task: Task): string {
  const lines = [
    `# Task ${task.id}`,
    "",
    `Title: ${task.title}`,
  ];
  if (task.description) lines.push("", "## Description", "", task.description);
  if (task.acceptance) lines.push("", "## Acceptance", "", task.acceptance);
  lines.push(
    "",
    "Work in the current directory. Make the change, run the relevant checks, and" +
      " commit on the current branch. Do not merge. Report what you changed and any" +
      " check you ran."
  );
  return lines.join("\n");
}

/** Read a byte stream as text lines; a malformed/last line is still delivered. */
async function pumpLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    }
    buf += dec.decode();
    if (buf.length > 0) onLine(buf);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

// ---------------------------------------------------------------------------
// Launch / observe / terminate
// ---------------------------------------------------------------------------

/** Launch ONE headless dsh Run for a Task and return its live handle. */
export async function startDshRun(db: Database, opts: StartRunOptions): Promise<DshRunHandle> {
  const task = getTask(db, opts.taskId);
  if (!task) throw new Error(`unknown task: ${opts.taskId}`);
  if (task.code_change !== 1) {
    throw new Error(`task ${task.id} is not a code-change task; a headless Run implements a code task`);
  }
  const phase = task.phase;
  if (phase !== "implement" && phase !== "integration") {
    throw new Error(`task ${task.id} is in phase '${phase ?? "none"}' (a Run starts in implement/integration)`);
  }

  const cwd = opts.cwd ?? task.worktree ?? process.cwd();
  const prompt = opts.prompt ?? buildTaskPrompt(task);
  const branch = gitBranch(cwd);
  const head = gitHead(cwd);
  const dshBin = opts.dshBin ?? process.env.RELAY_DSH_BIN ?? "dsh";
  const permissionMode = opts.permissionMode ?? DEFAULT_PERMISSION_MODE;
  const spawner = opts.spawner ?? bunDshSpawner;
  const fastExitMs = opts.fastExitMs ?? DEFAULT_FAST_EXIT_MS;
  const outputRoot = opts.outputRoot ?? join(dirname(defaultDbPath()), "runs");

  const runId = `run-${crypto.randomUUID().slice(0, 8)}`;
  const runDir = join(outputRoot, runId);
  mkdirSync(runDir, { recursive: true });
  const stdoutPath = join(runDir, "stdout.log");
  const stderrPath = join(runDir, "stderr.log");
  const eventsPath = join(runDir, "events.jsonl");
  const specPath = join(runDir, "spec.md");
  writeFileSync(specPath, prompt + "\n");
  writeFileSync(stdoutPath, "");
  writeFileSync(stderrPath, "");

  const events = (e: RunEvent): void => {
    appendFileSync(eventsPath, `${JSON.stringify({ ts: now(), ...e })}\n`);
  };

  const run = insertRun(db, {
    id: runId,
    taskId: task.id,
    phase,
    attempt: task.attempt,
    generation: task.attempt,
    cwd,
    branch,
    headSha: head,
    prompt,
    specPath,
    outputDir: runDir,
    stdoutPath,
    stderrPath,
    eventsPath,
  });

  events({ t: "run.started", runId, taskId: task.id, phase, attempt: task.attempt, cwd, branch, head, permissionMode });
  logEvent(db, {
    source: "dsh-runner",
    taskId: task.id,
    type: "dsh.run.started",
    payload: { runId, phase, attempt: task.attempt, cwd, branch, head, permissionMode },
  });

  const argv = [dshBin, "--profile", "headless", prompt];
  const env: Record<string, string> = {
    ...baseEnv(),
    ...(opts.env ?? {}),
    DSH_PERMISSION_MODE: permissionMode,
    RELAY_RUN_ID: runId,
    RELAY_TASK_ID: task.id,
  };

  let proc: DshProcess;
  try {
    proc = spawner.spawn(argv, { cwd, env });
  } catch (e) {
    const message = `spawn failed: ${e instanceof Error ? e.message : String(e)}`;
    events({ t: "run.failed", error: message });
    const failed = updateRun(db, runId, { state: "failed", error: message, ended_at: now() });
    logEvent(db, { source: "dsh-runner", taskId: task.id, type: "dsh.run.failed", payload: { runId, error: message } });
    return { id: runId, wait: async () => failed, cancel: () => {} };
  }

  updateRun(db, runId, { state: "running", pid: proc.pid });
  let sessionId: string | null = null;
  let cancelReason: string | null = null;
  let settled = false;

  const onStdout = (line: string): void => {
    appendFileSync(stdoutPath, `${line}\n`);
    const m = SESSION_ID_RE.exec(line);
    if (m) sessionId = m[0];
    events({ t: "stdout", v: line });
  };
  const onStderr = (line: string): void => {
    appendFileSync(stderrPath, `${line}\n`);
    const m = SESSION_ID_RE.exec(line);
    if (m && !sessionId) sessionId = m[0];
    events({ t: "stderr", v: line });
  };
  const outP = pumpLines(proc.stdout, onStdout).catch(() => {});
  const errP = pumpLines(proc.stderr, onStderr).catch(() => {});

  let timeout: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timeout = setTimeout(() => {
      if (settled) return;
      cancelReason = "timeout";
      events({ t: "run.timeout", timeoutMs: opts.timeoutMs });
      proc.kill("SIGKILL");
    }, opts.timeoutMs);
  }

  const done = (async (): Promise<Run> => {
    let exitCode: number | null = null;
    let failure: string | null = null;
    try {
      exitCode = await proc.exited;
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
    await Promise.allSettled([outP, errP]);
    if (timeout) clearTimeout(timeout);
    settled = true;

    const durationMs = now() - run.started_at;
    const fast = durationMs < fastExitMs;
    // An external `relay run cancel` marks the row before signalling, so honour
    // it here instead of recording a bare signal failure.
    const external = getRun(db, runId)?.signal ?? null;
    const reason = cancelReason ?? external;
    let state: RunState;
    if (reason === "timeout") state = "timeout";
    else if (reason) state = "cancelled";
    else if (failure) state = "failed";
    else state = exitCode === 0 ? "exited" : "failed";

    if (fast) events({ t: "run.fast_exit", durationMs, exitCode });
    events({ t: "run.exited", state, exitCode, durationMs, fast, sessionId });
    const finalRun = updateRun(db, runId, {
      state,
      exit_code: exitCode,
      signal: reason,
      session_id: sessionId,
      error: failure ?? (state === "exited" ? null : reason ? `run ${reason}` : `exit ${exitCode}`),
      fast_exit: fast ? 1 : 0,
      ended_at: now(),
    });
    logEvent(db, {
      source: "dsh-runner",
      taskId: task.id,
      type: `dsh.run.${state}`,
      payload: { runId, exitCode, durationMs, fast, sessionId },
    });
    return finalRun;
  })();

  return {
    id: runId,
    wait: () => done,
    cancel(reason = "cancelled") {
      if (settled || cancelReason) return;
      cancelReason = reason;
      events({ t: "run.cancelled", reason });
      proc.kill("SIGTERM");
      // Escalate if it ignores the first signal; the group kill is safe once the
      // process is gone (it throws and is swallowed).
      setTimeout(() => {
        if (!settled) proc.kill("SIGKILL");
      }, 5000);
    },
  };
}

/** Poll the durable row until the Run is terminal (for a CLI/other process). */
export async function waitDshRun(db: Database, runId: string, pollMs = 250): Promise<Run> {
  const terminal = new Set<RunState>(["exited", "failed", "cancelled", "timeout", "submitted"]);
  for (;;) {
    const r = getRun(db, runId);
    if (!r) throw new Error(`unknown run: ${runId}`);
    if (terminal.has(r.state)) return r;
    await new Promise((r2) => setTimeout(r2, pollMs));
  }
}

// ---------------------------------------------------------------------------
// Structured submission (the ONLY way a Run advances a Task)
// ---------------------------------------------------------------------------

export interface RunSubmission {
  runId: string;
  taskId?: string;
  phase?: string;
  attempt?: number;
  branch?: string | null;
  headSha?: string | null;
  summary?: string;
  evidence?: string;
}

export function rejectSubmission(reason: string): never {
  throw new Error(`RUN_SUBMISSION_REJECTED: ${reason}`);
}

/**
 * Accept a structured implementation submission bound to the current
 * Run/Task/phase/attempt/branch/HEAD. Refuses (never advances the Task) when:
 *   - the Run is missing, or its state is not a clean `exited` with code 0
 *     (failed / signal / cancelled / timeout / still running);
 *   - the submission names a different task/phase/attempt/branch/HEAD than the
 *     Run recorded at start;
 *   - the LIVE task has moved (phase/attempt/branch/HEAD changed since the Run
 *     started) — a stale Run can never advance the current attempt.
 * A process `exit 0` or the Run's final stdout text does NOT call this.
 */
export function acceptRunSubmission(db: Database, sub: RunSubmission): Run {
  const run = getRun(db, sub.runId);
  if (!run) rejectSubmission(`unknown run: ${sub.runId}`);

  if (run.state !== "exited" || run.exit_code !== 0) {
    rejectSubmission(
      `run ${run.id} is '${run.state}'${run.exit_code === null ? "" : ` (exit ${run.exit_code})`}; only a clean exit 0 can be submitted`
    );
  }
  if (sub.taskId !== undefined && sub.taskId !== run.task_id) {
    rejectSubmission(`run ${run.id} belongs to task ${run.task_id}, not ${sub.taskId}`);
  }
  if (sub.phase !== undefined && sub.phase !== run.phase) {
    rejectSubmission(`run ${run.id} started in phase '${run.phase}', not '${sub.phase}'`);
  }
  if (sub.attempt !== undefined && sub.attempt !== run.attempt) {
    rejectSubmission(`run ${run.id} started at attempt ${run.attempt}, not ${sub.attempt}`);
  }
  if (sub.branch !== undefined && sub.branch !== run.branch) {
    rejectSubmission(`run ${run.id} was bound to branch ${run.branch ?? "none"}, not ${sub.branch ?? "none"}`);
  }
  if (sub.headSha !== undefined && sub.headSha !== run.head_sha) {
    rejectSubmission(`run ${run.id} was bound to head ${run.head_sha ?? "none"}, not ${sub.headSha ?? "none"}`);
  }

  const task = getTask(db, run.task_id);
  if (!task) rejectSubmission(`run ${run.id} references missing task ${run.task_id}`);
  if (task.phase !== run.phase || task.attempt !== run.attempt) {
    rejectSubmission(
      `run ${run.id} is stale: task ${task.id} is now phase '${task.phase ?? "none"}' attempt ${task.attempt}`
    );
  }
  if ((task.branch ?? null) !== (run.branch ?? null)) {
    rejectSubmission(`run ${run.id} is stale: task branch is now ${task.branch ?? "none"}, run was ${run.branch ?? "none"}`);
  }
  if ((task.head_sha ?? null) !== (run.head_sha ?? null)) {
    rejectSubmission(`run ${run.id} is stale: task head is now ${task.head_sha ?? "none"}, run was ${run.head_sha ?? "none"}`);
  }

  const impl: RunImplementation = {
    runId: run.id,
    phase: run.phase,
    attempt: run.attempt,
    branch: run.branch,
    headSha: run.head_sha,
    summary: sub.summary,
    evidence: sub.evidence ?? `run:${run.id}`,
  };
  // The workflow re-validates against the live task and records TaskSubmitted.
  submitImplementationFromRun(db, task.id, impl);
  const updated = updateRun(db, run.id, { state: "submitted" });
  logEvent(db, {
    source: "dsh-runner",
    taskId: task.id,
    type: "dsh.run.submitted",
    payload: { runId: run.id, phase: run.phase, attempt: run.attempt, head: run.head_sha },
  });
  return updated;
}
