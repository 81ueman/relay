import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { now, openDb } from "../src/db";
import { logEvent } from "../src/events";
import { insertTaskResult } from "../src/results";
import { getTask } from "../src/tasks";
import { intakeTask } from "../src/workflow";
import {
  classifyFactoryOutcome,
  factoryOutcomesForTask,
  latestFactoryOutcome,
  recordFactoryOutcome,
  type FactoryOutcomeInput,
} from "../src/factory-failure";

/**
 * ISH-1013 fixtures: the SAME durable rows the Factory writes (a Task, a Run,
 * task_results and events). No Factory process and no mocks of the classifier:
 * each case proves the projection distinguishes the cause from real-looking
 * evidence, and that an unverified cause stays UNKNOWN.
 */

let dir = "";
let dbPath = "";
let db: Database;
let seq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-factory-failure-"));
  dbPath = join(dir, "state.db");
  process.env.RELAY_DB = dbPath;
  db = openDb(dbPath);
  seq = 0;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.RELAY_DB;
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function newTask(checks = [{ name: "noop", command: "true" }]): string {
  return intakeTask(db, {
    provider: "test",
    issueId: `ISH-1013-${seq++}`,
    codeChange: true,
    title: "factory repair exhaustion fixture",
    checks,
  }).id;
}

function setTask(
  taskId: string,
  patch: { state?: string; phase?: string | null; attempt?: number; headSha?: string | null }
): void {
  const t = getTask(db, taskId)!;
  db.query(`UPDATE tasks SET state = ?, phase = ?, attempt = ?, head_sha = ?, updated_at = ? WHERE id = ?`).run(
    patch.state ?? t.state,
    patch.phase === undefined ? t.phase : patch.phase,
    patch.attempt ?? t.attempt,
    patch.headSha === undefined ? t.head_sha : patch.headSha,
    now(),
    taskId
  );
}

function insertRun(opts: {
  taskId: string;
  attempt: number;
  state: string;
  headSha?: string | null;
  baseHeadSha?: string | null;
  exitCode?: number | null;
  error?: string | null;
  stderrPath?: string | null;
  dshPath?: string | null;
}): string {
  const id = `run-1013-${seq++}`;
  const t = now();
  db.query(
    `INSERT INTO runs
       (id, task_id, phase, attempt, generation, cwd, branch, head_sha, base_head_sha,
        prompt, output_dir, state, exit_code, signal, error, stderr_path, dsh_events_path,
        stdout_path, started_at, ended_at, created_at, updated_at)
     VALUES (?, ?, 'implement', ?, ?, ?, NULL, ?, ?, '', ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?)`
  ).run(
    id,
    opts.taskId,
    opts.attempt,
    opts.attempt,
    join(dir, "worktree"),
    opts.headSha ?? null,
    opts.baseHeadSha ?? SHA_B,
    join(dir, "run-output"),
    opts.state,
    opts.exitCode ?? null,
    opts.error ?? null,
    opts.stderrPath ?? null,
    opts.dshPath ?? null,
    t,
    t,
    t,
    t
  );
  return id;
}

function attempt(n: number, runId: string | null, extra: Partial<FactoryOutcomeInput["attempts"][number]> = {}) {
  return {
    attempt: n,
    runId,
    baseHead: SHA_B,
    producedHead: null as string | null,
    verifyOutcome: null as string | null,
    reviewVerdict: null as string | null,
    phase: "implement",
    ...extra,
  };
}

function resultInput(taskId: string, extra: Partial<FactoryOutcomeInput>): FactoryOutcomeInput {
  return {
    taskId,
    outcome: "blocked",
    head: null,
    reason: null,
    attempts: [],
    ...extra,
  };
}

describe("ISH-1013: a Factory stop is classified from existing evidence, never guessed", () => {
  test("max_attempts -> code rework exhausted, with the last Run and failing REQUIRED check", () => {
    const id = newTask([{ name: "fixed-marker", command: "test -f fixed.txt" }]);
    const run = insertRun({ taskId: id, attempt: 0, state: "submitted", headSha: SHA_A });
    setTask(id, { phase: "implement", attempt: 1, headSha: null });
    insertTaskResult(db, {
      taskId: id,
      phase: "verify",
      attempt: 0,
      kind: "VerificationResult",
      workerId: "relay",
      passed: false,
      headSha: SHA_A,
      evidenceRef: join(dir, "verify-0.log"),
      reason: "fixed-marker=fail(exit 1)",
      payload: {
        outcome: "fail",
        checks: [{ name: "fixed-marker", required: true, outcome: "fail", exitCode: 1, output: "missing fixed.txt" }],
      },
    });

    const report = classifyFactoryOutcome(
      db,
      resultInput(id, {
        outcome: "max_attempts",
        reason: "exceeded 2 attempts",
        attempts: [attempt(0, run, { producedHead: SHA_A, verifyOutcome: "fail" })],
      })
    )!;

    expect(report.class).toBe("code_rework_exhausted");
    expect(report.cause).toBe("MAX_ATTEMPTS");
    expect(report.resume).toBe("requires_rework");
    expect(report.taskId).toBe(id);
    expect(report.attempt).toBe(0);
    expect(report.taskAttempt).toBe(1);
    expect(report.runId).toBe(run);
    expect(report.head).toBe(SHA_A);
    expect(report.evidence.join("\n")).toContain(`run ${run}`);
    expect(report.evidence.join("\n")).toContain("fixed-marker=fail(exit 1)");
    expect(report.next.command).toBe(`relay run factory ${id} --max-attempts 3`);
    expect(report.next.resumeWhen).toContain("VERIFY");
  });

  test("review refusal -> missing/inconclusive evidence, naming the Run and retained reviewer evidence", () => {
    const id = newTask();
    const run = insertRun({ taskId: id, attempt: 0, state: "submitted", headSha: SHA_A });
    setTask(id, { phase: "review", state: "review", attempt: 0, headSha: SHA_A });
    const evidence = join(dir, "review-attempt-0.json");
    logEvent(db, {
      source: "factory",
      taskId: id,
      type: "factory.review_refused",
      payload: { reason: "REVIEW_NO_STRUCTURED_RESULT", message: "no JSON object in reviewer output", head: SHA_A, evidence },
    });

    const report = classifyFactoryOutcome(
      db,
      resultInput(id, {
        outcome: "review_refused",
        head: SHA_A,
        reason: "REVIEW_NO_STRUCTURED_RESULT: no JSON object in reviewer output",
        attempts: [attempt(0, run, { producedHead: SHA_A, reviewVerdict: "refused", phase: "review" })],
      })
    )!;

    expect(report.class).toBe("missing_or_inconclusive_evidence");
    expect(report.cause).toBe("REVIEW_REFUSED");
    expect(report.resume).toBe("requires_fresh_evidence");
    expect(report.requiresUnblock).toBe(false);
    expect(report.evidence.join("\n")).toContain("factory.review_refused");
    expect(report.evidence.join("\n")).toContain(evidence);
    expect(report.next.read).toContain(`relay run logs ${run}`);
    expect(report.next.command).toBe(`relay run factory ${id}`);
  });

  test("a REQUIRED check that cannot run -> CHECK_NOT_RUN; unrun is never a PASS", () => {
    const id = newTask([{ name: "hang", command: "sleep 5" }]);
    const run = insertRun({ taskId: id, attempt: 0, state: "submitted", headSha: SHA_A });
    setTask(id, { phase: "verify", state: "blocked_human", attempt: 0, headSha: SHA_A });
    insertTaskResult(db, {
      taskId: id,
      phase: "verify",
      attempt: 0,
      kind: "VerificationResult",
      workerId: "relay",
      passed: false,
      headSha: SHA_A,
      evidenceRef: join(dir, "verify-not-run.log"),
      reason: "hang=not_run",
      payload: { outcome: "not_run", checks: [{ name: "hang", required: true, outcome: "not_run", exitCode: null }] },
    });

    const report = classifyFactoryOutcome(
      db,
      resultInput(id, {
        outcome: "blocked",
        head: SHA_A,
        reason: "verify not_run: hang=not_run(exit none): timed out",
        attempts: [attempt(0, run, { producedHead: SHA_A, verifyOutcome: "not_run" })],
      })
    )!;

    expect(report.class).toBe("missing_or_inconclusive_evidence");
    expect(report.cause).toBe("CHECK_NOT_RUN");
    expect(report.requiresUnblock).toBe(true);
    expect(report.next.command).toBe(`relay unblock ${id}`);
    expect(report.next.action).toContain("unrun gate never PASSes");
  });

  test("NOT_RUN check output naming a launch/permission error is still CHECK_NOT_RUN", () => {
    const id = newTask([{ name: "required-test", command: "bun test" }]);
    const run = insertRun({ taskId: id, attempt: 0, state: "submitted", headSha: SHA_A });
    setTask(id, { phase: "verify", state: "blocked_human", attempt: 0, headSha: SHA_A });
    insertTaskResult(db, {
      taskId: id,
      phase: "verify",
      attempt: 0,
      kind: "VerificationResult",
      workerId: "relay",
      passed: false,
      headSha: SHA_A,
      evidenceRef: join(dir, "verify-noisy-not-run.log"),
      reason: "required-test=not_run",
      payload: {
        outcome: "not_run",
        checks: [
          {
            name: "required-test",
            required: true,
            outcome: "not_run",
            exitCode: null,
            output: "bash: bun: command not found; permission denied",
          },
        ],
      },
    });

    const report = classifyFactoryOutcome(
      db,
      resultInput(id, {
        outcome: "blocked",
        head: SHA_A,
        // The Factory reason embeds the raw check output. Its words must never
        // decide the cause: the structured VERIFY row says the check did not run.
        reason:
          "verify not_run: required-test=not_run(exit none): bash: bun: command not found; permission denied",
        attempts: [attempt(0, run, { producedHead: SHA_A, verifyOutcome: "not_run", phase: "verify" })],
      })
    )!;

    expect(report.class).toBe("missing_or_inconclusive_evidence");
    expect(report.cause).toBe("CHECK_NOT_RUN");
    expect(report.next.command).toBe(`relay unblock ${id}`);
  });

  test("a verify NOT_RUN reason cannot decide a cause from check output even without a stored row", () => {
    const id = newTask([{ name: "required-test", command: "bun test" }]);
    const run = insertRun({ taskId: id, attempt: 0, state: "submitted", headSha: SHA_A });
    setTask(id, { phase: "verify", state: "blocked_human", attempt: 0, headSha: SHA_A });

    const report = classifyFactoryOutcome(
      db,
      resultInput(id, {
        outcome: "blocked",
        head: SHA_A,
        reason:
          "verify not_run: required-test=not_run(exit none): permission denied; spawn failed; stale result",
        attempts: [attempt(0, run, { producedHead: SHA_A, verifyOutcome: "not_run", phase: "verify" })],
      })
    )!;

    expect(report.class).toBe("missing_or_inconclusive_evidence");
    expect(report.cause).toBe("CHECK_NOT_RUN");
  });

  test("ENOSPC -> infra blocked, with the exact cause and an explicit release after the fix", () => {
    const id = newTask();
    const run = insertRun({
      taskId: id,
      attempt: 0,
      state: "failed",
      exitCode: null,
      error: "cause=ENOSPC: no space left on device",
      stderrPath: join(dir, "stderr.log"),
    });
    setTask(id, { phase: "implement", state: "blocked_human", attempt: 1, headSha: null });

    const report = classifyFactoryOutcome(
      db,
      resultInput(id, {
        outcome: "blocked",
        reason: "IMPLEMENT_RECOVERY/ENOSPC: ENOSPC: No space left on device; evidence: write failed",
        attempts: [attempt(0, run)],
      })
    )!;

    expect(report.class).toBe("infra_blocked");
    expect(report.cause).toBe("ENOSPC");
    expect(report.resume).toBe("after_environment_fix");
    expect(report.requiresUnblock).toBe(true);
    expect(report.evidence.join("\n")).toContain("cause=ENOSPC");
    expect(report.next.read).toBe("relay status");
    expect(report.next.command).toBe(`relay unblock ${id}`);
    expect(report.next.resumeWhen).toContain("disk guard reports OK");
  });

  test("LOW_DISK (launch refusal) is distinguished from a Run's ENOSPC", () => {
    const id = newTask();
    setTask(id, { phase: "implement", state: "queued", attempt: 0, headSha: null });

    const report = classifyFactoryOutcome(
      db,
      resultInput(id, {
        outcome: "blocked",
        reason: "LOW_DISK: refusing to launch a Run: 1 GiB free on the host volume for the Run is below the 20 GiB minimum; free space and retry",
      })
    )!;

    expect(report.class).toBe("infra_blocked");
    expect(report.cause).toBe("LOW_DISK");
    expect(report.next.read).toBe("relay status");
    expect(report.next.command).toContain("relay run factory");
  });

  test("a stale/foreign HEAD -> stale head, never accepted", () => {
    const id = newTask();
    const run = insertRun({ taskId: id, attempt: 0, state: "submitted", headSha: SHA_A });
    setTask(id, { phase: "review", state: "review", attempt: 0, headSha: SHA_A });
    const evidence = join(dir, "review-stale.json");
    const reason = `REVIEW_HEAD_MISMATCH: reviewer named head ${SHA_B}, task head is ${SHA_A}`;
    logEvent(db, {
      source: "factory",
      taskId: id,
      type: "factory.review_refused",
      payload: { reason: "REVIEW_HEAD_MISMATCH", message: reason, head: SHA_A, evidence },
    });

    const report = classifyFactoryOutcome(
      db,
      resultInput(id, {
        outcome: "review_refused",
        head: SHA_A,
        reason,
        attempts: [attempt(0, run, { producedHead: SHA_A, reviewVerdict: "refused", phase: "review" })],
      })
    )!;

    expect(report.class).toBe("stale_head");
    expect(report.cause).toBe("STALE_HEAD");
    expect(report.resume).toBe("requires_fresh_evidence");
    expect(report.head).toBe(SHA_A);
    expect(report.evidence.join("\n")).toContain("REVIEW_HEAD_MISMATCH");
    expect(report.next.resumeWhen).toContain(SHA_A);
  });

  test("review findings/check output are evidence, never a guessed process cause", () => {
    const id = newTask();
    const run = insertRun({ taskId: id, attempt: 0, state: "submitted", headSha: SHA_A });
    setTask(id, { phase: "implement", attempt: 1, headSha: null });
    insertTaskResult(db, {
      taskId: id,
      phase: "review",
      attempt: 0,
      kind: "ReviewResult",
      workerId: "reviewer",
      passed: false,
      headSha: SHA_A,
      evidenceRef: join(dir, "review-fix.json"),
      // A CODE finding may mention any word; it is not proof the RUN hit ENOSPC,
      // lost permission or timed out.
      reason: "FIX: the new test prints permission denied and ENOSPC, then times out",
      payload: {
        blocked: false,
        findings: [{ severity: "blocker", message: "ENOSPC/permission denied/timeout wording in a fixture" }],
      },
    });

    const report = classifyFactoryOutcome(
      db,
      resultInput(id, {
        outcome: "max_attempts",
        reason: "exceeded 2 attempts",
        attempts: [attempt(0, run, { producedHead: SHA_A, reviewVerdict: "fix", phase: "review" })],
      })
    )!;

    expect(report.class).toBe("code_rework_exhausted");
    expect(report.cause).toBe("MAX_ATTEMPTS");
    expect(report.evidence.join("\n")).toContain("ENOSPC");
    expect(report.evidence.join("\n")).toContain("permission denied");
  });

  test("an OLD attempt-less event cannot decide a later failure (never guess)", () => {
    const id = newTask();
    // A Sandbox refusal from an earlier attempt, before the current Run started.
    db.query(
      `INSERT INTO events (timestamp, source, task_id, type, payload_json)
       VALUES (?, 'factory', ?, 'factory.sandbox_unusable', ?)`
    ).run(now() - 60_000, id, JSON.stringify({ reason: "SANDBOX_ERROR: old sandbox was removed" }));
    const run = insertRun({ taskId: id, attempt: 0, state: "failed", exitCode: 1 });
    setTask(id, { phase: "implement", state: "queued", attempt: 0, headSha: null });

    const report = classifyFactoryOutcome(
      db,
      resultInput(id, {
        outcome: "coding_failed",
        reason: "IMPLEMENT_RECOVERY/UNKNOWN_CAUSE: a bare non-zero exit, cause unknown",
        attempts: [attempt(0, run)],
      })
    )!;

    expect(report.cause).toBe("UNKNOWN");
    expect(report.class).toBe("unknown");
    expect(report.evidence.join("\n")).not.toContain("old sandbox was removed");
  });

  test("a Factory call on a terminal Task records no new failure and preserves the real outcome", () => {
    const id = newTask();
    setTask(id, { phase: "implement", state: "queued", attempt: 0, headSha: null });
    const prior = recordFactoryOutcome(
      db,
      resultInput(id, { outcome: "blocked", reason: "LOW_DISK: free space before relaunching" })
    )!;
    expect(prior.cause).toBe("LOW_DISK");
    const eventsBefore = factoryOutcomesForTask(db, id);
    expect(eventsBefore).toHaveLength(1);

    for (const state of ["done", "cancelled", "failed"] as const) {
      setTask(id, { state });
      const terminal = recordFactoryOutcome(
        db,
        resultInput(id, { outcome: "terminal", reason: `state ${state}` })
      );
      expect(terminal).toBeNull();
      // No second `factory.outcome` event replaces the real diagnosis.
      expect(factoryOutcomesForTask(db, id)).toHaveLength(eventsBefore.length);
      expect(latestFactoryOutcome(db, id)?.outcome).toBe("blocked");
      expect(latestFactoryOutcome(db, id)?.failure?.cause).toBe("LOW_DISK");
    }
  });

  test("NO_IMPLEMENTATION/REPEATED_FAILURE name the existing fresh-attempt Factory command", () => {
    const id = newTask();
    const run = insertRun({
      taskId: id,
      attempt: 1,
      state: "exited",
      exitCode: 0,
      headSha: SHA_B,
      baseHeadSha: SHA_B,
    });
    setTask(id, { phase: "implement", state: "queued", attempt: 1, headSha: null });

    const report = classifyFactoryOutcome(
      db,
      resultInput(id, {
        outcome: "no_implementation",
        reason:
          "IMPLEMENT_RECOVERY/REPEATED_FAILURE: run-1013 exited 0 with no new commit at base HEAD",
        attempts: [attempt(1, run)],
      })
    )!;

    expect(report.class).toBe("code_rework_exhausted");
    expect(report.cause).toBe("REPEATED_FAILURE");
    expect(report.next.command).toBe(`relay run factory ${id} --max-attempts 2`);
    expect(report.next.action).toContain("closed attempt/HEAD is never relaunched");
  });

  test("an unverified failure stays UNKNOWN; no resume command is invented", () => {
    const id = newTask();
    const run = insertRun({
      taskId: id,
      attempt: 0,
      state: "failed",
      exitCode: 1,
      stderrPath: join(dir, "unknown-stderr.log"),
    });
    setTask(id, { phase: "implement", state: "queued", attempt: 0, headSha: null });

    const report = classifyFactoryOutcome(
      db,
      resultInput(id, {
        outcome: "coding_failed",
        reason: "IMPLEMENT_RECOVERY/UNKNOWN_CAUSE: run run-1013-0 did not produce a new commit; the failure cause is unknown",
        attempts: [attempt(0, run)],
      })
    )!;

    expect(report.class).toBe("unknown");
    expect(report.cause).toBe("UNKNOWN");
    expect(report.resume).toBe("requires_investigation");
    expect(report.requiresUnblock).toBe(false);
    expect(report.next.command).toBeNull();
    expect(report.next.action).toContain("cause is unverified");
  });
});

describe("ISH-1013: the same projection is readable from the existing CLI surfaces", () => {
  test("run show/logs and task show expose the classification, evidence and next action", () => {
    const id = newTask([{ name: "fixed-marker", command: "test -f fixed.txt" }]);
    const run = insertRun({ taskId: id, attempt: 0, state: "submitted", headSha: SHA_A });
    setTask(id, { phase: "implement", attempt: 1, headSha: null });
    insertTaskResult(db, {
      taskId: id,
      phase: "verify",
      attempt: 0,
      kind: "VerificationResult",
      workerId: "relay",
      passed: false,
      headSha: SHA_A,
      evidenceRef: join(dir, "verify-0.log"),
      payload: { outcome: "fail", checks: [{ name: "fixed-marker", required: true, outcome: "fail", exitCode: 1 }] },
    });
    const input = resultInput(id, {
      outcome: "max_attempts",
      reason: "exceeded 2 attempts",
      attempts: [attempt(0, run, { producedHead: SHA_A, verifyOutcome: "fail" })],
    });
    const report = recordFactoryOutcome(db, input)!;
    expect(report.cause).toBe("MAX_ATTEMPTS");

    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const env = { ...process.env, RELAY_DB: dbPath };

    const show = Bun.spawnSync(["bun", cli, "run", "show", run], { env, stdout: "pipe", stderr: "pipe" });
    expect(show.exitCode).toBe(0);
    const showOut = show.stdout.toString();
    expect(showOut).toContain("factory_outcome: max_attempts");
    expect(showOut).toContain("classification: code_rework_exhausted (MAX_ATTEMPTS)");
    expect(showOut).toContain(`command: relay run factory ${id} --max-attempts 3`);

    const showJson = Bun.spawnSync(["bun", cli, "run", "show", run, "--json"], { env, stdout: "pipe", stderr: "pipe" });
    expect(showJson.exitCode).toBe(0);
    const parsed = JSON.parse(showJson.stdout.toString()) as {
      factory: { outcome: string; failure: { class: string; cause: string; next: { command: string } } };
    };
    expect(parsed.factory.outcome).toBe("max_attempts");
    expect(parsed.factory.failure.class).toBe("code_rework_exhausted");
    expect(parsed.factory.failure.cause).toBe("MAX_ATTEMPTS");
    expect(parsed.factory.failure.next.command).toBe(`relay run factory ${id} --max-attempts 3`);

    const logs = Bun.spawnSync(["bun", cli, "run", "logs", run], { env, stdout: "pipe", stderr: "pipe" });
    expect(logs.exitCode).toBe(0);
    expect(logs.stdout.toString()).toContain("--- factory outcome");
    expect(logs.stdout.toString()).toContain("classification: code_rework_exhausted (MAX_ATTEMPTS)");

    const taskShow = Bun.spawnSync(["bun", cli, "task", "show", id, "--json"], { env, stdout: "pipe", stderr: "pipe" });
    expect(taskShow.exitCode).toBe(0);
    const taskJson = JSON.parse(taskShow.stdout.toString()) as {
      factory: { failure: { class: string; cause: string } };
    };
    expect(taskJson.factory.failure.class).toBe("code_rework_exhausted");
    expect(taskJson.factory.failure.cause).toBe("MAX_ATTEMPTS");
  });
});
