import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { claimTask, getTask } from "../src/tasks";
import { registerWorker } from "../src/workers";
import { intakeTask, runMechanicalVerification, submitPhase, taskChecks } from "../src/workflow";
import { type DshProcess, type DshSpawner } from "../src/dsh-runner";
import { PINNED_DSH_VERSION } from "../src/dsh-version";
import { applyWorkspaceCleanup, launchTaskRun } from "../src/run-lifecycle";
import { pathSizeBytes, taskCargoTarget } from "../src/scratch";
import { scanRunLeaks } from "../src/run-leaks";
import { prepareReadOnlyReviewWorktree, removeReviewWorktree } from "../src/review-workspace";
import {
  REVIEW_WRITER_ACTIVE,
  runHeadlessReview,
  type ReviewerProcess,
  type ReviewerSpawnContext,
  type ReviewerSpawner,
} from "../src/reviewer-runner";
import { defaultRunner, gitHead, type CheckSpec, type ExecutedCheck, type CommandRunner } from "../src/verify";

/**
 * ISH-1225: the Cargo build cache belongs to the TASK, not the Run.
 *
 * A real throwaway repo + a fake dsh process proves the environment/cleanup/leak
 * wiring without building Rust. The VERIFY test uses the REAL command runner so
 * the asserted `CARGO_TARGET_DIR` is the one a child process actually observes.
 */

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
  envs: Record<string, string>[] = [];
  spawn(_argv: string[], opts: { cwd: string; env: Record<string, string> }): DshProcess {
    const p = new FakeProcess(50_000 + this.procs.length);
    this.procs.push(p);
    this.envs.push(opts.env);
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

function pinnedDshBin(): string {
  const p = join(dir, "bin", "dsh-pinned");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(p, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${PINNED_DSH_VERSION}; exit 0; fi\nexit 0\n`);
  chmodSync(p, 0o755);
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-ish1225-"));
  repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "relay@test");
  git(repo, "config", "user.name", "relay-test");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "base");
  process.env.RELAY_DB = join(dir, "state.db");
  process.env.RELAY_DSH_BIN = pinnedDshBin();
  process.env.RELAY_MIN_FREE_DISK_BYTES = "0";
  db = openDb(process.env.RELAY_DB);
  registerWorker(db, "impl", { role: "worker" });
  registerWorker(db, "ver", { role: "worker" });
  issueSeq = 0;
});

afterEach(() => {
  db.close();
  delete process.env.RELAY_DSH_BIN;
  delete process.env.RELAY_MIN_FREE_DISK_BYTES;
  rmSync(dir, { recursive: true, force: true });
});

const outputRoot = () => join(dir, "runs");
const worktreesRoot = () => join(dir, "worktrees");

function newTask(checks?: CheckSpec[]): string {
  return intakeTask(db, {
    provider: "test",
    issueId: `ISH-1225-${issueSeq++}`,
    codeChange: true,
    title: "task build cache",
    ...(checks ? { checks } : {}),
  }).id;
}

async function launch(taskId: string, spawner: FakeSpawner): Promise<void> {
  const launched = await launchTaskRun(db, taskId, {
    repo,
    worktreesRoot: worktreesRoot(),
    outputRoot: outputRoot(),
    spawner,
    fastExitMs: 0,
  });
  spawner.procs[0].finish(0);
  await launched.handle.wait();
}

function passingRunner(): CommandRunner {
  return {
    async run(spec): Promise<ExecutedCheck> {
      return {
        name: spec.name,
        required: spec.required !== false,
        outcome: "pass",
        exitCode: 0,
        output: "fake:pass",
        durationMs: 1,
      };
    },
  };
}

function reviewerSpawner(head: string): { spawner: ReviewerSpawner; calls: ReviewerSpawnContext[] } {
  const calls: ReviewerSpawnContext[] = [];
  const spawner: ReviewerSpawner = {
    async run(ctx): Promise<ReviewerProcess> {
      calls.push(ctx);
      return {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({ verdict: "pass", head, findings: [], summary: "ok" }),
        stderr: "",
      };
    },
  };
  return { spawner, calls };
}

describe("ISH-1225: one Task-level Cargo target for every phase", () => {
  test("implement Run, FIX Run and VERIFY share CARGO_TARGET_DIR; no second build dir", async () => {
    const check = { name: "cargo-env", command: 'printf "%s" "$CARGO_TARGET_DIR"' };
    const id = newTask([check]);
    const spawner1 = new FakeSpawner();
    await launch(id, spawner1);
    const worktree = getTask(db, id)!.worktree!;
    const target = taskCargoTarget(worktree);
    expect(spawner1.envs[0].CARGO_TARGET_DIR).toBe(target);
    const run1 = db.query(`SELECT output_dir FROM runs WHERE task_id = ? ORDER BY created_at ASC LIMIT 1`).get(id) as {
      output_dir: string;
    };
    expect(existsSync(join(run1.output_dir, "scratch", "cargo-target"))).toBe(false);

    // Warm the Task cache as the IMPLEMENT Run would have.
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "warm-marker"), "compiled once\n");

    // A second Run of the SAME Task (a FIX attempt) must reuse that directory.
    const spawner2 = new FakeSpawner();
    await launch(id, spawner2);
    expect(spawner2.envs[0].CARGO_TARGET_DIR).toBe(target);
    expect(existsSync(join(target, "warm-marker"))).toBe(true);
    const run2 = db.query(`SELECT output_dir FROM runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`).get(id) as {
      output_dir: string;
    };
    expect(run2.output_dir).not.toBe(run1.output_dir);
    expect(existsSync(join(run2.output_dir, "scratch", "cargo-target"))).toBe(false);

    // VERIFY uses the REAL runner: the child process must observe the same dir.
    claimTask(db, id, "impl");
    submitPhase(db, id, "impl", { headSha: gitHead(worktree) ?? undefined });
    expect(getTask(db, id)!.phase).toBe("verify");
    const v = await runMechanicalVerification(db, id, {
      checks: taskChecks(getTask(db, id)!),
      runner: defaultRunner,
      cwd: worktree,
    });
    expect(v.outcome).toBe("pass");
    expect(v.checks[0].output).toContain(target);
    expect(v.checks[0].output.trim()).toBe(target);
    expect(getTask(db, id)!.phase).toBe("review");
  });

  test("relay run cleanup --apply removes the Task build dir", async () => {
    const id = newTask();
    await launch(id, new FakeSpawner());
    const worktree = getTask(db, id)!.worktree!;
    const target = taskCargoTarget(worktree);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "warm-marker"), "remove me\n");
    db.query(`UPDATE tasks SET state='done', accepted_at=?, merged_at=? WHERE id=?`).run(Date.now(), Date.now(), id);

    const plan = await applyWorkspaceCleanup(db, id, {
      apply: true,
      repo,
      worktreesRoot: worktreesRoot(),
      outputRoot: outputRoot(),
    });
    expect(plan.remove).toBe(true);
    expect(plan.removed).toBe(true);
    expect(plan.buildDir).toBe(target);
    expect(plan.removedResources).toContain(`build ${target}`);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(worktree)).toBe(false);
  });

  test("relay run list --leaks reports the build dir only after the Task is terminal", async () => {
    const id = newTask();
    await launch(id, new FakeSpawner());
    const worktree = getTask(db, id)!.worktree!;
    const target = taskCargoTarget(worktree);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "warm-marker"), "size me\n");

    const live = scanRunLeaks(db, { repo, outputRoot: outputRoot(), worktreesRoot: worktreesRoot() });
    expect(live.entries.some((e) => e.kind === "build" && e.path === target)).toBe(false);
    expect(live.entries.some((e) => e.kind === "worktree" && e.path === worktree)).toBe(false);

    db.query(`UPDATE tasks SET state='done', accepted_at=?, merged_at=? WHERE id=?`).run(Date.now(), Date.now(), id);
    const terminal = scanRunLeaks(db, { repo, outputRoot: outputRoot(), worktreesRoot: worktreesRoot() });
    const build = terminal.entries.find((e) => e.kind === "build" && e.path === target);
    const wt = terminal.entries.find((e) => e.kind === "worktree" && e.path === worktree);
    expect(build?.taskId).toBe(id);
    expect(build?.sizeBytes).toBeGreaterThan(0);
    expect(wt?.taskId).toBe(id);
    // The build dir is reported separately, so the worktree entry excludes it.
    expect((wt?.sizeBytes ?? 0) + (build?.sizeBytes ?? 0)).toBe(pathSizeBytes(worktree) ?? 0);

    // The CLI renderer is the actual patrol surface the gateway reads.
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const out = execFileSync(
      process.execPath,
      [cli, "run", "list", "--leaks", "--json", "--repo", repo, "--worktrees", worktreesRoot()],
      {
        encoding: "utf8",
        env: { ...process.env, RELAY_DB: process.env.RELAY_DB!, RELAY_DOCKER_RESOURCES: "off", RELAY_MIN_FREE_DISK_BYTES: "0" },
      }
    );
    const report = JSON.parse(out) as { entries: { kind: string; path: string | null; taskId: string | null }[] };
    expect(report.entries.some((e) => e.kind === "build" && e.path === target && e.taskId === id)).toBe(true);
  });

  test("the reviewer reuses the Task target but is refused while a writer is live", async () => {
    const check = { name: "noop", command: "true" };
    const id = newTask([check]);
    await launch(id, new FakeSpawner());
    const worktree = getTask(db, id)!.worktree!;
    const target = taskCargoTarget(worktree);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "warm-marker"), "review me\n");

    claimTask(db, id, "impl");
    const head = gitHead(worktree)!;
    submitPhase(db, id, "impl", { headSha: head });
    const verify = await runMechanicalVerification(db, id, {
      checks: taskChecks(getTask(db, id)!),
      runner: passingRunner(),
      cwd: worktree,
      headProbe: () => head,
    });
    expect(verify.outcome).toBe("pass");
    expect(getTask(db, id)!.phase).toBe("review");

    // Production reviews run in a detached read-only checkout, but the build
    // cache stays the Task worktree's target.
    const reviewWorktree = join(dir, "review-ro");
    expect(prepareReadOnlyReviewWorktree(repo, head, reviewWorktree).ok).toBe(true);
    const { spawner, calls } = reviewerSpawner(head);
    try {
      const r = await runHeadlessReview(db, id, {
        spawner,
        reviewWorktree,
        scratchRoot: join(outputRoot(), "reviews", id, `1-${head.slice(0, 10)}`),
      });
      expect(r.outcome).toBe("pass");
      expect(calls[0].cwd).toBe(reviewWorktree);
      expect(calls[0].env.CARGO_TARGET_DIR).toBe(target);
      expect(calls[0].env.RELAY_TASK_CARGO_TARGET_DIR).toBe(target);
      expect(calls[0].env.TMPDIR).toContain(join(outputRoot(), "reviews", id));
      expect(calls[0].env.TMPDIR).not.toBe(target);
      expect(existsSync(join(calls[0].env.RELAY_SCRATCH_DIR!, "cargo-target"))).toBe(false);
    } finally {
      removeReviewWorktree(repo, reviewWorktree);
    }

    // Now a live writer on the SAME Task worktree: the reviewer must not start
    // and therefore cannot touch that target concurrently.
    const liveId = newTask([check]);
    const liveSpawner = new FakeSpawner();
    const launched = await launchTaskRun(db, liveId, {
      repo,
      worktreesRoot: worktreesRoot(),
      outputRoot: outputRoot(),
      spawner: liveSpawner,
      fastExitMs: 0,
    });
    const liveWorktree = getTask(db, liveId)!.worktree!;
    const liveTarget = taskCargoTarget(liveWorktree);
    mkdirSync(liveTarget, { recursive: true });
    db.query(`UPDATE tasks SET phase='review', state='review', head_sha=? WHERE id=?`).run(
      gitHead(liveWorktree),
      liveId
    );
    const refused = reviewerSpawner(gitHead(liveWorktree)!);
    try {
      const r = await runHeadlessReview(db, liveId, { spawner: refused.spawner });
      expect(r.outcome).toBe("refused");
      expect(r.error).toContain(REVIEW_WRITER_ACTIVE);
      expect(refused.calls).toEqual([]);
    } finally {
      liveSpawner.procs[0].finish(0);
      await launched.handle.wait();
    }
  });
});
