import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { claimTask, getTask } from "../src/tasks";
import { registerWorker } from "../src/workers";
import {
  intakeTask,
  recordReview,
  recordVerification,
  submitPhase,
} from "../src/workflow";
import {
  type CheckRunView,
  type ChecksReadOnly,
  type GitHubReadOnly,
  type GitHubReviewReader,
  type NativeReviewDeps,
  type PrView,
} from "../src/providers";
import {
  GhCliGitHub,
  factoryNativeReviewDepsFromEnv,
  githubReaderFromEnv,
  providerDepsFromEnv,
  type Exec,
} from "../src/provider-adapters";
import {
  PROVIDER_RATE_LIMITED,
  ProviderRateLimitGuard,
  providerRateLimitFromExec,
  providerRateLimitFromText,
} from "../src/provider-rate-limit";
import {
  mergeGateCandidates,
  runMergeGates,
} from "../src/merge-gate";
import {
  providerBoundTasks,
  processWorkflow,
} from "../src/workflow-driver";
import { bindTaskPr } from "../src/pr-binding";
import { runFactoryTask } from "../src/factory";

// ISH-1132: the daemon's provider poll must not spend the shared GitHub API
// budget on terminal Tasks, must honor the per-Task interval for every read
// (including check-runs), and must surface an exhausted budget as typed,
// retryable PROVIDER_RATE_LIMITED instead of "provider not configured".

const FULL = "a".repeat(40);
const BASE = "0".repeat(40);

let dir = "";
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-ish1132-"));
  process.env.RELAY_DB = join(dir, "state.db");
  process.env.RELAY_LEASE_MS = "120000";
  db = openDb(process.env.RELAY_DB);
  registerWorker(db, "impl", { role: "worker" });
  registerWorker(db, "rev", { role: "reviewer" });
  registerWorker(db, "integ", { role: "integrator" });
});

afterEach(() => {
  delete process.env.RELAY_PROVIDER_POLL_MS;
  delete process.env.RELAY_PROVIDER_RATE_LIMIT_BACKOFF_MS;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function view(number: number, state: PrView["state"] = "open"): PrView {
  return {
    ref: { repo: "o/r", number },
    url: `https://github.com/o/r/pull/${number}`,
    state,
    isDraft: false,
    headRefName: "relay/ish-1132",
    headSha: FULL,
    baseRef: "main",
    baseSha: BASE,
    mergeable: "mergeable",
    labels: [],
    updatedAt: "2026-10-23T00:00:00Z",
  };
}

function intake(issue: string, number: number): string {
  return intakeTask(db, {
    provider: "github",
    issueId: issue,
    codeChange: true,
    headSha: FULL,
    prUrl: `https://github.com/o/r/pull/${number}`,
    prRepo: "o/r",
    branch: "relay/ish-1132",
  }).id;
}

function toReview(id: string): void {
  claimTask(db, id, "impl");
  submitPhase(db, id, "impl", { headSha: FULL });
  claimTask(db, id, "impl");
  recordVerification(db, id, "impl", { passed: true, headSha: FULL });
}

function toMergeReady(id: string): void {
  toIntegration(id);
  claimTask(db, id, "integ");
  submitPhase(db, id, "integ");
}

function toIntegration(id: string): void {
  toReview(id);
  // The merge-gate fixture records the independent verdict directly (the
  // reviewer claim path is not what these provider-poll tests exercise).
  recordReview(db, id, "rev", { verdict: "pass", headSha: FULL });
}

function addLiveRun(taskId: string, id = `run-${taskId}`): void {
  const t = Date.now();
  db.query(
    `INSERT INTO runs
       (id, task_id, phase, attempt, generation, cwd, prompt, output_dir, state,
        started_at, created_at, updated_at)
     VALUES (?, ?, 'implement', 0, 0, '/tmp', '', '/tmp', 'running', ?, ?, ?)`
  ).run(id, taskId, t, t, t);
}

interface Counts {
  pr: number;
  branch: number;
  comments: number;
  checks: number;
}

function countingProviders(): { gh: GitHubReadOnly & ChecksReadOnly; calls: Counts } {
  const calls: Counts = { pr: 0, branch: 0, comments: 0, checks: 0 };
  const gh: GitHubReadOnly & ChecksReadOnly = {
    name: "counting",
    readOnly: true,
    getPullRequest(ref) {
      calls.pr++;
      return view(ref.number);
    },
    findPullRequestForBranch() {
      calls.branch++;
      return null;
    },
    listComments() {
      calls.comments++;
      return [];
    },
    listChecks(): CheckRunView[] {
      calls.checks++;
      return [{ name: "typecheck", bucket: "pass" }];
    },
  };
  return { gh, calls };
}

describe("ISH-1132: terminal Tasks spend zero provider calls", () => {
  test("N=60 done/cancelled/failed PR-bound Tasks are never polled or gated", async () => {
    process.env.RELAY_PROVIDER_POLL_MS = "0"; // the interval must not be the reason
    const N = 60;
    for (let i = 0; i < N; i++) {
      const id = intake(`ISH-1132-TERMINAL-${i}`, 3000 + i);
      if (i % 3 === 0) {
        db.query(`UPDATE tasks SET state = 'done', phase = 'merge_ready', accepted_at = 1, merged_at = ? WHERE id = ?`).run(
          i % 2 === 0 ? Date.now() : null,
          id
        );
      } else if (i % 3 === 1) {
        db.query(`UPDATE tasks SET state = 'cancelled', phase = 'review' WHERE id = ?`).run(id);
      } else {
        db.query(`UPDATE tasks SET state = 'failed', phase = 'merge_ready' WHERE id = ?`).run(id);
      }
    }
    expect(providerBoundTasks(db)).toHaveLength(0);
    expect(mergeGateCandidates(db)).toHaveLength(0);

    const { gh, calls } = countingProviders();
    await processWorkflow(db, { github: gh, checks: gh });
    expect(calls).toEqual({ pr: 0, branch: 0, comments: 0, checks: 0 });
  });

  test("only a live Run or review/merge_ready/integration is a poll candidate", () => {
    const queued = intake("ISH-1132-QUEUED", 4000);
    const live = intake("ISH-1132-LIVE", 4001);
    addLiveRun(live);
    const review = intake("ISH-1132-REVIEW", 4002);
    toReview(review);
    const mergeReady = intake("ISH-1132-MERGE", 4003);
    toMergeReady(mergeReady);
    const integration = intake("ISH-1132-INTEG", 4004);
    toIntegration(integration);
    // A merged/accepted Task is terminal even if a stale phase was not advanced.
    const merged = intake("ISH-1132-MERGED", 4005);
    db.query(`UPDATE tasks SET state = 'review', phase = 'merge_ready', merged_at = ? WHERE id = ?`).run(Date.now(), merged);

    const ids = providerBoundTasks(db).map((t) => t.id);
    expect(ids).not.toContain(queued); // implement/verify with no live Run
    expect(ids).not.toContain(merged); // merged/accepted is terminal
    expect(ids).toContain(live);
    expect(ids).toContain(review);
    expect(ids).toContain(mergeReady);
    expect(ids).toContain(integration);
    expect(mergeGateCandidates(db).map((t) => t.id)).not.toContain(merged);
  });
});

describe("ISH-1132: the per-Task interval covers check-runs and both passes", () => {
  test("runMergeGates does not re-read the PR or check-runs inside RELAY_PROVIDER_POLL_MS", async () => {
    process.env.RELAY_PROVIDER_POLL_MS = "60000";
    const id = intake("ISH-1132-THROTTLE", 4100);
    toMergeReady(id);
    const { gh, calls } = countingProviders();

    await runMergeGates(db, { github: gh, checks: gh });
    expect(calls.pr).toBe(1);
    expect(calls.checks).toBe(1);
    const polledAt = getTask(db, id)!.provider_polled_at;
    expect(polledAt).not.toBeNull();

    await runMergeGates(db, { github: gh, checks: gh });
    expect(calls.pr).toBe(1); // no per-tick re-poll
    expect(calls.checks).toBe(1);

    // The interval is the existing provider_polled_at: once it is old, the next
    // pass reads the PR + check-runs again.
    db.query(`UPDATE tasks SET provider_polled_at = ? WHERE id = ?`).run(Date.now() - 60_001, id);
    await runMergeGates(db, { github: gh, checks: gh });
    expect(calls.pr).toBe(2);
    expect(calls.checks).toBe(2);
  });

  test("a PR-polled merge_ready Task does not starve the gate's check read", async () => {
    process.env.RELAY_PROVIDER_POLL_MS = "60000";
    const id = intake("ISH-1132-SHARED", 4101);
    toMergeReady(id);
    const { gh, calls } = countingProviders();

    await processWorkflow(db, { github: gh, checks: gh });
    // The provider pass links/retargets the PR; the gate then spends the same
    // interval's budget on the HEAD-pinned check read.
    expect(calls.checks).toBe(1);
    const afterFirst = { ...calls };

    await processWorkflow(db, { github: gh, checks: gh });
    expect(calls).toEqual(afterFirst); // zero calls on the next daemon tick
  });
});

describe("ISH-1132: rate-limit parsing, backoff and typed state", () => {
  test("parses the reported reset / retry-after and falls back conservatively", () => {
    const now = 1_700_000_000_000;
    const resetEpoch = Math.floor(now / 1000) + 120;
    const withHeader = providerRateLimitFromText(
      `HTTP 403: API rate limit exceeded for user ID 1.\nx-ratelimit-reset: ${resetEpoch}`,
      { now }
    );
    expect(withHeader?.resetAt).toBe(resetEpoch * 1000);

    const retryAfter = providerRateLimitFromText("You have exceeded a secondary rate limit.\nretry-after: 30", { now });
    expect(retryAfter?.resetAt).toBe(now + 30_000);

    const fallback = providerRateLimitFromText("API rate limit exceeded for user ID 1.", { now, fallbackMs: 5_000 });
    expect(fallback?.resetAt).toBe(now + 5_000);
    expect(fallback?.reason).toContain("API rate limit exceeded");

    expect(providerRateLimitFromText("a normal 502", { now })).toBeNull();
    expect(providerRateLimitFromExec({ ok: true, stdout: "rate limit", stderr: "" }, { now })).toBeNull();
  });

  test("the guard refuses calls until the reset and then clears", () => {
    let now = 1_000;
    const guard = new ProviderRateLimitGuard("github", () => now, 60_000);
    const state = guard.note({ ok: false, stdout: "", stderr: "API rate limit exceeded" });
    expect(state?.resetAt).toBe(1_000 + 60_000);
    expect(guard.blocked()).not.toBeNull();
    now = state!.resetAt;
    expect(guard.blocked()).toBeNull();
  });

  test("GhCliGitHub backs off instead of spawning more gh commands (including check-runs)", async () => {
    let calls = 0;
    const exec: Exec = () => {
      calls++;
      return { ok: false, stdout: "", stderr: "API rate limit exceeded for user ID 1" };
    };
    const gh = new GhCliGitHub(exec);

    expect(await gh.getPullRequest({ repo: "o/r", number: 1 })).toBeNull();
    expect(gh.rateLimit()).not.toBeNull();
    expect(calls).toBe(1);

    // The reader refuses the next read with NO subprocess.
    expect(await gh.getPullRequest({ repo: "o/r", number: 1 })).toBeNull();
    expect(await gh.listChecks({ repo: "o/r", number: 1 }, FULL)).toBeNull();
    expect(calls).toBe(1);
  });

  test("listChecks does not spend its second read after a rate-limited first read", async () => {
    let calls = 0;
    const exec: Exec = () => {
      calls++;
      return { ok: false, stdout: "", stderr: "secondary rate limit; retry-after: 60" };
    };
    const gh = new GhCliGitHub(exec);
    expect(await gh.listChecks({ repo: "o/r", number: 1 }, FULL)).toBeNull();
    expect(calls).toBe(1);
    expect(gh.rateLimit()?.resetAt).toBeGreaterThan(Date.now());
  });

  test("a rate-limited auth probe is a configured reader, not `not configured`", async () => {
    const seen: string[][] = [];
    const reset = Math.floor(Date.now() / 1000) + 600;
    const exec: Exec = (argv) => {
      seen.push(argv);
      if (argv[1] === "auth") {
        // The known misreport: the token looks invalid because the API is out.
        return { ok: false, stdout: "", stderr: "The token in keyring is invalid" };
      }
      if (argv[1] === "api" && argv[2] === "rate_limit") {
        return {
          ok: true,
          stdout: JSON.stringify({
            resources: { core: { limit: 5000, remaining: 0, reset } },
          }),
          stderr: "",
        };
      }
      return { ok: false, stdout: "", stderr: "API rate limit exceeded" };
    };

    const gh = await githubReaderFromEnv({}, exec, { auto: true });
    expect(gh).toBeDefined();
    expect(gh?.rateLimit()?.resetAt).toBe(reset * 1000);
    expect(seen.some((a) => a[1] === "api" && a[2] === "rate_limit")).toBe(true);

    const deps = await providerDepsFromEnv({}, exec, { autoGithub: true });
    expect(deps.github?.rateLimit()?.resetAt).toBe(reset * 1000);

    const native = await factoryNativeReviewDepsFromEnv({ RELAY_REVIEW_AUTHOR: "me" }, exec);
    expect(native?.rateLimited?.resetAt).toBe(reset * 1000);
    expect(native?.author).toBe("me");
  });
});

describe("ISH-1132: a rate limit is a typed retryable outcome, never not-configured", () => {
  test("pr-binding returns PROVIDER_RATE_LIMITED instead of PR_UNREADABLE", async () => {
    const id = intake("ISH-1132-BIND", 4200);
    const state = {
      provider: "github",
      reason: "API rate limit exceeded",
      observedAt: Date.now(),
      resetAt: Date.now() + 60_000,
    };
    const gh: GitHubReadOnly = {
      name: "rate-limited",
      readOnly: true,
      rateLimit: () => state,
      getPullRequest: () => {
        throw new Error("a rate-limited reader must not be called");
      },
      findPullRequestForBranch: () => null,
      listComments: () => [],
    };
    const r = await bindTaskPr(db, id, { github: gh });
    expect(r.status).toBe("blocked");
    expect(r.code).toBe("PROVIDER_RATE_LIMITED");
    expect(r.reason).toContain(PROVIDER_RATE_LIMITED);
  });

  test("the merge gate reports PROVIDER_RATE_LIMITED, not PROVIDER_UNREADABLE", async () => {
    const id = intake("ISH-1132-GATE", 4201);
    toMergeReady(id);
    const state = {
      provider: "github",
      reason: "API rate limit exceeded",
      observedAt: Date.now(),
      resetAt: Date.now() + 60_000,
    };
    const gh: GitHubReadOnly & ChecksReadOnly = {
      name: "rate-limited",
      readOnly: true,
      rateLimit: () => state,
      getPullRequest: () => {
        throw new Error("a rate-limited reader must not be called");
      },
      findPullRequestForBranch: () => null,
      listComments: () => [],
      listChecks: () => {
        throw new Error("a rate-limited checks reader must not be called");
      },
    };
    const runs = await runMergeGates(db, { github: gh, checks: gh, authority: { linearWrite: false, merge: true } });
    const decision = runs.find((r) => r.decision.taskId === id)!.decision;
    expect(decision.status).toBe("BLOCKED");
    const codes = decision.reasons.map((r) => r.code);
    expect(codes).toContain("PROVIDER_RATE_LIMITED");
    expect(codes).not.toContain("PROVIDER_UNREADABLE");
    expect(codes).not.toContain("CHECKS_NOT_RUN");
  });

  test("the Factory returns provider_rate_limited, not FACTORY_NATIVE_REVIEW_REQUIRED", async () => {
    const id = intake("ISH-1132-FACTORY", 4202);
    toReview(id);
    const state = {
      provider: "github",
      reason: "API rate limit exceeded for user ID 19165512",
      observedAt: Date.now(),
      resetAt: Date.now() + 60_000,
    };
    const gh: GitHubReadOnly & GitHubReviewReader = {
      name: "rate-limited",
      readOnly: true,
      rateLimit: () => state,
      getPullRequest: () => {
        throw new Error("a rate-limited reader must not be called");
      },
      findPullRequestForBranch: () => null,
      listComments: () => [],
      listReviews: () => [],
    };
    const nativeReview: NativeReviewDeps = {
      reader: gh,
      github: gh,
      author: "me",
      allowedTools: "Read Bash",
      rateLimited: state,
    };

    const result = await runFactoryTask(db, id, {
      prBinding: { github: gh },
      nativeReview,
      requireNativeReview: true,
    });
    expect(result.outcome).toBe("provider_rate_limited");
    expect(result.reason).toContain(PROVIDER_RATE_LIMITED);
    expect(result.reason).not.toContain("FACTORY_NATIVE_REVIEW_REQUIRED");
    expect(result.failure?.cause).toBe("PROVIDER_RATE_LIMITED");
    expect(result.failure?.resume).toBe("after_environment_fix");

    // ONE durable event per (provider, reset) episode, even on a second run.
    await runFactoryTask(db, id, {
      prBinding: { github: gh },
      nativeReview,
      requireNativeReview: true,
    });
    const events = db
      .query(`SELECT COUNT(*) AS n FROM events WHERE type = 'workflow.provider_rate_limited'`)
      .get() as { n: number };
    expect(events.n).toBe(1);
  });
});

describe("ISH-1132: the daemon pass stops spending calls on a rate limit", () => {
  test("one 403 backs off every later tick without a `gh` call or a throttle write", async () => {
    process.env.RELAY_PROVIDER_POLL_MS = "0"; // backoff, not the interval, is under test
    const id = intake("ISH-1132-BACKOFF", 4300);
    toReview(id);

    let calls = 0;
    const reset = new Date(Date.now() + 60 * 60_000).toUTCString();
    const exec: Exec = () => {
      calls++;
      return {
        ok: false,
        stdout: "",
        stderr: `API rate limit exceeded for user ID 19165512. (HTTP 403)\nx-ratelimit-reset: ${Math.floor(Date.now() / 1000) + 3600}`,
      };
    };
    const gh = new GhCliGitHub(exec);

    const first = await processWorkflow(db, { github: gh, checks: gh });
    expect(calls).toBe(1);
    expect(first).toEqual([]); // no fake action: the outcome is the event
    expect(getTask(db, id)!.provider_polled_at).toBeNull();

    const events = db
      .query(`SELECT COUNT(*) AS n FROM events WHERE type = 'workflow.provider_rate_limited'`)
      .get() as { n: number };
    expect(events.n).toBe(1);

    // The next daemon tick must not spawn another gh command.
    await processWorkflow(db, { github: gh, checks: gh });
    expect(calls).toBe(1);
    const after = db
      .query(`SELECT COUNT(*) AS n FROM events WHERE type = 'workflow.provider_rate_limited'`)
      .get() as { n: number };
    expect(after.n).toBe(1);

    // A DIFFERENT provider reset (a fresh episode) logs again, once.
    gh.noteRateLimit({
      provider: "github",
      reason: `rate limited until ${reset}`,
      observedAt: Date.now(),
      resetAt: Date.now() + 120_000,
    });
    calls = 0;
    await processWorkflow(db, { github: gh, checks: gh });
    expect(calls).toBe(0);
    const episodes = db
      .query(`SELECT COUNT(*) AS n FROM events WHERE type = 'workflow.provider_rate_limited'`)
      .get() as { n: number };
    expect(episodes.n).toBe(2);
  });
});
