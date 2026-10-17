import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { blockTask, claimNext, claimTask, getTask } from "../src/tasks";
import { registerWorker } from "../src/workers";
import { inboxFor } from "../src/messages";
import { intakeTask, recordReview, runMechanicalVerification, submitPhase, taskChecks } from "../src/workflow";
import { insertTaskResult } from "../src/results";
import { acceptRunSubmission, DUPLICATE_WRITER, listRuns } from "../src/dsh-runner";
import { launchTaskRun } from "../src/run-lifecycle";
import { defaultRunner, gitHead, type CommandRunner } from "../src/verify";
import { upsertSandbox } from "../src/sandbox";
import { sandboxVerifyTarget, type SandboxExec } from "../src/sandbox-verify";
import { processPgid, spawnIdentityToken } from "../src/proc-identity";
import { DEFAULT_INTEGRATOR_WORKER, pidAlive, runFactoryTask } from "../src/factory";
import {
  DEFAULT_REVIEWER_WORKER as REVIEWER_WORKER,
  REVIEW_NOT_INDEPENDENT,
  REVIEW_NO_STRUCTURED_RESULT,
  REVIEW_PROCESS_FAILED,
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

type ReviewPlan =
  | "pass"
  | "fix"
  | "blocked"
  | "garbage"
  | "wronghead"
  | "envelope"
  | "exitfail"
  | "signal"
  | "mutatehead";

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
        case "exitfail":
          // A WELL-FORMED pass on stdout, but the reviewer process failed.
          stdout = JSON.stringify({ verdict: "pass", head, summary: "looks fine" });
          break;
        case "signal":
          stdout = JSON.stringify({ verdict: "pass", head, summary: "looks fine" });
          break;
        case "mutatehead": {
          // Commit to the worktree WHILE the reviewer runs, then name the OLD head.
          writeFileSync(join(ctx.cwd, "mutated-by-reviewer.txt"), "mutated\n");
          git(ctx.cwd, "add", "mutated-by-reviewer.txt");
          git(ctx.cwd, "commit", "-q", "-m", "reviewer moved the head");
          stdout = JSON.stringify({ verdict: "pass", head, summary: "ok for the head it saw" });
          break;
        }
        default:
          stdout = JSON.stringify({ verdict: "pass", head, summary: "looks correct" });
      }
      if (p === "exitfail") return { exitCode: 1, signal: null, stdout, stderr: "reviewer crashed" };
      if (p === "signal") return { exitCode: null, signal: "SIGKILL", stdout, stderr: "" };
      return { exitCode: 0, signal: null, stdout, stderr: "" };
    },
  };
  return { spawner, calls };
}

function newTask(
  extra: { checks?: { name: string; command: string; required?: boolean; timeoutMs?: number }[]; title?: string } = {}
) {
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

  test("ISH-829: a sandbox-backed Task verifies IN the sandbox, never the host runner", async () => {
    const dsh = fakeDsh("dsh-sbx", COMMITTING_DSH);
    const id = newTask();
    const rev = reviewerHarness(["pass"]);
    let hostCalls = 0;
    const hostSpy: CommandRunner = {
      async run(s) {
        hostCalls++;
        return { name: s.name, required: true, outcome: "pass", exitCode: 0, output: "host", durationMs: 0 };
      },
    };
    // A sandbox row is what selects the sandbox target (never the host runner).
    const task0 = getTask(db, id)!;
    upsertSandbox(db, {
      taskId: id,
      name: "relay-ish829-factory",
      agent: "shell",
      source: repo,
      workspace: task0.worktree,
      branch: task0.branch,
      headSha: null,
      state: "running",
    });
    // Fake `sbx exec`: HEAD is the LIVE produced head, the tree is clean, and
    // every check command exits 0.
    const exec: SandboxExec = {
      async exec(_name, argv) {
        const j = argv.join(" ");
        if (j.includes("rev-parse HEAD")) return { code: 0, stdout: `${getTask(db, id)!.head_sha}\n`, stderr: "", timedOut: false };
        if (j.includes("--porcelain")) return { code: 0, stdout: "", stderr: "", timedOut: false };
        return { code: 0, stdout: "sbx-ran", stderr: "", timedOut: false };
      },
    };
    const res = await runFactoryTask(db, id, {
      ...factoryDeps(dsh, rev.spawner),
      verifyRunner: hostSpy,
      verifyTarget: (d, t, checks) => sandboxVerifyTarget(d, t, checks, { exec, headProbe: () => getTask(db, id)!.head_sha }),
    });
    expect(res.outcome).toBe("merge_ready");
    expect(res.attempts[0].verifyOutcome).toBe("pass");
    expect(hostCalls).toBe(0); // the host runner was NEVER reached
  });

  test("ISH-829: the independent reviewer reads a detached read-only worktree at the fixed head", async () => {
    const dsh = fakeDsh("dsh-ro", COMMITTING_DSH);
    const id = newTask();
    const rev = reviewerHarness(["pass"]);
    const roRoot = join(dir, "review-wt");
    const res = await runFactoryTask(db, id, { ...factoryDeps(dsh, rev.spawner), reviewWorktreeRoot: roRoot });
    expect(res.outcome).toBe("merge_ready");
    expect(rev.calls).toHaveLength(1);
    const cwd = rev.calls[0].cwd;
    // The reviewer read a DETACHED worktree under the review root, not the writer's.
    expect(cwd.startsWith(roRoot)).toBe(true);
    const task = getTask(db, id)!;
    expect(rev.calls[0].head).toBe(task.head_sha);
    // The read-only worktree is torn down after the review.
    expect(existsSync(cwd)).toBe(false);
    // ISH-829 finding 5: the recorded evidence_ref is DURABLE — it does NOT live
    // in the removed review worktree, so it still exists.
    const row = db
      .query(`SELECT evidence_ref FROM task_results WHERE task_id = ? AND kind = 'ReviewResult' ORDER BY id DESC LIMIT 1`)
      .get(id) as { evidence_ref: string | null } | null;
    expect(row?.evidence_ref).toBeTruthy();
    expect(existsSync(row!.evidence_ref!)).toBe(true);
    expect(row!.evidence_ref!.startsWith(cwd)).toBe(false);
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

  // Regression (PR #10 finding 1): `blockTask(..., human=false)` sets
  // `blocked_internal` while LEAVING `phase` unchanged, so a guard that lists
  // only `blocked_human` carried the task to MergeReady and erased the block.
  test("a blocked_internal task is terminal (the durable block is never erased)", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    registerWorker(db, "impl-worker", { role: "worker" });
    const id = newTask();
    blockTask(db, id, "impl-worker", "needs a human decision", false);
    expect(getTask(db, id)!.state).toBe("blocked_internal");
    const phaseBefore = getTask(db, id)!.phase;
    const res = await runFactoryTask(db, id, factoryDeps(dsh, reviewerHarness(["pass"]).spawner));
    expect(res.outcome).toBe("terminal");
    expect(res.reason).toBe("state blocked_internal");
    expect(getTask(db, id)!.state).toBe("blocked_internal");
    expect(getTask(db, id)!.phase).toBe(phaseBefore);
    expect(listRuns(db, { taskId: id })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PR #10 round-1 findings — regression tests (each reproduced the bug on the
// pre-fix HEAD; none of these was caught by the existing suite).
// ---------------------------------------------------------------------------

describe("PR #10 finding 2: a failed reviewer process is never a verdict", () => {
  test("a non-zero reviewer exit with a well-formed pass on stdout is REFUSED", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const res = await runFactoryTask(db, id, factoryDeps(dsh, reviewerHarness(["exitfail"]).spawner));
    expect(res.outcome).toBe("review_refused");
    expect(res.reason).toContain(REVIEW_PROCESS_FAILED);
    expect(getTask(db, id)!.phase).toBe("review");
  });

  test("a signalled reviewer with a valid pass on stdout is REFUSED", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const res = await runFactoryTask(db, id, factoryDeps(dsh, reviewerHarness(["signal"]).spawner));
    expect(res.outcome).toBe("review_refused");
    expect(res.reason).toContain(REVIEW_PROCESS_FAILED);
    expect(getTask(db, id)!.phase).toBe("review");
  });
});

describe("PR #10 finding 3: a worktree HEAD that moved during review is REFUSED", () => {
  test("a reviewer that commits to the worktree while running cannot advance", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const headBefore = await driveToReview(id, dsh);
    const rev = reviewerHarness(["mutatehead"]);
    const res = await runFactoryTask(db, id, { ...factoryDeps(dsh, rev.spawner), maxAttempts: 1 });
    expect(res.outcome).toBe("review_refused");
    expect(res.reason).toContain("HEAD_MISMATCH");
    // The task is NOT advanced, and its recorded head still names the reviewed rev.
    const task = getTask(db, id)!;
    expect(task.phase).toBe("review");
    expect(task.head_sha).toBe(headBefore);
  });
});

describe("PR #10 finding 4: an orphaned running Run never hangs the factory", () => {
  test("a dead-pid orphan is marked failed and the factory fails closed", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const launched = await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: dsh, fastExitMs: 0 });
    await launched.handle.wait();
    // Simulate the owner process dying: the row stays `running` with a dead pid.
    const dead = Bun.spawnSync(["true"]);
    const deadPid = dead.pid ?? 999999;
    db.query(`UPDATE runs SET state='running', pid=?, exit_code=NULL, ended_at=NULL WHERE id=?`).run(deadPid, launched.handle.id);
    const res = await runFactoryTask(db, id, { ...factoryDeps(dsh, reviewerHarness(["pass"]).spawner), timeoutMs: 2000 });
    expect(res.outcome).toBe("coding_failed");
    expect(res.reason).toContain("orphaned");
    const runs = listRuns(db, { taskId: id });
    expect(runs).toHaveLength(1);
    expect(runs[0].state).toBe("failed");
    expect(getTask(db, id)!.phase).toBe("implement");
  });

  test("an EXPIRED but still-live orphan is KILLED before the fence is released", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const launched = await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: dsh, fastExitMs: 0 });
    await launched.handle.wait();
    // A REAL detached child in its own process group — the orphan a crashed factory
    // leaves behind. Store its OWN start token so the identity check proves it is
    // this Run's process (a genuine orphan), not a reused PID.
    const child = Bun.spawn(["sleep", "30"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const childPid = child.pid;
    db.query(
      `UPDATE runs SET state='running', pid=?, spawn_lstart=?, exit_code=NULL, ended_at=NULL WHERE id=?`
    ).run(childPid, spawnIdentityToken(childPid), launched.handle.id);

    const res = await runFactoryTask(db, id, { ...factoryDeps(dsh, reviewerHarness(["pass"]).spawner), timeoutMs: 300 });
    expect(res.outcome).toBe("coding_failed");
    expect(res.reason).toContain("expired");
    // KILL BEFORE RELEASE: proven ours and now dead, so the Run is terminal `failed`.
    expect(pidAlive(childPid)).toBe(false);
    expect(listRuns(db, { taskId: id })[0].state).toBe("failed");
    // With the writer truly gone, the worktree is free again — a following launch
    // is admitted (no stale DUPLICATE_WRITER, no second live writer).
    const next = await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: dsh, fastExitMs: 0 });
    expect(next.handle.id).not.toBe(launched.handle.id);
    await next.handle.wait();
  });

  test("an orphan that CANNOT be killed leaves the Run running (DUPLICATE_WRITER keeps fencing)", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const launched = await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: dsh, fastExitMs: 0 });
    await launched.handle.wait();
    // A genuine detached orphan (identity MATCHES), but the terminate seam fails.
    const child = Bun.spawn(["sleep", "30"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const childPid = child.pid;
    db.query(
      `UPDATE runs SET state='running', pid=?, spawn_lstart=?, exit_code=NULL, ended_at=NULL WHERE id=?`
    ).run(childPid, spawnIdentityToken(childPid), launched.handle.id);
    const res = await runFactoryTask(db, id, {
      ...factoryDeps(dsh, reviewerHarness(["pass"]).spawner),
      timeoutMs: 300,
      terminateOrphan: async () => false,
    });
    expect(res.outcome).toBe("coding_failed");
    expect(res.reason).toContain("could not be terminated");
    // The seam never signalled: the orphan is still alive.
    expect(pidAlive(childPid)).toBe(true);
    // The Run stays `running`, so the single-writer fence is intact.
    expect(listRuns(db, { taskId: id })[0].state).toBe("running");
    let refused = false;
    try {
      await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: dsh });
    } catch (e) {
      refused = new RegExp(DUPLICATE_WRITER).test(String(e));
    }
    expect(refused).toBe(true);
    try { child.kill("SIGKILL"); } catch { /* done */ }
  });

  // Round-3 finding: the orphan-kill path must NEVER signal a PID that is not
  // provably the Run's dsh. A reused PID (an unrelated host process) must survive.
  test("a reused PID (unrelated NON-leader process) is NEVER signalled", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const launched = await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: dsh, fastExitMs: 0 });
    await launched.handle.wait();
    // A NON-detached child: it shares this process's group, so it is NOT a group
    // leader — exactly the shape the old kill(pid) fallback would have hit.
    const victim = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const victimPid = victim.pid;
    expect(processPgid(victimPid)).not.toBe(victimPid); // not a leader
    db.query(
      `UPDATE runs SET state='running', pid=?, spawn_lstart='lstart-v1:not-the-real-token', exit_code=NULL, ended_at=NULL WHERE id=?`
    ).run(victimPid, launched.handle.id);

    const res = await runFactoryTask(db, id, { ...factoryDeps(dsh, reviewerHarness(["pass"]).spawner), timeoutMs: 300 });
    expect(res.outcome).toBe("coding_failed");
    expect(res.reason).toContain("reused");
    // The unrelated process is UNTOUCHED and still alive.
    expect(pidAlive(victimPid)).toBe(true);
    // The original dsh is gone, so the Row is terminal `failed` (no signal was sent).
    expect(listRuns(db, { taskId: id })[0].state).toBe("failed");
    try { victim.kill("SIGKILL"); } catch { /* done */ }
  });

  test("a group leader with a DIFFERENT spawn start time (reused PID) is NEVER signalled", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const launched = await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: dsh, fastExitMs: 0 });
    await launched.handle.wait();
    // A detached (group-leader) process, but the stored token is a DIFFERENT start
    // time: the PID was reused. Identity mismatches on the token -> no signal.
    const victim = Bun.spawn(["sleep", "30"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const victimPid = victim.pid;
    expect(processPgid(victimPid)).toBe(victimPid); // is a leader
    db.query(
      `UPDATE runs SET state='running', pid=?, spawn_lstart='lstart-v1:Tue Jan  1 00:00:00 1980', exit_code=NULL, ended_at=NULL WHERE id=?`
    ).run(victimPid, launched.handle.id);

    const res = await runFactoryTask(db, id, { ...factoryDeps(dsh, reviewerHarness(["pass"]).spawner), timeoutMs: 300 });
    expect(res.outcome).toBe("coding_failed");
    expect(res.reason).toContain("reused");
    expect(pidAlive(victimPid)).toBe(true);
    expect(listRuns(db, { taskId: id })[0].state).toBe("failed");
    try { victim.kill("SIGKILL"); } catch { /* done */ }
  });
});

describe("PR #10 finding 5: an all-optional check list is not a gate", () => {
  test("a task with only OPTIONAL checks is no_checks (an unrun check can never PASS)", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask({ checks: [{ name: "slow", command: "sleep 5", required: false, timeoutMs: 80 }] });
    const res = await runFactoryTask(db, id, factoryDeps(dsh, reviewerHarness(["pass"]).spawner));
    expect(res.outcome).toBe("no_checks");
    expect(getTask(db, id)!.phase).toBe("verify");
  });

  test("a task with at least one REQUIRED check still runs", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask({
      checks: [
        { name: "required-noop", command: "true", required: true },
        { name: "optional-noop", command: "true", required: false },
      ],
    });
    const res = await runFactoryTask(db, id, factoryDeps(dsh, reviewerHarness(["pass"]).spawner));
    expect(res.outcome).toBe("merge_ready");
  });
});

// ---------------------------------------------------------------------------
// PR #10 round-4 findings.
// ---------------------------------------------------------------------------

describe("PR #10 finding 1: the spawn token is canonical (env-independent)", () => {
  test("spawnIdentityToken is identical across caller LC_ALL/TZ", () => {
    const before = spawnIdentityToken(process.pid);
    const saved = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG, TZ: process.env.TZ };
    try {
      process.env.LC_ALL = "ja_JP.UTF-8";
      process.env.LANG = "ja_JP.UTF-8";
      process.env.TZ = "Asia/Tokyo";
      const after = spawnIdentityToken(process.pid);
      expect(after).toBe(before);
      expect(before?.startsWith("lstart-v1:")).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("a genuine orphan stored under one LC_ALL/TZ is still MATCHED after a restart under another", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const launched = await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: dsh, fastExitMs: 0 });
    await launched.handle.wait();
    const child = Bun.spawn(["sleep", "30"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const childPid = child.pid;
    db.query(
      `UPDATE runs SET state='running', pid=?, spawn_lstart=?, exit_code=NULL, ended_at=NULL WHERE id=?`
    ).run(childPid, spawnIdentityToken(childPid), launched.handle.id);

    // Adopt from a process with a DIFFERENT locale/timezone than the spawn.
    const saved = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG, TZ: process.env.TZ };
    let res: Awaited<ReturnType<typeof runFactoryTask>>;
    try {
      process.env.LC_ALL = "ja_JP.UTF-8";
      process.env.LANG = "ja_JP.UTF-8";
      process.env.TZ = "Asia/Tokyo";
      res = await runFactoryTask(db, id, { ...factoryDeps(dsh, reviewerHarness(["pass"]).spawner), timeoutMs: 300 });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(res.outcome).toBe("coding_failed");
    // Canonical token => identity MATCHED => the genuine orphan was killed, not
    // misread as "reused" (which would release the fence while it lived).
    expect(pidAlive(childPid)).toBe(false);
    expect(listRuns(db, { taskId: id })[0].state).toBe("failed");
  });

  test("a LEGACY non-canonical token is undeterminable: fence held, no signal", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const launched = await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: dsh, fastExitMs: 0 });
    await launched.handle.wait();
    const child = Bun.spawn(["sleep", "30"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const childPid = child.pid;
    // An OLD-format token (no version tag) cannot be compared across environments.
    db.query(
      `UPDATE runs SET state='running', pid=?, spawn_lstart='Sat Oct 17 01:24:35 2026', exit_code=NULL, ended_at=NULL WHERE id=?`
    ).run(childPid, launched.handle.id);

    const res = await runFactoryTask(db, id, { ...factoryDeps(dsh, reviewerHarness(["pass"]).spawner), timeoutMs: 300 });
    expect(res.outcome).toBe("coding_failed");
    expect(res.reason).toContain("could not be proven");
    // Never signalled; the Run is left running so the fence keeps holding.
    expect(pidAlive(childPid)).toBe(true);
    expect(listRuns(db, { taskId: id })[0].state).toBe("running");
    let refused = false;
    try {
      await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: dsh });
    } catch (e) {
      refused = new RegExp(DUPLICATE_WRITER).test(String(e));
    }
    expect(refused).toBe(true);
    try { child.kill("SIGKILL"); } catch { /* done */ }
  });
});

describe("PR #10 finding 2: the live Run is the only control-plane writer", () => {
  test("claimTask, claimNext and submitPhase refuse while a Run owns the phase/attempt", async () => {
    const slow = fakeDsh("dsh-slow", "sleep 2\nexit 0\n");
    const id = newTask();
    const live = await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: slow });
    registerWorker(db, "thief", { role: "worker" });
    expect(() => claimTask(db, id, "thief")).toThrow(/RUN_OWNED/);
    expect(() => submitPhase(db, id, "thief", { evidence: "x" })).toThrow(/RUN_OWNED/);
    // The generic claim machine must not offer the Run-owned task either.
    expect(claimNext(db, "thief")).toBeNull();
    await live.handle.wait();
  });

  test("a coding Run that runs `relay claim` + `relay submit` cannot advance the Task", async () => {
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const thiefDsh = `#!/bin/sh
set -e
echo "$RELAY_RUN_ID" > "change-$RELAY_RUN_ID.txt"
git add -A
git -c user.email=relay@test -c user.name=relay commit -qm "change $RELAY_RUN_ID"
bun "$RELAY_CLI" worker register w-dsh --role worker >> .relay/attempt.log 2>&1 || true
bun "$RELAY_CLI" claim "$RELAY_TASK_ID" --worker w-dsh >> .relay/attempt.log 2>&1 || true
bun "$RELAY_CLI" submit "$RELAY_TASK_ID" --worker w-dsh --evidence done >> .relay/attempt.log 2>&1 || true
echo DONE
`;
    const dsh = fakeDsh("dsh-thief", thiefDsh);
    const id = newTask();
    const res = await runFactoryTask(db, id, {
      ...factoryDeps(dsh, reviewerHarness(["pass"]).spawner),
      dshEnv: { RELAY_CLI: cli },
    });
    // The Run's own generic mutations were refused, so the factory's structured
    // acceptRunSubmission is the ONLY advance and the whole loop still completes.
    expect(res.outcome).toBe("merge_ready");
    const log = readFileSync(join(dir, "worktrees", id, ".relay", "attempt.log"), "utf-8");
    expect(log).toContain("RUN_OWNED");
  });
});

// Silence the unused-import linters while keeping the named exports referenced.
void DEFAULT_INTEGRATOR_WORKER;
void submitPhase;
void existsSync;
