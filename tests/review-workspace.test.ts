import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { getTask, claimTask } from "../src/tasks";
import { registerWorker } from "../src/workers";
import { intakeTask, recordVerification, submitPhase } from "../src/workflow";
import { gitHead } from "../src/verify";
import {
  prepareReadOnlyReviewWorktree,
  removeReviewWorktree,
  reviewWorktreeAtHead,
} from "../src/review-workspace";
import {
  runHeadlessReview,
  type ReviewerProcess,
  type ReviewerSpawnContext,
  type ReviewerSpawner,
} from "../src/reviewer-runner";

// ISH-829: the independent reviewer reads a DETACHED read-only worktree at the
// fixed HEAD, not the writer's live checkout. A REAL temp repo exercises the
// `git worktree` materialisation; a fake reviewer spawner reads the cwd HEAD.

let dir = "";
let repo = "";
let db: Database;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-ish829-review-"));
  repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "relay@test");
  git(repo, "config", "user.name", "relay-test");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "base");
  process.env.RELAY_DB = join(dir, "state.db");
  db = openDb(process.env.RELAY_DB);
  registerWorker(db, "impl", { role: "worker" });
  registerWorker(db, "ver", { role: "worker" });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A reviewer that reads its cwd HEAD and returns a well-formed verdict. */
function harness(): { spawner: ReviewerSpawner; calls: ReviewerSpawnContext[] } {
  const calls: ReviewerSpawnContext[] = [];
  const spawner: ReviewerSpawner = {
    async run(ctx): Promise<ReviewerProcess> {
      calls.push(ctx);
      const head = gitHead(ctx.cwd);
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

describe("prepareReadOnlyReviewWorktree", () => {
  test("materialises a detached checkout at the fixed HEAD", () => {
    const head = git(repo, "rev-parse", "HEAD");
    const ro = join(dir, "review-ro");
    const ws = prepareReadOnlyReviewWorktree(repo, head, ro);
    expect(ws.ok).toBe(true);
    expect(ws.path).toBe(ro);
    expect(gitHead(ro)).toBe(head);
    expect(reviewWorktreeAtHead(ro, head)).toBe(true);
  });

  test("stays at the fixed HEAD even when the source repo advances", () => {
    const head = git(repo, "rev-parse", "HEAD");
    const ro = join(dir, "review-ro");
    prepareReadOnlyReviewWorktree(repo, head, ro);
    writeFileSync(join(repo, "later.txt"), "later\n");
    git(repo, "add", "later.txt");
    git(repo, "commit", "-q", "-m", "moved on");
    expect(git(repo, "rev-parse", "HEAD")).not.toBe(head);
    expect(gitHead(ro)).toBe(head);
  });

  test("a bad or absent head fails closed", () => {
    expect(prepareReadOnlyReviewWorktree(repo, "nope", join(dir, "a")).ok).toBe(false);
    expect(prepareReadOnlyReviewWorktree(repo, null, join(dir, "b")).ok).toBe(false);
    expect(prepareReadOnlyReviewWorktree(repo, "f".repeat(40), join(dir, "c")).ok).toBe(false);
  });

  test("cleanup removes the worktree", () => {
    const head = git(repo, "rev-parse", "HEAD");
    const ro = join(dir, "review-ro");
    prepareReadOnlyReviewWorktree(repo, head, ro);
    removeReviewWorktree(repo, ro);
    expect(gitHead(ro)).toBeNull();
  });
});

describe("runHeadlessReview on an independent read-only worktree", () => {
  test("records a PASS bound to the fixed HEAD without touching the writer's checkout", async () => {
    const head = git(repo, "rev-parse", "HEAD");
    const t = intakeTask(db, { provider: "test", issueId: "ISH-829-rev", codeChange: true, headSha: head });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl");
    claimTask(db, t.id, "ver");
    recordVerification(db, t.id, "ver", { passed: true }); // -> review@head
    expect(getTask(db, t.id)!.phase).toBe("review");

    const ro = join(dir, "review-ro");
    expect(prepareReadOnlyReviewWorktree(repo, head, ro).ok).toBe(true);
    const { spawner, calls } = harness();
    try {
      const r = await runHeadlessReview(db, t.id, { spawner, reviewWorktree: ro });
      expect(r.outcome).toBe("pass");
      expect(calls[0].cwd).toBe(ro);
      expect(getTask(db, t.id)!.head_sha).toBe(head);
    } finally {
      removeReviewWorktree(repo, ro);
    }
  });

  test("review evidence is written to a DURABLE base, outside the review worktree", async () => {
    const head = git(repo, "rev-parse", "HEAD");
    const t = intakeTask(db, { provider: "test", issueId: "ISH-829-rev2", codeChange: true, headSha: head });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl");
    claimTask(db, t.id, "ver");
    recordVerification(db, t.id, "ver", { passed: true });

    const ro = join(dir, "review-ro");
    expect(prepareReadOnlyReviewWorktree(repo, head, ro).ok).toBe(true);
    const { spawner } = harness();
    // The reviewer runs in the ephemeral `ro`, but evidence is pinned under the
    // durable writer repo — so removing `ro` cannot delete it.
    const r = await runHeadlessReview(db, t.id, { spawner, reviewWorktree: ro, evidenceDir: repo });
    expect(r.outcome).toBe("pass");
    expect(r.evidenceRef).toBeTruthy();
    expect(r.evidenceRef!.startsWith(repo)).toBe(true);
    removeReviewWorktree(repo, ro);
    expect(existsSync(r.evidenceRef!)).toBe(true); // still there after teardown
  });
});
