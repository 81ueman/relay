import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import {
  findTaskResult,
  intakeTask,
  linkTask,
  recordReview,
  recordVerification,
} from "../src/workflow";
import { claimNext, claimTask, cancelTask, getTask } from "../src/tasks";
import { registerWorker } from "../src/workers";
import {
  acceptRunSubmission,
  assertNoActiveWriter,
  DSH_VERSION_MISMATCH,
  findActiveWriter,
  getRun,
  listRuns,
  startDshRun,
  type DshProcess,
  type DshSpawner,
} from "../src/dsh-runner";
import { PINNED_DSH_VERSION } from "../src/dsh-version";

// ISH-803 one-shot headless dsh runner. Everything here drives a FAKE process —
// no real dsh, no network — so the lifecycle (exit / crash / cancel / malformed
// stdout / stderr / fast exit / concurrency) is deterministic.

/** A controllable fake dsh process (streams + exit). */
class FakeProcess implements DshProcess {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number | null>;
  signals: string[] = [];
  private outC!: ReadableStreamDefaultController<Uint8Array>;
  private errC!: ReadableStreamDefaultController<Uint8Array>;
  private resolveExit!: (c: number | null) => void;
  private finished = false;

  constructor(
    pid: number,
    private opts: { reject?: Error } = {}
  ) {
    this.pid = pid;
    this.stdout = new ReadableStream({ start: (c) => (this.outC = c) });
    this.stderr = new ReadableStream({ start: (c) => (this.errC = c) });
    this.exited = new Promise<number | null>((res, rej) => {
      this.resolveExit = (c) => (this.opts.reject ? rej(this.opts.reject) : res(c));
    });
  }

  writeOut(s: string): void {
    this.outC.enqueue(new TextEncoder().encode(s));
  }
  writeErr(s: string): void {
    this.errC.enqueue(new TextEncoder().encode(s));
  }
  /** End the process with `code` (idempotent). */
  finish(code: number | null): void {
    if (this.finished) return;
    this.finished = true;
    try {
      this.outC.close();
    } catch {
      /* noop */
    }
    try {
      this.errC.close();
    } catch {
      /* noop */
    }
    this.resolveExit(code);
  }
  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    this.signals.push(signal);
    this.finish(143);
  }
}

class FakeSpawner implements DshSpawner {
  procs: FakeProcess[] = [];
  argv: string[][] = [];
  envs: Record<string, string>[] = [];
  cwds: string[] = [];
  onSpawn?: (p: FakeProcess, argv: string[], opts: { cwd: string; env: Record<string, string> }) => void;
  throwOnSpawn?: Error;

  spawn(argv: string[], opts: { cwd: string; env: Record<string, string> }): DshProcess {
    if (this.throwOnSpawn) throw this.throwOnSpawn;
    const p = new FakeProcess(10_000 + this.procs.length);
    this.procs.push(p);
    this.argv.push(argv);
    this.envs.push(opts.env);
    this.cwds.push(opts.cwd);
    this.onSpawn?.(p, argv, opts);
    return p;
  }
}

let dir = "";
let db: Database;
/** Dir for fake `dsh` executables the host-runner tests use (ISH-869). */
let dshBinDir = "";

/**
 * Write a fake host `dsh` that answers `--version` with `version` (or with a
 * non-zero exit when `version` is null) and is otherwise inert.
 */
function fakeDshBin(name: string, version: string | null): string {
  const p = join(dshBinDir, name);
  const body =
    version === null
      ? "exit 2\n"
      : `if [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\nexit 0\n`;
  writeFileSync(p, `#!/bin/sh\n${body}`);
  chmodSync(p, 0o755);
  return p;
}

let prevMinFreeDisk: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-dsh-run-"));
  process.env.RELAY_DB = join(dir, "state.db");
  // ISH-1009: these tests exercise the runner, not the host's real free space.
  prevMinFreeDisk = process.env.RELAY_MIN_FREE_DISK_BYTES;
  process.env.RELAY_MIN_FREE_DISK_BYTES = "0";
  db = openDb(process.env.RELAY_DB);
  // ISH-869: the host runner probes `<dshBin> --version`; the fake-process tests
  // point it at a pinned fake so the guard passes without a real host dsh.
  dshBinDir = join(dir, "bin");
  mkdirSync(dshBinDir, { recursive: true });
  process.env.RELAY_DSH_BIN = fakeDshBin("dsh-pinned", PINNED_DSH_VERSION);
});

afterEach(() => {
  db.close();
  delete process.env.RELAY_DSH_BIN;
  if (prevMinFreeDisk === undefined) delete process.env.RELAY_MIN_FREE_DISK_BYTES;
  else process.env.RELAY_MIN_FREE_DISK_BYTES = prevMinFreeDisk;
  rmSync(dir, { recursive: true, force: true });
});

let issueSeq = 0;
/** A code-change task at implement/attempt 0 in its own temp worktree. */
function newTask(): { id: string; cwd: string; outputRoot: string } {
  const cwd = mkdtempSync(join(tmpdir(), "relay-dsh-wt-"));
  // A UNIQUE issue id: intake is idempotent by (provider, issue, slice), so a
  // shared id would return the same Task for a second call.
  const t = intakeTask(db, {
    provider: "test",
    issueId: `ISH-803-${issueSeq++}`,
    codeChange: true,
    title: "implement the thing",
    worktree: cwd,
  });
  return { id: t.id, cwd, outputRoot: join(dir, "runs") };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

/**
 * A code-change task whose worktree is a REAL `git init` repo with one commit
 * and NO linked branch/HEAD — the normal implement-phase state the non-git
 * `newTask()` could not exercise (both sides were NULL there).
 */
function newGitTask(): { id: string; cwd: string; outputRoot: string; baseHead: string; branch: string } {
  const cwd = mkdtempSync(join(tmpdir(), "relay-dsh-git-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "relay@test");
  git(cwd, "config", "user.name", "relay-test");
  writeFileSync(join(cwd, "README.md"), "base\n");
  git(cwd, "add", "README.md");
  git(cwd, "commit", "-q", "-m", "base");
  const baseHead = git(cwd, "rev-parse", "HEAD");
  const branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  const t = intakeTask(db, {
    provider: "test",
    issueId: `ISH-803-git-${issueSeq++}`,
    codeChange: true,
    title: "implement the thing",
    worktree: cwd,
  });
  return { id: t.id, cwd, outputRoot: join(dir, "runs"), baseHead, branch };
}

function readEvents(runId: string): any[] {
  const p = join(dir, "runs", runId, "events.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** The ORIGINAL dsh `--json` JSONL evidence for a Run. */
function readDshJsonl(runId: string): any[] {
  const p = join(dir, "runs", runId, "dsh.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** One dsh JSONL stdout line (as the real `--json` profile emits it). */
function dshLine(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj)}\n`;
}

/** A minimal, ordered dsh 0.2.1-rc.2 JSONL run: session -> text -> final. */
function emitHappyJsonl(p: FakeProcess, sessionId: string, text = "SMOKE_OK"): void {
  p.writeOut(dshLine({ type: "session", sessionId, cwd: "/tmp/wt" }));
  p.writeOut(dshLine({ type: "status", phase: "turn_start", turn: 1 }));
  p.writeOut(dshLine({ type: "text", text }));
  p.writeOut(dshLine({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } }));
  p.writeOut(dshLine({ type: "final", text }));
}

describe("one-shot headless dsh Run lifecycle", () => {
  test("normal run: reads dsh --json JSONL, records exit 0, and does NOT submit", async () => {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    const sessionId = "session-11111111-2222-3333-4444-555555555555";
    spawner.onSpawn = (p) => {
      p.writeErr("dsh: reasoning:\nworking through it\n");
      emitHappyJsonl(p, sessionId, "DONE: all edits committed");
      p.finish(0);
    };
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot, fastExitMs: 0 });
    const run = await h.wait();

    expect(run.state).toBe("exited");
    expect(run.exit_code).toBe(0);
    expect(run.pid).toBeGreaterThan(0);
    expect(run.ended_at).not.toBeNull();
    // The dsh sessionId from the `session` event is the Run's session_id.
    expect(run.session_id).toBe(sessionId);
    // The RAW stdout is still kept, and the ORIGINAL dsh JSONL is separate evidence.
    expect(readFileSync(run.stdout_path!, "utf-8")).toContain('"type":"final"');
    expect(readFileSync(run.stderr_path!, "utf-8")).toContain("working through it");
    const dsh = readDshJsonl(run.id);
    expect(dsh.map((e) => e.type)).toEqual(["session", "status", "text", "status", "final"]);
    expect(run.dsh_events_path).toBe(join(outputRoot, run.id, "dsh.jsonl"));
    // Relay's own log carries an ANNOTATION of each dsh event TYPE (never the
    // dsh payload), so the two logs stay distinct.
    const relay = readEvents(run.id);
    expect(relay.filter((e) => e.t === "dsh.event").map((e) => e.type)).toEqual([
      "session",
      "status",
      "text",
      "status",
      "final",
    ]);
    expect(relay.some((e) => e.t === "stdout")).toBe(false);
    // A clean exit is NOT a submission: the task must not have advanced.
    const task = getTask(db, id)!;
    expect(task.phase).toBe("implement");
    expect(task.state).toBe("queued");
    expect(findTaskResult(db, id, "implement", 0, "TaskSubmitted")).toBeNull();
    const exited = relay.find((e) => e.t === "run.exited");
    expect(exited?.state).toBe("exited");
    expect(exited?.terminal).toBe("final");
    expect(exited?.turnReason).toBe("completed");
  });

  test("records the launcher lease and clears it when the launch coroutine finishes", async () => {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    const atSpawn: { pid: number | null; lstart: string | null; state: string }[] = [];
    spawner.onSpawn = (p) => {
      const row = listRuns(db, { taskId: id })[0]!;
      atSpawn.push({ pid: row.launcher_pid, lstart: row.launcher_lstart, state: row.state });
      emitHappyJsonl(p, "session-launcher-0000-1111-2222-333333333333");
      p.finish(0);
    };

    const h = await startDshRun(db, { taskId: id, spawner, outputRoot, fastExitMs: 0 });
    const run = await h.wait();
    const settled = getRun(db, run.id)!;

    // ISH-1008: the lease is durable from the insert (before the child pid is
    // recorded), so a sweep cannot mistake the pre-spawn launch for an orphan.
    expect(atSpawn[0]?.pid).toBe(process.pid);
    expect(atSpawn[0]?.state).toBe("starting");
    // The coroutine is done, so a failed terminal write can be retried by a sweep.
    expect(run.state).toBe("exited");
    expect(settled.launcher_pid).toBeNull();
    expect(settled.launcher_lstart).toBeNull();
  });

  test("a real tool_call + tool_result are preserved in per-Run dsh evidence", async () => {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    const sessionId = "session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    spawner.onSpawn = (p) => {
      p.writeOut(dshLine({ type: "session", sessionId, cwd: "/tmp/wt" }));
      p.writeOut(dshLine({ type: "tool_call", callId: "call_1", tool: "read", input: { file_path: "note.txt" } }));
      p.writeOut(
        dshLine({
          type: "tool_result",
          callId: "call_1",
          status: "completed",
          result: "<content>\n1: hello-from-file\n</content>",
        })
      );
      p.writeOut(dshLine({ type: "final", text: "read it" }));
      p.finish(0);
    };
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot, fastExitMs: 0 });
    const run = await h.wait();
    expect(run.state).toBe("exited");
    const dsh = readDshJsonl(run.id);
    const call = dsh.find((e) => e.type === "tool_call");
    const result = dsh.find((e) => e.type === "tool_result");
    expect(call.tool).toBe("read");
    expect(call.callId).toBe("call_1");
    expect(call.input.file_path).toBe("note.txt");
    expect(result.callId).toBe("call_1");
    expect(result.status).toBe("completed");
    expect(result.result).toContain("hello-from-file");
    expect(readEvents(run.id).find((e) => e.t === "run.exited")?.dsh.toolCall).toBe(1);
  });

  test("a truncated event is preserved and flagged (never a false success)", async () => {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => {
      p.writeOut(dshLine({ type: "session", sessionId: "session-99999999-8888-7777-6666-555555555555", cwd: "/tmp" }));
      p.writeOut(dshLine({ type: "text", text: "x".repeat(20), truncated: true }));
      p.writeOut(dshLine({ type: "final", text: "done" }));
      p.finish(0);
    };
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot, fastExitMs: 0 });
    const run = await h.wait();
    expect(run.state).toBe("exited");
    expect(readDshJsonl(run.id).find((e) => e.type === "text").truncated).toBe(true);
    expect(readEvents(run.id).find((e) => e.t === "run.exited")?.dsh.truncated).toBe(1);
  });

  test("a missing `session` event leaves session_id null but the Run still exits", async () => {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => {
      p.writeOut(dshLine({ type: "text", text: "no session here" }));
      p.writeOut(dshLine({ type: "final", text: "no session here" }));
      p.finish(0);
    };
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot, fastExitMs: 0 });
    const run = await h.wait();
    expect(run.state).toBe("exited");
    expect(run.session_id).toBeNull();
  });

  test("an in-turn failure with a `final` is still failed by the exit code", async () => {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => {
      p.writeOut(dshLine({ type: "session", sessionId: "session-12121212-3434-5656-7878-909090909090", cwd: "/tmp" }));
      p.writeOut(dshLine({ type: "final", text: "gave up" }));
      p.finish(1);
    };
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot, fastExitMs: 0 });
    const run = await h.wait();
    expect(run.state).toBe("failed");
    expect(run.exit_code).toBe(1);
    expect(() => acceptRunSubmission(db, { runId: run.id })).toThrow(/RUN_SUBMISSION_REJECTED/);
    expect(findTaskResult(db, id, "implement", 0, "TaskSubmitted")).toBeNull();
  });

  test("a terminal `error` event with exit 0 fails closed", async () => {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => {
      p.writeOut(dshLine({ type: "session", sessionId: "session-00000000-1111-2222-3333-444444444444", cwd: "/tmp" }));
      p.writeOut(dshLine({ type: "error", message: "provider exploded outside a turn" }));
      p.finish(0);
    };
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot, fastExitMs: 0 });
    const run = await h.wait();
    expect(run.state).toBe("failed");
    expect(run.error).toContain("provider exploded");
    expect(() => acceptRunSubmission(db, { runId: run.id })).toThrow(/RUN_SUBMISSION_REJECTED/);
  });

  test("the pinned CLI is used exactly: dsh --profile headless --json <task>", async () => {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => p.finish(0);
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot });
    await h.wait();
    expect(spawner.argv[0][0]).toBe(process.env.RELAY_DSH_BIN!);
    expect(spawner.argv[0].slice(1, 5)).toEqual(["--profile", "headless", "--json", expect.any(String)]);
    expect(spawner.argv[0][4]).toContain(`# Task ${id}`);
    // Permission boundary: workspace-write by default, and the Run is identified.
    expect(spawner.envs[0].DSH_PERMISSION_MODE).toBe("workspace-write");
    expect(spawner.envs[0].RELAY_RUN_ID).toBe(h.id);
    expect(spawner.envs[0].RELAY_TASK_ID).toBe(id);
  });

  test("non-zero exit is a failure, never accepted", async () => {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => {
      p.writeErr("dsh: RATE_LIMIT: too many requests\n");
      p.finish(1);
    };
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot });
    const run = await h.wait();
    expect(run.state).toBe("failed");
    expect(run.exit_code).toBe(1);
    expect(() => acceptRunSubmission(db, { runId: run.id })).toThrow(/RUN_SUBMISSION_REJECTED/);
    expect(findTaskResult(db, id, "implement", 0, "TaskSubmitted")).toBeNull();
  });

  test("a spawn failure is recorded as failed, not a crash of the caller", async () => {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    spawner.throwOnSpawn = new Error("ENOENT: dsh not found");
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot });
    const run = await h.wait();
    expect(run.state).toBe("failed");
    expect(run.error).toContain("ENOENT");
    expect(run.pid).toBeNull();
  });

  test("a process crash (exited rejects) is failed, not exited", async () => {
    const { id, outputRoot } = newTask();
    const empty = (): ReadableStream<Uint8Array> => new ReadableStream({ start: (c) => c.close() });
    const rejecting: DshSpawner = {
      spawn: () => ({
        pid: 4242,
        stdout: empty(),
        stderr: empty(),
        exited: new Promise<number | null>((_, rej) => setTimeout(() => rej(new Error("killed by signal")), 0)),
        kill: () => {},
      }),
    };
    const h = await startDshRun(db, { taskId: id, spawner: rejecting, outputRoot });
    const run = await h.wait();
    expect(run.state).toBe("failed");
    expect(run.error).toContain("killed by signal");
  });

  test("cancel terminates the process group and records cancelled", async () => {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot });
    const running = getRun(db, h.id)!;
    expect(running.state).toBe("running");
    h.cancel("user cancel");
    const run = await h.wait();
    expect(run.state).toBe("cancelled");
    expect(run.signal).toBe("user cancel");
    expect(spawner.procs[0].signals).toContain("SIGTERM");
    expect(() => acceptRunSubmission(db, { runId: run.id })).toThrow(/RUN_SUBMISSION_REJECTED/);
  });

  test("timeout kills the process and records timeout", async () => {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot, timeoutMs: 20 });
    const run = await h.wait();
    expect(run.state).toBe("timeout");
    expect(readEvents(run.id).some((e) => e.t === "run.timeout")).toBe(true);
  });

  test("malformed stdout stays visible, is never dsh evidence, and never throws", async () => {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => {
      // The real profile prints this plugin banner to stdout BEFORE the JSONL.
      p.writeOut("[opencode-session-id] mounted: providers=[opencode]\n");
      p.writeOut("not json at all\n");
      p.writeOut('{"broken": \n');
      p.writeOut(dshLine({ type: "final", text: "done" })); // no trailing newline case below
      p.finish(0);
    };
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot, fastExitMs: 0 });
    const run = await h.wait();
    // exit 0 is still the (authoritative) process success, but the malformed
    // lines are surfaced and are NOT counted as dsh events.
    expect(run.state).toBe("exited");
    const malformed = readEvents(run.id).filter((e) => e.t === "stdout.malformed");
    expect(malformed.map((e) => e.v)).toEqual([
      "[opencode-session-id] mounted: providers=[opencode]",
      "not json at all",
      '{"broken": ',
    ]);
    // Malformed lines are never written into the dsh JSONL evidence.
    expect(readDshJsonl(run.id).map((e) => e.type)).toEqual(["final"]);
    expect(readEvents(run.id).find((e) => e.t === "run.exited")?.dsh.malformed).toBe(3);
  });

  test("a last stdout line without a trailing newline is still parsed", async () => {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => {
      p.writeOut(JSON.stringify({ type: "final", text: "no newline" })); // no "\n"
      p.finish(0);
    };
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot, fastExitMs: 0 });
    const run = await h.wait();
    expect(readDshJsonl(run.id).map((e) => e.type)).toEqual(["final"]);
    expect(readEvents(run.id).some((e) => e.t === "stdout.malformed")).toBe(false);
  });

  test("an abnormally fast exit is flagged but still not a submission", async () => {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => p.finish(0);
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot, fastExitMs: 60_000 });
    const run = await h.wait();
    expect(run.state).toBe("exited");
    expect(run.fast_exit).toBe(1);
    expect(readEvents(run.id).some((e) => e.t === "run.fast_exit")).toBe(true);
    expect(findTaskResult(db, id, "implement", 0, "TaskSubmitted")).toBeNull();
  });

  test("two Runs in different cwds run concurrently", async () => {
    const a = newTask();
    const b = newTask();
    const spawner = new FakeSpawner();
    const h1 = await startDshRun(db, { taskId: a.id, spawner, outputRoot: a.outputRoot, cwd: a.cwd });
    const h2 = await startDshRun(db, { taskId: b.id, spawner, outputRoot: b.outputRoot, cwd: b.cwd });
    expect(spawner.cwds).toEqual([a.cwd, b.cwd]);
    // Both are live at the same time.
    expect(getRun(db, h1.id)!.state).toBe("running");
    expect(getRun(db, h2.id)!.state).toBe("running");
    expect(getRun(db, h1.id)!.cwd).toBe(a.cwd);
    expect(getRun(db, h2.id)!.cwd).toBe(b.cwd);
    expect(getRun(db, h1.id)!.output_dir).not.toBe(getRun(db, h2.id)!.output_dir);

    spawner.procs[0].writeOut("A done\n");
    spawner.procs[0].finish(0);
    spawner.procs[1].writeOut("B done\n");
    spawner.procs[1].finish(0);
    const [r1, r2] = await Promise.all([h1.wait(), h2.wait()]);
    expect(r1.state).toBe("exited");
    expect(r2.state).toBe("exited");
    expect(listRuns(db, { taskId: a.id })[0].id).toBe(h1.id);
    expect(listRuns(db, { taskId: b.id })[0].id).toBe(h2.id);
  });
});

describe("real git worktree: base/produced HEAD binding (findings 1 & 2)", () => {
  test("a clean Run with no linked branch/HEAD is submittable (adopts the Run's)", async () => {
    const { id, cwd, outputRoot, baseHead, branch } = newGitTask();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => {
      p.writeOut("implemented (no commit)\n");
      p.finish(0);
    };
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot, cwd, fastExitMs: 0 });
    const run = await h.wait();
    expect(run.base_head_sha).toBe(baseHead);
    expect(run.head_sha).toBe(baseHead); // no commit: produced == base
    // The task has NO branch/head yet: the submission must still be accepted.
    const accepted = acceptRunSubmission(db, { runId: run.id });
    expect(accepted.state).toBe("submitted");
    const task = getTask(db, id)!;
    expect(task.phase).toBe("verify");
    expect(task.head_sha).toBe(baseHead);
    expect(task.branch).toBe(branch);
    expect(findTaskResult(db, id, "implement", 0, "TaskSubmitted")!.head_sha).toBe(baseHead);
  });

  test("the submission binds to the HEAD the Run PRODUCED (dsh commits)", async () => {
    const { id, cwd, outputRoot, baseHead } = newGitTask();
    let produced = "";
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => {
      writeFileSync(join(cwd, "change.txt"), "change\n");
      git(cwd, "add", "change.txt");
      git(cwd, "commit", "-q", "-m", "the change");
      produced = git(cwd, "rev-parse", "HEAD");
      p.writeOut("committed\n");
      p.finish(0);
    };
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot, cwd, fastExitMs: 0 });
    const run = await h.wait();
    expect(run.base_head_sha).toBe(baseHead);
    expect(run.head_sha).toBe(produced);
    expect(produced).not.toBe(baseHead);

    // `--head` must name the PRODUCED head; the pre-run head is refused.
    expect(() => acceptRunSubmission(db, { runId: run.id, headSha: baseHead })).toThrow(/bound to head/);
    const accepted = acceptRunSubmission(db, { runId: run.id, headSha: produced });
    expect(accepted.state).toBe("submitted");

    // The produced head is recorded on the Task AND TaskSubmitted (so verify /
    // review judge the committed revision, not the pre-run one).
    const task = getTask(db, id)!;
    expect(task.head_sha).toBe(produced);
    expect(task.phase).toBe("verify");
    expect(findTaskResult(db, id, "implement", 0, "TaskSubmitted")!.head_sha).toBe(produced);
  });

  test("a task head bound elsewhere than the Run's start is refused (base fence)", async () => {
    const { id, cwd, outputRoot, baseHead } = newGitTask();
    // The task is already bound to a different revision than the Run starts at.
    linkTask(db, id, { headSha: "0000000000000000000000000000000000000000" });
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => p.finish(0);
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot, cwd });
    const run = await h.wait();
    expect(run.base_head_sha).toBe(baseHead);
    expect(() => acceptRunSubmission(db, { runId: run.id })).toThrow(/stale: task head/);
    expect(findTaskResult(db, id, "implement", 0, "TaskSubmitted")).toBeNull();
  });
});

describe("integration-phase Run with a moved head re-reviews (round-3)", () => {
  test("a committing integration Run lands in review at attempt+1, NOT merge_ready", async () => {
    for (const [wid, role] of [
      ["w-impl", "worker"],
      ["w-ver", "worker"],
      ["w-rev", "reviewer"],
      ["w-int", "integrator"],
    ] as const) {
      registerWorker(db, wid, { role });
    }
    const { id, cwd, outputRoot, baseHead } = newGitTask();

    // IMPLEMENT via a headless Run (no commit): the task adopts the Run's branch/head.
    const implSpawner = new FakeSpawner();
    implSpawner.onSpawn = (p) => {
      p.writeOut("impl\n");
      p.finish(0);
    };
    const implRun = await startDshRun(db, { taskId: id, spawner: implSpawner, outputRoot, cwd, fastExitMs: 0 });
    await implRun.wait();
    acceptRunSubmission(db, { runId: implRun.id });
    expect(getTask(db, id)!.phase).toBe("verify");

    // verify PASS -> review PASS at the produced head -> integration.
    claimTask(db, id, "w-ver");
    recordVerification(db, id, "w-ver", { passed: true });
    expect(getTask(db, id)!.phase).toBe("review");
    expect(claimNext(db, "w-rev")?.id).toBe(id);
    recordReview(db, id, "w-rev", { verdict: "pass", headSha: baseHead });
    expect(getTask(db, id)!.phase).toBe("integration");

    // The integrator claims integration, then an integration Run COMMITS H1.
    claimTask(db, id, "w-int");
    const before = getTask(db, id)!;
    expect(before.phase).toBe("integration");
    expect(before.head_sha).toBe(baseHead);

    let produced = "";
    const intSpawner = new FakeSpawner();
    intSpawner.onSpawn = (p) => {
      writeFileSync(join(cwd, "merge.txt"), "merged\n");
      git(cwd, "add", "merge.txt");
      git(cwd, "commit", "-q", "-m", "integration change");
      produced = git(cwd, "rev-parse", "HEAD");
      p.writeOut("integration committed\n");
      p.finish(0);
    };
    const intRun = await startDshRun(db, { taskId: id, spawner: intSpawner, outputRoot, cwd, fastExitMs: 0 });
    const run = await intRun.wait();
    expect(run.base_head_sha).toBe(baseHead);
    expect(run.head_sha).toBe(produced);
    expect(produced).not.toBe(baseHead);

    const submitted = acceptRunSubmission(db, { runId: run.id });
    expect(submitted.state).toBe("submitted");

    // It must NOT land in merge_ready with an unreviewed head.
    const after = getTask(db, id)!;
    expect(after.phase).toBe("review");
    expect(after.state).toBe("review");
    expect(after.attempt).toBe(before.attempt + 1);
    expect(after.head_sha).toBe(produced);
    expect(after.phase).not.toBe("merge_ready");
    // No integration TaskSubmitted advanced it; the review was invalidated.
    expect(findTaskResult(db, id, "integration", before.attempt, "TaskSubmitted")).toBeNull();
    const invalidated = db
      .query(`SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'workflow.review_invalidated'`)
      .get(id) as { n: number };
    expect(invalidated.n).toBeGreaterThan(0);
  });
});

describe("relay run start always reaches a terminal state (finding 3)", () => {
  test("the CLI waits for the Run before closing the DB", async () => {
    const { id, cwd } = newGitTask();
    const binDir = mkdtempSync(join(tmpdir(), "relay-dsh-bin-"));
    const bin = join(binDir, "dsh-fake.sh");
    writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.2.1-rc.2; exit 0; fi\necho final\nsleep 0.2\necho done\nexit 0\n');
    chmodSync(bin, 0o755);
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const p = Bun.spawnSync(["bun", cli, "run", "start", id, "--cwd", cwd], {
      env: { ...process.env, RELAY_DB: process.env.RELAY_DB!, RELAY_DSH_BIN: bin },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = p.stdout.toString();
    const err = p.stderr.toString();
    expect(p.exitCode).toBe(0);
    expect(out).toContain("state=exited");
    expect(err).not.toContain("closed database");
    // The durable row is terminal, not stuck at `running`.
    const row = getRun(db, listRuns(db, { taskId: id })[0].id)!;
    expect(row.state).toBe("exited");
    expect(row.exit_code).toBe(0);
  });
});

describe("relay run logs: read-only dsh event history (ISH-810)", () => {
  test("shows the session id and the ordered tool_call/tool_result chronology", async () => {
    const { id, cwd } = newGitTask();
    const binDir = mkdtempSync(join(tmpdir(), "relay-dsh-bin-"));
    const bin = join(binDir, "dsh-json.sh");
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo 0.2.1-rc.2; exit 0; fi',
        `printf '%s\\n' '{"type":"session","sessionId":"session-cli-1111-2222-3333-4444-555555555555","cwd":"/tmp"}'`,
        `printf '%s\\n' '{"type":"tool_call","callId":"c1","tool":"read","input":{"file_path":"note.txt"}}'`,
        `printf '%s\\n' '{"type":"tool_result","callId":"c1","status":"completed","result":"hello-from-file"}'`,
        `printf '%s\\n' '{"type":"final","text":"done"}'`,
        "exit 0",
        "",
      ].join("\n")
    );
    chmodSync(bin, 0o755);
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const env = { ...process.env, RELAY_DB: process.env.RELAY_DB!, RELAY_DSH_BIN: bin };
    const start = Bun.spawnSync(["bun", cli, "run", "start", id, "--cwd", cwd], { env, stdout: "pipe", stderr: "pipe" });
    expect(start.exitCode).toBe(0);
    const runId = listRuns(db, { taskId: id })[0].id;

    const logs = Bun.spawnSync(["bun", cli, "run", "logs", runId], { env, stdout: "pipe", stderr: "pipe" });
    const out = logs.stdout.toString();
    expect(out).toContain("--- dsh events");
    expect(out).toContain("session=session-cli-1111-2222-3333-4444-555555555555");
    expect(out).toContain("tool_call read c1");
    expect(out).toContain("tool_result c1 status=completed");
    expect(out).toContain("hello-from-file");
    expect(out).toContain('final "done"');
  });
});

describe("structured submission is the only thing that advances a Task", () => {
  async function cleanRun(): Promise<{ runId: string; taskId: string }> {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => {
      p.writeOut("implemented the thing\n");
      p.finish(0);
    };
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot, fastExitMs: 0 });
    await h.wait();
    return { runId: h.id, taskId: id };
  }

  test("a bound submission records TaskSubmitted and advances implement -> verify", async () => {
    const { runId, taskId } = await cleanRun();
    const run = acceptRunSubmission(db, { runId, summary: "did it" });
    expect(run.state).toBe("submitted");
    const task = getTask(db, taskId)!;
    expect(task.phase).toBe("verify");
    const res = findTaskResult(db, taskId, "implement", 0, "TaskSubmitted");
    expect(res).not.toBeNull();
    expect(res!.worker_id).toBe(`dsh-run:${runId}`);
    expect(res!.head_sha).toBe(run.head_sha);
  });

  test("a duplicate submission for the same phase/attempt is refused", async () => {
    const { runId } = await cleanRun();
    acceptRunSubmission(db, { runId });
    expect(() => acceptRunSubmission(db, { runId })).toThrow(/RUN_SUBMISSION_REJECTED|DUPLICATE_DISPATCH/);
  });

  test("a submission naming the wrong task/phase/branch is refused", async () => {
    const { runId } = await cleanRun();
    expect(() => acceptRunSubmission(db, { runId, taskId: "T999" })).toThrow(/belongs to task/);
    expect(() => acceptRunSubmission(db, { runId, phase: "review" })).toThrow(/started in phase/);
    expect(() => acceptRunSubmission(db, { runId, branch: "feature/x" })).toThrow(/bound to branch/);
  });

  test("a submission for a moved HEAD is refused", async () => {
    const { runId, taskId } = await cleanRun();
    linkTask(db, taskId, { headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });
    expect(() => acceptRunSubmission(db, { runId })).toThrow(/RUN_SUBMISSION_REJECTED/);
    expect(findTaskResult(db, taskId, "implement", 0, "TaskSubmitted")).toBeNull();
  });

  test("a cancelled run can never be submitted", async () => {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot });
    h.cancel();
    const run = await h.wait();
    expect(() => acceptRunSubmission(db, { runId: run.id })).toThrow(/clean exit 0/);
  });
});

// ISH-808 round 2: the Run path must treat `cancelled` (any terminal state) as
// CLOSED. `cancelTask` leaves `phase`/`attempt` untouched, so without these
// guards a Run could move a cancelled code-change task back to queued/verify.
describe("ISH-808: a cancelled task is terminal on the Run path", () => {
  test("startDshRun on a cancelled task is refused before any writer starts", async () => {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    cancelTask(db, id, "w", "superseded");
    expect(getTask(db, id)!.state).toBe("cancelled");

    await expect(startDshRun(db, { taskId: id, outputRoot, spawner })).rejects.toThrow(/terminal/);

    expect(getTask(db, id)!.state).toBe("cancelled");
    expect(spawner.procs.length).toBe(0); // no dsh process, no runs row
    expect(listRuns(db, { taskId: id }).length).toBe(0);
  });

  test("a Run that settles exit 0 cannot be submitted after the task is cancelled", async () => {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    let proc!: FakeProcess;
    spawner.onSpawn = (p) => (proc = p);
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot });
    proc.writeOut("done\n");
    proc.finish(0);
    await h.wait();
    expect(getRun(db, h.id)!.state).toBe("exited");

    cancelTask(db, id, "w", "superseded");

    expect(() => acceptRunSubmission(db, { runId: h.id })).toThrow(/terminal/);
    // The task stays cancelled — never queued/verify again.
    expect(getTask(db, id)!.state).toBe("cancelled");
    expect(findTaskResult(db, id, "implement", 0, "TaskSubmitted")).toBeNull();
  });

  test("cancelTask keeps a live Run visible to the single-writer fence and stops its process", async () => {
    const { id, cwd, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    let proc!: FakeProcess;
    spawner.onSpawn = (p) => (proc = p);
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot, cwd });
    expect(getRun(db, h.id)!.state).toBe("running");
    expect(findActiveWriter(db, { cwd })?.id).toBe(h.id);

    // Stub process.kill so the test never touches a real OS pid, and record the
    // signal cancelTask sends (the Run's process is what must be stopped).
    const calls: { pid: number; signal: string | number | undefined }[] = [];
    const realKill = process.kill;
    (process as unknown as { kill: unknown }).kill = (pid: number, signal?: string | number) => {
      calls.push({ pid, signal });
      return true;
    };
    try {
      cancelTask(db, id, "w", "obsolete");
    } finally {
      (process as unknown as { kill: unknown }).kill = realKill;
    }

    // The process GROUP was signalled (negative pid = -pid, SIGTERM).
    expect(calls.some((c) => c.signal === "SIGTERM" && c.pid === -proc.pid)).toBe(true);
    // The ROW is not rewritten: the Run is still `running` with a cancel signal,
    // so the single-writer fence still refuses a second writer.
    const live = getRun(db, h.id)!;
    expect(live.state).toBe("running");
    expect(live.signal).toBe("cancelled");
    expect(findActiveWriter(db, { cwd })?.id).toBe(h.id);
    // The single-writer fence still REFUSES a second writer on this worktree.
    expect(() => assertNoActiveWriter(db, { cwd })).toThrow(/DUPLICATE_WRITER/);
    await expect(startDshRun(db, { taskId: id, spawner, outputRoot, cwd })).rejects.toThrow(/terminal/);

    // The process finally exits 0: the settle path records `cancelled`.
    proc.finish(0);
    await h.wait();
    expect(getRun(db, h.id)!.state).toBe("cancelled");
    expect(() => acceptRunSubmission(db, { runId: h.id })).toThrow(/RUN_SUBMISSION_REJECTED/);
    expect(getTask(db, id)!.state).toBe("cancelled");
  });
});

// ISH-869 finding 1: the HOST headless Coding Worker (`relay run start`/`factory`
// -> startDshRun) must be the exact pinned dsh, and a mismatch must fail closed
// BEFORE any Run row or process.
describe("ISH-869: the host Coding Worker is pinned (fail closed)", () => {
  test("a host dsh that is not the pin is refused before any Run row or process", async () => {
    const { id, outputRoot } = newTask();
    const old = fakeDshBin("dsh-old", "0.2.0-rc.2");
    const spawner = new FakeSpawner();
    await expect(startDshRun(db, { taskId: id, spawner, outputRoot, dshBin: old })).rejects.toThrow(
      new RegExp(`^${DSH_VERSION_MISMATCH}`)
    );
    expect(spawner.procs.length).toBe(0); // no process was spawned
    expect(listRuns(db, { taskId: id })).toHaveLength(0); // and no Run row was written
  });

  test("a host dsh whose `--version` fails is refused (no version is not the pin)", async () => {
    const { id, outputRoot } = newTask();
    const broken = fakeDshBin("dsh-broken", null);
    const spawner = new FakeSpawner();
    await expect(startDshRun(db, { taskId: id, spawner, outputRoot, dshBin: broken })).rejects.toThrow(
      new RegExp(`^${DSH_VERSION_MISMATCH}`)
    );
    expect(spawner.procs.length).toBe(0);
    expect(listRuns(db, { taskId: id })).toHaveLength(0);
  });

  test("an unpinned default from PATH/RELAY_DSH_BIN is refused", async () => {
    const { id, outputRoot } = newTask();
    process.env.RELAY_DSH_BIN = fakeDshBin("dsh-old-env", "0.2.1-rc.1");
    const spawner = new FakeSpawner();
    await expect(startDshRun(db, { taskId: id, spawner, outputRoot })).rejects.toThrow(
      new RegExp(`^${DSH_VERSION_MISMATCH}`)
    );
    expect(spawner.procs.length).toBe(0);
    expect(listRuns(db, { taskId: id })).toHaveLength(0);
  });

  test("the pinned host dsh is admitted and runs", async () => {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => {
      emitHappyJsonl(p, "session-pinned-host");
      p.finish(0);
    };
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot, fastExitMs: 0 });
    const run = await h.wait();
    expect(run.state).toBe("exited");
    expect(run.exit_code).toBe(0);
    expect(run.session_id).toBe("session-pinned-host");
  });
});
