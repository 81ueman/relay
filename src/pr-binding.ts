import type { Database } from "bun:sqlite";
import { logEvent } from "./events";
import type { Task } from "./schema";
import { getTask } from "./tasks";
import {
  NO_AUTHORITY,
  parsePrUrl,
  type GitHubReadOnly,
  type PrRef,
  type ProviderAuthority,
  type PrView,
} from "./providers";
import { linkTask } from "./workflow";
import { defaultExec, type Exec } from "./provider-adapters";

/**
 * ISH-880 — bind a Sandbox-produced commit to a real GitHub PR and its CURRENT
 * remote HEAD, before the Task may enter the review stage.
 *
 * The Factory stops at reading GitHub (ISH-761); it never publishes. This module
 * is the ONE seam that bridges the exact Sandbox commit (fetched to the host by
 * ISH-828, HEAD-verified by ISH-829) to a GitHub branch/PR, and then binds the
 * PR's live remote HEAD to the SAME Task/attempt. It composes existing pieces
 * only — the read-only `GitHubReadOnly` reader, `linkTask` (whose HEAD fence
 * already invalidates a Review/VERIFY at a moved HEAD) and the point-of-use
 * `ProviderAuthority` — and adds no second workflow engine, provider framework
 * or credential grant.
 *
 * Fail-closed rules (a coding agent can never manufacture a PR binding):
 *   - Task↔PR identity is EXPLICIT: a recorded `pr_url`/`pr_repo#number`. It is
 *     never inferred from a branch name or output text alone. A crash-retry may
 *     ADOPT an existing PR for the task's branch only when BOTH the repo AND the
 *     observed head equal the task's own recorded repo/produced commit.
 *   - the PR is re-read from GitHub and its `headSha` MUST equal the produced
 *     commit; a moved/unreadable/other-repo PR is BLOCKED — never bound, never a
 *     fake review_pass.
 *   - publishing (push + create/update) requires an EXPLICIT point-of-use
 *     `githubWrite` grant AND an authorized publisher; otherwise BLOCKED. There
 *     is no implicit grant and no default publisher.
 *   - retry/restart never creates a duplicate PR: an already-recorded identity is
 *     only re-read, and the publisher is find-or-create.
 *   - NOTHING here merges, approves, deletes a branch, or writes Linear.
 */

export const PR_BINDING_ERROR = "PR_BINDING";

/** Why a bind pass did not reach a verified Task↔PR identity. */
export type PrBindBlockCode =
  | "NOT_CODE_TASK"
  | "NO_PRODUCED_HEAD"
  | "HEAD_MISMATCH"
  | "PROVIDER_UNREADABLE"
  | "PR_UNREADABLE"
  | "PR_NOT_OPEN"
  | "HEAD_MOVED"
  | "REPO_CHANGED"
  | "PUBLISH_UNAUTHORIZED"
  | "NO_PUBLISHER"
  | "REPO_UNKNOWN"
  | "BRANCH_UNKNOWN"
  | "PUBLISH_FAILED"
  | "STALE";

export type PrBindStatus = "bound" | "adopted" | "published" | "blocked";

export interface PrBindingResult {
  taskId: string;
  status: PrBindStatus;
  ref: PrRef | null;
  /** The produced commit the PR head had to equal. */
  expectedHead: string | null;
  /** The PR's observed remote head (null when unreadable). */
  remoteHead: string | null;
  /** True only when THIS pass created the PR (never on a re-read/idempotent pass). */
  created: boolean;
  reason: string | null;
  /** Stable identity of this binding decision (task, head, status, ref). */
  identity: string;
}

// ---------------------------------------------------------------------------
// The authorized publisher seam (push + find-or-create PR)
// ---------------------------------------------------------------------------

export interface PublishRequest {
  /** `owner/name`. */
  repo: string;
  branch: string;
  /** The exact commit to publish (the Sandbox-produced head). */
  headSha: string;
  base: string | null;
  title: string;
  body: string;
}

export interface PublishResult {
  ok: boolean;
  ref: PrRef | null;
  /** True when this call CREATED the PR; false when it reused an existing one. */
  created: boolean;
  error?: string;
}

/**
 * The one publisher seam. A real implementation runs `git push` + `gh pr
 * create`/`gh pr edit` (see `GitGhPrPublisher`); tests use a fake. It is
 * deliberately NOT wired on by default: an operator grants it at the call site.
 */
export interface PrPublisher {
  readonly name: string;
  publish(req: PublishRequest): PublishResult;
}

export interface GitGhPublisherOptions {
  /** The git remote to push the produced commit through (default `origin`). */
  remote?: string;
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
 * Parse a git remote URL to its `owner/name`, or null when it is not a GitHub
 * remote. Understands `https://github.com/O/R(.git)?` (with optional userinfo),
 * `git@github.com:O/R(.git)?` and `ssh://git@github.com[:port]/O/R(.git)?`.
 *
 * This exists so the publisher's "the remote points at the target repo" guard
 * compares PARSED owner/name — a substring test would accept `relay-private`,
 * `relay-fork` and `x81ueman/relay` for `81ueman/relay`.
 */
export function parseGitRemote(url: string): string | null {
  const s = (url ?? "").trim();
  let m = s.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (m) return `${m[1]}/${m[2]}`;
  m = s.match(/^ssh:\/\/git@github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (m) return `${m[1]}/${m[2]}`;
  m = s.match(/^https?:\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (m) return `${m[1]}/${m[2]}`;
  return null;
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
 * The real publisher: push the produced commit to the repo's GitHub remote, then
 * find-or-create the PR with the `gh` CLI (normal `git`/`gh`, no new engine).
 * The remote's URL must point at `req.repo`, so a misconfigured checkout can
 * never push a Task's commit into an unrelated repository.
 */
export class GitGhPrPublisher implements PrPublisher {
  readonly name = "git-gh";
  constructor(
    private repoDir: string,
    private exec: Exec = defaultExec,
    private opts: GitGhPublisherOptions = {}
  ) {}

  publish(req: PublishRequest): PublishResult {
    const remote = this.opts.remote ?? "origin";
    const url = this.exec(["git", "-C", this.repoDir, "remote", "get-url", remote]);
    // Parse the remote to owner/name and require CASE-INSENSITIVE EQUALITY with
    // the target repo. A substring test would accept `relay-private`,
    // `relay-fork` and `x81ueman/relay` for `81ueman/relay`.
    const remoteRepo = url.ok ? parseGitRemote(url.stdout) : null;
    if (!remoteRepo || normalizeRepo(remoteRepo) !== normalizeRepo(req.repo)) {
      return {
        ok: false,
        ref: null,
        created: false,
        error: `remote ${remote} (${url.stdout.trim() || "unreadable"}) does not point at ${req.repo}`,
      };
    }
    const push = this.exec(["git", "-C", this.repoDir, "push", remote, `${req.headSha}:refs/heads/${req.branch}`]);
    if (!push.ok) {
      return { ok: false, ref: null, created: false, error: `git push failed: ${(push.stderr || push.stdout).slice(0, 200)}` };
    }
    const found = this.findOpenPr(req.repo, req.branch);
    if (found) return { ok: true, ref: found, created: false };
    const created = this.exec([
      "gh", "pr", "create",
      "--repo", req.repo,
      "--head", req.branch,
      "--base", req.base ?? "main",
      "--title", req.title,
      "--body", req.body || " ",
    ]);
    if (!created.ok) {
      return { ok: false, ref: null, created: false, error: `gh pr create failed: ${(created.stderr || created.stdout).slice(0, 200)}` };
    }
    const out = created.stdout.trim();
    const ref = parsePrUrl(out.split(/\s+/).pop() ?? "", req.repo) ?? parsePrUrl(out, req.repo);
    if (!ref) return { ok: false, ref: null, created: true, error: "gh pr create printed no recognizable PR url/number" };
    return { ok: true, ref, created: true };
  }

  /**
   * Find an OPEN, SAME-REPO PR for `branch`. `gh pr list --head` also returns
   * cross-repository (fork) PRs, so a fork PR is SKIPPED — its head branch is in
   * another repo, and adopting it would bind the Task to a stranger's PR. A
   * skipped fork is fail-closed: the caller then attempts `gh pr create`.
   */
  private findOpenPr(repo: string, branch: string): PrRef | null {
    const r = this.exec([
      "gh", "pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--limit", "10",
      "--json", "url,number,isCrossRepository,headRepository",
    ]);
    if (!r.ok) return null;
    try {
      const arr = JSON.parse(r.stdout) as {
        url?: string;
        number?: number;
        isCrossRepository?: boolean;
        headRepository?: { nameWithOwner?: string } | null;
      }[];
      if (!Array.isArray(arr)) return null;
      for (const j of arr) {
        if (j.isCrossRepository === true) continue;
        const headRepo = j.headRepository?.nameWithOwner;
        if (headRepo && normalizeRepo(headRepo) !== normalizeRepo(repo)) continue;
        return parsePrUrl(j.url ?? (j.number ? `${repo}#${j.number}` : null), repo);
      }
      return null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Identity + the bind orchestration
// ---------------------------------------------------------------------------

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
  /** The authorized publisher. Absent -> a publish attempt is refused. */
  publisher?: PrPublisher;
  /** Point-of-use authority. Publishing requires `githubWrite`. */
  authority?: ProviderAuthority;
  /** The produced commit the PR head must equal (default `task.head_sha`). */
  expectedHead?: string | null;
  /** The target repository (default `task.pr_repo`). */
  repo?: string | null;
  base?: string | null;
  title?: string;
  body?: string;
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
 * Bind a Task's produced commit to a GitHub PR and its CURRENT remote HEAD.
 *
 * Passes, in order:
 *   1. the task's EXPLICIT PR identity (if recorded) -> re-read and verify;
 *   2. a crash-retry ADOPTION of an existing PR on the task's (repo, branch)
 *      whose head equals the produced commit (no create);
 *   3. otherwise PUBLISH (push + find-or-create) — only with explicit authority;
 * and in every case the re-read remote head must equal the produced commit.
 */
export function bindTaskPr(db: Database, taskId: string, deps: PrBindingDeps = {}): PrBindingResult {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  // The produced commit is the ONLY head a PR may be bound to. A caller-supplied
  // `expectedHead` may only RESTATE it (never override it), so a CLI `--head`
  // can never rewrite task.head_sha to a commit that was never produced.
  const expectedHead = task.head_sha ?? null;
  const repo = deps.repo ?? task.pr_repo ?? null;

  const blocked = (
    code: PrBindBlockCode,
    message: string,
    ref: PrRef | null = null,
    remoteHead: string | null = null,
    created = false
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
      created,
      reason: `${PR_BINDING_ERROR}: ${code}: ${message}`,
      identity,
    };
  };

  const bound = (
    status: "bound" | "adopted" | "published",
    view: PrView,
    created: boolean,
    event: string
  ): PrBindingResult => {
    const linked = linkTask(db, taskId, viewLink(view));
    // linkTask is a no-op on a terminal task / a settled head: a binding that
    // did not actually land on the produced commit is not a binding. EXACT full
    // SHA (case-insensitive), never a prefix.
    if (!sameCommitSha(linked.head_sha, expectedHead)) {
      return blocked("STALE", `linked head ${short(linked.head_sha)} != produced commit ${short(expectedHead)}`, view.ref, view.headSha, created);
    }
    const ref = view.ref;
    const identity = `pr-binding:${taskId}:${expectedHead}:${status}:${ref.repo}#${ref.number}`;
    logEvent(db, {
      source: "pr-binding",
      taskId,
      type: event,
      payload: { repo: ref.repo, number: ref.number, head: view.headSha, expectedHead, created },
    });
    return { taskId, status, ref, expectedHead, remoteHead: view.headSha, created, reason: null, identity };
  };

  const verifiable = (ref: PrRef): { view: PrView } | PrBindingResult => {
    if (!deps.github) return blocked("PROVIDER_UNREADABLE", "no read-only GitHub reader is configured", ref);
    const view = deps.github.getPullRequest(ref);
    if (!view) return blocked("PR_UNREADABLE", `PR ${ref.repo}#${ref.number} could not be re-read from GitHub`, ref);
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
        `PR head ${short(view.headSha)} != the produced commit ${short(expectedHead)}`,
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
  if (!deps.github) return blocked("PROVIDER_UNREADABLE", "no read-only GitHub reader is configured");

  // 1. Explicit identity wins: re-read only (never publish over a recorded PR).
  const existing = resolveTaskPrRef(task);
  if (existing) {
    const r = verifiable(existing);
    if ("status" in r) return r;
    return bound("bound", r.view, false, "pr.bound");
  }

  // 2. Crash-retry adoption: an existing PR for THIS repo+branch whose head is
  // the produced commit. Repo AND head are both required, so this is not
  // branch-name-only identity inference. A FORK PR (same branch name + SHA) is
  // rejected instead of adopted.
  const found = repo && task.branch ? deps.github.findPullRequestForBranch(repo, task.branch) : null;
  if (found) {
    if (!prHeadRepoSafe(found, repo)) {
      return blocked(
        "REPO_CHANGED",
        `adoptable PR ${found.ref.repo}#${found.ref.number} head repo ${found.headRepo || "(unknown)"} is not ${repo} (cross-repository/fork)`,
        found.ref,
        found.headSha
      );
    }
    if (found.headSha && sameCommitSha(found.headSha, expectedHead)) {
      if (found.state !== "open") {
        return blocked("PR_NOT_OPEN", `adoptable PR ${found.ref.repo}#${found.ref.number} is ${found.state}`, found.ref, found.headSha);
      }
      return bound("adopted", found, false, "pr.adopted");
    }
  }

  // 3. Publish — only with an explicit point-of-use grant AND a publisher.
  const authority = deps.authority ?? NO_AUTHORITY;
  if (!authority.githubWrite) {
    return blocked("PUBLISH_UNAUTHORIZED", "no point-of-use GitHub write authority; refusing to push or create a PR");
  }
  if (!deps.publisher) return blocked("NO_PUBLISHER", "no authorized PR publisher is configured");
  if (!repo) return blocked("REPO_UNKNOWN", "the task records no pr_repo to publish into");
  if (!task.branch) return blocked("BRANCH_UNKNOWN", "the task records no branch to publish");

  const published = deps.publisher.publish({
    repo,
    branch: task.branch,
    headSha: expectedHead,
    base: deps.base ?? task.pr_base ?? null,
    title: deps.title ?? task.title ?? taskId,
    body: deps.body ?? "",
  });
  if (!published.ok || !published.ref) {
    return blocked("PUBLISH_FAILED", published.error ?? "the publisher returned no PR", null, null, published.created);
  }
  const r = verifiable(published.ref);
  if ("status" in r) return r;
  return bound("published", r.view, published.created, "pr.published");
}

/** One-line summary + the reason, for CLI rendering. */
export function formatPrBindingResult(r: PrBindingResult): string {
  const ref = r.ref ? `${r.ref.repo}#${r.ref.number}` : "-";
  const line = `${r.taskId}  ${r.status.toUpperCase()}  pr=${ref}  head=${short(r.remoteHead)}  expected=${short(r.expectedHead)}`;
  return r.reason ? `${line}\n  ${r.reason}` : line;
}
