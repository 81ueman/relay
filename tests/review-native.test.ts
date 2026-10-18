import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { logEvent } from "../src/events";
import { claimTask, getTask } from "../src/tasks";
import { registerWorker } from "../src/workers";
import { intakeTask, recordVerification, submitPhase } from "../src/workflow";
import { gitHead } from "../src/verify";
import {
  REVIEW_NATIVE_MISSING,
  REVIEW_NATIVE_NO_PR,
  REVIEW_NATIVE_UNVERIFIED,
  runHeadlessReview,
  type ReviewFinding,
  type ReviewerProcess,
  type ReviewerSpawnContext,
  type ReviewerSpawner,
} from "../src/reviewer-runner";
import { GhCliGitHub, type ExecResult } from "../src/provider-adapters";
import type {
  CommentView,
  GitHubReadOnly,
  GitHubReviewReader,
  NativeReviewDeps,
  PrRef,
  PrView,
  ReviewView,
} from "../src/providers";

// ISH-883: the headless reviewer POSTS a native GitHub PR review (via gh in its
// disposable checkout); Relay reads the ACTUAL review back and accepts it only at
// the exact reviewed HEAD. A fake GitHub + a fake Claude keep it deterministic.

let dir = "";
let repo = "";
let db: Database;
let seq = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

// One durable temp repo + DB for the whole file: the reviewed HEAD is fixed, so
// per-test git/SQLite churn (and the environment's transient `git` spawn
// failures) is minimised. Tasks are unique per test via `seq`.
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-ish883-native-"));
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

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const HEAD = (): string => git(repo, "rev-parse", "HEAD");

const MARKER_VERDICT: Record<string, "OK" | "NG" | "HOLD"> = { pass: "OK", fix: "NG", blocked: "HOLD" };

function prView(headSha: string, repoSlug = "o/r", number = 7): PrView {
  return {
    ref: { repo: repoSlug, number },
    url: `https://github.com/${repoSlug}/pull/${number}`,
    state: "open",
    isDraft: false,
    headRefName: "feat/x",
    headSha,
    baseRef: "main",
    baseSha: "base",
    mergeable: "mergeable",
    labels: [],
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

/** A fake GitHub serving read-back + a live PR head; `record` = the reviewer's post. */
class FakeNativeGitHub implements GitHubReadOnly, GitHubReviewReader {
  readonly name = "fake-native-gh";
  readonly readOnly = true as const;
  author = "ishiul-reviewer";
  pr: PrView;
  reviews: ReviewView[] = [];
  failList = false;
  private nextId = 100;

  constructor(pr: PrView) {
    this.pr = pr;
  }

  /** Simulate the reviewer's native POST (via its own `gh`). */
  record(b: { headSha: string; body: string; author?: string; state?: string; createdAt?: string }): ReviewView {
    const id = this.nextId++;
    const v: ReviewView = {
      id,
      repo: this.pr.ref.repo,
      prNumber: this.pr.ref.number,
      author: b.author ?? this.author,
      headSha: b.headSha,
      state: b.state ?? "COMMENTED",
      body: b.body,
      url: `https://github.com/${this.pr.ref.repo}/pull/${this.pr.ref.number}#discussion_r${id}`,
      createdAt: b.createdAt ?? "2026-01-01T00:00:00Z",
    };
    this.reviews.push(v);
    return v;
  }

  listReviews(ref: PrRef): ReviewView[] | null {
    if (this.failList) return null;
    return this.reviews.filter((r) => r.repo === ref.repo && r.prNumber === ref.number);
  }

  getPullRequest(ref: PrRef): PrView | null {
    return this.pr.ref.repo === ref.repo && this.pr.ref.number === ref.number ? this.pr : null;
  }

  findPullRequestForBranch(repoSlug: string, branch: string): PrView | null {
    return this.pr.ref.repo === repoSlug && this.pr.headRefName === branch ? this.pr : null;
  }

  listComments(): CommentView[] {
    return [];
  }
}

type PostPlan = "ok" | "missing" | "wronghead" | "nomarker" | "wrongauthor" | "pending" | "dismissed";

/**
 * A fake headless Claude reviewer: it reads its cwd HEAD, optionally POSTs a
 * native review to the fake GitHub (the `gh` call it would make), and returns a
 * structured verdict. Captures every spawn context for brief/env assertions.
 */
function reviewer(
  gh: FakeNativeGitHub,
  plan: { verdict?: "pass" | "fix" | "blocked"; post?: PostPlan; findings?: ReviewFinding[] } = {}
): { spawner: ReviewerSpawner; calls: ReviewerSpawnContext[] } {
  const calls: ReviewerSpawnContext[] = [];
  const spawner: ReviewerSpawner = {
    async run(ctx): Promise<ReviewerProcess> {
      calls.push(ctx);
      const head = gitHead(ctx.cwd)!;
      const v = plan.verdict ?? "pass";
      const post = plan.post ?? "ok";
      if (post !== "missing") {
        const markerHead = post === "wronghead" ? "0".repeat(40) : head;
        const body =
          post === "nomarker"
            ? "reviewed, no marker"
            : `<!-- ishiul-review head=${markerHead} verdict=${MARKER_VERDICT[v]} reviewer=${gh.author} -->\n\nrelay review`;
        const state = post === "pending" ? "PENDING" : post === "dismissed" ? "DISMISSED" : "COMMENTED";
        gh.record({ headSha: markerHead, body, state, ...(post === "wrongauthor" ? { author: "someone-else" } : {}) });
      }
      return {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({ verdict: v, head, findings: plan.findings ?? [], summary: "looks correct" }),
        stderr: "",
      };
    },
  };
  return { spawner, calls };
}

/** Drive a code task to review@head with a bound PR at `head`. */
function driveToReview(head: string, prSlug = "o/r"): string {
  const t = intakeTask(db, {
    provider: "test",
    issueId: `ISH-883-${seq++}`,
    codeChange: true,
    headSha: head,
    prUrl: `https://github.com/${prSlug}/pull/7`,
    prRepo: prSlug,
    branch: "feat/x",
    worktree: repo,
  });
  claimTask(db, t.id, "impl");
  submitPhase(db, t.id, "impl");
  claimTask(db, t.id, "ver");
  recordVerification(db, t.id, "ver", { passed: true });
  expect(getTask(db, t.id)!.phase).toBe("review");
  return t.id;
}

function nativeDeps(gh: FakeNativeGitHub): NativeReviewDeps {
  return { reader: gh, github: gh, author: gh.author, allowedTools: "Read Grep Glob Bash", spawnEnv: { GH_TOKEN: "t" } };
}

describe("runHeadlessReview verifies the reviewer's native GitHub review (ISH-883)", () => {
  test("accepts a PASS only after reading the native review back at the HEAD", async () => {
    const head = HEAD();
    const id = driveToReview(head);
    const gh = new FakeNativeGitHub(prView(head));
    const { spawner, calls } = reviewer(gh);
    const r = await runHeadlessReview(db, id, { spawner, nativeReview: nativeDeps(gh) });

    expect(r.outcome).toBe("pass");
    expect(gh.reviews).toHaveLength(1);
    expect(r.nativeReview?.author).toBe(gh.author);
    expect(r.nativeReview?.headSha).toBe(head);
    expect(getTask(db, id)!.phase).toBe("integration");

    // The brief told the reviewer which PR + marker to post, and the spawn got
    // the posted review's shell/token channel.
    expect(calls[0].brief).toContain("o/r#7");
    expect(calls[0].brief).toContain(`head=${head} verdict=OK|NG|HOLD reviewer=${gh.author}`);
    expect(calls[0].allowedTools).toBe("Read Grep Glob Bash");
    expect(calls[0].env.GH_TOKEN).toBe("t");

    // The verified native review is retained alongside the structured verdict.
    const evidence = JSON.parse(readFileSync(r.evidenceRef!, "utf-8")) as {
      structured: { verdict: string };
      native: { id: number; headSha: string } | null;
    };
    expect(evidence.structured.verdict).toBe("pass");
    expect(evidence.native?.id).toBe(r.nativeReview?.id);
    expect(evidence.native?.headSha).toBe(head);
  });

  test("refuses when the reviewer posted NO native review", async () => {
    const head = HEAD();
    const id = driveToReview(head);
    const gh = new FakeNativeGitHub(prView(head));
    const r = await runHeadlessReview(db, id, { spawner: reviewer(gh, { post: "missing" }).spawner, nativeReview: nativeDeps(gh) });
    expect(r.outcome).toBe("refused");
    expect(r.error).toContain(REVIEW_NATIVE_MISSING);
    expect(getTask(db, id)!.phase).toBe("review");
  });

  test("refuses a review pinned to a DIFFERENT head", async () => {
    const head = HEAD();
    const id = driveToReview(head);
    const gh = new FakeNativeGitHub(prView(head));
    const r = await runHeadlessReview(db, id, { spawner: reviewer(gh, { post: "wronghead" }).spawner, nativeReview: nativeDeps(gh) });
    expect(r.outcome).toBe("refused");
    expect(r.error).toContain(REVIEW_NATIVE_MISSING);
    expect(getTask(db, id)!.phase).toBe("review");
  });

  test("refuses a review whose body omits the head-pinned marker", async () => {
    const head = HEAD();
    const id = driveToReview(head);
    const gh = new FakeNativeGitHub(prView(head));
    const r = await runHeadlessReview(db, id, { spawner: reviewer(gh, { post: "nomarker" }).spawner, nativeReview: nativeDeps(gh) });
    expect(r.outcome).toBe("refused");
    expect(r.error).toContain(REVIEW_NATIVE_MISSING);
  });

  test("refuses a review authored by a foreign identity", async () => {
    const head = HEAD();
    const id = driveToReview(head);
    const gh = new FakeNativeGitHub(prView(head));
    const r = await runHeadlessReview(db, id, { spawner: reviewer(gh, { post: "wrongauthor" }).spawner, nativeReview: nativeDeps(gh) });
    expect(r.outcome).toBe("refused");
    expect(r.error).toContain(REVIEW_NATIVE_MISSING);
  });

  test("refuses a PENDING (never-submitted) review", async () => {
    const head = HEAD();
    const id = driveToReview(head);
    const gh = new FakeNativeGitHub(prView(head));
    const r = await runHeadlessReview(db, id, { spawner: reviewer(gh, { post: "pending" }).spawner, nativeReview: nativeDeps(gh) });
    expect(gh.reviews[0].state).toBe("PENDING");
    expect(r.outcome).toBe("refused");
    expect(r.error).toContain(REVIEW_NATIVE_MISSING);
    expect(getTask(db, id)!.phase).toBe("review");
  });

  test("refuses a DISMISSED review", async () => {
    const head = HEAD();
    const id = driveToReview(head);
    const gh = new FakeNativeGitHub(prView(head));
    const r = await runHeadlessReview(db, id, { spawner: reviewer(gh, { post: "dismissed" }).spawner, nativeReview: nativeDeps(gh) });
    expect(gh.reviews[0].state).toBe("DISMISSED");
    expect(r.outcome).toBe("refused");
    expect(r.error).toContain(REVIEW_NATIVE_MISSING);
    expect(getTask(db, id)!.phase).toBe("review");
  });

  test("refuses an old same-HEAD review after a base-changed invalidation", async () => {
    const head = HEAD();
    const id = driveToReview(head);
    const gh = new FakeNativeGitHub(prView(head));
    // A review at the HEAD that predates the base retarget (posted for the old base).
    const old = gh.record({
      headSha: head,
      state: "COMMENTED",
      createdAt: "2000-01-01T00:00:00Z",
      body: `<!-- ishiul-review head=${head} verdict=OK reviewer=${gh.author} -->\n\nold base review`,
    });
    // A base retarget re-opens the review at the SAME HEAD (attempt+1).
    logEvent(db, {
      source: "workflow",
      taskId: id,
      type: "workflow.review_invalidated",
      payload: { reason: "base-changed", toHead: head, toAttempt: 1 },
    });
    // The reviewer posts nothing new; the old review must NOT be re-accepted.
    const r = await runHeadlessReview(db, id, { spawner: reviewer(gh, { post: "missing" }).spawner, nativeReview: nativeDeps(gh) });
    expect(old.createdAt).toBe("2000-01-01T00:00:00Z");
    expect(r.outcome).toBe("refused");
    expect(r.error).toContain(REVIEW_NATIVE_MISSING);
    expect(getTask(db, id)!.phase).toBe("review");
  });

  test("prefers the NEWEST matching same-HEAD review", async () => {
    const head = HEAD();
    const id = driveToReview(head);
    const gh = new FakeNativeGitHub(prView(head));
    const marker = `<!-- ishiul-review head=${head} verdict=OK reviewer=${gh.author} -->`;
    const older = gh.record({ headSha: head, body: marker, createdAt: "2020-01-01T00:00:00Z" });
    const newer = gh.record({ headSha: head, body: marker, createdAt: "2025-01-01T00:00:00Z" });
    // The reviewer posts nothing new; the read-back must pick the newest.
    const r = await runHeadlessReview(db, id, { spawner: reviewer(gh, { post: "missing" }).spawner, nativeReview: nativeDeps(gh) });
    expect(r.outcome).toBe("pass");
    expect(r.nativeReview?.id).toBe(newer.id);
    expect(r.nativeReview?.id).not.toBe(older.id);
  });

  test("refuses when the PR has moved off the reviewed HEAD", async () => {
    const head = HEAD();
    const id = driveToReview(head);
    const gh = new FakeNativeGitHub(prView(head));
    gh.pr = prView("a".repeat(40)); // GitHub's current head advanced
    const r = await runHeadlessReview(db, id, { spawner: reviewer(gh).spawner, nativeReview: nativeDeps(gh) });
    expect(r.outcome).toBe("refused");
    expect(r.error).toContain(REVIEW_NATIVE_UNVERIFIED);
    expect(getTask(db, id)!.phase).toBe("review");
  });

  test("refuses when the reviews cannot be read back", async () => {
    const head = HEAD();
    const id = driveToReview(head);
    const gh = new FakeNativeGitHub(prView(head));
    gh.failList = true;
    const r = await runHeadlessReview(db, id, { spawner: reviewer(gh).spawner, nativeReview: nativeDeps(gh) });
    expect(r.outcome).toBe("refused");
    expect(r.error).toContain(REVIEW_NATIVE_UNVERIFIED);
  });

  test("refuses when no PR is bound", async () => {
    const head = HEAD();
    const t = intakeTask(db, { provider: "test", issueId: `ISH-883-nb-${seq++}`, codeChange: true, headSha: head, worktree: repo });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl");
    claimTask(db, t.id, "ver");
    recordVerification(db, t.id, "ver", { passed: true });
    const gh = new FakeNativeGitHub(prView(head));
    const r = await runHeadlessReview(db, t.id, { spawner: reviewer(gh).spawner, nativeReview: nativeDeps(gh) });
    expect(r.outcome).toBe("refused");
    expect(r.error).toContain(REVIEW_NATIVE_NO_PR);
  });

  test("a FIX review reads back as NG and still reworks", async () => {
    const head = HEAD();
    const id = driveToReview(head);
    const gh = new FakeNativeGitHub(prView(head));
    const r = await runHeadlessReview(db, id, {
      spawner: reviewer(gh, {
        verdict: "fix",
        findings: [{ severity: "blocker", file: "src/x.ts", line: 4, message: "missing guard" }],
      }).spawner,
      nativeReview: nativeDeps(gh),
    });
    expect(r.outcome).toBe("fix");
    expect(gh.reviews[0].body).toContain("verdict=NG");
    expect(getTask(db, id)!.phase).toBe("implement");
  });

  test("the local structured-verdict path is unchanged when native review is off", async () => {
    const head = HEAD();
    const id = driveToReview(head);
    const gh = new FakeNativeGitHub(prView(head));
    const r = await runHeadlessReview(db, id, { spawner: reviewer(gh, { post: "missing" }).spawner });
    expect(r.outcome).toBe("pass");
    expect(r.nativeReview).toBeNull();
    expect(getTask(db, id)!.phase).toBe("integration");
  });
});

describe("gh CLI native review read-back (ISH-883)", () => {
  const ok = (stdout: string): ExecResult => ({ ok: true, stdout, stderr: "" });

  test("listReviews maps paginated reviews and returns null on a failed read", () => {
    const gh = new GhCliGitHub(() =>
      ok(`[{"id":1,"user":{"login":"bot"},"commit_id":"aaa","state":"COMMENTED","body":"x","html_url":"u","submitted_at":"t"}]`)
    );
    const reviews = gh.listReviews({ repo: "o/r", number: 7 })!;
    expect(reviews).toHaveLength(1);
    expect(reviews[0].author).toBe("bot");
    expect(reviews[0].headSha).toBe("aaa");
    expect(reviews[0].body).toBe("x");

    const failing = new GhCliGitHub(() => ({ ok: false, stdout: "", stderr: "boom" }));
    expect(failing.listReviews({ repo: "o/r", number: 7 })).toBeNull();
  });
});
