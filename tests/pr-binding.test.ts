import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { claimTask, getTask } from "../src/tasks";
import { registerWorker } from "../src/workers";
import { findPassingReview } from "../src/results";
import {
  intakeTask,
  linkTask,
  recordReview,
  runMechanicalVerification,
  submitPhase,
  taskChecks,
} from "../src/workflow";
import { FakeGitHub, reconcileTaskFromProvider, type PrView } from "../src/providers";
import {
  bindTaskPr,
  isFullCommitSha,
  prHeadRepoSafe,
  PR_BINDING_ERROR,
  resolveTaskPrRef,
  sameCommitSha,
} from "../src/pr-binding";

// ISH-880/885: a deterministic fixture for the READ-ONLY Task<->PR check — a
// fake read-only GitHub (in-memory PRs) and the real SQLite task/phase machine.
// No network. Relay never writes to GitHub, so there is no publisher here.

const A = "a".repeat(40);
const B = "b".repeat(40);
const REPO = "81ueman/relay";
const BRANCH = "relay/ish-880";

let dir = "";
let db: Database;
let seq = 0;

function newTask(extra: { prRepo?: string; prUrl?: string; head?: string; branch?: string } = {}): string {
  const id = intakeTask(db, {
    provider: "test",
    issueId: `ISH-880-${seq++}`,
    codeChange: true,
    title: "bind the PR",
    checks: [{ name: "noop", command: "true" }],
    prRepo: extra.prRepo,
    prUrl: extra.prUrl,
    branch: extra.branch,
    headSha: extra.head,
  }).id;
  return id;
}

function prView(headSha: string, over: Partial<PrView> = {}): PrView {
  return {
    ref: { repo: REPO, number: 7 },
    url: `https://github.com/${REPO}/pull/7`,
    state: "open",
    isDraft: false,
    headRefName: BRANCH,
    headSha,
    baseRef: "main",
    baseSha: "0".repeat(40),
    mergeable: "mergeable",
    labels: [],
    updatedAt: "2026-01-01T00:00:00Z",
    isCrossRepository: false,
    headRepo: REPO,
    ...over,
  };
}

/** Drive a task to the review phase with a PASSING review at `head`. */
async function driveToReviewed(id: string, head: string): Promise<void> {
  linkTask(db, id, { branch: BRANCH, headSha: head });
  registerWorker(db, "impl-worker", { role: "worker" });
  claimTask(db, id, "impl-worker");
  submitPhase(db, id, "impl-worker");
  const v = await runMechanicalVerification(db, id, {
    checks: taskChecks(getTask(db, id)!),
    runner: {
      async run(spec) {
        return { name: spec.name, required: true, outcome: "pass", exitCode: 0, output: "ok", durationMs: 0 };
      },
    },
    cwd: dir,
    headSha: head,
    headProbe: () => head,
  });
  expect(v.outcome).toBe("pass");
  recordReview(db, id, "claude", { verdict: "pass", headSha: head, externalReviewer: "claude" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-ish880-"));
  process.env.RELAY_DB = join(dir, "state.db");
  db = openDb(process.env.RELAY_DB);
  seq = 0;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.RELAY_DB;
});

describe("resolveTaskPrRef: identity is EXPLICIT, never a branch name", () => {
  test("needs a recorded pr_url/pr_repo#n", () => {
    expect(resolveTaskPrRef({ pr_url: null, pr_repo: null })).toBeNull();
    expect(resolveTaskPrRef({ pr_url: "81ueman/relay#7", pr_repo: null })).toEqual({ repo: REPO, number: 7 });
    expect(resolveTaskPrRef({ pr_url: null, pr_repo: REPO })).toBeNull();
    expect(resolveTaskPrRef({ pr_url: `${REPO}#12`, pr_repo: REPO })).toEqual({ repo: REPO, number: 12 });
  });
});

describe("bindTaskPr: re-read and bind the produced commit (read-only)", () => {
  test("a recorded PR is re-read and bound to the produced commit", () => {
    const id = newTask({ prRepo: REPO, prUrl: `${REPO}#7`, head: A });
    linkTask(db, id, { branch: BRANCH, headSha: A });
    const gh = new FakeGitHub().putPullRequest(prView(A));

    const r = bindTaskPr(db, id, { github: gh });

    expect(r.status).toBe("bound");
    expect(r.created).toBe(false); // Relay never creates a PR
    expect(r.remoteHead).toBe(A);
    const t = getTask(db, id)!;
    expect(t.pr_url).toBe(`https://github.com/${REPO}/pull/7`);
    expect(t.pr_repo).toBe(REPO);
    expect(t.head_sha).toBe(A);
    expect(t.pr_base).toBe("main");
  });

  test("retry after a crash ADOPTS the existing PR for the (repo, branch) — no duplicate", () => {
    const id = newTask({ prRepo: REPO });
    linkTask(db, id, { branch: BRANCH, headSha: A });
    const gh = new FakeGitHub().putPullRequest(prView(A)); // created by the Agent

    const r = bindTaskPr(db, id, { github: gh });

    expect(r.status).toBe("adopted");
    expect(r.created).toBe(false);
    expect(getTask(db, id)!.pr_url).toBe(`https://github.com/${REPO}/pull/7`);
  });

  test("no recorded identity and no adoptable PR is NO_PR_IDENTITY (Relay never publishes)", () => {
    const id = newTask({ prRepo: REPO });
    linkTask(db, id, { branch: BRANCH, headSha: A });
    const gh = new FakeGitHub().putPullRequest(prView(B)); // a PR on the branch at another head

    const r = bindTaskPr(db, id, { github: gh });

    expect(r.status).toBe("blocked");
    expect(r.reason).toContain("NO_PR_IDENTITY");
    expect(getTask(db, id)!.pr_url).toBeNull();
  });
});

describe("bindTaskPr: fail closed (never a fake review_pass)", () => {
  test("a moved PR head is BLOCKED and never overwrites the recorded head", () => {
    const id = newTask({ prRepo: REPO, prUrl: `${REPO}#7`, head: A });
    linkTask(db, id, { branch: BRANCH, headSha: A });
    const gh = new FakeGitHub().putPullRequest(prView(B));

    const r = bindTaskPr(db, id, { github: gh });

    expect(r.status).toBe("blocked");
    expect(r.reason).toContain(`${PR_BINDING_ERROR}: HEAD_MOVED`);
    const t = getTask(db, id)!;
    expect(t.head_sha).toBe(A); // the recorded commit is untouched
    expect(t.pr_url).toBe(`${REPO}#7`);
  });

  test("a PR in a DIFFERENT repo is BLOCKED", () => {
    const id = newTask({ prRepo: REPO, prUrl: `https://github.com/evil/relay/pull/7`, head: A });
    linkTask(db, id, { branch: BRANCH, headSha: A });
    const gh = new FakeGitHub().putPullRequest(prView(A, { ref: { repo: "evil/relay", number: 7 } }));

    const r = bindTaskPr(db, id, { github: gh });

    expect(r.status).toBe("blocked");
    expect(r.reason).toContain("REPO_CHANGED");
  });

  test("a closed PR is BLOCKED", () => {
    const id = newTask({ prRepo: REPO, prUrl: `${REPO}#7`, head: A });
    linkTask(db, id, { branch: BRANCH, headSha: A });
    const gh = new FakeGitHub().putPullRequest(prView(A, { state: "closed" }));

    const r = bindTaskPr(db, id, { github: gh });

    expect(r.status).toBe("blocked");
    expect(r.reason).toContain("PR_NOT_OPEN");
  });

  test("an unreadable provider is BLOCKED (unknown is never ready)", () => {
    const id = newTask({ prRepo: REPO, prUrl: `${REPO}#7`, head: A });
    linkTask(db, id, { branch: BRANCH, headSha: A });
    expect(bindTaskPr(db, id, {}).reason).toContain("PROVIDER_UNREADABLE");
    // A reader that cannot find the PR is also BLOCKED, not "unbound is fine".
    const r = bindTaskPr(db, id, { github: new FakeGitHub() });
    expect(r.status).toBe("blocked");
    expect(r.reason).toContain("PR_UNREADABLE");
  });

  test("a task with no produced commit cannot bind", () => {
    const id = newTask({ prRepo: REPO });
    const gh = new FakeGitHub().putPullRequest(prView(A));
    const r = bindTaskPr(db, id, { github: gh });
    expect(r.status).toBe("blocked");
    expect(r.reason).toContain("NO_PRODUCED_HEAD");
  });
});

// ---------------------------------------------------------------------------
// ISH-885: the legitimate FIX is Agent-owned. The Agent updates the SAME PR from
// A to B and pushes B FIRST; Relay only then OBSERVES B. Relay never writes.
// ---------------------------------------------------------------------------

describe("ISH-885: a legitimate FIX is observed read-only (the Agent pushes B first)", () => {
  test("once the Agent has pushed B, Relay re-reads the SAME PR at B and binds it", () => {
    const id = newTask({ prRepo: REPO, prUrl: `${REPO}#7`, head: B });
    linkTask(db, id, { branch: BRANCH, headSha: B });
    const gh = new FakeGitHub().putPullRequest(prView(B)); // the Agent pushed B to PR #7

    const r = bindTaskPr(db, id, { github: gh });

    expect(r.status).toBe("bound");
    expect(r.created).toBe(false);
    expect(r.ref).toEqual({ repo: REPO, number: 7 }); // the SAME PR
    expect(r.remoteHead).toBe(B);
    expect(getTask(db, id)!.head_sha).toBe(B);
  });

  test("while the PR still shows A and the Task has produced B, Relay refuses (HEAD_MOVED)", () => {
    const id = newTask({ prRepo: REPO, prUrl: `${REPO}#7`, head: B });
    linkTask(db, id, { branch: BRANCH, headSha: B });
    const gh = new FakeGitHub().putPullRequest(prView(A)); // the Agent has NOT pushed B yet

    const r = bindTaskPr(db, id, { github: gh });

    expect(r.status).toBe("blocked");
    expect(r.reason).toContain("HEAD_MOVED");
    expect(getTask(db, id)!.head_sha).toBe(B); // Relay did not move anything
  });

  test("A's PASS never authorizes B: a new-head bind re-opens review at attempt+1", async () => {
    const id = newTask();
    await driveToReviewed(id, A); // a PASS at A
    expect(getTask(db, id)!.attempt).toBe(0);

    // The Agent's FIX: the Task now produces B; Relay reads the same PR at B.
    linkTask(db, id, { headSha: B });
    linkTask(db, id, { prUrl: `${REPO}#7`, prRepo: REPO });
    const gh = new FakeGitHub().putPullRequest(prView(B));
    const r = bindTaskPr(db, id, { github: gh });

    expect(r.status).toBe("bound");
    const t = getTask(db, id)!;
    expect(t.head_sha).toBe(B);
    expect(t.phase).toBe("review");
    expect(t.attempt).toBe(1); // A's PASS was invalidated
    expect(findPassingReview(db, id, 0)).not.toBeNull(); // A's evidence is retained, not reused
    expect(findPassingReview(db, id, 1)).toBeNull(); // B has no PASS yet
  });
});

describe("bindTaskPr: HEAD evidence is preserved", () => {
  test("a blocked bind does NOT invalidate the review evidence at the recorded head", async () => {
    const id = newTask();
    await driveToReviewed(id, A);
    expect(getTask(db, id)!.attempt).toBe(0);
    expect(findPassingReview(db, id, 0)).not.toBeNull();

    // Record an explicit PR whose head has moved.
    linkTask(db, id, { prUrl: `${REPO}#7`, prRepo: REPO });
    const gh = new FakeGitHub().putPullRequest(prView(B));
    const r = bindTaskPr(db, id, { github: gh });

    expect(r.status).toBe("blocked");
    const t = getTask(db, id)!;
    expect(t.phase).toBe("integration"); // a PASS had advanced review -> integration
    expect(t.attempt).toBe(0); // the passing review at A survives untouched
    expect(t.head_sha).toBe(A);
    expect(findPassingReview(db, id, 0)).not.toBeNull();
  });

  test("a moved bound PR head re-opens review at a new attempt (VERIFY/Review invalidated)", async () => {
    const id = newTask({ prRepo: REPO, prUrl: `${REPO}#7` });
    await driveToReviewed(id, A);
    expect(getTask(db, id)!.attempt).toBe(0);

    // GitHub now reports the PR at a NEW head (the Agent pushed B).
    const gh = new FakeGitHub().putPullRequest(prView(B));
    reconcileTaskFromProvider(db, id, { github: gh });

    const t = getTask(db, id)!;
    expect(t.head_sha).toBe(B);
    expect(t.phase).toBe("review");
    expect(t.attempt).toBe(1); // the old PASS no longer applies
    expect(findPassingReview(db, id, 1)).toBeNull();
  });
});

describe("finding 2: a FORK PR is never adopted or bound", () => {
  test("pass 2 adoption rejects a same-branch, same-SHA fork PR (REPO_CHANGED)", () => {
    const id = newTask({ prRepo: REPO });
    linkTask(db, id, { branch: BRANCH, headSha: A });
    const gh = new FakeGitHub().putPullRequest(
      prView(A, { isCrossRepository: true, headRepo: "fork-owner/relay" })
    );

    const r = bindTaskPr(db, id, { github: gh });

    expect(r.status).toBe("blocked");
    expect(r.reason).toContain("REPO_CHANGED");
    expect(getTask(db, id)!.pr_url).toBeNull();
  });

  test("a recorded identity whose PR head is in a fork repo is REPO_CHANGED", () => {
    const id = newTask({ prRepo: REPO, prUrl: `${REPO}#7`, head: A });
    linkTask(db, id, { branch: BRANCH, headSha: A });
    const gh = new FakeGitHub().putPullRequest(
      prView(A, { isCrossRepository: true, headRepo: "fork-owner/relay" })
    );

    const r = bindTaskPr(db, id, { github: gh });

    expect(r.status).toBe("blocked");
    expect(r.reason).toContain("REPO_CHANGED");
    expect(getTask(db, id)!.head_sha).toBe(A);
  });

  test("an unknown-provenance view fails closed when the repo is known", () => {
    const id = newTask({ prRepo: REPO, prUrl: `${REPO}#7`, head: A });
    linkTask(db, id, { branch: BRANCH, headSha: A });
    const bare = prView(A);
    delete bare.isCrossRepository;
    delete bare.headRepo;
    const gh = new FakeGitHub().putPullRequest(bare);

    const r = bindTaskPr(db, id, { github: gh });

    expect(r.status).toBe("blocked");
    expect(r.reason).toContain("REPO_CHANGED");
  });

  test("prHeadRepoSafe classifies same-repo, fork flag, head-repo mismatch and unknown", () => {
    expect(prHeadRepoSafe(prView(A), REPO)).toBe(true);
    expect(prHeadRepoSafe(prView(A, { isCrossRepository: true }), REPO)).toBe(false);
    expect(prHeadRepoSafe(prView(A, { headRepo: "fork/relay" }), REPO)).toBe(false);
    const unknown = { ...prView(A), isCrossRepository: undefined, headRepo: "" };
    expect(prHeadRepoSafe(unknown, REPO)).toBe(false);
  });
});

describe("finding 3: the bound head is an EXACT full 40-hex SHA", () => {
  test("isFullCommitSha / sameCommitSha reject prefixes and different SHAs", () => {
    expect(isFullCommitSha(A)).toBe(true);
    expect(isFullCommitSha(A.slice(0, 7))).toBe(false);
    expect(isFullCommitSha(null)).toBe(false);
    expect(sameCommitSha(A, A.toUpperCase())).toBe(true);
    expect(sameCommitSha(A.slice(0, 7), A)).toBe(false);
    expect(sameCommitSha(A, B)).toBe(false);
  });

  test("a prefix --head neither binds nor rewrites the produced commit", () => {
    const id = newTask({ prRepo: REPO, prUrl: `${REPO}#7`, head: A });
    linkTask(db, id, { branch: BRANCH, headSha: A });
    const gh = new FakeGitHub().putPullRequest(prView(B));

    const r = bindTaskPr(db, id, { github: gh, expectedHead: "ab" });

    expect(r.status).toBe("blocked");
    expect(r.reason).toContain("HEAD_MISMATCH");
    expect(getTask(db, id)!.head_sha).toBe(A); // never rewritten
  });

  test("a full but DIFFERENT --head is refused", () => {
    const id = newTask({ prRepo: REPO, prUrl: `${REPO}#7`, head: A });
    linkTask(db, id, { branch: BRANCH, headSha: A });
    const gh = new FakeGitHub().putPullRequest(prView(B));

    const r = bindTaskPr(db, id, { github: gh, expectedHead: B });

    expect(r.status).toBe("blocked");
    expect(r.reason).toContain("HEAD_MISMATCH");
    expect(getTask(db, id)!.head_sha).toBe(A);
  });

  test("an abbreviated PR head never matches a full produced commit (no prefix match)", () => {
    const id = newTask({ prRepo: REPO, prUrl: `${REPO}#7`, head: A });
    linkTask(db, id, { branch: BRANCH, headSha: A });
    const gh = new FakeGitHub().putPullRequest(prView(A.slice(0, 7)));

    const r = bindTaskPr(db, id, { github: gh });

    expect(r.status).toBe("blocked");
    expect(r.reason).toContain("HEAD_MOVED");
    expect(getTask(db, id)!.head_sha).toBe(A);
  });

  test("a restated identical --head (case-insensitive) is accepted", () => {
    const id = newTask({ prRepo: REPO, prUrl: `${REPO}#7`, head: A });
    linkTask(db, id, { branch: BRANCH, headSha: A });
    const gh = new FakeGitHub().putPullRequest(prView(A));

    const r = bindTaskPr(db, id, { github: gh, expectedHead: A.toUpperCase() });

    expect(r.status).toBe("bound");
    expect(getTask(db, id)!.head_sha).toBe(A);
  });
});
