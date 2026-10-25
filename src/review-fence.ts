/**
 * ISH-1226: a review in flight holds the Task worktree's shared `target/`.
 *
 * A headless reviewer is not a `runs` row (it has no dsh process), so the
 * ISH-760 single-writer guard cannot see it. A durable fence makes the mutual
 * exclusion real ACROSS PROCESSES:
 *
 *   - `runHeadlessReview` inserts the fence in a `BEGIN IMMEDIATE` transaction
 *     after re-checking that no writer Run holds the worktree;
 *   - `startDshRun` re-checks the fence in the same `BEGIN IMMEDIATE`
 *     transaction that inserts its Run row.
 *
 * Whichever begins second observes the first. A fence is live until its
 * `expires_at` (the reviewer's own hard timeout plus a grace window): a crashed
 * Factory/reviewer therefore fails CLOSED — a writer is refused rather than
 * racing an orphan reviewer that may still write `target/`.
 */
import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { now } from "./db";
import { findActiveWriterRow } from "./run-owner";

/** A live writer Run still holds the Task worktree (checked when fencing). */
export const REVIEW_WRITER_ACTIVE = "REVIEW_WRITER_ACTIVE";
/** A review is already in flight for this Task/worktree. */
export const REVIEW_IN_FLIGHT = "REVIEW_IN_FLIGHT";

/** Slack after the reviewer's hard timeout before a crashed fence stops blocking. */
export const REVIEW_FENCE_GRACE_MS = 60_000;

export interface ReviewFence {
  task_id: string;
  token: string;
  worktree: string;
  branch: string | null;
  head_sha: string;
  started_at: number;
  expires_at: number;
}

export interface ReviewFenceQuery {
  /** Match a review of this exact Task. */
  taskId?: string | null;
  /** Match a review sharing this worktree (resolved). */
  cwd?: string | null;
  /** Match a review on this branch. */
  branch?: string | null;
}

export class ReviewFenceRefused extends Error {
  readonly code: typeof REVIEW_WRITER_ACTIVE | typeof REVIEW_IN_FLIGHT;
  readonly writerRunId: string | null;
  readonly fence: ReviewFence | null;

  constructor(
    code: typeof REVIEW_WRITER_ACTIVE | typeof REVIEW_IN_FLIGHT,
    message: string,
    extra: { writerRunId?: string | null; fence?: ReviewFence | null } = {}
  ) {
    super(message);
    this.name = "ReviewFenceRefused";
    this.code = code;
    this.writerRunId = extra.writerRunId ?? null;
    this.fence = extra.fence ?? null;
  }
}

/** The live review fence matching this Task/worktree/branch, or null. */
export function findLiveReviewFenceRow(
  db: Database,
  q: ReviewFenceQuery,
  at: number = now()
): ReviewFence | null {
  const rows = db
    .query(`SELECT * FROM review_fences WHERE expires_at > ? ORDER BY started_at DESC, rowid DESC`)
    .all(at) as ReviewFence[];
  const cwd = q.cwd ? resolve(q.cwd) : null;
  for (const row of rows) {
    if (q.taskId && row.task_id === q.taskId) return row;
    if (cwd && resolve(row.worktree) === cwd) return row;
    if (q.branch && row.branch && q.branch === row.branch) return row;
  }
  return null;
}

/** The REVIEW_IN_FLIGHT refusal for a live fence. */
export function reviewInFlightError(fence: ReviewFence): Error {
  return new Error(
    `${REVIEW_IN_FLIGHT}: review ${fence.token} of ${fence.task_id} is live in ${fence.worktree} ` +
      `until ${new Date(fence.expires_at).toISOString()}; wait for it to end before launching another writer`
  );
}

/** Throw REVIEW_IN_FLIGHT when a live review holds this Task/worktree. */
export function assertNoReviewInFlight(db: Database, q: ReviewFenceQuery, at: number = now()): void {
  const fence = findLiveReviewFenceRow(db, q, at);
  if (fence) throw reviewInFlightError(fence);
}

export interface BeginReviewFenceInput {
  taskId: string;
  /** The durable Task worktree whose `target/` the reviewer shares. */
  worktree: string;
  branch: string | null;
  headSha: string;
  /** The reviewer's hard timeout; the fence outlives it by the grace window. */
  timeoutMs: number;
}

/**
 * Take the review fence. The writer check and the INSERT share ONE
 * `BEGIN IMMEDIATE` transaction, so a writer cannot slip between the pre-check
 * and the reviewer spawn. Throws `ReviewFenceRefused` (REVIEW_WRITER_ACTIVE or
 * REVIEW_IN_FLIGHT) and leaves no fence behind when refused.
 */
export function beginReviewFence(db: Database, input: BeginReviewFenceInput): ReviewFence {
  const startedAt = now();
  const worktree = resolve(input.worktree);
  const fence: ReviewFence = {
    task_id: input.taskId,
    token: `review-fence-${crypto.randomUUID().slice(0, 8)}`,
    worktree,
    branch: input.branch,
    head_sha: input.headSha,
    started_at: startedAt,
    expires_at: startedAt + Math.max(0, input.timeoutMs) + REVIEW_FENCE_GRACE_MS,
  };
  return db
    .transaction(() => {
      // An expired row is not a holder, but its PRIMARY KEY (task_id) would
      // still block a new review of the same Task. Drop expired fences first.
      db.query(`DELETE FROM review_fences WHERE expires_at <= ?`).run(startedAt);
      const writer = findActiveWriterRow(db, { cwd: worktree, branch: input.branch });
      if (writer) {
        throw new ReviewFenceRefused(
          REVIEW_WRITER_ACTIVE,
          `${REVIEW_WRITER_ACTIVE}: run ${writer.id} is '${writer.state}' in the Task worktree ${worktree}; refuse to share its build cache`,
          { writerRunId: writer.id }
        );
      }
      const existing = findLiveReviewFenceRow(
        db,
        { taskId: input.taskId, cwd: worktree, branch: input.branch },
        startedAt
      );
      if (existing) {
        throw new ReviewFenceRefused(REVIEW_IN_FLIGHT, reviewInFlightError(existing).message, { fence: existing });
      }
      db.query(
        `INSERT INTO review_fences
           (task_id, token, worktree, branch, head_sha, started_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        fence.task_id,
        fence.token,
        fence.worktree,
        fence.branch,
        fence.head_sha,
        fence.started_at,
        fence.expires_at
      );
      return fence;
    })
    .immediate();
}

/**
 * Release the fence this review took. Best effort: a failed DELETE leaves the
 * fence to expire (fail closed), never throws out of the reviewer's finally.
 */
export function releaseReviewFence(db: Database, token: string): void {
  try {
    db.query(`DELETE FROM review_fences WHERE token = ?`).run(token);
  } catch {
    /* the fence still expires; a writer is refused until then */
  }
}
