import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { claimTask, getTask } from "../src/tasks";
import { registerWorker } from "../src/workers";
import { intakeTask, runMechanicalVerification, submitPhase, taskChecks } from "../src/workflow";
import { startDshRun, type DshProcess, type DshSpawner } from "../src/dsh-runner";
import { PINNED_DSH_VERSION } from "../src/dsh-version";
import { applyWorkspaceCleanup, ensureTaskWorktree, launchTaskRun } from "../src/run-lifecycle";
import { disabledRunResourceDocker } from "../src/run-resources";
import { taskCargoTarget } from "../src/scratch";
import {
  beginReviewFence,
  findLiveReviewFenceRow,
  releaseReviewFence,
  REVIEW_IN_FLIGHT,
} from "../src/review-fence";
import {
  runHeadlessReview,
  type ReviewerProcess,
  type ReviewerSpawner,
} from "../src/reviewer-runner";
import { gitHead, type CheckSpec, type CommandRunner, type ExecutedCheck } from "../src/verify";

/**
 * ISH-1226: two follow-ups from the ISH-1225 review.
 *
 * 1. `target/` is Relay scratch ONLY when the repo does not track files under
 *    it. A repo that tracks `target/` must see an uncommitted edit there in the
 *    cleanup dirty guard (refused, patch saved, nothing deleted); an untracked
 *    `target/` is still reclaimed as the Task build cache.
 * 2. A headless review takes a durable fence. `startDshRun` refuses a writer
 *    while that fence is live, so a manual `relay run start` cannot overlap the
 *    reviewer on the shared `target/` even though the reviewer is not a Run row.
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
  spawn(_argv: string[], _opts: { cwd: string; env: Record<string, string> }): DshProcess {
    const p = new FakeProcess(60_000 + this.procs.length);
    this.procs.push(p);
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
  dir = mkdtempSync(join(tmpdir(), "relay-ish1226-"));
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
    issueId: `ISH-1226-${issueSeq++}`,
    codeChange: true,
    title: "tracked target + review fence",
    ...(checks ? { checks } : {}),
  }).id;
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

function reviewerSpawner(
  head: string,
  during?: () => void | Promise<void>
): { spawner: ReviewerSpawner; calls: number } {
  const state = { calls: 0 };
  const spawner: ReviewerSpawner = {
    async run(): Promise<ReviewerProcess> {
      state.calls++;
      await during?.();
      return {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({ verdict: "pass", head, findings: [], summary: "ok" }),
        stderr: "",
      };
    },
  };
  return { spawner, get calls() { return state.calls; } };
}

describe("ISH-1226: a tracked target/ is never mistaken for the build cache", () => {
  test("a tracked target/ with an uncommitted edit refuses cleanup and deletes nothing", async () => {
    const id = newTask();
    const { worktree } = ensureTaskWorktree(db, id, { repo, worktreesRoot: worktreesRoot() });
    const target = taskCargoTarget(worktree);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "tracked.txt"), "committed build input\n");
    git(worktree, "add", "target/tracked.txt");
    git(worktree, "-c", "user.email=relay@test", "-c", "user.name=relay-test", "commit", "-q", "-m", "track target");
    writeFileSync(join(target, "tracked.txt"), "uncommitted edit\n");
    db.query(`UPDATE tasks SET state='cancelled' WHERE id=?`).run(id);

    const plan = await applyWorkspaceCleanup(db, id, {
      apply: true,
      repo,
      worktreesRoot: worktreesRoot(),
      outputRoot: outputRoot(),
      docker: disabledRunResourceDocker(),
    });

    // The dirty guard INCLUDES target/ when it has tracked files.
    expect(plan.remove).toBe(false);
    expect(plan.reasons.join(" ")).toMatch(/uncommitted/);
    // It is not Relay's build cache, so the apply path must not reclaim it.
    expect(plan.buildDir).toBeNull();
    expect(plan.savedPatch).toBeTruthy();
    expect(readFileSync(plan.savedPatch!, "utf-8")).toContain("uncommitted edit");
    // Nothing was deleted.
    expect(existsSync(worktree)).toBe(true);
    expect(readFileSync(join(target, "tracked.txt"), "utf-8")).toBe("uncommitted edit\n");
  });

  test("an untracked target/ is still reclaimed as the Task build cache", async () => {
    const id = newTask();
    const { worktree } = ensureTaskWorktree(db, id, { repo, worktreesRoot: worktreesRoot() });
    const target = taskCargoTarget(worktree);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "warm-marker"), "remove me\n");
    db.query(`UPDATE tasks SET state='cancelled' WHERE id=?`).run(id);

    const plan = await applyWorkspaceCleanup(db, id, {
      apply: true,
      repo,
      worktreesRoot: worktreesRoot(),
      outputRoot: outputRoot(),
      docker: disabledRunResourceDocker(),
    });

    expect(plan.remove).toBe(true);
    expect(plan.buildDir).toBe(target);
    expect(plan.removedResources).toContain(`build ${target}`);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(worktree)).toBe(false);
  });
});

describe("ISH-1226: startDshRun refuses a writer while a review fence is live", () => {
  test("the same Task cannot start a writer while its review is in flight", async () => {
    const id = newTask();
    const { worktree, branch } = ensureTaskWorktree(db, id, { repo, worktreesRoot: worktreesRoot() });
    const head = gitHead(worktree)!;
    const fence = beginReviewFence(db, {
      taskId: id,
      worktree,
      branch,
      headSha: head,
      timeoutMs: 60_000,
    });
    expect(findLiveReviewFenceRow(db, { taskId: id })?.token).toBe(fence.token);

    const spawner = new FakeSpawner();
    const before = db.query(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number };
    try {
      await expect(
        startDshRun(db, {
          taskId: id,
          cwd: worktree,
          outputRoot: outputRoot(),
          spawner,
          fastExitMs: 0,
          skipDiskGuard: true,
        })
      ).rejects.toThrow(REVIEW_IN_FLIGHT);
      // Refused BEFORE any Run row / output dir / dsh process.
      expect(spawner.procs).toEqual([]);
      expect((db.query(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n).toBe(before.n);

      // A writer for a DIFFERENT Task aimed at the same checkout is also refused
      // by the worktree/branch half of the fence.
      const other = newTask();
      await expect(
        startDshRun(db, {
          taskId: other,
          cwd: worktree,
          outputRoot: outputRoot(),
          spawner,
          fastExitMs: 0,
          skipDiskGuard: true,
        })
      ).rejects.toThrow(REVIEW_IN_FLIGHT);
    } finally {
      releaseReviewFence(db, fence.token);
    }

    // A second review of the same Task is refused while the first is in flight.
    const first = beginReviewFence(db, { taskId: id, worktree, branch, headSha: head, timeoutMs: 60_000 });
    expect(() =>
      beginReviewFence(db, { taskId: id, worktree, branch, headSha: head, timeoutMs: 60_000 })
    ).toThrow(REVIEW_IN_FLIGHT);
    releaseReviewFence(db, first.token);
  });
});

describe("ISH-1226: the reviewer holds the fence for the reviewer process only", () => {
  test("runHeadlessReview takes the fence before spawning and releases it after", async () => {
    const check = { name: "noop", command: "true" };
    const id = newTask([check]);
    const launchSpawner = new FakeSpawner();
    const launched = await launchTaskRun(db, id, {
      repo,
      worktreesRoot: worktreesRoot(),
      outputRoot: outputRoot(),
      spawner: launchSpawner,
      fastExitMs: 0,
    });
    launchSpawner.procs[0].finish(0);
    await launched.handle.wait();

    const worktree = getTask(db, id)!.worktree!;
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

    const review = reviewerSpawner(head, async () => {
      const fence = findLiveReviewFenceRow(db, { taskId: id });
      expect(fence).not.toBeNull();
      expect(fence!.worktree).toBe(worktree);
      expect(fence!.head_sha).toBe(head);
      // The real in-flight review must refuse a same-Task writer via the fence
      // (the early fence check runs before the phase gate, so this is the
      // REVIEW_IN_FLIGHT refusal rather than a generic phase refusal).
      const blocked = new FakeSpawner();
      await expect(
        startDshRun(db, {
          taskId: id,
          cwd: worktree,
          outputRoot: outputRoot(),
          spawner: blocked,
          fastExitMs: 0,
          skipDiskGuard: true,
        })
      ).rejects.toThrow(REVIEW_IN_FLIGHT);
      expect(blocked.procs).toEqual([]);
    });
    const result = await runHeadlessReview(db, id, { spawner: review.spawner });
    expect(result.outcome).toBe("pass");
    expect(review.calls).toBe(1);
    // Released when the reviewer process returns.
    expect(findLiveReviewFenceRow(db, { taskId: id })).toBeNull();
    expect((db.query(`SELECT COUNT(*) AS n FROM review_fences`).get() as { n: number }).n).toBe(0);
  });
});
