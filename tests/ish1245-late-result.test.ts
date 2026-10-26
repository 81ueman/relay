import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { listEvents } from "../src/events";
import { cancelTask, claimNext, claimTask, getTask } from "../src/tasks";
import { registerWorker } from "../src/workers";
import {
  acceptTask,
  findTaskResult,
  intakeTask,
  recordReview,
  recordVerification,
  requestMergeReadyRebase,
  runMechanicalVerification,
  submitPhase,
  taskChecks,
} from "../src/workflow";
import { bindTaskPr } from "../src/pr-binding";
import type { PrRef, PrView } from "../src/providers";
import type { CheckSpec, CommandRunner } from "../src/verify";

// ISH-1245: a result produced by work that STARTED before a Task was closed
// (cancelled/failed/done) must never move the Task out of that terminal state.
// The result stays as evidence and `task.late_result_ignored` records why it
// did not apply. These tests cover the acceptance race plus the write-time
// fence on every result-recording path.

let dir = "";
let db: Database;

const FULL = "a".repeat(40);
const BASE = "0".repeat(40);
const CHECK: CheckSpec = { name: "typecheck", command: "bun run typecheck", required: true };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-ish1245-"));
  process.env.RELAY_DB = join(dir, "state.db");
  process.env.RELAY_LEASE_MS = "120000";
  db = openDb(process.env.RELAY_DB);
  registerWorker(db, "impl", { role: "worker" });
  registerWorker(db, "ver", { role: "worker" });
  registerWorker(db, "rev", { role: "reviewer" });
  registerWorker(db, "integ", { role: "integrator" });
});

afterEach(() => {
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

/**
 * Simulate another process committing a close at exactly the result-write
 * boundary: the trigger runs inside the test's transaction, but the guard only
 * ever observes the durable row (`getTask`), exactly as it would after a real
 * `cancelTask` from a separate connection.
 */
function cancelOnResult(kind: string): void {
  db.exec(`
    CREATE TRIGGER test_cancel_on_${kind}
    AFTER INSERT ON task_results
    WHEN NEW.kind = '${kind}'
    BEGIN
      UPDATE tasks
         SET state = 'cancelled', assignee = NULL, lease_until = NULL,
             lease_token = lease_token + 1, updated_at = NEW.created_at
       WHERE id = NEW.task_id AND state NOT IN ('done','failed','cancelled');
    END;
  `);
}

/** implement -> verify (manual; no mechanical checks) -> running verify claim. */
function toManualVerify(issueId: string): string {
  const t = intakeTask(db, { provider: "test", issueId, codeChange: true, headSha: FULL });
  claimTask(db, t.id, "impl");
  submitPhase(db, t.id, "impl");
  claimTask(db, t.id, "ver");
  return t.id;
}

/** manual verify PASS -> review, with the reviewer claim taken. */
function toReview(issueId: string): string {
  const id = toManualVerify(issueId);
  recordVerification(db, id, "ver", { passed: true, headSha: FULL });
  claimNext(db, "rev");
  expect(getTask(db, id)!.state).toBe("review");
  return id;
}

/** manual implement -> verify -> review -> integration -> merge_ready. */
function toMergeReady(issueId: string): string {
  const t = intakeTask(db, {
    provider: "test",
    issueId,
    codeChange: true,
    headSha: FULL,
    prUrl: "https://github.com/o/r/pull/1245",
    prRepo: "o/r",
  });
  claimTask(db, t.id, "impl");
  submitPhase(db, t.id, "impl");
  claimTask(db, t.id, "ver");
  recordVerification(db, t.id, "ver", { passed: true, headSha: FULL });
  claimNext(db, "rev");
  recordReview(db, t.id, "rev", { verdict: "pass", headSha: FULL });
  claimTask(db, t.id, "integ");
  submitPhase(db, t.id, "integ", { headSha: FULL });
  expect(getTask(db, t.id)!.phase).toBe("merge_ready");
  return t.id;
}

describe("ISH-1245: a close during VERIFY is terminal", () => {
  test("a mechanical verify cancelled while its command runs stays cancelled; the result is evidence", async () => {
    const t = intakeTask(db, {
      provider: "test",
      issueId: "ish1245-mechanical-verify",
      codeChange: true,
      headSha: FULL,
      checks: [CHECK],
    });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl");
    expect(getTask(db, t.id)!.phase).toBe("verify");

    const runner: CommandRunner = {
      async run(s) {
        // The operator cancels while the command is still running.
        cancelTask(db, t.id, "operator", "cancelled while verifying");
        return {
          name: s.name,
          required: true,
          outcome: "pass",
          exitCode: 0,
          output: "fake:pass",
          durationMs: 1,
        };
      },
    };
    const result = await runMechanicalVerification(db, t.id, {
      checks: taskChecks(getTask(db, t.id)!),
      runner,
      cwd: dir,
      headProbe: () => FULL,
    });

    expect(result.outcome).toBe("pass");
    expect(result.stale).toBe(true);
    const live = getTask(db, t.id)!;
    expect(live.state).toBe("cancelled");
    expect(live.phase).toBe("verify");
    expect(live.attempt).toBe(0);

    // The late result is durable evidence...
    const row = findTaskResult(db, t.id, "verify", 0, "VerificationResult");
    expect(row?.passed).toBe(1);
    expect(row?.head_sha).toBe(FULL);
    // ...and the refusal is audited.
    const events = lateEvents(t.id);
    expect(events).toHaveLength(1);
    expect(events[0].payload.kind).toBe("VerificationResult");
    expect(events[0].payload.taskState).toBe("cancelled");
    expect(events[0].payload.resultId).toBe(row!.id);
  });

  test("a manual VERIFY result committed at the close boundary is evidence only", () => {
    const id = toManualVerify("ish1245-manual-verify");
    expect(getTask(db, id)!.state).toBe("running");

    cancelOnResult("VerificationResult");
    const after = recordVerification(db, id, "ver", { passed: true, headSha: FULL });

    expect(after.state).toBe("cancelled");
    expect(after.phase).toBe("verify");
    expect(findTaskResult(db, id, "verify", 0, "VerificationResult")?.passed).toBe(1);
    expect(lateEvents(id)).toHaveLength(1);
  });
});

describe("ISH-1245: every other result path is fenced at the write boundary", () => {
  test("an implement submit committed at the close boundary is evidence only", () => {
    const t = intakeTask(db, {
      provider: "test",
      issueId: "ish1245-implement-submit",
      codeChange: true,
      headSha: FULL,
    });
    claimTask(db, t.id, "impl");

    cancelOnResult("TaskSubmitted");
    const after = submitPhase(db, t.id, "impl", { evidence: "late implement submit" });

    expect(after.state).toBe("cancelled");
    expect(after.phase).toBe("implement");
    expect(findTaskResult(db, t.id, "implement", 0, "TaskSubmitted")?.evidence_ref).toBe(
      "late implement submit"
    );
    expect(lateEvents(t.id)).toHaveLength(1);
  });

  test("a review verdict committed at the close boundary is evidence only", () => {
    const id = toReview("ish1245-review");

    cancelOnResult("ReviewResult");
    const after = recordReview(db, id, "rev", { verdict: "pass", headSha: FULL });

    expect(after.state).toBe("cancelled");
    expect(after.phase).toBe("review");
    expect(findTaskResult(db, id, "review", 0, "ReviewResult")?.passed).toBe(1);
    expect(lateEvents(id)).toHaveLength(1);
  });

  test("TaskAccepted committed at the close boundary is evidence only (never done)", () => {
    const id = toMergeReady("ish1245-accept");

    cancelOnResult("TaskAccepted");
    const after = acceptTask(db, id, "integ");

    expect(after.state).toBe("cancelled");
    expect(after.accepted_at).toBeNull();
    expect(findTaskResult(db, id, "merge_ready", 0, "TaskAccepted")).not.toBeNull();
    expect(lateEvents(id)).toHaveLength(1);
  });

  test("a rebase request cannot re-open a closed merge_ready Task", () => {
    const id = toMergeReady("ish1245-rebase");
    cancelTask(db, id, "operator", "closed before the rebase request");

    expect(() =>
      requestMergeReadyRebase(db, id, "integ", {
        reason: "the PR conflicts with main",
        prMergeable: "conflicting",
        prHeadSha: FULL,
        headSha: FULL,
      })
    ).toThrow(/terminal/);
    const after = getTask(db, id)!;
    expect(after.state).toBe("cancelled");
    expect(after.phase).toBe("merge_ready");
    // No phase move, no rebase note, no rebase_requested event.
    expect(getTask(db, id)!.attempt).toBe(0);
    expect(listEvents(db).some((e) => e.task_id === id && e.type === "workflow.rebase_requested")).toBe(false);
  });

  test("a PR binding that finishes after a close is refused and audited", async () => {
    const t = intakeTask(db, {
      provider: "github",
      issueId: "o/r#1245",
      codeChange: true,
      headSha: FULL,
      branch: "relay/ish-1245",
      prUrl: "https://github.com/o/r/pull/1245",
      prRepo: "o/r",
    });
    const view: PrView = {
      ref: { repo: "o/r", number: 1245 },
      url: "https://github.com/o/r/pull/1245",
      state: "open",
      isDraft: false,
      headRefName: "relay/ish-1245",
      headSha: FULL,
      baseRef: "main",
      baseSha: BASE,
      mergeable: "mergeable",
      labels: [],
      updatedAt: "2026-10-26T14:35:00Z",
      isCrossRepository: false,
      headRepo: "o/r",
    };
    const github = {
      name: "cancelling-github",
      readOnly: true as const,
      getPullRequest(_ref: PrRef): PrView {
        // The PR read is in flight when the operator closes the Task.
        cancelTask(db, t.id, "operator", "cancelled during PR read");
        return view;
      },
      findPullRequestForBranch(): PrView | null {
        return null;
      },
      listComments(): [] {
        return [];
      },
      rateLimit(): null {
        return null;
      },
    };

    const res = await bindTaskPr(db, t.id, { github, repo: "o/r" });

    expect(res.status).toBe("blocked");
    expect(res.code).toBe("STALE");
    expect(getTask(db, t.id)!.state).toBe("cancelled");
    const events = lateEvents(t.id);
    expect(events).toHaveLength(1);
    expect(events[0].payload.kind).toBe("PrBinding");
    expect(events[0].payload.taskState).toBe("cancelled");
  });
});
