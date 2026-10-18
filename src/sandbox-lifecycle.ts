import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defaultDbPath, now, projectRoot } from "./db";
import { logEvent } from "./events";
import { getTask } from "./tasks";
import type { Run, RunState, Sandbox, Task } from "./schema";
import { isTerminalTaskState } from "./schema";
import {
  bunDshSpawner,
  DEFAULT_FAST_EXIT_MS,
  DEFAULT_PERMISSION_MODE,
  getRun,
  acceptRunSubmission,
  type DshProcess,
  type DshSpawner,
  type RunSubmission,
} from "./dsh-runner";
import {
  countDshLine,
  dshSessionId,
  emptyDshCounts,
  parseDshLine,
  turnEndReason,
  type DshEvent,
  type DshEventCounts,
} from "./dsh-events";
import { buildRunBrief, inheritFindings, taskBranchName, type RunFinding } from "./run-lifecycle";
import { spawnIdentityToken } from "./proc-identity";
import { childEnv } from "./child-env";
import { isPinnedDsh, PINNED_DSH_VERSION } from "./dsh-version";
import { labOwnerId, LAB_OWNER_ASSIGNED_EVENT } from "./lab-cleanup";
import {
  DUPLICATE_SANDBOX_WRITER,
  SANDBOX_ERROR,
  bashLc,
  getSandbox,
  hostGit,
  logSandbox,
  realSbxCli,
  resolveMainCheckout,
  sandboxNameForTask,
  sandboxRemote,
  sbxCreateArgv,
  sbxExecArgv,
  sbxSandboxState,
  updateSandboxState,
  upsertSandbox,
  type SbxCli,
} from "./sandbox";

/**
 * ISH-828 — Task-scoped Coding Sandbox lifecycle.
 *
 * One Task owns ONE Docker Sandboxes clone-mode sandbox (a private in-container
 * Git clone). A Run/attempt is a fresh `dsh --profile headless --json` process
 * started INSIDE that sandbox via `sbx exec`. This module composes the thin
 * `sbx` boundary (`src/sandbox.ts`), ISH-810's dsh JSONL decoder
 * (`src/dsh-events.ts`) and ISH-760's findings inheritance / submission fences
 * (`src/run-lifecycle.ts`, `src/dsh-runner.ts`). It does NOT reimplement the
 * phase machine, the dsh decoder or the sbx CLI.
 *
 * Durable vs disposable:
 *   - DURABLE: the Task and its Coding Sandbox (name / branch / HEAD mapping in
 *     SQLite). A FIX re-enters the SAME sandbox.
 *   - DISPOSABLE: one `sbx exec … dsh` process per phase/attempt. Its stdout /
 *     stderr / dsh JSONL / Relay events are per-Run evidence on the host and are
 *     NEVER deleted by sandbox cleanup.
 *
 * Fail-closed:
 *   - the local `sbx exec` client exiting is NOT the same as the in-VM dsh
 *     ending; a cancel/timeout kills the client and then probes (and stops) the
 *     in-VM process, recording `orphaned` rather than pretending success;
 *   - a Run only becomes `exited` when the produced commit was fetched back to
 *     the host (`git fetch sandbox-<name>`); a fetch failure is `failed`;
 *   - cleanup removes the VM only AFTER the produced commit and every Run's log
 *     directory are confirmed saved; otherwise it refuses.
 */

/**
 * ISH-869: `PINNED_DSH_VERSION` / `isPinnedDsh` live in the shared
 * `src/dsh-version.ts` (one constant for BOTH the host runner and the sandbox).
 * Re-exported here so existing sandbox imports keep working.
 */
export { isPinnedDsh, PINNED_DSH_VERSION } from "./dsh-version";

const ORPHANED = "orphaned";

/**
 * The pattern that identifies the in-VM dsh process, written SELF-EXCLUDING: the
 * bracket makes the regex NOT match the literal `[d]sh …` text inside the probe
 * (or pkill) command's own argv. Without it, on Linux `pgrep -f 'dsh --profile
 * headless'` matches the `bash -lc …` line that is running the probe itself and
 * always reports ALIVE (round-3 finding 1).
 */
export const DSH_PROC_PATTERN = "[d]sh --profile headless";

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
// Sandbox ensure (create / select / own)
// ---------------------------------------------------------------------------

export interface EnsureSandboxOptions {
  /** The MAIN host checkout to `--clone` from (default the repo main checkout). */
  source?: string;
  /** Agent or sandbox-kit reference (default `shell`, or $RELAY_SANDBOX_AGENT). */
  agent?: string;
  cpus?: number;
  memory?: string;
  /** Test seam. */
  cli?: SbxCli;
}

export interface SandboxBinding {
  taskId: string;
  name: string;
  agent: string;
  source: string;
  workspace: string;
  branch: string;
  created: boolean;
  state: Sandbox["state"];
}

function assertCodeChange(task: Task | null, taskId: string): asserts task is Task {
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (task.code_change !== 1) {
    throw new Error(`${SANDBOX_ERROR}: task ${taskId} is not a code-change task; a sandbox Run implements a code task`);
  }
}

/**
 * Create (or SELECT and reuse) the single Coding Sandbox a Task owns.
 *
 * Idempotent: a live mapping is reused as-is (this is what makes a FIX the SAME
 * sandbox + a NEW dsh Run). Create path: `sbx create --clone --name <name>
 * <agent> <main-checkout>`, then ensure the Task branch exists inside the clone.
 * `--clone` is refused for a linked worktree source.
 */
export function ensureTaskSandbox(db: Database, taskId: string, opts: EnsureSandboxOptions = {}): SandboxBinding {
  const task = getTask(db, taskId);
  assertCodeChange(task, taskId);
  const cli = opts.cli ?? realSbxCli;

  // Guard: `--clone` must not be handed a linked git worktree.
  const sourceHint = resolve(opts.source ?? projectRoot());
  const mc = resolveMainCheckout(sourceHint);
  if (!mc) throw new Error(`${SANDBOX_ERROR}: ${sourceHint} is not a git checkout`);
  if (!mc.isMain) {
    throw new Error(
      `${SANDBOX_ERROR}: ${sourceHint} is a linked git worktree; \`sbx create --clone\` must run from the MAIN checkout (${mc.root})`
    );
  }
  const source = mc.root;

  const live = getSandbox(db, taskId);
  if (live && live.state !== "removed" && live.state !== "failed") {
    const st = sbxSandboxState(cli, live.name);
    // Finding 6: a LISTING FAILURE is not "no sandboxes". Fail closed: do not
    // mark the mapping lost, and do not risk recreating a name that may exist.
    if (!st.ok) {
      throw new Error(
        `${SANDBOX_ERROR}: could not list sandboxes while reusing ${live.name} (${st.error}); refusing to recreate it`
      );
    }
    if (st.present) {
      const branch = live.branch ?? task.branch ?? taskBranchName(task);
      // A stopped sandbox is still reusable; `sbx exec` starts it again.
      const state = live.state === "stopped" ? "stopped" : "running";
      const refreshed = updateSandboxState(db, taskId, { workspace: source, branch, state });
      logSandbox(db, taskId, "sandbox.selected", { name: live.name, branch, source, state });
      return {
        taskId,
        name: live.name,
        agent: live.agent,
        source: live.source,
        workspace: refreshed?.workspace ?? source,
        branch,
        created: false,
        state,
      };
    }
    // Confirmed absent: the mapping says live, sbx no longer knows it.
    updateSandboxState(db, taskId, { state: "failed" });
    logSandbox(db, taskId, "sandbox.lost", { name: live.name });
  }

  const agent = opts.agent ?? process.env.RELAY_SANDBOX_AGENT ?? "shell";
  const name = live?.name ?? sandboxNameForTask(task);
  const branch = task.branch ?? taskBranchName(task);
  upsertSandbox(db, { taskId, name, agent, source, workspace: source, branch, state: "creating" });

  const created = cli.run(sbxCreateArgv({ name, agent, source, cpus: opts.cpus, memory: opts.memory }));
  if (!created.ok) {
    updateSandboxState(db, taskId, { state: "failed" });
    logSandbox(db, taskId, "sandbox.create_failed", { name, agent, source, error: created.err || created.out });
    throw new Error(`${SANDBOX_ERROR}: sbx create --clone failed for ${taskId}: ${(created.err || created.out).slice(0, 300)}`);
  }

  // The clone mirrors the host path inside the VM (ISH-822). Put it on the Task
  // branch so every Run commits onto the branch Relay later fetches. Finding 3: a
  // failed branch setup is FATAL — a Run must never commit onto an unrelated
  // branch and be recorded with the wrong produced HEAD.
  if (!ensureSandboxBranch(cli, name, source, branch)) {
    updateSandboxState(db, taskId, { state: "failed" });
    logSandbox(db, taskId, "sandbox.branch_failed", { name, source, branch });
    throw new Error(`${SANDBOX_ERROR}: could not check out branch ${branch} in sandbox ${name}`);
  }
  const binding = updateSandboxState(db, taskId, { state: "running", workspace: source, branch });
  logSandbox(db, taskId, "sandbox.created", { name, agent, source, branch, output: created.out.slice(0, 500) });
  return { taskId, name, agent, source, workspace: binding?.workspace ?? source, branch, created: true, state: "running" };
}

/**
 * Ensure `branch` exists in the sandbox clone and is checked out. Returns false on
 * any failure (the caller treats that as fatal — see finding 3).
 */
function ensureSandboxBranch(cli: SbxCli, name: string, workspace: string, branch: string): boolean {
  const script = `git rev-parse --verify --quiet refs/heads/${branch} >/dev/null && git checkout ${branch} || git checkout -b ${branch}`;
  const r = cli.run(sbxExecArgv(name, bashLc(script), { workdir: workspace }));
  if (!r.ok) return false;
  // Confirm the clone is actually ON the branch (a compound `&& ||` can exit 0
  // for the wrong reason, so verify rather than trust the exit code).
  const cur = cli.run(sbxExecArgv(name, ["git", "rev-parse", "--abbrev-ref", "HEAD"], { workdir: workspace }));
  return cur.ok && cur.out.trim() === branch;
}

/**
 * ISH-830e: make the pinned `.relay/` directory (the Run brief) invisible to the
 * sandbox clone's `git status`, mirroring the host worktree's `ensureRelayExcluded`.
 * The brief pin is untracked; a repo without `.relay/` in its tracked `.gitignore`
 * would otherwise be "dirty", and the VERIFY clean-tree fence (`sandboxTreeState`)
 * would fail closed with `not_run` — the Factory then blocks with `verify not_run`
 * and the review leg is never reached. Best-effort: a failure never blocks the Run.
 */
export function ensureSandboxRelayExcluded(cli: SbxCli, name: string, workspace: string): void {
  const script = [
    "mkdir -p .relay",
    "g=$(git rev-parse --path-format=absolute --git-common-dir)",
    'mkdir -p "$g/info"',
    `grep -qxF '.relay/' "$g/info/exclude" 2>/dev/null || printf '.relay/\\n' >> "$g/info/exclude"`,
  ].join(" && ");
  cli.run(sbxExecArgv(name, bashLc(script), { workdir: workspace }));
}

/** The in-clone HEAD (used as the Run's base/staleness fence). */
export function sandboxHead(cli: SbxCli, name: string, workspace: string): string | null {
  const r = cli.run(sbxExecArgv(name, ["git", "rev-parse", "HEAD"], { workdir: workspace }));
  const sha = r.ok ? r.out.trim().split(/\s+/)[0] : "";
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

/** The dsh version inside the sandbox, or null when dsh is not installed. */
export function sandboxDshVersion(cli: SbxCli, name: string, opts: { workdir?: string; dshBin?: string } = {}): string | null {
  const bin = opts.dshBin ?? "dsh";
  const r = cli.run(sbxExecArgv(name, [bin, "--version"], { workdir: opts.workdir }));
  if (!r.ok) return null;
  return (r.out || r.err).trim().split("\n")[0] || null;
}

export interface PrepareSandboxOptions {
  dshVersion?: string;
  installDsh?: boolean;
  /** The in-VM dsh executable to probe/install (default `dsh`). */
  dshBin?: string;
  cli?: SbxCli;
}

/**
 * Ensure a usable dsh inside the sandbox. When it is missing and `installDsh`
 * is set (default true), install the pinned ISH-869 build. Never installs into
 * the host — the command runs inside the VM.
 *
 * The returned `version` is whatever `dsh --version` reports after the attempt;
 * the caller MUST check it with `isPinnedDsh` — a sandbox left on an older build
 * must never be treated as a successful start (ISH-869).
 */
export function prepareSandboxDsh(
  binding: SandboxBinding,
  opts: PrepareSandboxOptions = {}
): { version: string | null; installed: boolean } {
  const cli = opts.cli ?? realSbxCli;
  const want = opts.dshVersion ?? PINNED_DSH_VERSION;
  // ISH-869 finding 2: probe and install the SAME binary the Run will spawn, so
  // the guard can never bless a different executable than the one that runs.
  const bin = opts.dshBin ?? "dsh";
  const have = sandboxDshVersion(cli, binding.name, { workdir: binding.workspace, dshBin: bin });
  if (have && isPinnedDsh(have, want)) return { version: have, installed: false };
  if (opts.installDsh === false) return { version: have, installed: false };
  const r = cli.run(
    sbxExecArgv(binding.name, bashLc(`npm i -g @deepseek-ai/dsh@${want} >/dev/null 2>&1 && ${bin} --version`), {
      workdir: binding.workspace,
    }),
    { timeoutMs: 15 * 60_000 }
  );
  if (!r.ok) return { version: have, installed: false };
  const v = (r.out || "").trim().split("\n").pop() ?? null;
  return { version: v, installed: true };
}

// ---------------------------------------------------------------------------
// Single-writer (a second writer into the same sandbox is refused)
// ---------------------------------------------------------------------------

export interface ActiveSandboxWriterQuery {
  sandboxName: string;
  branch?: string | null;
  excludeRunId?: string;
}

/** The non-terminal Run that already holds this sandbox (or Task branch). */
export function findActiveSandboxWriter(db: Database, q: ActiveSandboxWriterQuery): Run | null {
  const rows = db
    .query(`SELECT * FROM runs WHERE state IN ('starting','running') ORDER BY created_at DESC, rowid DESC`)
    .all() as Run[];
  for (const r of rows) {
    if (q.excludeRunId && r.id === q.excludeRunId) continue;
    const sameSandbox = !!r.sandbox_name && r.sandbox_name === q.sandboxName;
    const sameBranch = !!(q.branch && r.branch && q.branch === r.branch && !r.sandbox_name);
    if (sameSandbox || sameBranch) return r;
  }
  return null;
}

export function assertNoActiveSandboxWriter(db: Database, q: ActiveSandboxWriterQuery): void {
  const conflict = findActiveSandboxWriter(db, q);
  if (conflict) {
    throw new Error(
      `${DUPLICATE_SANDBOX_WRITER}: run ${conflict.id} is still '${conflict.state}' in sandbox ${q.sandboxName}; wait for it to end or \`relay run cancel ${conflict.id}\``
    );
  }
}

// ---------------------------------------------------------------------------
// Fetch the produced commit back to the host
// ---------------------------------------------------------------------------

export interface FetchedHead {
  ok: boolean;
  sha: string | null;
  remote: string;
  error?: string;
}

/**
 * `git fetch sandbox-<name>` in the MAIN checkout and resolve the produced HEAD.
 * This is the ONLY way a sandbox Run's commit reaches the host; a failure means
 * the Run cannot be submitted and must fail closed.
 *
 * Finding 3: when a `branch` is given, the produced HEAD is ONLY
 * `<remote>/<branch>`. There is NO `FETCH_HEAD` fallback — `git fetch` may write
 * FETCH_HEAD to whatever ref it saw first, so accepting it could record an
 * unrelated commit as the Task branch's head.
 */
export function fetchSandboxHead(source: string, name: string, branch: string | null): FetchedHead {
  const remote = sandboxRemote(name);
  const fetched = hostGit(source, ["fetch", remote]);
  if (!fetched.ok) {
    return { ok: false, sha: null, remote, error: `git fetch ${remote} failed: ${(fetched.err || fetched.out).slice(0, 200)}` };
  }
  if (branch) {
    const r = hostGit(source, ["rev-parse", `${remote}/${branch}`]);
    if (r.ok && /^[0-9a-f]{7,40}$/.test(r.out.trim())) return { ok: true, sha: r.out.trim(), remote };
    return { ok: false, sha: null, remote, error: `no ref ${remote}/${branch} after fetch` };
  }
  const fh = hostGit(source, ["rev-parse", "FETCH_HEAD"]);
  if (fh.ok && /^[0-9a-f]{7,40}$/.test(fh.out.trim())) return { ok: true, sha: fh.out.trim(), remote };
  return { ok: false, sha: null, remote, error: `no ref for ${remote} (no branch bound)` };
}

// ---------------------------------------------------------------------------
// Launch: one disposable dsh Run INSIDE the durable sandbox
// ---------------------------------------------------------------------------

export interface LaunchSandboxOptions extends EnsureSandboxOptions {
  outputRoot?: string;
  /** The in-VM dsh executable (default `dsh`). */
  dshBin?: string;
  prompt?: string;
  permissionMode?: string;
  timeoutMs?: number;
  fastExitMs?: number;
  /** Extra `sbx exec -e` env for the Run (never the whole host env). */
  env?: Record<string, string>;
  /**
   * Extra dsh arguments inserted before `--json` (operator provider overlay, e.g.
   * `["--patch", "/home/agent/dsh-overlay.yml"]`). Provider config is the
   * operator's, not Relay's.
   */
  dshArgs?: string[];
  installDsh?: boolean;
  /** The sbx executable (default `sbx`, or $RELAY_SBX_BIN). */
  sbxBin?: string;
  /** Test seam for the `sbx exec … dsh` process. */
  spawner?: DshSpawner;
}

export interface SandboxRunHandle {
  readonly id: string;
  wait(): Promise<Run>;
  cancel(reason?: string): void;
}

export interface LaunchedSandboxRun {
  handle: SandboxRunHandle;
  run: Run;
  sandbox: SandboxBinding;
  briefPath: string | null;
  findings: RunFinding[];
}

interface InsertSandboxRunInput {
  id: string;
  taskId: string;
  phase: string;
  attempt: number;
  sandboxName: string;
  cwd: string;
  branch: string | null;
  baseHeadSha: string | null;
  prompt: string;
  specPath: string;
  outputDir: string;
  stdoutPath: string;
  stderrPath: string;
  eventsPath: string;
  dshEventsPath: string;
}

function insertSandboxRunIfNoWriter(db: Database, r: InsertSandboxRunInput): Run {
  return db
    .transaction(() => {
      assertNoActiveSandboxWriter(db, { sandboxName: r.sandboxName, branch: r.branch });
      const t = now();
      db.query(
        `INSERT INTO runs
           (id, task_id, phase, attempt, generation, cwd, branch, head_sha, base_head_sha, prompt,
            spec_path, output_dir, state, stdout_path, stderr_path, events_path, dsh_events_path,
            sandbox_name, fast_exit, started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, 0, ?, ?, ?)`
      ).run(
        r.id,
        r.taskId,
        r.phase,
        r.attempt,
        r.attempt,
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
        r.sandboxName,
        t,
        t,
        t
      );
      return getRun(db, r.id)!;
    })
    .immediate();
}

interface RunPatchFull {
  state?: RunState;
  pid?: number;
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

function patchRun(db: Database, id: string, patch: RunPatchFull): Run {
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

/** Liveness of the in-VM dsh: a probe failure is `unknown`, never `gone`. */
export type DshLiveness = "alive" | "gone" | "unknown";

/**
 * Three-state liveness of the in-VM dsh. `unknown` covers a probe transport
 * failure (`sbx exec` returned non-zero) OR output with neither marker. Callers
 * MUST treat `unknown` as `alive` (fail closed): a probe failure must never admit
 * a second writer into the same clone (round-3 finding 2).
 */
export function sandboxDshState(cli: SbxCli, name: string): DshLiveness {
  const r = cli.run(
    sbxExecArgv(name, bashLc(`pgrep -f '${DSH_PROC_PATTERN}' >/dev/null && echo ALIVE || echo GONE`))
  );
  if (!r.ok) return "unknown";
  const out = r.out ?? "";
  if (out.includes("ALIVE")) return "alive";
  if (out.includes("GONE")) return "gone";
  return "unknown";
}

/** Back-compat boolean: only a confirmed `gone` is false (see `sandboxDshState`). */
export function sandboxDshAlive(cli: SbxCli, name: string): boolean {
  return sandboxDshState(cli, name) !== "gone";
}

/**
 * Ensure the Task's sandbox, pin the brief, and launch ONE disposable headless
 * dsh Run inside it. Throws `DUPLICATE_SANDBOX_WRITER` while another Run still
 * holds the sandbox. The atomic guard is the `BEGIN IMMEDIATE` insert below.
 */
export async function launchTaskSandboxRun(
  db: Database,
  taskId: string,
  opts: LaunchSandboxOptions = {}
): Promise<LaunchedSandboxRun> {
  const task = getTask(db, taskId);
  assertCodeChange(task, taskId);
  if (isTerminalTaskState(task.state)) {
    throw new Error(`${SANDBOX_ERROR}: cannot start a Run for ${task.id}: task is terminal (state=${task.state})`);
  }
  if (task.phase !== "implement" && task.phase !== "integration") {
    throw new Error(`${SANDBOX_ERROR}: task ${task.id} is in phase '${task.phase ?? "none"}' (a Run starts in implement/integration)`);
  }
  const cli = opts.cli ?? realSbxCli;
  const binding = ensureTaskSandbox(db, taskId, opts);

  // Refuse BEFORE pinning/writing when the sandbox already has a live writer.
  assertNoActiveSandboxWriter(db, { sandboxName: binding.name, branch: binding.branch });

  const dsh = prepareSandboxDsh(binding, { installDsh: opts.installDsh, cli, dshBin: opts.dshBin });
  logSandbox(db, taskId, "sandbox.dsh", { name: binding.name, version: dsh.version, installed: dsh.installed });
  // ISH-869 fail-closed: a sandbox still on an OLD dsh (e.g. the 0.2.0-rc.2
  // baseline left by an earlier Task) must NOT be started as a success. There is
  // one pinned build; a mismatch refuses the Run rather than silently running the
  // stale one.
  if (!isPinnedDsh(dsh.version)) {
    const got = dsh.version ?? "none";
    logSandbox(db, taskId, "sandbox.dsh.version_mismatch", { name: binding.name, want: PINNED_DSH_VERSION, got });
    throw new Error(
      `${SANDBOX_ERROR}: sandbox ${binding.name} has dsh ${got}, but Relay pins @deepseek-ai/dsh@${PINNED_DSH_VERSION}; ` +
        `refusing to start a Run (an old version is never a silent pass)`
    );
  }

  const outputRoot = opts.outputRoot ?? join(dirname(defaultDbPath()), "runs");
  const runId = `run-${crypto.randomUUID().slice(0, 8)}`;
  const runDir = join(outputRoot, runId);
  mkdirSync(runDir, { recursive: true });
  const stdoutPath = join(runDir, "stdout.log");
  const stderrPath = join(runDir, "stderr.log");
  const eventsPath = join(runDir, "events.jsonl");
  const dshEventsPath = join(runDir, "dsh.jsonl");
  const specPath = join(runDir, "spec.md");

  const fresh = getTask(db, taskId)!;
  const findings = inheritFindings(db, fresh);
  const brief = buildRunBrief(db, fresh, { worktree: binding.workspace, branch: binding.branch, findings });
  const briefText = [
    brief.text,
    "",
    "## Coding Sandbox",
    `You are running inside a private Docker Sandboxes clone (sandbox ${binding.name}).`,
    `The clone is at ${binding.workspace} on branch ${binding.branch}. Commit your change on this branch; Relay fetches it back to the host.`,
  ].join("\n");
  writeFileSync(specPath, `${briefText}\n`);
  writeFileSync(stdoutPath, "");
  writeFileSync(stderrPath, "");
  writeFileSync(dshEventsPath, "");

  const events = (e: Record<string, unknown>): void => {
    appendFileSync(eventsPath, `${JSON.stringify({ ts: now(), ...e })}\n`);
  };

  // Pin the brief into the clone BEFORE launch (best-effort: the same text is
  // passed to dsh as the prompt, so a cp failure never hides the contract).
  let briefPath: string | null = null;
  const briefDest = join(binding.workspace, ".relay", "run-brief.md");
  // `sbx cp` tar-extracts into the destination dir, which must already exist.
  // ISH-830e: also make `.relay/` invisible to the clone's `git status` (via
  // `.git/info/exclude`, mirroring the host worktree). The pin is untracked; a
  // fixture repo without `.relay/` in its tracked `.gitignore` would otherwise be
  // "dirty", and the VERIFY clean-tree fence would fail closed with `not_run`.
  ensureSandboxRelayExcluded(cli, binding.name, binding.workspace);
  const cp = cli.run(["cp", specPath, `${binding.name}:${briefDest}`]);
  if (cp.ok) briefPath = briefDest;
  else events({ t: "sandbox.brief_pin_failed", error: cp.err || cp.out });

  const baseHead = sandboxHead(cli, binding.name, binding.workspace);

  const run = insertSandboxRunIfNoWriter(db, {
    id: runId,
    taskId,
    phase: fresh.phase ?? "implement",
    attempt: fresh.attempt,
    sandboxName: binding.name,
    cwd: binding.workspace,
    branch: binding.branch,
    baseHeadSha: baseHead,
    prompt: briefText,
    specPath,
    outputDir: runDir,
    stdoutPath,
    stderrPath,
    eventsPath,
    dshEventsPath,
  });

  events({ t: "run.started", runId, taskId, sandbox: binding.name, phase: run.phase, attempt: run.attempt, baseHead });
  logSandbox(db, taskId, "sandbox.run.started", { runId, sandbox: binding.name, phase: run.phase, attempt: run.attempt, baseHead });

  const permissionMode = opts.permissionMode ?? DEFAULT_PERMISSION_MODE;
  const fastExitMs = opts.fastExitMs ?? DEFAULT_FAST_EXIT_MS;
  const dshBin = opts.dshBin ?? "dsh";
  const runArgv = [dshBin, "--profile", "headless", ...(opts.dshArgs ?? []), "--json", briefText];
  // ISH-845: record the Task's external Lab owner id durably as it is handed to
  // the sandbox, so `planLabCleanup` can tell a Lab-using Task from one that
  // never had an owner (and never issues a spurious external cleanup call).
  const labOwner = labOwnerId(fresh);
  logEvent(db, {
    source: "lab-cleanup",
    taskId,
    type: LAB_OWNER_ASSIGNED_EVENT,
    payload: { ownerId: labOwner, sandbox: binding.name, phase: run.phase, attempt: run.attempt },
  });
  const execEnv: Record<string, string> = {
    DSH_PERMISSION_MODE: permissionMode,
    RELAY_RUN_ID: runId,
    RELAY_TASK_ID: taskId,
    // The `network-lab` skill uses it as the lab `--namespace`/`name:`, so Relay
    // can later clean up exactly this Task's labs (and nothing else).
    RELAY_LAB_OWNER: labOwner,
    ...(opts.env ?? {}),
  };
  const sbxBin = opts.sbxBin ?? process.env.RELAY_SBX_BIN ?? "sbx";
  const argv = [sbxBin, ...sbxExecArgv(binding.name, runArgv, { workdir: binding.workspace, env: execEnv })];
  const spawner = opts.spawner ?? bunDshSpawner;

  let proc: DshProcess;
  try {
    // ISH-828 finding 8: the sbx client gets the small child allowlist, not all
    // of process.env. Only the explicit -e values above enter the VM.
    proc = spawner.spawn(argv, { cwd: binding.source, env: childEnv() });
  } catch (e) {
    const message = `spawn failed: ${e instanceof Error ? e.message : String(e)}`;
    events({ t: "run.failed", error: message });
    const failed = patchRun(db, runId, { state: "failed", error: message, ended_at: now() });
    logSandbox(db, taskId, "sandbox.run.failed", { runId, error: message });
    return { handle: { id: runId, wait: async () => failed, cancel: () => {} }, run: failed, sandbox: binding, briefPath, findings };
  }

  patchRun(db, runId, { state: "running", pid: proc.pid, spawn_lstart: spawnIdentityToken(proc.pid) });

  let sessionId: string | null = null;
  let cancelReason: string | null = null;
  let settled = false;
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
      events({ t: "dsh.event", type: ev.type, ...(typeof ev.callId === "string" ? { callId: ev.callId } : {}) });
      return;
    }
    if (parsed.kind === "malformed") events({ t: "stdout.malformed", error: parsed.error, v: parsed.raw });
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

  const stopInVmDsh = (): void => {
    // Killing the local client does NOT stop the in-VM dsh; signal it explicitly.
    // The self-excluding pattern keeps pkill from signalling the shell running it.
    try {
      cli.run(sbxExecArgv(binding.name, bashLc(`pkill -f '${DSH_PROC_PATTERN}' || true`)));
    } catch {
      /* best effort */
    }
  };

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

    const external = getRun(db, runId)?.signal ?? null;
    const reason = cancelReason ?? external;
    const durationMs = now() - run.started_at;
    const fast = durationMs < fastExitMs;

    let state: RunState;
    let fetchedHead: string | null = null;
    let fetchError: string | null = null;
    let errorText: string | null = null;

    if (reason === "timeout") state = "timeout";
    else if (reason) state = "cancelled";
    else if (failure) state = "failed";
    else if (exitCode !== 0 || terminal === "error") state = "failed";
    else state = "exited";

    if (state === "exited") {
      // The produced commit must reach the host BEFORE the Run may be submitted.
      const fetched = fetchSandboxHead(binding.source, binding.name, binding.branch);
      if (!fetched.ok) {
        state = "failed";
        fetchError = fetched.error ?? "fetch failed";
      } else {
        fetchedHead = fetched.sha;
      }
    }

    // Finding 2 (round 3): probe the in-VM dsh on EVERY non-`exited` outcome (a
    // non-zero client exit, a transport drop, a cancel or a timeout), not only
    // cancel/timeout. The probe is THREE-state; a failed probe is `unknown` and
    // is treated like `alive`. A dead client with a live/unknown in-VM dsh is an
    // orphan; stop it, and if it is still not confirmed gone leave the row
    // NON-TERMINAL so the single-writer guard blocks a second writer.
    let orphanNote: string | null = null;
    if (state !== "exited") {
      const first = sandboxDshState(cli, binding.name);
      let current = first;
      if (current !== "gone") {
        stopInVmDsh();
        current = sandboxDshState(cli, binding.name);
      }
      if (current !== "gone") {
        const stuckError = `${ORPHANED}: in-VM dsh ${
          current === "unknown" ? "liveness is unknown (probe failed)" : "survived"
        } after ${reason ?? `exit ${exitCode}`}; Run left non-terminal to block a second writer`;
        events({ t: "run.orphaned", reason, leftRunning: true, liveness: current });
        const stuck = patchRun(db, runId, { state: "running", signal: reason, error: stuckError, session_id: sessionId });
        logSandbox(db, taskId, "sandbox.run.orphaned", { runId, sandbox: binding.name, exitCode, reason, leftRunning: true, liveness: current });
        return stuck;
      }
      if (first !== "gone") {
        orphanNote = `in-VM dsh ${
          first === "unknown" ? "liveness was unknown (probe failed)" : "survived"
        } and is now stopped`;
        events({ t: "run.orphaned", reason, stopped: true, firstLiveness: first });
      }
    }

    if (fast) events({ t: "run.fast_exit", durationMs, exitCode });
    events({
      t: "run.exited",
      state,
      exitCode,
      durationMs,
      fast,
      sessionId,
      baseHead: run.base_head_sha,
      producedHead: fetchedHead,
      dsh: counts,
      terminal,
      turnReason,
    });
    errorText =
      (orphanNote ? `${ORPHANED}: ${orphanNote}` : null) ??
      fetchError ??
      failure ??
      (state === "exited" ? null : reason ? `run ${reason}` : terminalError ?? `exit ${exitCode}`);

    const finalRun = patchRun(db, runId, {
      state,
      branch: binding.branch,
      head_sha: fetchedHead,
      exit_code: exitCode,
      signal: reason,
      session_id: sessionId,
      error: errorText,
      fast_exit: fast ? 1 : 0,
      ended_at: now(),
    });
    if (fetchedHead) updateSandboxState(db, taskId, { head_sha: fetchedHead, state: "running" });
    logSandbox(db, taskId, "sandbox.run." + state, {
      runId,
      sandbox: binding.name,
      exitCode,
      durationMs,
      fast,
      sessionId,
      baseHead: run.base_head_sha,
      producedHead: fetchedHead,
      dsh: counts,
      terminal,
      turnReason,
    });
    return finalRun;
  })();

  return {
    handle: {
      id: runId,
      wait: () => done,
      cancel(reason = "cancelled") {
        if (settled || cancelReason) return;
        cancelReason = reason;
        events({ t: "run.cancelled", reason });
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!settled) proc.kill("SIGKILL");
        }, 5000);
      },
    },
    run,
    sandbox: binding,
    briefPath,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Structured submission (sandbox-aware fence on top of ISH-760/810)
// ---------------------------------------------------------------------------

/** Why this Run may not submit into the Task's CURRENT sandbox, or null. */
export function sandboxSubmitterError(run: Run, task: Task, sandbox: Sandbox | null): string | null {
  if (run.task_id !== task.id) return `run ${run.id} belongs to task ${run.task_id}, not ${task.id}`;
  if (!run.sandbox_name) return `run ${run.id} is not a sandbox Run`;
  if (!sandbox) return `task ${task.id} has no recorded sandbox`;
  if (run.sandbox_name !== sandbox.name) {
    return `run ${run.id} ran in sandbox ${run.sandbox_name}, task is bound to ${sandbox.name}`;
  }
  if (run.phase !== task.phase) return `run ${run.id} started in phase '${run.phase}', task is '${task.phase ?? "none"}'`;
  if (run.attempt !== task.attempt) return `run ${run.id} started at attempt ${run.attempt}, task is attempt ${task.attempt}`;
  if (task.branch !== null && run.branch !== task.branch) {
    return `run ${run.id} produced branch ${run.branch ?? "none"}, task is ${task.branch}`;
  }
  if (task.head_sha !== null && (run.base_head_sha ?? null) !== task.head_sha) {
    return `run ${run.id} started at head ${run.base_head_sha ?? "none"}, task is bound to ${task.head_sha}`;
  }
  return null;
}

/**
 * Accept a structured submission from a sandbox Run. Adds the sandbox-identity
 * fence, then delegates to the existing ISH-760/810 `acceptRunSubmission`
 * (which re-validates the live Task and records TaskSubmitted).
 */
export function acceptSandboxSubmission(db: Database, sub: RunSubmission): Run {
  const run = getRun(db, sub.runId);
  if (!run) throw new Error(`RUN_SUBMISSION_REJECTED: unknown run: ${sub.runId}`);
  const task = getTask(db, run.task_id);
  if (!task) throw new Error(`RUN_SUBMISSION_REJECTED: run ${run.id} references missing task ${run.task_id}`);
  const err = sandboxSubmitterError(run, task, getSandbox(db, run.task_id));
  if (err) throw new Error(`RUN_SUBMISSION_REJECTED: ${err}`);
  return acceptRunSubmission(db, sub);
}

// ---------------------------------------------------------------------------
// Restart / orphan sweep (a durable `running` row whose client died)
// ---------------------------------------------------------------------------

/** True when the host `sbx exec` client that started this Run is still this Run. */
export function hostSandboxClientAlive(run: Run): boolean {
  if (!run.pid) return false;
  try {
    process.kill(run.pid, 0);
  } catch {
    return false;
  }
  const lstart = spawnIdentityToken(run.pid);
  return run.spawn_lstart ? lstart === run.spawn_lstart : true;
}

export interface OrphanSweepOptions {
  /** Actually stop the in-VM dsh and mark the Run (default: plan only). */
  apply?: boolean;
  cli?: SbxCli;
  /**
   * Restrict the sweep to a single Run id (the Factory's adoption scopes it to
   * the one Run it adopted, so a concurrent Task's just-inserted `starting` Run
   * is never touched). Omit to sweep every non-terminal sandbox Run (the
   * operator `relay run sandbox sweep`).
   */
  runId?: string;
}

export interface OrphanSweepResult {
  inspected: number;
  orphaned: {
    runId: string;
    taskId: string;
    sandbox: string;
    inVmAlive: boolean;
    stopped: boolean;
    /** True when the in-VM dsh is confirmed gone (the Run was marked terminal). */
    resolved: boolean;
    applied: boolean;
  }[];
}

/**
 * ISH-828 fail-closed on restart: a Relay/host crash can leave a Run row
 * `running` after its local `sbx exec` client is gone. This sweeps such rows
 * (non-terminal, sandbox-backed, host client dead), stops the in-VM dsh when it
 * survived, and marks the Run `failed` with an `orphaned` error — never a
 * success. Dry-run by default; `apply: true` performs the transition.
 *
 * Round-3 finding 3: after `pkill` the sweep RE-PROBES. The Run is marked
 * terminal only when the dsh is confirmed `gone`; a still-alive (or `unknown`)
 * dsh leaves the row non-terminal and reports `stopped:false`.
 */
export function sweepOrphanedSandboxRuns(db: Database, opts: OrphanSweepOptions = {}): OrphanSweepResult {
  const cli = opts.cli ?? realSbxCli;
  const apply = opts.apply === true;
  const rows = (
    opts.runId
      ? db
          .query(`SELECT * FROM runs WHERE id = ? AND state IN ('starting','running') AND sandbox_name IS NOT NULL`)
          .all(opts.runId)
      : db.query(`SELECT * FROM runs WHERE state IN ('starting','running') AND sandbox_name IS NOT NULL`).all()
  ) as Run[];
  const result: OrphanSweepResult = { inspected: rows.length, orphaned: [] };
  for (const run of rows) {
    if (hostSandboxClientAlive(run)) continue;
    const sandbox = run.sandbox_name!;
    const before = sandboxDshState(cli, sandbox);
    let stopped = false;
    let resolved = before === "gone";
    if (apply) {
      if (!resolved) {
        cli.run(sbxExecArgv(sandbox, bashLc(`pkill -f '${DSH_PROC_PATTERN}' || true`)));
        const after = sandboxDshState(cli, sandbox);
        if (after === "gone") {
          resolved = true;
          stopped = true;
        }
      }
      if (resolved) {
        patchRun(db, run.id, {
          state: "failed",
          error: `orphaned: no live sbx exec client${stopped ? " (in-VM dsh stopped)" : ""}`,
          ended_at: now(),
        });
      } else {
        // The in-VM dsh is still alive (or its liveness is unknown): keep the row
        // non-terminal so the single-writer guard still blocks a second writer.
        patchRun(db, run.id, {
          error: `orphaned: in-VM dsh still ${before === "unknown" ? "unknown" : "alive"} after pkill; Run left non-terminal`,
        });
      }
      logSandbox(db, run.task_id, "sandbox.run.orphaned", {
        runId: run.id,
        sandbox,
        livenessBefore: before,
        stopped,
        resolved,
      });
    }
    result.orphaned.push({
      runId: run.id,
      taskId: run.task_id,
      sandbox,
      inVmAlive: before !== "gone",
      stopped,
      resolved,
      applied: apply,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Safe sandbox cleanup (evidence-retaining, fail-closed)
// ---------------------------------------------------------------------------

export interface SandboxCleanupOptions {
  apply?: boolean;
  force?: boolean;
  /** Explicit abort reason: cleanup without a real merge. */
  abort?: string;
  cli?: SbxCli;
}

export interface SandboxCleanupPlan {
  taskId: string;
  name: string | null;
  branch: string | null;
  /** The produced commit confirmed saved on the host (or null when none). */
  savedHead: string | null;
  remove: boolean;
  apply: boolean;
  reasons: string[];
  removed: boolean;
  retainedRuns: number;
}

/**
 * Plan (and, with `apply`, perform) a SAFE sandbox teardown. Removal is allowed
 * only when the Task is really merged OR explicitly aborted; no Run still holds
 * the sandbox; and every Run's log directory still exists on the host. The
 * `runs` rows and their output dirs are RETAINED as evidence.
 *
 * Finding 4: the produced commit is confirmed SAFE by `applySandboxCleanup`, which
 * `git fetch`es the sandbox immediately before removal — so a Run that committed
 * and then exited non-zero (head_sha never recorded) cannot be silently destroyed.
 * This plan cannot fetch (it is a dry run), so it must not treat a missing
 * `head_sha` as "no commit".
 */
export function planSandboxCleanup(db: Database, taskId: string, opts: SandboxCleanupOptions = {}): SandboxCleanupPlan {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  const sandbox = getSandbox(db, taskId);
  const reasons: string[] = [];
  const runs = db.query(`SELECT * FROM runs WHERE task_id = ?`).all(taskId) as Run[];
  const plan: SandboxCleanupPlan = {
    taskId,
    name: sandbox?.name ?? null,
    branch: sandbox?.branch ?? task.branch,
    savedHead: sandbox?.head_sha ?? null,
    remove: false,
    apply: opts.apply === true,
    reasons,
    removed: false,
    retainedRuns: runs.length,
  };
  if (!sandbox) {
    reasons.push("no recorded sandbox");
    return plan;
  }
  if (sandbox.state === "removed") {
    reasons.push("sandbox already removed");
    return plan;
  }

  const merged = task.merged_at !== null;
  const aborted = !!opts.abort;
  if (!merged && !aborted) {
    if (!isTerminalTaskState(task.state)) reasons.push(`task is not terminal (state=${task.state})`);
    else reasons.push("task is terminal but not merged; pass --abort <reason> to reclaim it");
  }
  if (task.pr_url && !merged && !aborted) reasons.push(`open PR ${task.pr_url}`);

  const active = findActiveSandboxWriter(db, { sandboxName: sandbox.name, branch: sandbox.branch });
  if (active) reasons.push(`active run ${active.id} (${active.state}) still holds sandbox ${sandbox.name}`);

  // Every Run's evidence directory must still exist on the host before teardown.
  for (const r of runs) {
    if (!r.output_dir || !existsSync(r.output_dir)) {
      reasons.push(`run ${r.id} evidence dir is missing (${r.output_dir ?? "none"})`);
    }
  }

  plan.remove = reasons.length === 0;
  return plan;
}

export interface SavedTip {
  ok: boolean;
  tip: string | null;
  savedRef?: string;
  error?: string;
}

/**
 * Fetch the sandbox's branch tip to the host and make sure it can never be lost:
 * if the tip is not already the recorded `head_sha`, pin it under a durable host
 * ref (`refs/relay-sandbox/<name>`) and record it. Returns `ok:false` when the
 * fetch/resolve fails — the caller must then NOT destroy the VM.
 */
export function saveSandboxTip(db: Database, taskId: string, sandbox: Sandbox): SavedTip {
  const remote = sandboxRemote(sandbox.name);
  const fetched = hostGit(sandbox.source, ["fetch", remote]);
  if (!fetched.ok) {
    return { ok: false, tip: null, error: `git fetch ${remote} failed: ${(fetched.err || fetched.out).slice(0, 200)}` };
  }
  let tip: string | null = null;
  if (sandbox.branch) {
    const r = hostGit(sandbox.source, ["rev-parse", `${remote}/${sandbox.branch}`]);
    if (r.ok && /^[0-9a-f]{7,40}$/.test(r.out.trim())) tip = r.out.trim();
  } else {
    const r = hostGit(sandbox.source, ["rev-parse", "FETCH_HEAD"]);
    if (r.ok && /^[0-9a-f]{7,40}$/.test(r.out.trim())) tip = r.out.trim();
  }
  if (!tip) return { ok: true, tip: null };
  if (sandbox.head_sha && tip === sandbox.head_sha) return { ok: true, tip };

  // Not yet saved: pin it under a durable host ref so removal cannot lose it.
  const ref = `refs/relay-sandbox/${sandbox.name}`;
  const upd = hostGit(sandbox.source, ["update-ref", ref, tip]);
  if (!upd.ok) return { ok: false, tip, error: `git update-ref ${ref} failed: ${(upd.err || upd.out).slice(0, 200)}` };
  updateSandboxState(db, taskId, { head_sha: tip });
  return { ok: true, tip, savedRef: ref };
}

export function applySandboxCleanup(db: Database, taskId: string, opts: SandboxCleanupOptions = {}): SandboxCleanupPlan {
  const plan = planSandboxCleanup(db, taskId, opts);
  if (!plan.apply || !plan.name) return plan;
  if (!plan.remove) {
    logSandbox(db, taskId, "sandbox.cleanup_skipped", { name: plan.name, reasons: plan.reasons });
    return plan;
  }
  const cli = opts.cli ?? realSbxCli;
  const sandbox = getSandbox(db, taskId)!;

  // Finding 6: a failed `sbx ls` is not a confirmed absence. Fail closed.
  const st = sbxSandboxState(cli, plan.name);
  if (!st.ok) {
    plan.reasons.push(`sbx ls failed: ${st.error ?? "unknown"}; refusing to assume the sandbox is gone`);
    plan.remove = false;
    return plan;
  }

  // Finding 4: confirm the produced commit is on the host BEFORE destroying the VM.
  // (A confirmed-absent sandbox has nothing to save.)
  let savedRef: string | null = null;
  if (st.present) {
    const saved = saveSandboxTip(db, taskId, sandbox);
    if (!saved.ok) {
      plan.reasons.push(`could not confirm the sandbox commit is saved: ${saved.error ?? "unknown"}`);
      plan.remove = false;
      return plan;
    }
    if (saved.tip) plan.savedHead = saved.tip;
    savedRef = saved.savedRef ?? null;

    cli.run(["stop", plan.name]);
    const rm = cli.run(["rm", "--force", plan.name]);
    if (!rm.ok) {
      plan.reasons.push(`sbx rm failed: ${(rm.err || rm.out).slice(0, 200)}`);
      plan.remove = false;
      return plan;
    }
  }
  updateSandboxState(db, taskId, { state: "removed" });
  plan.removed = true;
  logSandbox(db, taskId, "sandbox.removed", {
    name: plan.name,
    branch: plan.branch,
    abort: opts.abort ?? null,
    savedHead: plan.savedHead,
    savedRef,
    confirmedAbsent: !st.present,
    retainedRuns: plan.retainedRuns,
  });
  return plan;
}
