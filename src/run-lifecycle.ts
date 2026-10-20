import type { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { defaultDbPath, now, projectRoot } from "./db";
import { logEvent } from "./events";
import type { Run, Task, TaskResult } from "./schema";
import { isTerminalTaskState } from "./schema";
import { getTask } from "./tasks";
import {
  assertNoActiveWriter,
  buildTaskPrompt,
  findActiveWriter,
  getRun,
  startDshRun,
  type DshRunHandle,
  type DshSpawner,
} from "./dsh-runner";
import { taskChecks } from "./workflow";
import type { CheckSpec } from "./verify";
import { redactSecrets } from "./lab";

/**
 * ISH-760 — Task Worktree + disposable dsh Run lifecycle, single-writer.
 *
 * The Task (and the branch + Worktree it owns) is DURABLE; a headless dsh Run is
 * DISPOSABLE. This module is the Relay side that:
 *
 *   - creates/selects and OWNS one branch + worktree per Task;
 *   - pins the Run brief (the Task spec + the recorded verification steps + the
 *     PREVIOUS findings) into the worktree BEFORE launch, so there is no shared
 *     `/tmp` and no late-prompt race;
 *   - launches exactly ONE dsh Run per phase/attempt through ISH-803's
 *     `startDshRun` (single-writer is enforced there: a second writer on the
 *     same worktree/branch is refused until the previous Run is terminal);
 *   - re-enters a FIX as the SAME worktree + findings + a NEW Run — no session
 *     continuation, no Herdr pane/session attach;
 *   - cleans a workspace up only when it is SAFE (a real merge or an explicit
 *     abort, no open PR, no active writer, no uncommitted changes, relay-owned),
 *     while retaining the Run logs/evidence.
 *
 * It does NOT reimplement the phase machine (ISH-758) or the dsh process runner
 * (ISH-803): it composes `startDshRun` / `acceptRunSubmission` and the workflow's
 * structured results.
 */

export const WORKTREE_ERROR = "WORKTREE_ERROR";
/** A second writer into the same worktree/branch was refused (see ISH-803). */
export { DUPLICATE_WRITER, findActiveWriter } from "./dsh-runner";

// ---------------------------------------------------------------------------
// git seam (injectable so tests can drive a real temp repo, no Herdr)
// ---------------------------------------------------------------------------

export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

/** Run git in `cwd`, capturing stdout/stderr (never throws). */
export function gitRun(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): GitResult {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    });
    return { ok: true, out: out.trim(), err: "" };
  } catch (e) {
    const anyE = e as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      ok: false,
      out: (anyE.stdout ?? "").toString().trim(),
      err: (anyE.stderr ?? anyE.message ?? "").toString().trim(),
    };
  }
}

export function isGitWorktree(dir: string): boolean {
  return gitRun(dir, ["rev-parse", "--is-inside-work-tree"]).out === "true";
}

/** `git-dir` and `git-common-dir` of `dir`, absolute (resolved), or null. */
export function gitDirs(dir: string): { gitDir: string; commonDir: string } | null {
  const r = gitRun(dir, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
  const [gitDir, commonDir] = r.ok ? r.out.split("\n") : [];
  if (!gitDir || !commonDir) return null;
  // realpath: git reports the physical path (/var -> /private/var on macOS) and
  // `dir` may be the symlinked spelling, so compare in one space.
  return { gitDir: realpathOf(gitDir), commonDir: realpathOf(commonDir) };
}

/** The checkout's (resolved) git COMMON dir — where `objects/` and `info/` live. */
export function gitCommonDir(dir: string): string | null {
  const r = gitRun(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return r.ok && r.out ? realpathOf(r.out) : null;
}

function realpathOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * ISH-904: every git dir the checkout needs lives INSIDE the checkout itself, so
 * a `workspace-write` Run (writable set = the session cwd) can run every git
 * mutation — commit, index.lock, ORIG_HEAD, refs — without escalating.
 *
 * A relay Task workspace is a LOCAL CLONE (`.git/` inside the path); a linked
 * `git worktree add` checkout is NOT self-contained: its git dir is
 * `<source>/.git/worktrees/<T>` and its common dir `<source>/.git`, both outside.
 */
export function isSelfContainedWorkspace(dir: string): boolean {
  if (!isGitWorktree(dir)) return false;
  const dirs = gitDirs(dir);
  if (!dirs) return false;
  const root = realpathOf(dir);
  return isUnder(dirs.gitDir, root) && isUnder(dirs.commonDir, root);
}

/** The source repo's `origin` URL (what a Run push must target), or null. */
export function gitOriginUrl(repo: string): string | null {
  const r = gitRun(repo, ["remote", "get-url", "origin"]);
  return r.ok && r.out ? r.out : null;
}

export function gitHeadOf(dir: string): string | null {
  const r = gitRun(dir, ["rev-parse", "HEAD"]);
  return r.ok && r.out ? r.out : null;
}

export function gitCurrentBranch(dir: string): string | null {
  const r = gitRun(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.ok && r.out && r.out !== "HEAD" ? r.out : null;
}

// ---------------------------------------------------------------------------
// Worktree: create / select / own
// ---------------------------------------------------------------------------

const SANITIZE_RE = /[^a-zA-Z0-9._-]+/g;
function sanitizeId(id: string): string {
  return id.replace(SANITIZE_RE, "-").replace(/^-+|-+$/g, "") || "task";
}

/**
 * The branch a Task is implemented on. The Task's own recorded branch wins; else
 * a deterministic `relay/<issue-or-id>` (repo/state safe), so re-running is
 * idempotent instead of minting a new branch.
 */
export function taskBranchName(task: Pick<Task, "id" | "branch" | "issue_id" | "slice">): string {
  if (task.branch) return task.branch;
  const base = (task.issue_id ?? task.id).toLowerCase();
  const slug = base.replace(SANITIZE_RE, "-").replace(/^-+|-+$/g, "");
  const slice = (task.slice ?? "").trim();
  const suffix = slice ? `-${slice.replace(SANITIZE_RE, "-").replace(/^-+|-+$/g, "")}` : "";
  return `relay/${slug || task.id}${suffix}`;
}

/** The root under which Relay creates Task worktrees (`<control-plane>/worktrees`). */
export function taskWorktreesRoot(dbRoot?: string): string {
  return dbRoot ? resolve(dbRoot) : join(dirname(defaultDbPath()), "worktrees");
}

export interface EnsureWorktreeOptions {
  /** The MAIN checkout to add the worktree from (default: the project root). */
  repo?: string;
  /** Override the worktree path. */
  path?: string;
  /** Override the branch. */
  branch?: string;
  /** Base ref for a NEW branch (default: `task.pr_base`, else `origin/main`, else HEAD). */
  base?: string;
  /** Root for Relay-created worktrees (default `taskWorktreesRoot()`). */
  worktreesRoot?: string;
  /**
   * ISH-904: receive non-fatal base-resolution warnings (a failed `origin`
   * refresh, or a base that is behind `origin/main`). The binding always carries
   * them too; this lets the CLI print them to stderr.
   */
  onWarning?: (message: string) => void;
}

export interface WorktreeBinding {
  worktree: string;
  branch: string;
  repo: string;
  created: boolean;
  /** The ref the Task branch was cut from (null when an existing branch was reused). */
  base?: string | null;
  /** The resolved base commit (null when an existing branch was reused). */
  baseSha?: string | null;
  /** Non-fatal base-resolution warnings (e.g. behind origin/main). */
  warnings?: string[];
}

function isUnder(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}

/**
 * Make the WORKSPACE-LOCAL `.relay/` directory ignored so the PINNED run brief
 * never shows up as an uncommitted change (a clean `git status` is the cleanup
 * precondition). Uses the checkout's own `.git/info/exclude` — local, never
 * committed, and INSIDE the workspace (ISH-904 never writes `<source>/.git`).
 * Tracked `.gitignore`s that already carry `.relay/` make this a no-op there.
 */
function ensureRelayExcluded(workspace: string): void {
  const dirs = gitDirs(workspace);
  if (!dirs) return;
  const exclude = join(dirs.commonDir, "info", "exclude");
  try {
    mkdirSync(dirname(exclude), { recursive: true });
    let body = "";
    try {
      body = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    } catch {
      body = "";
    }
    if (!/^\s*\.relay\/?\s*$/m.test(body)) {
      writeFileSync(exclude, `${body.replace(/\s*$/, "")}\n.relay/\n`);
    }
  } catch {
    /* best effort: the treed .gitignore still covers the real repo */
  }
}

/**
 * Resolve the base commit IN THE SOURCE repo. `refs/remotes/origin/*` of a clone
 * made from the source's PATH are copies of the source's LOCAL branches, so the
 * clone cannot answer `origin/main` the way the source does (its `origin/main` is
 * the real remote-tracking ref); the source is the only place the requested base
 * means what it meant before ISH-904. Only the IMPLICIT default (`origin/main`,
 * not explicitly requested) may fall back to the source's `HEAD`.
 */
function resolveBaseCommit(repo: string, base: string, explicit: boolean): string {
  const refs = explicit ? [base] : [base, "HEAD"];
  for (const ref of refs) {
    const r = gitRun(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (r.ok && r.out) return r.out;
  }
  throw new Error(
    `${WORKTREE_ERROR}: base ref '${base}'${explicit ? "" : " (nor HEAD)"} resolves to no commit in the source repo (${realpathOf(repo)})`
  );
}

/**
 * ISH-904: refresh the SOURCE repo's `origin/*` refs before cutting a Task
 * branch. Without this the Factory based every lane on whatever `origin/main`
 * happened to be at the last manual fetch — three merges stale in the overnight
 * run. Best-effort: a checkout with no origin/network/credentials still cuts
 * from the local refs it has, and the caller gets a warning instead of a failure.
 */
function fetchOriginForBase(repo: string): { ok: boolean; error: string | null } {
  if (!gitOriginUrl(repo)) return { ok: true, error: null };
  const r = gitRun(repo, ["fetch", "-q", "--no-tags", "origin"], {
    timeoutMs: 20_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return r.ok ? { ok: true, error: null } : { ok: false, error: (r.err || r.out || "git fetch failed").slice(0, 300) };
}

/** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  return gitRun(repo, ["merge-base", "--is-ancestor", ancestor, descendant]).ok;
}

/** The commit a ref resolves to in the SOURCE repo, or null. */
function resolveCommit(repo: string, ref: string): string | null {
  const r = gitRun(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.ok && r.out ? r.out : null;
}

function shortSha(sha: string): string {
  return sha.slice(0, 10);
}

/**
 * ISH-904: choose the ref a NEW Task branch is cut from.
 *
 * `--base` is honoured exactly (an explicit local ref must keep working). A
 * Task's recorded `pr_base` (normally a branch NAME such as `main`) prefers the
 * SOURCE's fresh `origin/<base>` so a stale local `main` can never be the base;
 * it falls back to the named local ref when the remote does not have it. The
 * implicit default is `origin/main`, else `HEAD`.
 */
function resolveTaskBaseRef(repo: string, task: Task, opts: EnsureWorktreeOptions): { ref: string; explicit: boolean } {
  if (opts.base !== undefined) return { ref: opts.base, explicit: true };
  if (task.pr_base) {
    const remote = `origin/${task.pr_base}`;
    return { ref: resolveCommit(repo, `refs/remotes/${remote}`) ? remote : task.pr_base, explicit: true };
  }
  return {
    ref: resolveCommit(repo, "refs/remotes/origin/main") ? "origin/main" : "HEAD",
    explicit: false,
  };
}

/**
 * Fetch one commit object from the source PATH (a local fetch: no network) so the
 * clone's own object store holds it, then verify the clone can read it. Works for
 * a commit reachable from no branch (e.g. a detached source HEAD).
 */
function importSourceCommit(path: string, source: string, sha: string): boolean {
  gitRun(path, ["fetch", "-q", "--no-tags", realpathOf(source), sha]);
  if (gitRun(path, ["cat-file", "-e", `${sha}^{commit}`]).ok) return true;
  // Older git may refuse a bare sha fetch: import every source ref, then retry.
  gitRun(path, ["fetch", "-q", "--no-tags", realpathOf(source), "+refs/*:refs/relay-source/*"]);
  return gitRun(path, ["cat-file", "-e", `${sha}^{commit}`]).ok;
}

/**
 * ISH-904 create path: a SELF-CONTAINED Task workspace = a LOCAL clone of the
 * source repo (`--local --no-checkout`: hardlinked objects, cheap), whose
 * `origin` is re-pointed at the SOURCE repo's `origin` URL so the Run pushes the
 * Task branch to the real remote (never to the local source path). Then the Task
 * branch is checked out from the resolved base commit, or reused from the source.
 *
 * Every ref answer comes from LOCAL state, never from `origin` (`ls-remote`):
 *  - the base is resolved in the SOURCE (`resolveBaseCommit`) and its commit is
 *    fetched from the source path;
 *  - an existing branch is taken from the source's local branch, else from its
 *    `refs/remotes/origin/<branch>` (a branch that only exists on GitHub).
 *
 * `git worktree add` cannot help here: current git has no `--separate-git-dir`
 * for it, and a linked worktree's git dir/common dir always live outside the
 * workspace, which `workspace-write` denies.
 */
function createSelfContainedWorkspace(
  repo: string,
  path: string,
  branch: string,
  branchExists: boolean,
  base: string,
  baseExplicit: boolean,
  taskId: string
): void {
  const source = realpathOf(repo);
  const baseSha = branchExists ? null : resolveBaseCommit(source, base, baseExplicit);
  // Clone onto the PHYSICAL parent path: git records the canonical destination,
  // so the clone's `origin` is the real source path (not a /var symlink alias).
  const cloned = gitRun(realpathOf(dirname(path)), ["clone", "--local", "--no-checkout", source, path]);
  if (!cloned.ok || !existsSync(path)) {
    throw new Error(`${WORKTREE_ERROR}: git clone failed for ${taskId}: ${(cloned.err || cloned.out).slice(0, 300)}`);
  }
  try {
    // A local clone records `objects/info/alternates` back to the source's object
    // dir instead of hardlinking when the source itself has alternates (common: a
    // source checkout that is itself a `--shared` clone of `<main>/.git/objects`).
    // Left in place, every git READ goes outside the workspace, and the deeper
    // chain is not re-resolved from here (a `--shared` source's own commits go
    // unreadable). Break it WITHOUT a transport: hardlink every alternate object
    // (packed + loose) into the workspace's own store, then drop the file.
    const alternates = join(gitCommonDir(path) ?? join(path, ".git"), "objects", "info", "alternates");
    if (existsSync(alternates)) foldAlternatesInto(path, alternates);
    // Only NOW re-point `origin` at the real remote: a Run must push there, and
    // never into the source checkout through the clone's local-path origin. Every
    // object the branch needs was imported from the source path (no network).
    const sourceOrigin = gitOriginUrl(repo);
    if (sourceOrigin) {
      const set = gitRun(path, ["remote", "set-url", "origin", sourceOrigin]);
      if (!set.ok) throw new Error(`remote set-url origin failed: ${(set.err || set.out).slice(0, 200)}`);
    } else {
      // No provider remote to push to: drop it so nothing can push into the
      // source checkout by accident.
      gitRun(path, ["remote", "remove", "origin"]);
    }
    const checkout = branchExists
      ? checkoutExistingBranch(path, source, branch)
      : (() => {
          if (baseSha && !importSourceCommit(path, source, baseSha)) {
            return { ok: false, out: "", err: `base commit ${baseSha} could not be imported from the source` } as GitResult;
          }
          return gitRun(path, ["checkout", "-q", "-b", branch, baseSha ?? "HEAD"]);
        })();
    if (!checkout.ok) throw new Error(`checkout ${branch} from ${base} failed: ${(checkout.err || checkout.out).slice(0, 300)}`);
  } catch (e) {
    // Fail closed: never leave a half-made workspace that a later call would
    // SELECT as if it were live.
    rmSync(path, { recursive: true, force: true });
    throw new Error(`${WORKTREE_ERROR}: ${e instanceof Error ? e.message : String(e)} (task ${taskId})`);
  }
  ensureRelayExcluded(path);
}

/**
 * Check out an EXISTING Task branch in the clone: from the source's local branch
 * if it has one, else from the source's remote-tracking
 * `refs/remotes/origin/<branch>` (a branch pushed to GitHub but not present
 * locally — what a legacy `git worktree add` used to resolve). Imported into the
 * clone at the same name from the source PATH (no network).
 */
function checkoutExistingBranch(path: string, source: string, branch: string): GitResult {
  const local = gitRun(source, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
  const remote = local.ok ? null : gitRun(source, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`]);
  if (!local.ok && !(remote && remote.ok)) {
    return { ok: false, out: "", err: `branch '${branch}' exists neither in the source nor on its origin` };
  }
  const fetched = gitRun(path, [
    "fetch",
    "-q",
    "--no-tags",
    realpathOf(source),
    `+refs/heads/${branch}:refs/heads/${branch}`,
    `+refs/remotes/origin/${branch}:refs/remotes/origin/${branch}`,
  ]);
  if (!fetched.ok && gitRun(path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]).ok === false) {
    // The refspec fails as a whole when ONE side is absent; import the side that exists.
    const side = local.ok ? `+refs/heads/${branch}:refs/heads/${branch}` : `+refs/remotes/origin/${branch}:refs/remotes/origin/${branch}`;
    gitRun(path, ["fetch", "-q", "--no-tags", realpathOf(source), side]);
  }
  if (local.ok) return gitRun(path, ["checkout", "-q", branch]);
  // Remote-only branch: mirror what `git worktree add <path> origin/<branch>` did.
  return gitRun(path, ["checkout", "-q", "-b", branch, "--track", `refs/remotes/origin/${branch}`]);
}

/** Hardlink (or copy across filesystems) every object an `alternates` file names. */
function foldAlternatesInto(path: string, alternates: string): void {
  const common = gitCommonDir(path) ?? join(path, ".git");
  const objects = join(common, "objects");
  const destPack = join(objects, "pack");
  mkdirSync(destPack, { recursive: true });
  mkdirSync(join(objects, "info"), { recursive: true });
  // git resolves a RELATIVE alternate against `objects/` (not the common dir).
  const seen = new Set<string>([realpathOf(objects)]);
  const queue = [alternates];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim().replace(/#.*$/, "").trim();
      if (!line) continue;
      const dir = resolve(objects, line);
      const real = realpathOf(dir);
      if (seen.has(real) || !existsSync(dir)) continue;
      seen.add(real);
      for (const name of readdirSync(dir)) {
        if (name === "info" || name === "pack") continue;
        const dst = join(objects, name);
        mkdirSync(dst, { recursive: true });
        for (const f of readdirSync(join(dir, name))) {
          const to = join(dst, f);
          if (!existsSync(to)) linkOrCopy(join(dir, name, f), to);
        }
      }
      const packDir = join(dir, "pack");
      if (existsSync(packDir)) {
        for (const f of readdirSync(packDir)) {
          if (!/\.(pack|idx)$/.test(f)) continue; // rev/bitmap/mtimes are regenerated
          const to = join(destPack, f);
          if (!existsSync(to)) linkOrCopy(join(packDir, f), to);
        }
      }
      // A nested alternate (the source itself alternates elsewhere) must be folded
      // too: an object this chain points at would otherwise be read outside.
      const nested = join(dir, "info", "alternates");
      if (existsSync(nested)) queue.push(nested);
    }
  }
  rmSync(alternates, { force: true });
}

/** Hardlink `from` to `to`; fall back to a copy when they are on different filesystems. */
function linkOrCopy(from: string, to: string): void {
  try {
    linkSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    copyFileSync(from, to);
  }
}

function recordBinding(
  db: Database,
  task: Task,
  worktree: string,
  branch: string,
  repo: string,
  created: boolean,
  base: string | null = null,
  baseSha: string | null = null,
  warnings: string[] = []
): WorktreeBinding {
  // Own it durably: record the worktree and (if unset) the branch on the Task.
  db.query(`UPDATE tasks SET worktree = ?, branch = COALESCE(branch, ?), updated_at = ? WHERE id = ?`).run(
    worktree,
    branch,
    now(),
    task.id
  );
  logEvent(db, {
    source: "run-lifecycle",
    taskId: task.id,
    type: created ? "worktree.created" : "worktree.selected",
    payload: { worktree, branch, repo, base, baseSha, warnings },
  });
  return { worktree, branch, repo, created, base, baseSha, warnings };
}

/**
 * Create (or SELECT and reuse) the single self-contained workspace + branch a
 * Task owns.
 *
 * Idempotent: an already-recorded, live workspace is reused as-is (this is what
 * makes a FIX the SAME workspace + a NEW Run). Create path (ISH-904): a LOCAL
 * CLONE of `repo` at the Task's path (see `createSelfContainedWorkspace`), on the
 * Task's branch off `base` (or reuse the existing branch). Every git dir it needs
 * is inside the path, so a `workspace-write` Run can commit and push.
 */
export function ensureTaskWorktree(db: Database, taskId: string, opts: EnsureWorktreeOptions = {}): WorktreeBinding {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (task.code_change !== 1) {
    throw new Error(`${WORKTREE_ERROR}: task ${taskId} is not a code-change task; a headless Run implements a code task`);
  }
  const repo = resolve(opts.repo ?? projectRoot());

  // SELECT: the Task already owns a live workspace -> reuse it unchanged.
  if (task.worktree && existsSync(task.worktree) && isSelfContainedWorkspace(task.worktree)) {
    const branch = task.branch ?? gitCurrentBranch(task.worktree) ?? taskBranchName(task);
    ensureRelayExcluded(task.worktree);
    return recordBinding(db, task, resolve(task.worktree), branch, repo, false);
  }

  const wtRoot = taskWorktreesRoot(opts.worktreesRoot);
  mkdirSync(wtRoot, { recursive: true });
  const path = resolve(opts.path ?? join(wtRoot, sanitizeId(task.id)));
  const branch = opts.branch ?? task.branch ?? taskBranchName(task);
  if (existsSync(path) && !isSelfContainedWorkspace(path)) {
    throw new Error(
      `${WORKTREE_ERROR}: ${path} exists and is not a self-contained git clone (a linked \`git worktree add\` checkout keeps its git dir outside the workspace, so a workspace-write Run cannot commit in it)`
    );
  }

  const warnings: string[] = [];
  const willCreate = !existsSync(path);
  // ISH-904: FETCH FIRST. The source's `origin/main` is whatever the last manual
  // fetch made it; an overnight factory cut every lane from that stale commit.
  // Best-effort: an offline/credential-less source still cuts from local refs and
  // gets an explicit warning.
  if (willCreate) {
    const fetched = fetchOriginForBase(repo);
    if (!fetched.ok) {
      warnings.push(
        `could not refresh origin before resolving the Task base: ${fetched.error}; using the source's existing refs`
      );
    }
  }
  // The branch may already exist (a FIX, a re-run, or a pushed relay/<n>): in the
  // source repo, or on the SOURCE repo's remote (so the source's
  // `refs/remotes/origin/<branch>` has it). LOCAL refs only — no `ls-remote`.
  const branchExists =
    gitRun(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok ||
    gitRun(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).ok;
  // Resolved in the SOURCE, where `origin/main` really is the remote-tracking ref
  // (the clone's own `origin/*` would be copies of the source's LOCAL heads).
  const { ref: base, explicit: baseExplicit } = resolveTaskBaseRef(repo, task, opts);
  let baseSha: string | null = null;
  if (willCreate && !branchExists) {
    baseSha = resolveBaseCommit(repo, base, baseExplicit);
    // Never silently cut a lane behind the freshly fetched trunk: warn with both
    // SHAs. (An explicit `--base` that is intentionally older still proceeds —
    // the operator named it — but is never silent.)
    const remoteMain = resolveCommit(repo, "refs/remotes/origin/main");
    if (remoteMain && baseSha !== remoteMain && isAncestor(repo, baseSha, remoteMain)) {
      warnings.push(
        `resolved base ${base}@${shortSha(baseSha)} is behind origin/main@${shortSha(remoteMain)}; ` +
        `the Task workspace may start stale (rebase it, or re-intake with a fresh base)`
      );
    }
  }
  if (willCreate) createSelfContainedWorkspace(repo, path, branch, branchExists, base, baseExplicit, taskId);
  ensureRelayExcluded(path);
  const binding = recordBinding(
    db,
    task,
    path,
    branch,
    repo,
    willCreate,
    branchExists ? null : base,
    baseSha,
    warnings
  );
  for (const w of warnings) {
    logEvent(db, { source: "run-lifecycle", taskId, type: "worktree.base_warning", payload: { warning: w } });
    opts.onWarning?.(w);
  }
  return binding;
}

// ---------------------------------------------------------------------------
// Findings inheritance (FIX = same worktree + previous findings + a new Run)
// ---------------------------------------------------------------------------

/**
 * One non-passing mechanical check, read back from a `VerificationResult`'s
 * existing `payload_json.checks` (never a second evidence store). The output is
 * still the UNBOUNDED stored tail here; `buildRunBrief` is what redacts and
 * bounds it for the pinned brief.
 */
export interface RunCheckFinding {
  name: string;
  required: boolean;
  outcome: string;
  exitCode: number | null;
  /** The declared reproduction command, when the Task still declares this check. */
  command: string | null;
  output: string | null;
  timedOut: boolean;
}

export interface RunFinding {
  attempt: number;
  kind: string; // "ReviewResult" | "VerificationResult"
  reason: string | null;
  evidence: string | null;
  headSha: string | null;
  /** The aggregate VERIFY outcome from the payload (`null` for a manual result). */
  outcome?: string | null;
  /** Non-passing check diagnostics from the VerificationResult payload. */
  checks?: RunCheckFinding[];
  /**
   * True only when the previous result says the CODE is wrong (a real `fail` or
   * a review `fix`). `not_run`/`inconclusive` and a blocked review are missing
   * evidence, not a code defect: they must never become a FIX instruction.
   * Absent on a caller-built legacy finding, which is treated as a real finding.
   */
  defect?: boolean;
}

/** Caps for the inherited diagnostics rendered into a pinned Run brief. */
export const RUN_FINDING_MAX_RESULTS = 6;
export const RUN_FINDING_MAX_CHECKS = 8;
export const RUN_FINDING_OUTPUT_LINES = 12;
export const RUN_FINDING_OUTPUT_CHARS = 1200;
export const RUN_FINDING_REASON_CHARS = 2000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** The stored `payload_json` object, or null when absent/malformed. */
function resultPayload(row: TaskResult): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(row.payload_json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Non-passing checks from a VerificationResult payload, bounded by identity only. */
function verificationChecks(payload: Record<string, unknown> | null, commands: Map<string, string>): RunCheckFinding[] {
  const raw = Array.isArray(payload?.checks) ? payload.checks : [];
  const out: RunCheckFinding[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const outcome = typeof item.outcome === "string" ? item.outcome : "";
    if (!name || !outcome || outcome === "pass") continue;
    // The host runner stores a combined `output`; the sandbox runner also keeps
    // separate stdout/stderr. Prefer the combined tail, then stderr, then stdout.
    const output =
      (typeof item.output === "string" && item.output) ||
      (typeof item.stderr === "string" && item.stderr) ||
      (typeof item.stdout === "string" && item.stdout) ||
      null;
    out.push({
      name,
      required: item.required !== false,
      outcome,
      exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
      command:
        commands.get(name) ??
        (typeof item.command === "string" && item.command.trim() ? item.command.trim() : null),
      output: output || null,
      timedOut: item.timedOut === true,
    });
  }
  return out;
}

function verificationDefect(outcome: string | null): boolean {
  // A manual verification row has no payload outcome; `passed = 0` is then the
  // explicit failure signal. A recorded `pass`/`not_run`/`inconclusive`/unknown
  // outcome is never converted into a code-fix instruction.
  return outcome === null ? true : outcome === "fail";
}

/**
 * The structured FIX signals for the attempt immediately BEFORE the Task's
 * current one (a review `fix`/`fail` reason or a failed mechanical verify). This
 * is what a new Run must fix; it is pinned into the brief, never carried by a
 * session continuation.
 *
 * The query is scoped to THIS Task AND exactly `attempt - 1`, so a finding from
 * another Task, another attempt, or a superseded/older HEAD can never leak in. A
 * `passed = 0` row is included for context but its `defect` flag decides whether
 * the brief may instruct a code change (NOT_RUN/INCONCLUSIVE/blocked do not).
 */
export function inheritFindings(
  db: Database,
  task: Pick<Task, "id" | "attempt"> & { checks_json?: string | null }
): RunFinding[] {
  if (task.attempt <= 0) return [];
  const rows = db
    .query(
      `SELECT * FROM task_results
        WHERE task_id = ? AND attempt = ? AND kind IN ('ReviewResult','VerificationResult') AND passed = 0
        ORDER BY id DESC`
    )
    .all(task.id, task.attempt - 1) as TaskResult[];
  if (rows.length === 0) return [];
  const commands = new Map(
    taskChecks({ checks_json: task.checks_json ?? null }).map((c) => [c.name, c.command] as const)
  );
  return rows.slice(0, RUN_FINDING_MAX_RESULTS).map((r) => {
    const payload = resultPayload(r);
    const isVerify = r.kind === "VerificationResult";
    const outcome = isVerify && typeof payload?.outcome === "string" ? payload.outcome : null;
    const blockedReview = !isVerify && payload?.blocked === true;
    return {
      attempt: r.attempt,
      kind: r.kind,
      reason: r.reason,
      evidence: r.evidence_ref,
      headSha: r.head_sha,
      outcome,
      checks: isVerify ? verificationChecks(payload, commands) : [],
      defect: isVerify ? verificationDefect(outcome) : !blockedReview,
    };
  });
}

/** Redact and bound a stored output tail for the pinned brief (never raw/full). */
function boundedFindingOutput(text: string | null): string | null {
  if (!text) return null;
  const clean = redactSecrets(text.replace(/\r/g, "")).trim();
  if (!clean) return null;
  const lines = clean.split("\n");
  const tail = lines.slice(Math.max(0, lines.length - RUN_FINDING_OUTPUT_LINES)).join("\n");
  if (tail.length <= RUN_FINDING_OUTPUT_CHARS) return tail;
  return `[… truncated …]\n${tail.slice(-RUN_FINDING_OUTPUT_CHARS)}`;
}

/** Redact and bound a stored finding reason for the pinned brief. */
function boundedFindingReason(text: string | null): string | null {
  if (!text) return null;
  const clean = redactSecrets(text.replace(/\r/g, "")).trim();
  if (!clean) return null;
  return clean.length <= RUN_FINDING_REASON_CHARS
    ? clean
    : `${clean.slice(0, RUN_FINDING_REASON_CHARS)}\n[… truncated …]`;
}

/** Render one inherited finding's concrete diagnostics (already bounded). */
function renderRunFinding(f: RunFinding): string[] {
  const out: string[] = [];
  const checks = f.checks ?? [];
  const defect = f.defect !== false;
  const label = defect ? (f.kind === "ReviewResult" ? "FIX" : "FAIL") : "BLOCKED";
  out.push("", `### ${f.kind} — ${label} (attempt ${f.attempt})`);
  if (f.headSha) {
    const what = f.kind === "ReviewResult" ? "Reviewed HEAD" : "Verified HEAD";
    out.push(`- ${what}: \`${f.headSha}\``);
  }
  if (f.evidence) out.push(`- Evidence: ${f.evidence}`);
  if (f.kind === "VerificationResult") {
    out.push(`- Check outcome: ${f.outcome ?? "fail (manual verification)"}`);
    if (checks.length > 0) {
      out.push("- Failed checks:");
      for (const c of checks.slice(0, RUN_FINDING_MAX_CHECKS)) {
        const optional = c.required ? "" : " (optional)";
        const exit = c.exitCode === null ? "" : `, exit ${c.exitCode}`;
        const timed = c.timedOut ? ", timed out" : "";
        const repro = c.command ? ` — reproduce: \`${c.command}\`` : "";
        out.push(`  - \`${c.name}\`${optional}: ${c.outcome}${exit}${timed}${repro}`);
        const tail = boundedFindingOutput(c.output);
        if (tail) out.push("    ```", ...tail.split("\n").map((l) => `    ${l}`), "    ```");
        else out.push("    (no output captured)");
      }
      if (checks.length > RUN_FINDING_MAX_CHECKS) {
        out.push(`  - … ${checks.length - RUN_FINDING_MAX_CHECKS} more failed check(s) omitted`);
      }
    }
  }
  const reason = boundedFindingReason(f.reason);
  if (reason) {
    out.push("- Findings:");
    out.push(...reason.split("\n").map((l) => `  ${l}`));
  } else if (checks.length === 0) {
    out.push("- (no captured output or findings; do not assume this check passed)");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run brief: pinned into the worktree BEFORE launch
// ---------------------------------------------------------------------------

export interface RunBrief {
  text: string;
  findings: RunFinding[];
  checks: CheckSpec[];
}

export interface BuildBriefOptions {
  worktree: string;
  branch: string;
  findings?: RunFinding[];
  /**
   * The exact base HEAD this Run starts from. Defaults to probing `worktree`
   * (the host path); a Sandbox caller passes the in-VM HEAD because the path is
   * not a host checkout. `null` means unknown (skip HEAD filtering).
   */
  baseHead?: string | null;
}

/** Compose the Run brief: ISH-803's task prompt + worktree + checks + findings. */
export function buildRunBrief(db: Database, task: Task, opts: BuildBriefOptions): RunBrief {
  const checks = taskChecks(task);
  const findings = opts.findings ?? inheritFindings(db, task);
  const lines = [buildTaskPrompt(task)];
  lines.push("", "## Worktree", `- branch: ${opts.branch}`, `- path: ${opts.worktree}`);
  if (checks.length > 0) {
    lines.push("", "## Verification steps (Relay runs these mechanically after you submit)");
    for (const c of checks) lines.push(`- ${c.name}: \`${c.command}\`${c.required === false ? " (optional)" : ""}`);
  }
  // The worktree HEAD is the exact base `startDshRun` will record. A finding
  // recorded at a DIFFERENT head is from an older revision and must never be
  // presented as this FIX's instruction (an unreadable/null head is admissible:
  // there is nothing to disprove it).
  const checkoutHead = opts.baseHead === undefined ? gitHeadOf(opts.worktree) : opts.baseHead;
  const applicable = findings.filter((f) => !checkoutHead || !f.headSha || f.headSha === checkoutHead);
  const defects = applicable.filter((f) => f.defect !== false);
  const blocked = applicable.filter((f) => f.defect === false);
  if (applicable.length > 0) {
    const attempt = applicable[0].attempt;
    if (defects.length > 0) {
      // Fall back to the head the failed result actually judged when the
      // checkout is unreadable (or the caller passed a synthetic path).
      const baseHead = checkoutHead ?? defects.find((f) => f.headSha)?.headSha ?? null;
      lines.push("", `## Prior findings @ attempt ${attempt} — FIX these (same worktree, new Run)`);
      lines.push(
        `- Base HEAD (this FIX Run starts here): ${baseHead ? `\`${baseHead}\`` : "(unreadable checkout HEAD)"}`
      );
      lines.push(
        "- The Task acceptance above is unchanged and is the completion bar; this is a NEW Run, not a session replay."
      );
      for (const f of defects) lines.push(...renderRunFinding(f));
    }
    if (blocked.length > 0) {
      lines.push("", `## Previous evidence BLOCKED @ attempt ${attempt} — not a code defect`);
      lines.push("- The previous CHECK/REVIEW could not produce a trustworthy decision; a PASS was NOT fabricated.");
      lines.push("- Do NOT change code merely to satisfy this section: the required evidence is missing.");
      for (const f of blocked) lines.push(...renderRunFinding(f));
    }
  }
  // ISH-885: a PR-bound Task's GitHub write is the Coding Agent's job — Relay is
  // read-only and only OBSERVES the PR afterwards. Without this instruction the
  // Factory's read-only Task↔PR gate would block every real Run (NO_PR_IDENTITY
  // on the first attempt, HEAD_MOVED on a FIX).
  if (task.pr_repo || task.pr_url) {
    const repo = task.pr_repo ?? "(the PR's repository)";
    const base = task.pr_base ?? "<the PR's base branch>";
    lines.push(
      "",
      "## Publish the Task branch as a GitHub PR (this is YOUR GitHub write)",
      "Relay is read-only: it never pushes, creates/updates a PR, or posts a review. You own the push and the PR.",
      `- push your commit to the Task branch — NEVER the default branch: \`git push origin HEAD:refs/heads/${opts.branch}\`` +
        " (`origin` is the source repo's origin URL; the workspace is a self-contained clone, so the whole push is writable under `workspace-write`)",
      `- if the branch has NO PR yet, create one: \`gh pr create --repo ${repo} --head ${opts.branch} --base ${base} --title <title> --body <body>\``,
      "- if a PR already exists for this branch (e.g. a FIX), just push the new commit to the SAME PR — do NOT open a duplicate",
      "- NEVER merge, and NEVER post a review (the independent reviewer posts reviews; Relay only reads them back)"
    );
  }
  lines.push(
    "",
    "## Do NOT run `relay` mutations",
    "Do not invoke `relay claim`/`relay submit`/`relay approve`/`relay note` (or any `relay` task/run mutation) for this",
    "task. Relay ALONE submits the result of this Run AFTER the process exits; a worker claim/submit during the Run is",
    "refused (RUN_OWNED) and can never advance the Task. Just make the change, run the checks, and commit."
  );
  lines.push("", "_Pinned by Relay (ISH-760) before launch: the Task/Worktree persists; this Run is disposable._");
  return { text: lines.join("\n"), findings: applicable, checks };
}

/** The deterministic in-worktree path the brief is pinned to (gitignored). */
export function runBriefPath(worktree: string): string {
  return join(worktree, ".relay", "run-brief.md");
}

/** Write the pinned brief into the worktree BEFORE the dsh process starts. */
export function pinRunBrief(worktree: string, text: string): string {
  const p = runBriefPath(worktree);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${text}\n`);
  return p;
}

// ---------------------------------------------------------------------------
// Launch (reuses ISH-803; one Run per phase/attempt)
// ---------------------------------------------------------------------------

export interface LaunchRunOptions extends EnsureWorktreeOptions {
  /** Root for `<root>/<run-id>/`; default `<control-plane>/runs`. */
  outputRoot?: string;
  dshBin?: string;
  permissionMode?: string;
  timeoutMs?: number;
  fastExitMs?: number;
  env?: Record<string, string>;
  /** Test seam. */
  spawner?: DshSpawner;
}

export interface LaunchedRun {
  handle: DshRunHandle;
  /** The Run row as it was at launch (state `running`). */
  run: Run;
  worktree: string;
  branch: string;
  briefPath: string;
  findings: RunFinding[];
  /** ISH-904: non-fatal base warnings (e.g. base behind origin/main). */
  warnings: string[];
}

/**
 * Ensure the Task's worktree, PIN the brief (task + checks + prior findings),
 * then launch ONE disposable headless dsh Run. Throws `DUPLICATE_WRITER` (from
 * ISH-803's guard) if another Run still holds this worktree/branch.
 *
 * `relay run start` remains the raw ISH-803 entrypoint; this is the Task
 * lifecycle entrypoint the Gateway/daemon uses.
 */
export async function launchTaskRun(db: Database, taskId: string, opts: LaunchRunOptions = {}): Promise<LaunchedRun> {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (task.code_change !== 1) {
    throw new Error(`${WORKTREE_ERROR}: task ${taskId} is not a code-change task`);
  }
  const binding = ensureTaskWorktree(db, taskId, opts);

  // ISH-760 (review round 1, finding 2): refuse a duplicate writer BEFORE
  // pinning the brief, so a REFUSED launch never writes into the worktree a live
  // Run owns (the brief must keep matching the Run that holds the worktree). The
  // race-free BEGIN IMMEDIATE guard inside `startDshRun` stays authoritative.
  assertNoActiveWriter(db, { cwd: binding.worktree, branch: binding.branch });

  const fresh = getTask(db, taskId)!;
  const findings = inheritFindings(db, fresh);
  const brief = buildRunBrief(db, fresh, { worktree: binding.worktree, branch: binding.branch, findings });
  const briefPath = pinRunBrief(binding.worktree, brief.text);

  const handle = await startDshRun(db, {
    taskId,
    cwd: binding.worktree,
    prompt: brief.text,
    outputRoot: opts.outputRoot,
    dshBin: opts.dshBin,
    permissionMode: opts.permissionMode,
    timeoutMs: opts.timeoutMs,
    fastExitMs: opts.fastExitMs,
    env: opts.env,
    spawner: opts.spawner,
  });
  const run = getRun(db, handle.id)!;
  logEvent(db, {
    source: "run-lifecycle",
    taskId,
    type: "run.launched",
    payload: {
      runId: handle.id,
      worktree: binding.worktree,
      branch: binding.branch,
      phase: run.phase,
      attempt: run.attempt,
      generation: run.generation,
      brief: briefPath,
      findings: brief.findings.length,
    },
  });
  return {
    handle,
    run,
    worktree: binding.worktree,
    branch: binding.branch,
    briefPath,
    findings: brief.findings,
    warnings: binding.warnings ?? [],
  };
}

// ---------------------------------------------------------------------------
// Submitter binding (a stale/late Run never advances the Task)
// ---------------------------------------------------------------------------

/**
 * Why this Run may NOT be the submitter of the live Task's current
 * phase/attempt/generation, or null when it is correctly bound. This mirrors (and
 * makes explicit) the fences `acceptRunSubmission` already applies; callers use
 * it to report before attempting the submission.
 */
export function runSubmitterError(run: Run, task: Task): string | null {
  if (run.task_id !== task.id) return `run ${run.id} belongs to task ${run.task_id}, not ${task.id}`;
  if (run.phase !== task.phase) return `run ${run.id} started in phase '${run.phase}', task is '${task.phase ?? "none"}'`;
  if (run.attempt !== task.attempt) return `run ${run.id} started at attempt ${run.attempt}, task is attempt ${task.attempt}`;
  if (run.generation !== run.attempt) return `run ${run.id} generation ${run.generation} != attempt ${run.attempt}`;
  if (task.branch !== null && run.branch !== task.branch) {
    return `run ${run.id} produced branch ${run.branch ?? "none"}, task is ${task.branch}`;
  }
  if (task.head_sha !== null && (run.base_head_sha ?? null) !== task.head_sha) {
    return `run ${run.id} started at head ${run.base_head_sha ?? "none"}, task is bound to ${task.head_sha}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Safe workspace cleanup (evidence-retaining)
// ---------------------------------------------------------------------------

export interface CleanupOptions {
  /** Actually remove (default: dry-run plan only). */
  apply?: boolean;
  /** Override the uncommitted-changes / ownership guards (still refuses a writer). */
  force?: boolean;
  /** Explicit abort reason: cleanup without a real merge. */
  abort?: string;
  /** Root for Relay-created worktrees (default `taskWorktreesRoot()`). */
  worktreesRoot?: string;
  /** The MAIN checkout the worktree belongs to (default: the project root). */
  repo?: string;
}

export interface CleanupPlan {
  taskId: string;
  worktree: string | null;
  branch: string | null;
  /** True when every safety guard passed (removal is allowed). */
  remove: boolean;
  apply: boolean;
  /** Why removal is refused (empty when `remove`). */
  reasons: string[];
  removed: boolean;
  /** Run output dirs are NEVER touched (evidence retention). */
  retainedRuns: number;
}

/**
 * Plan (and, with `apply`, perform) a SAFE workspace cleanup. Removal is allowed
 * only when: the Task is really merged OR explicitly aborted; there is no open
 * PR; no Run still holds the worktree/branch; the worktree is relay-owned (under
 * the Relay worktrees root); it has no uncommitted changes; and every commit on
 * it is on a remote (or has been copied back into the source repo). The `runs`
 * rows
 * and their output dirs are RETAINED as evidence.
 */
export function planWorkspaceCleanup(db: Database, taskId: string, opts: CleanupOptions = {}): CleanupPlan {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  const reasons: string[] = [];
  const worktree = task.worktree;
  const branch = task.branch;
  const retainedRuns = (db.query(`SELECT COUNT(*) AS n FROM runs WHERE task_id = ?`).get(taskId) as { n: number }).n;
  const plan: CleanupPlan = {
    taskId,
    worktree,
    branch,
    remove: false,
    apply: opts.apply === true,
    reasons,
    removed: false,
    retainedRuns,
  };

  if (!worktree) {
    reasons.push("no recorded worktree");
    return plan;
  }

  const merged = task.merged_at !== null;
  const aborted = !!opts.abort;
  if (!merged && !aborted) {
    if (!isTerminalTaskState(task.state)) {
      reasons.push(`task is not terminal (state=${task.state})`);
    } else {
      reasons.push("task is terminal but not merged; pass --abort <reason> to reclaim it");
    }
  }
  if (task.pr_url && !merged && !aborted) reasons.push(`open PR ${task.pr_url}`);

  const active = findActiveWriter(db, { cwd: worktree, branch });
  if (active) reasons.push(`active run ${active.id} (${active.state}) still holds this worktree`);

  if (!existsSync(worktree)) {
    // Already gone: nothing to remove, but still clear the ledger binding.
    plan.remove = reasons.length === 0;
    if (!plan.remove) reasons.push("worktree path is missing but another guard failed");
    return plan;
  }

  const wtRoot = taskWorktreesRoot(opts.worktreesRoot);
  const owned = isUnder(worktree, wtRoot) && resolve(worktree) !== resolve(projectRoot());
  if (!owned && !opts.force) reasons.push(`worktree is not relay-owned (not under ${wtRoot})`);

  const dirty = gitRun(worktree, ["status", "--porcelain"]);
  if (dirty.ok && dirty.out && !opts.force) reasons.push("worktree has uncommitted changes");
  if (!dirty.ok) reasons.push("worktree is not a readable git checkout");
  if (dirty.ok) {
    // ISH-904: reclaiming a self-contained clone DELETES the branch and every
    // commit on it, so a commit that no remote has would be LOST (with a legacy
    // linked worktree it used to survive in the source repo). Copy those commits
    // back into the source repo first (a local path fetch, no network) — the same
    // custody the linked worktree had. `--force` skips this and really discards.
    if (!opts.force) {
      const lost = unprotectedCommits(worktree, opts.repo);
      if (lost.length > 0) {
        const kept = preserveCommitsInSource(db, taskId, opts.repo, worktree, branch);
        if (!kept.ok) reasons.push(`workspace has ${lost.length} commit(s) not on any remote and they could not be kept: ${kept.error}`);
      }
    }
  }

  plan.remove = reasons.length === 0;
  return plan;
}

/**
 * Commits reachable from the workspace HEAD (or its Task branch) that NO remote
 * has: `git rev-list <ref> --not --remotes`. A clone's only remote is `origin`,
 * so this is exactly the set that dies with the directory.
 */
export function unprotectedCommits(worktree: string, repo?: string): string[] {
  // Refresh the remote-tracking refs so a commit that WAS pushed is not mistaken
  // for a lost one. A remote that cannot be reached (offline) just keeps the last
  // known tracking state: cleanup never needs the network to be conservative.
  const remotes = gitRun(worktree, ["remote"]);
  if (remotes.ok) {
    for (const r of remotes.out.split("\n").map((s) => s.trim()).filter(Boolean)) {
      gitRun(worktree, ["fetch", "-q", "--no-tags", r]);
    }
  }
  const out: string[] = [];
  const refs = ["HEAD", gitCurrentBranch(worktree) ? `refs/heads/${gitCurrentBranch(worktree)}` : null];
  for (const ref of refs) {
    if (!ref) continue;
    const r = gitRun(worktree, ["rev-list", ref, "--not", "--remotes"]);
    if (r.ok) out.push(...r.out.split("\n").filter(Boolean));
  }
  return [...new Set(out)];
}

/**
 * Copy the workspace's Task branch into the SOURCE repo (`refs/relay-kept/<branch>`)
 * so its commits outlive the workspace. Local path fetch only.
 */
function preserveCommitsInSource(
  db: Database,
  taskId: string,
  repo: string | undefined,
  worktree: string,
  branch: string | null
): { ok: boolean; error: string } {
  const source = resolve(repo ?? projectRoot());
  const name = sanitizeId(branch ?? "HEAD");
  const r = gitRun(source, [
    "fetch",
    "-q",
    "--no-tags",
    realpathOf(worktree),
    `+refs/heads/*:refs/relay-kept/${name}/*`,
    "+HEAD:refs/relay-kept/HEAD",
  ]);
  if (!r.ok) return { ok: false, error: (r.err || r.out).slice(0, 200) || "git fetch from the workspace failed" };
  logEvent(db, {
    source: "run-lifecycle",
    taskId,
    type: "worktree.commits_kept",
    payload: { worktree, branch, source, namespace: "refs/relay-kept/" },
  });
  return { ok: true, error: "" };
}

function isEmptyDir(path: string): boolean {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

/**
 * ISH-904: remove a Task workspace from disk. A self-contained clone is just a
 * directory (`rm -rf`), so the SOURCE repo's `.git` is never touched (a linked
 * `git worktree remove` would have mutated it). A legacy linked worktree from
 * before ISH-904 is still reclaimed through `git worktree remove` in its source.
 * Idempotent: an already-absent path is success.
 */
function reclaimWorkspace(path: string, force: boolean): { ok: boolean; error: string } {
  if (!existsSync(path)) return { ok: true, error: "" };
  if (isSelfContainedWorkspace(path)) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return existsSync(path) ? { ok: false, error: `${path} still exists after removal` } : { ok: true, error: "" };
  }
  // A readable git checkout whose git dir lives elsewhere: a legacy linked
  // worktree. Reclaim it via its OWN source repo so that repo's ledger is pruned.
  if (isGitWorktree(path)) {
    const dirs = gitDirs(path);
    const source = dirs ? dirname(dirs.commonDir) : null;
    if (source) {
      const r = gitRun(source, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
      if (r.ok) gitRun(source, ["worktree", "prune"]);
      if (r.ok || !existsSync(path)) return { ok: true, error: "" };
      return { ok: false, error: `git worktree remove failed: ${(r.err || r.out).slice(0, 200)}` };
    }
  }
  // Not a readable checkout (e.g. its `.git` was deleted, or it is a half-made
  // clone). The ownership guard already held; a NON-empty directory that is not
  // a checkout is not provably safe to delete without `--force`.
  if (!force && !isEmptyDir(path)) return { ok: false, error: `${path} is not a readable git checkout` };
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return existsSync(path) ? { ok: false, error: `${path} still exists after removal` } : { ok: true, error: "" };
}

export function applyWorkspaceCleanup(db: Database, taskId: string, opts: CleanupOptions = {}): CleanupPlan {
  const plan = planWorkspaceCleanup(db, taskId, opts);
  if (!plan.apply || !plan.worktree) return plan;
  if (!plan.remove) {
    logEvent(db, {
      source: "run-lifecycle",
      taskId,
      type: "worktree.cleanup_skipped",
      payload: { worktree: plan.worktree, branch: plan.branch, reasons: plan.reasons },
    });
    return plan;
  }
  if (existsSync(plan.worktree)) {
    const r = reclaimWorkspace(plan.worktree, opts.force === true);
    if (!r.ok) {
      plan.reasons.push(`workspace removal failed: ${r.error.slice(0, 200)}`);
      plan.remove = false;
      return plan;
    }
  }
  db.query(`UPDATE tasks SET worktree = NULL, updated_at = ? WHERE id = ?`).run(now(), taskId);
  plan.removed = true;
  logEvent(db, {
    source: "run-lifecycle",
    taskId,
    type: "worktree.cleaned",
    payload: {
      worktree: plan.worktree,
      branch: plan.branch,
      abort: opts.abort ?? null,
      merged: getTask(db, taskId)?.merged_at !== null,
      retainedRuns: plan.retainedRuns,
    },
  });
  return plan;
}
