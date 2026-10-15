#!/usr/bin/env bun
/**
 * ISH-760 one-command local fixture smoke.
 *
 *   bun run smoke:run-lifecycle
 *
 * Builds a throwaway git repo + control plane and drives the REAL Task lifecycle
 * with a FAKE `dsh` binary (no network, no real dsh, no Herdr):
 *
 *   ensure worktree -> launch (pin brief) -> duplicate writer REFUSED ->
 *   submit -> implement -> verify PASS -> review FIX -> a NEW Run on the SAME
 *   worktree that inherits the findings -> submit -> review PASS -> merge ->
 *   safe cleanup (evidence retained).
 *
 * Exits non-zero on the first failed assertion.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { getTask, claimNext } from "../src/tasks";
import { registerWorker } from "../src/workers";
import { intakeTask, recordReview, confirmMerged, runMechanicalVerification, taskChecks } from "../src/workflow";
import { defaultRunner } from "../src/verify";
import { acceptRunSubmission, getRun, listRuns, DUPLICATE_WRITER } from "../src/dsh-runner";
import {
  applyWorkspaceCleanup,
  ensureTaskWorktree,
  inheritFindings,
  launchTaskRun,
} from "../src/run-lifecycle";

let steps = 0;
function ok(msg: string): void {
  steps++;
  console.log(`  ok ${steps}. ${msg}`);
}
function fail(msg: string): never {
  console.error(`  FAIL: ${msg}`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): void {
  if (cond) ok(msg);
  else fail(msg);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

const dir = mkdtempSync(join(tmpdir(), "relay-ish760-smoke-"));
const repo = join(dir, "repo");
const binDir = join(dir, "bin");
process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

try {
  console.log("ISH-760 run-lifecycle fixture smoke");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "smoke@test");
  git(repo, "config", "user.name", "smoke");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "base");

  mkdirSync(binDir, { recursive: true });
  // A fake headless dsh: writes a file, commits, prints its final text, exits 0.
  const fast = join(binDir, "dsh-fast");
  writeFileSync(
    fast,
    `#!/bin/sh\nset -e\necho "smoke: implementing [${"$"}RELAY_RUN_ID]"\necho "${"$"}RELAY_RUN_ID" > smoke-"${"$"}RELAY_RUN_ID".txt\ngit add -A\ngit -c user.email=smoke@test -c user.name=smoke commit -qm "smoke ${"$"}RELAY_RUN_ID"\necho DONE\n`
  );
  chmodSync(fast, 0o755);
  const slow = join(binDir, "dsh-slow");
  writeFileSync(slow, "#!/bin/sh\nsleep 2\nexit 0\n");
  chmodSync(slow, 0o755);

  process.env.RELAY_DB = join(dir, "state.db");
  const db = openDb(process.env.RELAY_DB);
  registerWorker(db, "impl", { role: "worker" });
  registerWorker(db, "rev", { role: "reviewer" });

  const task = intakeTask(db, {
    provider: "fixture",
    issueId: "ISH-760-SMOKE",
    codeChange: true,
    title: "smoke the run lifecycle",
    checks: [{ name: "noop", command: "true" }],
  });

  // 1. Worktree create/select.
  const wt = ensureTaskWorktree(db, task.id, { repo });
  assert(wt.created && existsSync(wt.worktree), `worktree created at ${wt.worktree} on ${wt.branch}`);
  assert(ensureTaskWorktree(db, task.id, { repo }).created === false, "worktree is SELECTED (reused) on the second call");

  // 2. Single writer: a live Run refuses a duplicate writer on the same worktree.
  const slowRun = await launchTaskRun(db, task.id, { repo, dshBin: slow, outputRoot: join(dir, "runs") });
  assert(getRun(db, slowRun.handle.id)!.state === "running", "a disposable Run is live");
  let rejected = false;
  try {
    await launchTaskRun(db, task.id, { repo, dshBin: fast, outputRoot: join(dir, "runs") });
  } catch (e) {
    rejected = new RegExp(DUPLICATE_WRITER).test(String(e));
  }
  assert(rejected, "a duplicate writer on the same worktree/branch is REFUSED");
  await slowRun.handle.wait();
  assert(getRun(db, slowRun.handle.id)!.state === "exited", "the previous Run ended, releasing the writer");

  // 3. Implement with a real (fake-dsh) Run; the brief is pinned before launch.
  const impl = await launchTaskRun(db, task.id, { repo, dshBin: fast, outputRoot: join(dir, "runs"), fastExitMs: 0 });
  assert(readFileSync(impl.briefPath, "utf-8").includes("## Worktree"), "the Run brief is pinned into the worktree before launch");
  const implRun = await impl.handle.wait();
  assert(implRun.state === "exited" && implRun.exit_code === 0, "the implement Run exited 0");
  acceptRunSubmission(db, { runId: implRun.id });
  assert(getTask(db, task.id)!.phase === "verify", "a structured submission (not exit 0) advanced implement -> verify");

  // 4. mechanical verify PASS (Relay runs the checks) -> review FIX -> implement attempt 1.
  const v1 = await runMechanicalVerification(db, task.id, {
    checks: taskChecks(getTask(db, task.id)!),
    runner: defaultRunner,
    cwd: impl.worktree,
  });
  assert(v1.outcome === "pass" && getTask(db, task.id)!.phase === "review", "mechanical verify PASS -> review");
  const badHead = getTask(db, task.id)!.head_sha;
  claimNext(db, "rev");
  recordReview(db, task.id, "rev", { verdict: "fix", headSha: badHead ?? undefined, reason: "FIX: handle the empty input" });
  const fixed = getTask(db, task.id)!;
  assert(fixed.phase === "implement" && fixed.attempt === 1, "review FIX -> implement at attempt 1 (same task)");

  // 5. FIX = SAME worktree + previous findings + a NEW Run.
  assert(inheritFindings(db, fixed).some((f) => f.reason?.includes("handle the empty input")), "the previous findings are inherited");
  const fix = await launchTaskRun(db, task.id, { repo, dshBin: fast, outputRoot: join(dir, "runs"), fastExitMs: 0 });
  assert(fix.worktree === impl.worktree, "the FIX reuses the SAME worktree");
  assert(fix.handle.id !== impl.handle.id, "the FIX is a NEW disposable Run (no session continuation)");
  assert(readFileSync(fix.briefPath, "utf-8").includes("FIX: handle the empty input"), "the FIX brief pins the prior findings");
  const fixRun = await fix.handle.wait();
  acceptRunSubmission(db, { runId: fixRun.id });
  assert(getTask(db, task.id)!.phase === "verify", "the FIX Run advanced to verify");

  // 6. FIX mechanical verify PASS -> review PASS -> integration -> observed merge.
  const v2 = await runMechanicalVerification(db, task.id, {
    checks: taskChecks(getTask(db, task.id)!),
    runner: defaultRunner,
    cwd: fix.worktree,
  });
  assert(v2.outcome === "pass" && getTask(db, task.id)!.phase === "review", "the FIX verify PASS -> review");
  const goodHead = getTask(db, task.id)!.head_sha;
  claimNext(db, "rev");
  recordReview(db, task.id, "rev", { verdict: "pass", headSha: goodHead ?? undefined });
  assert(getTask(db, task.id)!.phase === "integration", "review PASS -> integration");
  confirmMerged(db, task.id, { headSha: goodHead ?? undefined });
  assert(getTask(db, task.id)!.merged_at !== null, "the provider merge is observed (TaskMerged)");

  // 7. Safe cleanup after a real merge; evidence is retained.
  const runsBefore = listRuns(db, { taskId: task.id }).length;
  const cleanup = applyWorkspaceCleanup(db, task.id, { apply: true, repo, worktreesRoot: join(dir, "worktrees") });
  assert(cleanup.removed && !existsSync(wt.worktree), "the merged worktree is cleaned up");
  assert(cleanup.retainedRuns === runsBefore && runsBefore >= 3, `run evidence is retained (${runsBefore} runs)`);
  assert(getRun(db, fixRun.id) !== null && existsSync(fixRun.output_dir), "the FIX Run row + output dir survive cleanup");

  db.close();
  console.log(`\nPASS — ${steps} checks`);
} catch (e) {
  console.error(`\nFAIL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exitCode = 1;
}
