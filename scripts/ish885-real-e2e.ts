#!/usr/bin/env bun
/**
 * ISH-885 REAL GitHub E2E (opt-in) — READ-ONLY Relay architecture.
 *
 *   RELAY_ISH885_E2E=1 bun scripts/ish885-real-e2e.ts
 *
 * Proves the Agent-owned GitHub workflow against a REAL disposable PR on
 * `81ueman/relay`. **Agents write; Relay only reads.**
 *
 *   - GitHub writer: this SCRIPT is a STAND-IN for the Coding Agent (it runs
 *     `git push` / `gh pr create` itself). The real dsh/DeepSeek Coding Agent leg
 *     is NOT run here (`codingAgentLeg: NOT_RUN`).
 *   - Independent headless Claude: posts a native `gh pr review` NG at A, then a
 *     PASS marker at B. The prompt pre-fills the verdict, so this demonstrates
 *     POSTING + Relay's READBACK, not an independent judgment
 *     (`independentClaudeJudgment: NOT_RUN`).
 *   - Relay: the READ-ONLY `GhCliGitHub` reader + `bindTaskPr` observe the PR at
 *     A and then at B, and `verifyNativeReview` reads Claude's reviews back and
 *     binds them to the exact HEAD. Relay has NO publisher and makes ZERO GitHub
 *     writes (statically: no write argv in `src/`).
 *
 * NOTE: coder stand-in, Claude reviewer and the `gh` login all share ONE GitHub
 * account (`81ueman`), so this run does NOT prove reviewer identity independence.
 *
 * The disposable PR + branch are cleaned up ONLY after the durable evidence file
 * is written. This script NEVER merges and NEVER pushes to the default branch.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { claimTask, getTask } from "../src/tasks";
import { registerWorker } from "../src/workers";
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
import { verifyNativeReview } from "../src/reviewer-runner";

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
    `You are a GitHub reviewer. Post a native PR review by running EXACTLY this command ` +
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
  // Honest provenance: this script stands in for the Coding Agent and pre-fills
  // Claude's verdict, and all actors share ONE GitHub account.
  codingAgentLeg: "NOT_RUN",
  githubWriter: "e2e-script stand-in (NOT dsh/DeepSeek)",
  independentClaudeJudgment: "NOT_RUN",
  reviewerIdentityIndependent: false,
  steps: [] as unknown[],
};
let prNumber: number | null = null;
const step = (name: string, data: Record<string, unknown>) => {
  (evidence.steps as unknown[]).push({ step: name, ...data, at: new Date().toISOString() });
  console.log(`- ${name}: ${JSON.stringify(data)}`);
};

try {
  // ---- Coding-Agent stand-in: scratch clone of main, branch, commit A. ----
  git(dir, "clone", "-q", "--depth", "1", "--branch", BASE, `git@github.com:${REPO}.git`, repo);
  git(repo, "config", "user.email", "ish885-standin@test");
  git(repo, "config", "user.name", "ish885-standin");
  git(repo, "checkout", "-q", "-b", branch);
  const A = commit(repo, "fixture.txt", "A\n", "A: first attempt (insufficient)");
  git(repo, "push", "-q", "-u", "origin", branch);
  const prUrl = gh("pr", "create", "--repo", REPO, "--head", branch, "--base", BASE, "--title", `ISH-885 E2E ${branch}`, "--body", "Disposable ISH-885 E2E fixture (Relay makes no GitHub writes).");
  prNumber = Number(prUrl.trim().split("/").pop());
  step("standin-push-A-create-PR", { sha: A, pr: `${REPO}#${prNumber}`, url: prUrl, actor: "e2e-script stand-in (NOT dsh/DeepSeek)" });

  process.env.RELAY_DB = join(dir, "state.db");
  const db = openDb(process.env.RELAY_DB);
  const github = new GhCliGitHub(defaultExec);
  const me = gh("api", "user", "-q", ".login");
  const native = { reader: github, github, author: me };

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

  // ---- Relay: READ-ONLY observe the PR at A. ----
  const r1 = bindTaskPr(db, task.id, { github, repo: REPO });
  if (r1.status !== "bound" || r1.remoteHead !== A) throw new Error(`relay did not bind A: ${r1.status} ${r1.reason}`);
  step("relay-read-A-bound", { status: r1.status, remoteHead: r1.remoteHead, taskHead: getTask(db, task.id)!.head_sha });

  // ---- Claude posts a native NG at A; Relay reads it back and records the NG. ----
  claudePostsReview(repo, prNumber, A, "NG", "first attempt is insufficient (ISH-885 E2E)");
  const ngRead = verifyNativeReview(db, getTask(db, task.id)!, { verdict: "fix", head: A, findings: [], summary: "" }, A, native);
  if (!ngRead.ok || !ngRead.review) throw new Error(`Relay could not read back Claude's NG at A: ${ngRead.error}`);
  step("relay-readback-NG-at-A", { ok: ngRead.ok, reviewId: ngRead.review.id, author: ngRead.review.author, headSha: ngRead.review.headSha, state: ngRead.review.state, url: ngRead.review.url });
  // Record A's REAL verdict (NG -> fix); the task returns to implement at attempt+1.
  recordReview(db, task.id, REVIEWER, { verdict: "fix", headSha: A, externalReviewer: REVIEWER, evidence: ngRead.review.url });

  // ---- Coding-Agent stand-in: FIX -> commit B pushed to the SAME PR. ----
  const B = commit(repo, "fixture.txt", "B\n", "B: FIX on the same branch");
  git(repo, "push", "-q", "origin", `${B}:refs/heads/${branch}`);
  let list: { number: number; headRefOid: string }[] = [];
  for (let i = 0; i < 10; i++) {
    const samePr = gh("pr", "list", "--repo", REPO, "--head", branch, "--state", "open", "--json", "number,headRefOid");
    list = JSON.parse(samePr) as { number: number; headRefOid: string }[];
    if (list.length === 1 && list[0]!.headRefOid === B) break;
    await Bun.sleep(1000);
  }
  if (list.length !== 1 || list[0]!.headRefOid !== B) {
    throw new Error(`the stand-in's FIX did not update the SAME PR: ls-remote=${git(repo, "ls-remote", "origin", `refs/heads/${branch}`)} list=${JSON.stringify(list)}`);
  }
  step("standin-push-B-same-PR", { sha: B, openPrs: list.length, pr: `${REPO}#${list[0]!.number}`, remoteHead: list[0]!.headRefOid, actor: "e2e-script stand-in (NOT dsh/DeepSeek)" });

  // The new head is a fresh attempt; Relay then OBSERVES B (it never pushes B).
  linkTask(db, task.id, { headSha: B });
  if (getTask(db, task.id)!.assignee !== "impl-worker") claimTask(db, task.id, "impl-worker");
  submitPhase(db, task.id, "impl-worker");
  const vB = await runMechanicalVerification(db, task.id, {
    checks: taskChecks(getTask(db, task.id)!),
    runner: { async run(spec) { return { name: spec.name, required: true, outcome: "pass", exitCode: 0, output: "ok", durationMs: 0 }; } },
    cwd: repo,
    headSha: B,
    headProbe: () => B,
  });
  if (vB.outcome !== "pass") throw new Error(`verify at B did not pass: ${vB.outcome}`);
  const r2 = bindTaskPr(db, task.id, { github, repo: REPO });
  if (r2.status !== "bound" || r2.remoteHead !== B) throw new Error(`relay did not bind B: ${r2.status} ${r2.reason}`);
  if (r2.ref?.number !== prNumber) throw new Error("the FIX bound a DIFFERENT PR (duplicate)");
  const tAfter = getTask(db, task.id)!;
  step("relay-read-B-bound", { status: r2.status, remoteHead: r2.remoteHead, pr: `${REPO}#${r2.ref?.number}`, taskHead: tAfter.head_sha, attempt: tAfter.attempt });
  if (tAfter.attempt < 1) throw new Error(`the FIX did not open a new attempt (attempt ${tAfter.attempt})`);

  // ---- Claude posts a PASS marker at B; Relay reads it back and records it. ----
  claudePostsReview(repo, prNumber, B, "OK", "the FIX at B addresses the finding (ISH-885 E2E)");
  const okRead = verifyNativeReview(db, getTask(db, task.id)!, { verdict: "pass", head: B, findings: [], summary: "" }, B, native);
  if (!okRead.ok || !okRead.review) throw new Error(`Relay could not read back Claude's OK at B: ${okRead.error}`);
  step("relay-readback-OK-at-B", { ok: okRead.ok, reviewId: okRead.review.id, author: okRead.review.author, headSha: okRead.review.headSha, state: okRead.review.state, url: okRead.review.url });
  recordReview(db, task.id, REVIEWER, { verdict: "pass", headSha: B, externalReviewer: REVIEWER, evidence: okRead.review.url });

  evidence.prNumber = prNumber;
  evidence.shas = { A, B };
  evidence.reviewIds = { ngA: ngRead.review.id, okB: okRead.review.id };
  evidence.zeroRelayWrites =
    "static: no write argv (git push / gh pr create|edit|merge|review|comment / gh api --method) in src/; Relay's gh calls are pr view / pr list / GET api only. This run shares ONE GitHub account (81ueman), so it does not independently prove that.";
  evidence.mergeReadyDrive = "NOT_RUN (full dsh+factory MergeReady covered by tests; this script proves the GitHub write/read boundary)";

  // ---- Cleanup, THEN persist evidence (so cleanup is recorded). ----
  let cleanupOk = true;
  try {
    gh("pr", "close", String(prNumber), "--repo", REPO);
    git(repo, "push", "-q", "origin", "--delete", branch);
    step("cleanup", { closed: prNumber, deletedBranch: branch });
  } catch (e) {
    cleanupOk = false;
    step("cleanup-failed", { error: e instanceof Error ? e.message : String(e) });
  }
  evidence.cleanedUp = cleanupOk;
  evidence.result = cleanupOk ? "PASS" : "FAIL";
  if (!cleanupOk) evidence.error = "cleanup failed: the disposable PR/branch may remain";
  evidence.finishedAt = new Date().toISOString();
  mkdirSync(join(process.cwd(), "docs"), { recursive: true });
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  db.close();
  if (cleanupOk) {
    console.log(`\nPASS — real GitHub PR ${REPO}#${prNumber}: stand-in pushed A then B (same PR); Claude posted NG@A and OK@B; Relay read both back via verifyNativeReview and bound each to its exact HEAD.`);
    console.log(`evidence: ${evidencePath}`);
  } else {
    console.error(`FAIL — the GitHub write/read boundary passed, but cleanup of PR ${REPO}#${prNumber} / branch ${branch} failed; the disposable resources may remain.`);
    process.exitCode = 1;
  }
} catch (e) {
  evidence.result = "FAIL";
  evidence.error = e instanceof Error ? e.stack ?? e.message : String(e);
  // Best-effort cleanup, RECORDED (never silently swallowed).
  const cleanupErrors: string[] = [];
  if (prNumber) {
    try {
      gh("pr", "close", String(prNumber), "--repo", REPO);
    } catch (ce) {
      cleanupErrors.push(`pr close: ${ce instanceof Error ? ce.message : String(ce)}`);
    }
  }
  try {
    git(repo, "push", "-q", "origin", "--delete", branch);
  } catch (ce) {
    cleanupErrors.push(`branch delete: ${ce instanceof Error ? ce.message : String(ce)}`);
  }
  if (cleanupErrors.length > 0) step("cleanup-failed", { errors: cleanupErrors });
  else if (prNumber) step("cleanup", { closed: prNumber, deletedBranch: branch });
  evidence.cleanedUp = cleanupErrors.length === 0;
  evidence.finishedAt = new Date().toISOString();
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
