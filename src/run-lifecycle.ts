import type { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
export function gitRun(cwd: string, args: string[]): GitResult {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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
}

export interface WorktreeBinding {
  worktree: string;
  branch: string;
  repo: string;
  created: boolean;
}

function isUnder(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}

/**
 * Make the repo-local `.relay/` directory ignored so the PINNED run brief never
 * shows up as an uncommitted change (a clean `git status` is the cleanup
 * precondition). Uses `.git/info/exclude`, which is local and never committed —
 * the tracked `.gitignore` already carries `.relay/` in this repo, so this is a
 * no-op there and only helps a foreign fixture repo.
 */
function ensureRelayExcluded(repo: string): void {
  const common = gitRun(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok || !common.out) return;
  const exclude = join(common.out, "info", "exclude");
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

function recordBinding(
  db: Database,
  task: Task,
  worktree: string,
  branch: string,
  repo: string,
  created: boolean
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
    payload: { worktree, branch, repo },
  });
  return { worktree, branch, repo, created };
}

/**
 * Create (or SELECT and reuse) the single worktree + branch a Task owns.
 *
 * Idempotent: an already-recorded, live worktree is reused as-is (this is what
 * makes a FIX the SAME worktree + a NEW Run). Create path: `git worktree add`
 * from `repo` on the Task's branch, off `base` (or reuse the existing branch).
 */
export function ensureTaskWorktree(db: Database, taskId: string, opts: EnsureWorktreeOptions = {}): WorktreeBinding {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (task.code_change !== 1) {
    throw new Error(`${WORKTREE_ERROR}: task ${taskId} is not a code-change task; a headless Run implements a code task`);
  }
  const repo = resolve(opts.repo ?? projectRoot());

  // SELECT: the Task already owns a live worktree -> reuse it unchanged.
  if (task.worktree && existsSync(task.worktree) && isGitWorktree(task.worktree)) {
    const branch = task.branch ?? gitCurrentBranch(task.worktree) ?? taskBranchName(task);
    ensureRelayExcluded(repo);
    return recordBinding(db, task, resolve(task.worktree), branch, repo, false);
  }

  const wtRoot = taskWorktreesRoot(opts.worktreesRoot);
  mkdirSync(wtRoot, { recursive: true });
  const path = resolve(opts.path ?? join(wtRoot, sanitizeId(task.id)));
  const branch = opts.branch ?? task.branch ?? taskBranchName(task);
  if (existsSync(path) && !isGitWorktree(path)) {
    throw new Error(`${WORKTREE_ERROR}: ${path} exists and is not a git worktree`);
  }

  const branchExists = gitRun(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
  const base =
    opts.base ??
    task.pr_base ??
    (gitRun(repo, ["rev-parse", "--verify", "--quiet", "origin/main"]).ok ? "origin/main" : "HEAD");
  const args = branchExists
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "-b", branch, path, base];
  const added = gitRun(repo, args);
  if (!added.ok) {
    throw new Error(`${WORKTREE_ERROR}: git worktree add failed for ${task.id}: ${(added.err || added.out).slice(0, 300)}`);
  }
  ensureRelayExcluded(repo);
  return recordBinding(db, task, path, branch, repo, true);
}

// ---------------------------------------------------------------------------
// Findings inheritance (FIX = same worktree + previous findings + a new Run)
// ---------------------------------------------------------------------------

export interface RunFinding {
  attempt: number;
  kind: string; // "ReviewResult" | "VerificationResult"
  reason: string | null;
  evidence: string | null;
  headSha: string | null;
}

/**
 * The structured FIX signals for the attempt immediately BEFORE the Task's
 * current one (a review `fix`/`fail` reason or a failed mechanical verify). This
 * is what a new Run must fix; it is pinned into the brief, never carried by a
 * session continuation.
 */
export function inheritFindings(db: Database, task: Pick<Task, "id" | "attempt">): RunFinding[] {
  if (task.attempt <= 0) return [];
  const rows = db
    .query(
      `SELECT * FROM task_results
        WHERE task_id = ? AND attempt < ? AND kind IN ('ReviewResult','VerificationResult') AND passed = 0
        ORDER BY attempt DESC, id DESC`
    )
    .all(task.id, task.attempt) as TaskResult[];
  if (rows.length === 0) return [];
  const prior = Math.max(...rows.map((r) => r.attempt));
  return rows
    .filter((r) => r.attempt === prior)
    .map((r) => ({
      attempt: r.attempt,
      kind: r.kind,
      reason: r.reason,
      evidence: r.evidence_ref,
      headSha: r.head_sha,
    }));
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
  if (findings.length > 0) {
    const attempt = findings[0].attempt;
    lines.push("", `## Prior findings @ attempt ${attempt} — FIX these (same worktree, new Run)`);
    for (const f of findings) {
      const ev = f.evidence ? ` — ${f.evidence}` : "";
      lines.push(`- [${f.kind}] ${f.reason ?? "(no reason recorded)"}${ev}`);
    }
  }
  lines.push("", "_Pinned by Relay (ISH-760) before launch: the Task/Worktree persists; this Run is disposable._");
  return { text: lines.join("\n"), findings, checks };
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
      findings: findings.length,
    },
  });
  return { handle, run, worktree: binding.worktree, branch: binding.branch, briefPath, findings };
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
 * the Relay worktrees root); and it has no uncommitted changes. The `runs` rows
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

  plan.remove = reasons.length === 0;
  return plan;
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
    const repo = opts.repo ?? projectRoot();
    const r = gitRun(repo, ["worktree", "remove", ...(opts.force ? ["--force"] : []), plan.worktree]);
    if (!r.ok) {
      plan.reasons.push(`git worktree remove failed: ${(r.err || r.out).slice(0, 200)}`);
      plan.remove = false;
      return plan;
    }
    gitRun(repo, ["worktree", "prune"]);
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
