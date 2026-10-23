import type { Database } from "bun:sqlite";
import { now } from "./db";
import { logEvent } from "./events";
import { isSha } from "./run-owner";
import type { Run } from "./schema";

/**
 * ISH-1128: the provider poll's durable observation of a Run's OWN pushed heads.
 *
 * The submit-time HEAD fence (see `taskHeadOvertakenByOtherWriter` in
 * `run-owner.ts`) accepts an own head that is on the base→produced lineage. A
 * worker is allowed to AMEND/REBASE the commit it already pushed and
 * force-push the new head, and the superseded commit is then NOT an ancestor of
 * the produced head — but the poll may already have bound it onto the Task. The
 * missing fact is "was this head ever the Run's own?"; this module records it
 * while the Run is LIVE, from the Run's own worktree (current HEAD or its HEAD
 * reflog), so the fence can still tell it apart from a foreign writer's head.
 *
 * Kept separate from `run-owner.ts` so that module stays free of DB/event
 * imports for its claim/wake callers.
 */

const HEAD_PROBE_TIMEOUT_MS = 5000;
/** How many recent HEAD reflog entries prove a Run's own amended-away head. */
const HEAD_REFLOG_LIMIT = 512;
/**
 * Slack before the Run's start time for a reflog entry. `started_at` is in
 * milliseconds and git records whole seconds, so a commit at the very start of
 * the Run can render a second "before" it.
 */
const REFLOG_START_SLACK_MS = 5000;

/** The commit `ref` (default HEAD) resolves to in `repo`, or null. */
function gitCommitAt(repo: string, ref = "HEAD"): string | null {
  if (!repo) return null;
  try {
    const p = Bun.spawnSync(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: HEAD_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (p.exitCode !== 0) return null;
    const sha = p.stdout.toString().trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Recent commits the worktree's HEAD pointed at, with the reflog entry time
 * (unix seconds). `--date=unix` makes `%gD` render `HEAD@{<unix>}`, so the
 * entry time is available without parsing the human date format.
 */
function headReflogEntries(repo: string): { sha: string; at: number }[] {
  if (!repo) return [];
  try {
    const p = Bun.spawnSync(
      [
        "git",
        "-C",
        repo,
        "reflog",
        "show",
        "--date=unix",
        "--format=%H %gD",
        "-n",
        String(HEAD_REFLOG_LIMIT),
        "HEAD",
      ],
      { stdout: "pipe", stderr: "pipe", timeout: HEAD_PROBE_TIMEOUT_MS, killSignal: "SIGKILL" }
    );
    if (p.exitCode !== 0) return [];
    const out: { sha: string; at: number }[] = [];
    for (const line of p.stdout.toString().split("\n")) {
      const [sha, selector] = line.trim().split(/\s+/, 2);
      if (!isSha(sha)) continue;
      const at = /@\{(\d+)\}/.exec(selector ?? "")?.[1];
      if (at === undefined) continue;
      out.push({ sha, at: Number(at) });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * ISH-1128: did THIS Run's worktree provably hold `headSha` since the Run
 * started?
 *
 * The current HEAD covers the ordinary "pushed, then the poll ran" window, and
 * the HEAD reflog covers the amend/force-push case where the worker already
 * moved the worktree on before the poll observed the earlier push. Only reflog
 * entries written during THIS Run count: the worktree is reused across FIX
 * attempts, so an older attempt's head must not be misread as this Run's own. A
 * commit a different writer pushed is neither checked out here nor in this
 * clone's reflog, so it can never be attributed to the Run.
 */
function runWorktreeHeldHead(run: Pick<Run, "cwd" | "started_at">, headSha: string): boolean {
  if (gitCommitAt(run.cwd) === headSha) return true;
  const sinceMs = run.started_at - REFLOG_START_SLACK_MS;
  return headReflogEntries(run.cwd).some((e) => e.sha === headSha && e.at * 1000 >= sinceMs);
}

/**
 * ISH-1128: record a PR head the read-only provider poll is binding onto the
 * Task, IF it is demonstrably one of this Task's LIVE Run's own pushes.
 *
 * Attribution is deliberately narrow: the PR must be on the SAME branch the
 * Run was launched on, the head must not be the Run's pre-run base, and the
 * Run's own worktree must provably have held the commit (current HEAD or its
 * HEAD reflog). The row is idempotent per (run, head) and survives the Run
 * ending, so the submit fence can still accept it after an amend/force-push
 * replaced the head. Returns the Run ids that own the observation.
 */
export function recordRunOwnPolledHead(
  db: Database,
  taskId: string,
  headSha: string | null,
  branch: string | null
): string[] {
  if (!headSha || !isSha(headSha) || !branch) return [];
  const live = db
    .query(
      `SELECT * FROM runs
        WHERE task_id = ? AND state IN ('starting', 'running')
        ORDER BY created_at DESC, rowid DESC`
    )
    .all(taskId) as Run[];
  const owners: string[] = [];
  for (const run of live) {
    // Same branch only: a head pushed on another branch is never this Run's.
    if (!run.branch || run.branch !== branch) continue;
    // The pre-run base is the fence, not an own push.
    if (run.base_head_sha !== null && run.base_head_sha === headSha) continue;
    if (!runWorktreeHeldHead(run, headSha)) continue;
    const inserted = db
      .query(
        `INSERT OR IGNORE INTO run_observed_heads (run_id, task_id, branch, head_sha, observed_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(run.id, taskId, branch, headSha, now());
    if (inserted.changes > 0) {
      logEvent(db, {
        source: "providers",
        taskId,
        type: "run.head_observed",
        payload: { runId: run.id, branch, headSha, reason: "own-worktree" },
      });
    }
    owners.push(run.id);
  }
  return owners;
}

/** The own-pushed heads the provider poll recorded for one Run (ISH-1128). */
export function runObservedOwnHeads(db: Database, runId: string): string[] {
  const rows = db
    .query(`SELECT head_sha FROM run_observed_heads WHERE run_id = ? ORDER BY observed_at, rowid`)
    .all(runId) as { head_sha: string }[];
  return rows.map((r) => r.head_sha);
}
