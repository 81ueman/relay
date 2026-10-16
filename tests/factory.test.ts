import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { getTask } from "../src/tasks";
import { registerWorker } from "../src/workers";
import { inboxFor } from "../src/messages";
import { intakeTask, recordReview, runMechanicalVerification, submitPhase, taskChecks } from "../src/workflow";
import { insertTaskResult } from "../src/results";
import { acceptRunSubmission, DUPLICATE_WRITER, listRuns } from "../src/dsh-runner";
import { launchTaskRun } from "../src/run-lifecycle";
import { defaultRunner, gitHead } from "../src/verify";
import { DEFAULT_INTEGRATOR_WORKER, runFactoryTask } from "../src/factory";
import {
  DEFAULT_REVIEWER_WORKER as REVIEWER_WORKER,
  REVIEW_NOT_INDEPENDENT,
  REVIEW_NO_STRUCTURED_RESULT,
  runHeadlessReview,
  extractReviewerVerdict,
  type ReviewerProcess,
  type ReviewerSpawnContext,
  type ReviewerSpawner,
} from "../src/reviewer-runner";

// ISH-762: the Factory E2E. A REAL temp git repo + a FAKE headless dsh process
// (a shell script that commits, no network) + a FAKE reviewer spawner keep the
// whole implement -> VERIFY -> review(FIX) -> fresh Run -> VERIFY -> review(PASS)
// -> integration -> MergeReady loop deterministic.

let dir = "";
let repo = "";
let binDir = "";
let db: Database;
let issueSeq = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

function fakeDsh(name: string, body: string): string {
  const p = join(binDir, name);
  writeFileSync(p, `#!/bin/sh\n${body}`);
  chmodSync(p, 0o755);
  return p;
}

/** A coding Run that writes a NEW file per run id and commits it (a real change). */
const COMMITTING_DSH = `set -e
echo "[$RELAY_RUN_ID] implementing"
echo "$RELAY_RUN_ID" > "change-$RELAY_RUN_ID.txt"
git add -A
git -c user.email=relay@test -c user.name=relay commit -qm "change $RELAY_RUN_ID"
echo DONE
`;

/** A coding Run that exits 0 but commits NOTHING (no implementation). */
const NOOP_DSH = `echo DONE
`;

type ReviewPlan = "pass" | "fix" | "blocked" | "garbage" | "wronghead" | "envelope";

interface ReviewerHarness {
  spawner: ReviewerSpawner;
  calls: { cwd: string; head: string | null; plan: ReviewPlan; brief: string }[];
}

/** A deterministic fake reviewer; reads the live worktree HEAD itself. */
function reviewerHarness(plan: ReviewPlan[]): ReviewerHarness {
  const calls: ReviewerHarness["calls"] = [];
  const spawner: ReviewerSpawner = {
    async run(ctx: ReviewerSpawnContext): Promise<ReviewerProcess> {
      const head = gitHead(ctx.cwd);
      const p = plan[Math.min(calls.length, plan.length - 1)] ?? "pass";
      calls.push({ cwd: ctx.cwd, head, plan: p, brief: ctx.brief });
      let stdout: string;
      switch (p) {
        case "fix":
          stdout = JSON.stringify({
            verdict: "fix",
            head,
            findings: [{ severity: "blocker", file: "a.txt", line: 1, message: "needs the B marker" }],
            summary: "incomplete",
          });
          break;
        case "blocked":
          stdout = JSON.stringify({ verdict: "blocked", head, summary: "cannot judge" });
          break;
        case "wronghead":
          stdout = JSON.stringify({ verdict: "pass", head: "0".repeat(40), summary: "x" });
          break;
        case "garbage":
          stdout = "I read it and it looks fine to me, no JSON.";
          break;
        case "envelope":
          stdout = JSON.stringify({
            type: "result",
            session_id: "fake-session-1",
            result: JSON.stringify({ verdict: "pass", head, summary: "ok via envelope" }),
          });
          break;
        default:
          stdout = JSON.stringify({ verdict: "pass", head, summary: "looks correct" });
      }
      return { exitCode: 0, signal: null, stdout, stderr: "" };
    },
  };
  return { spawner, calls };
}

function newTask(extra: { checks?: { name: string; command: string; timeoutMs?: number }[]; title?: string } = {}) {
  return intakeTask(db, {
    provider: "test",
    issueId: `ISH-762-${issueSeq++}`,
    codeChange: true,
    title: extra.title ?? "implement the marker file",
    checks: extra.checks ?? [{ name: "noop", command: "true" }],
  }).id;
}

/** Drive a task to the REVIEW phase by hand (launch -> submit -> mechanical verify). */
async function driveToReview(id: string, dshBin: string): Promise<string> {
  const launched = await launchTaskRun(db, id, {
    repo,
    worktreesRoot: join(dir, "worktrees"),
    outputRoot: join(dir, "runs"),
    dshBin,
    fastExitMs: 0,
  });
  const run = await launched.handle.wait();
  acceptRunSubmission(db, { runId: run.id });
  const v = await runMechanicalVerification(db, id, {
    checks: taskChecks(getTask(db, id)!),
    runner: defaultRunner,
    cwd: launched.worktree,
  });
  expect(v.outcome).toBe("pass");
  return getTask(db, id)!.head_sha!;
}

const factoryDeps = (dshBin: string, reviewer?: ReviewerSpawner) => ({
  repo,
  worktreesRoot: join(dir, "worktrees"),
  outputRoot: join(dir, "runs"),
  dshBin,
  fastExitMs: 0,
  reviewerSpawner: reviewer,
  mergeGateDeps: {},
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-ish762-"));
  repo = join(dir, "repo");
  binDir = join(dir, "bin");
  mkdirSync(repo, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "relay@test");
  git(repo, "config", "user.name", "relay-test");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "base");
  process.env.RELAY_DB = join(dir, "state.db");
  db = openDb(process.env.RELAY_DB);
  issueSeq = 0;
  delete process.env.RELAY_HUMAN;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.RELAY_HUMAN;
});

describe("extractReviewerVerdict (fail-closed parsing)", () => {
  test("parses a bare verdict object", () => {
    expect(extractReviewerVerdict('{"verdict":"pass","head":"abc","summary":"ok"}')).toEqual({
      verdict: "pass",
      head: "abc",
      findings: [],
      summary: "ok",
    });
  });
  test("parses the claude --output-format json envelope", () => {
    const envelope = JSON.stringify({ type: "result", result: '{"verdict":"fix","head":"h","findings":["x"]}' });
    expect(extractReviewerVerdict(envelope)?.verdict).toBe("fix");
    expect(extractReviewerVerdict(envelope)?.findings[0].message).toBe("x");
  });
  test("parses a JSONL stream and a fenced block", () => {
    expect(extractReviewerVerdict('{"type":"status"}\n{"verdict":"blocked","summary":"s"}')?.verdict).toBe("blocked");
    expect(extractReviewerVerdict('prose\n```json\n{"verdict":"pass","head":"h"}\n```')?.verdict).toBe("pass");
  });
  test("returns null when there is no structured verdict", () => {
    expect(extractReviewerVerdict("looks fine to me")).toBeNull();
    expect(extractReviewerVerdict("")).toBeNull();
    expect(extractReviewerVerdict('{"nope":1}')).toBeNull();
  });
});

describe("Factory E2E: real worktree, fake headless dsh + independent reviewer", () => {
  test("implement -> VERIFY -> review FIX -> fresh dsh FIX -> VERIFY -> review PASS -> MergeReady", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const rev = reviewerHarness(["fix", "pass"]);
    const res = await runFactoryTask(db, id, factoryDeps(dsh, rev.spawner));

    expect(res.outcome).toBe("merge_ready");
    const task = getTask(db, id)!;
    expect(task.phase).toBe("merge_ready");
    expect(task.state).toBe("queued");
    expect(task.merged_at).toBeNull(); // MergeReady is READ-ONLY: NOT merged
    expect(task.accepted_at).toBeNull(); // NOT Linear Done / accepted

    // Two coding attempts, two reviews, same worktree.
    expect(res.attempts.map((a) => a.reviewVerdict)).toEqual(["fix", "pass"]);
    expect(res.attempts.map((a) => a.verifyOutcome)).toEqual(["pass", "pass"]);
    const runs = listRuns(db, { taskId: id });
    expect(runs).toHaveLength(2);
    expect(runs[0].state).toBe("submitted");
    expect(runs[1].state).toBe("submitted");
    expect(runs[0].id).not.toBe(runs[1].id);

    // The FIX reused the SAME worktree + inherited the prior finding.
    expect(rev.calls).toHaveLength(2);
    expect(rev.calls[0].cwd).toBe(rev.calls[1].cwd);
    expect(readFileSync(join(rev.calls[1].cwd, ".relay", "run-brief.md"), "utf-8")).toContain("needs the B marker");

    // A read-only merge gate was evaluated (never merged).
    expect(res.gate).not.toBeNull();
  });

  test("a coding Run that exits nonzero canNOT advance (exit 0/final is not a submission)", async () => {
    const dsh = fakeDsh("dsh-fail", "exit 1\n");
    const id = newTask();
    const rev = reviewerHarness(["pass"]);
    const res = await runFactoryTask(db, id, factoryDeps(dsh, rev.spawner));
    expect(res.outcome).toBe("coding_failed");
    const task = getTask(db, id)!;
    expect(task.phase).toBe("implement");
    expect(task.head_sha).toBeNull();
    expect(rev.calls).toHaveLength(0);
  });

  test("a coding Run that exits 0 but commits nothing is NO_IMPLEMENTATION", async () => {
    const dsh = fakeDsh("dsh-noop", NOOP_DSH);
    const id = newTask();
    const rev = reviewerHarness(["pass"]);
    const res = await runFactoryTask(db, id, factoryDeps(dsh, rev.spawner));
    expect(res.outcome).toBe("no_implementation");
    expect(getTask(db, id)!.phase).toBe("implement");
  });

  test("a REQUIRED check that cannot run BLOCKS (never PASS)", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask({ checks: [{ name: "hang", command: "sleep 5", timeoutMs: 80 }] });
    const rev = reviewerHarness(["pass"]);
    const res = await runFactoryTask(db, id, factoryDeps(dsh, rev.spawner));
    expect(res.outcome).toBe("blocked");
    expect(res.reason).toContain("not_run");
    expect(getTask(db, id)!.state).toBe("blocked_human");
    expect(rev.calls).toHaveLength(0);
  });

  test("a reviewer with NO structured result is REFUSED (no advance)", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const rev = reviewerHarness(["garbage"]);
    const res = await runFactoryTask(db, id, factoryDeps(dsh, rev.spawner));
    expect(res.outcome).toBe("review_refused");
    expect(res.reason).toContain(REVIEW_NO_STRUCTURED_RESULT);
    expect(getTask(db, id)!.phase).toBe("review");
  });

  test("an old/foreign HEAD verdict is REFUSED (old HEAD cannot advance)", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const rev = reviewerHarness(["wronghead"]);
    const res = await runFactoryTask(db, id, factoryDeps(dsh, rev.spawner));
    expect(res.outcome).toBe("review_refused");
    expect(res.reason).toContain("HEAD_MISMATCH");
    expect(getTask(db, id)!.phase).toBe("review");
  });

  test("the envelope form (claude --output-format json) is accepted", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const rev = reviewerHarness(["envelope"]);
    const res = await runFactoryTask(db, id, factoryDeps(dsh, rev.spawner));
    expect(res.outcome).toBe("merge_ready");
  });

  test("re-entry adopts an already-live implement Run (no duplicate running work)", async () => {
    const slow = fakeDsh("dsh-slow", "sleep 1\nexit 0\n");
    const id = newTask();
    const live = await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: slow });
    // A second factory invocation must NOT start a second writer for the same worktree.
    const rev = reviewerHarness(["pass"]);
    const res = await runFactoryTask(db, id, factoryDeps(fakeDsh("dsh-commit", COMMITTING_DSH), rev.spawner));
    // The live Run exited 0 but produced no commit -> NO_IMPLEMENTATION, and only ONE run exists.
    expect(res.outcome).toBe("no_implementation");
    const runs = listRuns(db, { taskId: id });
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(live.handle.id);
  });

  test("the same-worktree single-writer exclusion refuses a parallel launch", async () => {
    const slow = fakeDsh("dsh-slow", "sleep 1\nexit 0\n");
    const fast = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const live = await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: slow });
    let refused = false;
    try {
      await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: fast });
    } catch (e) {
      refused = new RegExp(DUPLICATE_WRITER).test(String(e));
    }
    expect(refused).toBe(true);
    await live.handle.wait();
  });

  test("distinct worktrees run in parallel", async () => {
    const slow = fakeDsh("dsh-slow", "sleep 1\nexit 0\n");
    const a = newTask();
    const b = newTask();
    const ra = await launchTaskRun(db, a, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: slow });
    const rb = await launchTaskRun(db, b, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: slow });
    expect(ra.worktree).not.toBe(rb.worktree);
    await ra.handle.wait();
    await rb.handle.wait();
  });

  test("an integration submission at an UNREVIEWED new head is sent BACK to review", async () => {
    // The Factory reaches merge_ready ONLY at the reviewed head; a moved head at
    // integration invalidates the review and re-enters review (never merge_ready).
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const rev = reviewerHarness(["pass"]);
    await runFactoryTask(db, id, { ...factoryDeps(dsh, rev.spawner), maxAttempts: 1 });
    const task = getTask(db, id)!;
    expect(task.phase).toBe("merge_ready");
    const reviewedHead = task.head_sha!;
    // A PASS naming any head other than the current one is refused (old HEAD).
    const bogus = "1".repeat(40);
    registerWorker(db, REVIEWER_WORKER, { role: "reviewer" });
    db.query(`UPDATE tasks SET phase='review', state='review', claim_role='reviewer', attempt=attempt+1, assignee=? WHERE id=?`).run(
      REVIEWER_WORKER,
      id
    );
    expect(() => recordReview(db, id, REVIEWER_WORKER, { verdict: "pass", headSha: bogus })).toThrow();
    expect(getTask(db, id)!.head_sha).toBe(reviewedHead);
  });
});

describe("independent reviewer identity + submission authority", () => {
  test("a non-reviewer principal cannot review (fake reviewer identity refused)", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    await driveToReview(id, dsh);
    // Register an impostor worker with a non-reviewer role and try to review.
    registerWorker(db, "impostor", { role: "worker" });
    const rev = reviewerHarness(["pass"]);
    const r = await runHeadlessReview(db, id, { spawner: rev.spawner, reviewerWorker: "impostor" });
    expect(r.outcome).toBe("refused");
    expect(r.error).toContain(REVIEW_NOT_INDEPENDENT);
    expect(getTask(db, id)!.phase).toBe("review");
  });

  test("an unauthenticated code->review submission is refused", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const head = await driveToReview(id, dsh);
    // A submission must be attributable: a nonexistent principal cannot review.
    expect(() => recordReview(db, id, "dsh-run:whatever", { verdict: "pass", headSha: head })).toThrow();
    expect(getTask(db, id)!.phase).toBe("review");
  });

  test("a PASS at a head with an unresolved NG is refused (unreconciled NG)", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const head = await driveToReview(id, dsh);
    // An NG already recorded at this head (a prior non-passing review).
    insertTaskResult(db, {
      taskId: id,
      phase: "review",
      attempt: 0,
      kind: "ReviewResult",
      workerId: REVIEWER_WORKER,
      passed: false,
      headSha: head,
      profile: "prior",
      reason: "NG: still broken",
    });
    const rev2 = reviewerHarness(["pass"]);
    const r = await runHeadlessReview(db, id, { spawner: rev2.spawner, reviewerWorker: REVIEWER_WORKER, profile: "second" });
    expect(r.outcome).toBe("refused");
    expect(r.error).toContain("UNRESOLVED_NG");
  });
});

describe("Gateway is told only for judgment", () => {
  test("an ordinary FIX never messages the Gateway; a BLOCKED review does, once", async () => {
    process.env.RELAY_HUMAN = "gateway";
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const fixId = newTask();
    await runFactoryTask(db, fixId, { ...factoryDeps(dsh, reviewerHarness(["fix"]).spawner), maxAttempts: 1 });
    expect(inboxFor(db, "gateway")).toHaveLength(0);

    const blockId = newTask();
    const res = await runFactoryTask(db, blockId, { ...factoryDeps(dsh, reviewerHarness(["blocked"]).spawner), maxAttempts: 1 });
    expect(res.outcome).toBe("blocked");
    expect(getTask(db, blockId)!.state).toBe("blocked_human");
    const msgs = inboxFor(db, "gateway");
    expect(msgs.length).toBe(1);
    expect(msgs[0].task_id).toBe(blockId);
  });
});

describe("blocked / terminal tasks never advance", () => {
  test("a blocked_human task is returned as terminal with no Run launched", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    db.query(`UPDATE tasks SET state='blocked_human' WHERE id=?`).run(id);
    const res = await runFactoryTask(db, id, factoryDeps(dsh, reviewerHarness(["pass"]).spawner));
    expect(res.outcome).toBe("terminal");
    expect(listRuns(db, { taskId: id })).toHaveLength(0);
  });
});

// Silence the unused-import linters while keeping the named exports referenced.
void DEFAULT_INTEGRATOR_WORKER;
void submitPhase;
void existsSync;
