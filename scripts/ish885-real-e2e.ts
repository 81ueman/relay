#!/usr/bin/env bun
/**
 * ISH-885 REAL GitHub E2E (opt-in) — READ-ONLY Relay architecture.
 *
 *   RELAY_ISH885_E2E=1 bun scripts/ish885-real-e2e.ts
 *
 * Proves the Agent-owned GitHub workflow against a REAL disposable PR on
 * `81ueman/relay`. **Agents write; Relay only reads.**
 *
 *   - Coding Agent (this script's `git`/`gh`): push commit A, `gh pr create`;
 *     then the FIX: push commit B to the SAME PR.
 *   - Independent headless Claude: posts a native `gh pr review` NG at A, then a
 *     PASS marker at B.
 *   - Relay: the READ-ONLY `GhCliGitHub` reader + `bindTaskPr` observe the PR at
 *     A and then at B, read the reviews back, and invalidate A's evidence at B.
 *     Relay has NO publisher and makes ZERO GitHub writes.
 *
 * The full Sandbox-dsh coding leg and the Factory MergeReady drive are NOT run
 * here (see the task evidence); this script isolates the GitHub write/read
 * boundary. The disposable PR + branch are cleaned up ONLY after the durable
 * evidence file is written. This script NEVER merges and NEVER pushes to the
 * default branch.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { GhCliGitHub, defaultExec } from "../src/provider-adapters";
import { bindTaskPr } from "../src/pr-binding";

const REPO = "81ueman/relay";
const BASE = "main";
const REVIEWER = "claude";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

function gh(...args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf-8" }).trim();
}

function commit(cwd: string, file: string, contents: string, message: string): string {
  writeFileSync(join(cwd, file), contents);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/** Headless Claude posts a native GitHub review carrying an ISH-883 marker. */
function claudePostsReview(cwd: string, number: number, head: string, verdict: "NG" | "OK", note: string): void {
  const marker = `<!-- ishiul-review head=${head} verdict=${verdict} reviewer=${REVIEWER} -->`;
  const prompt =
    `You are an independent code reviewer. Post a native GitHub PR review by running EXACTLY this command ` +
    `(no other command), then reply DONE:\n\n` +
    `gh pr review ${number} --repo ${REPO} --comment --body "${marker} ${note}"\n`;
  const out = execFileSync("claude", ["-p", prompt, "--output-format", "json", "--allowedTools", "Bash"], {
    cwd,
    encoding: "utf-8",
    timeout: 240_000,
    env: process.env,
  });
  const parsed = JSON.parse(out) as { is_error?: boolean; result?: string };
  if (parsed.is_error) throw new Error(`claude reported an error: ${parsed.result ?? out.slice(0, 200)}`);
}

if (!process.env.RELAY_ISH885_E2E) {
  console.log("ISH-885 real GitHub E2E is opt-in: set RELAY_ISH885_E2E=1 to run it.");
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "relay-ish885-real-"));
const repo = join(dir, "repo");
const evidencePath = process.env.RELAY_ISH885_EVIDENCE ?? join(process.cwd(), "docs", "ish885-real-e2e-evidence.json");
const branch = `relay/e2e-ish885-${Date.now()}`;
const evidence: Record<string, unknown> = {
  task: "T16 / ISH-885",
  architecture: "read-only Relay; Agent-owned GitHub writes",
  repo: REPO,
  branch,
  startedAt: new Date().toISOString(),
  steps: [] as unknown[],
};
let prNumber: number | null = null;
const step = (name: string, data: Record<string, unknown>) => {
  (evidence.steps as unknown[]).push({ step: name, ...data, at: new Date().toISOString() });
  console.log(`- ${name}: ${JSON.stringify(data)}`);
};

try {
  // ---- Coding Agent: scratch clone of main, disposable branch, commit A. ----
  git(dir, "clone", "-q", "--depth", "1", "--branch", BASE, `git@github.com:${REPO}.git`, repo);
  git(repo, "config", "user.email", "ish885-agent@test");
  git(repo, "config", "user.name", "ish885-agent");
  git(repo, "checkout", "-q", "-b", branch);
  const A = commit(repo, "fixture.txt", "A\n", "A: first attempt (insufficient)");
  git(repo, "push", "-q", "-u", "origin", branch);
  const prUrl = gh("pr", "create", "--repo", REPO, "--head", branch, "--base", BASE, "--title", `ISH-885 E2E ${branch}`, "--body", "Disposable ISH-885 E2E fixture (Relay makes no GitHub writes).");
  prNumber = Number(prUrl.trim().split("/").pop());
  step("agent-push-A-create-PR", { sha: A, pr: `${REPO}#${prNumber}`, url: prUrl, agent: "dsh/DeepSeek (script)" });

  process.env.RELAY_DB = join(dir, "state.db");
  const db = openDb(process.env.RELAY_DB);
  const github = new GhCliGitHub(defaultExec);

  const task = intakeTask(db, {
    provider: "fixture",
    issueId: "ISH-885-E2E",
    codeChange: true,
    title: "ISH-885 real PR fixture",
    checks: [{ name: "fixture-ok", command: "true" }],
    prRepo: REPO,
    prUrl: `${REPO}#${prNumber}`,
    branch,
    headSha: A,
  });

  // Drive A to a review-pinned phase so the B head move is a real invalidation.
  registerWorker(db, "impl-worker", { role: "worker" });
  claimTask(db, task.id, "impl-worker");
  submitPhase(db, task.id, "impl-worker");
  const vA = await runMechanicalVerification(db, task.id, {
    checks: taskChecks(getTask(db, task.id)!),
    runner: { async run(spec) { return { name: spec.name, required: true, outcome: "pass", exitCode: 0, output: "ok", durationMs: 0 }; } },
    cwd: repo,
    headSha: A,
    headProbe: () => A,
  });
  if (vA.outcome !== "pass") throw new Error(`verify at A did not pass: ${vA.outcome}`);
  recordReview(db, task.id, REVIEWER, { verdict: "pass", headSha: A, externalReviewer: REVIEWER, evidence: `${REPO}#${prNumber}@${A}` });

  // ---- Relay: READ-ONLY observe the PR at A. ----
  const r1 = bindTaskPr(db, task.id, { github, repo: REPO });
  if (r1.status !== "bound" || r1.remoteHead !== A) throw new Error(`relay did not bind A: ${r1.status} ${r1.reason}`);
  step("relay-read-A-bound", { status: r1.status, created: r1.created, remoteHead: r1.remoteHead, taskHead: getTask(db, task.id)!.head_sha });

  // ---- Independent Claude: post a native NG review at A. ----
  claudePostsReview(repo, prNumber, A, "NG", "first attempt is insufficient (ISH-885 E2E)");
  const reviewsA = github.listReviews({ repo: REPO, number: prNumber }) ?? [];
  const ngA = reviewsA.find((v) => v.headSha === A && v.body.includes("verdict=NG"));
  if (!ngA) throw new Error("Claude's NG review at A was not read back from GitHub");
  step("claude-review-NG-at-A", { reviewId: ngA.id, author: ngA.author, headSha: ngA.headSha, state: ngA.state, url: ngA.url });

  // ---- Coding Agent: FIX -> commit B pushed to the SAME PR. ----
  const B = commit(repo, "fixture.txt", "B\n", "B: FIX on the same branch");
  git(repo, "push", "-q", "origin", `${B}:refs/heads/${branch}`);
  // GitHub PR metadata can lag the branch tip by a moment; recheck the exact
  // latest head (the same read Relay performs) before asserting.
  let list: { number: number; headRefOid: string }[] = [];
  for (let i = 0; i < 10; i++) {
    const samePr = gh("pr", "list", "--repo", REPO, "--head", branch, "--state", "open", "--json", "number,headRefOid");
    list = JSON.parse(samePr) as { number: number; headRefOid: string }[];
    if (list.length === 1 && list[0]!.headRefOid === B) break;
    await Bun.sleep(1000);
  }
  if (list.length !== 1 || list[0]!.headRefOid !== B) {
    throw new Error(`the Agent's FIX did not update the SAME PR: ls-remote=${git(repo, "ls-remote", "origin", `refs/heads/${branch}`)} list=${JSON.stringify(list)}`);
  }
  step("agent-push-B-same-PR", { sha: B, openPrs: list.length, pr: `${REPO}#${list[0]!.number}`, remoteHead: list[0]!.headRefOid });

  // A is invalidated by the new head; Relay then OBSERVES B (it never pushes B).
  linkTask(db, task.id, { headSha: B });
  const r2 = bindTaskPr(db, task.id, { github, repo: REPO });
  if (r2.status !== "bound" || r2.remoteHead !== B) throw new Error(`relay did not bind B: ${r2.status} ${r2.reason}`);
  if (r2.ref?.number !== prNumber) throw new Error("the FIX bound a DIFFERENT PR (duplicate)");
  const tAfter = getTask(db, task.id)!;
  step("relay-read-B-bound", { status: r2.status, created: r2.created, remoteHead: r2.remoteHead, pr: `${REPO}#${r2.ref?.number}`, taskHead: tAfter.head_sha, attempt: tAfter.attempt });
  if (tAfter.attempt !== 1) throw new Error(`A's evidence was not invalidated at B (attempt ${tAfter.attempt})`);
  if (findPassingReview(db, task.id, 1) !== null) throw new Error("A's PASS was reused at B");

  // ---- Independent Claude: post a PASS marker at B, read back. ----
  claudePostsReview(repo, prNumber, B, "OK", "the FIX at B addresses the finding (ISH-885 E2E)");
  const reviewsB = github.listReviews({ repo: REPO, number: prNumber }) ?? [];
  const okB = reviewsB.find((v) => v.headSha === B && v.body.includes("verdict=OK"));
  if (!okB) throw new Error("Claude's OK review at B was not read back from GitHub");
  step("claude-review-OK-at-B", { reviewId: okB.id, author: okB.author, headSha: okB.headSha, state: okB.state, url: okB.url });

  // ---- Relay made ZERO GitHub writes: the reviews are Claude's, the commits
  // are the Agent's, and the module has no publisher (deleted). ----
  const me = gh("api", "user", "-q", ".login");
  const authors = [...reviewsA, ...reviewsB].map((r) => r.author);
  step("no-relay-writes", { relayPublisher: "none (deleted)", reviewAuthors: [...new Set(authors)], ghLogin: me, commits: { A, B } });
  if (!authors.every((a) => a === me)) throw new Error("a review was not authored by the authenticated reviewer account");

  evidence.result = "PASS";
  evidence.prNumber = prNumber;
  evidence.shas = { A, B };
  evidence.reviewIds = { ngA: ngA.id, okB: okB.id };
  evidence.mergeReadyDrive = "NOT_RUN (full dsh+factory MergeReady covered by tests; this script proves the GitHub write/read boundary)";
  evidence.finishedAt = new Date().toISOString();
  mkdirSync(join(process.cwd(), "docs"), { recursive: true });
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`\nPASS — real GitHub PR ${REPO}#${prNumber}: Agent pushed A then B (same PR); Claude posted NG@A and OK@B; Relay read both and invalidated A. Relay wrote nothing.`);
  console.log(`evidence: ${evidencePath}`);

  // ---- Cleanup AFTER durable evidence. ----
  try {
    gh("pr", "close", String(prNumber), "--repo", REPO);
    git(repo, "push", "-q", "origin", "--delete", branch);
    step("cleanup", { closed: prNumber, deletedBranch: branch });
    evidence.cleanedUp = true;
  } catch (e) {
    evidence.cleanedUp = false;
    step("cleanup-failed", { error: e instanceof Error ? e.message : String(e) });
  }
  db.close();
} catch (e) {
  evidence.result = "FAIL";
  evidence.error = e instanceof Error ? e.stack ?? e.message : String(e);
  evidence.finishedAt = new Date().toISOString();
  if (prNumber) {
    try {
      gh("pr", "close", String(prNumber), "--repo", REPO);
      evidence.cleanedUp = true;
    } catch {
      /* best effort */
    }
  }
  try {
    git(repo, "push", "-q", "origin", "--delete", branch);
  } catch {
    /* best effort */
  }
  try {
    mkdirSync(join(process.cwd(), "docs"), { recursive: true });
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  } catch {
    /* best effort */
  }
  console.error(`FAIL: ${evidence.error}`);
  process.exitCode = 1;
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
