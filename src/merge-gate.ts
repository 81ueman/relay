import type { Database } from "bun:sqlite";
import { now } from "./db";
import { logEvent } from "./events";
import {
  findPassingReview,
  findSubmissionForAttempt,
  findUnresolvedNgAtHead,
  notifyGatewayTo,
} from "./results";
import type { Task } from "./schema";
import { TERMINAL_TASK_STATES, isTerminalTaskState } from "./schema";
import { getTask, resolveHumanInterface, taskDependencies } from "./tasks";
import { taskComplete } from "./workflow";
import { resolveTaskPrTarget } from "./pr-target";
import { currentProviderRateLimit, markProviderPolled, providerPollDue, providerPollMs } from "./provider-poll";
import { activeProviderRateLimit, logProviderRateLimitOnce } from "./provider-rate-limit";
import {
  DRAFT_RETAIN_LABELS,
  hasHoldLabel,
  headsMatch,
  linearHolds,
  NO_AUTHORITY,
  parsePrUrl,
  rollupChecks,
  type CheckRollup,
  type ChecksReadOnly,
  type GitHubReadOnly,
  type LinearReadOnly,
  type PrRef,
  type PrView,
  type ProviderAuthority,
} from "./providers";

/**
 * ISH-761: a READ-ONLY, HEAD-bound merge-readiness gate.
 *
 * An independent Review PASS is NOT merge permission and NOT Task Done. This
 * module mechanically verifies the GitHub current state (open/non-draft,
 * head/base/diff, mergeability, the re-fetched `merged` flag) together with the
 * REQUIRED evidence already stored in SQLite (a trusted independent review at
 * the CURRENT head, an unresolved NG, an owner HOLD, required check results, and
 * dependent change order) and produces ONE structured decision:
 *
 *   READY    — every merge-readiness condition is satisfied AND a point-of-use
 *              merge authority is granted. Nothing here performs the merge.
 *   BLOCKED  — at least one concrete reason (never a bare "not yet").
 *   MERGED   — GitHub re-fetched `merged` at the recorded head: the only "truly
 *              done" for a task with a PR.
 *
 * Everything is observation. `evaluateMergeGate` is PURE (no DB, no network) so
 * the decision table is exhaustively testable; `gatherMergeGateInput` resolves
 * the facts from SQLite + the read-only provider interfaces. There is deliberately
 * NO push, rebase, provider write or merge executor in this module.
 *
 * The retired `lane.sh` behaviours are gone on purpose:
 *   - no keyword scan of free text for "HOLD" — a HOLD is a STRUCTURED signal
 *     (a Linear state/label, or an owner label on the PR);
 *   - a later OK never overwrites an older unresolved NG at the same HEAD;
 *   - there is no `--no-merge` internal-approve path: acceptance and merge
 *     readiness are separate decisions, and a bare approve cannot satisfy either.
 */

export const MERGE_GATE_ERROR = "MERGE_GATE";

/** The concrete reasons a merge gate decision is BLOCKED. */
export type MergeBlockCode =
  | "NOT_CODE_TASK"
  | "NOT_MERGE_READY"
  | "TERMINAL"
  | "NOT_MERGED"
  | "NO_PR"
  | "PROVIDER_UNREADABLE"
  | "PROVIDER_RATE_LIMITED"
  | "PR_NOT_OPEN"
  | "PR_DRAFT"
  | "HEAD_MOVED"
  | "HEAD_UNKNOWN"
  | "REVIEW_MISSING"
  | "REVIEW_STALE"
  | "REVIEW_NOT_INDEPENDENT"
  | "UNRESOLVED_NG"
  | "HOLD"
  | "CHECKS_NOT_RUN"
  | "CHECKS_NOT_PASSED"
  | "CONFLICT"
  | "MERGEABILITY_UNKNOWN"
  | "BASE_CHANGED"
  | "DEPENDENCY_UNMET"
  | "MERGE_NOT_CREDITED"
  | "NO_PERMISSION";

export interface MergeGateReason {
  code: MergeBlockCode;
  message: string;
  /**
   * True when the condition needs a Gateway ROUTING decision (`IntegrationRequired`,
   * per ISH-761): a real conflict against a base another PR already moved. The
   * Coding Agent fixes the new HEAD; it is re-VERIFY/REVIEW'd.
   */
  integrationRequired?: boolean;
}

export type MergeGateStatus = "READY" | "BLOCKED" | "MERGED";

/** How the bound PR was resolved this pass. `unbound` = no PR on the task. */
export type PrRead = "ok" | "unbound" | "error" | "rate_limited";

/**
 * The fully-resolved facts one gate decision is made from. Deliberately
 * DB/network-free so the decision is a pure function of observable state.
 */
export interface MergeGateInput {
  taskId: string;
  /** The recorded (Relay) head the decision is bound to. */
  head: string | null;
  attempt: number;
  codeChange: boolean;
  phase: string | null;
  state: string;
  /** GitHub re-fetched `merged` for the bound PR. */
  merged: boolean;
  /** The re-fetched PR view, or null when unbound/unreadable. */
  pr: PrView | null;
  prRead: PrRead;
  /** A passing ReviewResult at the current head/attempt, or null. */
  review: { workerId: string | null; head: string | null; reviewer: string | null } | null;
  /** The author of the TaskSubmitted for this attempt (independence check). */
  submitter: string | null;
  /** An unresolved NG at the current head, or null. */
  unresolvedNgId: number | null;
  /** The base branch the review/verify judged (task`pr_base`); null if unrecorded. */
  prBase: string | null;
  /** A structured owner HOLD (Linear state/label or PR label), or null. */
  hold: string | null;
  /** The required-check roll-up; null = the read FAILED (NOT_RUN). */
  checks: CheckRollup | null;
  /**
   * ISH-1132: the check read itself hit the provider's rate-limit backoff. This
   * is NOT "checks not run"; it is a retryable `PROVIDER_RATE_LIMITED` block.
   */
  checksRateLimited?: boolean;
  /** Declared prerequisites that are not complete (merged, for a PR-bound dep). */
  unmetDependencies: string[];
  /** Point-of-use merge authority (ISH-288). Default DENY. */
  authority: ProviderAuthority;
  /** The PR is a draft the OWNER designated to keep as a draft. */
  draftRetained: boolean;
}

export interface MergeGateDecision {
  taskId: string;
  head: string | null;
  attempt: number;
  status: MergeGateStatus;
  reasons: MergeGateReason[];
  /** The re-fetched PR this decision judged (null when unbound/unreadable). */
  pr: PrView | null;
  /** The routing the gate RECOMMENDS. Never executed by this module. */
  action: "merge" | "IntegrationRequired" | "none";
  /** Stable identity of this decision (task, head, attempt, status, reasons). */
  identity: string;
}

// ---------------------------------------------------------------------------
// The pure decision table
// ---------------------------------------------------------------------------

function decide(input: MergeGateInput, status: MergeGateStatus, reasons: MergeGateReason[]): MergeGateDecision {
  const codes = reasons.map((r) => r.code).sort();
  const action: MergeGateDecision["action"] = reasons.some((r) => r.integrationRequired)
    ? "IntegrationRequired"
    : status === "READY"
      ? "merge"
      : "none";
  const identity = `merge-gate:${input.taskId}:${input.head ?? "none"}:${input.attempt}:${status}:${codes.join("+") || "ok"}`;
  return { taskId: input.taskId, head: input.head, attempt: input.attempt, status, reasons, pr: input.pr, action, identity };
}

/**
 * The decision. Fail-closed: any unknown / unreadable condition is BLOCKED, and
 * a zero-check roll-up is NOT_RUN. A `done` (internally accepted) task whose PR
 * is not merged is explicitly distinguished from Done.
 */
export function evaluateMergeGate(input: MergeGateInput): MergeGateDecision {
  const reasons: MergeGateReason[] = [];
  const push = (code: MergeBlockCode, message: string, integrationRequired?: boolean): void => {
    reasons.push(integrationRequired ? { code, message, integrationRequired: true } : { code, message });
  };

  // MERGED is the terminal truth: a re-fetched merge at the recorded head. An
  // unrelated/old-head merge is NOT this work and must not become Done.
  if (input.merged) {
    if (input.head && input.pr?.headSha && !headsMatch(input.pr.headSha, input.head)) {
      push(
        "HEAD_MOVED",
        `GitHub merged head ${short(input.pr.headSha)} != recorded head ${short(input.head)}; not this work`
      );
      return decide(input, "BLOCKED", reasons);
    }
    // Mirror `confirmMerged`'s postReview guard EXACTLY: a merge is credited only
    // for a code task, not cancelled/failed, and only once the review has passed
    // (phase integration/merge_ready) or the task was already internally accepted.
    // Otherwise Relay itself would refuse to credit it (logging merge_not_credited)
    // and the dry run must not report Done.
    const postReview = input.phase === "integration" || input.phase === "merge_ready" || input.state === "done";
    if (!input.codeChange) {
      push("MERGE_NOT_CREDITED", "GitHub reports the PR merged, but the task is not a code-change task; Relay will not credit it");
      return decide(input, "BLOCKED", reasons);
    }
    if (input.state === "cancelled" || input.state === "failed") {
      push("MERGE_NOT_CREDITED", `GitHub reports the PR merged, but the task is ${input.state}; Relay will not credit it`);
      return decide(input, "BLOCKED", reasons);
    }
    if (!postReview) {
      push(
        "MERGE_NOT_CREDITED",
        `GitHub reports the PR merged, but the review has not passed (phase '${input.phase ?? "none"}', state '${input.state}'); Relay credits a merge only at integration/merge_ready or after accept`
      );
      return decide(input, "BLOCKED", reasons);
    }
    return decide(input, "MERGED", reasons);
  }

  // ISH-1132: a rate-limited read is a TRANSIENT provider condition, not "no PR"
  // and not "checks did not run". Keep it typed so the Factory/operator can wait
  // for the reported reset instead of treating the Task as unconfigured.
  if (input.prRead === "rate_limited") {
    push("PROVIDER_RATE_LIMITED", "the GitHub API is rate-limited; no PR/check state was read this pass (retry after the reset)");
    return decide(input, "BLOCKED", reasons);
  }

  if (!input.codeChange) {
    push("NOT_CODE_TASK", "the merge gate applies only to a code-change task");
    return decide(input, "BLOCKED", reasons);
  }
  if (input.state === "done") {
    // `done` is a terminal lifecycle state, but a PR-bound task is "truly done"
    // only once the merge is confirmed: distinguish an internal accept from Done.
    push("NOT_MERGED", "internally accepted but the bound PR is not merged; an unmerged PASS is not Done");
  } else if (isTerminalTaskState(input.state)) {
    push("TERMINAL", `task is ${input.state}; a terminal task is not a merge candidate`);
    return decide(input, "BLOCKED", reasons);
  }
  if (input.phase !== "merge_ready") {
    push("NOT_MERGE_READY", `phase is '${input.phase ?? "none"}', not merge_ready`);
  }
  // A merge gate is HEAD-bound: with no recorded head there is nothing tying the
  // review/verify to the PR head being judged, so it can never be READY.
  if (input.head === null) {
    push("HEAD_UNKNOWN", "the task records no head_sha; a review cannot be bound to the judged HEAD");
  }

  // --- Pull request state -------------------------------------------------
  if (input.prRead === "unbound") {
    push("NO_PR", "no pull request is bound; nothing to verify");
  } else if (input.prRead === "error" || !input.pr) {
    push("PROVIDER_UNREADABLE", "GitHub state could not be read (unknown is BLOCKED, never ready; set RELAY_PROVIDER_GITHUB=gh or authenticate gh)");
  } else {
    const pr = input.pr;
    if (pr.state !== "open") {
      push("PR_NOT_OPEN", `PR is ${pr.state}, not open`);
    } else if (pr.isDraft) {
      push("PR_DRAFT", input.draftRetained ? "PR is a draft the owner designated to retain" : "PR is a draft");
    }
    if (input.head && pr.headSha && !headsMatch(pr.headSha, input.head)) {
      push(
        "HEAD_MOVED",
        `PR head ${short(pr.headSha)} != recorded head ${short(input.head)}; a changed HEAD needs a fresh independent review`
      );
    }
    // The base BRANCH is part of the reviewed diff identity: a retarget means the
    // review/verify judged a diff against another base. A base-SHA move alone is
    // NOT a block (an unrelated merge must not force a rebase loop).
    if (input.prBase && pr.baseRef && input.prBase !== pr.baseRef) {
      push(
        "BASE_CHANGED",
        `PR base '${pr.baseRef}' != the recorded base '${input.prBase}'; the review judged a different diff`
      );
    }
    if (pr.mergeable === "conflicting") {
      push(
        "CONFLICT",
        "the PR conflicts with its base; a Gateway routing decision (IntegrationRequired) is required",
        true
      );
    } else if (pr.mergeable === "unknown") {
      push("MERGEABILITY_UNKNOWN", "GitHub has not resolved mergeability yet; retry (never assumed mergeable)");
    }
  }

  // --- Independent review at the CURRENT head -----------------------------
  if (!input.review) {
    push("REVIEW_MISSING", "no trusted independent review PASS at the current HEAD");
  } else {
    // A review that names NO head cannot be the current-HEAD pass; and a review at
    // another head is stale. Either way it does not satisfy the gate.
    if (!input.review.head || (input.head && !headsMatch(input.review.head, input.head))) {
      push("REVIEW_STALE", `the review names ${short(input.review.head)}, not the current head ${short(input.head)}`);
    }
    if (input.review.workerId && input.submitter && input.review.workerId === input.submitter) {
      push("REVIEW_NOT_INDEPENDENT", `the reviewer ${input.review.workerId} authored this attempt and may not approve it`);
    }
  }

  if (input.unresolvedNgId !== null) {
    push(
      "UNRESOLVED_NG",
      `an NG (result ${input.unresolvedNgId}) is unresolved at this HEAD; a later OK alone does not clear it`
    );
  }
  if (input.hold) {
    push("HOLD", `owner HOLD: ${input.hold}`);
  }

  // --- Required check results ---------------------------------------------
  if (input.checksRateLimited) {
    push("PROVIDER_RATE_LIMITED", "required check results could not be read because the GitHub API is rate-limited (retry after the reset)");
  } else if (!input.checks) {
    push("CHECKS_NOT_RUN", "required check results are unavailable (NOT_RUN; a CI outage or an unreadable read)");
  } else if (input.checks.total === 0) {
    push("CHECKS_NOT_RUN", "no check results were reported for this HEAD");
  } else if (input.checks.passed === 0 && input.checks.failing.length === 0 && input.checks.pending.length === 0) {
    // Every reported check was skipped: no required gate actually RAN.
    push("CHECKS_NOT_RUN", "every reported check was skipped; no required gate actually ran");
  } else if (!input.checks.requiredPassed) {
    const detail: string[] = [];
    if (input.checks.failing.length) detail.push(`failing: ${input.checks.failing.join(",")}`);
    if (input.checks.pending.length) detail.push(`pending: ${input.checks.pending.join(",")}`);
    push("CHECKS_NOT_PASSED", `required checks are not all passing (${detail.join("; ") || "unknown"})`);
  }

  // --- Dependent change order ---------------------------------------------
  if (input.unmetDependencies.length > 0) {
    push(
      "DEPENDENCY_UNMET",
      `prerequisite(s) not complete: ${input.unmetDependencies.join(", ")} (a PR-bound dependency is complete only once merged)`
    );
  }

  // --- Point-of-use permission --------------------------------------------
  if (!input.authority.merge) {
    push("NO_PERMISSION", "no point-of-use merge authority is granted (ISH-288); a real merge stays forbidden");
  }

  return decide(input, reasons.length === 0 ? "READY" : "BLOCKED", reasons);
}

function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 10) : "none";
}

// ---------------------------------------------------------------------------
// Resolving the facts (read-only) from SQLite + the provider interfaces
// ---------------------------------------------------------------------------

export interface MergeGateDeps {
  github?: GitHubReadOnly;
  linear?: LinearReadOnly;
  /** HEAD-pinned required-check reader. Absent -> checks are NOT_RUN (BLOCK). */
  checks?: ChecksReadOnly;
  authorizedReviewers?: string[];
  authority?: ProviderAuthority;
  /**
   * ISH-1087: the Task's GitHub repo when the Task itself records no
   * `pr_repo`/`pr_url` (a live Factory Task records only a branch). Resolution
   * also falls back to the Task workspace/source `origin`.
   */
  repo?: string | null;
  /**
   * ISH-1129: daemon shutdown. Checked between Tasks so a bound-PR walk stops
   * promptly; the readers' abortable exec cancels an in-flight command.
   */
  signal?: AbortSignal;
}

/** True when shutdown already started: stop before the next provider read. */
function stopped(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/** Resolve the bound PR ref from the task, or null when none is bound. */
export async function boundPrRef(
  task: Task,
  github?: GitHubReadOnly,
  repo?: string | null
): Promise<PrRef | null> {
  let ref = parsePrUrl(task.pr_url, task.pr_repo);
  if (!ref && github) {
    // The Task may record only a branch (the live Factory intake). Resolve the
    // repo from the explicit gate/task value or the workspace origin, so the
    // gate observes the PR instead of reporting NO_PR.
    const resolved = resolveTaskPrTarget(task, { repo: repo ?? null })?.repo ?? null;
    const lookupRepo = resolved ?? task.pr_repo ?? null;
    if (lookupRepo && task.branch) ref = (await github.findPullRequestForBranch(lookupRepo, task.branch))?.ref ?? null;
  }
  return ref;
}

/**
 * Gather the facts for one task. Purely observational: it reads SQLite and the
 * read-only provider interfaces; it writes NOTHING and never calls a mutating
 * provider verb.
 */
export async function gatherMergeGateInput(
  db: Database,
  taskId: string,
  deps: MergeGateDeps = {}
): Promise<MergeGateInput | null> {
  const task = getTask(db, taskId);
  if (!task) return null;
  const head = task.head_sha ?? null;
  const attempt = task.attempt;

  let pr: PrView | null = null;
  let prRead: PrRead = "unbound";
  let merged = false;
  if (deps.github) {
    // ISH-1132: never spend a call while the reader is backing off, and never
    // report the backoff as a generic unreadable PR.
    if (activeProviderRateLimit(deps.github.rateLimit?.())) {
      prRead = "rate_limited";
    } else {
      const ref = await boundPrRef(task, deps.github, deps.repo);
      if (ref) {
        const view = await deps.github.getPullRequest(ref);
        if (view) {
          pr = view;
          prRead = "ok";
          merged = view.state === "merged";
        } else if (activeProviderRateLimit(deps.github.rateLimit?.())) {
          prRead = "rate_limited";
        } else {
          prRead = "error";
        }
      }
    }
  }

  const reviewRow = findPassingReview(db, taskId, attempt);
  const review = reviewRow
    ? {
        workerId: reviewRow.worker_id,
        head: reviewRow.head_sha,
        reviewer: reviewPayloadReviewer(reviewRow.payload_json) ?? reviewRow.worker_id,
      }
    : null;
  const submission = findSubmissionForAttempt(db, taskId, attempt);
  const ng = findUnresolvedNgAtHead(db, taskId, head);

  // A HOLD is a STRUCTURED owner signal: a Linear state/label, or an owner label
  // on the PR. Deliberately NOT a keyword scan of comment text (the retired
  // lane.sh behaviour). A HOLD marker posted to the review thread is applied to
  // the task as a blocked ReviewResult by provider reconciliation BEFORE it can
  // reach merge_ready.
  let hold: string | null = null;
  if (deps.linear && task.provider === "linear" && task.issue_id) {
    const issue = await deps.linear.getIssue(task.issue_id);
    if (issue && linearHolds(issue)) {
      hold = `linear:${issue.state}${issue.labels.length ? ` [${issue.labels.join(",")}]` : ""}`;
    }
  }
  if (!hold && pr) {
    const label = hasHoldLabel(pr.labels);
    if (label) hold = `github-label:${label}`;
  }

  let checks: CheckRollup | null = null;
  let checksRateLimited = false;
  // Checks are pinned to the RECORDED head. With no recorded head there is no
  // head to pin to, so the roll-up stays NOT_RUN (never the live PR head).
  if (deps.checks && pr && head) {
    if (activeProviderRateLimit(deps.checks.rateLimit?.())) {
      checksRateLimited = true;
    } else {
      const raw = await deps.checks.listChecks(pr.ref, head);
      if (raw === null && activeProviderRateLimit(deps.checks.rateLimit?.())) checksRateLimited = true;
      else checks = raw === null ? null : rollupChecks(raw);
    }
  }

  const unmetDependencies: string[] = [];
  for (const depId of taskDependencies(db, taskId)) {
    const dep = getTask(db, depId);
    if (!dep || !taskComplete(dep)) unmetDependencies.push(depId);
  }

  return {
    taskId,
    head,
    attempt,
    codeChange: task.code_change === 1,
    phase: task.phase,
    state: task.state,
    merged,
    pr,
    prRead,
    review,
    submitter: submission?.worker_id ?? null,
    unresolvedNgId: ng?.id ?? null,
    prBase: task.pr_base ?? null,
    hold,
    checks,
    checksRateLimited,
    unmetDependencies,
    authority: deps.authority ?? NO_AUTHORITY,
    draftRetained: !!pr && pr.isDraft && pr.labels.some((l) => DRAFT_RETAIN_LABELS.includes((l ?? "").toLowerCase())),
  };
}

function reviewPayloadReviewer(payloadJson: string | null | undefined): string | null {
  if (!payloadJson) return null;
  try {
    const p = JSON.parse(payloadJson) as { reviewer?: unknown };
    return typeof p.reviewer === "string" ? p.reviewer : null;
  } catch {
    return null;
  }
}

/** Gather + evaluate one task. Read-only. */
export async function checkMergeGate(
  db: Database,
  taskId: string,
  deps: MergeGateDeps = {}
): Promise<MergeGateDecision | null> {
  const input = await gatherMergeGateInput(db, taskId, deps);
  return input ? evaluateMergeGate(input) : null;
}

// ---------------------------------------------------------------------------
// IntegrationRequired — a routing signal, not a mutation
// ---------------------------------------------------------------------------

export interface IntegrationRequiredResult {
  raised: boolean;
  recipient: string | null;
}

/**
 * Record an `IntegrationRequired` routing decision for a conflict and tell the
 * Gateway ONCE per (task, head). Read-only w.r.t. providers: it never rebases,
 * pushes or writes GitHub. Idempotent via the (task, headKey) event key, where
 * `headKey` is the head or the literal `"none"` (so a null head is deduped too,
 * instead of matching a `"head":""` pattern that a JSON `null` never produces).
 */
export function raiseIntegrationRequired(
  db: Database,
  task: Task,
  head: string | null,
  reason: string
): IntegrationRequiredResult {
  const recipient = resolveHumanInterface(db, task);
  const headKey = head ?? "none";
  const already = db
    .query(
      `SELECT 1 AS x FROM events
        WHERE task_id = ? AND type = 'workflow.integration_required'
          AND json_extract(payload_json, '$.headKey') = ?
        LIMIT 1`
    )
    .get(task.id, headKey);
  if (already) return { raised: false, recipient };
  const t = now();
  db.query(
    `INSERT INTO task_notes (task_id, worker_id, kind, body, created_at)
     VALUES (?, 'relay', 'integration_required', ?, ?)`
  ).run(task.id, reason, t);
  logEvent(db, {
    source: "workflow",
    taskId: task.id,
    type: "workflow.integration_required",
    payload: { head, headKey, reason },
  });
  notifyGatewayTo(db, recipient, task, `${task.id}: IntegrationRequired — ${reason}`, "integration_required");
  return { raised: true, recipient };
}

/** True when this exact merge-gate decision identity was already logged. */
export function mergeGateDecisionLogged(db: Database, identity: string): boolean {
  const row = db
    .query(
      `SELECT 1 AS x FROM events
        WHERE type >= 'workflow.merge_gate.' AND type < 'workflow.merge_gate/'
          AND json_extract(payload_json, '$.identity') = ?
        LIMIT 1`
    )
    .get(identity);
  return !!row;
}

// ---------------------------------------------------------------------------
// The daemon pass (bounded, idempotent, read-only)
// ---------------------------------------------------------------------------

/**
 * Merge candidates this pass: every NON-TERMINAL code task parked at
 * `merge_ready`. ISH-1132 removed the done-but-unmerged candidate from THIS
 * pass: a `done` Task is terminal, and polling it here forever was one of the
 * sources of the exhausted GitHub budget. ISH-1138 gives that one case to the
 * PR poll (`providerBoundTasks`) instead, which credits `merged_at` and stops
 * after a merge or a closed PR. A merge observed while the Task is still
 * integration/merge_ready is credited; accept-after-merge is the live flow.
 */
export function mergeGateCandidates(db: Database): Task[] {
  return db
    .query(
      `SELECT * FROM tasks
        WHERE code_change = 1
          AND state NOT IN (${TERMINAL_TASK_STATES.map((s) => `'${s}'`).join(",")})
          AND merged_at IS NULL AND accepted_at IS NULL
          AND phase = 'merge_ready'
        ORDER BY priority DESC, created_at ASC`
    )
    .all() as Task[];
}

export interface MergeGateRun {
  decision: MergeGateDecision;
  /** True when this pass logged the decision for the first time. */
  logged: boolean;
  /** True when this pass raised IntegrationRequired for the first time. */
  integrationRaised: boolean;
}

/**
 * Evaluate the gate for every candidate, log each new decision identity ONCE,
 * and raise IntegrationRequired on a real conflict. Never mutates the task,
 * never touches a provider. Safe to call every tick.
 */
export async function runMergeGates(db: Database, deps: MergeGateDeps = {}): Promise<MergeGateRun[]> {
  const out: MergeGateRun[] = [];
  const nowMs = Date.now();
  const pollMs = providerPollMs();
  for (const t of mergeGateCandidates(db)) {
    // ISH-1129: shutdown interrupts a long candidate walk between Tasks.
    if (stopped(deps.signal)) break;
    // ISH-1132: the gate reads `gh pr view` AND `check-runs`; it obeys the SAME
    // per-Task interval as the PR poll and stops on a provider rate limit.
    const limited = currentProviderRateLimit(deps);
    const preLimited = limited !== null;
    if (limited) {
      // One typed decision is still produced (with ZERO provider calls) so the
      // operator sees PROVIDER_RATE_LIMITED instead of a silent empty pass.
      logProviderRateLimitOnce(db, limited);
    } else if (!providerPollDue(t, nowMs, pollMs)) {
      continue;
    }
    const decision = await checkMergeGate(db, t.id, deps);
    if (stopped(deps.signal)) break;
    const after = currentProviderRateLimit(deps);
    if (!decision) {
      if (after) logProviderRateLimitOnce(db, after);
      if (after || preLimited) break;
      continue;
    }
    // A completed evaluation (even a BLOCKED one) spent the Task's poll budget —
    // unless the pass was already backing off, in which case no call was spent.
    if (!preLimited && !after) markProviderPolled(db, t.id, nowMs);
    let logged = false;
    if (!mergeGateDecisionLogged(db, decision.identity)) {
      logEvent(db, {
        source: "workflow",
        taskId: t.id,
        type: `workflow.merge_gate.${decision.status.toLowerCase()}`,
        payload: {
          identity: decision.identity,
          head: decision.head,
          attempt: decision.attempt,
          action: decision.action,
          reasons: decision.reasons.map((r) => r.code),
        },
      });
      logged = true;
    }
    let integrationRaised = false;
    if (decision.action === "IntegrationRequired") {
      const reason = decision.reasons
        .filter((r) => r.integrationRequired)
        .map((r) => r.message)
        .join("; ");
      integrationRaised = raiseIntegrationRequired(db, t, decision.head, reason).raised;
    }
    out.push({ decision, logged, integrationRaised });
    if (after) {
      logProviderRateLimitOnce(db, after);
      break;
    }
    if (preLimited) break; // one typed decision is enough per backoff pass
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** One-line summary + the concrete reasons, for `relay merge-check`. */
export function formatMergeGateDecision(d: MergeGateDecision): string {
  const pr = d.pr ? `${d.pr.ref.repo}#${d.pr.ref.number}@${short(d.pr.headSha)}` : "none";
  const lines = [
    `${d.taskId}  ${d.status}  head=${short(d.head)}  pr=${pr}  attempt=${d.attempt}  action=${d.action}`,
  ];
  for (const r of d.reasons) lines.push(`  - ${r.code}: ${r.message}`);
  return lines.join("\n");
}
