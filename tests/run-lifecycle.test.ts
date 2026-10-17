import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { getTask, claimTask, claimNext } from "../src/tasks";
import { registerWorker } from "../src/workers";
import { intakeTask, recordReview, recordVerification } from "../src/workflow";
import { getRun, listRuns, type DshProcess, type DshSpawner } from "../src/dsh-runner";
import { PINNED_DSH_VERSION } from "../src/dsh-version";
import {
  applyWorkspaceCleanup,
  buildRunBrief,
  DUPLICATE_WRITER,
  ensureTaskWorktree,
  findActiveWriter,
  inheritFindings,
  launchTaskRun,
  planWorkspaceCleanup,
  runSubmitterError,
  taskBranchName,
} from "../src/run-lifecycle";

// ISH-760: the Task worktree + disposable dsh Run lifecycle, single-writer.
// A REAL temp git repo + a FAKE dsh process (no real dsh, no network) keep the
// whole lifecycle deterministic.

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

  constructor(pid: number) {
    this.pid = pid;
    this.stdout = new ReadableStream({ start: (c) => (this.outC = c) });
    this.stderr = new ReadableStream({ start: (c) => (this.errC = c) });
    this.exited = new Promise<number | null>((res) => (this.resolveExit = res));
  }
  writeOut(s: string): void {
    this.outC.enqueue(new TextEncoder().encode(s));
  }
  finish(code: number | null): void {
    if (this.finished) return;
    this.finished = true;
    try {
      this.outC.close();
    } catch { /* noop */ }
    try {
      this.errC.close();
    } catch { /* noop */ }
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
  cwds: string[] = [];
  envs: Record<string, string>[] = [];
  onSpawn?: (p: FakeProcess, opts: { cwd: string; env: Record<string, string> }) => void;

  spawn(argv: string[], opts: { cwd: string; env: Record<string, string> }): DshProcess {
    const p = new FakeProcess(20_000 + this.procs.length);
    this.procs.push(p);
    this.argv.push(argv);
    this.cwds.push(opts.cwd);
    this.envs.push(opts.env);
    this.onSpawn?.(p, opts);
    return p;
  }
}

let dir = "";
let repo = "";
let db: Database;
let issueSeq = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

/**
 * ISH-869: the host runner probes `<dshBin> --version`; the fake-process tests
 * below point `RELAY_DSH_BIN` at a fake that reports the pin.
 */
function pinnedDshBin(): string {
  const p = join(dir, "bin", "dsh-pinned");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(p, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${PINNED_DSH_VERSION}; exit 0; fi\nexit 0\n`);
  chmodSync(p, 0o755);
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-ish760-"));
  repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "relay@test");
  git(repo, "config", "user.name", "relay-test");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "base");
  process.env.RELAY_DB = join(dir, "state.db");
  db = openDb(process.env.RELAY_DB);
  registerWorker(db, "impl", { role: "worker" });
  registerWorker(db, "rev", { role: "reviewer" });
  issueSeq = 0;
  // ISH-869: launchTaskRun -> startDshRun probes `<dshBin> --version`.
  process.env.RELAY_DSH_BIN = pinnedDshBin();
});

afterEach(() => {
  db.close();
  delete process.env.RELAY_DSH_BIN;
  rmSync(dir, { recursive: true, force: true });
});

/** A code-change task with NO linked worktree/branch (a fresh manual injection). */
function newTask(extra: { prUrl?: string; checks?: { name: string; command: string }[] } = {}) {
  const t = intakeTask(db, {
    provider: "test",
    issueId: `ISH-760-${issueSeq++}`,
    codeChange: true,
    title: "implement the thing",
    prUrl: extra.prUrl,
    checks: extra.checks,
  });
  return t.id;
}

const outputRoot = () => join(dir, "runs");

describe("Task worktree: create / select / own (one branch+worktree per Task)", () => {
  test("creates a worktree on a deterministic branch and records it on the Task", () => {
    const id = newTask();
    const b = ensureTaskWorktree(db, id, { repo });
    expect(b.created).toBe(true);
    expect(existsSync(b.worktree)).toBe(true);
    expect(b.branch.startsWith("relay/")).toBe(true);
    expect(git(b.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(b.branch);
    // The Task durably owns the worktree/branch.
    const task = getTask(db, id)!;
    expect(task.worktree).toBe(b.worktree);
    expect(task.branch).toBe(b.branch);
  });

  test("is idempotent: a second call SELECTS the same worktree (no new branch)", () => {
    const id = newTask();
    const b1 = ensureTaskWorktree(db, id, { repo });
    const b2 = ensureTaskWorktree(db, id, { repo });
    expect(b2.created).toBe(false);
    expect(b2.worktree).toBe(b1.worktree);
    expect(b2.branch).toBe(b1.branch);
    // Exactly one worktree listing for that path.
    const list = git(repo, "worktree", "list", "--porcelain");
    expect(list.split(`${b1.worktree}`).length - 1).toBe(1);
  });

  test("refuses a non-code-change task", () => {
    const t = intakeTask(db, { provider: "test", issueId: `ISH-760-plain-${issueSeq++}`, title: "plain" });
    expect(() => ensureTaskWorktree(db, t.id, { repo })).toThrow(/not a code-change task/);
  });

  test("taskBranchName is deterministic and honours an explicit branch", () => {
    const id = newTask();
    const t = getTask(db, id)!;
    expect(taskBranchName(t)).toContain("ish-760-");
    expect(taskBranchName({ ...t, branch: "feature/x" })).toBe("feature/x");
  });
});

describe("single-writer: one disposable Run per phase/attempt", () => {
  test("launch ensures the worktree, pins the brief, and runs in it", async () => {
    const id = newTask();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => {
      p.writeOut("done\n");
      p.finish(0);
    };
    const launched = await launchTaskRun(db, id, { repo, spawner, outputRoot: outputRoot(), fastExitMs: 0 });
    const run = await launched.handle.wait();

    expect(run.state).toBe("exited");
    expect(run.exit_code).toBe(0);
    expect(run.cwd).toBe(launched.worktree);
    expect(spawner.cwds[0]).toBe(launched.worktree);
    // ISH-810: the pinned headless CLI now carries `--json` before the task.
    expect(spawner.argv[0][0]).toBe(process.env.RELAY_DSH_BIN!);
    expect(spawner.argv[0].slice(1, 5)).toEqual(["--profile", "headless", "--json", expect.any(String)]);
    expect(spawner.argv[0][4]).toContain(`# Task ${id}`);
    expect(run.generation).toBe(run.attempt);
    // The brief is pinned IN the worktree before launch.
    expect(existsSync(launched.briefPath)).toBe(true);
    expect(readFileSync(launched.briefPath, "utf-8")).toContain(`branch: ${launched.branch}`);
  });

  test("a duplicate writer on the same worktree/branch is refused while the Run is live", async () => {
    const id = newTask();
    const slow = new FakeSpawner(); // never finishes
    const launched = await launchTaskRun(db, id, { repo, spawner: slow, outputRoot: outputRoot() });
    expect(getRun(db, launched.handle.id)!.state).toBe("running");

    await expect(launchTaskRun(db, id, { repo, spawner: new FakeSpawner(), outputRoot: outputRoot() })).rejects.toThrow(
      new RegExp(DUPLICATE_WRITER)
    );

    // Different worktree (a different Task) may run in parallel — even on the
    // same files — so a second Task's launch is allowed.
    const other = newTask();
    const otherSpawner = new FakeSpawner();
    const otherLaunched = await launchTaskRun(db, other, { repo, spawner: otherSpawner, outputRoot: outputRoot() });
    expect(getRun(db, otherLaunched.handle.id)!.state).toBe("running");
    expect(otherLaunched.worktree).not.toBe(launched.worktree);

    // Once the first Run ENDS, the writer is released.
    slow.procs[0].finish(0);
    await launched.handle.wait();
    const again = await launchTaskRun(db, id, { repo, spawner: new FakeSpawner(), outputRoot: outputRoot() });
    expect(getRun(db, again.handle.id)!.state).toBe("running");
    again.handle.cancel();
  });

  test("findActiveWriter keys on worktree OR branch, never on unrelated Runs", async () => {
    const a = newTask();
    const b = newTask();
    const la = await launchTaskRun(db, a, { repo, spawner: new FakeSpawner(), outputRoot: outputRoot() });
    expect(findActiveWriter(db, { cwd: la.worktree })!.id).toBe(la.handle.id);
    expect(findActiveWriter(db, { cwd: la.worktree, branch: la.branch })!.id).toBe(la.handle.id);
    // A different worktree/branch has no active writer.
    const lb = ensureTaskWorktree(db, b, { repo });
    expect(findActiveWriter(db, { cwd: lb.worktree, branch: lb.branch })).toBeNull();
    la.handle.cancel();
  });

  test("a refused launch does NOT overwrite the live writer's pinned brief (finding 2)", async () => {
    const id = newTask();
    const slow = new FakeSpawner(); // never finishes: the first Run stays live
    const first = await launchTaskRun(db, id, { repo, spawner: slow, outputRoot: outputRoot() });
    const briefBefore = readFileSync(first.briefPath, "utf-8");
    expect(briefBefore).toContain("implement the thing");

    // A would-be second launcher changes the Task so a FRESH brief WOULD differ.
    db.query(`UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?`).run("CHANGED title", Date.now(), id);

    await expect(
      launchTaskRun(db, id, { repo, spawner: new FakeSpawner(), outputRoot: outputRoot() })
    ).rejects.toThrow(new RegExp(DUPLICATE_WRITER));

    // The brief the LIVE Run was launched with is byte-for-byte unchanged.
    const briefAfter = readFileSync(first.briefPath, "utf-8");
    expect(briefAfter).toBe(briefBefore);
    expect(briefAfter).not.toContain("CHANGED title");

    slow.procs[0].finish(0);
    await first.handle.wait();
  });
});

describe("single-writer is atomic ACROSS PROCESSES (finding 1)", () => {
  test("two concurrent launch processes admit exactly one writer", async () => {
    const id = newTask();
    const binding = ensureTaskWorktree(db, id, { repo });

    // A fake dsh that HOLDS the worktree, so the loser observes the live row.
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    const dsh = join(binDir, "dsh-race");
    writeFileSync(dsh, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.2.1-rc.2; exit 0; fi\nsleep 1.5\nexit 0\n');
    chmodSync(dsh, 0o755);

    const fixture = join(import.meta.dir, "fixtures", "ish760-race.ts");
    const repoRoot = join(import.meta.dir, "..");
    const env = {
      ...process.env,
      RELAY_DB: process.env.RELAY_DB!,
      TASK_ID: id,
      WORKTREE: binding.worktree,
      OUTPUT_ROOT: outputRoot(),
      DSH_BIN: dsh,
      // A start barrier: both processes hit the guard at ~the same instant.
      GO_AT: String(Date.now() + 1200),
    };
    const spawn = () => Bun.spawn(["bun", fixture], { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" });
    const p1 = spawn();
    const p2 = spawn();
    const outs = await Promise.all([new Response(p1.stdout).text(), new Response(p2.stdout).text()]);
    const codes = await Promise.all([p1.exited, p2.exited]);

    const admitted = outs.filter((o) => /^ADMITTED /m.test(o));
    const refused = outs.filter((o) => /DUPLICATE_WRITER/.test(o));
    expect(codes).toEqual([0, 0]);
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(listRuns(db, { taskId: id })).toHaveLength(1);
  }, 20000);
});

describe("FIX: same worktree + previous findings + a new Run (no session continuation)", () => {
  test("a review FIX reuses the worktree and pins the previous findings", async () => {
    const id = newTask();
    // implement (Run) -> adopt head -> verify -> review FIX -> implement attempt 1.
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => p.finish(0);
    const impl = await launchTaskRun(db, id, { repo, spawner, outputRoot: outputRoot(), fastExitMs: 0 });
    await impl.handle.wait();
    const { acceptRunSubmission } = await import("../src/dsh-runner");
    acceptRunSubmission(db, { runId: impl.handle.id });
    expect(getTask(db, id)!.phase).toBe("verify");

    const head = getTask(db, id)!.head_sha;
    claimTask(db, id, "impl");
    recordVerification(db, id, "impl", { passed: true });
    expect(getTask(db, id)!.phase).toBe("review");
    claimNext(db, "rev");
    recordReview(db, id, "rev", { verdict: "fix", headSha: head ?? undefined, reason: "null deref in parser" });
    const afterFix = getTask(db, id)!;
    expect(afterFix.phase).toBe("implement");
    expect(afterFix.attempt).toBe(1);

    // The findings are inherited from attempt 0's review.
    const findings = inheritFindings(db, afterFix);
    expect(findings.length).toBe(1);
    expect(findings[0].reason).toBe("null deref in parser");

    const fixSpawner = new FakeSpawner();
    fixSpawner.onSpawn = (p) => p.finish(0);
    const fix = await launchTaskRun(db, id, { repo, spawner: fixSpawner, outputRoot: outputRoot(), fastExitMs: 0 });
    expect(fix.worktree).toBe(impl.worktree); // SAME worktree
    expect(fix.handle.id).not.toBe(impl.handle.id); // a NEW disposable Run
    expect(fix.findings.length).toBe(1);
    const brief = readFileSync(fix.briefPath, "utf-8");
    expect(brief).toContain("Prior findings");
    expect(brief).toContain("null deref in parser");
    await fix.handle.wait();
  });

  test("buildRunBrief includes the verification steps recorded at intake", () => {
    const id = newTask({ checks: [{ name: "typecheck", command: "bun run typecheck" }] });
    const b = ensureTaskWorktree(db, id, { repo });
    const brief = buildRunBrief(db, getTask(db, id)!, { worktree: b.worktree, branch: b.branch });
    expect(brief.text).toContain("## Verification steps");
    expect(brief.text).toContain("bun run typecheck");
    expect(brief.findings).toEqual([]);
  });
});

describe("submitter binding: a stale/late/failed Run never advances the Task", () => {
  async function cleanRun(id: string) {
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => p.finish(0);
    const launched = await launchTaskRun(db, id, { repo, spawner, outputRoot: outputRoot(), fastExitMs: 0 });
    const run = await launched.handle.wait();
    return { run, launched };
  }

  test("a correctly-bound Run advances implement -> verify", async () => {
    const id = newTask();
    const { run } = await cleanRun(id);
    expect(runSubmitterError(run, getTask(db, id)!)).toBeNull();
    const { acceptRunSubmission } = await import("../src/dsh-runner");
    const accepted = acceptRunSubmission(db, { runId: run.id });
    expect(accepted.state).toBe("submitted");
    expect(getTask(db, id)!.phase).toBe("verify");
  });

  test("a moved task head refuses the submission", async () => {
    const id = newTask();
    const { run } = await cleanRun(id);
    const { acceptRunSubmission } = await import("../src/dsh-runner");
    const { linkTask } = await import("../src/workflow");
    linkTask(db, id, { headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });
    expect(() => acceptRunSubmission(db, { runId: run.id })).toThrow(/RUN_SUBMISSION_REJECTED/);
    expect(getTask(db, id)!.phase).toBe("implement");
  });

  test("a superseded (late) Run is refused even if it exited 0", async () => {
    const id = newTask();
    const { run } = await cleanRun(id);
    // A NEWER Run row for the same task/phase/attempt supersedes it.
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => p.finish(0);
    const newer = await launchTaskRun(db, id, { repo, spawner, outputRoot: outputRoot(), fastExitMs: 0 });
    await newer.handle.wait();
    const { acceptRunSubmission } = await import("../src/dsh-runner");
    expect(() => acceptRunSubmission(db, { runId: run.id })).toThrow(/superseded/);
  });

  test("runSubmitterError reports a phase/attempt/generation mismatch", () => {
    const t = getTask(db, newTask())!;
    const fake = (over: Partial<Parameters<typeof runSubmitterError>[0]>) =>
      ({ id: "run-x", task_id: t.id, phase: t.phase, attempt: t.attempt, generation: t.attempt, branch: null, base_head_sha: null, ...over }) as never;
    expect(runSubmitterError(fake({}), t)).toBeNull();
    expect(runSubmitterError(fake({ phase: "review" }), t)).toMatch(/phase/);
    expect(runSubmitterError(fake({ attempt: 9 }), t)).toMatch(/attempt/);
    expect(runSubmitterError(fake({ generation: 9 }), t)).toMatch(/generation/);
    expect(runSubmitterError(fake({ task_id: "T999" }), t)).toMatch(/belongs to task/);
  });
});

describe("safe cleanup: permissions, evidence, PR lifecycle", () => {
  test("a live Run blocks cleanup; an open PR blocks cleanup", async () => {
    const id = newTask({ prUrl: "https://example.test/pr/1" });
    const launched = await launchTaskRun(db, id, { repo, spawner: new FakeSpawner(), outputRoot: outputRoot() });
    const plan = planWorkspaceCleanup(db, id, { repo, worktreesRoot: join(dir, "worktrees") });
    expect(plan.remove).toBe(false);
    expect(plan.reasons.join(" ")).toMatch(/active run/);
    launched.handle.cancel();
    await launched.handle.wait();
    const plan2 = planWorkspaceCleanup(db, id, { repo, worktreesRoot: join(dir, "worktrees") });
    expect(plan2.reasons.join(" ")).toMatch(/open PR/);
  });

  test("an explicit abort allows reclaiming the worktree", async () => {
    const id = newTask();
    const b = ensureTaskWorktree(db, id, { repo });
    const plan = applyWorkspaceCleanup(db, id, { apply: true, abort: "Gateway abandoned the lane", repo, worktreesRoot: join(dir, "worktrees") });
    expect(plan.removed).toBe(true);
    expect(existsSync(b.worktree)).toBe(false);
    expect(getTask(db, id)!.worktree).toBeNull();
  });

  test("a real merge allows cleanup and the run evidence is retained", async () => {
    const id = newTask();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => p.finish(0);
    const launched = await launchTaskRun(db, id, { repo, spawner, outputRoot: outputRoot(), fastExitMs: 0 });
    const run = await launched.handle.wait();
    // Simulate a real merge observed on the provider.
    db.query(`UPDATE tasks SET state='done', accepted_at=?, merged_at=? WHERE id=?`).run(Date.now(), Date.now(), id);

    const plan = applyWorkspaceCleanup(db, id, { apply: true, repo, worktreesRoot: join(dir, "worktrees") });
    expect(plan.removed).toBe(true);
    expect(plan.retainedRuns).toBeGreaterThanOrEqual(1);
    // Evidence survives: the run row + its output dir are untouched.
    expect(getRun(db, run.id)).not.toBeNull();
    expect(existsSync(run.output_dir)).toBe(true);
  });

  test("uncommitted changes block cleanup unless forced", async () => {
    const id = newTask();
    const b = ensureTaskWorktree(db, id, { repo });
    writeFileSync(join(b.worktree, "wip.txt"), "uncommitted\n");
    const blocked = applyWorkspaceCleanup(db, id, { apply: true, abort: "abort", repo, worktreesRoot: join(dir, "worktrees") });
    expect(blocked.removed).toBe(false);
    expect(blocked.reasons.join(" ")).toMatch(/uncommitted/);
    const forced = applyWorkspaceCleanup(db, id, { apply: true, force: true, abort: "abort", repo, worktreesRoot: join(dir, "worktrees") });
    expect(forced.removed).toBe(true);
  });

  test("a human (non relay-owned) worktree is never removed", async () => {
    const id = newTask();
    // A human checkout OUTSIDE the relay worktrees root.
    const human = join(dir, "human-checkout");
    git(repo, "worktree", "add", "-b", "human/branch", human, "HEAD");
    db.query(`UPDATE tasks SET worktree = ?, branch = 'human/branch', merged_at = ?, state='done' WHERE id = ?`).run(
      human,
      Date.now(),
      id
    );
    const plan = applyWorkspaceCleanup(db, id, { apply: true, repo, worktreesRoot: join(dir, "worktrees") });
    expect(plan.removed).toBe(false);
    expect(plan.reasons.join(" ")).toMatch(/not relay-owned/);
    expect(existsSync(human)).toBe(true);
  });
});
