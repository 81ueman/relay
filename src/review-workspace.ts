import { hostGit } from "./sandbox";
import { gitHead } from "./verify";

/**
 * ISH-904 — the source a Task workspace is read from. The Task workspace is a
 * self-contained clone: `origin` points at the GitHub remote, so a local object
 * the Run created (its commit) is NOT in this clone's `origin`. The SOURCE repo
 * does not share the workspace's object store either (the local clone copies /
 * hardlinks, it does not alternate), so the produced HEAD is imported into the
 * source first — a LOCAL path fetch, no network — and the detached review
 * worktree can then be materialised there from the recorded head.
 *
 * Never fails the review here: when the import is impossible the source is
 * returned unchanged and the existing `git worktree add` fails closed.
 */
export function importHeadIntoSource(source: string, workspace: string | null | undefined, head: string | null): string {
  if (!workspace || !head || !SHA_RE.test(head) || workspace === source) return source;
  if (hostGit(source, ["cat-file", "-e", `${head}^{commit}`]).ok) return source;
  const imported = hostGit(source, ["fetch", "-q", "--no-tags", workspace, `+refs/heads/*:refs/relay-workspace/*`]);
  if (!imported.ok) hostGit(source, ["fetch", "-q", "--no-tags", workspace, `${head}:refs/relay-workspace/${head}`]);
  return source;
}

/**
 * ISH-829 — the reviewer's independent, fixed-HEAD disposable detached workspace.
 *
 * The mechanical VERIFY runs against the writer's checkout. The independent
 * reviewer must NOT read that live checkout: a writer (or a stray process) could
 * still be editing it, which would let a review be credited for content that is
 * not the reviewed HEAD. This helper materialises a DETACHED git worktree at the
 * exact recorded head, so the reviewer sees an immutable snapshot.
 *
 * It is a thin `git worktree` wrapper (no new review engine): the existing
 * `runHeadlessReview` brief/verdict/`recordReview` path is unchanged and is given
 * `reviewWorktree` instead of `task.worktree`.
 */

export interface ReviewWorkspace {
  ok: boolean;
  /** The read-only checkout, or null on failure. */
  path: string | null;
  /** The HEAD the checkout actually has (should equal the requested head). */
  head: string | null;
  error?: string;
}

const SHA_RE = /^[0-9a-f]{7,40}$/;

/**
 * `git worktree add --detach --force <dir> <head>` in `source`, then CONFIRM the
 * checkout is at `head`. Any failure (a bad sha, a git error, a moved HEAD) is
 * `ok:false` and the partial worktree is removed — a review that cannot be bound
 * to the fixed HEAD must fail closed, never fall back to the live worktree.
 */
export function prepareReadOnlyReviewWorktree(source: string, head: string | null | undefined, dir: string): ReviewWorkspace {
  if (!head || !SHA_RE.test(head)) {
    return { ok: false, path: null, head: null, error: `invalid review head '${head ?? "none"}'` };
  }
  const add = hostGit(source, ["worktree", "add", "--detach", "--force", dir, head]);
  if (!add.ok) {
    return { ok: false, path: null, head: null, error: `git worktree add failed: ${(add.err || add.out).slice(0, 200)}` };
  }
  const got = gitHead(dir);
  if (got !== head) {
    hostGit(source, ["worktree", "remove", "--force", dir]);
    return { ok: false, path: null, head: got, error: `review worktree HEAD ${got ?? "none"} != ${head}` };
  }
  return { ok: true, path: dir, head };
}

/** Best-effort teardown of a review worktree (never fails a review). */
export function removeReviewWorktree(source: string, dir: string | null | undefined): void {
  if (!dir) return;
  hostGit(source, ["worktree", "remove", "--force", dir]);
}

/** True when `path` is checked out at `head` (used as a post-review guard). */
export function reviewWorktreeAtHead(path: string, head: string | null): boolean {
  return !!head && gitHead(path) === head;
}
