import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { MockRuntime } from "../src/runtime/runtime";
import { reconcile } from "../src/reconciler";
import { addTask, cancelTask, claimNext, claimTask, getTask, runnableTasks, unblockTask } from "../src/tasks";
import { getWorker, registerWorker } from "../src/workers";
import {
  acceptTask,
  codeChangeGateSatisfied,
  confirmMerged,
  findMergedResult,
  findTaskResult,
  findUnresolvedNgAtHead,
  intakeTask,
  linkTask,
  quietBlock,
  recordReview,
  recordVerification,
  runMechanicalVerification,
  submitPhase,
  taskChecks,
} from "../src/workflow";
import { FakeGitHub, FakeLinear, NO_AUTHORITY, reconcileTaskFromProvider, type GitHubReadOnly, type PrView } from "../src/providers";
import {
  pendingMechanicalVerifications,
  providerBoundTasks,
  reconcileProviderBound,
  runPendingMechanicalVerifications,
  type WorkflowDeps,
} from "../src/workflow-driver";
import type { CheckSpec, CommandRunner, ExecutedCheck } from "../src/verify";

// ISH-759: the event-driven code-change workflow, end to end, with an injected
// read-only command runner and read-only fake GitHub/Linear providers. No real
// subprocess, no network, no provider writes.

let dir = "";
let db: Database;

const FULL = "a".repeat(40);
const MOVED = "b".repeat(40);
const BASE = "0".repeat(40);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-ish759-"));
  process.env.RELAY_DB = join(dir, "state.db");
  process.env.RELAY_LEASE_MS = "120000";
  db = openDb(process.env.RELAY_DB);
  registerWorker(db, "impl", { role: "worker" });
  registerWorker(db, "rev", { role: "reviewer" });
  registerWorker(db, "integ", { role: "integrator" });
});

afterEach(() => {
  delete process.env.RELAY_AUTO_APPROVE;
  delete process.env.RELAY_HUMAN;
  delete process.env.RELAY_PROVIDER_POLL_MS;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const CHECK: CheckSpec = { name: "typecheck", command: "bun run typecheck", required: true };

function outcomeRunner(outcome: ExecutedCheck["outcome"], onRun?: () => void): CommandRunner {
  return {
    async run(s) {
      onRun?.();
      return {
        name: s.name,
        required: s.required !== false,
        outcome,
        exitCode: outcome === "pass" ? 0 : outcome === "fail" ? 1 : null,
        output: `fake:${outcome}`,
        durationMs: 1,
      };
    },
  };
}

function countMessages(recipient: string, kind: string): number {
  return (
    db.query(`SELECT COUNT(*) AS n FROM messages WHERE recipient = ? AND kind = ?`).get(recipient, kind) as { n: number }
  ).n;
}

/** Run mechanical verify with the task's own head as the bound head (test fake). */
async function mechanical(
  id: string,
  outcome: ExecutedCheck["outcome"],
  opts: { onRun?: () => void; head?: string } = {}
) {
  return runMechanicalVerification(db, id, {
    checks: taskChecks(getTask(db, id)!),
    runner: outcomeRunner(outcome, opts.onRun),
    cwd: "/work",
    headProbe: () => opts.head ?? getTask(db, id)!.head_sha,
  });
}

/** Drive implement -> mechanical verify(pass) -> review, leaving the task in review. */
async function toReview(id: string, runner?: CommandRunner): Promise<void> {
  claimTask(db, id, "impl");
  submitPhase(db, id, "impl", { headSha: getTask(db, id)!.head_sha ?? undefined });
  if (runner) {
    await runMechanicalVerification(db, id, {
      checks: taskChecks(getTask(db, id)!),
      runner,
      cwd: "/work",
      headProbe: () => getTask(db, id)!.head_sha,
    });
  } else {
    await mechanical(id, "pass");
  }
}

describe("mechanical verification: Relay runs the commands, no LLM waits", async () => {
  test("a Relay-owned verify phase is never offered to the claim machine", async () => {
    const t = intakeTask(db, { provider: "github", issueId: "o/r#1", codeChange: true, headSha: FULL, checks: [CHECK] });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl");
    const after = getTask(db, t.id)!;
    expect(after.phase).toBe("verify");
    expect(after.claim_role).toBe("relay");
    expect(runnableTasks(db).some((x) => x.id === t.id)).toBe(false);
    expect(pendingMechanicalVerifications(db).map((x) => x.id)).toEqual([t.id]);
  });

  test("PASS -> review (independent reviewer claimable)", async () => {
    const t = intakeTask(db, { provider: "github", issueId: "o/r#2", codeChange: true, headSha: FULL, checks: [CHECK] });
    await toReview(t.id);
    expect(getTask(db, t.id)!.phase).toBe("review");
    expect(claimNext(db, "rev")?.id).toBe(t.id);
  });

  test("FAIL -> implement FIX at a new attempt, head cleared", async () => {
    const t = intakeTask(db, { provider: "github", issueId: "o/r#3", codeChange: true, headSha: FULL, checks: [CHECK] });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl", { headSha: FULL });
    const r = await mechanical(t.id, "fail");
    expect(r.outcome).toBe("fail");
    expect(r.task.phase).toBe("implement");
    expect(r.task.state).toBe("queued");
    expect(r.task.attempt).toBe(1);
    expect(r.task.head_sha).toBeNull();
  });

  test("a required NOT_RUN -> BLOCKED (never PASS)", async () => {
    process.env.RELAY_HUMAN = "gateway";
    registerWorker(db, "gateway", { role: "planner" });
    const t = intakeTask(db, { provider: "github", issueId: "o/r#4", codeChange: true, headSha: FULL, checks: [CHECK] });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl", { headSha: FULL });
    const r = await mechanical(t.id, "not_run");
    expect(r.outcome).toBe("not_run");
    expect(r.task.state).toBe("blocked_human");
    expect(findTaskResult(db, t.id, "verify", 0, "VerificationResult")!.passed).toBe(0);
    // quiet block: exactly one Gateway notice, no wake storm
    expect(countMessages("gateway", "child_blocked")).toBe(1);
  });

  test("a required INCONCLUSIVE -> BLOCKED", async () => {
    const t = intakeTask(db, { provider: "github", issueId: "o/r#5", codeChange: true, headSha: FULL, checks: [CHECK] });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl", { headSha: FULL });
    const r = await mechanical(t.id, "inconclusive");
    expect(r.outcome).toBe("inconclusive");
    expect(r.task.state).toBe("blocked_human");
  });

  test("an old-HEAD result is discarded and never becomes PASS", async () => {
    const t = intakeTask(db, { provider: "github", issueId: "o/r#6", codeChange: true, headSha: FULL, checks: [CHECK] });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl", { headSha: FULL });
    // Head moves WHILE the check runs; the probe binds to FULL (the start head).
    const r = await mechanical(t.id, "pass", { head: FULL, onRun: () => linkTask(db, t.id, { headSha: MOVED }) });
    expect(r.stale).toBe(true);
    expect(r.outcome).toBe("pass");
    const live = getTask(db, t.id)!;
    expect(live.head_sha).toBe(MOVED);
    expect(live.phase).not.toBe("review"); // the stale PASS did not advance
    expect(findTaskResult(db, t.id, "verify", 0, "VerificationResult")).toBeNull();
  });
});

describe("review verdicts: PASS / FIX / BLOCKED", async () => {
  test("PASS -> integration -> merge_ready; acceptance then merge", async () => {
    const t = intakeTask(db, { provider: "github", issueId: "o/r#7", codeChange: true, headSha: FULL, checks: [CHECK], prUrl: "https://github.com/o/r/pull/7", prRepo: "o/r" });
    await toReview(t.id);
    expect(claimNext(db, "rev")?.id).toBe(t.id);
    recordReview(db, t.id, "rev", { verdict: "pass", headSha: FULL });
    expect(getTask(db, t.id)!.phase).toBe("integration");
    claimTask(db, t.id, "integ");
    submitPhase(db, t.id, "integ");
    expect(getTask(db, t.id)!.phase).toBe("merge_ready");
    const accepted = acceptTask(db, t.id, "integ");
    expect(accepted.state).toBe("done");
    // A task with a PR is not "truly done" until the real merge is confirmed.
    expect(codeChangeGateSatisfied(getTask(db, t.id)!)).toBe(false);
    const merged = confirmMerged(db, t.id, { headSha: FULL, repo: "o/r" });
    expect(merged.merged_at).not.toBeNull();
    expect(findMergedResult(db, t.id)).not.toBeNull();
    expect(codeChangeGateSatisfied(getTask(db, t.id)!)).toBe(true);
  });

  test("FIX -> new attempt on the SAME task; BLOCKED -> quiet human block", async () => {
    const t = intakeTask(db, { provider: "github", issueId: "o/r#8", codeChange: true, headSha: FULL, checks: [CHECK] });
    await toReview(t.id);
    claimNext(db, "rev");
    const fixed = recordReview(db, t.id, "rev", { verdict: "fix", headSha: FULL, reason: "bug" });
    expect(fixed.phase).toBe("implement");
    expect(fixed.attempt).toBe(1);

    // second attempt on a MOVED head, this time BLOCKED
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl", { headSha: MOVED });
    await mechanical(t.id, "pass");
    claimNext(db, "rev");
    process.env.RELAY_HUMAN = "gateway";
    registerWorker(db, "gateway", { role: "planner" });
    const blocked = recordReview(db, t.id, "rev", { verdict: "blocked", headSha: MOVED, reason: "needs a human" });
    expect(blocked.state).toBe("blocked_human");
    expect(countMessages("gateway", "child_blocked")).toBe(1);
  });

  test("an unresolved NG at the same HEAD is never cleared by a later OK alone", async () => {
    const t = intakeTask(db, { provider: "github", issueId: "o/r#9", codeChange: true, headSha: FULL, checks: [CHECK] });
    await toReview(t.id);
    claimNext(db, "rev");
    recordReview(db, t.id, "rev", { verdict: "fix", headSha: FULL, reason: "ng" });
    // Re-implement + re-verify the SAME head (a body-only fix does not move it).
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl", { headSha: FULL });
    await mechanical(t.id, "pass");
    claimNext(db, "rev");
    expect(findUnresolvedNgAtHead(db, t.id, FULL)).not.toBeNull();
    // A DIFFERENT profile's OK cannot silently clear the NG.
    expect(() => recordReview(db, t.id, "rev", { verdict: "pass", headSha: FULL, profile: "second" })).toThrow(/UNRESOLVED_NG/);
    // Explicit supersede is required.
    const ng = findUnresolvedNgAtHead(db, t.id, FULL)!;
    const ok = recordReview(db, t.id, "rev", { verdict: "pass", headSha: FULL, profile: "second", supersedesResultId: ng.id });
    expect(ok.phase).toBe("integration");
  });

  test("the reviewer has no write/merge: it cannot submit code or accept", async () => {
    const t = intakeTask(db, { provider: "github", issueId: "o/r#10", codeChange: true, headSha: FULL, checks: [CHECK] });
    await toReview(t.id);
    claimNext(db, "rev");
    expect(() => submitPhase(db, t.id, "rev", { headSha: FULL })).toThrow(/submit applies to implement\/integration/);
    recordReview(db, t.id, "rev", { verdict: "pass", headSha: FULL });
    claimTask(db, t.id, "integ");
    submitPhase(db, t.id, "integ");
    expect(() => acceptTask(db, t.id, "rev")).toThrow(/AUTHORITY/);
  });
});

describe("Gateway is notified only for judgment events", async () => {
  test("ordinary FIX/PASS never message the Gateway; children_ready fires once", async () => {
    process.env.RELAY_HUMAN = "gateway";
    registerWorker(db, "gateway", { role: "planner" });
    const parent = intakeTask(db, { provider: "github", issueId: "o/r#11", codeChange: true, headSha: FULL, checks: [CHECK] });
    const c1 = intakeTask(db, { provider: "github", issueId: "o/r#11", slice: "a", codeChange: true, headSha: FULL, checks: [CHECK], parentTaskId: parent.id });
    const c2 = intakeTask(db, { provider: "github", issueId: "o/r#11", slice: "b", codeChange: true, headSha: FULL, checks: [CHECK], parentTaskId: parent.id });

    // c1: a PASS then accept. No Gateway message on the PASS itself.
    await toReview(c1.id);
    claimNext(db, "rev");
    recordReview(db, c1.id, "rev", { verdict: "pass", headSha: FULL });
    expect(countMessages("gateway", "child_blocked")).toBe(0);
    claimTask(db, c1.id, "integ");
    submitPhase(db, c1.id, "integ");
    acceptTask(db, c1.id, "gateway");
    expect(countMessages("gateway", "children_ready")).toBe(0); // c2 not done

    await toReview(c2.id);
    claimNext(db, "rev");
    recordReview(db, c2.id, "rev", { verdict: "pass", headSha: FULL });
    claimTask(db, c2.id, "integ");
    submitPhase(db, c2.id, "integ");
    acceptTask(db, c2.id, "gateway");
    expect(countMessages("gateway", "children_ready")).toBe(1);
  });
});

describe("provider reconciliation binds state without writing", async () => {
  function githubView(state: PrView["state"], headSha: string): PrView {
    return {
      ref: { repo: "o/r", number: 1 },
      url: "https://github.com/o/r/pull/1",
      state,
      isDraft: false,
      headRefName: "devin/ish759",
      headSha,
      baseRef: "main",
      baseSha: BASE,
      mergeable: "mergeable",
      labels: ["some-label"],
      updatedAt: "2026-01-01T00:00:00Z",
    };
  }

  test("a GitHub LABEL is never an approval", async () => {
    const t = intakeTask(db, { provider: "github", issueId: "o/r#12", codeChange: true, headSha: FULL, checks: [CHECK], prUrl: "https://github.com/o/r/pull/1", prRepo: "o/r" });
    await toReview(t.id);
    const gh = new FakeGitHub();
    gh.putPullRequest(githubView("open", FULL));
    // Only a label, no verdict marker.
    const actions = await reconcileTaskFromProvider(db, t.id, { github: gh, authorizedReviewers: ["claude"] });
    expect(actions.some((a) => a.kind.startsWith("review-"))).toBe(false);
    expect(getTask(db, t.id)!.phase).toBe("review");
  });

  test("a self-claimed marker is ignored; an authorized OK advances", async () => {
    const t = intakeTask(db, { provider: "github", issueId: "o/r#13", codeChange: true, headSha: FULL, checks: [CHECK], prUrl: "https://github.com/o/r/pull/1", prRepo: "o/r" });
    await toReview(t.id);
    const gh = new FakeGitHub();
    gh.putPullRequest(githubView("open", FULL));
    gh.putComments({ repo: "o/r", number: 1 }, [
      { author: "impostor", createdAt: "2026-01-01T00:00:00Z", body: `<!-- ishiul-review head=${FULL} verdict=OK reviewer=claude -->` },
    ]);
    await reconcileTaskFromProvider(db, t.id, { github: gh, authorizedReviewers: ["claude"] });
    expect(getTask(db, t.id)!.phase).toBe("review"); // self-claim ignored

    gh.putComments({ repo: "o/r", number: 1 }, [
      { author: "claude", createdAt: "2026-01-01T00:00:00Z", body: `<!-- ishiul-review head=${FULL} verdict=OK reviewer=claude -->` },
    ]);
    // A new real comment moves the PR; simulate that so comments are refetched.
    db.query(`UPDATE tasks SET pr_updated_at = NULL WHERE id = ?`).run(t.id);
    const actions = await reconcileTaskFromProvider(db, t.id, { github: gh, authorizedReviewers: ["claude"] });
    expect(actions.some((a) => a.kind === "review-pass")).toBe(true);
    expect(getTask(db, t.id)!.phase).toBe("integration");
  });

  test("the live PR head is bound; a move sends the task back to review", async () => {
    const t = intakeTask(db, { provider: "github", issueId: "o/r#14", codeChange: true, headSha: FULL, checks: [CHECK], prUrl: "https://github.com/o/r/pull/1", prRepo: "o/r" });
    await toReview(t.id);
    claimNext(db, "rev");
    recordReview(db, t.id, "rev", { verdict: "pass", headSha: FULL });
    claimTask(db, t.id, "integ");
    submitPhase(db, t.id, "integ");
    expect(getTask(db, t.id)!.phase).toBe("merge_ready");

    const gh = new FakeGitHub();
    gh.putPullRequest(githubView("open", MOVED)); // synchronize: head moved
    const actions = await reconcileTaskFromProvider(db, t.id, { github: gh });
    expect(actions.some((a) => a.kind === "pr-head-bound")).toBe(true);
    const live = getTask(db, t.id)!;
    expect(live.head_sha).toBe(MOVED);
    expect(live.phase).toBe("review"); // re-review required
  });

  test("a merged PR at the recorded head confirms the merge (read-only)", async () => {
    const t = intakeTask(db, { provider: "github", issueId: "o/r#15", codeChange: true, headSha: FULL, checks: [CHECK], prUrl: "https://github.com/o/r/pull/1", prRepo: "o/r" });
    await toReview(t.id);
    claimNext(db, "rev");
    recordReview(db, t.id, "rev", { verdict: "pass", headSha: FULL });
    claimTask(db, t.id, "integ");
    submitPhase(db, t.id, "integ");
    acceptTask(db, t.id, "integ");

    const gh = new FakeGitHub();
    gh.putPullRequest(githubView("merged", FULL));
    const actions = await reconcileTaskFromProvider(db, t.id, { github: gh });
    expect(actions.some((a) => a.kind === "merged")).toBe(true);
    expect(getTask(db, t.id)!.merged_at).not.toBeNull();
  });

  test("a Linear HOLD parks the task quietly, once", async () => {
    process.env.RELAY_HUMAN = "gateway";
    registerWorker(db, "gateway", { role: "planner" });
    const t = intakeTask(db, { provider: "linear", issueId: "ISH-759", codeChange: true, headSha: FULL, checks: [CHECK] });
    await toReview(t.id);
    const lin = new FakeLinear();
    lin.putIssue({ id: "ISH-759", state: "In Progress", labels: ["hold"], updatedAt: "2026-01-01T00:00:00Z" });
    const first = await reconcileTaskFromProvider(db, t.id, { linear: lin });
    expect(first.some((a) => a.kind === "linear-hold")).toBe(true);
    expect(getTask(db, t.id)!.state).toBe("blocked_human");
    // A second pass does not re-block or re-notify.
    const second = await reconcileTaskFromProvider(db, t.id, { linear: lin });
    expect(second.some((a) => a.kind === "linear-hold")).toBe(false);
    expect(countMessages("gateway", "child_blocked")).toBe(1);
  });
});

describe("the reconciler drives verify and providers event-driven", async () => {
  test("reconcile runs a pending mechanical verify and dispatches a reviewer", async () => {
    const t = intakeTask(db, { provider: "github", issueId: "o/r#16", codeChange: true, headSha: FULL, checks: [CHECK] });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl", { headSha: FULL });
    const rt = new MockRuntime();
    const deps: WorkflowDeps = { verifyRunner: outcomeRunner("pass"), verifyCwd: "/work", verifyHeadProbe: () => FULL };
    const { actions } = await reconcile(db, rt, Date.now(), deps);
    expect(actions.some((a) => a.startsWith("verify-pass:"))).toBe(true);
    expect(getTask(db, t.id)!.phase).toBe("review");
  });

  test("pending mechanical verifications are not re-run once a result exists", async () => {
    const t = intakeTask(db, { provider: "github", issueId: "o/r#17", codeChange: true, headSha: FULL, checks: [CHECK] });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl", { headSha: FULL });
    expect(pendingMechanicalVerifications(db).map((x) => x.id)).toEqual([t.id]);
  });
});

describe("no RELAY_AUTO_APPROVE bypass on the mechanical path", async () => {
  test("a verified code task in review is not auto-approved", async () => {
    process.env.RELAY_AUTO_APPROVE = "true";
    const t = intakeTask(db, { provider: "github", issueId: "o/r#18", codeChange: true, headSha: FULL, checks: [CHECK] });
    await toReview(t.id);
    const rt = new MockRuntime();
    const { actions } = await reconcile(db, rt);
    expect(actions).not.toContain(`auto-approved:${t.id}`);
    expect(getTask(db, t.id)!.state).toBe("review");
  });
});

describe("read-only authority default", async () => {
  test("provider reconciliation with no authority never performs a merge", async () => {
    expect(NO_AUTHORITY.merge).toBe(false);
    expect(() => confirmMerged(db, "T404")).toThrow(/unknown task/);
  });
});

describe("finding 1: mechanical verify binds to the recorded head", async () => {
  test("a checkout HEAD != the task head BLOCKS (never PASS)", async () => {
    const t = intakeTask(db, { provider: "github", issueId: "o/r#20", codeChange: true, headSha: FULL, checks: [CHECK] });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl", { headSha: FULL });
    // The runner's cwd HEAD is MOVED, not the recorded FULL head.
    const r = await mechanical(t.id, "pass", { head: MOVED });
    expect(r.outcome).toBe("not_run");
    const live = getTask(db, t.id)!;
    expect(live.state).toBe("blocked_human");
    expect(live.phase).toBe("verify");
    const vr = findTaskResult(db, t.id, "verify", 0, "VerificationResult")!;
    expect(vr.passed).toBe(0);
    expect(vr.reason).toContain("checkout HEAD");
  });

  test("the driver uses the task's worktree and its probe", async () => {
    const t = intakeTask(db, { provider: "github", issueId: "o/r#21", codeChange: true, headSha: FULL, checks: [CHECK] });
    db.query(`UPDATE tasks SET worktree = ? WHERE id = ?`).run("/wt", t.id);
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl", { headSha: FULL });
    const actions = await runPendingMechanicalVerifications(db, {
      verifyRunner: outcomeRunner("pass"),
      verifyHeadProbe: () => MOVED, // wrong head -> not_run
    });
    expect(actions).toContain(`verify-not_run:${t.id}`);
    expect(getTask(db, t.id)!.state).toBe("blocked_human");
  });
});

describe("finding 2: a blocked mechanical verify is resumable", async () => {
  test("unblock routes back to a fresh implement attempt, then re-verifies", async () => {
    const t = intakeTask(db, { provider: "github", issueId: "o/r#22", codeChange: true, headSha: FULL, checks: [CHECK] });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl", { headSha: FULL });
    await mechanical(t.id, "not_run");
    expect(getTask(db, t.id)!.state).toBe("blocked_human");

    const resumed = unblockTask(db, t.id, "impl");
    expect(resumed.state).toBe("queued");
    expect(resumed.phase).toBe("implement");
    expect(resumed.attempt).toBe(1);
    expect(resumed.head_sha).toBeNull();

    // The fresh attempt can run implement -> verify -> review again.
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl", { headSha: FULL });
    await mechanical(t.id, "pass");
    expect(getTask(db, t.id)!.phase).toBe("review");
  });
});

describe("finding 3: a review BLOCKED / Linear HOLD is resumable", async () => {
  test("unblock routes a review BLOCKED back to a fresh attempt", async () => {
    const t = intakeTask(db, { provider: "github", issueId: "o/r#23", codeChange: true, headSha: FULL, checks: [CHECK] });
    await toReview(t.id);
    claimNext(db, "rev");
    recordReview(db, t.id, "rev", { verdict: "blocked", headSha: FULL, reason: "need human" });
    expect(getTask(db, t.id)!.state).toBe("blocked_human");
    expect(getTask(db, t.id)!.phase).toBe("review");

    const resumed = unblockTask(db, t.id, "rev");
    expect(resumed.phase).toBe("implement");
    expect(resumed.attempt).toBe(1);
    expect(resumed.head_sha).toBeNull();
    // A fresh attempt is claimable and reviewable (no stale ReviewResult dead end).
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl", { headSha: FULL });
    await mechanical(t.id, "pass");
    expect(claimNext(db, "rev")?.id).toBe(t.id);
  });

  test("a Linear HOLD on a review task resumes on unblock", async () => {
    process.env.RELAY_HUMAN = "gateway";
    registerWorker(db, "gateway", { role: "planner" });
    const t = intakeTask(db, { provider: "linear", issueId: "ISH-999", codeChange: true, headSha: FULL, checks: [CHECK] });
    await toReview(t.id);
    const lin = new FakeLinear();
    lin.putIssue({ id: "ISH-999", state: "In Progress", labels: ["hold"], updatedAt: "2026-01-01T00:00:00Z" });
    await reconcileTaskFromProvider(db, t.id, { linear: lin });
    expect(getTask(db, t.id)!.state).toBe("blocked_human");

    // A review with NO stored result resumes AT review (state=review), not
    // queued: claimNext then keeps it at review so recordReview can run.
    const resumed = unblockTask(db, t.id, "gateway");
    expect(resumed.phase).toBe("review");
    expect(resumed.state).toBe("review");
    expect(claimNext(db, "rev")?.id).toBe(t.id);
    expect(getTask(db, t.id)!.state).toBe("review");
  });
});

describe("finding 4: quietBlock releases the owning worker", async () => {
  test("a Linear HOLD on a running task clears the worker's current_task_id", async () => {
    const t = intakeTask(db, { provider: "linear", issueId: "ISH-1000", codeChange: true, headSha: FULL });
    claimTask(db, t.id, "impl");
    expect(getWorker(db, "impl")!.current_task_id).toBe(t.id);

    const lin = new FakeLinear();
    lin.putIssue({ id: "ISH-1000", state: "In Progress", labels: ["hold"], updatedAt: "2026-01-01T00:00:00Z" });
    await reconcileTaskFromProvider(db, t.id, { linear: lin });

    expect(getTask(db, t.id)!.state).toBe("blocked_human");
    const w = getWorker(db, "impl")!;
    expect(w.current_task_id).toBeNull();
    expect(w.state).toBe("idle");
  });
});

describe("finding 6: the merge gate is enforced where done is decided", async () => {
  /** Walk a code child (with a PR) all the way to an internal accept. */
  async function acceptCodeChild(id: string): Promise<void> {
    await toReview(id);
    claimNext(db, "rev");
    recordReview(db, id, "rev", { verdict: "pass", headSha: FULL });
    claimTask(db, id, "integ");
    submitPhase(db, id, "integ");
    acceptTask(db, id, "integ");
  }

  test("ISH-1087: a merge is NOT credited when no PR is bound (the gate would be NO_PR)", async () => {
    const t = intakeTask(db, { provider: "github", issueId: "o/r#1087", codeChange: true, headSha: FULL, checks: [CHECK] });
    await acceptCodeChild(t.id);
    expect(() => confirmMerged(db, t.id, { headSha: FULL, repo: "o/r" })).toThrow(/NO_PR/);
    expect(getTask(db, t.id)!.merged_at).toBeNull();
    expect(findMergedResult(db, t.id)).toBeNull();
  });

  test("children_ready waits for the real merge of a PR-bound child", async () => {
    process.env.RELAY_HUMAN = "gateway";
    registerWorker(db, "gateway", { role: "planner" });
    const parent = intakeTask(db, { provider: "github", issueId: "o/r#30", codeChange: true, headSha: FULL, checks: [CHECK] });
    const c1 = intakeTask(db, {
      provider: "github", issueId: "o/r#30", slice: "a", codeChange: true, headSha: FULL, checks: [CHECK],
      parentTaskId: parent.id, prUrl: "https://github.com/o/r/pull/1", prRepo: "o/r",
    });
    const c2 = intakeTask(db, {
      provider: "github", issueId: "o/r#30", slice: "b", codeChange: true, headSha: FULL, checks: [CHECK],
      parentTaskId: parent.id, prUrl: "https://github.com/o/r/pull/2", prRepo: "o/r",
    });
    await acceptCodeChild(c1.id);
    await acceptCodeChild(c2.id);
    // Both internally accepted; neither merged -> NOT children_ready.
    expect(countMessages("gateway", "children_ready")).toBe(0);
    confirmMerged(db, c1.id, { headSha: FULL, repo: "o/r" });
    expect(countMessages("gateway", "children_ready")).toBe(0); // c2 still unmerged
    confirmMerged(db, c2.id, { headSha: FULL, repo: "o/r" });
    expect(countMessages("gateway", "children_ready")).toBe(1); // now truly done
  });

  test("a PR-bound code dependency is not satisfied until merged", async () => {
    const dep = intakeTask(db, {
      provider: "github", issueId: "o/r#31", codeChange: true, headSha: FULL,
      prUrl: "https://github.com/o/r/pull/3", prRepo: "o/r",
    });
    const dependent = addTask(db, { title: "dependent", dependsOn: [dep.id] });
    // Force the dep to an accepted-but-unmerged state.
    db.query(`UPDATE tasks SET state = 'done', phase = 'merge_ready' WHERE id = ?`).run(dep.id);
    expect(runnableTasks(db).some((t) => t.id === dependent.id)).toBe(false);
    // Now confirm the merge: the dependency is satisfied.
    confirmMerged(db, dep.id, { headSha: FULL, repo: "o/r" });
    expect(runnableTasks(db).some((t) => t.id === dependent.id)).toBe(true);
  });
});

describe("finding 6: marker application uses the live head and dedupes", async () => {
  test("an abbreviated marker SHA applies against the live full head", async () => {
    const t = intakeTask(db, {
      provider: "github", issueId: "o/r#32", codeChange: true, headSha: FULL, checks: [CHECK],
      prUrl: "https://github.com/o/r/pull/4", prRepo: "o/r",
    });
    await toReview(t.id);
    const gh = new FakeGitHub();
    gh.putPullRequest({
      ref: { repo: "o/r", number: 4 }, url: "https://github.com/o/r/pull/4", state: "open", isDraft: false,
      headRefName: "b", headSha: FULL, baseRef: "main", baseSha: "0".repeat(40), mergeable: "mergeable",
      labels: [], updatedAt: "2026-01-01T00:00:00Z",
    });
    gh.putComments({ repo: "o/r", number: 4 }, [
      { author: "claude", createdAt: "2026-01-01T00:00:00Z", body: `<!-- ishiul-review head=${FULL.slice(0, 7)} verdict=OK reviewer=claude -->` },
    ]);
    const actions = await reconcileTaskFromProvider(db, t.id, { github: gh, authorizedReviewers: ["claude"] });
    expect(actions.some((a) => a.kind === "review-pass")).toBe(true);
    const result = db.query(`SELECT * FROM task_results WHERE task_id = ? AND kind='ReviewResult'`).get(t.id) as { head_sha: string };
    expect(result.head_sha).toBe(FULL); // the live FULL head, not the abbreviation
  });

  test("an unappliable marker logs marker_not_applied once across passes", async () => {
    const t = intakeTask(db, {
      provider: "github", issueId: "o/r#33", codeChange: true, headSha: FULL, checks: [CHECK],
      prUrl: "https://github.com/o/r/pull/5", prRepo: "o/r",
    });
    await toReview(t.id);
    // First, an authorized NG at H (routes to implement, head cleared).
    claimNext(db, "rev");
    recordReview(db, t.id, "rev", { verdict: "fix", headSha: FULL });
    // Back to review at the same head: a stale OK marker cannot apply (duplicate).
    db.query(`UPDATE tasks SET phase='review', state='review', claim_role='reviewer', assignee=NULL WHERE id = ?`).run(t.id);
    const gh = new FakeGitHub();
    gh.putPullRequest({
      ref: { repo: "o/r", number: 5 }, url: "https://github.com/o/r/pull/5", state: "open", isDraft: false,
      headRefName: "b", headSha: FULL, baseRef: "main", baseSha: "0".repeat(40), mergeable: "mergeable",
      labels: [], updatedAt: "2026-01-01T00:00:00Z",
    });
    gh.putComments({ repo: "o/r", number: 5 }, [
      { author: "claude", createdAt: "2026-01-01T00:00:00Z", body: `<!-- ishiul-review head=${FULL} verdict=OK reviewer=claude -->` },
    ]);
    for (let i = 0; i < 3; i++) {
      // Force a comment fetch each pass (as if the PR kept moving) so the dedupe
      // — not the comment-fetch throttle — is what limits the event.
      db.query(`UPDATE tasks SET pr_updated_at = NULL WHERE id = ?`).run(t.id);
      await reconcileTaskFromProvider(db, t.id, { github: gh, authorizedReviewers: ["claude"] });
    }
    const n = db
      .query(`SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'workflow.marker_not_applied'`)
      .get(t.id) as { n: number };
    expect(n.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Round-2 findings
// ---------------------------------------------------------------------------

function githubViewAt(
  number: number,
  headSha: string,
  state: PrView["state"] = "open",
  updatedAt = "2026-01-01T00:00:00Z"
): PrView {
  return {
    ref: { repo: "o/r", number },
    url: `https://github.com/o/r/pull/${number}`,
    state,
    isDraft: false,
    headRefName: "devin/ish759",
    headSha,
    baseRef: "main",
    baseSha: "0".repeat(40),
    mergeable: "mergeable",
    labels: [],
    updatedAt,
  };
}

describe("round 2: a Linear HOLD on review resumes at review", async () => {
  test("HOLD -> unblock -> review PASS", async () => {
    process.env.RELAY_HUMAN = "gateway";
    registerWorker(db, "gateway", { role: "planner" });
    const t = intakeTask(db, { provider: "linear", issueId: "ISH-2000", codeChange: true, headSha: FULL, checks: [CHECK] });
    await toReview(t.id);
    expect(getTask(db, t.id)!.state).toBe("review");

    const lin = new FakeLinear();
    lin.putIssue({ id: "ISH-2000", state: "In Progress", labels: ["hold"], updatedAt: "2026-01-01T00:00:00Z" });
    await reconcileTaskFromProvider(db, t.id, { linear: lin });
    expect(getTask(db, t.id)!.state).toBe("blocked_human");

    // Unblock with NO stored review: must resume at `review`, not `queued`.
    const resumed = unblockTask(db, t.id, "gateway");
    expect(resumed.state).toBe("review");
    expect(resumed.phase).toBe("review");
    expect(resumed.claim_role).toBe("reviewer");

    // claimNext keeps a state=review task at review (not running), so the review
    // can be recorded.
    const claimed = claimNext(db, "rev");
    expect(claimed?.id).toBe(t.id);
    expect(getTask(db, t.id)!.state).toBe("review");
    const done = recordReview(db, t.id, "rev", { verdict: "pass", headSha: FULL });
    expect(done.phase).toBe("integration");
  });
});

describe("round 2: the merge gate is reachable in normal flows", async () => {
  async function toAccepted(id: string): Promise<void> {
    await toReview(id);
    claimNext(db, "rev");
    recordReview(db, id, "rev", { verdict: "pass", headSha: FULL });
    claimTask(db, id, "integ");
    submitPhase(db, id, "integ");
    acceptTask(db, id, "integ");
  }

  test("ISH-1138: an accepted (done) task whose PR merges later gets merged_at within one poll interval", async () => {
    process.env.RELAY_PROVIDER_POLL_MS = "60000";
    const t = intakeTask(db, {
      provider: "github", issueId: "o/r#40", codeChange: true, headSha: FULL, checks: [CHECK],
      prUrl: "https://github.com/o/r/pull/1", prRepo: "o/r",
    });
    await toAccepted(t.id);
    expect(getTask(db, t.id)!.state).toBe("done");
    expect(getTask(db, t.id)!.merged_at).toBeNull();
    // ISH-1138: accept-before-merge is the one terminal poll candidate.
    expect(providerBoundTasks(db).some((x) => x.id === t.id)).toBe(true);

    const gh = new FakeGitHub();
    gh.putPullRequest(githubViewAt(1, FULL, "open"));
    let calls = 0;
    const counting: GitHubReadOnly = {
      name: "counting",
      readOnly: true,
      getPullRequest: (ref) => {
        calls++;
        return gh.getPullRequest(ref);
      },
      findPullRequestForBranch: (repo, branch) => gh.findPullRequestForBranch(repo, branch),
      listComments: (ref) => gh.listComments(ref),
    };

    // First poll: still open. It spends exactly one read and starts the interval.
    await reconcileProviderBound(db, { github: counting });
    expect(calls).toBe(1);
    expect(getTask(db, t.id)!.merged_at).toBeNull();
    expect(getTask(db, t.id)!.provider_polled_at).not.toBeNull();

    // Inside the interval: bounded, no second read.
    await reconcileProviderBound(db, { github: counting });
    expect(calls).toBe(1);

    // The PR merges after the interval: the next poll records merged_at and the
    // Task leaves the poll set for good.
    db.query(`UPDATE tasks SET provider_polled_at = ? WHERE id = ?`).run(Date.now() - 60_001, t.id);
    gh.putPullRequest(githubViewAt(1, FULL, "merged"));
    const actions = await reconcileProviderBound(db, { github: counting });
    expect(calls).toBe(2);
    expect(actions).toContain(`merged:${t.id}`);
    expect(getTask(db, t.id)!.merged_at).not.toBeNull();
    expect(providerBoundTasks(db).some((x) => x.id === t.id)).toBe(false);

    // Once merged_at is set it issues zero further reads, even when due.
    db.query(`UPDATE tasks SET provider_polled_at = NULL WHERE id = ?`).run(t.id);
    await reconcileProviderBound(db, { github: counting });
    expect(calls).toBe(2);
  });

  test("ISH-1138: a done Task with merged_at set issues zero provider calls", async () => {
    const t = intakeTask(db, {
      provider: "github", issueId: "o/r#42", codeChange: true, headSha: FULL, checks: [CHECK],
      prUrl: "https://github.com/o/r/pull/4", prRepo: "o/r",
    });
    await toAccepted(t.id);
    confirmMerged(db, t.id, { headSha: FULL, repo: "o/r", actor: "provider:github" });
    expect(getTask(db, t.id)!.state).toBe("done");
    expect(getTask(db, t.id)!.merged_at).not.toBeNull();
    expect(providerBoundTasks(db).some((x) => x.id === t.id)).toBe(false);

    let calls = 0;
    const gh: GitHubReadOnly = {
      name: "counting",
      readOnly: true,
      getPullRequest: () => {
        calls++;
        return githubViewAt(4, FULL, "merged");
      },
      findPullRequestForBranch: () => null,
      listComments: () => [],
    };
    const actions = await reconcileProviderBound(db, { github: gh });
    expect(calls).toBe(0);
    expect(actions).toEqual([]);
  });

  test("ISH-1138: a done Task whose PR is closed leaves the poll set for good", async () => {
    const t = intakeTask(db, {
      provider: "github", issueId: "o/r#43", codeChange: true, headSha: FULL, checks: [CHECK],
      prUrl: "https://github.com/o/r/pull/5", prRepo: "o/r",
    });
    await toAccepted(t.id);
    expect(getTask(db, t.id)!.merged_at).toBeNull();
    expect(providerBoundTasks(db).some((x) => x.id === t.id)).toBe(true);

    const gh = new FakeGitHub();
    gh.putPullRequest(githubViewAt(5, FULL, "closed"));
    let calls = 0;
    const counting: GitHubReadOnly = {
      name: "counting",
      readOnly: true,
      getPullRequest: (ref) => {
        calls++;
        return gh.getPullRequest(ref);
      },
      findPullRequestForBranch: (repo, branch) => gh.findPullRequestForBranch(repo, branch),
      listComments: (ref) => gh.listComments(ref),
    };

    const actions = await reconcileProviderBound(db, { github: counting });
    expect(calls).toBe(1);
    expect(actions).toContain(`pr-closed:${t.id}`);
    expect(getTask(db, t.id)!.merged_at).toBeNull();
    expect(getTask(db, t.id)!.pr_settled_at).not.toBeNull();
    expect(providerBoundTasks(db).some((x) => x.id === t.id)).toBe(false);

    await reconcileProviderBound(db, { github: counting });
    expect(calls).toBe(1);
  });

  test("ISH-1138: a done Task whose PR merged at another head leaves the poll set", async () => {
    process.env.RELAY_PROVIDER_POLL_MS = "60000";
    const t = intakeTask(db, {
      provider: "github", issueId: "o/r#44", codeChange: true, headSha: FULL, checks: [CHECK],
      prUrl: "https://github.com/o/r/pull/6", prRepo: "o/r",
    });
    await toAccepted(t.id);
    expect(getTask(db, t.id)!.merged_at).toBeNull();
    expect(providerBoundTasks(db).some((x) => x.id === t.id)).toBe(true);

    // The PR merged at MOVED, a head the accepted Task does not record. That
    // merge can never be credited; the poll must not re-read it forever.
    const gh = new FakeGitHub();
    gh.putPullRequest(githubViewAt(6, MOVED, "merged"));
    let calls = 0;
    const counting: GitHubReadOnly = {
      name: "counting",
      readOnly: true,
      getPullRequest: (ref) => {
        calls++;
        return gh.getPullRequest(ref);
      },
      findPullRequestForBranch: (repo, branch) => gh.findPullRequestForBranch(repo, branch),
      listComments: (ref) => gh.listComments(ref),
    };

    const actions = await reconcileProviderBound(db, { github: counting });
    expect(calls).toBe(1);
    expect(actions).toContain(`merge-not-credited:${t.id}`);
    expect(actions).toContain(`pr-merge-settled:${t.id}`);
    expect(getTask(db, t.id)!.merged_at).toBeNull();
    expect(getTask(db, t.id)!.pr_settled_at).not.toBeNull();
    expect(providerBoundTasks(db).some((x) => x.id === t.id)).toBe(false);

    // The settlement is durable: even a due poll spends zero further reads.
    db.query(`UPDATE tasks SET provider_polled_at = NULL WHERE id = ?`).run(t.id);
    await reconcileProviderBound(db, { github: counting });
    expect(calls).toBe(1);
  });

  test("ISH-1138: a PR closed during review is not tombstoned, so a later accept still gets merged_at", async () => {
    process.env.RELAY_PROVIDER_POLL_MS = "0";
    const t = intakeTask(db, {
      provider: "github", issueId: "o/r#45", codeChange: true, headSha: FULL, checks: [CHECK],
      prUrl: "https://github.com/o/r/pull/7", prRepo: "o/r",
    });
    await toReview(t.id);
    expect(getTask(db, t.id)!.state).toBe("review");

    const gh = new FakeGitHub();
    gh.putPullRequest(githubViewAt(7, FULL, "closed"));
    let calls = 0;
    const counting: GitHubReadOnly = {
      name: "counting",
      readOnly: true,
      getPullRequest: (ref) => {
        calls++;
        return gh.getPullRequest(ref);
      },
      findPullRequestForBranch: (repo, branch) => gh.findPullRequestForBranch(repo, branch),
      listComments: (ref) => gh.listComments(ref),
    };

    // Closed while the Task is NOT accepted: a review/merge_ready PR can be
    // reopened, so no tombstone may be written here.
    await reconcileProviderBound(db, { github: counting });
    expect(calls).toBe(1);
    expect(getTask(db, t.id)!.pr_settled_at).toBeNull();
    expect(providerBoundTasks(db).some((x) => x.id === t.id)).toBe(true);

    // Reopen, review PASS, accept — then the merge still lands.
    gh.putPullRequest(githubViewAt(7, FULL, "open"));
    claimNext(db, "rev");
    recordReview(db, t.id, "rev", { verdict: "pass", headSha: FULL });
    claimTask(db, t.id, "integ");
    submitPhase(db, t.id, "integ");
    acceptTask(db, t.id, "integ");
    expect(getTask(db, t.id)!.state).toBe("done");
    expect(getTask(db, t.id)!.merged_at).toBeNull();
    expect(providerBoundTasks(db).some((x) => x.id === t.id)).toBe(true);

    gh.putPullRequest(githubViewAt(7, FULL, "merged"));
    db.query(`UPDATE tasks SET provider_polled_at = NULL WHERE id = ?`).run(t.id);
    const actions = await reconcileProviderBound(db, { github: counting });
    expect(actions).toContain(`merged:${t.id}`);
    expect(getTask(db, t.id)!.merged_at).not.toBeNull();
  });

  test("merge -> accept: a merge observed in integration is credited, accept still completes", async () => {
    const t = intakeTask(db, {
      provider: "github", issueId: "o/r#41", codeChange: true, headSha: FULL, checks: [CHECK],
      prUrl: "https://github.com/o/r/pull/2", prRepo: "o/r",
    });
    await toReview(t.id);
    claimNext(db, "rev");
    recordReview(db, t.id, "rev", { verdict: "pass", headSha: FULL });
    expect(getTask(db, t.id)!.phase).toBe("integration");

    const gh = new FakeGitHub();
    gh.putPullRequest(githubViewAt(2, FULL, "merged"));
    const actions = await reconcileTaskFromProvider(db, t.id, { github: gh });
    expect(actions.some((a) => a.kind === "merged")).toBe(true);
    expect(getTask(db, t.id)!.merged_at).not.toBeNull();

    claimTask(db, t.id, "integ");
    submitPhase(db, t.id, "integ");
    const done = acceptTask(db, t.id, "integ");
    expect(done.state).toBe("done");
    expect(codeChangeGateSatisfied(done)).toBe(true);
  });

  test("linear + PR: a Linear-intaken task's GitHub merge is observed", async () => {
    const t = intakeTask(db, {
      provider: "linear", issueId: "ISH-2001", codeChange: true, headSha: FULL, checks: [CHECK],
      prUrl: "https://github.com/o/r/pull/3", prRepo: "o/r",
    });
    await toReview(t.id);
    claimNext(db, "rev");
    recordReview(db, t.id, "rev", { verdict: "pass", headSha: FULL });
    claimTask(db, t.id, "integ");
    submitPhase(db, t.id, "integ");

    const gh = new FakeGitHub();
    gh.putPullRequest(githubViewAt(3, FULL, "merged"));
    const lin = new FakeLinear();
    lin.putIssue({ id: "ISH-2001", state: "In Progress", labels: [], updatedAt: "2026-01-01T00:00:00Z" });
    const actions = await reconcileTaskFromProvider(db, t.id, { github: gh, linear: lin });
    expect(actions.some((a) => a.kind === "merged")).toBe(true);
    expect(getTask(db, t.id)!.merged_at).not.toBeNull();
  });

  test("merge_not_credited is logged once per (task, head)", async () => {
    const t = intakeTask(db, {
      provider: "github", issueId: "o/r#42", codeChange: true, headSha: FULL, checks: [CHECK],
      prUrl: "https://github.com/o/r/pull/4", prRepo: "o/r",
    });
    await toReview(t.id); // state review: a merge is not credited yet
    const gh = new FakeGitHub();
    gh.putPullRequest(githubViewAt(4, FULL, "merged"));
    for (let i = 0; i < 3; i++) {
      db.query(`UPDATE tasks SET pr_updated_at = NULL WHERE id = ?`).run(t.id);
      await reconcileTaskFromProvider(db, t.id, { github: gh });
    }
    const n = db
      .query(`SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'workflow.merge_not_credited'`)
      .get(t.id) as { n: number };
    expect(n.n).toBe(1);
  });
});

describe("round 2: provider polling is throttled and comment fetch is change-gated", async () => {
  function countingGitHub(view: () => PrView) {
    const calls = { pr: 0, comments: 0 };
    const gh: GitHubReadOnly = {
      name: "counting",
      readOnly: true,
      getPullRequest: () => {
        calls.pr++;
        return view();
      },
      findPullRequestForBranch: () => null,
      listComments: () => {
        calls.comments++;
        return [];
      },
    };
    return { gh, calls };
  }

  test("reconcileProviderBound skips a recently-polled task", async () => {
    const t = intakeTask(db, {
      provider: "github", issueId: "o/r#50", codeChange: true, headSha: FULL, checks: [CHECK],
      prUrl: "https://github.com/o/r/pull/5", prRepo: "o/r",
    });
    await toReview(t.id);
    const { gh, calls } = countingGitHub(() => githubViewAt(5, FULL));
    await reconcileProviderBound(db, { github: gh });
    const afterFirst = calls.pr;
    expect(afterFirst).toBeGreaterThan(0);
    await reconcileProviderBound(db, { github: gh });
    expect(calls.pr).toBe(afterFirst); // throttled: no second poll
    // With the throttle disabled, the next poll runs.
    process.env.RELAY_PROVIDER_POLL_MS = "0";
    await reconcileProviderBound(db, { github: gh });
    expect(calls.pr).toBeGreaterThan(afterFirst);
  });

  test("comments are fetched only when the PR updatedAt/head moves", async () => {
    const t = intakeTask(db, {
      provider: "github", issueId: "o/r#51", codeChange: true, headSha: FULL, checks: [CHECK],
      prUrl: "https://github.com/o/r/pull/6", prRepo: "o/r",
    });
    await toReview(t.id);
    let updatedAt = "2026-01-01T00:00:00Z";
    const { gh, calls } = countingGitHub(() => githubViewAt(6, FULL, "open", updatedAt));
    await reconcileTaskFromProvider(db, t.id, { github: gh });
    expect(calls.comments).toBe(1); // first fetch
    await reconcileTaskFromProvider(db, t.id, { github: gh });
    expect(calls.comments).toBe(1); // unchanged -> no fetch
    updatedAt = "2026-01-02T00:00:00Z";
    await reconcileTaskFromProvider(db, t.id, { github: gh });
    expect(calls.comments).toBe(2); // moved -> fetch again
  });
});

describe("round 3: a marker posted before review survives a pre-review poll", async () => {
  function okMarkerComment() {
    return [
      {
        author: "claude",
        createdAt: "2026-01-01T00:00:00Z",
        body: `<!-- ishiul-review head=${FULL} verdict=OK reviewer=claude -->`,
      },
    ];
  }

  test("poll in verify does not consume the watermark; the marker applies in review", async () => {
    const t = intakeTask(db, {
      provider: "github", issueId: "o/r#60", codeChange: true, headSha: FULL, checks: [CHECK],
      prUrl: "https://github.com/o/r/pull/7", prRepo: "o/r",
    });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl", { headSha: FULL });
    expect(getTask(db, t.id)!.phase).toBe("verify");

    // The reviewer already marked the pushed head (updatedAt=u2) BEFORE the task
    // reached review (e.g. before `relay result submit`, or mid-verify).
    const gh = new FakeGitHub();
    gh.putPullRequest(githubViewAt(7, FULL, "open", "u2"));
    gh.putComments({ repo: "o/r", number: 7 }, okMarkerComment());

    // Poll while in verify: the comment scan does NOT run, so the watermark must
    // NOT advance (otherwise the marker is silently consumed).
    await reconcileTaskFromProvider(db, t.id, { github: gh });
    expect(getTask(db, t.id)!.pr_updated_at).toBeNull();
    expect(getTask(db, t.id)!.phase).toBe("verify");

    await mechanical(t.id, "pass");
    expect(getTask(db, t.id)!.phase).toBe("review");

    // Three polls with the SAME PR unchanged: the marker must be read and applied.
    for (let i = 0; i < 3; i++) await reconcileTaskFromProvider(db, t.id, { github: gh });
    expect(getTask(db, t.id)!.phase).toBe("integration");
  });

  test("the watermark advances once the comment scan actually runs", async () => {
    const t = intakeTask(db, {
      provider: "github", issueId: "o/r#61", codeChange: true, headSha: FULL, checks: [CHECK],
      prUrl: "https://github.com/o/r/pull/8", prRepo: "o/r",
    });
    await toReview(t.id);
    const gh = new FakeGitHub();
    gh.putPullRequest(githubViewAt(8, FULL, "open", "u5"));
    gh.putComments({ repo: "o/r", number: 8 }, []); // no marker yet
    await reconcileTaskFromProvider(db, t.id, { github: gh });
    expect(getTask(db, t.id)!.pr_updated_at).toBe("u5"); // scanned -> watermark set
    expect(getTask(db, t.id)!.phase).toBe("review");
  });
});

describe("round 4: a transient comment-read failure must not consume the watermark", async () => {
  class FlakyGitHub implements GitHubReadOnly {
    readonly name = "flaky";
    readonly readOnly = true as const;
    failComments = 0;
    constructor(private inner: FakeGitHub) {}
    getPullRequest(ref: Parameters<GitHubReadOnly["getPullRequest"]>[0]) {
      return this.inner.getPullRequest(ref);
    }
    findPullRequestForBranch(repo: string, branch: string) {
      return this.inner.findPullRequestForBranch(repo, branch);
    }
    listComments(ref: Parameters<GitHubReadOnly["listComments"]>[0]) {
      if (this.failComments > 0) {
        this.failComments--;
        return null; // a transient gh api failure
      }
      return this.inner.listComments(ref);
    }
  }

  test("a gh api failure during the review scan is retried, not lost", async () => {
    const t = intakeTask(db, {
      provider: "github", issueId: "o/r#70", codeChange: true, headSha: FULL, checks: [CHECK],
      prUrl: "https://github.com/o/r/pull/10", prRepo: "o/r",
    });
    await toReview(t.id);
    expect(getTask(db, t.id)!.pr_updated_at).toBeNull();

    const inner = new FakeGitHub();
    inner.putPullRequest(githubViewAt(10, FULL, "open", "u2"));
    inner.putComments({ repo: "o/r", number: 10 }, [
      { author: "claude", createdAt: "2026-01-01T00:00:00Z", body: `<!-- ishiul-review head=${FULL} verdict=OK reviewer=claude -->` },
    ]);
    const gh = new FlakyGitHub(inner);
    gh.failComments = 1;

    // The one scan in review fails: the watermark must NOT be consumed.
    await reconcileTaskFromProvider(db, t.id, { github: gh });
    expect(getTask(db, t.id)!.pr_updated_at).toBeNull();
    expect(getTask(db, t.id)!.phase).toBe("review");

    // Once the read recovers, the marker is applied.
    for (let i = 0; i < 3; i++) await reconcileTaskFromProvider(db, t.id, { github: gh });
    expect(getTask(db, t.id)!.phase).toBe("integration");
  });
});

// ISH-808 round 2: a cancelled code-change task is CLOSED. Every workflow entry
// point checks isTerminalTaskState, so none of them can move it back to
// queued/verify/review or park it blocked_human.
describe("ISH-808: a cancelled code-change task cannot be advanced", async () => {
  /** intake -> claim -> submit, leaving the task at phase=verify. */
  function toVerify(issue: string): string {
    const t = intakeTask(db, { provider: "github", issueId: issue, codeChange: true, headSha: FULL, checks: [CHECK] });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl");
    expect(getTask(db, t.id)!.phase).toBe("verify");
    return t.id;
  }

  test("runMechanicalVerification refuses a cancelled task (never quietBlocks it)", async () => {
    const id = toVerify("o/r#808a");
    cancelTask(db, id, "w", "superseded");
    await expect(mechanical(id, "pass")).rejects.toThrow(/terminal/);
    // Stays cancelled: the NOT_RUN path never parks it blocked_human.
    expect(getTask(db, id)!.state).toBe("cancelled");
  });

  test("submitPhase refuses a cancelled task", async () => {
    const t = intakeTask(db, { provider: "github", issueId: "o/r#808b", codeChange: true, headSha: FULL, checks: [CHECK] });
    claimTask(db, t.id, "impl");
    cancelTask(db, t.id, "w", "duplicate");
    expect(() => submitPhase(db, t.id, "impl")).toThrow(/terminal/);
    expect(getTask(db, t.id)!.state).toBe("cancelled");
  });

  test("recordVerification refuses a cancelled task", async () => {
    const id = toVerify("o/r#808c");
    cancelTask(db, id, "w", "obsolete");
    expect(() => recordVerification(db, id, "impl", { passed: true, headSha: FULL })).toThrow(/terminal/);
    expect(getTask(db, id)!.state).toBe("cancelled");
  });

  test("acceptTask refuses a cancelled merge_ready task (never -> done)", async () => {
    const t = intakeTask(db, {
      provider: "github", issueId: "o/r#808d", codeChange: true, headSha: FULL, checks: [CHECK],
      prUrl: "https://github.com/o/r/pull/808", prRepo: "o/r",
    });
    await toReview(t.id);
    claimNext(db, "rev");
    recordReview(db, t.id, "rev", { verdict: "pass", headSha: FULL });
    claimTask(db, t.id, "integ");
    submitPhase(db, t.id, "integ");
    expect(getTask(db, t.id)!.phase).toBe("merge_ready");

    cancelTask(db, t.id, "w", "program closed");
    expect(() => acceptTask(db, t.id, "integ")).toThrow(/terminal/);
    expect(getTask(db, t.id)!.state).toBe("cancelled");
  });

  test("confirmMerged refuses a cancelled task", async () => {
    const id = toVerify("o/r#808e");
    cancelTask(db, id, "w", "superseded");
    expect(() => confirmMerged(db, id, { headSha: FULL })).toThrow(/cannot confirm a merge/);
    expect(getTask(db, id)!.state).toBe("cancelled");
  });

  test("quietBlock refuses a cancelled task", async () => {
    const id = toVerify("o/r#808f");
    cancelTask(db, id, "w", "superseded");
    const live = getTask(db, id)!;
    expect(() => quietBlock(db, live, "late hold", "provider:linear")).toThrow(/terminal/);
    expect(getTask(db, id)!.state).toBe("cancelled");
  });
});

describe("ISH-1129: shutdown interrupts the provider poll between Tasks", () => {
  test("an aborted signal stops after the in-flight Task and leaves no partial link/throttle write", async () => {
    const N = 60;
    for (let i = 0; i < N; i++) {
      intakeTask(db, {
        provider: "test",
        issueId: `ISH-1129-BETWEEN-${i}`,
        codeChange: true,
        prUrl: `https://github.com/o/r/pull/${2000 + i}`,
      });
    }
    // ISH-1132: the poll only considers a live Run or review/merge_ready/
    // integration. These fixtures have no Run, so put them in review.
    db.query(`UPDATE tasks SET phase = 'review', state = 'review' WHERE provider = 'test'`).run();
    const ac = new AbortController();
    let calls = 0;
    const gh: GitHubReadOnly = {
      name: "abort-fake",
      readOnly: true as const,
      getPullRequest() {
        calls++;
        ac.abort(); // SIGTERM arrives inside the first provider command
        return null;
      },
      findPullRequestForBranch: () => null,
      listComments: () => [],
    };

    const actions = await reconcileProviderBound(db, { github: gh, signal: ac.signal });
    expect(calls).toBe(1);
    expect(actions).toEqual([]);
    // The aborted read is NOT a poll: no throttle and no link/head update.
    const rows = db
      .query(`SELECT head_sha, pr_repo, provider_polled_at FROM tasks WHERE provider = 'test'`)
      .all() as { head_sha: string | null; pr_repo: string | null; provider_polled_at: number | null }[];
    expect(rows).toHaveLength(N);
    for (const r of rows) {
      expect(r.head_sha).toBeNull();
      expect(r.pr_repo).toBeNull();
      expect(r.provider_polled_at).toBeNull();
    }
  });
});
