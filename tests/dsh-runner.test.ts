import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { intakeTask, findTaskResult, linkTask } from "../src/workflow";
import { getTask } from "../src/tasks";
import {
  acceptRunSubmission,
  getRun,
  listRuns,
  startDshRun,
  type DshProcess,
  type DshSpawner,
} from "../src/dsh-runner";

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-dsh-run-"));
  process.env.RELAY_DB = join(dir, "state.db");
  db = openDb(process.env.RELAY_DB);
});

afterEach(() => {
  db.close();
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

function readEvents(runId: string): any[] {
  const p = join(dir, "runs", runId, "events.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("one-shot headless dsh Run lifecycle", () => {
  test("normal run: streams stdout/stderr, records exit 0, and does NOT submit", async () => {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => {
      p.writeOut("dsh: reasoning: thinking...\n"); // never (headless puts reasoning on stderr, but be tolerant)
      p.writeErr("dsh: reasoning:\nworking through it\n");
      p.writeOut("DONE: all edits committed\n");
      p.finish(0);
    };
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot, fastExitMs: 0 });
    const run = await h.wait();

    expect(run.state).toBe("exited");
    expect(run.exit_code).toBe(0);
    expect(run.pid).toBeGreaterThan(0);
    expect(run.ended_at).not.toBeNull();
    expect(readFileSync(run.stdout_path!, "utf-8")).toContain("DONE: all edits committed");
    expect(readFileSync(run.stderr_path!, "utf-8")).toContain("working through it");

    // A clean exit is NOT a submission: the task must not have advanced.
    const task = getTask(db, id)!;
    expect(task.phase).toBe("implement");
    expect(task.state).toBe("queued");
    expect(findTaskResult(db, id, "implement", 0, "TaskSubmitted")).toBeNull();
    expect(readEvents(run.id).some((e) => e.t === "run.exited" && e.state === "exited")).toBe(true);
  });

  test("the pinned CLI is used exactly: dsh --profile headless <task>", async () => {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => p.finish(0);
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot });
    await h.wait();
    expect(spawner.argv[0][0]).toBe("dsh");
    expect(spawner.argv[0].slice(0, 3)).toEqual(["dsh", "--profile", "headless"]);
    expect(spawner.argv[0][3]).toContain(`# Task ${id}`);
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

  test("malformed stdout never throws and is recorded line by line", async () => {
    const { id, outputRoot } = newTask();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => {
      p.writeOut("not json at all\n");
      p.writeOut('{"broken": \n');
      p.writeOut("plain final text"); // no trailing newline: still delivered
      p.finish(0);
    };
    const h = await startDshRun(db, { taskId: id, spawner, outputRoot, fastExitMs: 0 });
    const run = await h.wait();
    expect(run.state).toBe("exited");
    const stdoutEvents = readEvents(run.id).filter((e) => e.t === "stdout");
    expect(stdoutEvents.map((e) => e.v)).toEqual([
      "not json at all",
      '{"broken": ',
      "plain final text",
    ]);
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
