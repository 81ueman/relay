import { readFileSync } from "node:fs";
import type { Run, RunState } from "./schema";
import { readDshEvents, turnEndReason } from "./dsh-events";

/**
 * ISH-1012 — bounded IMPLEMENT recovery policy.
 *
 * `src/factory.ts` used to STOP the Task on the first IMPLEMENT Run failure
 * (`CODING_FAILED` / `NO_IMPLEMENTATION`) while VERIFY FAIL and REVIEW FIX
 * already continued on a NEW attempt. This module is the missing MINIMAL judge:
 * it decides, from the EXISTING evidence of the failed Run, whether one fresh
 * dsh Coding Run on the SAME Task/worktree may be issued.
 *
 * It is deliberately NOT an orchestrator/state machine: the Factory still owns
 * sequencing and `workflow.recordImplementRecovery` performs the ordinary
 * phase/attempt transition. This module is a pure classifier plus the bounded
 * evidence reader.
 *
 * CONSERVATIVE BY CONSTRUCTION. A retry is issued only for:
 *   - `missing-commit` — the Run exited 0 but produced no new commit; or
 *   - `partial-commit` — the Run exited non-zero but DID commit a new revision
 *     (the coding turn made concrete progress before the process failed).
 * Everything else STOPS: ENOSPC / resource exhaustion, permission / auth /
 * launch problems, invalid (stale/refused) submissions, signalled or cancelled
 * Runs, an unconfirmed live writer, and unknown causes. The same failure with no
 * progress is stopped even inside the attempt budget.
 */

/** The prefix every IMPLEMENT recovery decision carries in a Factory reason. */
export const IMPLEMENT_RECOVERY = "IMPLEMENT_RECOVERY";

/**
 * Why an IMPLEMENT Run is NOT retried. The code is durable, bounded and goes
 * into the Factory reason + the `factory.implement_retry_refused` event.
 */
export type ImplementStopCode =
  | "NO_EXECUTION_TARGET"
  | "LAUNCH"
  | "ENOSPC"
  | "RESOURCE"
  | "PERMISSION"
  | "AUTH"
  | "INVALID_RESULT"
  | "WRITER_NOT_TERMINAL"
  | "CANCELLED"
  | "TIMEOUT"
  | "ORPHAN"
  | "UNKNOWN_CAUSE"
  | "REPEATED_FAILURE"
  | "ATTEMPT_CLOSED";

/** What the Factory does when the decision is not a retry. */
export type ImplementStopAction = "block" | "stop" | "fence";

/** The two — and only two — recoverable IMPLEMENT failure classes. */
export type ImplementFailureKind = "missing-commit" | "partial-commit";

export interface ImplementRecoveryDecision {
  retry: boolean;
  kind: ImplementFailureKind | null;
  /** Concrete, non-empty explanation (never a bare "failed"). */
  reason: string;
  /** Bounded evidence lines (Run id/state/exit/head/error). */
  evidence: string[];
  /** Stable failure signature used for the same-failure stop. */
  signature: string | null;
  /** Set when `retry` is false. */
  stop: ImplementStopCode | null;
  /** What the Factory must do when `retry` is false. */
  action: ImplementStopAction;
}

/** The bounded fields of a failed Run this policy reads (no second store). */
export type ImplementRun = Pick<
  Run,
  | "id"
  | "task_id"
  | "phase"
  | "attempt"
  | "state"
  | "exit_code"
  | "signal"
  | "head_sha"
  | "base_head_sha"
  | "error"
  | "dsh_events_path"
  | "stdout_path"
  | "stderr_path"
>;

/** The terminal Run states. Anything else still owns the single-writer fence. */
const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "exited",
  "failed",
  "cancelled",
  "timeout",
  "submitted",
]);

/** Read at most the last `maxBytes` of a Run evidence file; never throws. */
export function readEvidenceTail(path: string | null | undefined, maxBytes = 8192): string | null {
  if (!path) return null;
  try {
    const text = readFileSync(path, "utf-8");
    if (!text) return null;
    return text.length <= maxBytes ? text : text.slice(text.length - maxBytes);
  } catch {
    return null;
  }
}

/** The dsh JSONL evidence of one Run, bounded to the fields the policy needs. */
export interface ImplementTurnEvidence {
  /** Last `status.turn_end.reason.kind` ("completed"/"error"/...). */
  turnEnd: string | null;
  /** Last `status.turn_end.reason.error.code` (e.g. MISSING_CREDENTIAL). */
  turnEndCode: string | null;
  /** Last `status.turn_end.reason.error.message`. */
  turnEndMessage: string | null;
  /** Terminal `error` event messages. */
  errors: string[];
  /** Last non-empty terminal `final` text. */
  finalText: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Read the dsh JSONL evidence (the EXISTING per-Run file) — never stdout.log. */
export function readTurnEvidence(path: string | null | undefined): ImplementTurnEvidence {
  const out: ImplementTurnEvidence = {
    turnEnd: null,
    turnEndCode: null,
    turnEndMessage: null,
    errors: [],
    finalText: null,
  };
  if (!path) return out;
  for (const { event } of readDshEvents(path)) {
    const kind = turnEndReason(event);
    if (kind) out.turnEnd = kind;
    if (event.type === "status" && event.phase === "turn_end" && isRecord(event.reason)) {
      const error = event.reason.error;
      if (isRecord(error)) {
        if (typeof error.code === "string" && error.code) out.turnEndCode = error.code;
        if (typeof error.message === "string" && error.message) out.turnEndMessage = error.message;
      }
    }
    if (event.type === "error") {
      const message = event.message ?? event.error ?? event.text;
      if (typeof message === "string" && message) out.errors.push(message);
    }
    if (event.type === "final" && typeof event.text === "string" && event.text.trim()) {
      out.finalText = event.text;
    }
  }
  return out;
}

/**
 * Non-recoverable cause markers, checked in this order. The FIRST match wins and
 * names the stop code. These are the concerns other issues own (disk, resources,
 * auth, launch): Relay must stop, never retry them.
 */
const CAUSE_MARKERS: readonly [ImplementStopCode, RegExp][] = [
  ["ENOSPC", /\bENOSPC\b|no space left on device|disk (?:is )?full|quota exceeded|insufficient (?:free )?(?:disk|space)/i],
  [
    "RESOURCE",
    /\bENOMEM\b|\bEAGAIN\b|\bEMFILE\b|\bENFILE\b|out of memory|oom[- ]?kill(?:ed)?|resource (?:exhausted|exhaustion)|too many open files|rate limit(?:ed)?|too many requests/i,
  ],
  [
    "PERMISSION",
    /\bEACCES\b|\bEPERM\b|permission denied|operation not permitted|read-only file system|access denied/i,
  ],
  [
    "AUTH",
    /MISSING_CREDENTIAL|unauthori[sz]ed|\bforbidden\b|authentication (?:failed|required)|credential|api[- ]?key|token (?:expired|invalid)|login required/i,
  ],
  ["LAUNCH", /spawn failed|DSH_VERSION_MISMATCH|dsh version|command not found|\bENOENT\b/i],
];

/**
 * The dead-run / adopted-Run paths are ISH-1008's concern. This policy only
 * records that they must NOT be retried; it never diagnoses liveness itself.
 */
const ORPHAN_MARKER =
  /\borphan(?:ed)?\b|adopted run .*exceeded its .* budget|recorded pid was reused|owner pid (?:is not alive|is no longer alive)|could not be terminated/i;

const INVALID_RESULT_MARKER = /\bRUN_SUBMISSION_(?:REFUSED|REJECTED)\b|AUTHORITY|STALE_(?:RESULT|ATTEMPT|LEASE)|HEAD_MISMATCH/i;

/** The exact `NO_IMPLEMENTATION` prefix the Factory uses. */
const NO_IMPLEMENTATION = "NO_IMPLEMENTATION";
/** The exact `CODING_FAILED` prefix the Factory uses. */
const CODING_FAILED = "CODING_FAILED";

function evidenceText(run: ImplementRun | null, error: string | null, turn: ImplementTurnEvidence, stderrTail: string | null): string {
  return [
    error ?? "",
    run?.error ?? "",
    run?.signal ?? "",
    turn.turnEnd ?? "",
    turn.turnEndCode ?? "",
    turn.turnEndMessage ?? "",
    turn.errors.join("\n"),
    turn.finalText ?? "",
    stderrTail ?? "",
  ]
    .filter((s) => s.length > 0)
    .join("\n");
}

/**
 * A stable signature of a recoverable failure. `base` is where the Run started;
 * a retry that produces a NEW commit starts at a different base and therefore
 * has a different signature (progress). The same signature twice = no progress.
 */
export function implementRecoverySignature(
  kind: ImplementFailureKind,
  run: Pick<Run, "base_head_sha" | "head_sha">
): string {
  return `${kind}:${run.base_head_sha ?? "none"}`;
}

/**
 * The signature of an already-terminal implement Run, or null when that Run is
 * not a recoverable class (an environment/unknown failure is never compared —
 * it is stopped for its own cause). Used to detect the repeated-same-failure
 * stop across restarts without a new durable column.
 */
export function terminalImplementRunSignature(
  run: Pick<ImplementRun, "state" | "exit_code" | "signal" | "head_sha" | "base_head_sha">
): string | null {
  if (run.signal) return null;
  if (run.state === "exited" && run.exit_code === 0 && run.head_sha !== null && run.head_sha === run.base_head_sha) {
    return implementRecoverySignature("missing-commit", run);
  }
  if (
    run.state === "failed" &&
    !run.signal &&
    run.head_sha !== null &&
    run.base_head_sha !== null &&
    run.head_sha !== run.base_head_sha
  ) {
    return implementRecoverySignature("partial-commit", run);
  }
  return null;
}

export interface ClassifyImplementFailureInput {
  /** The terminal IMPLEMENT Run, or null when nothing was launched. */
  run: ImplementRun | null;
  /** The Factory error string (`NO_IMPLEMENTATION: …` / `CODING_FAILED: …`). */
  error: string | null;
  /** Signatures of earlier failed IMPLEMENT Runs, most recent first. */
  priorSignatures?: readonly string[];
  /** Test seam for the evidence-file reader (default: the real fs). */
  readTail?: (path: string | null | undefined, maxBytes?: number) => string | null;
  /** Test seam for the dsh JSONL reader (default: the real per-Run file). */
  readTurn?: (path: string | null | undefined) => ImplementTurnEvidence;
}

function decision(
  retry: boolean,
  fields: Omit<ImplementRecoveryDecision, "retry">
): ImplementRecoveryDecision {
  return { retry, ...fields };
}

function stop(
  stopCode: ImplementStopCode,
  action: ImplementStopAction,
  reason: string,
  evidenceLines: string[],
  signature: string | null = null
): ImplementRecoveryDecision {
  return decision(false, {
    kind: null,
    reason,
    evidence: evidenceLines,
    signature,
    stop: stopCode,
    action,
  });
}

function runEvidence(run: ImplementRun | null): string[] {
  if (!run) return [];
  const lines = [`run ${run.id}: state=${run.state}`];
  if (run.exit_code !== null) lines.push(`exit=${run.exit_code}`);
  if (run.signal) lines.push(`signal=${run.signal}`);
  lines.push(`baseHead=${run.base_head_sha ?? "none"}`, `producedHead=${run.head_sha ?? "none"}`);
  if (run.error) lines.push(`error=${run.error}`);
  return lines;
}

/**
 * Decide whether the failed IMPLEMENT attempt may start a fresh Run on a NEW
 * attempt. Pure: it reads only the failed Run row + its EXISTING evidence files
 * and never mutates anything.
 */
export function classifyImplementFailure(input: ClassifyImplementFailureInput): ImplementRecoveryDecision {
  const { run, error } = input;
  const prior = input.priorSignatures ?? [];
  const readTail = input.readTail ?? readEvidenceTail;
  const readTurn = input.readTurn ?? readTurnEvidence;
  const evidence = runEvidence(run);

  // Nothing was launched at all: a retry could only repeat the same refusal.
  if (!run) {
    return stop(
      "NO_EXECUTION_TARGET",
      "block",
      error ?? "no IMPLEMENT Run was launched (no usable execution target)",
      evidence
    );
  }

  // A non-terminal Run still owns the single-writer fence. NEVER retry (or
  // launch) while the writer is unconfirmed: the fence, not this policy, is
  // authoritative. ISH-1008 owns dead-run liveness; this only fails closed.
  if (!TERMINAL_RUN_STATES.has(run.state)) {
    return stop(
      "WRITER_NOT_TERMINAL",
      "fence",
      `run ${run.id} is still '${run.state}'; the single-writer fence is held and no second Run may start${
        error ? ` (${error})` : ""
      }`,
      evidence
    );
  }

  const turn = readTurn(run.dsh_events_path);
  const stderrTail = readTail(run.stderr_path);
  const text = evidenceText(run, error, turn, stderrTail);

  // A cancelled/signalled Run is a user/HOLD action, never an automatic rework.
  if (run.state === "cancelled" || run.signal === "cancelled") {
    return stop("CANCELLED", "stop", `run ${run.id} was cancelled${run.signal ? ` (signal ${run.signal})` : ""}; an explicit user stop is never retried`, evidence);
  }
  if (run.state === "timeout" || run.signal === "timeout") {
    return stop("TIMEOUT", "block", `run ${run.id} timed out; a resource/timeout failure is not auto-retried`, evidence);
  }

  // An adopted/dead-Run outcome belongs to ISH-1008; stop without diagnosing it.
  if (ORPHAN_MARKER.test(text)) {
    return stop(
      "ORPHAN",
      "stop",
      `run ${run.id} ended in the adopted/orphaned Run path; ISH-1008 owns it and it is not auto-retried${
        error ? ` (${error})` : ""
      }`,
      evidence
    );
  }

  // Invalid results (stale/refused submission, authority/fence violation) are
  // never reworked: a retry would launder a result that must be rejected.
  if (INVALID_RESULT_MARKER.test(error ?? "")) {
    return stop("INVALID_RESULT", "block", `run ${run.id} did not produce a valid submission: ${error}`, evidence);
  }

  // Environment/resource/auth/launch causes: STOP, never auto-fix.
  for (const [code, pattern] of CAUSE_MARKERS) {
    if (pattern.test(text)) {
      // Name the concrete marker line as well as the Factory error, so an
      // operator sees WHY the failure was classified (ENOSPC, EACCES, …).
      const marker = text
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0 && pattern.test(line));
      const detail = [error?.trim(), marker && marker !== error?.trim() ? `evidence: ${marker}` : null]
        .filter((s): s is string => !!s)
        .join("; ");
      return stop(code, "block", `${code}: ${detail || `run ${run.id} evidence matched ${code}`}`, evidence);
    }
  }

  // A terminal Run that must never be resubmitted: a submitted Run whose Task
  // did not advance, or a clean exit whose submission was already refused.
  if (run.state === "submitted") {
    return stop(
      "ATTEMPT_CLOSED",
      "stop",
      `run ${run.id} was already submitted but the Task is still on attempt ${run.attempt}; no second Run is issued`,
      evidence
    );
  }

  const isMissingCommit =
    (error ?? "").startsWith(NO_IMPLEMENTATION) &&
    run.state === "exited" &&
    run.exit_code === 0 &&
    run.head_sha !== null &&
    run.head_sha === run.base_head_sha;

  if (isMissingCommit) {
    const signature = implementRecoverySignature("missing-commit", run);
    if (prior.includes(signature)) {
      return stop(
        "REPEATED_FAILURE",
        "stop",
        `run ${run.id} exited 0 with no new commit at base ${run.base_head_sha}; the SAME missing-commit failure already repeated without progress`,
        evidence,
        signature
      );
    }
    return decision(true, {
      kind: "missing-commit",
      reason: `missing-commit: run ${run.id} exited 0 but produced no new commit (head ${run.head_sha} unchanged at base ${run.base_head_sha})`,
      evidence,
      signature,
      stop: null,
      action: "stop",
    });
  }

  // Non-zero exit: recoverable ONLY when the Run provably produced a NEW commit
  // (a concrete coding result on the SAME worktree). A bare non-zero exit with
  // no new revision is an UNKNOWN cause and is never retried.
  const isPartialCommit =
    run.state === "failed" &&
    !run.signal &&
    run.head_sha !== null &&
    run.base_head_sha !== null &&
    run.head_sha !== run.base_head_sha;

  if (isPartialCommit) {
    const signature = implementRecoverySignature("partial-commit", run);
    if (prior.includes(signature)) {
      return stop(
        "REPEATED_FAILURE",
        "stop",
        `run ${run.id} failed again at base ${run.base_head_sha} without further progress`,
        evidence,
        signature
      );
    }
    return decision(true, {
      kind: "partial-commit",
      reason: `partial-commit: run ${run.id} exited '${run.state}' (exit ${run.exit_code ?? "none"}) AFTER producing new commit ${run.head_sha}; the coding turn made concrete progress`,
      evidence,
      signature,
      stop: null,
      action: "stop",
    });
  }

  const detail = (error ?? run.error ?? "").trim();
  return stop(
    "UNKNOWN_CAUSE",
    "stop",
    `run ${run.id} did not produce a new commit (${run.state}, exit ${run.exit_code ?? "none"}); the failure cause is unknown, so it is not auto-retried${detail ? `: ${detail}` : ""}`,
    evidence
  );
}

/**
 * The Factory reason for a refused retry: always names the code and the concrete
 * cause, never a bare "failed".
 */
export function implementStopReason(d: ImplementRecoveryDecision): string {
  return d.retry ? "" : `${IMPLEMENT_RECOVERY}/${d.stop ?? "UNKNOWN_CAUSE"}: ${d.reason}`;
}
