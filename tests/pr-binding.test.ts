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
import {
  FakeGitHub,
  NO_AUTHORITY,
  reconcileTaskFromProvider,
  type PrView,
} from "../src/providers";
import {
  bindTaskPr,
  GitGhPrPublisher,
  PR_BINDING_ERROR,
  resolveTaskPrRef,
  type PrPublisher,
  type PublishRequest,
} from "../src/pr-binding";
import type { Exec } from "../src/provider-adapters";

// ISH-880: a deterministic fixture for the Task<->PR binding — a fake read-only
// GitHub (in-memory PRs), a fake authorized publisher (records its calls, never
// reaches git/gh), and the real SQLite task/phase machine. No network.

const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
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
    ...over,
  };
}

class FakePublisher implements PrPublisher {
  readonly name = "fake-publisher";
  calls: PublishRequest[] = [];
  constructor(
    private make: (req: PublishRequest) => { ref: { repo: string; number: number } | null; created: boolean; error?: string }
  ) {}
  publish(req: PublishRequest) {
    this.calls.push(req);
    return { ok: true, ...this.make(req) };
  }
}

const WRITE = { ...NO_AUTHORITY, githubWrite: true };

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

describe("bindTaskPr: publish then verify the real remote HEAD", () => {
  test("a fresh PR is published and bound to the produced commit", () => {
    const id = newTask({ prRepo: REPO });
    linkTask(db, id, { branch: BRANCH, headSha: HEAD });
    const gh = new FakeGitHub();
    // The publisher creates the PR: the read-only reader sees it on the next read.
    const pub = new FakePublisher(() => {
      gh.putPullRequest(prView(HEAD));
      return { ref: { repo: REPO, number: 7 }, created: true };
    });

    const r = bindTaskPr(db, id, { github: gh, publisher: pub, authority: WRITE });

    expect(r.status).toBe("published");
    expect(r.created).toBe(true);
    expect(pub.calls).toHaveLength(1);
    expect(pub.calls[0].headSha).toBe(HEAD);
    expect(pub.calls[0].repo).toBe(REPO);
    const t = getTask(db, id)!;
    expect(t.pr_url).toBe(`https://github.com/${REPO}/pull/7`);
    expect(t.pr_repo).toBe(REPO);
    expect(t.head_sha).toBe(HEAD);
    expect(t.pr_base).toBe("main");
  });

  test("a recorded PR is re-read and re-bound; the publisher is NEVER called", () => {
    const id = newTask({ prRepo: REPO, prUrl: `${REPO}#7`, head: HEAD });
    linkTask(db, id, { branch: BRANCH, headSha: HEAD });
    const gh = new FakeGitHub().putPullRequest(prView(HEAD));
    const pub = new FakePublisher(() => ({ ref: { repo: REPO, number: 7 }, created: true }));

    const r = bindTaskPr(db, id, { github: gh, publisher: pub, authority: WRITE });

    expect(r.status).toBe("bound");
    expect(r.created).toBe(false);
    expect(pub.calls).toHaveLength(0); // no duplicate PR on retry
  });

  test("retry after a crash ADOPTS the existing PR for the (repo, branch) — no duplicate", () => {
    const id = newTask({ prRepo: REPO });
    linkTask(db, id, { branch: BRANCH, headSha: HEAD });
    const gh = new FakeGitHub().putPullRequest(prView(HEAD)); // created by the crashed pass
    const pub = new FakePublisher(() => ({ ref: { repo: REPO, number: 99 }, created: true }));

    const r = bindTaskPr(db, id, { github: gh, publisher: pub, authority: WRITE });

    expect(r.status).toBe("adopted");
    expect(r.created).toBe(false);
    expect(pub.calls).toHaveLength(0); // adopted, not a second create
    expect(getTask(db, id)!.pr_url).toBe(`https://github.com/${REPO}/pull/7`);
  });

  test("a PR on the branch with a DIFFERENT head is not adopted", () => {
    const id = newTask({ prRepo: REPO });
    linkTask(db, id, { branch: BRANCH, headSha: HEAD });
    const gh = new FakeGitHub().putPullRequest(prView(MOVED));
    gh.putPullRequest(prView(HEAD, { ref: { repo: REPO, number: 8 }, url: `https://github.com/${REPO}/pull/8` }));
    const pub = new FakePublisher(() => ({ ref: { repo: REPO, number: 8 }, created: true }));

    const r = bindTaskPr(db, id, { github: gh, publisher: pub, authority: WRITE });

    // Not adopted: the only PR on the branch has a different head, so the
    // producer publishes a new one whose head DOES match.
    expect(pub.calls).toHaveLength(1);
    expect(r.status).toBe("published");
    expect(r.ref?.number).toBe(8);
  });
});

describe("bindTaskPr: fail closed (never a fake review_pass)", () => {
  test("a moved PR head is BLOCKED and never overwrites the recorded head", () => {
    const id = newTask({ prRepo: REPO, prUrl: `${REPO}#7`, head: HEAD });
    linkTask(db, id, { branch: BRANCH, headSha: HEAD });
    const gh = new FakeGitHub().putPullRequest(prView(MOVED));

    const r = bindTaskPr(db, id, { github: gh });

    expect(r.status).toBe("blocked");
    expect(r.reason).toContain(`${PR_BINDING_ERROR}: HEAD_MOVED`);
    const t = getTask(db, id)!;
    expect(t.head_sha).toBe(HEAD); // the recorded commit is untouched
    expect(t.pr_url).toBe(`${REPO}#7`);
  });

  test("a PR in a DIFFERENT repo is BLOCKED", () => {
    const id = newTask({ prRepo: REPO, prUrl: `https://github.com/evil/relay/pull/7`, head: HEAD });
    linkTask(db, id, { branch: BRANCH, headSha: HEAD });
    const gh = new FakeGitHub().putPullRequest(prView(HEAD, { ref: { repo: "evil/relay", number: 7 } }));

    const r = bindTaskPr(db, id, { github: gh });

    expect(r.status).toBe("blocked");
    expect(r.reason).toContain("REPO_CHANGED");
  });

  test("a closed PR is BLOCKED", () => {
    const id = newTask({ prRepo: REPO, prUrl: `${REPO}#7`, head: HEAD });
    linkTask(db, id, { branch: BRANCH, headSha: HEAD });
    const gh = new FakeGitHub().putPullRequest(prView(HEAD, { state: "closed" }));

    const r = bindTaskPr(db, id, { github: gh });

    expect(r.status).toBe("blocked");
    expect(r.reason).toContain("PR_NOT_OPEN");
  });

  test("an unreadable provider is BLOCKED (unknown is never ready)", () => {
    const id = newTask({ prRepo: REPO, prUrl: `${REPO}#7`, head: HEAD });
    linkTask(db, id, { branch: BRANCH, headSha: HEAD });
    expect(bindTaskPr(db, id, {}).reason).toContain("PROVIDER_UNREADABLE");
    // A reader that cannot find the PR is also BLOCKED, not "unbound is fine".
    const r = bindTaskPr(db, id, { github: new FakeGitHub() });
    expect(r.status).toBe("blocked");
    expect(r.reason).toContain("PR_UNREADABLE");
  });

  test("publishing without an explicit grant, or without a publisher, is BLOCKED", () => {
    const id = newTask({ prRepo: REPO });
    linkTask(db, id, { branch: BRANCH, headSha: HEAD });
    const gh = new FakeGitHub();
    const pub = new FakePublisher(() => ({ ref: { repo: REPO, number: 7 }, created: true }));

    const noGrant = bindTaskPr(db, id, { github: gh, publisher: pub });
    expect(noGrant.status).toBe("blocked");
    expect(noGrant.reason).toContain("PUBLISH_UNAUTHORIZED");
    expect(pub.calls).toHaveLength(0);

    const noPublisher = bindTaskPr(db, id, { github: gh, authority: WRITE });
    expect(noPublisher.status).toBe("blocked");
    expect(noPublisher.reason).toContain("NO_PUBLISHER");
  });

  test("a task with no produced commit cannot bind", () => {
    const id = newTask({ prRepo: REPO });
    const gh = new FakeGitHub().putPullRequest(prView(HEAD));
    const r = bindTaskPr(db, id, { github: gh });
    expect(r.status).toBe("blocked");
    expect(r.reason).toContain("NO_PRODUCED_HEAD");
  });

  test("a publisher that returns an unreadable/mismatched PR is BLOCKED", () => {
    const id = newTask({ prRepo: REPO });
    linkTask(db, id, { branch: BRANCH, headSha: HEAD });
    const gh = new FakeGitHub(); // getPullRequest -> null
    const pub = new FakePublisher(() => ({ ref: { repo: REPO, number: 7 }, created: true }));

    const r = bindTaskPr(db, id, { github: gh, publisher: pub, authority: WRITE });

    expect(r.status).toBe("blocked");
    expect(r.reason).toContain("PR_UNREADABLE");
    expect(getTask(db, id)!.pr_url).toBeNull(); // nothing was bound
  });
});

describe("bindTaskPr: HEAD evidence is preserved", () => {
  test("a blocked bind does NOT invalidate the review evidence at the recorded head", async () => {
    const id = newTask();
    await driveToReviewed(id, HEAD);
    expect(getTask(db, id)!.attempt).toBe(0);
    expect(findPassingReview(db, id, 0)).not.toBeNull();

    // Record an explicit PR whose head has moved.
    linkTask(db, id, { prUrl: `${REPO}#7`, prRepo: REPO });
    const gh = new FakeGitHub().putPullRequest(prView(MOVED));
    const r = bindTaskPr(db, id, { github: gh });

    expect(r.status).toBe("blocked");
    const t = getTask(db, id)!;
    expect(t.phase).toBe("integration"); // a PASS had advanced review -> integration
    expect(t.attempt).toBe(0); // the passing review at HEAD survives untouched
    expect(t.head_sha).toBe(HEAD);
    expect(findPassingReview(db, id, 0)).not.toBeNull();
  });

  test("a moved bound PR head re-opens review at a new attempt (VERIFY/Review invalidated)", async () => {
    const id = newTask({ prRepo: REPO, prUrl: `${REPO}#7` });
    await driveToReviewed(id, HEAD);
    expect(getTask(db, id)!.attempt).toBe(0);

    // GitHub now reports the PR at a NEW head (an external force-push).
    const gh = new FakeGitHub().putPullRequest(prView(MOVED));
    reconcileTaskFromProvider(db, id, { github: gh });

    const t = getTask(db, id)!;
    expect(t.head_sha).toBe(MOVED);
    expect(t.phase).toBe("review");
    expect(t.attempt).toBe(1); // the old PASS no longer applies
    expect(findPassingReview(db, id, 1)).toBeNull();
  });
});

describe("GitGhPrPublisher: normal git/gh, find-or-create, remote guard", () => {
  function recordingExec(handler: (argv: string[]) => { ok: boolean; stdout: string; stderr: string }) {
    const calls: string[][] = [];
    const exec: Exec = (argv) => {
      calls.push(argv);
      return handler(argv);
    };
    return { calls, exec };
  }

  test("pushes the produced commit and creates the PR (parses the gh URL)", () => {
    const { calls, exec } = recordingExec((argv) => {
      const j = argv.join(" ");
      if (j.includes("remote get-url")) return { ok: true, stdout: `git@github.com:${REPO}.git\n`, stderr: "" };
      if (argv[0] === "git" && argv.includes("push")) return { ok: true, stdout: "", stderr: "" };
      if (j.includes("pr list")) return { ok: true, stdout: "[]", stderr: "" };
      if (j.includes("pr create")) return { ok: true, stdout: `https://github.com/${REPO}/pull/42\n`, stderr: "" };
      return { ok: false, stdout: "", stderr: "unexpected" };
    });
    const p = new GitGhPrPublisher("/repo", exec);
    const r = p.publish({ repo: REPO, branch: BRANCH, headSha: HEAD, base: "main", title: "t", body: "b", existing: null });

    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);
    expect(r.ref).toEqual({ repo: REPO, number: 42 });
    expect(calls.some((c) => c.join(" ").includes(`push origin ${HEAD}:refs/heads/${BRANCH}`))).toBe(true);
  });

  test("find-or-create: an existing open PR is reused, never duplicated", () => {
    let created = 0;
    const { exec } = recordingExec((argv) => {
      const j = argv.join(" ");
      if (j.includes("remote get-url")) return { ok: true, stdout: `git@github.com:${REPO}.git\n`, stderr: "" };
      if (argv[0] === "git" && argv.includes("push")) return { ok: true, stdout: "", stderr: "" };
      if (j.includes("pr list")) return { ok: true, stdout: JSON.stringify([{ url: `https://github.com/${REPO}/pull/5`, number: 5 }]), stderr: "" };
      if (j.includes("pr create")) {
        created++;
        return { ok: true, stdout: `https://github.com/${REPO}/pull/6\n`, stderr: "" };
      }
      return { ok: false, stdout: "", stderr: "unexpected" };
    });
    const p = new GitGhPrPublisher("/repo", exec);
    const r = p.publish({ repo: REPO, branch: BRANCH, headSha: HEAD, base: "main", title: "t", body: "b", existing: null });

    expect(r.ok).toBe(true);
    expect(r.created).toBe(false);
    expect(r.ref).toEqual({ repo: REPO, number: 5 });
    expect(created).toBe(0);
  });

  test("refuses to push when the git remote does not point at the target repo", () => {
    let pushed = false;
    const { exec } = recordingExec((argv) => {
      const j = argv.join(" ");
      if (j.includes("remote get-url")) return { ok: true, stdout: "git@github.com:someone/else.git\n", stderr: "" };
      if (argv[0] === "git" && argv.includes("push")) {
        pushed = true;
        return { ok: true, stdout: "", stderr: "" };
      }
      return { ok: true, stdout: "[]", stderr: "" };
    });
    const p = new GitGhPrPublisher("/repo", exec);
    const r = p.publish({ repo: REPO, branch: BRANCH, headSha: HEAD, base: null, title: "t", body: "", existing: null });

    expect(r.ok).toBe(false);
    expect(pushed).toBe(false);
  });
});
