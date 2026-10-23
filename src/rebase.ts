import type { Database } from "bun:sqlite";
import { gatherMergeGateInput, type MergeGateDeps } from "./merge-gate";
import type { Task } from "./schema";
import { HEAD_MISMATCH, requestMergeReadyRebase } from "./workflow";

/**
 * ISH-1122: the coordinator-facing REBASE FIX endpoint.
 *
 * `requestMergeReadyRebase` owns the (pure) transition rules. This module owns
 * the OBSERVATION: it reads the Task's bound/observed PR through the existing
 * read-only merge-gate reader, and only calls the transition when the PR is
 * really CONFLICTING at the recorded HEAD. Reading is the same `gh` reader the
 * merge gate uses (ISH-1087: auto-detected on the operator path when
 * `RELAY_PROVIDER_GITHUB` is unset, and disabled by `off`); nothing here writes a
 * provider, rebases, pushes or merges.
 *
 * Deliberately NOT a review path: no `ReviewResult` is written, and an
 * unresolved reviewer NG/HOLD or owner HOLD is refused rather than cleared.
 */

export const REBASE_ERROR = "REBASE";

export interface RebaseRequestOptions {
  /** The FIX brief the next implement Run inherits. */
  reason: string;
  /** Read-only providers used to observe the bound PR (and any owner HOLD). */
  deps?: MergeGateDeps;
  /** Optional assertion of the recorded HEAD the caller judged. */
  headSha?: string;
}

/**
 * Observe the bound PR and return a `merge_ready` Task to `implement` at
 * attempt+1 when (and only when) it is CONFLICTING at the recorded HEAD.
 *
 * Fail-closed: no reader, no PR, an unreadable/provider-unknown PR, a merged or
 * closed PR, a moved PR HEAD, a mergeable PR or an unresolved NG/HOLD all refuse
 * without touching the Task.
 */
export async function requestRebase(
  db: Database,
  taskId: string,
  actor: string,
  opts: RebaseRequestOptions
): Promise<Task> {
  const input = await gatherMergeGateInput(db, taskId, opts.deps);
  if (!input) throw new Error(`unknown task: ${taskId}`);
  if (!opts.deps?.github) {
    throw new Error(
      `${REBASE_ERROR}: cannot observe the bound PR for ${taskId}: the read-only GitHub reader is not ` +
      `configured (set RELAY_PROVIDER_GITHUB=gh, or authenticate gh so the operator path can auto-detect it)`
    );
  }
  if (input.head === null) {
    throw new Error(`${REBASE_ERROR}: ${taskId} records no HEAD; there is no revision a conflict could be bound to`);
  }
  if (opts.headSha && opts.headSha !== input.head) {
    throw new Error(`${HEAD_MISMATCH}: rebase head ${opts.headSha} != task head ${input.head} for ${taskId}`);
  }
  if (input.prRead === "unbound") {
    throw new Error(`${REBASE_ERROR}: ${taskId} has no pull request bound/observable; there is no conflict to route`);
  }
  if (input.prRead === "error" || !input.pr) {
    throw new Error(
      `${REBASE_ERROR}: the pull request for ${taskId} could not be read; mergeability is unknown (never assumed conflicting)`
    );
  }
  if (input.merged || input.pr.state === "merged") {
    throw new Error(`${REBASE_ERROR}: ${taskId}'s PR is already merged; there is nothing to rebase`);
  }
  if (input.pr.state !== "open") {
    throw new Error(`${REBASE_ERROR}: ${taskId}'s PR is ${input.pr.state}, not open; a rebase route needs an open PR`);
  }
  if (!input.pr.headSha) {
    throw new Error(
      `${REBASE_ERROR}: the PR read for ${taskId} reported no head; the conflict cannot be bound to the recorded revision`
    );
  }
  if (input.pr.headSha !== input.head) {
    throw new Error(
      `${HEAD_MISMATCH}: the PR head ${input.pr.headSha} != recorded head ${input.head} for ${taskId}; ` +
      `the observed conflict is not of this work`
    );
  }
  if (input.pr.mergeable !== "conflicting") {
    throw new Error(
      `${REBASE_ERROR}: ${taskId}'s PR is ${input.pr.mergeable}, not conflicting; no rebase is needed ` +
      `(a mergeable PR is refused)`
    );
  }
  return requestMergeReadyRebase(db, taskId, actor, {
    reason: opts.reason,
    prMergeable: input.pr.mergeable,
    prHeadSha: input.pr.headSha,
    hold: input.hold,
    headSha: opts.headSha ?? input.head,
  });
}
