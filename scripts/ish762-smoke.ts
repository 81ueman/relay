#!/usr/bin/env bun
/**
 * ISH-762 one-command FIXTURE smoke.
 *
 *   bun run smoke:factory
 *
 * Builds a throwaway git repo + control plane and drives the WHOLE factory with a
 * FAKE headless dsh (a shell script that commits) and a FAKE independent reviewer
 * (no network):
 *
 *   implement (real git worktree) -> structured submit -> VERIFY (real commands)
 *     -> review FIX -> fresh dsh Run on the SAME worktree with the findings
 *     -> VERIFY -> review PASS -> integration -> MergeReady (read-only, NOT merged)
 *
 * It then prints the per-Run evidence (dsh session id + JSONL path + the review
 * evidence file) and exits non-zero on the first failed assertion.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { getTask } from "../src/tasks";
import { registerWorker } from "../src/workers";
import { intakeTask } from "../src/workflow";
import { listRuns } from "../src/dsh-runner";
import { launchTaskRun, DUPLICATE_WRITER } from "../src/run-lifecycle";
import { gitHead } from "../src/verify";
import { runFactoryTask } from "../src/factory";
import type { ReviewerProcess, ReviewerSpawnContext, ReviewerSpawner } from "../src/reviewer-runner";

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

const dir = mkdtempSync(join(tmpdir(), "relay-ish762-smoke-"));
const repo = join(dir, "repo");
const binDir = join(dir, "bin");
process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** A deterministic fake reviewer: FIX on the first call, PASS after. */
function fakeReviewer(): ReviewerSpawner {
  let n = 0;
  return {
    async run(ctx: ReviewerSpawnContext): Promise<ReviewerProcess> {
      const head = gitHead(ctx.cwd);
      n++;
      const body =
        n === 1
          ? { verdict: "fix", head, findings: [{ severity: "blocker", file: "marker.txt", message: "the B marker is missing" }], summary: "incomplete" }
          : { verdict: "pass", head, findings: [], summary: "correct and complete" };
      return { exitCode: 0, signal: null, stdout: JSON.stringify(body), stderr: "" };
    },
  };
}

try {
  console.log("ISH-762 factory fixture smoke");
  mkdirSync(repo, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "smoke@test");
  git(repo, "config", "user.name", "smoke");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "base");

  const dsh = join(binDir, "dsh-fake");
  writeFileSync(
    dsh,
    `#!/bin/sh\nset -e\necho "{\\"type\\":\\"session\\",\\"sessionId\\":\\"session-fake-$RELAY_RUN_ID\\"}"\necho "$RELAY_RUN_ID" > "change-$RELAY_RUN_ID.txt"\ngit add -A\ngit -c user.email=smoke@test -c user.name=smoke commit -qm "change $RELAY_RUN_ID"\necho "{\\"type\\":\\"final\\",\\"text\\":\\"DONE\\"}"\n`
  );
  chmodSync(dsh, 0o755);
  const slowDsh = join(binDir, "dsh-slow");
  writeFileSync(slowDsh, "#!/bin/sh\nsleep 2\nexit 0\n");
  chmodSync(slowDsh, 0o755);

  process.env.RELAY_DB = join(dir, "state.db");
  const db = openDb(process.env.RELAY_DB);
  registerWorker(db, "rev", { role: "reviewer" });

  const task = intakeTask(db, {
    provider: "fixture",
    issueId: "ISH-762-SMOKE",
    codeChange: true,
    title: "add the marker file",
    checks: [{ name: "noop", command: "true" }],
  });

  // 1. Single-writer: a live Run refuses a duplicate writer on the same worktree.
  const live = await launchTaskRun(db, task.id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: slowDsh });
  assert(getTask(db, task.id)!.phase === "implement", "the task starts in the implement phase");
  let refused = false;
  try {
    await launchTaskRun(db, task.id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: dsh });
  } catch (e) {
    refused = new RegExp(DUPLICATE_WRITER).test(String(e));
  }
  assert(refused, "a duplicate writer on the same worktree/branch is REFUSED");
  await live.handle.wait();

  // 2. Fresh task: run the WHOLE factory (implement -> verify -> review FIX ->
  //    fresh Run -> verify -> review PASS -> integration -> MergeReady).
  const t2 = intakeTask(db, {
    provider: "fixture",
    issueId: "ISH-762-SMOKE-2",
    codeChange: true,
    title: "add the marker file",
    checks: [{ name: "noop", command: "true" }],
  });
  const res = await runFactoryTask(db, t2.id, {
    repo,
    worktreesRoot: join(dir, "worktrees"),
    outputRoot: join(dir, "runs"),
    dshBin: dsh,
    fastExitMs: 0,
    reviewerSpawner: fakeReviewer(),
  });
  if (res.outcome !== "merge_ready") console.error("DEBUG factory result:", JSON.stringify(res, null, 2));
  assert(res.outcome === "merge_ready", "the factory reached MergeReady");
  const t2live = getTask(db, t2.id)!;
  assert(t2live.phase === "merge_ready", "the task phase is merge_ready");
  assert(t2live.merged_at === null && t2live.accepted_at === null, "MergeReady is READ-ONLY: NOT merged, NOT accepted");
  assert(res.attempts.length === 2, "two coding attempts (FIX then PASS)");
  assert(res.attempts[0].reviewVerdict === "fix" && res.attempts[1].reviewVerdict === "pass", "review FIX then PASS");
  assert(res.attempts[0].verifyOutcome === "pass" && res.attempts[1].verifyOutcome === "pass", "mechanical VERIFY pass on both attempts");

  const runs = listRuns(db, { taskId: t2.id });
  assert(runs.length === 2 && runs[0].id !== runs[1].id, "two disposable dsh Runs (no session continuation)");

  // 3. Evidence: the per-Run dsh JSONL + session id + the review evidence file.
  const r0 = runs[0];
  assert(existsSync(r0.dsh_events_path) && readFileSync(r0.dsh_events_path, "utf-8").includes("session-fake"), "Run 1 kept its original dsh JSONL (with the session id)");
  const reviewEvidence = join(dir, "worktrees", t2.id, ".relay", "reviews");
  assert(existsSync(reviewEvidence), "the raw reviewer output is retained as per-review evidence");
  assert(res.gate !== null, `the read-only merge gate was evaluated (${res.gate?.status})`);

  // 4. A FIX never messages a Gateway; only a judgment block does (documented path).
  assert((res.steps.filter((s) => s.startsWith("review:")).length === 2), "exactly two review decisions were recorded");

  db.close();
  console.log(`\nPASS — ${steps} checks`);
} catch (e) {
  console.error(`\nFAIL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exitCode = 1;
}
