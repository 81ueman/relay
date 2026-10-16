import type { Database } from "bun:sqlite";
import { logEvent } from "./events";
import type { Task } from "./schema";
import { isTerminalTaskState } from "./schema";
import { getTask } from "./tasks";
import {
  AUTHORITY_ERROR,
  HEAD_MISMATCH,
  confirmMerged,
  isCodeTask,
  linkTask,
  quietBlock,
  recordReview,
} from "./workflow";

/**
 * ISH-759 provider reconciliation (GitHub / Linear), absorbed from `lane.sh`.
 *
 * Everything here is READ-ONLY by default. The interfaces are deliberately
 * read-only and the default authority for any mutation is DENY, so the whole
 * path is dry-run / fail-closed per ISH-288's point-of-use rule: a real GitHub
 * write (comment/label), a Linear write, or a merge requires an explicit
 * `ProviderAuthority` grant at the call site. Observing provider state and
 * binding it to the Relay task is not a side effect.
 *
 * What is absorbed from `lane.sh`:
 *   - the review verdict marker (`<!-- ishiul-review head=<sha> verdict=OK|NG|HOLD
 *     reviewer=<id> -->`) scanned across issue/review/inline comments;
 *   - the "newest marker at the live head wins, NG/HOLD beat OK" rule;
 *   - PR state polling (open / synchronize=head moved / merged);
 *   - findings are carried as the marker body + evidence ref (no separate
 *     coordinator, no duplicate scheduler).
 *
 * A GitHub LABEL or a reviewer's TurnEnded is NEVER an approval, and a comment
 * from an author outside the authorized-reviewer set is a self-claim and is
 * ignored. Only an authorized verdict marker can become a ReviewResult — and
 * only when its head equals the Relay task's recorded head.
 */

// ---------------------------------------------------------------------------
// Read-only provider interfaces
// ---------------------------------------------------------------------------

export interface PrRef {
  /** `owner/name`. */
  repo: string;
  number: number;
}

export type PrState = "open" | "closed" | "merged" | "unknown";

export interface PrView {
  ref: PrRef;
  url: string;
  state: PrState;
  isDraft: boolean;
  headRefName: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  mergeable: "mergeable" | "conflicting" | "unknown";
  /** Derived display only — never a source of truth for a phase. */
  labels: string[];
  updatedAt: string;
}

export interface CommentView {
  author: string;
  createdAt: string;
  body: string;
}

export interface GitHubReadOnly {
  readonly name: string;
  readonly readOnly: true;
  getPullRequest(ref: PrRef): PrView | null;
  findPullRequestForBranch(repo: string, branch: string): PrView | null;
  /**
   * Issue comments + review bodies + inline review comments, one stream.
   * Returns `null` when the read FAILED (any endpoint), so a caller never treats
   * a transient provider error as "no comments".
   */
  listComments(ref: PrRef): CommentView[] | null;
}

export interface IssueView {
  id: string;
  state: string;
  labels: string[];
  updatedAt: string;
}

export interface LinearReadOnly {
  readonly name: string;
  readonly readOnly: true;
  getIssue(id: string): IssueView | null;
}

// ---------------------------------------------------------------------------
// ISH-761 required check results (read-only, HEAD-pinned)
// ---------------------------------------------------------------------------

/**
 * One GitHub check run or commit status, normalized to the SAME bucket
 * vocabulary `gh pr checks` uses. `bucket` is the only thing the merge gate
 * reads: a required check that is `pending`/`fail`/`cancel` (or absent) BLOCKS.
 */
export interface CheckRunView {
  name: string;
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
}

/**
 * The read-only check reader. `listChecks` is pinned to an EXACT head so the
 * result can never be credited to a moved HEAD. A failed read returns `null`
 * ("unknown"), which the gate treats as NOT_RUN — never as "no checks, pass".
 */
export interface ChecksReadOnly {
  readonly name: string;
  readonly readOnly: true;
  listChecks(ref: PrRef, headSha: string): CheckRunView[] | null;
}

/** The roll-up the merge gate judges: required checks all concluded green. */
export interface CheckRollup {
  total: number;
  passed: number;
  pending: string[];
  failing: string[];
  skipped: string[];
  /**
   * True only when at least one check actually ran AND none is failing /
   * pending / cancelled. A zero-check roll-up is deliberately NOT passed: an
   * unrun required gate (e.g. a CI credit outage) must BLOCK, never PASS.
   */
  requiredPassed: boolean;
}

export function rollupChecks(checks: CheckRunView[]): CheckRollup {
  const pending: string[] = [];
  const failing: string[] = [];
  const skipped: string[] = [];
  let passed = 0;
  for (const c of checks) {
    switch (c.bucket) {
      case "pass":
        passed++;
        break;
      case "pending":
        pending.push(c.name);
        break;
      case "fail":
      case "cancel":
        failing.push(c.name);
        break;
      case "skipping":
        skipped.push(c.name);
        break;
    }
  }
  return {
    total: checks.length,
    passed,
    pending,
    failing,
    skipped,
    requiredPassed: checks.length > 0 && pending.length === 0 && failing.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Review verdict markers (absorbed from lane.sh `verdict_rows`)
// ---------------------------------------------------------------------------

export const DEFAULT_REVIEW_OWNER = "claude";

const MARKER_RE =
  /<!--\s*ishiul-review\s+head=([0-9a-fA-F]{7,64})\s+verdict=(OK|NG|HOLD)\s+reviewer=([A-Za-z0-9_.@-]+)\s*-->/g;

export type MarkerVerdict = "OK" | "NG" | "HOLD";

export interface ReviewMarker {
  headSha: string;
  verdict: MarkerVerdict;
  reviewer: string;
  author: string;
  createdAt: string;
  body: string;
}

/** Both a full SHA and GitHub's abbreviated SHA must match the same commit. */
export function headsMatch(markerHead: string, liveHead: string | null | undefined): boolean {
  if (!liveHead) return false;
  const a = markerHead.toLowerCase();
  const b = liveHead.toLowerCase();
  return a === b || b.startsWith(a) || a.startsWith(b);
}

/**
 * Parse verdict markers from a comment stream. ONLY markers authored by an
 * authorized reviewer count; a marker from any other author is a self-claim and
 * is ignored. Ordered oldest -> newest.
 */
export function parseReviewMarkers(
  comments: CommentView[],
  opts: { authorizedReviewers: Iterable<string> }
): ReviewMarker[] {
  const allowed = new Set([...opts.authorizedReviewers].map((s) => s.toLowerCase()));
  const out: { marker: ReviewMarker; order: number }[] = [];
  let order = 0;
  for (const c of comments) {
    const authoredOk = allowed.has((c.author ?? "").toLowerCase());
    if (!authoredOk) continue;
    MARKER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MARKER_RE.exec(c.body ?? "")) !== null) {
      out.push({
        order: order++,
        marker: {
          headSha: m[1],
          verdict: m[2] as MarkerVerdict,
          reviewer: m[3],
          author: c.author,
          createdAt: c.createdAt,
          body: c.body,
        },
      });
    }
  }
  out.sort((x, y) => (x.marker.createdAt < y.marker.createdAt ? -1 : x.marker.createdAt > y.marker.createdAt ? 1 : x.order - y.order));
  return out.map((x) => x.marker);
}

/**
 * The newest marker at the live head (lane.sh's `effective_verdict`): NG/HOLD
 * beat an earlier OK because they are simply newer. Returns null when no
 * authorized marker names the head.
 */
export function effectiveVerdictAtHead(markers: ReviewMarker[], liveHead: string | null | undefined): ReviewMarker | null {
  let last: ReviewMarker | null = null;
  for (const m of markers) {
    if (headsMatch(m.headSha, liveHead)) last = m;
  }
  return last;
}

/**
 * Why a candidate signal is (not) an approval. A `structured` ReviewResult and
 * an authorized `review-marker` are approvals; a `turn-ended` (a reviewer's
 * session went idle), a `label`, and a `self-claim` (a comment from an
 * unauthorized author) are NOT.
 */
export type ApprovalSignal = "structured" | "review-marker" | "turn-ended" | "label" | "self-claim" | "none";

export function isApprovalSignal(signal: ApprovalSignal): boolean {
  return signal === "structured" || signal === "review-marker";
}

// ---------------------------------------------------------------------------
// Side-effect authority (ISH-288 point-of-use rule) — DENY by default
// ---------------------------------------------------------------------------

export interface ProviderAuthority {
  /** Post/refresh a PR comment or mutate a GitHub label. */
  githubWrite: boolean;
  /** Write a Linear issue (status/comment). */
  linearWrite: boolean;
  /** Perform a real GitHub merge. */
  merge: boolean;
}

export const NO_AUTHORITY: ProviderAuthority = { githubWrite: false, linearWrite: false, merge: false };

export type SideEffect = "github-write" | "linear-write" | "merge";

export function sideEffectAllowed(a: ProviderAuthority, kind: SideEffect): boolean {
  switch (kind) {
    case "github-write":
      return a.githubWrite;
    case "linear-write":
      return a.linearWrite;
    case "merge":
      return a.merge;
  }
}

/** Throw (fail closed) unless the point-of-use authority grants the side effect. */
export function assertSideEffectAllowed(a: ProviderAuthority, kind: SideEffect): void {
  if (!sideEffectAllowed(a, kind)) {
    throw new Error(
      `${AUTHORITY_ERROR}: ${kind} is not authorized at this point of use; failing closed (no implicit grant)`
    );
  }
}

/**
 * A merge requested THROUGH Relay. With no authority it fails closed; with
 * authority it still only runs when `dryRun` is false. There is deliberately no
 * implementation here that performs a real merge — that is out of ISH-759's
 * scope (no new merge authority) and requires its own explicitly authorized
 * executor.
 */
export function performMerge(
  authority: ProviderAuthority,
  opts: { dryRun?: boolean } = {}
): { performed: false; dryRun: boolean } {
  assertSideEffectAllowed(authority, "merge");
  // Authorized, but this slice never mutates GitHub: dry-run/observation only.
  return { performed: false, dryRun: opts.dryRun !== false };
}

// ---------------------------------------------------------------------------
// Reconciliation: bind provider state to the Relay task (read-only)
// ---------------------------------------------------------------------------

export interface ProviderDeps {
  github?: GitHubReadOnly;
  linear?: LinearReadOnly;
  /** GitHub logins (or `reviewer=` ids) allowed to author a verdict marker. */
  authorizedReviewers?: string[];
  authority?: ProviderAuthority;
}

export interface ProviderAction {
  kind: string;
  taskId: string;
  detail?: string;
}

/** Parse a PR number + repo from a linked PR url or `owner/repo#n`. */
export function parsePrUrl(url: string | null, fallbackRepo: string | null): PrRef | null {
  if (!url) return null;
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (m) return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
  const hash = url.match(/^([^#\s]+\/[^#\s]+)#(\d+)$/);
  if (hash) return { repo: hash[1], number: Number(hash[2]) };
  const num = url.match(/#(\d+)$/) ?? url.match(/^(\d+)$/);
  if (num && fallbackRepo) return { repo: fallbackRepo, number: Number(num[1]) };
  return null;
}

/** Linear labels/states that mean a human HOLD (park the task, quiet). */
const LINEAR_HOLD_LABELS = ["hold", "do-not-merge", "do not merge", "human-hold"];
const LINEAR_HOLD_STATES = ["hold", "on hold", "blocked"];

/**
 * ISH-761: owner-designated HOLD labels. A PR or Linear issue carrying one of
 * these is an explicit owner stop — the merge gate must never treat it as
 * ready. This is a STRUCTURED label lookup, not a keyword scan of free text.
 */
export const HOLD_LABELS = ["hold", "do-not-merge", "do not merge", "human-hold"];

/** Owner-designated draft retention: the draft is intentional, do not force-undraft. */
export const DRAFT_RETAIN_LABELS = ["draft-retained", "hold-draft", ...HOLD_LABELS];

export function hasHoldLabel(labels: readonly string[] | null | undefined): string | null {
  for (const l of labels ?? []) {
    if (HOLD_LABELS.includes((l ?? "").toLowerCase())) return l;
  }
  return null;
}

export function linearHolds(issue: IssueView): boolean {
  const state = (issue.state ?? "").toLowerCase();
  if (LINEAR_HOLD_STATES.includes(state)) return true;
  return (issue.labels ?? []).some((l) => LINEAR_HOLD_LABELS.includes(l.toLowerCase()));
}

/**
 * Reconcile ONE task from its bound provider(s). Never mutates the provider.
 * Returns the actions taken. Safe to call every tick; each effect is idempotent.
 */
export function reconcileTaskFromProvider(db: Database, taskId: string, deps: ProviderDeps): ProviderAction[] {
  const task = getTask(db, taskId);
  if (!task || !isCodeTask(task)) return [];
  const actions: ProviderAction[] = [];
  const authorizedReviewers = deps.authorizedReviewers ?? [DEFAULT_REVIEW_OWNER];

  // A PR may be bound whatever the intake provider is (e.g. a Linear issue with
  // a GitHub PR), so consult GitHub whenever a pr_url/pr_repo+branch exists.
  if (deps.github && (task.pr_url || (task.pr_repo && task.branch))) {
    let ref = parsePrUrl(task.pr_url, task.pr_repo);
    if (!ref && task.branch && task.pr_repo) {
      const byBranch = deps.github.findPullRequestForBranch(task.pr_repo, task.branch);
      if (byBranch) ref = byBranch.ref;
    }
    if (ref) {
      const view = deps.github.getPullRequest(ref);
      if (view) {
        const before = getTask(db, taskId)!;
        const linked = linkTask(db, taskId, {
          prUrl: view.url,
          branch: view.headRefName,
          headSha: view.headSha,
          prRepo: view.ref.repo,
          prBase: view.baseRef,
          prBaseSha: view.baseSha,
          prDiff: `${view.baseSha}...${view.headSha}`,
        });
        if ((linked.head_sha ?? null) !== (before.head_sha ?? null)) {
          actions.push({ kind: "pr-head-bound", taskId, detail: `${before.head_sha ?? "none"} -> ${view.headSha}` });
        } else {
          actions.push({ kind: "pr-bound", taskId, detail: ref.repo + "#" + ref.number });
        }

        if (view.state === "merged") {
          actions.push(...confirmMergeFromView(db, getTask(db, taskId)!, view));
        }

        // Comments cost three `gh api` calls, so fetch them only when the PR
        // actually moved (updatedAt/head changed since the last comment scan).
        const live = getTask(db, taskId)!;
        const prMoved =
          (view.updatedAt ?? "") !== (before.pr_updated_at ?? "") ||
          view.headSha !== (before.head_sha ?? "");
        // The watermark means "comments scanned up to here": advance it ONLY when
        // the scan actually runs. Advancing on a poll while the task is in
        // implement/verify would consume a marker posted before the task reached
        // review (the optimistic watermark would then look unchanged and the
        // marker would never be read).
        if (prMoved && live.phase === "review" && live.state === "review") {
          // Only record the watermark when the scan SUCCEEDED. A failed read
          // returns null; leaving the watermark untouched makes the next poll
          // retry the scan instead of losing a marker to a transient error.
          const comments = deps.github.listComments(ref);
          if (comments !== null) {
            db.query(`UPDATE tasks SET pr_updated_at = ? WHERE id = ?`).run(view.updatedAt ?? "", taskId);
            const markers = parseReviewMarkers(comments, { authorizedReviewers });
            const eff = effectiveVerdictAtHead(markers, live.head_sha);
            if (eff) actions.push(...applyMarker(db, live, eff, deps.authority ?? NO_AUTHORITY));
          } else {
            actions.push({ kind: "comments-unreadable", taskId, detail: ref.repo + "#" + ref.number });
          }
        }
      }
    }
  }

  if (task.provider === "linear" && deps.linear && task.issue_id) {
    const issue = deps.linear.getIssue(task.issue_id);
    if (issue) {
      const live = getTask(db, taskId)!;
      if (linearHolds(issue) && live.state !== "blocked_human" && !isTerminalTaskState(live.state)) {
        quietBlock(db, live, `Linear HOLD (${issue.state}${issue.labels.length ? `: ${issue.labels.join(",")}` : ""})`, "provider:linear");
        actions.push({ kind: "linear-hold", taskId, detail: issue.state });
      }
      if ((issue.state ?? "").toLowerCase() === "done") {
        logEvent(db, { source: "workflow", taskId, type: "workflow.linear_accepted", payload: { issue: issue.id, state: issue.state } });
        actions.push({ kind: "linear-done-observed", taskId });
      }
    }
  }

  return actions;
}

/** Credit a merge only when it is at the merged head we recorded. */
function confirmMergeFromView(db: Database, task: Task, view: PrView): ProviderAction[] {
  if (task.merged_at !== null) return [];
  try {
    confirmMerged(db, task.id, { headSha: view.headSha, repo: view.ref.repo, actor: "provider:github" });
    return [{ kind: "merged", taskId: task.id, detail: view.headSha }];
  } catch (e) {
    if (String(e).includes(HEAD_MISMATCH) || String(e).includes("CODE_CHANGE_GATE")) {
      // Log ONCE per (task, head): an uncreditable merge must not spam the event
      // log on every throttle window.
      const head = view.headSha || task.head_sha || "none";
      if (!mergeNotCreditedLogged(db, task.id, head)) {
        logEvent(db, {
          source: "workflow",
          taskId: task.id,
          type: "workflow.merge_not_credited",
          payload: { head, error: String(e).slice(0, 300) },
        });
      }
      return [{ kind: "merge-not-credited", taskId: task.id, detail: String(e).slice(0, 160) }];
    }
    throw e;
  }
}

/** True when a merge_not_credited event already exists for (task, head). */
function mergeNotCreditedLogged(db: Database, taskId: string, head: string): boolean {
  const row = db
    .query(
      `SELECT 1 AS x FROM events
        WHERE task_id = ? AND type = 'workflow.merge_not_credited' AND payload_json LIKE ?
        LIMIT 1`
    )
    .get(taskId, `%"head":"${head}"%`);
  return !!row;
}

/** Apply an authorized verdict marker as a structured ReviewResult. */
function applyMarker(db: Database, task: Task, marker: ReviewMarker, authority: ProviderAuthority): ProviderAction[] {
  // Structuring a verdict is not a provider write; it needs no authority.
  void authority;
  const verdict = marker.verdict === "OK" ? "pass" : marker.verdict === "NG" ? "fix" : "blocked";
  // Pass the LIVE FULL head recorded on the task, not the (possibly abbreviated)
  // marker SHA: recordReview compares heads exactly. `headsMatch` already proved
  // the marker names this head.
  const liveHead = task.head_sha ?? marker.headSha;
  try {
    recordReview(db, task.id, `provider:${marker.reviewer}`, {
      verdict,
      headSha: liveHead,
      reason: marker.body.slice(0, 2000),
      evidence: `marker:${marker.author}@${marker.createdAt}`,
      externalReviewer: marker.reviewer,
      source: "github-marker",
    });
    return [{ kind: `review-${verdict}`, taskId: task.id, detail: `${marker.verdict}@${liveHead.slice(0, 10)}` }];
  } catch (e) {
    // Duplicate / unresolved-NG / stale-head refusals are expected and are NOT
    // failures: they are the guards doing their job. Log ONCE per
    // (task, marker identity) so an unappliable marker does not spam the event
    // log on every reconcile pass.
    const markerKey = `${marker.author}@${marker.headSha}@${marker.verdict}`;
    if (!markerNotAppliedLogged(db, task.id, markerKey)) {
      logEvent(db, {
        source: "workflow",
        taskId: task.id,
        type: "workflow.marker_not_applied",
        payload: { markerKey, verdict: marker.verdict, head: marker.headSha, error: String(e).slice(0, 300) },
      });
    }
    return [{ kind: "marker-not-applied", taskId: task.id, detail: String(e).slice(0, 120) }];
  }
}

/** True when a marker_not_applied event already exists for this marker identity. */
function markerNotAppliedLogged(db: Database, taskId: string, markerKey: string): boolean {
  const row = db
    .query(
      `SELECT 1 AS x FROM events
        WHERE task_id = ? AND type = 'workflow.marker_not_applied' AND payload_json LIKE ?
        LIMIT 1`
    )
    .get(taskId, `%"markerKey":"${markerKey}"%`);
  return !!row;
}

// ---------------------------------------------------------------------------
// Test fakes (read-only, in-memory; no network)
// ---------------------------------------------------------------------------

export class FakeGitHub implements GitHubReadOnly, ChecksReadOnly {
  readonly name = "fake-github";
  readonly readOnly = true as const;
  private prs = new Map<string, PrView>();
  private comments = new Map<string, CommentView[]>();
  private checks = new Map<string, CheckRunView[] | null>();

  private key(ref: PrRef): string {
    return `${ref.repo}#${ref.number}`;
  }

  putPullRequest(view: PrView): this {
    this.prs.set(this.key(view.ref), view);
    return this;
  }

  putComments(ref: PrRef, comments: CommentView[]): this {
    this.comments.set(this.key(ref), comments);
    return this;
  }

  /**
   * Pin checks to an exact head. `null` simulates a FAILED read (NOT_RUN); an
   * empty array means the head genuinely reported no checks (also NOT_RUN).
   */
  putChecks(ref: PrRef, headSha: string, checks: CheckRunView[] | null): this {
    this.checks.set(`${this.key(ref)}@${headSha}`, checks);
    return this;
  }

  getPullRequest(ref: PrRef): PrView | null {
    return this.prs.get(this.key(ref)) ?? null;
  }

  findPullRequestForBranch(repo: string, branch: string): PrView | null {
    for (const v of this.prs.values()) {
      if (v.ref.repo === repo && v.headRefName === branch) return v;
    }
    return null;
  }

  listComments(ref: PrRef): CommentView[] {
    return this.comments.get(this.key(ref)) ?? [];
  }

  listChecks(ref: PrRef, headSha: string): CheckRunView[] | null {
    const k = `${this.key(ref)}@${headSha}`;
    return this.checks.has(k) ? this.checks.get(k)! : [];
  }
}

export class FakeLinear implements LinearReadOnly {
  readonly name = "fake-linear";
  readonly readOnly = true as const;
  private issues = new Map<string, IssueView>();

  putIssue(issue: IssueView): this {
    this.issues.set(issue.id, issue);
    return this;
  }

  getIssue(id: string): IssueView | null {
    return this.issues.get(id) ?? null;
  }
}
