import type { Database } from "bun:sqlite";
import { logEvent } from "./events";
import type { Task } from "./schema";
import { isTerminalTaskState } from "./schema";
import { getTask } from "./tasks";
import { parsePrUrl, type GitHubReadOnly, type PrRef, type PrView } from "./providers";
import { normalizeRepoSlug, resolveTaskPrTarget } from "./pr-target";
import { activeProviderRateLimit, providerRateLimitedReason } from "./provider-rate-limit";
import { linkTask } from "./workflow";

/**
 * ISH-885 — the READ-ONLY Task↔PR check.
 *
 * The GitHub PR workflow is Agent-owned: the Coding Agent (dsh/DeepSeek) does
 * `git commit` + `git push` + `gh pr create`/update in its own Task workspace,
 * and the independent Claude reviewer posts a native `gh pr review`. Relay is the
 * supervisor and NEVER writes to GitHub — it has no publisher, no `git push`, no
 * PR mutation and no review submission. (The ISH-880 `GitGhPrPublisher` /
 * `--publish` write path was removed by ISH-885: Agent tools, not Relay
 * capabilities.)
 *
 * This module is the ONE seam that binds the exact produced commit
 * (HEAD-verified by mechanical VERIFY) to a GitHub PR by RE-READING GitHub and
 * then binds the PR's live remote HEAD to the SAME
 * Task/attempt. It composes existing pieces only — the read-only `GitHubReadOnly`
 * reader and `linkTask` (whose HEAD fence already invalidates a Review/VERIFY at
 * a moved HEAD) — and adds no second workflow engine, provider framework,
 * credential grant or write path.
 *
 * Fail-closed rules (a coding agent can never manufacture a PR binding):
 *   - Task↔PR identity is EXPLICIT: a recorded `pr_url`/`pr_repo#number`, or a
 *     crash-retry ADOPTION of an existing PR for the task's (repo, branch) whose
 *     observed head equals the task's own produced commit. It is never inferred
 *     from a branch name or output text alone.
 *   - the PR is re-read from GitHub and its `headSha` MUST equal the produced
 *     commit; a moved/unreadable/other-repo PR is BLOCKED — never bound, never a
 *     fake review_pass.
 *   - ISH-885 legitimate FIX: the Agent updates the SAME PR from old commit A to
 *     new commit B and pushes B FIRST; Relay then only OBSERVES B. If the PR still
 *     shows A while the Task has produced B, Relay refuses (the Agent has not
 *     published yet) rather than overwriting the remote head itself.
 *   - retry/restart never creates a duplicate PR: an already-recorded identity is
 *     only re-read, and no adoption ever creates.
 *   - NOTHING here pushes, creates/updates a PR, posts a review, merges, approves,
 *     deletes a branch, or writes Linear.
 */

export const PR_BINDING_ERROR = "PR_BINDING";

/** Why a bind pass did not reach a verified Task↔PR identity. */
export type PrBindBlockCode =
  | "NOT_CODE_TASK"
  | "NO_PRODUCED_HEAD"
  | "HEAD_MISMATCH"
  | "PROVIDER_UNREADABLE"
  | "PROVIDER_RATE_LIMITED"
  | "PR_UNREADABLE"
  | "PR_NOT_OPEN"
  | "HEAD_MOVED"
  | "REPO_CHANGED"
  | "NO_PR_IDENTITY"
  | "STALE";

export type PrBindStatus = "bound" | "adopted" | "blocked";

export interface PrBindingResult {
  taskId: string;
  status: PrBindStatus;
  ref: PrRef | null;
  /** The produced commit the PR head had to equal. */
  expectedHead: string | null;
  /** The PR's observed remote head (null when unreadable). */
  remoteHead: string | null;
  reason: string | null;
  /** ISH-1132: the structured block reason (null when bound). */
  code: PrBindBlockCode | null;
  /** Stable identity of this binding decision (task, head, status, ref). */
  identity: string;
}

/** Full 40-hex commit SHAs only — a short/abbreviated SHA is never an identity. */
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

export function isFullCommitSha(sha: string | null | undefined): sha is string {
  return typeof sha === "string" && FULL_SHA_RE.test(sha);
}

/**
 * True only when both are the SAME full 40-hex commit (case-insensitive). This
 * replaces `headsMatch` (which accepts a PREFIX in either direction) so a PR
 * head can never be matched to — or rewrite the produced commit with — an
 * abbreviated or merely-similar SHA.
 */
export function sameCommitSha(a: string | null | undefined, b: string | null | undefined): boolean {
  return isFullCommitSha(a) && isFullCommitSha(b) && a.toLowerCase() === b.toLowerCase();
}

/** Normalize `owner/name` for a case-insensitive comparison. */
export function normalizeRepo(repo: string): string {
  return repo.trim().toLowerCase();
}

/**
 * True only when a PR's HEAD branch is provably in `repo` — never a fork. A
 * `gh pr list --head <branch>` lookup returns CROSS-REPOSITORY (fork) PRs, so a
 * fork PR with a same-named branch at the same SHA must never be adopted as the
 * Task's PR. Fail-closed: a view whose provenance is unknown (no explicit
 * `isCrossRepository: false` and no matching head repo) is NOT trusted.
 */
export function prHeadRepoSafe(view: PrView, repo: string | null): boolean {
  if (view.isCrossRepository === true) return false;
  const headRepo = (view.headRepo ?? "").trim();
  if (repo && headRepo) return normalizeRepo(headRepo) === normalizeRepo(repo);
  return repo ? view.isCrossRepository === false : true;
}

/**
 * The EXPLICIT Task↔PR identity recorded on the task, or null. Only a recorded
 * `pr_url` (`owner/repo#n`, a github PR URL, or `#n` with a `pr_repo`) counts —
 * a branch name is never an identity.
 */
export function resolveTaskPrRef(task: Pick<Task, "pr_url" | "pr_repo">): PrRef | null {
  return parsePrUrl(task.pr_url, task.pr_repo);
}

export interface PrBindingDeps {
  /** Read-only GitHub reader. Required to re-read + verify the remote head. */
  github?: GitHubReadOnly;
  /** The produced commit the PR head must equal (default `task.head_sha`). */
  expectedHead?: string | null;
  /**
   * The target repository as `owner/name`. Default: resolve from the task's
   * recorded `pr_repo`/`pr_url`, else the Task workspace's `origin`. A live
   * Factory Task often records neither, so this is what lets the read-only
   * adoption pass see the PR the Coding Agent opened.
   */
  repo?: string | null;
  /** The Factory's source checkout (used only to resolve `repo`). */
  sourceRepo?: string | null;
}

function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 10) : "none";
}

function viewLink(view: PrView) {
  return {
    prUrl: view.url,
    branch: view.headRefName,
    headSha: view.headSha,
    prRepo: view.ref.repo,
    prBase: view.baseRef,
    prBaseSha: view.baseSha,
    prDiff: `${view.baseSha}...${view.headSha}`,
  };
}

/**
 * Bind a Task's produced commit to a GitHub PR and its CURRENT remote HEAD — by
 * READING GitHub only. Passes, in order:
 *   1. the task's EXPLICIT PR identity (if recorded) -> re-read and verify;
 *   2. a crash-retry ADOPTION of an existing PR on the task's (repo, branch)
 *      whose head equals the produced commit (no create);
 *   3. otherwise BLOCKED: Relay never publishes; the Coding Agent must push and
 *      create/update the PR first.
 * In every case the re-read remote head must equal the produced commit.
 */
export async function bindTaskPr(
  db: Database,
  taskId: string,
  deps: PrBindingDeps = {}
): Promise<PrBindingResult> {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  // The produced commit is the ONLY head a PR may be bound to. A caller-supplied
  // `expectedHead` may only RESTATE it (never override it), so a CLI `--head`
  // can never rewrite task.head_sha to a commit that was never produced.
  const expectedHead = task.head_sha ?? null;
  // The Task's own recorded identity wins; a live Factory Task that records only
  // a branch still resolves its GitHub repo from the workspace/source origin, so
  // the PR the Coding Agent opened is OBSERVED instead of reported as NO_PR.
  const resolved = resolveTaskPrTarget(task, { repo: deps.sourceRepo ?? null });
  // `repo` is normally `owner/name`; a caller that passes a source checkout path
  // is resolved through its `origin` instead of being treated as a slug.
  const repo =
    normalizeRepoSlug(deps.repo) ??
    (deps.repo ? resolveTaskPrTarget(task, { repo: deps.repo })?.repo ?? null : null) ??
    resolved?.repo ??
    null;

  const blocked = (
    code: PrBindBlockCode,
    message: string,
    ref: PrRef | null = null,
    remoteHead: string | null = null
  ): PrBindingResult => {
    const identity = `pr-binding:${taskId}:${expectedHead ?? "none"}:blocked:${code}`;
    logEvent(db, {
      source: "pr-binding",
      taskId,
      type: "pr.bind_blocked",
      payload: { code, reason: message, expectedHead, repo, ref: ref ?? null, remoteHead },
    });
    return {
      taskId,
      status: "blocked",
      ref,
      expectedHead,
      remoteHead,
      reason: `${PR_BINDING_ERROR}: ${code}: ${message}`,
      code,
      identity,
    };
  };

  const bound = (status: "bound" | "adopted", view: PrView, event: string): PrBindingResult => {
    const linked = linkTask(db, taskId, viewLink(view));
    // ISH-1245: the PR read is asynchronous, so the Task can be closed while it
    // is in flight. linkTask keeps the terminal state; a binding that did not
    // land is refused and audited (never reported as "bound" just because the
    // unchanged head happens to match).
    if (isTerminalTaskState(linked.state)) {
      logEvent(db, {
        source: "pr-binding",
        taskId,
        type: "task.late_result_ignored",
        payload: {
          kind: "PrBinding",
          taskState: linked.state,
          status,
          repo: view.ref.repo,
          number: view.ref.number,
          head: view.headSha,
          expectedHead,
          reason: "PR binding finished after the Task was closed",
        },
      });
      return blocked(
        "STALE",
        `task ${taskId} is ${linked.state}; a PR binding cannot re-open a closed Task`,
        view.ref,
        view.headSha
      );
    }
    // linkTask is a no-op on a settled head: a binding that did not actually land
    // on the produced commit is not a binding. EXACT full SHA (case-insensitive),
    // never a prefix.
    if (!sameCommitSha(linked.head_sha, expectedHead)) {
      return blocked("STALE", `linked head ${short(linked.head_sha)} != produced commit ${short(expectedHead)}`, view.ref, view.headSha);
    }
    const ref = view.ref;
    const identity = `pr-binding:${taskId}:${expectedHead}:${status}:${ref.repo}#${ref.number}`;
    logEvent(db, {
      source: "pr-binding",
      taskId,
      type: event,
      payload: { repo: ref.repo, number: ref.number, head: view.headSha, expectedHead },
    });
    return { taskId, status, ref, expectedHead, remoteHead: view.headSha, reason: null, code: null, identity };
  };

  /**
   * Re-read the PR and verify its IDENTITY (repo, non-fork, open) AND that its
   * live head is the produced commit. Relay only ever OBSERVES; it never moves
   * the head. If the Agent has not pushed the produced commit yet, the head
   * mismatch is a HEAD_MOVED block (retry the Agent), not a Relay write.
   */
  const verifiable = async (ref: PrRef): Promise<{ view: PrView } | PrBindingResult> => {
    if (!deps.github) {
      return blocked(
        "PROVIDER_UNREADABLE",
        "no read-only GitHub reader is configured (set RELAY_PROVIDER_GITHUB=gh, or authenticate gh so the operator path can auto-detect it)",
        ref
      );
    }
    const view = await deps.github.getPullRequest(ref);
    if (!view) {
      // ISH-1132: an exhausted API budget is retryable and typed, not a
      // "PR unreadable"/"provider not configured" verdict.
      const limited = activeProviderRateLimit(deps.github.rateLimit?.());
      if (limited) return blocked("PROVIDER_RATE_LIMITED", providerRateLimitedReason(limited), ref);
      return blocked("PR_UNREADABLE", `PR ${ref.repo}#${ref.number} could not be re-read from GitHub`, ref);
    }
    if (view.ref.repo !== ref.repo) {
      return blocked("REPO_CHANGED", `PR ${ref.repo}#${ref.number} resolved to repo ${view.ref.repo}`, ref);
    }
    if (repo && view.ref.repo !== repo) {
      return blocked("REPO_CHANGED", `PR repo ${view.ref.repo} != the task's recorded repo ${repo}`, ref, view.headSha);
    }
    // A fork PR (the head branch lives in another repo) is never the Task's PR,
    // even at the same branch name and SHA.
    if (!prHeadRepoSafe(view, repo ?? ref.repo)) {
      return blocked(
        "REPO_CHANGED",
        `PR ${ref.repo}#${ref.number} head repo ${view.headRepo || "(unknown)"} is not ${repo ?? ref.repo} (cross-repository/fork)`,
        ref,
        view.headSha
      );
    }
    if (view.state !== "open") {
      return blocked("PR_NOT_OPEN", `PR ${ref.repo}#${ref.number} is ${view.state}, not open`, ref, view.headSha);
    }
    if (!sameCommitSha(view.headSha, expectedHead)) {
      return blocked(
        "HEAD_MOVED",
        `PR head ${short(view.headSha)} != the produced commit ${short(expectedHead)}; the Coding Agent must push the produced commit to the same PR before Relay can bind it`,
        ref,
        view.headSha
      );
    }
    return { view };
  };

  if (!task.code_change) return blocked("NOT_CODE_TASK", `task ${taskId} is not a code-change task`);
  if (!expectedHead) return blocked("NO_PRODUCED_HEAD", "the task records no produced commit to bind");
  if (!isFullCommitSha(expectedHead)) {
    return blocked("NO_PRODUCED_HEAD", `the task head ${short(expectedHead)} is not a full 40-hex commit SHA`);
  }
  if (deps.expectedHead !== undefined && !sameCommitSha(deps.expectedHead, expectedHead)) {
    return blocked(
      "HEAD_MISMATCH",
      `expected head ${short(deps.expectedHead)} != the produced commit ${short(expectedHead)} (a binding may only restate the produced commit)`
    );
  }
  if (!deps.github) {
    return blocked(
      "PROVIDER_UNREADABLE",
      "no read-only GitHub reader is configured (set RELAY_PROVIDER_GITHUB=gh, or authenticate gh so the operator path can auto-detect it)"
    );
  }
  const activeLimit = activeProviderRateLimit(deps.github.rateLimit?.());
  if (activeLimit) {
    return blocked("PROVIDER_RATE_LIMITED", providerRateLimitedReason(activeLimit));
  }

  // 1. Explicit identity wins: re-read + verify only.
  const existing = resolveTaskPrRef(task);
  if (existing) {
    const r = await verifiable(existing);
    if ("status" in r) return r;
    return bound("bound", r.view, "pr.bound");
  }

  // 2. Crash-retry adoption: an existing PR for THIS repo+branch whose head is
  // the produced commit. Repo AND head are both required, so this is not
  // branch-name-only identity inference. A FORK PR (same branch name + SHA) is
  // rejected instead of adopted.
  const found = repo && task.branch ? await deps.github.findPullRequestForBranch(repo, task.branch) : null;
  if (!found) {
    const limited = activeProviderRateLimit(deps.github.rateLimit?.());
    if (limited) return blocked("PROVIDER_RATE_LIMITED", providerRateLimitedReason(limited));
  }
  if (found) {
    if (!prHeadRepoSafe(found, repo)) {
      return blocked(
        "REPO_CHANGED",
        `adoptable PR ${found.ref.repo}#${found.ref.number} head repo ${found.headRepo || "(unknown)"} is not ${repo} (cross-repository/fork)`,
        found.ref,
        found.headSha
      );
    }
    if (found.state !== "open") {
      return blocked("PR_NOT_OPEN", `adoptable PR ${found.ref.repo}#${found.ref.number} is ${found.state}`, found.ref, found.headSha);
    }
    if (!found.headSha || !sameCommitSha(found.headSha, expectedHead)) {
      // The PR EXISTS but its live head is not the produced commit yet. Naming
      // HEAD_MOVED (instead of the generic NO_PR_IDENTITY) tells the Coding
      // Agent to push/update the SAME PR rather than open another one.
      return blocked(
        "HEAD_MOVED",
        `PR ${found.ref.repo}#${found.ref.number} head ${short(found.headSha)} != the produced commit ${short(expectedHead)}; the Coding Agent must push the produced commit to the SAME PR before Relay can bind it`,
        found.ref,
        found.headSha
      );
    }
    return bound("adopted", found, "pr.adopted");
  }

  // 3. No identity and no adoptable PR: Relay does NOT publish. The Coding Agent
  // owns the GitHub write and must create/update the PR first.
  return blocked(
    "NO_PR_IDENTITY",
    `the task records no PR identity and no open PR for ${repo ?? "(unknown repo)"}@${task.branch ?? "(no branch)"} matches the produced commit ${short(expectedHead)}; the Coding Agent must push and create/update the PR first (Relay never writes to GitHub)`
  );
}

/** One-line summary + the reason, for CLI rendering. */
export function formatPrBindingResult(r: PrBindingResult): string {
  const ref = r.ref ? `${r.ref.repo}#${r.ref.number}` : "-";
  const line = `${r.taskId}  ${r.status.toUpperCase()}  pr=${ref}  head=${short(r.remoteHead)}  expected=${short(r.expectedHead)}`;
  return r.reason ? `${line}\n  ${r.reason}` : line;
}

// ISH-1087: the repo/base resolver lives in a small dependency-free module so
// the Factory, merge gate and Run brief share ONE inference rule. Re-exported
// here (the Task↔PR seam) for callers that already import this module.
export {
  gitOriginRepo,
  issueKeyForTask,
  normalizeRepoSlug,
  repoFromPrUrl,
  repoFromRemoteUrl,
  resolveTaskPrTarget,
} from "./pr-target";
export type { PrTargetOptions, PrTargetSource, ResolvedPrTarget } from "./pr-target";
