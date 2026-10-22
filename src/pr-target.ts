import type { Task } from "./schema";

/**
 * ISH-1087 — where a Task's GitHub PR lives.
 *
 * The Factory's live intake does not always record `pr_repo`: an ishiul Task is
 * created from a Linear issue and only the *workspace* knows the GitHub remote.
 * Before this module the read-only PR binding therefore skipped such a Task
 * entirely (`task.pr_repo || task.pr_url` was false), the worker was never told
 * to open a PR, and the merge gate reported `NO_PR` for a Task that could have
 * had one. This resolves the target repo/base from every durable source, in
 * order:
 *
 *   1. the Task's own recorded `pr_repo` / `pr_url` (an explicit identity);
 *   2. the Task workspace's `origin` (a self-contained clone is re-pointed at
 *      the source repo's real remote);
 *   3. the Factory's source checkout.
 *
 * It is pure/read-only: no network, no GitHub write, no Task mutation.
 */

/** Strict `owner/name` (GitHub path segments; no scheme/path/git suffix). */
const REPO_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Normalize a bare or `github.com/`-prefixed `owner/name`, or null. */
export function normalizeRepoSlug(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/^github\.com[/:]/i, "");
  s = s.replace(/\.git$/i, "");
  s = s.replace(/^\/+|\/+$/g, "");
  if (s.split("/").some((part) => part === "." || part === "..")) return null;
  return REPO_SLUG_RE.test(s) ? s : null;
}

/** Parse the `owner/name` from a GitHub remote/PR URL, or null. */
export function repoFromRemoteUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  const s = url.trim();
  // https://github.com/o/r(.git), ssh://git@github.com/o/r(.git),
  // git@github.com:o/r(.git), github.com/o/r
  const m = s.match(/github\.com(?::\d+)?[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? normalizeRepoSlug(`${m[1]}/${m[2]}`) : null;
}

/** Parse the `owner/name` from a linked PR url, or null. */
export function repoFromPrUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const m = url.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+/i);
  if (m) return normalizeRepoSlug(`${m[1]}/${m[2]}`);
  // The compact form recorded by intake/CLI: `owner/repo#n`.
  const compact = url.match(/^([^#\s]+\/[^#\s]+)#\d+$/);
  return compact ? normalizeRepoSlug(compact[1]) : null;
}

/** The `owner/name` of a checkout's `origin`, or null. Never throws. */
export function gitOriginRepo(dir: string | null | undefined): string | null {
  if (!dir) return null;
  try {
    const p = Bun.spawnSync(["git", "-C", dir, "remote", "get-url", "origin"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (p.exitCode !== 0) return null;
    return repoFromRemoteUrl(p.stdout.toString());
  } catch {
    return null;
  }
}

export type PrTargetSource = "task" | "worktree" | "repo";

export interface ResolvedPrTarget {
  /** `owner/name` of the GitHub repository the PR belongs to. */
  repo: string;
  /** The PR's base branch (default `main`). */
  base: string;
  source: PrTargetSource;
}

export interface PrTargetOptions {
  /**
   * The Factory's source checkout (a path) or an explicit `owner/name`. A slug
   * is accepted so tests/operators can name the repo without a checkout.
   */
  repo?: string | null;
  /**
   * The Task workspace to read `origin` from (defaults to `task.worktree`).
   * A Sandbox caller may pass the host source because the in-VM path is not
   * readable from the host.
   */
  worktree?: string | null;
}

/**
 * Resolve the Task's GitHub PR target across all durable sources. `null` means
 * the Task is genuinely local-only (no GitHub repo anywhere) — never an
 * inferred owner from a branch name.
 */
export function resolveTaskPrTarget(
  task: Pick<Task, "pr_url" | "pr_repo" | "pr_base" | "worktree">,
  opts: PrTargetOptions = {}
): ResolvedPrTarget | null {
  const base = (task.pr_base ?? "").trim() || "main";
  const explicit = normalizeRepoSlug(task.pr_repo) ?? repoFromPrUrl(task.pr_url);
  if (explicit) return { repo: explicit, base, source: "task" };

  const fromWorktree = gitOriginRepo(opts.worktree ?? task.worktree);
  if (fromWorktree) return { repo: fromWorktree, base, source: "worktree" };

  const repo = normalizeRepoSlug(opts.repo) ?? gitOriginRepo(opts.repo);
  if (repo) return { repo, base, source: "repo" };

  return null;
}

/**
 * The issue key a PR title must carry: `ISH-<n>` when the Task records one
 * (issue id, else the leading token of its title), otherwise the Task id.
 * Never invents an issue number.
 */
export function issueKeyForTask(task: Pick<Task, "id" | "issue_id" | "title">): string {
  const issue = (task.issue_id ?? "").trim();
  const fromIssue = issue.match(/^(ISH-\d+)(?:$|[^0-9])/i);
  if (fromIssue) return fromIssue[1].toUpperCase();
  const fromTitle = (task.title ?? "").trim().match(/^(ISH-\d+)(?:$|[^0-9])/i);
  if (fromTitle) return fromTitle[1].toUpperCase();
  return task.id;
}
