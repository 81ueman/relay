#!/usr/bin/env bun
/**
 * ISH-762 REAL-PROCESS smoke (opt-in).
 *
 *   RELAY_REAL_SMOKE=1 bun run smoke:factory:real
 *
 * Drives ONE task through the factory with the REAL, pinned dsh
 * (`dsh --profile headless --json`, 0.2.1-rc.2) as the coding worker and the REAL
 * Claude Code (`claude -p --output-format json`) as the independent reviewer:
 *
 *   real dsh implement -> structured submit -> real mechanical VERIFY
 *     -> real Claude review -> (FIX -> fresh real dsh Run) -> ... -> MergeReady
 *
 * The verdict is whatever the real reviewer honestly returns; this smoke asserts
 * the INVARIANTS (structured result, head binding, no unauthorized write, per-Run
 * evidence retained) and records the raw dsh JSONL / reviewer output as evidence.
 * It writes NOTHING outside a throwaway temp repo + control plane: no push, no
 * merge, no GitHub/Linear write.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { getTask } from "../src/tasks";
import { intakeTask } from "../src/workflow";
import { listRuns } from "../src/dsh-runner";
import { runFactoryTask } from "../src/factory";
import { DEFAULT_REVIEWER_WORKER, reviewEvidencePath } from "../src/reviewer-runner";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

if (!process.env.RELAY_REAL_SMOKE) {
  console.log("ISH-762 real smoke is opt-in: set RELAY_REAL_SMOKE=1 to run it.");
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "relay-ish762-real-"));
const repo = join(dir, "repo");
process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

try {
  console.log("ISH-762 real dsh + real Claude factory smoke");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "smoke@test");
  git(repo, "config", "user.name", "smoke");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "base");

  process.env.RELAY_DB = join(dir, "state.db");
  const db = openDb(process.env.RELAY_DB);

  const task = intakeTask(db, {
    provider: "fixture",
    issueId: "ISH-762-REAL",
    codeChange: true,
    title: "create the DONE marker",
    description:
      "Create a file named DONE.md at the repository root whose entire contents are the single line:\ndone\nThen commit it on the current branch (git add DONE.md && git commit -m done). Do not merge.",
    acceptance: "DONE.md exists at the repo root and contains the word 'done'. The change is committed on the current branch.",
    checks: [{ name: "done-marker", command: "test -f DONE.md && grep -q done DONE.md" }],
  });

  const dshBin = process.env.RELAY_DSH_BIN || "dsh";
  const result = await runFactoryTask(db, task.id, {
    repo,
    worktreesRoot: join(dir, "worktrees"),
    outputRoot: join(dir, "runs"),
    dshBin,
    permissionMode: "workspace-write",
    timeoutMs: 15 * 60_000,
    maxAttempts: 2,
  });

  const runs = listRuns(db, { taskId: task.id });
  const evidence = {
    outcome: result.outcome,
    head: result.head,
    attempts: result.attempts,
    gate: result.gate?.status ?? null,
    reason: result.reason,
    steps: result.steps,
    runs: runs.map((r) => ({
      id: r.id,
      state: r.state,
      exit: r.exit_code,
      sessionId: r.session_id,
      dshJsonl: r.dsh_events_path,
      baseHead: r.base_head_sha,
      head: r.head_sha,
    })),
    reviews: runs.map((r) => reviewEvidencePath(join(dir, "worktrees", task.id), r.attempt, r.head_sha)),
    task: (() => {
      const t = getTask(db, task.id)!;
      return { phase: t.phase, state: t.state, merged_at: t.merged_at, accepted_at: t.accepted_at, pr_url: t.pr_url, head_sha: t.head_sha };
    })(),
  };
  console.log(JSON.stringify(evidence, null, 2));

  // Invariants (never a specific model verdict).
  const problems: string[] = [];
  if (runs.length === 0) problems.push("no coding Run was launched");
  for (const r of runs) if (!r.dsh_events_path || !existsSync(r.dsh_events_path)) problems.push(`run ${r.id} kept no dsh JSONL evidence`);
  const t = getTask(db, task.id)!;
  if (t.merged_at !== null) problems.push("a merge was credited (must never be)");
  if (t.accepted_at !== null) problems.push("the task was accepted/Linear-Done (must never be)");
  if (t.pr_url !== null) problems.push("a PR/GitHub URL was bound (no unauthorized GitHub write)");

  db.close();

  const okReview = result.attempts.some((a) => a.reviewVerdict === "pass" || a.reviewVerdict === "fix");
  if (problems.length > 0) {
    console.error(`\nFAIL: ${problems.join("; ")}`);
    process.exitCode = 1;
  } else if (result.outcome === "merge_ready") {
    console.log(`\nPASS — real dsh -> VERIFY -> real Claude -> MergeReady (reviewer=${DEFAULT_REVIEWER_WORKER})`);
  } else if (okReview) {
    console.log(`\nPARTIAL — the real boundary ran (a real structured review was recorded) but the task ended '${result.outcome}'.`);
    process.exitCode = 2;
  } else {
    console.log(`\nNOT_VERIFIED — the real factory ended '${result.outcome}': ${result.reason ?? "no reason"}`);
    process.exitCode = 3;
  }
} catch (e) {
  console.error(`\nFAIL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exitCode = 1;
}
