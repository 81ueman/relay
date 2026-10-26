import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { listEvents } from "../src/events";
import { runHeadlessReview } from "../src/reviewer-runner";
import { gitHead } from "../src/verify";
import {
  addTask,
  blockTask,
  cancelTask,
  claimNext,
  claimTask,
  getNotes,
  getTask,
} from "../src/tasks";
import { registerWorker } from "../src/workers";
import {
  acceptTask,
  confirmMerged,
  findMergedResult,
  findTaskResult,
  intakeTask,
  quietBlock,
  recordImplementRecovery,
  recordReview,
  recordVerification,
  requestMergeReadyRebase,
  submitImplementationFromRun,
  submitPhase,
} from "../src/workflow";

// ISH-1246 (follow-up to ISH-1245): the terminal fence must leave EVIDENCE on
// EVERY late-result route, not only on the write that lands between an entry
// check and its guard.
//
//  1. A result refused by an ENTRY check (the close already committed before the
//     call) still records its Result row and `task.late_result_ignored`.
//  2. Every write-time guard is reached by a test that commits the close AFTER
//     the caller's entry check. The pre-ISH-1245 base has no such guard, so the
//     task is re-opened/advanced there and these assertions fail.
//
// The close is injected at the caller's first `db.transaction(...)` — exactly
// between its entry check and its write — with no production test hook.

let dir = "";
let db: Database;

const FULL = "a".repeat(40);
const MOVED = "b".repeat(40);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-ish1246-"));
  process.env.RELAY_DB = join(dir, "state.db");
  process.env.RELAY_LEASE_MS = "120000";
  db = openDb(process.env.RELAY_DB);
  registerWorker(db, "impl", { role: "worker" });
  registerWorker(db, "ver", { role: "worker" });
  registerWorker(db, "rev", { role: "reviewer" });
  registerWorker(db, "integ", { role: "integrator" });
});

afterEach(() => {
  restoreTransaction?.();
  restoreTransaction = null;
  db.close();
  delete process.env.RELAY_DB;
  delete process.env.RELAY_LEASE_MS;
  rmSync(dir, { recursive: true, force: true });
});

/** The parsed `task.late_result_ignored` events for one Task. */
function lateEvents(taskId: string): { id: number; payload: Record<string, unknown> }[] {
  return listEvents(db)
    .filter((e) => e.task_id === taskId && e.type === "task.late_result_ignored")
    .map((e) => ({ id: e.id, payload: JSON.parse(e.payload_json) as Record<string, unknown> }));
}

function eventTypes(taskId: string, type: string): number {
  return listEvents(db).filter((e) => e.task_id === taskId && e.type === type).length;
}

let restoreTransaction: (() => void) | null = null;

/**
 * Commit the close at the next `db.transaction(...)` call. Every guarded
 * transition below reads the Task for its entry checks BEFORE opening its
 * transaction, so the close is durable exactly at the write boundary the
 * ISH-1245 guard was added for — the guard sees it and the pre-guard base does
 * not.
 */
function cancelAtWriteBoundary(taskId: string, reason = "operator closed the Task at the write boundary"): void {
  const dbAny = db as unknown as Record<string, unknown>;
  const original = dbAny.transaction;
  const orig = db.transaction.bind(db);
  let armed = true;
  dbAny.transaction = (fn: () => unknown) => {
    if (armed) {
      armed = false;
      cancelTask(db, taskId, "operator", reason);
    }
    return orig(fn);
  };
  restoreTransaction = () => {
    dbAny.transaction = original;
  };
}

/** implement -> verify (manual; no mechanical checks) -> running verify claim. */
function toManualVerify(issueId: string): string {
  const t = intakeTask(db, { provider: "test", issueId, codeChange: true, headSha: FULL });
  claimTask(db, t.id, "impl");
  submitPhase(db, t.id, "impl");
  claimTask(db, t.id, "ver");
  return t.id;
}

/** manual implement -> verify -> review, with the reviewer claim taken. */
function toReview(issueId: string): string {
  const id = toManualVerify(issueId);
  recordVerification(db, id, "ver", { passed: true, headSha: FULL });
  claimNext(db, "rev");
  expect(getTask(db, id)!.state).toBe("review");
  return id;
}

/** manual implement -> verify -> review -> integration, with the integrator claim taken. */
function toIntegration(issueId: string): string {
  const t = intakeTask(db, {
    provider: "test",
    issueId,
    codeChange: true,
    headSha: FULL,
    prUrl: "https://github.com/o/r/pull/1246",
    prRepo: "o/r",
  });
  claimTask(db, t.id, "impl");
  submitPhase(db, t.id, "impl");
  claimTask(db, t.id, "ver");
  recordVerification(db, t.id, "ver", { passed: true, headSha: FULL });
  claimNext(db, "rev");
  recordReview(db, t.id, "rev", { verdict: "pass", headSha: FULL });
  claimTask(db, t.id, "integ");
  expect(getTask(db, t.id)!.phase).toBe("integration");
  return t.id;
}

/** manual implement -> verify -> review -> integration -> merge_ready. */
function toMergeReady(issueId: string): string {
  const id = toIntegration(issueId);
  submitPhase(db, id, "integ", { headSha: FULL });
  expect(getTask(db, id)!.phase).toBe("merge_ready");
  return id;
}

/** Insert the durable failed IMPLEMENT Run row `recordImplementRecovery` judges. */
function insertImplementRun(taskId: string): void {
  const t = Date.now();
  db.query(
    `INSERT INTO runs
       (id, task_id, phase, attempt, generation, cwd, branch, head_sha, base_head_sha,
        output_dir, state, error, started_at, created_at, updated_at)
     VALUES (?, ?, 'implement', 0, 0, ?, NULL, NULL, NULL, ?, 'failed', 'exit 1', ?, ?, ?)`
  ).run("run-ish1246", taskId, join(dir, "worktree"), join(dir, "runs", "run-ish1246"), t, t, t);
}

// ---------------------------------------------------------------------------
// 1. A close that already committed is evidence on the entry-check refusal
// ---------------------------------------------------------------------------

describe("ISH-1246: an entry-check refusal keeps the late result as evidence", () => {
  test("submitPhase after a committed cancel stores TaskSubmitted evidence and leaves the Task cancelled", () => {
    const t = intakeTask(db, { provider: "test", issueId: "ish1246-entry-submit", codeChange: true, headSha: FULL });
    claimTask(db, t.id, "impl");
    cancelTask(db, t.id, "operator", "closed before the submit arrived");

    expect(() => submitPhase(db, t.id, "impl", { evidence: "late implement submit" })).toThrow(/terminal/);

    const after = getTask(db, t.id)!;
    expect(after.state).toBe("cancelled");
    expect(after.phase).toBe("implement");
    expect(after.attempt).toBe(0);
    const row = findTaskResult(db, t.id, "implement", 0, "TaskSubmitted");
    expect(row).not.toBeNull();
    expect(row!.evidence_ref).toBe("late implement submit");
    expect(row!.reason).toContain("late submit");
    const events = lateEvents(t.id);
    expect(events).toHaveLength(1);
    expect(events[0].payload.kind).toBe("TaskSubmitted");
    expect(events[0].payload.taskState).toBe("cancelled");
    expect(events[0].payload.resultId).toBe(row!.id);
  });

  test("recordVerification after a committed cancel stores VerificationResult evidence (pass and fail)", () => {
    const passId = toManualVerify("ish1246-entry-verify-pass");
    cancelTask(db, passId, "operator", "closed before the verification arrived");
    expect(() => recordVerification(db, passId, "ver", { passed: true, headSha: FULL, evidence: "late pass" })).toThrow(
      /terminal/
    );
    const passRow = findTaskResult(db, passId, "verify", 0, "VerificationResult");
    expect(passRow?.passed).toBe(1);
    expect(passRow?.evidence_ref).toBe("late pass");
    expect(lateEvents(passId)).toHaveLength(1);
    expect(lateEvents(passId)[0].payload.kind).toBe("VerificationResult");

    const failId = toManualVerify("ish1246-entry-verify-fail");
    cancelTask(db, failId, "operator", "closed before the verification arrived");
    expect(() => recordVerification(db, failId, "ver", { passed: false, headSha: FULL })).toThrow(/terminal/);
    const failRow = findTaskResult(db, failId, "verify", 0, "VerificationResult");
    expect(failRow?.passed).toBe(0);
    expect(getTask(db, failId)!.attempt).toBe(0); // no rework attempt was started
    expect(lateEvents(failId)).toHaveLength(1);
  });

  test("recordReview after a committed cancel stores ReviewResult evidence and never advances", () => {
    const id = toReview("ish1246-entry-review");
    cancelTask(db, id, "operator", "closed before the review arrived");

    expect(() => recordReview(db, id, "rev", { verdict: "pass", headSha: FULL, evidence: "late review" })).toThrow(
      /cannot record a review/
    );

    const after = getTask(db, id)!;
    expect(after.state).toBe("cancelled");
    expect(after.phase).toBe("review");
    const row = findTaskResult(db, id, "review", 0, "ReviewResult");
    expect(row?.passed).toBe(1);
    expect(row?.head_sha).toBe(FULL);
    expect(row?.evidence_ref).toBe("late review");
    const events = lateEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0].payload.kind).toBe("ReviewResult");
    expect(events[0].payload.taskState).toBe("cancelled");
  });

  test("acceptTask after a committed cancel stores TaskAccepted evidence and never becomes done", () => {
    const id = toMergeReady("ish1246-entry-accept");
    cancelTask(db, id, "operator", "closed before the acceptance arrived");

    expect(() => acceptTask(db, id, "integ")).toThrow(/terminal/);

    const after = getTask(db, id)!;
    expect(after.state).toBe("cancelled");
    expect(after.phase).toBe("merge_ready");
    expect(after.accepted_at).toBeNull();
    const row = findTaskResult(db, id, "merge_ready", 0, "TaskAccepted");
    expect(row).not.toBeNull();
    expect(lateEvents(id)).toHaveLength(1);
    expect(lateEvents(id)[0].payload.kind).toBe("TaskAccepted");
  });
});

// ---------------------------------------------------------------------------
// 2. Every write-time guard is reached through a mid-flight close
// ---------------------------------------------------------------------------

describe("ISH-1246: the close lands between the entry check and the write", () => {
  test("quietBlock reaches its write-time guard (never parks a cancelled Task)", () => {
    const id = toManualVerify("ish1246-guard-quiet-block");
    const live = getTask(db, id)!;
    cancelAtWriteBoundary(id, "operator closed while the provider read was in flight");

    const after = quietBlock(db, live, "late Linear HOLD", "provider:linear");

    expect(after.state).toBe("cancelled");
    expect(after.phase).toBe("verify");
    expect(getNotes(db, id).filter((n) => n.kind === "blocked_human")).toHaveLength(0);
    expect(eventTypes(id, "task.blocked_human")).toBe(0);
    const events = lateEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0].payload.kind).toBe("ChildBlocked");
    expect(events[0].payload.taskState).toBe("cancelled");
  });

  test("blockTask reaches its write-time guard (never parks a cancelled Task)", () => {
    const t = addTask(db, { title: "late block" });
    cancelAtWriteBoundary(t.id, "operator closed while the block was in flight");

    const after = blockTask(db, t.id, "w1", "late HOLD", true);

    expect(after.state).toBe("cancelled");
    expect(getNotes(db, t.id).filter((n) => n.kind === "blocked_human")).toHaveLength(0);
    expect(eventTypes(t.id, "task.blocked_human")).toBe(0);
    const events = lateEvents(t.id);
    expect(events).toHaveLength(1);
    expect(events[0].payload.kind).toBe("Block");
    expect(events[0].payload.taskState).toBe("cancelled");
  });

  test("recordImplementRecovery reaches its write-time guard (never bumps the attempt)", () => {
    const t = intakeTask(db, { provider: "test", issueId: "ish1246-guard-recovery", codeChange: true });
    insertImplementRun(t.id);
    cancelAtWriteBoundary(t.id, "operator closed while the recovery was in flight");

    const after = recordImplementRecovery(db, t.id, {
      runId: "run-ish1246",
      signature: "missing-commit:abc",
      reason: "missing-commit: retry the implement phase",
      evidence: ["run run-ish1246: state=failed", "exit=1"],
    });

    expect(after.state).toBe("cancelled");
    expect(after.phase).toBe("implement");
    expect(after.attempt).toBe(0);
    expect(eventTypes(t.id, "factory.implement_retry")).toBe(0);
    const events = lateEvents(t.id);
    expect(events).toHaveLength(1);
    expect(events[0].payload.kind).toBe("ImplementRecovery");
    expect(events[0].payload.taskState).toBe("cancelled");
  });

  test("confirmMerged reaches its write-time guard (never credits a merge)", () => {
    const id = toMergeReady("ish1246-guard-merge");
    cancelAtWriteBoundary(id, "operator closed while the merge read was in flight");

    const after = confirmMerged(db, id, { headSha: FULL, repo: "o/r", actor: "provider:github" });

    expect(after.state).toBe("cancelled");
    expect(after.merged_at).toBeNull();
    expect(findMergedResult(db, id)).toBeNull();
    const events = lateEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0].payload.kind).toBe("TaskMerged");
    expect(events[0].payload.taskState).toBe("cancelled");
  });

  test("requestMergeReadyRebase reaches its write-time guard (never re-opens the Task)", () => {
    const id = toMergeReady("ish1246-guard-rebase");
    cancelAtWriteBoundary(id, "operator closed while the PR conflict read was in flight");

    const after = requestMergeReadyRebase(db, id, "integ", {
      reason: "the PR conflicts with main",
      prMergeable: "conflicting",
      prHeadSha: FULL,
      headSha: FULL,
    });

    expect(after.state).toBe("cancelled");
    expect(after.phase).toBe("merge_ready");
    expect(after.attempt).toBe(0);
    expect(after.head_sha).toBe(FULL);
    expect(getNotes(db, id).filter((n) => n.kind === "rebase")).toHaveLength(0);
    expect(eventTypes(id, "workflow.rebase_requested")).toBe(0);
    const events = lateEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0].payload.kind).toBe("RebaseRequested");
    expect(events[0].payload.taskState).toBe("cancelled");
  });

  test("an integration submit naming a moved HEAD reaches its write-time guard", () => {
    const id = toIntegration("ish1246-guard-integration-submit");
    cancelAtWriteBoundary(id, "operator closed while the moved-HEAD submit was in flight");

    const after = submitPhase(db, id, "integ", { headSha: MOVED, evidence: "late integration submit" });

    expect(after.state).toBe("cancelled");
    expect(after.phase).toBe("integration");
    expect(after.attempt).toBe(0);
    expect(after.head_sha).toBe(FULL);
    expect(eventTypes(id, "workflow.review_invalidated")).toBe(0);
    const row = findTaskResult(db, id, "integration", 0, "TaskSubmitted");
    expect(row).not.toBeNull();
    expect(row!.reason).toContain("late integration submit");
    expect(row!.head_sha).toBe(MOVED);
    const events = lateEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0].payload.kind).toBe("TaskSubmitted");
    expect(events[0].payload.taskState).toBe("cancelled");
  });

  test("an integration RUN submit naming a moved HEAD reaches its write-time guard", () => {
    const id = toIntegration("ish1246-guard-run-integration");
    cancelAtWriteBoundary(id, "operator closed while the Run submission was in flight");

    const after = submitImplementationFromRun(db, id, {
      runId: "run-ish1246-integration",
      phase: "integration",
      attempt: 0,
      headSha: MOVED,
      baseHeadSha: FULL,
      summary: "late integration run submit",
    });

    expect(after.state).toBe("cancelled");
    expect(after.phase).toBe("integration");
    expect(after.attempt).toBe(0);
    expect(after.head_sha).toBe(FULL);
    expect(eventTypes(id, "workflow.review_invalidated")).toBe(0);
    const row = findTaskResult(db, id, "integration", 0, "TaskSubmitted");
    expect(row).not.toBeNull();
    expect(row!.reason).toBe("late integration run submit");
    expect(row!.head_sha).toBe(MOVED);
    const events = lateEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0].payload.kind).toBe("TaskSubmitted");
    expect(events[0].payload.taskState).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// 3. The headless reviewer keeps the same evidence shape (ReviewResult row)
// ---------------------------------------------------------------------------

describe("ISH-1246: a headless reviewer verdict that returns after a close", () => {
  test("is stored as a ReviewResult row plus task.late_result_ignored, not just an event", async () => {
    const repo = join(dir, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.email=relay@test",
      "-c",
      "user.name=relay-test",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "base",
    ]);
    const head = gitHead(repo)!;
    const t = intakeTask(db, {
      provider: "test",
      issueId: "ish1246-headless-review",
      codeChange: true,
      headSha: head,
      worktree: repo,
    });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl");
    claimTask(db, t.id, "ver");
    recordVerification(db, t.id, "ver", { passed: true, headSha: head });
    expect(getTask(db, t.id)!.phase).toBe("review");

    const result = await runHeadlessReview(db, t.id, {
      reviewerWorker: "rev",
      profile: "default",
      spawner: {
        async run() {
          // The operator closes the Task while the reviewer process runs.
          cancelTask(db, t.id, "operator", "closed while the reviewer ran");
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({ verdict: "pass", head, findings: [], summary: "looks good" }),
            stderr: "",
          };
        },
      },
    });

    // The verdict is refused (the Task is not review@head any more)...
    expect(result.outcome).toBe("refused");
    expect(getTask(db, t.id)!.state).toBe("cancelled");
    // ...but it is durable evidence with the SAME shape as every other path.
    const row = findTaskResult(db, t.id, "review", 0, "ReviewResult");
    expect(row).not.toBeNull();
    expect(row!.passed).toBe(1);
    expect(row!.head_sha).toBe(head);
    expect(row!.evidence_ref).toBeTruthy();
    expect(JSON.parse(row!.payload_json).source).toBe("claude-headless");
    const events = lateEvents(t.id);
    expect(events).toHaveLength(1);
    expect(events[0].payload.kind).toBe("ReviewResult");
    expect(events[0].payload.taskState).toBe("cancelled");
    expect(events[0].payload.resultId).toBe(row!.id);
  });
});
