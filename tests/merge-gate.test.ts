import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { claimTask, getTask } from "../src/tasks";
import { registerWorker } from "../src/workers";
import { intakeTask, recordReview, recordVerification, submitPhase } from "../src/workflow";
import {
  DEFAULT_REVIEW_OWNER,
  FakeGitHub,
  rollupChecks,
  type CheckRunView,
  type PrView,
  type ProviderAuthority,
} from "../src/providers";
import { GhCliGitHub, mapCheckRunBucket, mapCommitStatusBucket, type Exec } from "../src/provider-adapters";
import { processWorkflow } from "../src/workflow-driver";
import {
  boundPrRef,
  checkMergeGate,
  evaluateMergeGate,
  gatherMergeGateInput,
  mergeGateCandidates,
  mergeGateDecisionLogged,
  raiseIntegrationRequired,
  runMergeGates,
  type MergeGateInput,
} from "../src/merge-gate";

// ISH-761: the read-only, HEAD-bound merge gate. The decision table is a pure
// function of observable state; the integration tests drive a real SQLite task
// to merge_ready and read a READ-ONLY FakeGitHub (no network, no provider write).

const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const BASE = "0".repeat(40);
const GRANT: ProviderAuthority = { githubWrite: false, linearWrite: false, merge: true };

function view(over: Partial<PrView> = {}): PrView {
  return {
    ref: { repo: "o/r", number: 1 },
    url: "https://github.com/o/r/pull/1",
    state: "open",
    isDraft: false,
    headRefName: "feat/x",
    headSha: HEAD,
    baseRef: "main",
    baseSha: BASE,
    mergeable: "mergeable",
    labels: [],
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const CHECKS: CheckRunView[] = [
  { name: "typecheck", bucket: "pass" },
  { name: "test", bucket: "pass" },
];

function base(over: Partial<MergeGateInput> = {}): MergeGateInput {
  return {
    taskId: "T1",
    head: HEAD,
    attempt: 0,
    codeChange: true,
    phase: "merge_ready",
    state: "queued",
    merged: false,
    pr: view(),
    prRead: "ok",
    review: { workerId: "rev", head: HEAD, reviewer: "claude" },
    submitter: "impl",
    unresolvedNgId: null,
    prBase: "main",
    hold: null,
    checks: { total: 2, passed: 2, pending: [], failing: [], skipped: [], requiredPassed: true },
    unmetDependencies: [],
    authority: GRANT,
    draftRetained: false,
    ...over,
  };
}

const codes = (i: Partial<MergeGateInput>): string[] =>
  evaluateMergeGate(base(i)).reasons.map((r) => r.code).sort();

describe("merge gate: the READY / BLOCKED decision table (pure)", () => {
  test("an independent PASS at the current HEAD + evidence + permission -> READY", () => {
    const d = evaluateMergeGate(base());
    expect(d.status).toBe("READY");
    expect(d.reasons).toEqual([]);
    expect(d.action).toBe("merge");
    expect(d.identity).toContain(`:${HEAD}:0:READY:ok`);
  });

  test("an old HEAD -> BLOCKED HEAD_MOVED (a PASS cannot survive a moved HEAD)", () => {
    const d = evaluateMergeGate(base({ head: HEAD, pr: view({ headSha: MOVED }) }));
    expect(d.status).toBe("BLOCKED");
    expect(d.reasons.map((r) => r.code)).toContain("HEAD_MOVED");
  });

  test("a same-HEAD unresolved NG -> BLOCKED UNRESOLVED_NG (a later OK alone does not clear it)", () => {
    expect(codes({ unresolvedNgId: 7 })).toContain("UNRESOLVED_NG");
  });

  test("a no-PR task -> BLOCKED NO_PR", () => {
    expect(codes({ pr: null, prRead: "unbound" })).toContain("NO_PR");
  });

  test("an unreadable provider -> BLOCKED PROVIDER_UNREADABLE (unknown != ready)", () => {
    expect(codes({ pr: null, prRead: "error" })).toContain("PROVIDER_UNREADABLE");
  });

  test("a draft -> BLOCKED PR_DRAFT; an owner-retained draft reports it as intentional", () => {
    const plain = evaluateMergeGate(base({ pr: view({ isDraft: true }) }));
    expect(plain.reasons.map((r) => r.code)).toContain("PR_DRAFT");
    expect(plain.action).toBe("none");
    const retained = evaluateMergeGate(base({ pr: view({ isDraft: true, labels: ["draft-retained"] }), draftRetained: true }));
    expect(retained.reasons.find((r) => r.code === "PR_DRAFT")?.message).toContain("retain");
  });

  test("a closed PR -> BLOCKED PR_NOT_OPEN", () => {
    expect(codes({ pr: view({ state: "closed" }) })).toContain("PR_NOT_OPEN");
  });

  test("a missing review -> BLOCKED REVIEW_MISSING", () => {
    expect(codes({ review: null })).toContain("REVIEW_MISSING");
  });

  test("a review at another head -> BLOCKED REVIEW_STALE", () => {
    expect(codes({ review: { workerId: "rev", head: MOVED, reviewer: "claude" } })).toContain("REVIEW_STALE");
  });

  test("a reviewer that authored the attempt -> BLOCKED REVIEW_NOT_INDEPENDENT", () => {
    expect(codes({ submitter: "rev" })).toContain("REVIEW_NOT_INDEPENDENT");
  });

  test("an owner HOLD (Linear or a PR label) -> BLOCKED HOLD", () => {
    expect(codes({ hold: "linear:Hold [hold]" })).toContain("HOLD");
    expect(codes({ hold: "github-label:do-not-merge" })).toContain("HOLD");
  });

  test("an unrun required gate -> BLOCKED CHECKS_NOT_RUN (and it is never a PASS)", () => {
    expect(codes({ checks: null })).toContain("CHECKS_NOT_RUN");
    expect(codes({ checks: { total: 0, passed: 0, pending: [], failing: [], skipped: [], requiredPassed: false } })).toContain(
      "CHECKS_NOT_RUN"
    );
  });

  test("a failing / pending required check -> BLOCKED CHECKS_NOT_PASSED", () => {
    const fail = { total: 1, passed: 0, pending: [], failing: ["test"], skipped: [], requiredPassed: false };
    const pending = { total: 1, passed: 0, pending: ["test"], failing: [], skipped: [], requiredPassed: false };
    expect(codes({ checks: fail })).toContain("CHECKS_NOT_PASSED");
    expect(codes({ checks: pending })).toContain("CHECKS_NOT_PASSED");
  });

  test("#2 an all-skipped roll-up -> BLOCKED CHECKS_NOT_RUN (no gate actually ran); a pass+skip mix stays READY", () => {
    const allSkipped = { total: 1, passed: 0, pending: [], failing: [], skipped: ["ci"], requiredPassed: false };
    const d = evaluateMergeGate(base({ checks: allSkipped }));
    expect(d.status).toBe("BLOCKED");
    expect(d.reasons.map((r) => r.code)).toContain("CHECKS_NOT_RUN");
    const mixed = { total: 2, passed: 1, pending: [], failing: [], skipped: ["b"], requiredPassed: true };
    expect(evaluateMergeGate(base({ checks: mixed })).status).toBe("READY");
  });

  test("a conflict -> BLOCKED CONFLICT and action IntegrationRequired (a Gateway routing decision)", () => {
    const d = evaluateMergeGate(base({ pr: view({ mergeable: "conflicting" }) }));
    expect(d.status).toBe("BLOCKED");
    expect(d.reasons.map((r) => r.code)).toContain("CONFLICT");
    expect(d.reasons.find((r) => r.code === "CONFLICT")?.integrationRequired).toBe(true);
    expect(d.action).toBe("IntegrationRequired");
  });

  test("an unresolved mergeability -> BLOCKED MERGEABILITY_UNKNOWN (never assumed mergeable)", () => {
    expect(codes({ pr: view({ mergeable: "unknown" }) })).toContain("MERGEABILITY_UNKNOWN");
  });

  test("an unmet dependency -> BLOCKED DEPENDENCY_UNMET", () => {
    expect(codes({ unmetDependencies: ["T0"] })).toContain("DEPENDENCY_UNMET");
  });

  test("lack of point-of-use permission -> BLOCKED NO_PERMISSION (never merge-ready by mistake)", () => {
    const d = evaluateMergeGate(base({ authority: { githubWrite: false, linearWrite: false, merge: false } }));
    expect(d.status).toBe("BLOCKED");
    expect(d.reasons.map((r) => r.code)).toContain("NO_PERMISSION");
  });

  test("an unrelated merge of another PR (base moved, still mergeable) does NOT force a rebase/review loop", () => {
    // The base SHA differs from any ancestor the review saw, but GitHub reports
    // the PR as mergeable: that alone must NOT block (no unconditional rebase).
    const d = evaluateMergeGate(base({ pr: view({ baseSha: "c".repeat(40), mergeable: "mergeable" }) }));
    expect(d.status).toBe("READY");
  });

  test("a re-fetched merge at the recorded head -> MERGED; at another head -> BLOCKED", () => {
    expect(evaluateMergeGate(base({ merged: true })).status).toBe("MERGED");
    expect(evaluateMergeGate(base({ merged: true, pr: view({ state: "merged", headSha: MOVED }) })).status).toBe("BLOCKED");
  });

  // --- round-2 findings ---------------------------------------------------

  test("#4 a merge Relay will not credit (pre-review / non-code / cancelled) -> BLOCKED MERGE_NOT_CREDITED", () => {
    // Mirrors confirmMerged's postReview guard: implement/review is not credited.
    const early = evaluateMergeGate(base({ merged: true, phase: "implement", state: "queued" }));
    expect(early.status).toBe("BLOCKED");
    expect(early.reasons.map((r) => r.code)).toContain("MERGE_NOT_CREDITED");
    expect(evaluateMergeGate(base({ merged: true, state: "cancelled" })).reasons.map((r) => r.code)).toContain(
      "MERGE_NOT_CREDITED"
    );
    expect(evaluateMergeGate(base({ merged: true, codeChange: false })).status).toBe("BLOCKED");
    // The creditable cases stay MERGED.
    expect(evaluateMergeGate(base({ merged: true, phase: "integration", state: "queued" })).status).toBe("MERGED");
    expect(evaluateMergeGate(base({ merged: true, state: "done" })).status).toBe("MERGED");
  });

  test("#2 a task with no recorded HEAD -> BLOCKED HEAD_UNKNOWN (never bound to head=none)", () => {
    const d = evaluateMergeGate(base({ head: null, review: { workerId: "rev", head: null, reviewer: "rev" } }));
    expect(d.status).toBe("BLOCKED");
    expect(d.reasons.map((r) => r.code)).toContain("HEAD_UNKNOWN");
    // A review that names no head is stale, never a pass.
    expect(evaluateMergeGate(base({ review: { workerId: "rev", head: null, reviewer: "rev" } })).reasons.map((r) => r.code)).toContain(
      "REVIEW_STALE"
    );
  });

  test("#5 a retargeted base branch -> BLOCKED BASE_CHANGED; a base-SHA move alone is not a block", () => {
    const retargeted = evaluateMergeGate(base({ pr: view({ baseRef: "release-1" }) }));
    expect(retargeted.reasons.map((r) => r.code)).toContain("BASE_CHANGED");
    // Same base branch, moved base SHA + still mergeable -> READY (no rebase loop).
    expect(evaluateMergeGate(base({ pr: view({ baseSha: "c".repeat(40) }) })).status).toBe("READY");
    // An unrecorded base is not compared (legacy tasks).
    expect(evaluateMergeGate(base({ prBase: null, pr: view({ baseRef: "release-1" }) })).status).toBe("READY");
  });

  test("a done-but-unmerged task is distinguished from Done -> BLOCKED NOT_MERGED (and TERMINAL for failed/cancelled)", () => {
    expect(codes({ state: "done" })).toContain("NOT_MERGED");
    expect(codes({ state: "cancelled" })).toContain("TERMINAL");
    expect(codes({ state: "failed" })).toContain("TERMINAL");
  });

  test("a non-merge-ready phase or a non-code task -> BLOCKED", () => {
    expect(codes({ phase: "review" })).toContain("NOT_MERGE_READY");
    expect(codes({ codeChange: false })).toContain("NOT_CODE_TASK");
  });

  test("the structured identity changes with the HEAD and the status", () => {
    const a = evaluateMergeGate(base());
    const b = evaluateMergeGate(base({ head: MOVED, pr: view({ headSha: MOVED }) }));
    expect(a.identity).not.toBe(b.identity);
    const blocked = evaluateMergeGate(base({ unresolvedNgId: 1 }));
    expect(blocked.identity).toContain("BLOCKED:UNRESOLVED_NG");
  });
});

describe("check roll-up + the gh adapter mapping", () => {
  test("requiredPassed requires at least one check and no pending/failing", () => {
    expect(rollupChecks([]).requiredPassed).toBe(false);
    expect(rollupChecks([{ name: "a", bucket: "pass" }]).requiredPassed).toBe(true);
    expect(rollupChecks([{ name: "a", bucket: "pending" }]).requiredPassed).toBe(false);
    expect(rollupChecks([{ name: "a", bucket: "fail" }]).requiredPassed).toBe(false);
    expect(rollupChecks([{ name: "a", bucket: "cancel" }]).requiredPassed).toBe(false);
    // A skipped optional job does not, by itself, fail the roll-up...
    expect(rollupChecks([{ name: "a", bucket: "pass" }, { name: "b", bucket: "skipping" }]).requiredPassed).toBe(true);
    // ...but an ALL-skipped roll-up had no gate actually run: it is NOT passed.
    expect(rollupChecks([{ name: "a", bucket: "skipping" }]).requiredPassed).toBe(false);
    expect(rollupChecks([{ name: "a", bucket: "skipping" }, { name: "b", bucket: "skipping" }]).requiredPassed).toBe(false);
  });

  test("check-run + commit-status buckets map to the gh vocabulary", () => {
    expect(mapCheckRunBucket("completed", "success")).toBe("pass");
    expect(mapCheckRunBucket("completed", "neutral")).toBe("pass");
    expect(mapCheckRunBucket("in_progress", "")).toBe("pending");
    expect(mapCheckRunBucket("completed", "failure")).toBe("fail");
    expect(mapCheckRunBucket("completed", "cancelled")).toBe("cancel");
    expect(mapCheckRunBucket("completed", "skipped")).toBe("skipping");
    expect(mapCommitStatusBucket("success")).toBe("pass");
    expect(mapCommitStatusBucket("pending")).toBe("pending");
    expect(mapCommitStatusBucket("error")).toBe("fail");
  });

  test("GhCliGitHub.listChecks is HEAD-pinned, merges check-runs + statuses, and returns null on failure", () => {
    const calls: string[][] = [];
    const exec: Exec = (argv) => {
      calls.push(argv);
      if (argv.some((a) => a.endsWith("/check-runs"))) {
        return {
          ok: true,
          stdout: JSON.stringify({
            check_runs: [
              { name: "typecheck", status: "completed", conclusion: "success" },
              { name: "lint", status: "in_progress", conclusion: null },
            ],
          }),
          stderr: "",
        };
      }
      if (argv.some((a) => a.endsWith("/status"))) {
        return { ok: true, stdout: JSON.stringify({ statuses: [{ context: "ci/legacy", state: "success" }] }), stderr: "" };
      }
      return { ok: false, stdout: "", stderr: "boom" };
    };
    const gh = new GhCliGitHub(exec);
    const checks = gh.listChecks({ repo: "o/r", number: 1 }, HEAD);
    expect(checks).not.toBeNull();
    expect(checks!.map((c) => c.name)).toEqual(["typecheck", "lint", "ci/legacy"]);
    expect(checks!.find((c) => c.name === "lint")!.bucket).toBe("pending");
    // Both reads carry the EXACT head.
    expect(calls.every((argv) => argv.some((a) => a.includes(HEAD)))).toBe(true);

    const failing: Exec = () => ({ ok: false, stdout: "", stderr: "rate limited" });
    expect(new GhCliGitHub(failing).listChecks({ repo: "o/r", number: 1 }, HEAD)).toBeNull();
    // An empty head can never be bound.
    expect(gh.listChecks({ repo: "o/r", number: 1 }, "")).toBeNull();
  });

  test("#1 a one-sided read failure is NOT_RUN, never the other read as the whole picture", () => {
    const runsOnly: Exec = (argv) =>
      argv.some((a) => a.endsWith("/check-runs"))
        ? { ok: false, stdout: "", stderr: "rate limited" }
        : { ok: true, stdout: JSON.stringify({ statuses: [{ context: "ci/legacy", state: "success" }] }), stderr: "" };
    expect(new GhCliGitHub(runsOnly).listChecks({ repo: "o/r", number: 1 }, HEAD)).toBeNull();

    const statusesFail: Exec = (argv) =>
      argv.some((a) => a.endsWith("/check-runs"))
        ? { ok: true, stdout: JSON.stringify({ check_runs: [{ name: "test", status: "completed", conclusion: "success" }] }), stderr: "" }
        : { ok: false, stdout: "", stderr: "rate limited" };
    expect(new GhCliGitHub(statusesFail).listChecks({ repo: "o/r", number: 1 }, HEAD)).toBeNull();

    // An UNPARSEABLE read is also NOT_RUN.
    const badJson: Exec = (argv) =>
      argv.some((a) => a.endsWith("/check-runs"))
        ? { ok: true, stdout: "not json at all", stderr: "" }
        : { ok: true, stdout: JSON.stringify({ statuses: [] }), stderr: "" };
    expect(new GhCliGitHub(badJson).listChecks({ repo: "o/r", number: 1 }, HEAD)).toBeNull();
  });

  test("#1 check runs are paginated: every page is read and a short read is NOT_RUN", () => {
    const pages: string[][] = [];
    const exec: Exec = (argv) => {
      if (argv.some((a) => a.endsWith("/check-runs"))) {
        pages.push(argv);
        // Two concatenated pages (what `gh api --paginate` emits).
        return {
          ok: true,
          stdout:
            JSON.stringify({ total_count: 2, check_runs: [{ name: "a", status: "completed", conclusion: "success" }] }) +
            JSON.stringify({ total_count: 2, check_runs: [{ name: "b", status: "completed", conclusion: "failure" }] }),
          stderr: "",
        };
      }
      return { ok: true, stdout: JSON.stringify({ statuses: [] }), stderr: "" };
    };
    const checks = new GhCliGitHub(exec).listChecks({ repo: "o/r", number: 1 }, HEAD);
    // The failing run on the second page is seen, and --paginate was requested.
    expect(checks!.map((c) => c.name)).toEqual(["a", "b"]);
    expect(checks!.find((c) => c.name === "b")!.bucket).toBe("fail");
    expect(pages[0]).toContain("--paginate");

    // Declared total_count exceeds what was read -> incomplete -> NOT_RUN.
    const short: Exec = (argv) =>
      argv.some((a) => a.endsWith("/check-runs"))
        ? { ok: true, stdout: JSON.stringify({ total_count: 31, check_runs: [{ name: "a", status: "completed", conclusion: "success" }] }), stderr: "" }
        : { ok: true, stdout: JSON.stringify({ statuses: [] }), stderr: "" };
    expect(new GhCliGitHub(short).listChecks({ repo: "o/r", number: 1 }, HEAD)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

let dir = "";
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-ish761-"));
  process.env.RELAY_DB = join(dir, "state.db");
  process.env.RELAY_LEASE_MS = "120000";
  db = openDb(process.env.RELAY_DB);
  registerWorker(db, "impl", { role: "worker" });
  registerWorker(db, "rev", { role: "reviewer" });
  registerWorker(db, "integ", { role: "integrator" });
});

afterEach(() => {
  delete process.env.RELAY_HUMAN;
  delete process.env.RELAY_PROVIDER_POLL_MS;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Drive a task implement -> review -> merge_ready with a real passing review at HEAD. */
function toMergeReady(id: string): void {
  claimTask(db, id, "impl");
  submitPhase(db, id, "impl", { headSha: HEAD });
  claimTask(db, id, "impl"); // verify phase (manual, no mechanical checks)
  recordVerification(db, id, "impl", { passed: true, headSha: HEAD });
  recordReview(db, id, "rev", { verdict: "pass", headSha: HEAD });
  claimTask(db, id, "integ");
  submitPhase(db, id, "integ", { headSha: HEAD });
}

function intake(id: string, over: { prUrl?: string } = {}) {
  return intakeTask(db, {
    provider: "github",
    issueId: id,
    codeChange: true,
    headSha: HEAD,
    prUrl: over.prUrl ?? "https://github.com/o/r/pull/1",
    prRepo: "o/r",
    branch: "feat/x",
  });
}

describe("merge gate: gathering the facts + the daemon pass (read-only)", () => {
  test("gather resolves the bound PR, the passing review and the HEAD-pinned checks", () => {
    const gh = new FakeGitHub();
    gh.putPullRequest(view());
    gh.putChecks({ repo: "o/r", number: 1 }, HEAD, CHECKS);
    const t = intake("o/r#1");
    toMergeReady(t.id);

    const input = gatherMergeGateInput(db, t.id, { github: gh, checks: gh, authority: GRANT })!;
    expect(input.prRead).toBe("ok");
    expect(input.head).toBe(HEAD);
    expect(input.review?.head).toBe(HEAD);
    expect(input.checks?.requiredPassed).toBe(true);
    expect(evaluateMergeGate(input).status).toBe("READY");
    expect(checkMergeGate(db, t.id, { github: gh, checks: gh, authority: GRANT })!.status).toBe("READY");
  });

  test("without a check reader the checks are NOT_RUN (BLOCKED, never assumed green)", () => {
    const gh = new FakeGitHub();
    gh.putPullRequest(view());
    const t = intake("o/r#2");
    toMergeReady(t.id);
    const d = checkMergeGate(db, t.id, { github: gh, authority: GRANT })!;
    expect(d.status).toBe("BLOCKED");
    expect(d.reasons.map((r) => r.code)).toContain("CHECKS_NOT_RUN");
  });

  test("a Linear HOLD is a structured block", () => {
    const gh = new FakeGitHub();
    gh.putPullRequest(view());
    gh.putChecks({ repo: "o/r", number: 1 }, HEAD, CHECKS);
    const t = intakeTask(db, { provider: "linear", issueId: "ISH-1", codeChange: true, headSha: HEAD, prUrl: "https://github.com/o/r/pull/1", prRepo: "o/r", branch: "feat/x" });
    toMergeReady(t.id);
    const lin = { name: "fake", readOnly: true as const, getIssue: () => ({ id: "ISH-1", state: "In Progress", labels: ["hold"], updatedAt: "" }) };
    const d = checkMergeGate(db, t.id, { github: gh, checks: gh, linear: lin, authority: GRANT })!;
    expect(d.reasons.map((r) => r.code)).toContain("HOLD");
  });

  test("a conflict raises IntegrationRequired ONCE per (task, head), never merging", () => {
    const gh = new FakeGitHub();
    gh.putPullRequest(view({ mergeable: "conflicting" }));
    gh.putChecks({ repo: "o/r", number: 1 }, HEAD, CHECKS);
    const t = intake("o/r#3");
    toMergeReady(t.id);

    const first = runMergeGates(db, { github: gh, checks: gh, authority: GRANT }).find((r) => r.decision.taskId === t.id)!;
    expect(first.decision.action).toBe("IntegrationRequired");
    expect(first.integrationRaised).toBe(true);
    expect(first.logged).toBe(true);
    // The task itself is untouched by the gate (a routing decision, not a mutation).
    expect(getTask(db, t.id)!.phase).toBe("merge_ready");

    const second = runMergeGates(db, { github: gh, checks: gh, authority: GRANT }).find((r) => r.decision.taskId === t.id)!;
    expect(second.integrationRaised).toBe(false);
    expect(second.logged).toBe(false);
    expect(mergeGateDecisionLogged(db, first.decision.identity)).toBe(true);
  });

  test("a real merge is re-fetched at the recorded head -> MERGED", () => {
    const gh = new FakeGitHub();
    gh.putPullRequest(view({ state: "merged", mergeable: "unknown" }));
    gh.putChecks({ repo: "o/r", number: 1 }, HEAD, CHECKS);
    const t = intake("o/r#4");
    toMergeReady(t.id);
    const d = checkMergeGate(db, t.id, { github: gh, checks: gh, authority: GRANT })!;
    expect(d.status).toBe("MERGED");
    expect(d.action).toBe("none");
  });

  test("mergeGateCandidates includes merge_ready and a done-but-unmerged PR task", () => {
    const t = intake("o/r#5");
    toMergeReady(t.id);
    expect(mergeGateCandidates(db).map((x) => x.id)).toContain(t.id);
    // An internally accepted-but-unmerged task stays a candidate.
    db.query(`UPDATE tasks SET state = 'done', accepted_at = 1 WHERE id = ?`).run(t.id);
    expect(mergeGateCandidates(db).map((x) => x.id)).toContain(t.id);
  });

  test("boundPrRef falls back to a PR found by branch", () => {
    const gh = new FakeGitHub();
    gh.putPullRequest(view({ headRefName: "feat/x" }));
    const t = intakeTask(db, { provider: "github", issueId: "o/r#6", codeChange: true, branch: "feat/x", prRepo: "o/r" });
    expect(boundPrRef(getTask(db, t.id)!, gh)).toEqual({ repo: "o/r", number: 1 });
  });

  test("raiseIntegrationRequired is idempotent and read-only w.r.t. the task", () => {
    const t = intake("o/r#7");
    toMergeReady(t.id);
    const live = getTask(db, t.id)!;
    const a = raiseIntegrationRequired(db, live, HEAD, "conflict with base");
    const b = raiseIntegrationRequired(db, live, HEAD, "conflict with base");
    expect(a.raised).toBe(true);
    expect(b.raised).toBe(false);
    expect(getTask(db, t.id)!.state).toBe(live.state);
    expect(getTask(db, t.id)!.phase).toBe(live.phase);
  });

  test("#3 IntegrationRequired is deduped for a NULL head too (no per-tick spam)", () => {
    const t = intake("o/r#8");
    toMergeReady(t.id);
    // Simulate a task with no recorded head (the #2 trigger).
    db.query(`UPDATE tasks SET head_sha = NULL WHERE id = ?`).run(t.id);
    const a = raiseIntegrationRequired(db, getTask(db, t.id)!, null, "conflict with base");
    const b = raiseIntegrationRequired(db, getTask(db, t.id)!, null, "conflict with base");
    const c = raiseIntegrationRequired(db, getTask(db, t.id)!, null, "conflict with base");
    expect([a.raised, b.raised, c.raised]).toEqual([true, false, false]);
    const events = db
      .query(`SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'workflow.integration_required'`)
      .get(t.id) as { n: number };
    expect(events.n).toBe(1);
  });

  test("#2 a null-head task never reaches READY and its checks stay NOT_RUN", () => {
    const gh = new FakeGitHub();
    gh.putPullRequest(view());
    gh.putChecks({ repo: "o/r", number: 1 }, HEAD, CHECKS);
    // Intake with NO headSha, then drive to merge_ready.
    const t = intakeTask(db, {
      provider: "github",
      issueId: "o/r#9",
      codeChange: true,
      prUrl: "https://github.com/o/r/pull/1",
      prRepo: "o/r",
      branch: "feat/x",
    });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl");
    claimTask(db, t.id, "impl");
    recordVerification(db, t.id, "impl", { passed: true });
    recordReview(db, t.id, "rev", { verdict: "pass" });
    claimTask(db, t.id, "integ");
    submitPhase(db, t.id, "integ");

    const input = gatherMergeGateInput(db, t.id, { github: gh, checks: gh, authority: GRANT })!;
    expect(input.head).toBeNull();
    // Checks are NOT pinned to the live PR head when the recorded head is missing.
    expect(input.checks).toBeNull();
    const d = evaluateMergeGate(input);
    expect(d.status).toBe("BLOCKED");
    expect(d.reasons.map((r) => r.code)).toContain("HEAD_UNKNOWN");
  });

  test("#1 (round-2) a retargeted base branch is caught by the daemon pass, not silently overwritten", async () => {
    process.env.RELAY_PROVIDER_POLL_MS = "0"; // no throttle: the provider pass runs
    const gh = new FakeGitHub();
    // The PR was retargeted to release-1 AFTER the review judged main.
    gh.putPullRequest(view({ baseRef: "release-1" }));
    gh.putChecks({ repo: "o/r", number: 1 }, HEAD, CHECKS);

    const t = intakeTask(db, {
      provider: "github",
      issueId: "o/r#10",
      codeChange: true,
      headSha: HEAD,
      prUrl: "https://github.com/o/r/pull/1",
      prRepo: "o/r",
      branch: "feat/x",
      prBase: "main",
      prBaseSha: BASE,
    });
    toMergeReady(t.id);
    expect(getTask(db, t.id)!.pr_base).toBe("main");

    // Before any daemon pass the gate already blocks on the retargeted base.
    const before = checkMergeGate(db, t.id, { github: gh, checks: gh, authority: GRANT })!;
    expect(before.status).toBe("BLOCKED");
    expect(before.reasons.map((r) => r.code)).toContain("BASE_CHANGED");

    // The provider pass + gate pass run together (as the daemon does).
    const actions = await processWorkflow(db, { github: gh, checks: gh, authority: GRANT });
    // The provider path must NOT silently overwrite the reviewed base and leave
    // the task READY: the base-branch change invalidates the review.
    expect(getTask(db, t.id)!.pr_base).toBe("release-1");
    expect(getTask(db, t.id)!.phase).toBe("review");
    expect(getTask(db, t.id)!.state).toBe("review");
    expect(actions.some((a) => a.startsWith("merge-gate-ready:"))).toBe(false);
    // And afterwards the gate is definitively not READY.
    expect(checkMergeGate(db, t.id, { github: gh, checks: gh, authority: GRANT })!.status).toBe("BLOCKED");
  });

  test("#1 (round-3) a base retarget accepts a FRESH PASS at the same head but not the stale marker", async () => {
    process.env.RELAY_PROVIDER_POLL_MS = "0";
    const ref = { repo: "o/r", number: 1 };
    const gh = new FakeGitHub();
    // The PR was retargeted to release-1 after the review judged main, and an OLD
    // authorized OK marker for the same head sits in the review thread.
    gh.putPullRequest(view({ baseRef: "release-1" }));
    gh.putChecks(ref, HEAD, CHECKS);
    gh.putComments(ref, [
      {
        author: DEFAULT_REVIEW_OWNER,
        createdAt: "2026-01-01T00:00:00Z",
        body: `<!-- ishiul-review head=${HEAD} verdict=OK reviewer=claude -->`,
      },
    ]);

    const t = intakeTask(db, {
      provider: "github",
      issueId: "o/r#11",
      codeChange: true,
      headSha: HEAD,
      prUrl: "https://github.com/o/r/pull/1",
      prRepo: "o/r",
      branch: "feat/x",
      prBase: "main",
      prBaseSha: BASE,
    });
    toMergeReady(t.id); // records a PASS at attempt 0, base "main"

    // Retarget -> the provider pass invalidates the review (attempt 1, SAME head).
    await processWorkflow(db, { github: gh, checks: gh, authority: GRANT, authorizedReviewers: [DEFAULT_REVIEW_OWNER] });
    expect(getTask(db, t.id)!.phase).toBe("review");
    expect(getTask(db, t.id)!.state).toBe("review");
    expect(getTask(db, t.id)!.attempt).toBe(1);
    expect(getTask(db, t.id)!.pr_base).toBe("release-1");

    // The STALE pre-retarget marker alone must NOT re-apply: the task stays in
    // review (without the createdAt filter it would jump back to integration).
    expect(checkMergeGate(db, t.id, { github: gh, checks: gh, authority: GRANT })!.status).not.toBe("READY");

    // A FRESH independent PASS at the SAME head is ACCEPTED (no deadlock)...
    const fresh = recordReview(db, t.id, "rev", { verdict: "pass", headSha: HEAD });
    expect(fresh.phase).toBe("integration");
    claimTask(db, t.id, "integ");
    submitPhase(db, t.id, "integ");
    expect(getTask(db, t.id)!.phase).toBe("merge_ready");
    // ...and the gate is READY again for the retargeted base.
    expect(checkMergeGate(db, t.id, { github: gh, checks: gh, authority: GRANT })!.status).toBe("READY");
  });
});
