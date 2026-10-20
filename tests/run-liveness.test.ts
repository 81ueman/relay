import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { now, openDb } from "../src/db";
import { addTask, getTask } from "../src/tasks";
import { inboxFor } from "../src/messages";
import { listEvents } from "../src/events";
import { getRun } from "../src/dsh-runner";
import { pidAlive } from "../src/factory";
import { reconcile } from "../src/reconciler";
import { MockRuntime } from "../src/runtime/runtime";
import { buildDashboardView } from "../src/dashboard/model";
import { renderDashboard, renderDashboardJson } from "../src/dashboard/render";
import type { SbxCli, SbxResult } from "../src/sandbox";
import {
  classifyRunDeath,
  classifyRunFailure,
  parseRunFailureClass,
} from "../src/run-failure";
import {
  maybeSweepRunLiveness,
  sweepRunLiveness,
} from "../src/run-liveness";

// ISH-1008: a dead Run must be failed by the daemon's liveness sweep, with a
// classified cause, without anyone touching the Task. Everything below is
// deterministic: fake evidence logs, dead PIDs, an injected identity where the
// sandbox cannot run `ps`, and a fake `sbx` CLI.

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ["RELAY_HUMAN", "RELAY_RUN_LIVENESS_MS", "RELAY_RUN_START_GRACE_MS"];

let dir = "";
let db: Database;
let dbPath = "";
let seq = 0;

beforeEach(() => {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), "relay-run-liveness-"));
  dbPath = join(dir, "state.db");
  process.env.RELAY_DB = dbPath;
  delete process.env.RELAY_RUN_LIVENESS_MS;
  delete process.env.RELAY_RUN_START_GRACE_MS;
  delete process.env.RELAY_HUMAN;
  db = openDb(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.RELAY_DB;
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

/** A permanently-dead PID (larger than any OS pid limit). */
const DEAD_PID = 2_147_483_646;

function newTask(): string {
  return addTask(db, { title: `liveness ${seq++}` }).id;
}

interface InsertRunOptions {
  taskId: string;
  id?: string;
  state?: string;
  pid?: number | null;
  spawnLstart?: string | null;
  sandbox?: string | null;
  stderr?: string;
  dshJsonl?: string;
  startedAt?: number;
  endedAt?: number | null;
  error?: string | null;
}

/** Insert a Run row with real evidence files under `<dir>/runs/<id>/`. */
function insertRun(opts: InsertRunOptions): string {
  const id = opts.id ?? `run-live-${seq++}`;
  const out = join(dir, "runs", id);
  mkdirSync(out, { recursive: true });
  const stderrPath = join(out, "stderr.log");
  const dshPath = join(out, "dsh.jsonl");
  writeFileSync(stderrPath, opts.stderr ?? "");
  writeFileSync(dshPath, opts.dshJsonl ?? "");
  const t = opts.startedAt ?? now();
  db.query(
    `INSERT INTO runs
       (id, task_id, phase, attempt, generation, cwd, branch, head_sha, base_head_sha, prompt,
        spec_path, output_dir, state, pid, spawn_lstart, sandbox_name, error,
        stdout_path, stderr_path, events_path, dsh_events_path, exit_code, signal,
        fast_exit, started_at, ended_at, created_at, updated_at)
     VALUES (?, ?, 'implement', 0, 0, ?, NULL, NULL, NULL, '', NULL, ?, ?, ?, ?, ?, ?,
             NULL, ?, NULL, ?, NULL, NULL, 0, ?, ?, ?, ?)`
  ).run(
    id,
    opts.taskId,
    dir,
    out,
    opts.state ?? "running",
    opts.pid ?? null,
    opts.spawnLstart ?? null,
    opts.sandbox ?? null,
    opts.error ?? null,
    stderrPath,
    dshPath,
    t,
    opts.endedAt ?? null,
    t,
    t
  );
  return id;
}

function runDiedEvents(runId: string): { payload_json: string }[] {
  return db
    .query(`SELECT payload_json FROM events WHERE type = 'run.died' AND payload_json LIKE ?`)
    .all(`%${runId}%`) as { payload_json: string }[];
}

function runDiedMail() {
  return inboxFor(db, "coord").filter((m) => m.kind === "run_died");
}

describe("classifyRunFailure (ISH-1008)", () => {
  test("ENOSPC in stderr is the classified cause", () => {
    const c = classifyRunFailure({ stderr: "[dsh] write failed: ENOSPC: no space left on device\n" });
    expect(c.class).toBe("ENOSPC");
    expect(c.detail).toContain("ENOSPC");
  });

  test("ENOSPC in the dsh JSONL evidence is found too (stderr may be empty)", () => {
    const c = classifyRunFailure({
      stderr: "",
      dshJsonl: JSON.stringify({ type: "error", message: "ENOSPC: no space left on device" }) + "\n",
    });
    expect(c.class).toBe("ENOSPC");
  });

  test("an OOM signature is OOM, and a signal is a signal", () => {
    expect(classifyRunFailure({ stderr: "FATAL ERROR: JavaScript heap out of memory" }).class).toBe("OOM");
    expect(classifyRunFailure({ stderr: "Killed\n" })).toMatchObject({ class: "signal", detail: "Killed" });
    expect(classifyRunFailure({ stderr: "received SIGTERM\n" }).class).toBe("signal");
    expect(classifyRunFailure({ stderr: "", signal: "SIGTERM" })).toMatchObject({
      class: "signal",
      detail: "signal SIGTERM",
    });
    expect(classifyRunFailure({ stderr: "", exitCode: 137 }).class).toBe("signal");
    // `runs.signal` also carries Relay cancel reasons; only SIG* is a signal.
    expect(classifyRunFailure({ stderr: "", signal: "cancelled" }).class).toBe("unknown");
  });

  test("a plain exit with no signature is unknown (still surfaced, never a success)", () => {
    const c = classifyRunFailure({ stderr: "ordinary provider error", exitCode: 1 });
    expect(c.class).toBe("unknown");
    expect(c.detail).toContain("exit 1");
  });

  test("only the END of the evidence is read", () => {
    const taskId = newTask();
    const id = insertRun({
      taskId,
      stderr: "ENOSPC: no space left on device\n" + "x".repeat(4000),
    });
    const run = getRun(db, id)!;
    expect(classifyRunDeath(run, { tailBytes: 64 }).class).toBe("unknown");
    expect(classifyRunDeath(run, { tailBytes: 5000 }).class).toBe("ENOSPC");
  });

  test("parses a stored cause back out of runs.error", () => {
    expect(parseRunFailureClass("orphaned: pid gone; cause=ENOSPC: no space left on device")).toBe("ENOSPC");
    expect(parseRunFailureClass("orphaned: pid gone")).toBeNull();
    expect(parseRunFailureClass("cause=NOPE: whatever")).toBeNull();
  });
});

describe("sweepRunLiveness (ISH-1008)", () => {
  test("a dead local Run is failed as orphaned with the ENOSPC cause and surfaced", () => {
    process.env.RELAY_HUMAN = "coord";
    const taskId = newTask();
    const id = insertRun({
      taskId,
      pid: DEAD_PID,
      spawnLstart: "lstart-v1:Tue Jan  1 00:00:00 1980",
      stderr: "write session: ENOSPC: no space left on device\n",
      startedAt: 0,
    });

    const res = sweepRunLiveness(db, { at: 1_000, startGraceMs: 0 });
    expect(res.errors).toEqual([]);
    expect(res.died).toHaveLength(1);
    expect(res.died[0]).toMatchObject({ runId: id, class: "ENOSPC" });

    const run = getRun(db, id)!;
    expect(run.state).toBe("failed");
    expect(run.error).toContain("orphaned");
    expect(run.error).toContain("cause=ENOSPC");
    expect(run.ended_at).toBe(1_000);

    const ev = runDiedEvents(id);
    expect(ev).toHaveLength(1);
    const payload = JSON.parse(ev[0].payload_json);
    expect(payload.class).toBe("ENOSPC");
    expect(payload.runId).toBe(id);
    expect(payload.taskId).toBe(taskId);

    const mail = runDiedMail();
    expect(mail).toHaveLength(1);
    expect(mail[0].payload).toContain("ENOSPC");
    expect(mail[0].task_id).toBe(taskId);
  });

  test("a provably-live Run is never marked failed", () => {
    const taskId = newTask();
    const id = insertRun({
      taskId,
      pid: process.pid,
      spawnLstart: null,
      startedAt: 0,
    });
    const res = sweepRunLiveness(db, {
      at: 1_000,
      startGraceMs: 0,
      identify: () => "match",
    });
    expect(res.died).toEqual([]);
    expect(res.live).toBe(1);
    expect(getRun(db, id)!.state).toBe("running");
  });

  test("an undeterminable identity keeps the single-writer fence", () => {
    const taskId = newTask();
    // The default identifyRunProcess needs a live PID; this process is live, and
    // a missing spawn token makes the identity undeterminable in every env.
    const id = insertRun({
      taskId,
      pid: process.pid,
      spawnLstart: null,
      startedAt: 0,
    });
    const res = sweepRunLiveness(db, { at: 1_000, startGraceMs: 0 });
    expect(res.died).toEqual([]);
    expect(getRun(db, id)!.state).toBe("running");
  });

  test("a reused PID is treated as gone but never signalled", () => {
    const taskId = newTask();
    const id = insertRun({
      taskId,
      pid: process.pid,
      spawnLstart: "lstart-v1:Tue Jan  1 00:00:00 1980",
      startedAt: 0,
    });
    const res = sweepRunLiveness(db, {
      at: 1_000,
      startGraceMs: 0,
      identify: () => "reused",
    });
    expect(res.died[0].class).toBe("unknown");
    expect(getRun(db, id)!.state).toBe("failed");
    expect(getRun(db, id)!.error).toContain("reused");
    // The sweep never signals. The unrelated live process is untouched.
    expect(pidAlive(process.pid)).toBe(true);
  });

  test("a starting row with no PID waits for the launch grace window", () => {
    const taskId = newTask();
    const id = insertRun({ taskId, state: "starting", pid: null, startedAt: 10_000 });
    const early = sweepRunLiveness(db, { at: 11_000, startGraceMs: 60_000 });
    expect(early.died).toEqual([]);
    expect(getRun(db, id)!.state).toBe("starting");

    const late = sweepRunLiveness(db, { at: 70_001, startGraceMs: 60_000 });
    expect(late.died).toHaveLength(1);
    const run = getRun(db, id)!;
    expect(run.state).toBe("failed");
    expect(run.error).toContain("never recorded a pid");
  });

  test("a dead sandbox Run is failed by ISH-828's sweep and gets the cause", () => {
    process.env.RELAY_HUMAN = "coord";
    const taskId = newTask();
    const id = insertRun({
      taskId,
      pid: DEAD_PID,
      sandbox: "sbx-T29",
      stderr: "dsh: ENOSPC: no space left on device\n",
      startedAt: 0,
    });
    const cli: SbxCli = {
      run(args: string[]): SbxResult {
        return args.join(" ").includes("pgrep")
          ? { ok: true, code: 0, out: "GONE", err: "" }
          : { ok: true, code: 0, out: "", err: "" };
      },
    };

    const res = sweepRunLiveness(db, { at: 1_000, startGraceMs: 0, cli });
    expect(res.errors).toEqual([]);
    expect(res.died).toHaveLength(1);
    const run = getRun(db, id)!;
    expect(run.state).toBe("failed");
    expect(run.error).toContain("orphaned");
    expect(run.error).toContain("cause=ENOSPC");
    expect(run.error).toContain("no live sbx exec client");
    expect(runDiedEvents(id)).toHaveLength(1);

    // The dashboard shows the classified cause (text + JSON projection).
    const view = buildDashboardView(db, { root: dir, panes: null, at: 1_000 });
    expect(view.runs.find((r) => r.id === id)?.cause).toBe("ENOSPC");
    expect(view.attention.some((a) => a.kind === "run" && a.text.includes("cause=ENOSPC"))).toBe(true);
    const out = renderDashboard(view, { color: false, width: 180 });
    expect(out).toContain("RUNS");
    expect(out).toContain("ENOSPC");
    const json = JSON.parse(renderDashboardJson(view));
    expect(json.runs.find((r: { id: string }) => r.id === id)?.cause).toBe("ENOSPC");
  });

  test("a still-alive in-VM dsh leaves the sandbox Run fenced", () => {
    const taskId = newTask();
    const id = insertRun({ taskId, pid: DEAD_PID, sandbox: "sbx-live", startedAt: 0 });
    const cli: SbxCli = {
      run(args: string[]): SbxResult {
        // `pkill` does not change the outcome: still ALIVE -> unresolved.
        return args.join(" ").includes("pgrep")
          ? { ok: true, code: 0, out: "ALIVE", err: "" }
          : { ok: true, code: 0, out: "", err: "" };
      },
    };
    const res = sweepRunLiveness(db, { at: 1_000, startGraceMs: 0, cli });
    expect(res.died).toEqual([]);
    const run = getRun(db, id)!;
    expect(run.state).toBe("running");
    expect(run.error).toContain("still alive");
  });

  test("fails soft on a DB write error and retries on the next pass", () => {
    const taskId = newTask();
    const id = insertRun({
      taskId,
      pid: DEAD_PID,
      stderr: "ENOSPC: no space left on device\n",
      startedAt: 0,
    });
    // Simulate SQLITE_FULL/ENOSPC on the terminal update (the real incident).
    db.exec(
      `CREATE TRIGGER fail_terminal_write BEFORE UPDATE OF state ON runs
         WHEN NEW.state = 'failed'
       BEGIN
         SELECT RAISE(ABORT, 'database or disk is full');
       END;`
    );
    const first = maybeSweepRunLiveness(db, 1_000, { intervalMs: 45_000, startGraceMs: 0 });
    expect(first.errors).toHaveLength(1);
    expect(first.died).toEqual([]);
    expect(getRun(db, id)!.state).toBe("running");

    db.exec(`DROP TRIGGER fail_terminal_write;`);
    // A failed pass must NOT advance the durable throttle: the very next tick
    // retries instead of waiting out the whole interval.
    const second = maybeSweepRunLiveness(db, 1_001, { intervalMs: 45_000, startGraceMs: 0 });
    expect(second.skipped).toBe(false);
    expect(second.errors).toEqual([]);
    expect(second.died).toHaveLength(1);
    expect(getRun(db, id)!.state).toBe("failed");
  });

  test("the durable throttle skips passes but a failed pass does not advance it", () => {
    const taskId = newTask();
    const firstId = insertRun({ taskId, pid: DEAD_PID, startedAt: 0 });
    const first = maybeSweepRunLiveness(db, 1_000, { intervalMs: 45_000, startGraceMs: 0 });
    expect(first.skipped).toBe(false);
    expect(getRun(db, firstId)!.state).toBe("failed");

    const secondId = insertRun({ taskId, pid: DEAD_PID, startedAt: 0 });
    const skipped = maybeSweepRunLiveness(db, 2_000, { intervalMs: 45_000, startGraceMs: 0 });
    expect(skipped.skipped).toBe(true);
    expect(getRun(db, secondId)!.state).toBe("running");

    const due = maybeSweepRunLiveness(db, 46_000, { intervalMs: 45_000, startGraceMs: 0 });
    expect(due.skipped).toBe(false);
    expect(getRun(db, secondId)!.state).toBe("failed");
  });
});

describe("reconcile owns the liveness sweep (ISH-1008)", () => {
  test("one reconcile pass fails a dead Run without touching the Task", async () => {
    process.env.RELAY_RUN_LIVENESS_MS = "0";
    process.env.RELAY_HUMAN = "coord";
    const taskId = newTask();
    const id = insertRun({
      taskId,
      pid: DEAD_PID,
      stderr: "ENOSPC: no space left on device\n",
      startedAt: 0,
    });

    const { actions } = await reconcile(db, new MockRuntime(), 10_000);
    expect(actions).toContain(`run-died:${id}:ENOSPC`);
    const run = getRun(db, id)!;
    expect(run.state).toBe("failed");
    expect(run.error).toContain("cause=ENOSPC");
    // The Task itself is untouched: only the disposable Run ended.
    expect(getTask(db, taskId)!.state).toBe("queued");
    expect(getTask(db, taskId)!.phase).toBeNull();
  });

  test("`relay run show` reports the classified cause", () => {
    const taskId = newTask();
    const id = insertRun({
      taskId,
      pid: DEAD_PID,
      stderr: "ENOSPC: no space left on device\n",
      startedAt: 0,
    });
    sweepRunLiveness(db, { at: 1_000, startGraceMs: 0 });

    const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
    const r = Bun.spawnSync(["bun", cliPath, "run", "show", id], {
      cwd: dir,
      env: { ...process.env, RELAY_DB: dbPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    const out = r.stdout.toString();
    expect(out).toContain("state: failed");
    expect(out).toContain("cause=ENOSPC");
    expect(out).toContain("failure_class: ENOSPC");
  });
});
