import type { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defaultDbPath, now } from "./db";
import { logEvent } from "./events";
import { getTask } from "./tasks";
import type { Run, RunState, Task } from "./schema";
import { isTerminalTaskState } from "./schema";
import { spawnIdentityToken } from "./proc-identity";
import {
  beginRunLaunch,
  endRunLaunch,
  launcherFields,
  releaseRunLauncher,
} from "./run-launcher";
import { childEnv } from "./child-env";
import { isPinnedDsh, PINNED_DSH_VERSION, readDshVersion } from "./dsh-version";
import { assertLaunchDiskSpace, type DiskGuardOptions } from "./disk-guard";
import { gitHead } from "./verify";
import { submitImplementationFromRun, type RunImplementation } from "./workflow";
import {
  countDshLine,
  dshSessionId,
  emptyDshCounts,
  type DshEvent,
  type DshEventCounts,
  parseDshLine,
  turnEndReason,
} from "./dsh-events";

/**
 * ISH-803 / ISH-810 — one-shot headless dsh coding runner.
 *
 * 1 Run = 1 `dsh --profile headless` process = 1 coding attempt. Starting /
 * running / finishing a dsh attempt must NOT require a Herdr pane, a TUI, the
 * `dsh web` server, the Cordis wake plugin, or a manual attach. This module owns
 * ONLY one Run's launch / observe / terminate; Task worktrees, single-writer
 * control and FIX re-entry are ISH-760.
 *
 * PINNED CLI CONTRACT (dsh **0.2.1-rc.2**, unchanged from 0.2.0-rc.2): the app is
 * `dsh --profile headless --json <task...>` (multiple words joined by spaces, or
 * `--json -` to read the task from stdin). STDERR carries provider reasoning and
 * errors; STDOUT is newline-delimited JSON **execution events** — `session`
 * (sessionId/cwd), `status` (turn/step + `turn_end` reason), `text`, `thinking`,
 * `tool_call`, `tool_result`, and a terminal `final` (or `error` on a failure
 * outside a turn). The runner reads that JSONL incrementally, records the
 * ORIGINAL dsh JSONL as per-Run evidence (`dsh.jsonl`) and keeps Relay's own
 * lifecycle log (`events.jsonl`) strictly distinct.
 *
 * The JSONL is a BOUNDED projection, not a lossless Session log (fields/events
 * can be truncated, tool results may be sensitive), and an in-turn failure can
 * still print a `final`. **The process exit code / `turn_end` reason are
 * authoritative for process success**, and *neither* means Relay Task approval.
 * A parse/truncation problem is surfaced and never manufactures a success.
 *
 * `exit 0` is NOT a submission: only a structured `acceptRunSubmission` (bound
 * to the Run/Task/phase/attempt/branch/HEAD) advances the Task.
 */

export const DEFAULT_FAST_EXIT_MS = 1500;
/** dsh's default permission mode: writes are confined to the Run cwd. */
export const DEFAULT_PERMISSION_MODE = "workspace-write";

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
  /** Extra env for the child (merged over a small allowlist, never all of process.env). */
  env?: Record<string, string>;
  /** ISH-1009: disk-space guard override (test/operator seam). */
  diskGuard?: DiskGuardOptions;
  /**
   * ISH-1009: internal composition seam. `launchTaskRun` measures BEFORE it
   * creates/pins the worktree and then starts the Run; setting this avoids a
   * second probe of the same volume. Public entrypoints leave it unset.
   */
  skipDiskGuard?: boolean;
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

/** ISH-760: a second writer into the same worktree/branch is refused. */
export const DUPLICATE_WRITER = "DUPLICATE_WRITER";

/** ISH-869: the host headless `dsh` is not the pinned build — refuse to spawn. */
export const DSH_VERSION_MISMATCH = "DSH_VERSION_MISMATCH";

export interface ActiveWriterQuery {
  /** The worktree the candidate writer would run in. */
  cwd: string;
  /** The branch the candidate writer would write (null when not a git checkout). */
  branch?: string | null;
  /** Ignore this Run (e.g. the row being re-checked). */
  excludeRunId?: string;
}

/**
 * ISH-760 single-writer: the non-terminal Run that already holds a writer on the
 * SAME worktree (by resolved cwd) or the SAME branch. Two Runs in DIFFERENT
 * worktrees/branches never conflict, even when they touch the same files — the
 * spec permits that parallel case and only rejects a duplicate writer on one
 * branch/worktree.
 */
export function findActiveWriter(db: Database, q: ActiveWriterQuery): Run | null {
  const cwd = resolve(q.cwd);
  const rows = db
    .query(`SELECT * FROM runs WHERE state IN ('starting','running') ORDER BY created_at DESC, rowid DESC`)
    .all() as Run[];
  for (const r of rows) {
    if (q.excludeRunId && r.id === q.excludeRunId) continue;
    const sameWorktree = resolve(r.cwd) === cwd;
    const sameBranch = !!(q.branch && r.branch && q.branch === r.branch);
    if (sameWorktree || sameBranch) return r;
  }
  return null;
}

/** The DUPLICATE_WRITER error for a conflicting live Run. */
export function activeWriterError(conflict: Run, cwd: string, branch: string | null): Error {
  const why =
    resolve(conflict.cwd) === resolve(cwd)
      ? `run ${conflict.id} is still '${conflict.state}' in this worktree (${cwd})`
      : `run ${conflict.id} is still '${conflict.state}' on branch ${branch ?? "none"}`;
  return new Error(
    `${DUPLICATE_WRITER}: ${why}; wait for it to end or \`relay run cancel ${conflict.id}\` before launching another writer`
  );
}

/**
 * Throw `DUPLICATE_WRITER` when a live Run already holds `cwd`/`branch`. A
 * best-effort pre-check for a fast refusal; the AUTHORITATIVE, race-free guard is
 * `insertRunIfNoActiveWriter` (one `BEGIN IMMEDIATE` transaction around the check
 * and the INSERT).
 */
export function assertNoActiveWriter(db: Database, q: ActiveWriterQuery): void {
  const conflict = findActiveWriter(db, q);
  if (conflict) throw activeWriterError(conflict, q.cwd, q.branch ?? null);
}

interface InsertRunInput {
  id: string;
  taskId: string;
  phase: string;
  attempt: number;
  generation: number;
  cwd: string;
  /** The branch at Run start (the produced branch is written on exit). */
  branch: string | null;
  /** The HEAD at Run start (the base/staleness fence). */
  baseHeadSha: string | null;
  prompt: string;
  specPath: string;
  outputDir: string;
  stdoutPath: string;
  stderrPath: string;
  eventsPath: string;
  /** ISH-810: the per-Run path of the ORIGINAL dsh `--json` JSONL evidence. */
  dshEventsPath: string;
}

function insertRun(db: Database, r: InsertRunInput): Run {
  const t = now();
  // ISH-1008: record the launcher so the liveness sweep can tell "the child is
  // gone but the coroutine is still finishing the terminal write" from "nobody
  // owns this row any more".
  const launcher = launcherFields();
  // `head_sha` (the PRODUCED head) is NULL until the Run ends and the cwd is
  // re-read; `base_head_sha` is the pre-run fence.
  db.query(
    `INSERT INTO runs
       (id, task_id, phase, attempt, generation, cwd, branch, head_sha, base_head_sha, prompt,
        spec_path, output_dir, state, stdout_path, stderr_path, events_path, dsh_events_path,
        launcher_pid, launcher_lstart, fast_exit, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  ).run(
    r.id,
    r.taskId,
    r.phase,
    r.attempt,
    r.generation,
    r.cwd,
    r.branch,
    r.baseHeadSha,
    r.prompt,
    r.specPath,
    r.outputDir,
    r.stdoutPath,
    r.stderrPath,
    r.eventsPath,
    r.dshEventsPath,
    launcher.launcher_pid,
    launcher.launcher_lstart,
    t,
    t,
    t
  );
  return getRun(db, r.id)!;
}

/**
 * ISH-760 single-writer, ATOMIC across processes: the existence check
 * (`assertNoActiveWriter`) and the `INSERT` happen in ONE `BEGIN IMMEDIATE`
 * transaction. Two concurrent `relay run launch`/`start` processes cannot both
 * be admitted: the second `BEGIN IMMEDIATE` blocks (or gets SQLITE_BUSY) until
 * the first COMMITs, then its SELECT observes the first row and it is refused.
 * A deferred transaction would NOT close this window (the read happens before the
 * write lock), so the IMMEDIATE form is required.
 */
function insertRunIfNoActiveWriter(db: Database, r: InsertRunInput): Run {
  return db
    .transaction(() => {
      assertNoActiveWriter(db, { cwd: r.cwd, branch: r.branch });
      return insertRun(db, r);
    })
    .immediate();
}

interface RunPatch {
  state?: RunState;
  pid?: number;
  /** ISH-762: the spawn-time process identity token (`ps -o lstart=`). */
  spawn_lstart?: string | null;
  branch?: string | null;
  head_sha?: string | null;
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
  if (patch.spawn_lstart !== undefined) put("spawn_lstart", patch.spawn_lstart);
  if (patch.branch !== undefined) put("branch", patch.branch);
  if (patch.head_sha !== undefined) put("head_sha", patch.head_sha);
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
  // ISH-808: a cancelled task (or any other terminal state) is CLOSED. A Run
  // must not start for it — its phase is left untouched by `cancelTask`, so the
  // phase check below would otherwise admit a fresh writer and let its result
  // move the task back out of `cancelled`.
  if (isTerminalTaskState(task.state)) {
    throw new Error(`cannot start a Run for ${task.id}: task is terminal (state=${task.state})`);
  }
  if (task.code_change !== 1) {
    throw new Error(`task ${task.id} is not a code-change task; a headless Run implements a code task`);
  }
  const phase = task.phase;
  if (phase !== "implement" && phase !== "integration") {
    throw new Error(`task ${task.id} is in phase '${phase ?? "none"}' (a Run starts in implement/integration)`);
  }

  // ISH-1009: refuse BEFORE any Run row / output directory / dsh process. A
  // refusal leaves the Task exactly as it was (queued), so the next attempt
  // after space is freed launches normally. A probe failure is never a pass.
  if (!opts.skipDiskGuard) {
    assertLaunchDiskSpace(db, {
      taskId: task.id,
      phase,
      target: "host",
      ...opts.diskGuard,
    });
  }

  const cwd = opts.cwd ?? task.worktree ?? process.cwd();
  const prompt = opts.prompt ?? buildTaskPrompt(task);
  const branch = gitBranch(cwd);
  const head = gitHead(cwd);

  // ISH-760 single writer: do not launch the next writer into a worktree/branch
  // whose previous Run has not ENDED (its durable row is not yet terminal).
  // Different worktrees/branches are allowed to run in parallel. The Run's own
  // end/cancel is the confirmation that releases the writer. This is a FAST
  // pre-check only; the authoritative race-free guard is the BEGIN IMMEDIATE
  // insert below.
  assertNoActiveWriter(db, { cwd, branch });

  const dshBin = opts.dshBin ?? process.env.RELAY_DSH_BIN ?? "dsh";
  // ISH-869 fail-closed: the HOST Coding Worker must be the exact pinned dsh.
  // Probe `--version` BEFORE any Run row or spawn, so an old/mismatched build
  // (e.g. a 0.2.0-rc.2 `dsh` on PATH) can never be run as a normal success.
  const hostDshVersion = readDshVersion(dshBin);
  if (!isPinnedDsh(hostDshVersion)) {
    const message =
      `${DSH_VERSION_MISMATCH}: ${dshBin} reports ${hostDshVersion ?? "no version"}, but Relay pins ` +
      `@deepseek-ai/dsh@${PINNED_DSH_VERSION}; refusing to start a Run (an old version is never a silent pass)`;
    logEvent(db, {
      source: "dsh-runner",
      taskId: task.id,
      type: "dsh.version_mismatch",
      payload: { dshBin, want: PINNED_DSH_VERSION, got: hostDshVersion },
    });
    throw new Error(message);
  }
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
  // ISH-810: the ORIGINAL dsh `--json` JSONL (one event per line) is per-Run
  // evidence, kept separate from Relay's own `events.jsonl` lifecycle log.
  const dshEventsPath = join(runDir, "dsh.jsonl");
  const specPath = join(runDir, "spec.md");
  writeFileSync(specPath, prompt + "\n");
  writeFileSync(stdoutPath, "");
  writeFileSync(stderrPath, "");
  writeFileSync(dshEventsPath, "");

  const events = (e: RunEvent): void => {
    appendFileSync(eventsPath, `${JSON.stringify({ ts: now(), ...e })}\n`);
  };

  const run = insertRunIfNoActiveWriter(db, {
    id: runId,
    taskId: task.id,
    phase,
    attempt: task.attempt,
    generation: task.attempt,
    cwd,
    branch,
    baseHeadSha: head,
    prompt,
    specPath,
    outputDir: runDir,
    stdoutPath,
    stderrPath,
    eventsPath,
    dshEventsPath,
  });

  events({ t: "run.started", runId, taskId: task.id, phase, attempt: task.attempt, cwd, branch, baseHead: head, permissionMode });
  logEvent(db, {
    source: "dsh-runner",
    taskId: task.id,
    type: "dsh.run.started",
    payload: { runId, phase, attempt: task.attempt, cwd, branch, baseHead: head, permissionMode },
  });

  const argv = [dshBin, "--profile", "headless", "--json", prompt];
  const env: Record<string, string> = {
    ...childEnv(process.env, opts.env),
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

  // ISH-762: capture the process identity token NOW, while the dsh is known to be
  // the process we just spawned. A later adoption compares it before any signal.
  updateRun(db, runId, {
    state: "running",
    pid: proc.pid,
    spawn_lstart: spawnIdentityToken(proc.pid),
  });
  let sessionId: string | null = null;
  let cancelReason: string | null = null;
  let settled = false;
  // ISH-810 dsh JSONL observability (see src/dsh-events.ts).
  const counts: DshEventCounts = emptyDshCounts();
  let terminal: "final" | "error" | null = null;
  let terminalError: string | null = null;
  let turnReason: string | null = null;

  const onStdout = (line: string): void => {
    appendFileSync(stdoutPath, `${line}\n`);
    const parsed = parseDshLine(line);
    countDshLine(counts, parsed);
    if (parsed.kind === "event") {
      const ev: DshEvent = parsed.event;
      // The ORIGINAL dsh JSONL is per-Run evidence, kept separate from Relay's
      // own lifecycle log below. Relay never writes its own events here.
      appendFileSync(dshEventsPath, `${parsed.raw}\n`);
      const sid = dshSessionId(ev);
      if (sid && !sessionId) sessionId = sid;
      const reason = turnEndReason(ev);
      if (reason) turnReason = reason;
      if (ev.type === "final") terminal = "final";
      if (ev.type === "error") {
        terminal = "error";
        terminalError = `dsh error event: ${String(ev.message ?? ev.error ?? ev.text ?? "unknown")}`;
      }
      // Relay's OWN audit annotation: the event TYPE only, never its payload, so
      // the two logs stay distinct.
      events({ t: "dsh.event", type: ev.type, ...(typeof ev.callId === "string" ? { callId: ev.callId } : {}) });
      return;
    }
    if (parsed.kind === "malformed") {
      // A non-JSON / unparseable stdout line stays VISIBLE; it never becomes a
      // success and never aborts the Run (the profile may print boot banners).
      events({ t: "stdout.malformed", error: parsed.error, v: parsed.raw });
    }
  };
  const onStderr = (line: string): void => {
    appendFileSync(stderrPath, `${line}\n`);
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

  beginRunLaunch(runId);
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

    // The PRODUCED revision: dsh is asked to commit, so re-read the worktree
    // AFTER the process ends. `run.base_head_sha` keeps the pre-run fence.
    const producedBranch = gitBranch(cwd);
    const producedHead = gitHead(cwd);

    const durationMs = now() - run.started_at;
    const fast = durationMs < fastExitMs;
    // An external `relay run cancel` (or `relay task cancel`) writes the row's
    // `signal` before stopping the process, so honour it here instead of
    // recording a bare signal failure.
    const external = getRun(db, runId)?.signal ?? null;
    const reason = cancelReason ?? external;
    let state: RunState;
    if (reason === "timeout") state = "timeout";
    else if (reason) state = "cancelled";
    else if (failure) state = "failed";
    // The process exit code is authoritative for process success. A terminal
    // `error` event (a failure OUTSIDE a turn) disagreeing with a 0 exit is a
    // contradiction: fail CLOSED rather than report a success we cannot trust.
    // A `final` event is NOT required and is NEVER a substitute for `run submit`.
    else state = exitCode === 0 && terminal !== "error" ? "exited" : "failed";

    if (fast) events({ t: "run.fast_exit", durationMs, exitCode });
    events({
      t: "run.exited",
      state,
      exitCode,
      durationMs,
      fast,
      sessionId,
      baseHead: run.base_head_sha,
      producedHead,
      dsh: counts,
      terminal,
      turnReason,
    });
    const errorText =
      failure ??
      (state === "exited"
        ? null
        : reason
          ? `run ${reason}`
          : terminalError ?? `exit ${exitCode}`);
    const finalRun = updateRun(db, runId, {
      state,
      branch: producedBranch,
      head_sha: producedHead,
      exit_code: exitCode,
      signal: reason,
      session_id: sessionId,
      error: errorText,
      fast_exit: fast ? 1 : 0,
      ended_at: now(),
    });
    logEvent(db, {
      source: "dsh-runner",
      taskId: task.id,
      type: `dsh.run.${state}`,
      payload: {
        runId,
        exitCode,
        durationMs,
        fast,
        sessionId,
        baseHead: run.base_head_sha,
        producedHead,
        dsh: counts,
        terminal,
        turnReason,
      },
    });
    return finalRun;
  })().finally(() => {
    // The coroutine is done: it can no longer write the terminal row. Keep the
    // in-process state for this pass and clear the durable launcher lease, so a
    // failed terminal write is retried by the next liveness sweep instead of
    // being held by a launcher PID that will never write again.
    endRunLaunch(runId);
    releaseRunLauncher(db, runId);
  });

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
 *     Run recorded;
 *   - the LIVE task has moved: its phase/attempt changed, its branch is bound to
 *     a different branch, or its head is bound to a revision other than the Run's
 *     START head.
 * A task with no linked branch/head YET (the normal implement phase) adopts the
 * Run's produced branch/head; the Run's own `base_head_sha` is the staleness
 * fence. A process `exit 0` or the Run's final stdout text does NOT call this.
 */
export function acceptRunSubmission(db: Database, sub: RunSubmission): Run {
  const run = getRun(db, sub.runId);
  if (!run) rejectSubmission(`unknown run: ${sub.runId}`);

  if (run.state !== "exited" || run.exit_code !== 0) {
    rejectSubmission(
      `run ${run.id} is '${run.state}'${run.exit_code === null ? "" : ` (exit ${run.exit_code})`}; only a clean exit 0 can be submitted`
    );
  }
  // ISH-760: the Run must be the CURRENT writer for its (task, phase, attempt).
  // A newer Run for the same work supersedes it, so a late result from an older
  // Run can never advance the Task.
  const latest = db
    .query(
      `SELECT id FROM runs WHERE task_id = ? AND phase = ? AND attempt = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(run.task_id, run.phase, run.attempt) as { id: string } | null;
  if (latest && latest.id !== run.id) {
    rejectSubmission(`run ${run.id} was superseded by ${latest.id} for ${run.task_id} ${run.phase}/${run.attempt}`);
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
  // ISH-808: a terminal task is CLOSED. An in-flight Run's `exit 0` (or a Run
  // started before the cancel) must never resurrect it into queued/review.
  if (isTerminalTaskState(task.state)) {
    rejectSubmission(`run ${run.id} cannot advance task ${task.id}: it is terminal (state=${task.state})`);
  }
  if (task.phase !== run.phase || task.attempt !== run.attempt) {
    rejectSubmission(
      `run ${run.id} is stale: task ${task.id} is now phase '${task.phase ?? "none"}' attempt ${task.attempt}`
    );
  }
  // Branch: a task with no branch yet ADOPTS the Run's (the normal implement
  // case — the branch is not linked until a PR is); an already-bound task must
  // match what the Run produced.
  if (task.branch !== null && task.branch !== run.branch) {
    rejectSubmission(
      `run ${run.id} is stale: task branch is ${task.branch ?? "none"}, run produced ${run.branch ?? "none"}`
    );
  }
  // HEAD fence: the Run started at `run.base_head_sha`. A task whose head is
  // already bound to a DIFFERENT revision has moved since the Run started, so
  // the Run can never advance the current attempt. A NULL task head is "not yet
  // bound" and adopts the Run's produced head.
  if (task.head_sha !== null && (run.base_head_sha ?? null) !== task.head_sha) {
    rejectSubmission(
      `run ${run.id} is stale: task head is ${task.head_sha}, run started at ${run.base_head_sha ?? "none"}`
    );
  }

  const impl: RunImplementation = {
    runId: run.id,
    phase: run.phase,
    attempt: run.attempt,
    branch: run.branch,
    // The PRODUCED head (the revision the Run committed); `baseHeadSha` is the
    // pre-run fence the workflow checks against the task.
    headSha: run.head_sha,
    baseHeadSha: run.base_head_sha,
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
