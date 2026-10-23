import type { Database } from "bun:sqlite";
import { logEvent } from "./events";
import { findTaskResult } from "./results";
import { getTask } from "./tasks";
import { isTerminalTaskState, type Run, type Task } from "./schema";

/**
 * ISH-1013 — the operator/Gateway view of a Factory that stopped.
 *
 * The Factory already records a durable outcome (`max_attempts`, `coding_failed`,
 * `blocked`, `review_refused`, …), a concrete `reason`, per-attempt Run/HEAD
 * rows, `task_results` and events. This module adds ONE read-only projection on
 * top of those existing rows: a minimal classification, the failing evidence
 * references, and the next required operation. It creates no state machine, no
 * second evidence store and no automatic unblock.
 *
 * The projection is written once per Factory result as a `factory.outcome`
 * event (best effort) so a restart and `relay run show/logs` see the SAME
 * classification without re-running anything, and a later success supersedes an
 * older failure in `task show`. Classification itself never mutates the Task;
 * only an explicit human `relay unblock` (or a normal Factory re-entry) does that.
 */

export const FACTORY_OUTCOME_EVENT = "factory.outcome";

/** The minimal operator classification. */
export const FACTORY_FAILURE_CLASSES = [
  "code_rework_exhausted",
  "infra_blocked",
  "permission_or_human_decision",
  "missing_or_inconclusive_evidence",
  "stale_head",
  "unknown",
] as const;
export type FactoryFailureClass = (typeof FACTORY_FAILURE_CLASSES)[number];

/**
 * The concrete, evidence-derived cause. This is deliberately FINER than the
 * classification: it names the check/review/run marker that was actually seen,
 * never a guessed cause. `UNKNOWN` means exactly that — no marker matched.
 */
export const FACTORY_FAILURE_CAUSES = [
  "MAX_ATTEMPTS",
  "NO_IMPLEMENTATION",
  "REPEATED_FAILURE",
  "REVIEW_REFUSED",
  "REVIEW_BLOCKED",
  "CHECK_NOT_RUN",
  "NO_REQUIRED_CHECK",
  "EVIDENCE_UNAVAILABLE",
  "ENOSPC",
  "LOW_DISK",
  "RESOURCE",
  "LAUNCH",
  "TIMEOUT",
  "ORPHAN",
  "WORKSPACE",
  "WRITER_ACTIVE",
  "PERMISSION",
  "AUTH",
  "HUMAN_HOLD",
  "STALE_HEAD",
  "STALE_EVIDENCE",
  "UNKNOWN",
] as const;
export type FactoryFailureCause = (typeof FACTORY_FAILURE_CAUSES)[number];

/**
 * What may resume the Task. This distinguishes a transient environment cause
 * (`after_environment_fix`, `after_writer_finishes`) from a state a human must
 * explicitly release (`requires_unblock`). A resolved environment cause still
 * needs the ordinary `relay unblock` when the Task is parked.
 */
export const FACTORY_FAILURE_RESUMES = [
  "safe_rerun",
  "after_environment_fix",
  "after_writer_finishes",
  "requires_unblock",
  "requires_fresh_evidence",
  "requires_rework",
  "requires_investigation",
] as const;
export type FactoryFailureResume = (typeof FACTORY_FAILURE_RESUMES)[number];

export interface FactoryFailureNext {
  /** What is wrong and what must be fixed before resuming. */
  action: string;
  /** Which existing Run/Task surface to read (never a new one). */
  read: string | null;
  /**
   * The existing safe resume operation, when one exists. A human HOLD, a live
   * writer, missing permission and stale evidence never get an automatic one.
   */
  command: string | null;
  /** The condition that permits resume — the operator's acceptance gate. */
  resumeWhen: string;
}

export interface FactoryFailureReport {
  class: FactoryFailureClass;
  cause: FactoryFailureCause;
  resume: FactoryFailureResume;
  /** True when the Task is parked and an explicit `relay unblock` is required. */
  requiresUnblock: boolean;
  taskId: string;
  /** The attempt of the LAST Run/evidence (not necessarily the Task's attempt). */
  attempt: number;
  /** The Task's current attempt (a block may already have advanced it). */
  taskAttempt: number;
  head: string | null;
  runId: string | null;
  runState: string | null;
  runExitCode: number | null;
  /** Bounded references to the failing Run/check/review/log. */
  evidence: string[];
  next: FactoryFailureNext;
}

/** The fields of a Factory result this projection needs (no import cycle). */
export interface FactoryAttemptInput {
  attempt: number;
  runId: string | null;
  baseHead: string | null;
  producedHead: string | null;
  verifyOutcome: string | null;
  reviewVerdict: string | null;
  phase: string | null;
}

export interface FactoryOutcomeInput {
  taskId: string;
  outcome: string;
  head: string | null;
  reason: string | null;
  attempts: FactoryAttemptInput[];
}

export interface StoredFactoryOutcome {
  eventId: number;
  at: number;
  outcome: string;
  reason: string | null;
  failure: FactoryFailureReport | null;
}

const MAX_EVIDENCE_LINES = 12;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function text(value: unknown, max = 600): string | null {
  if (typeof value !== "string") return null;
  const one = value.replace(/\s+/g, " ").trim();
  if (!one) return null;
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 12) : "-";
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parsePayload(json: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function latestEvent(
  db: Database,
  taskId: string,
  type: string
): { id: number; timestamp: number; payload: Record<string, unknown> } | null {
  const row = db
    .query(`SELECT id, timestamp, payload_json FROM events WHERE task_id = ? AND type = ? ORDER BY id DESC LIMIT 1`)
    .get(taskId, type) as { id: number; timestamp: number; payload_json: string } | null;
  if (!row) return null;
  const payload = parsePayload(row.payload_json);
  return payload ? { id: row.id, timestamp: row.timestamp, payload } : null;
}

/* -------------------------------------------------------------------------- */
/* Evidence collection (existing rows only)                                    */
/* -------------------------------------------------------------------------- */

interface CollectedEvidence {
  lines: string[];
  /**
   * PROCESS-level cause text only (Factory reason, Run error/signal/state and
   * Factory events). Arbitrary check output or review findings are evidence for
   * the operator, but they are not a verified process cause and must never
   * decide the classification.
   */
  causeText: string[];
  reviewBlocked: boolean;
  reviewRefused: boolean;
  /**
   * The structured VERIFY row at this attempt says a REQUIRED check did not run
   * (`not_run`/`inconclusive`). This is verified process evidence and must decide
   * CHECK_NOT_RUN before any regex, because the Factory reason embeds raw check
   * output (which may legitimately contain "command not found" or "permission
   * denied" without proving a launch/permission cause).
   */
  verifyNotRun: boolean;
}

function addEvidence(collected: CollectedEvidence, line: string): void {
  if (collected.lines.length >= MAX_EVIDENCE_LINES) return;
  collected.lines.push(line);
}

function collectRunEvidence(run: Run | null, collected: CollectedEvidence): void {
  if (!run) return;
  const logs = [run.stderr_path, run.dsh_events_path].filter((p): p is string => !!p);
  const line =
    `run ${run.id} (implement/${run.attempt}) state=${run.state}` +
    `${run.exit_code !== null ? ` exit=${run.exit_code}` : ""}` +
    `${run.signal ? ` signal=${run.signal}` : ""}` +
    ` base=${shortSha(run.base_head_sha)} produced=${shortSha(run.head_sha)}` +
    `${logs.length ? ` logs=${logs.join(", ")}` : ""}` +
    `${run.error ? ` error=${text(run.error, 240) ?? ""}` : ""}`;
  addEvidence(collected, line);
  collected.causeText.push(run.error ?? "", run.signal ?? "", run.state);
}

function parseChecks(payload: Record<string, unknown> | null): Record<string, unknown>[] {
  if (!payload || !Array.isArray(payload.checks)) return [];
  return payload.checks.filter((c): c is Record<string, unknown> => isRecord(c));
}

function collectVerificationEvidence(
  db: Database,
  task: Task,
  attempt: number,
  collected: CollectedEvidence
): void {
  const row = findTaskResult(db, task.id, "verify", attempt, "VerificationResult");
  if (!row) return;
  const payload = parsePayload(row.payload_json);
  const checks = parseChecks(payload);
  const outcome = typeof payload?.outcome === "string" ? payload.outcome : null;
  const requiredUnrun = checks.some(
    (c) => c.required !== false && ["not_run", "inconclusive"].includes(String(c.outcome ?? ""))
  );
  // The aggregate outcome is authoritative (`fail` outranks a not_run check and
  // is a real code failure). Fall back to the per-check rows only when a legacy
  // payload carries no aggregate outcome.
  if (outcome === "not_run" || outcome === "inconclusive" || (!outcome && requiredUnrun)) {
    collected.verifyNotRun = true;
  }
  const failing = checks.filter((c) => c.required !== false && String(c.outcome ?? "") !== "pass");
  const failingText = failing
    .map((c) => {
      const exit = typeof c.exitCode === "number" ? `(exit ${c.exitCode})` : "";
      return `${String(c.name ?? "?")}=${String(c.outcome ?? "?")}${exit}`;
    })
    .join(",");
  addEvidence(
    collected,
    `verify/${attempt} result#${row.id}: passed=${row.passed ?? "-"} head=${shortSha(row.head_sha)}` +
      `${failingText ? ` failing=${failingText}` : ""}` +
      `${row.evidence_ref ? ` evidence=${row.evidence_ref}` : ""}` +
      `${row.reason ? ` reason=${text(row.reason, 240) ?? ""}` : ""}`
  );
}

function collectReviewEvidence(
  db: Database,
  task: Task,
  attempt: number,
  collected: CollectedEvidence
): void {
  const row = findTaskResult(db, task.id, "review", attempt, "ReviewResult");
  if (!row) return;
  const payload = parsePayload(row.payload_json);
  if (payload?.blocked === true) collected.reviewBlocked = true;
  addEvidence(
    collected,
    `review/${attempt} result#${row.id}: passed=${row.passed ?? "-"} head=${shortSha(row.head_sha)}` +
      `${payload?.blocked === true ? " blocked=true" : ""}` +
      `${row.evidence_ref ? ` evidence=${row.evidence_ref}` : ""}` +
      `${row.reason ? ` reason=${text(row.reason, 240) ?? ""}` : ""}`
  );
}

function eventAttempt(payload: Record<string, unknown>): number | null {
  return numberField(payload.attempt) ?? numberField(payload.fromAttempt);
}

function collectEventEvidence(
  db: Database,
  task: Task,
  attempt: number,
  runStartedAt: number | null,
  collected: CollectedEvidence
): void {
  const types = [
    "factory.implement_retry_refused",
    "factory.implement_blocked",
    "factory.review_refused",
    "factory.attempt_closed",
    "factory.blocked_internal",
  ];
  for (const type of types) {
    const event = latestEvent(db, task.id, type);
    if (!event) continue;
    // A refusal event for a DIFFERENT attempt/HEAD is not this failure's
    // evidence. Never let an older attempt's marker decide the cause.
    const at = eventAttempt(event.payload);
    if (at !== null && at !== attempt) continue;
    // An attempt-less event older than the current Run is stale evidence: it
    // must not decide this failure's cause.
    if (at === null && runStartedAt !== null && event.timestamp < runStartedAt) continue;
    if (type === "factory.review_refused") {
      const namedHead = text(event.payload.head, 64);
      if (namedHead && task.head_sha && namedHead !== task.head_sha) continue;
      collected.reviewRefused = true;
    }
    const detail = [event.payload.reason, event.payload.message, event.payload.stop, event.payload.action]
      .map((v) => text(v, 300))
      .filter((v): v is string => !!v)
      .join("; ");
    const evidence = text(event.payload.evidence, 300);
    addEvidence(
      collected,
      `event #${event.id} ${type}: ${detail || "recorded"}${evidence ? ` evidence=${evidence}` : ""}`
    );
    collected.causeText.push(detail);
  }
}

/* -------------------------------------------------------------------------- */
/* Classification                                                              */
/* -------------------------------------------------------------------------- */

const STALE_HEAD_RE = /HEAD_MISMATCH|HEAD_MOVED|stale (?:head|review|result|attempt)|old head|worktree HEAD .*!=|review head .*!=/i;
const STALE_EVIDENCE_RE = /\bSTALE_(?:RESULT|ATTEMPT|LEASE)\b/i;
const ENOSPC_RE = /\bENOSPC\b|no space left on device|SQLITE_FULL|\bEDQUOT\b|disk (?:is )?full|quota exceeded/i;
const LOW_DISK_RE = /\bLOW_DISK\b|DISK_PROBE_FAILED|free-space probe failed|below the .* minimum|launch guard/i;
const PERMISSION_RE =
  /\bEACCES\b|\bEPERM\b|permission denied|operation not permitted|read-only file system|access denied|\bPERMISSION\b|REVIEW_NOT_INDEPENDENT|\bAUTHORITY\b/i;
const AUTH_RE =
  /MISSING_CREDENTIAL|unauthori[sz]ed|\bforbidden\b|authentication (?:failed|required)|credential|api[- ]?key|token (?:expired|invalid)|login required|\bAUTH\b/i;
const HUMAN_HOLD_RE = /\bHOLD\b|human (?:hold|decision|release)|operator (?:hold|cancel)/i;
const WRITER_ACTIVE_RE =
  /single-writer|still (?:live|running)|writer fence|second writer|unfinished writer|refusing a new attempt|cannot start a second/i;
const WORKSPACE_RE = /review workspace|no worktree|WORKTREE_ERROR|worktree .*missing|workspace .*missing/i;
const LAUNCH_RE = /spawn failed|DSH_VERSION_MISMATCH|command not found|\bENOENT\b|dsh version/i;
const ORPHAN_RE = /\bORPHAN\b|orphaned|adopted run|recorded pid was reused|could not be terminated/i;
const TIMEOUT_RE = /\bTIMEOUT\b|timed out|\btimeout\b/i;
const RESOURCE_RE =
  /\bENOMEM\b|\bEAGAIN\b|\bEMFILE\b|\bENFILE\b|out of memory|oom[- ]?kill(?:ed)?|resource (?:exhausted|exhaustion)|too many open files|rate limit(?:ed)?|too many requests/i;
const REVIEW_REFUSED_RE =
  /REVIEW_NO_STRUCTURED_RESULT|REVIEW_PROCESS_FAILED|REVIEW_ERROR|no structured verdict|reviewer (?:exited|returned)/i;
const EVIDENCE_UNAVAILABLE_RE =
  /PR_BINDING.*(?:UNREADABLE|NOT_OPEN)|PROVIDER_UNREADABLE|PR_UNREADABLE|evidence .*unreadable|could not read/i;
const CHECK_NOT_RUN_RE = /\bNOT_RUN\b|\bINCONCLUSIVE\b|unrun (?:gate|check)|check .* could not run/i;

/**
 * The Factory's VERIFY-block reason is `verify <outcome>: <per-check output>`.
 * The per-check tail is arbitrary output and must stay EVIDENCE, never decide a
 * process cause (a test may print "permission denied" or "command not found"
 * legitimately). Keep only the structured outcome for cause detection.
 */
function factoryReasonCauseText(reason: string | null): string {
  if (!reason) return "";
  const verify = /^\s*verify\s+(\w+)\s*:/.exec(reason);
  return verify ? `verify ${verify[1]}` : reason;
}

function detectCause(
  input: FactoryOutcomeInput,
  task: Task,
  collected: CollectedEvidence
): FactoryFailureCause {
  const text = collected.causeText.join("\n");
  // A structured reviewer BLOCKED verdict is a human decision: its arbitrary
  // summary text must not be re-read as an infra/permission/stale marker.
  if (collected.reviewBlocked) return "REVIEW_BLOCKED";
  // A structured VERIFY result (not_run/inconclusive for a REQUIRED check) is
  // verified process evidence and is decided BEFORE any regex. The Factory reason
  // for this stop embeds raw check output, which must not be read as a launch,
  // permission, auth or stale marker. It is also the same evidence a later
  // re-entry reads back from the parked Task.
  if (collected.verifyNotRun) return "CHECK_NOT_RUN";
  if (STALE_HEAD_RE.test(text)) return "STALE_HEAD";
  if (ENOSPC_RE.test(text)) return "ENOSPC";
  if (LOW_DISK_RE.test(text)) return "LOW_DISK";
  if (PERMISSION_RE.test(text)) return "PERMISSION";
  if (AUTH_RE.test(text)) return "AUTH";
  if (HUMAN_HOLD_RE.test(text)) return "HUMAN_HOLD";
  if (WRITER_ACTIVE_RE.test(text)) return "WRITER_ACTIVE";
  if (WORKSPACE_RE.test(text)) return "WORKSPACE";
  if (LAUNCH_RE.test(text)) return "LAUNCH";
  if (ORPHAN_RE.test(text)) return "ORPHAN";
  // A check's own "timed out" output is CHECK_NOT_RUN evidence, not a Run-level
  // timeout: detect the unrun gate BEFORE the generic timeout marker.
  if (CHECK_NOT_RUN_RE.test(text)) return "CHECK_NOT_RUN";
  // A refused/failed reviewer is missing evidence, not a Run timeout/resource
  // failure; keep the structured refusal ahead of generic process markers.
  if (input.outcome === "review_refused" || collected.reviewRefused || REVIEW_REFUSED_RE.test(text)) {
    return "REVIEW_REFUSED";
  }
  if (TIMEOUT_RE.test(text)) return "TIMEOUT";
  if (RESOURCE_RE.test(text)) return "RESOURCE";
  if (input.outcome === "no_checks") return "NO_REQUIRED_CHECK";
  if (EVIDENCE_UNAVAILABLE_RE.test(text)) return "EVIDENCE_UNAVAILABLE";
  if (STALE_EVIDENCE_RE.test(text)) return "STALE_EVIDENCE";
  if (input.outcome === "max_attempts") return "MAX_ATTEMPTS";
  if (input.outcome === "no_implementation") {
    return /REPEATED_FAILURE/i.test(text) ? "REPEATED_FAILURE" : "NO_IMPLEMENTATION";
  }
  if (task.state === "blocked_human" || task.state === "blocked_internal") {
    // A parked Task with no recognised cause is a human-release state, never a
    // guessed code/infra cause. The next action still says to read the evidence.
    return "HUMAN_HOLD";
  }
  return "UNKNOWN";
}

function classFor(cause: FactoryFailureCause): FactoryFailureClass {
  switch (cause) {
    case "MAX_ATTEMPTS":
    case "NO_IMPLEMENTATION":
    case "REPEATED_FAILURE":
      return "code_rework_exhausted";
    case "ENOSPC":
    case "LOW_DISK":
    case "RESOURCE":
    case "LAUNCH":
    case "TIMEOUT":
    case "ORPHAN":
    case "WORKSPACE":
    case "WRITER_ACTIVE":
      return "infra_blocked";
    case "PERMISSION":
    case "AUTH":
    case "HUMAN_HOLD":
    case "REVIEW_BLOCKED":
      return "permission_or_human_decision";
    case "REVIEW_REFUSED":
    case "CHECK_NOT_RUN":
    case "NO_REQUIRED_CHECK":
    case "EVIDENCE_UNAVAILABLE":
      return "missing_or_inconclusive_evidence";
    case "STALE_HEAD":
    case "STALE_EVIDENCE":
      return "stale_head";
    case "UNKNOWN":
    default:
      return "unknown";
  }
}

function resumeFor(cause: FactoryFailureCause): FactoryFailureResume {
  switch (cause) {
    case "ENOSPC":
    case "LOW_DISK":
    case "RESOURCE":
    case "LAUNCH":
    case "TIMEOUT":
    case "ORPHAN":
    case "WORKSPACE":
      return "after_environment_fix";
    case "WRITER_ACTIVE":
      return "after_writer_finishes";
    case "PERMISSION":
    case "AUTH":
    case "HUMAN_HOLD":
    case "REVIEW_BLOCKED":
      return "requires_unblock";
    case "REVIEW_REFUSED":
    case "CHECK_NOT_RUN":
    case "NO_REQUIRED_CHECK":
    case "EVIDENCE_UNAVAILABLE":
      return "requires_fresh_evidence";
    case "STALE_HEAD":
    case "STALE_EVIDENCE":
      return "requires_fresh_evidence";
    case "MAX_ATTEMPTS":
    case "NO_IMPLEMENTATION":
    case "REPEATED_FAILURE":
      return "requires_rework";
    case "UNKNOWN":
    default:
      return "requires_investigation";
  }
}

function attemptBudget(reason: string | null, report: Pick<FactoryFailureReport, "attempt" | "taskAttempt">): number {
  const m = /exceeded (\d+) attempts/i.exec(reason ?? "");
  const parsed = m ? Number(m[1]) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return Math.max(report.attempt, report.taskAttempt, 1);
}

function nextFor(
  cause: FactoryFailureCause,
  report: Pick<
    FactoryFailureReport,
    "taskId" | "attempt" | "taskAttempt" | "head" | "runId" | "requiresUnblock"
  >,
  reason: string | null
): FactoryFailureNext {
  const taskId = report.taskId;
  const run = report.runId;
  const read = run ? `relay run logs ${run} --tail 100` : `relay task show ${taskId}`;
  const show = run ? `relay run show ${run}` : `relay task show ${taskId}`;
  const unblock = `relay unblock ${taskId}`;
  const factory = `relay run factory ${taskId}`;
  const head = report.head ?? "the Task's current HEAD";

  switch (cause) {
    case "ENOSPC":
      return {
        action:
          `The Run hit a full disk (ENOSPC); the Factory never auto-retries this. ` +
          `Free space on the Run volume, then ${report.requiresUnblock ? `\`${unblock}\`` : `re-run \`${factory}\``} to start a fresh attempt.`,
        read: report.requiresUnblock ? `relay status` : read,
        command: report.requiresUnblock ? unblock : factory,
        resumeWhen: "the disk guard reports OK (or the Run volume is below its threshold) and no live writer holds the worktree",
      };
    case "LOW_DISK":
      return {
        action:
          `The pre-launch disk guard refused the Run (LOW_DISK); nothing was launched. ` +
          `Free space, then ${report.requiresUnblock ? `\`${unblock}\`` : `re-run \`${factory}\``}.`,
        read: "relay status",
        command: report.requiresUnblock ? unblock : factory,
        resumeWhen: "the disk guard reports OK and no live writer holds the worktree",
      };
    case "RESOURCE":
      return {
        action:
          "The Run hit a resource/rate limit (memory, file descriptors, provider rate); the Factory never auto-retries this. " +
          "Reduce the pressure or raise the budget, then resume.",
        read,
        command: report.requiresUnblock ? unblock : factory,
        resumeWhen: "the resource pressure is gone and no live writer holds the worktree",
      };
    case "TIMEOUT":
      return {
        action:
          "The Run timed out; a timeout is not auto-retried. Fix the stalled step or raise the Run budget, then resume.",
        read,
        command: report.requiresUnblock ? unblock : factory,
        resumeWhen: "the step no longer stalls and the Run completes inside its budget",
      };
    case "LAUNCH":
      return {
        action:
          "The Run could not be launched (dsh executable/version or spawn environment). Fix that environment, then resume.",
        read,
        command: report.requiresUnblock ? unblock : factory,
        resumeWhen: "the dsh launch probe succeeds and no live writer holds the worktree",
      };
    case "WORKSPACE":
      return {
        action:
          "The Task worktree/review workspace is missing or unusable. Restore it; Relay never recreates or guesses evidence.",
        read,
        command: report.requiresUnblock ? unblock : factory,
        resumeWhen: "the recorded worktree/HEAD exists and matches the Task",
      };
    case "ORPHAN":
      return {
        action:
          "The Run ended on the adopted/orphaned path (ISH-1008 owns liveness). Read its classified cause; do not relaunch a dead writer.",
        read: show,
        command: report.requiresUnblock ? unblock : null,
        resumeWhen: "the liveness sweep has made the Run terminal and the single-writer fence is released",
      };
    case "WRITER_ACTIVE":
      return {
        action:
          "A live writer still owns this Task/worktree. Wait for it to finish; never launch a second writer or auto-release its attempt.",
        read: show,
        command: null,
        resumeWhen: "the named Run is terminal and re-entry can adopt or reuse it without a second writer",
      };
    case "PERMISSION":
      return {
        action:
          "The Run/review lacks a required permission or independent identity. Restore it, then explicitly release the parked Task.",
        read,
        command: report.requiresUnblock ? unblock : null,
        resumeWhen: "the required permission/identity is present and a human explicitly unblocks the Task",
      };
    case "AUTH":
      return {
        action:
          "The provider credential/authentication is missing or rejected. Restore it; Relay never auto-retries an auth failure.",
        read,
        command: report.requiresUnblock ? unblock : null,
        resumeWhen: "the provider credential works and a human explicitly unblocks the Task",
      };
    case "HUMAN_HOLD":
      return {
        action:
          "This Task is parked by a human HOLD/decision. Read the Task notes and decide; only an explicit human release may resume it.",
        read: `relay task show ${taskId}`,
        command: report.requiresUnblock ? unblock : null,
        resumeWhen: "a human resolves the HOLD and explicitly unblocks the Task",
      };
    case "REVIEW_BLOCKED":
      return {
        action:
          "The independent reviewer returned BLOCKED (judgment required). Read the retained review/log evidence, decide or fix, then release explicitly.",
        read,
        command: report.requiresUnblock ? unblock : null,
        resumeWhen: "the review block is resolved and a human explicitly unblocks the Task",
      };
    case "REVIEW_REFUSED":
      return {
        action:
          "The reviewer produced no acceptable structured verdict (refused/failed). Re-run the review stage; no verdict is never a PASS.",
        read,
        command: report.requiresUnblock ? unblock : factory,
        resumeWhen: `a reviewer returns a structured PASS/FIX/BLOCKED verdict naming ${head}`,
      };
    case "CHECK_NOT_RUN":
      return {
        action:
          "A REQUIRED mechanical check could not run (NOT_RUN/INCONCLUSIVE). Fix the check or its environment; an unrun gate never PASSes.",
        read,
        command: report.requiresUnblock ? unblock : factory,
        resumeWhen: `the required check runs and PASSes at ${head}`,
      };
    case "NO_REQUIRED_CHECK":
      return {
        action:
          "The Task has no REQUIRED mechanical check, so VERIFY can never PASS. Record one at intake, then re-run.",
        read: `relay task show ${taskId}`,
        command: report.requiresUnblock ? unblock : factory,
        resumeWhen: "at least one REQUIRED check is recorded and runs at the Task HEAD",
      };
    case "EVIDENCE_UNAVAILABLE":
      return {
        action:
          "The required review/PR evidence could not be read. Restore it; Relay does not infer a verdict from missing evidence.",
        read,
        command: report.requiresUnblock ? unblock : factory,
        resumeWhen: "the evidence is readable and names the Task's current HEAD",
      };
    case "STALE_HEAD":
    case "STALE_EVIDENCE":
      return {
        action:
          "The evidence names a stale/foreign HEAD or attempt. Never accept it; read the named Run and the current Task HEAD, then re-run at the current HEAD.",
        read,
        command: report.requiresUnblock ? unblock : factory,
        resumeWhen: `a fresh VERIFY/review result names the Task's current HEAD (${head})`,
      };
    case "MAX_ATTEMPTS": {
      const nextBudget = attemptBudget(reason, report) + 1;
      return {
        action:
          `The attempt budget is exhausted. Fix the remaining failing check/review finding, then re-run with a larger --max-attempts; old attempts/HEADs are never reused.`,
        read,
        command: `relay run factory ${taskId} --max-attempts ${nextBudget}`,
        resumeWhen: "a FRESH attempt passes VERIFY and independent REVIEW at a new HEAD",
      };
    }
    case "NO_IMPLEMENTATION":
    case "REPEATED_FAILURE": {
      const nextBudget = attemptBudget(reason, report) + 1;
      return {
        action:
          "The coding turn produced no new commit (or repeated the same failure at the same base HEAD). " +
          "Fix the brief, the worktree or the repeated blocker; the closed attempt/HEAD is never relaunched, " +
          "so re-enter through the existing Factory on a fresh attempt budget.",
        read,
        command: report.requiresUnblock ? unblock : `relay run factory ${taskId} --max-attempts ${nextBudget}`,
        resumeWhen: `a fresh attempt produces a new commit that passes VERIFY and independent REVIEW at its HEAD (not ${head})`,
      };
    }
    case "UNKNOWN":
    default:
      return {
        action:
          "The cause is unverified. Read the named Run logs and Task events; do not retry blindly or auto-release the Task.",
        read,
        command: null,
        resumeWhen: "an operator identifies the cause, repairs it, and chooses an explicit safe re-entry",
      };
  }
}

/**
 * Derive the minimal classification/next-action report from the Factory result
 * and the EXISTING Run/result/event rows. Pure read: no Task/Run mutation.
 * Returns null for `merge_ready`, an unknown Task, or an already-terminal Task
 * (there is nothing to repair).
 */
export function classifyFactoryOutcome(db: Database, input: FactoryOutcomeInput): FactoryFailureReport | null {
  if (input.outcome === "merge_ready") return null;
  const task = getTask(db, input.taskId);
  if (!task) return null;
  // A Factory call on an already-finished Task is not a new failure: there is
  // nothing to repair and no next action. Never overwrite the outcome that
  // actually ended the Task with an UNKNOWN "investigate" projection.
  if (isTerminalTaskState(task.state)) return null;

  // The LAST attempt that actually has an outcome. A cap may create an empty
  // attempt at the boundary; its evidence is the previous attempt's Run/result.
  const last = input.attempts[input.attempts.length - 1] ?? null;
  const evidenceAttempt =
    [...input.attempts]
      .reverse()
      .find((a) => a.runId || a.verifyOutcome || a.reviewVerdict) ?? last;

  let run: Run | null = null;
  if (evidenceAttempt?.runId) {
    run = (db.query(`SELECT * FROM runs WHERE id = ?`).get(evidenceAttempt.runId) as Run | null) ?? null;
  }
  if (!run && evidenceAttempt) {
    run =
      (db
        .query(
          `SELECT * FROM runs WHERE task_id = ? AND phase = 'implement' AND attempt = ?
             ORDER BY created_at DESC, rowid DESC LIMIT 1`
        )
        .get(task.id, evidenceAttempt.attempt) as Run | null) ?? null;
  }
  if (!run) {
    run =
      (db
        .query(
          `SELECT * FROM runs WHERE task_id = ? AND phase = 'implement'
             ORDER BY created_at DESC, rowid DESC LIMIT 1`
        )
        .get(task.id) as Run | null) ?? null;
  }

  const attempt = run?.attempt ?? evidenceAttempt?.attempt ?? task.attempt;
  const collected: CollectedEvidence = {
    lines: [],
    causeText: [factoryReasonCauseText(input.reason)],
    reviewBlocked: false,
    reviewRefused: false,
    verifyNotRun: false,
  };
  collectRunEvidence(run, collected);
  collectVerificationEvidence(db, task, attempt, collected);
  collectReviewEvidence(db, task, attempt, collected);
  collectEventEvidence(db, task, attempt, run?.started_at ?? null, collected);

  const cause = detectCause(input, task, collected);
  const requiresUnblock = task.state === "blocked_human" || task.state === "blocked_internal";
  const head = task.head_sha ?? run?.head_sha ?? evidenceAttempt?.producedHead ?? input.head ?? null;
  const reportBase = {
    taskId: input.taskId,
    attempt,
    taskAttempt: task.attempt,
    head,
    runId: run?.id ?? null,
    requiresUnblock,
  };
  const next = nextFor(cause, reportBase, input.reason);
  return {
    class: classFor(cause),
    cause,
    resume: resumeFor(cause),
    requiresUnblock,
    taskId: input.taskId,
    attempt,
    taskAttempt: task.attempt,
    head,
    runId: run?.id ?? null,
    runState: run?.state ?? null,
    runExitCode: run?.exit_code ?? null,
    evidence: collected.lines,
    next,
  };
}

/**
 * Log the durable `factory.outcome` event for a completed Factory result and
 * return its report. Best effort: a full disk (or a classification bug) must
 * never turn an already-decided Factory result into a new failure.
 */
export function recordFactoryOutcome(db: Database, input: FactoryOutcomeInput): FactoryFailureReport | null {
  // A Factory call on an already-finished Task (done/failed/cancelled) is a
  // no-op, not a new failure: do not log a `factory.outcome` event that would
  // replace the diagnosis/success that actually ended the Task.
  try {
    const task = getTask(db, input.taskId);
    if (!task || isTerminalTaskState(task.state)) return null;
  } catch {
    return null;
  }
  let failure: FactoryFailureReport | null = null;
  try {
    failure = classifyFactoryOutcome(db, input);
  } catch {
    failure = null;
  }
  try {
    logEvent(db, {
      source: "factory",
      taskId: input.taskId,
      type: FACTORY_OUTCOME_EVENT,
      payload: {
        outcome: input.outcome,
        reason: input.reason,
        taskId: input.taskId,
        attempt: failure?.attempt ?? null,
        taskAttempt: failure?.taskAttempt ?? null,
        runId: failure?.runId ?? null,
        head: failure?.head ?? input.head,
        failure,
      },
    });
  } catch {
    /* evidence is already in the Run/result rows; the event is an index */
  }
  return failure;
}

/* -------------------------------------------------------------------------- */
/* Read-side projection for `run show/logs` and `task show`                    */
/* -------------------------------------------------------------------------- */

function isFailureReport(value: unknown): value is FactoryFailureReport {
  return (
    isRecord(value) &&
    typeof value.class === "string" &&
    typeof value.cause === "string" &&
    typeof value.taskId === "string" &&
    isRecord(value.next)
  );
}

function parseStoredOutcome(row: { id: number; timestamp: number; payload_json: string }): StoredFactoryOutcome | null {
  const payload = parsePayload(row.payload_json);
  if (!payload || typeof payload.outcome !== "string") return null;
  const failure = isFailureReport(payload.failure) ? payload.failure : null;
  return {
    eventId: row.id,
    at: row.timestamp,
    outcome: payload.outcome,
    reason: text(payload.reason, 2000),
    failure,
  };
}

/** All stored Factory outcomes for a Task, newest first (bounded). */
export function factoryOutcomesForTask(db: Database, taskId: string, limit = 200): StoredFactoryOutcome[] {
  const rows = db
    .query(
      `SELECT id, timestamp, payload_json FROM events
        WHERE task_id = ? AND type = ?
        ORDER BY id DESC LIMIT ?`
    )
    .all(taskId, FACTORY_OUTCOME_EVENT, limit) as { id: number; timestamp: number; payload_json: string }[];
  return rows.map(parseStoredOutcome).filter((r): r is StoredFactoryOutcome => !!r);
}

/**
 * The stored outcome that explains THIS Run. An exact `runId` match wins; a
 * same-attempt match covers an outcome recorded before a Run row was attached
 * (e.g. a non-code-change refusal or a cap with no Run). No match -> null, never
 * a guessed cause from another Run.
 */
export function findFactoryOutcomeForRun(db: Database, run: Pick<Run, "id" | "task_id" | "attempt">): StoredFactoryOutcome | null {
  const outcomes = factoryOutcomesForTask(db, run.task_id);
  for (const outcome of outcomes) {
    if (outcome.failure?.runId === run.id) return outcome;
  }
  for (const outcome of outcomes) {
    if (outcome.failure && outcome.failure.attempt === run.attempt && outcome.failure.runId === null) return outcome;
  }
  return null;
}

/** The latest stored outcome for a Task (for `relay task show`). */
export function latestFactoryOutcome(db: Database, taskId: string): StoredFactoryOutcome | null {
  return factoryOutcomesForTask(db, taskId, 1)[0] ?? null;
}

/** Human-readable lines shared by the Factory/run/task CLI surfaces. */
export function formatFactoryFailureLines(failure: FactoryFailureReport): string[] {
  const lines = [
    `classification: ${failure.class} (${failure.cause})`,
    `task: ${failure.taskId} attempt=${failure.attempt} task_attempt=${failure.taskAttempt} head=${failure.head ?? "-"} run=${failure.runId ?? "-"}`,
    `resume: ${failure.resume}${failure.requiresUnblock ? " (explicit unblock required)" : ""}`,
  ];
  if (failure.runState) lines.push(`run_state: ${failure.runState}${failure.runExitCode !== null ? ` (exit ${failure.runExitCode})` : ""}`);
  for (const e of failure.evidence) lines.push(`evidence: ${e}`);
  lines.push(`next: ${failure.next.action}`);
  if (failure.next.read) lines.push(`read: ${failure.next.read}`);
  if (failure.next.command) lines.push(`command: ${failure.next.command}`);
  lines.push(`resume when: ${failure.next.resumeWhen}`);
  return lines;
}

/** Human-readable lines for a STORED outcome (includes the Factory outcome/reason). */
export function formatStoredFactoryOutcome(stored: StoredFactoryOutcome): string[] {
  const lines = [`factory_outcome: ${stored.outcome}`];
  if (stored.reason) lines.push(`factory_reason: ${stored.reason}`);
  if (stored.failure) lines.push(...formatFactoryFailureLines(stored.failure));
  return lines;
}
