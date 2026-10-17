#!/usr/bin/env bun
/**
 * ISH-828 one-command local fixture smoke.
 *
 *   bun run smoke:sandbox
 *
 * Builds a throwaway main-checkout git repo + control plane and drives the REAL
 * Task Coding Sandbox lifecycle with a FAKE `sbx` CLI and a FAKE `sbx exec`
 * process (no Docker, no sandbox, no network). The produced commit is simulated
 * with a REAL local git remote named `sandbox-<name>`, so the host fetch and the
 * SQLite mapping are exercised for real:
 *
 *   create sandbox -> launch (fresh dsh Run) -> duplicate writer REFUSED ->
 *   submit -> FIX reuses the SAME sandbox + inherits findings -> new Run ->
 *   safe cleanup after abort (evidence retained).
 *
 * Exits non-zero on the first failed assertion. The REAL sandbox smoke is
 * `scripts/ish828-real-smoke.ts` (opt-in, requires a logged-in `sbx`).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { getTask } from "../src/tasks";
import { intakeTask } from "../src/workflow";
import { getRun, type DshProcess, type DshSpawner } from "../src/dsh-runner";
import {
  acceptSandboxSubmission,
  applySandboxCleanup,
  ensureTaskSandbox,
  launchTaskSandboxRun,
  planSandboxCleanup,
} from "../src/sandbox-lifecycle";
import { getSandbox, type SbxCli, type SbxResult } from "../src/sandbox";

let steps = 0;
function ok(msg: string): void {
  steps++;
  console.log(`  ok ${steps}. ${msg}`);
}
function fail(msg: string): never {
  console.error(`  FAIL: ${msg}`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): void {
  if (cond) ok(msg);
  else fail(msg);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

class FakeProcess implements DshProcess {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number | null>;
  private outC!: ReadableStreamDefaultController<Uint8Array>;
  private errC!: ReadableStreamDefaultController<Uint8Array>;
  private resolveExit!: (c: number | null) => void;
  private finished = false;
  constructor(pid: number) {
    this.pid = pid;
    this.stdout = new ReadableStream({ start: (c) => (this.outC = c) });
    this.stderr = new ReadableStream({ start: (c) => (this.errC = c) });
    this.exited = new Promise<number | null>((res) => (this.resolveExit = res));
  }
  emit(s: string): void {
    this.outC.enqueue(new TextEncoder().encode(s));
  }
  finish(code: number | null): void {
    if (this.finished) return;
    this.finished = true;
    try { this.outC.close(); } catch { /* noop */ }
    try { this.errC.close(); } catch { /* noop */ }
    this.resolveExit(code);
  }
  kill(): void {
    this.finish(143);
  }
}

class FakeSpawner implements DshSpawner {
  procs: FakeProcess[] = [];
  argv: string[][] = [];
  onSpawn?: (p: FakeProcess, argv: string[]) => void;
  spawn(argv: string[], _opts: { cwd: string; env: Record<string, string> }): DshProcess {
    const p = new FakeProcess(40_000 + this.procs.length);
    this.procs.push(p);
    this.argv.push(argv);
    this.onSpawn?.(p, argv);
    return p;
  }
}

class FakeSbx implements SbxCli {
  created: string[] = [];
  currentBranch = "main";
  headSha = "b".repeat(40);
  run(args: string[]): SbxResult {
    const ok = (out = ""): SbxResult => ({ ok: true, code: 0, out, err: "" });
    if (args[0] === "ls") return ok(JSON.stringify(this.created.map((name) => ({ name, status: "running" }))));
    if (args[0] === "create") {
      const i = args.indexOf("--name");
      this.created.push(args[i + 1]);
      return ok("Created sandbox");
    }
    if (args[0] === "exec") {
      const joined = args.join(" ");
      if (joined.includes("git checkout")) {
        const m = joined.match(/git checkout (?:-b )?([^\s;&|]+)/);
        if (m) this.currentBranch = m[1];
        return ok("");
      }
      if (joined.includes("rev-parse HEAD")) return ok(this.headSha);
      if (joined.includes("rev-parse --abbrev-ref HEAD")) return ok(this.currentBranch);
      if (joined.includes("--version")) return ok("0.2.1-rc.2");
      return ok("");
    }
    if (args[0] === "rm") {
      this.created = this.created.filter((n) => n !== args[args.length - 1]);
      return ok("removed");
    }
    return ok("");
  }
}

function dshStream(p: FakeProcess): void {
  p.emit(JSON.stringify({ type: "session", sessionId: "session-smoke", cwd: "/workspace" }) + "\n");
  p.emit(JSON.stringify({ type: "tool_call", callId: "c1", tool: "bash" }) + "\n");
  p.emit(JSON.stringify({ type: "tool_result", callId: "c1", status: "completed", result: "ok" }) + "\n");
  p.emit(JSON.stringify({ type: "final", text: "done" }) + "\n");
}

const dir = mkdtempSync(join(tmpdir(), "relay-ish828-smoke-"));
process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

try {
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "smoke@test");
  git(repo, "config", "user.name", "relay-smoke");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "base");

  process.env.RELAY_DB = join(dir, "state.db");
  const db = openDb(process.env.RELAY_DB);
  const task = intakeTask(db, { provider: "smoke", issueId: "ISH-828-SMOKE", codeChange: true, title: "sandbox smoke" });
  const outputRoot = join(dir, "runs");

  // 1. Create the Task Coding Sandbox (clone mode) from the main checkout.
  const sbx = new FakeSbx();
  const binding = ensureTaskSandbox(db, task.id, { source: repo, agent: "ishiul-coding", cli: sbx });
  assert(binding.created, `created a clone-mode sandbox ${binding.name}`);
  assert(getSandbox(db, task.id)!.state === "running", "the Task -> sandbox mapping is durable (running)");

  // 2. Launch ONE fresh dsh Run inside the sandbox.
  const spawner = new FakeSpawner();
  spawner.onSpawn = (p, argv) => {
    assert(
      argv[0].endsWith("sbx") && argv[1] === "exec" && argv.includes(binding.name),
      "the Run is an `sbx exec` into the Task sandbox"
    );
    dshStream(p);
    p.finish(0);
  };
  const launched = await launchTaskSandboxRun(db, task.id, { source: repo, cli: sbx, spawner, outputRoot, fastExitMs: 0 });

  // 3. A second writer is refused while the first Run holds the sandbox.
  let refused = false;
  try {
    await launchTaskSandboxRun(db, task.id, { source: repo, cli: sbx, spawner, outputRoot });
  } catch (e) {
    refused = String(e).includes("DUPLICATE_SANDBOX_WRITER");
  }
  assert(refused, "a second writer into the same sandbox is refused");

  // 4. Simulate the in-container commit and fetch it back to the host.
  const bare = join(dir, "bare.git");
  const producer = join(dir, "producer");
  mkdirSync(producer, { recursive: true });
  git(producer, "init", "-q", "-b", binding.branch);
  git(producer, "config", "user.email", "sbx@test");
  git(producer, "config", "user.name", "sbx");
  writeFileSync(join(producer, "change.txt"), "sandbox change\n");
  git(producer, "add", "change.txt");
  git(producer, "commit", "-q", "-m", "sandbox commit");
  const produced = git(producer, "rev-parse", "HEAD");
  git(producer, "init", "-q", "--bare", bare);
  git(producer, "remote", "add", "origin", bare);
  git(producer, "push", "-q", "origin", `${binding.branch}:refs/heads/${binding.branch}`);
  git(repo, "remote", "add", `sandbox-${binding.name}`, bare);

  const run = await launched.handle.wait();
  assert(run.state === "exited" && run.exit_code === 0, "the Run exited 0 (still not a submission)");
  assert(run.head_sha === produced, `the produced commit was fetched back to the host (${produced.slice(0, 12)})`);
  assert(existsSync(run.dsh_events_path!) && existsSync(run.events_path!), "dsh JSONL + Relay events evidence exist");

  // 5. Structured submission advances the Task.
  acceptSandboxSubmission(db, { runId: run.id });
  assert(getTask(db, task.id)!.phase !== "implement", "the structured submission advanced the phase");

  // 6. A FIX reuses the SAME sandbox and pins the previous findings.
  const t = getTask(db, task.id)!;
  db.query(`UPDATE tasks SET phase='implement', attempt=attempt+1, head_sha=NULL WHERE id=?`).run(task.id);
  db.query(
    `INSERT INTO task_results (task_id, phase, attempt, kind, worker_id, passed, reason, payload_json, created_at)
     VALUES (?, 'review', ?, 'ReviewResult', 'rev', 0, 'fix the smoke', '{}', ?)`
  ).run(task.id, t.attempt, Date.now());
  const second = await launchTaskSandboxRun(db, task.id, { source: repo, cli: sbx, spawner, outputRoot, fastExitMs: 0 });
  assert(second.sandbox.name === binding.name && !second.sandbox.created, "the FIX reused the SAME sandbox (no new clone)");
  assert(readFileSync(second.run.spec_path!, "utf8").includes("fix the smoke"), "the previous finding is pinned into the brief");
  const run2 = await second.handle.wait();
  assert(run2.id !== run.id && run2.state === "exited", "the FIX is a NEW Run, not a session continuation");

  // 7. Safe cleanup after an explicit abort; every Run's evidence is retained.
  const abort = planSandboxCleanup(db, task.id, { abort: "smoke done", cli: sbx });
  assert(abort.removed === false, "cleanup is a dry-run plan without --apply");
  const cleanup = applySandboxCleanup(db, task.id, { apply: true, abort: "smoke done", cli: sbx });
  assert(cleanup.removed, "the aborted sandbox is removed");
  assert(getRun(db, run.id) !== null && existsSync(run.output_dir), "the Run row + output dir are retained as evidence");

  db.close();
  console.log(`\nPASS — ${steps} checks`);
} catch (e) {
  console.error(`\nFAIL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exitCode = 1;
}
