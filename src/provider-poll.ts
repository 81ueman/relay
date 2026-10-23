import type { Database } from "bun:sqlite";
import { activeProviderRateLimit, type ProviderRateLimitState } from "./provider-rate-limit";
import type { ChecksReadOnly, GitHubReadOnly, LinearReadOnly } from "./providers";
import type { Task } from "./schema";

/**
 * ISH-1132 — the one per-Task provider-poll budget.
 *
 * Both daemon passes that make provider reads (the PR/issue reconciliation and
 * the HEAD-bound merge gate, which reads `check-runs`) use the SAME durable
 * `tasks.provider_polled_at` timestamp. A Task is read at most once per
 * `RELAY_PROVIDER_POLL_MS` (default 60s), so the shared GitHub API budget is not
 * spent once per 1.5s daemon tick.
 *
 * The poll ALSO only ever runs for a Task that can still change: a live Run
 * (mid-implementation PR binding), or review/merge_ready/integration. Terminal
 * Tasks (done/failed/cancelled) are never polled, no matter how many are bound
 * to a PR in the DB — with the ISH-1138 exception of a `done` Task accepted
 * before its PR merged, which stays polled until `merged_at` or a final
 * `pr_settled_at` observation (closed, or merged at an uncreditable head) is
 * recorded and then leaves for good.
 */

/** The phases that still need provider reads even with no live Run. */
export const PROVIDER_POLL_PHASES = ["review", "merge_ready", "integration"] as const;

/** Minimum spacing between provider polls of one task (default 60s). */
export function providerPollMs(env: { [key: string]: string | undefined } = process.env): number {
  const v = Number(env.RELAY_PROVIDER_POLL_MS ?? "60000");
  return Number.isFinite(v) && v >= 0 ? v : 60000;
}

/**
 * True when the Task may spend a provider call now. `0` disables the throttle
 * (used by tests); a never-polled Task is always due.
 */
export function providerPollDue(
  task: Pick<Task, "provider_polled_at">,
  nowMs = Date.now(),
  pollMs = providerPollMs()
): boolean {
  if (pollMs <= 0) return true;
  return task.provider_polled_at === null || nowMs - task.provider_polled_at >= pollMs;
}

/** Record that this Task spent a provider read at `at`. */
export function markProviderPolled(db: Database, taskId: string, at = Date.now()): void {
  db.query(`UPDATE tasks SET provider_polled_at = ? WHERE id = ?`).run(at, taskId);
}

export interface ProviderReaderSet {
  github?: GitHubReadOnly;
  linear?: LinearReadOnly;
  checks?: ChecksReadOnly;
}

/**
 * The active rate-limit backoff across the configured readers, or null. A
 * reader that sees a 403/429 records it; every later pass can then skip its
 * provider calls without spawning another command.
 */
export function currentProviderRateLimit(deps: ProviderReaderSet, now = Date.now()): ProviderRateLimitState | null {
  return activeProviderRateLimit(
    deps.github?.rateLimit?.() ??
      deps.checks?.rateLimit?.() ??
      deps.linear?.rateLimit?.() ??
      null,
    now
  );
}
