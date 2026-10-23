import { describe, expect, test } from "bun:test";
import {
  classifyImplementFailure,
  implementRecoverySignature,
  implementStopReason,
  readEvidenceTail,
  terminalImplementRunSignature,
  type ImplementRun,
  type ImplementTurnEvidence,
} from "../src/implement-recovery";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * ISH-1012: the recoverability judge is deliberately small and conservative.
 * These are the explicit ALLOW/DENY cases with concrete reasons — the same
 * policy the Factory applies to a failed IMPLEMENT Run.
 */

const A = "a".repeat(40);
const B = "b".repeat(40);

function run(overrides: Partial<ImplementRun> = {}): ImplementRun {
  return {
    id: "run-test",
    task_id: "T1",
    phase: "implement",
    attempt: 0,
    state: "failed",
    exit_code: 1,
    signal: null,
    head_sha: A,
    base_head_sha: A,
    error: "exit 1",
    dsh_events_path: null,
    stdout_path: null,
    stderr_path: null,
    ...overrides,
  };
}

const NO_COMMIT = "NO_IMPLEMENTATION: run run-test exited 0 but produced no new commit";
const CODING_FAILED = "CODING_FAILED: run run-test is 'failed' (exit 1)";

const noTurn: ImplementTurnEvidence = {
  turnEnd: null,
  turnEndCode: null,
  turnEndMessage: null,
  errors: [],
  finalText: null,
};

describe("ISH-1012 classifier: recoverable IMPLEMENT failures", () => {
  test("exit 0 with NO new commit is recoverable (missing-commit) + stable signature", () => {
    const d = classifyImplementFailure({
      run: run({ state: "exited", exit_code: 0 }),
      error: NO_COMMIT,
      readTurn: () => noTurn,
    });
    expect(d.retry).toBe(true);
    expect(d.kind).toBe("missing-commit");
    expect(d.stop).toBeNull();
    expect(d.signature).toBe(`missing-commit:${A}`);
    expect(d.reason).toContain("exited 0");
    expect(d.reason).toContain("produced no new commit");
    expect(d.evidence.join("\n")).toContain("run run-test: state=exited");
    expect(d.evidence.join("\n")).toContain("exit=0");
  });

  test("a non-zero exit that DID produce a new commit is recoverable (partial-commit)", () => {
    const d = classifyImplementFailure({
      run: run({ state: "failed", exit_code: 3, base_head_sha: A, head_sha: B }),
      error: "CODING_FAILED: run run-test is 'failed' (exit 3)",
      readTurn: () => noTurn,
    });
    expect(d.retry).toBe(true);
    expect(d.kind).toBe("partial-commit");
    expect(d.signature).toBe(`partial-commit:${A}`);
    expect(d.reason).toContain("AFTER producing new commit");
    expect(d.reason).toContain(B);
  });

  test("a partial-commit failure repeated at the SAME base is stopped", () => {
    const d = classifyImplementFailure({
      run: run({ state: "failed", exit_code: 3, base_head_sha: A, head_sha: B }),
      error: "CODING_FAILED: run run-test is 'failed' (exit 3)",
      priorSignatures: [`partial-commit:${A}`],
      readTurn: () => noTurn,
    });
    expect(d.retry).toBe(false);
    expect(d.stop).toBe("REPEATED_FAILURE");
    expect(d.action).toBe("stop");
    expect(d.reason).toContain("without further progress");
  });

  test("the same missing-commit at the same base is stopped (no progress, no loop)", () => {
    const d = classifyImplementFailure({
      run: run({ state: "exited", exit_code: 0 }),
      error: NO_COMMIT,
      priorSignatures: [`missing-commit:${A}`],
      readTurn: () => noTurn,
    });
    expect(d.retry).toBe(false);
    expect(d.stop).toBe("REPEATED_FAILURE");
    expect(d.reason).toContain("SAME missing-commit failure");
  });
});

describe("ISH-1012 classifier: non-recoverable causes (never auto-fixed)", () => {
  test("ENOSPC evidence denies a missing-commit retry and BLOCKS", () => {
    const d = classifyImplementFailure({
      run: run({ state: "exited", exit_code: 0 }),
      error: NO_COMMIT,
      readTail: () => "fatal: No space left on device",
      readTurn: () => noTurn,
    });
    expect(d.retry).toBe(false);
    expect(d.stop).toBe("ENOSPC");
    expect(d.action).toBe("block");
    expect(d.reason).toContain("No space left on device");
    expect(implementStopReason(d).startsWith("IMPLEMENT_RECOVERY/ENOSPC: ")).toBe(true);
  });

  test("resource exhaustion denies a partial-commit retry", () => {
    const d = classifyImplementFailure({
      run: run({ state: "failed", exit_code: 1, head_sha: B }),
      error: CODING_FAILED,
      readTail: () => "dsh: ENOMEM: cannot allocate memory",
      readTurn: () => noTurn,
    });
    expect(d.stop).toBe("RESOURCE");
    expect(d.action).toBe("block");
  });

  test("permission failures deny even a partial commit", () => {
    const d = classifyImplementFailure({
      run: run({ state: "failed", exit_code: 1, head_sha: B }),
      error: CODING_FAILED,
      readTail: () => "dsh: EACCES: permission denied, open '.relay/run-brief.md'",
      readTurn: () => noTurn,
    });
    expect(d.stop).toBe("PERMISSION");
    expect(d.action).toBe("block");
    expect(d.reason).toContain("EACCES");
  });

  test("a provider credential failure is AUTH-denied even with a final event", () => {
    const d = classifyImplementFailure({
      run: run({ state: "failed", exit_code: 1 }),
      error: CODING_FAILED,
      readTurn: () => ({
        turnEnd: "error",
        turnEndCode: "MISSING_CREDENTIAL",
        turnEndMessage: "no API key for provider route",
        errors: [],
        finalText: "",
      }),
    });
    expect(d.stop).toBe("AUTH");
    expect(d.action).toBe("block");
    expect(d.reason).toContain("MISSING_CREDENTIAL");
  });

  test("a stale/refused submission is INVALID_RESULT-denied (never laundered)", () => {
    const d = classifyImplementFailure({
      run: run({ state: "exited", exit_code: 0, head_sha: B }),
      error: "RUN_SUBMISSION_REFUSED: run run-test was superseded by run-newer",
      readTurn: () => noTurn,
    });
    expect(d.stop).toBe("INVALID_RESULT");
    expect(d.action).toBe("block");
    expect(d.reason).toContain("superseded");
  });

  test("a non-zero exit with NO new commit is an UNKNOWN cause: stopped, not retried", () => {
    const d = classifyImplementFailure({
      run: run({ state: "failed", exit_code: 1 }),
      error: CODING_FAILED,
      readTurn: () => noTurn,
    });
    expect(d.retry).toBe(false);
    expect(d.stop).toBe("UNKNOWN_CAUSE");
    expect(d.action).toBe("stop");
    expect(d.reason).toContain("cause is unknown");
    expect(implementStopReason(d)).toContain("IMPLEMENT_RECOVERY/UNKNOWN_CAUSE");
  });

  test("a cancelled/signalled Run is never retried", () => {
    const d = classifyImplementFailure({
      run: run({ state: "cancelled", signal: "cancelled" }),
      error: CODING_FAILED,
      readTurn: () => noTurn,
    });
    expect(d.stop).toBe("CANCELLED");
    expect(d.action).toBe("stop");
  });

  test("a timeout is BLOCKED, never retried", () => {
    const d = classifyImplementFailure({
      run: run({ state: "timeout" }),
      error: "CODING_FAILED: run run-test is 'timeout'",
      readTurn: () => noTurn,
    });
    expect(d.stop).toBe("TIMEOUT");
    expect(d.action).toBe("block");
  });

  test("an unconfirmed live writer holds the fence and is never retried", () => {
    const d = classifyImplementFailure({
      run: run({ state: "running" }),
      error: "CODING_FAILED: run run-test is 'running'",
      readTurn: () => noTurn,
    });
    expect(d.stop).toBe("WRITER_NOT_TERMINAL");
    expect(d.action).toBe("fence");
    expect(d.reason).toContain("single-writer fence");
  });

  test("the adopted/orphan Run path is ISH-1008's: stopped, not diagnosed here", () => {
    const d = classifyImplementFailure({
      run: run({ state: "failed", error: "orphaned run: owner pid is not alive" }),
      error: "CODING_FAILED: orphaned run run-test: owner pid is not alive",
      readTurn: () => noTurn,
    });
    expect(d.stop).toBe("ORPHAN");
    expect(d.action).toBe("stop");
    expect(d.reason).toContain("ISH-1008");
  });
});

describe("ISH-1012: durable signatures/evidence helpers", () => {
  test("terminalImplementRunSignature only signs the two recoverable classes", () => {
    expect(terminalImplementRunSignature(run({ state: "exited", exit_code: 0 }))).toBe(`missing-commit:${A}`);
    expect(terminalImplementRunSignature(run({ state: "failed", exit_code: 1, head_sha: B }))).toBe(`partial-commit:${A}`);
    expect(terminalImplementRunSignature(run({ state: "failed", exit_code: 1 }))).toBeNull();
    expect(terminalImplementRunSignature(run({ state: "failed", exit_code: 1, head_sha: B, signal: "timeout" }))).toBeNull();
    expect(terminalImplementRunSignature(run({ state: "cancelled" }))).toBeNull();
  });

  test("implementRecoverySignature is base-HEAD scoped (a new commit = new signature)", () => {
    expect(implementRecoverySignature("missing-commit", { base_head_sha: A, head_sha: A })).toBe(`missing-commit:${A}`);
    expect(implementRecoverySignature("partial-commit", { base_head_sha: A, head_sha: B })).toBe(`partial-commit:${A}`);
    expect(implementRecoverySignature("partial-commit", { base_head_sha: B, head_sha: A })).toBe(`partial-commit:${B}`);
  });

  test("readEvidenceTail is bounded and never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-1012-"));
    try {
      const p = join(dir, "stderr.log");
      writeFileSync(p, "x".repeat(200) + "TAIL");
      expect(readEvidenceTail(p, 10)).toBe("xxxxxxTAIL");
      expect(readEvidenceTail(join(dir, "missing.log"))).toBeNull();
      expect(readEvidenceTail(null)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
