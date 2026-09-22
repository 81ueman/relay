import type { Database } from "bun:sqlite";
import { now } from "./db";

/**
 * Mail-nudge policy, shared by the supervisor (which delivers) and the dashboard
 * (which shows when the next nudge is due) so the two never drift.
 */

/** Relay-generated kinds delivered without the mail-nudge initial delay. */
export const IMMEDIATE_MAIL_KINDS = [
  "child_done",
  "children_done",
  "child_blocked",
  "children_blocked",
  /** `relay send --urgent`: a genuine interrupt that MAY wake a busy worker. */
  "urgent",
] as const;

/**
 * Kinds that may nudge a worker even while it is mid-turn. Everything else is
 * PULL-ONLY: it surfaces at the worker's next `relay inbox` stopping point and is
 * never allowed to interrupt active work (T329).
 */
export function isImmediateKind(kind: string | null | undefined): boolean {
  return !!kind && (IMMEDIATE_MAIL_KINDS as readonly string[]).includes(kind);
}

/** How long an undelivered message waits before its recipient is nudged, and the nudge cooldown. */
export function mailNudgeMs(): number {
  const v = Number(process.env.RELAY_MAIL_NUDGE_MS ?? "180000");
  return Number.isFinite(v) && v > 0 ? v : 180000;
}

/**
 * Hard upper bound on how long a busy worker may defer a nudge: after
 * `starvationCapMs()` of CONTINUOUS work the worker is nudged once anyway, so
 * durable mail can never be starved indefinitely by a very long turn (T329).
 */
export function starvationCapMs(): number {
  const v = Number(process.env.RELAY_MAIL_STARVATION_MS ?? String(4 * mailNudgeMs()));
  return Number.isFinite(v) && v > 0 ? v : 4 * mailNudgeMs();
}

export function immediateKindSql(): string {
  return IMMEDIATE_MAIL_KINDS.map((k) => `'${k}'`).join(",");
}

/**
 * Milliseconds until the recipient's queued mail is next nudged, or null when
 * there is none. Immediate notices (child_done/child_blocked/urgent/...) are
 * nudged on the next supervisor tick (0) subject to the working check; ordinary
 * mail is PULL-ONLY and reports null (it is never nudged).
 */
export function nextMailNudgeIn(db: Database, recipient: string, at = now()): number | null {
  const q = db
    .query(
      `SELECT MIN(CASE WHEN kind IN (${immediateKindSql()}) THEN created_at END) AS oldest,
              SUM(CASE WHEN kind IN (${immediateKindSql()}) THEN 1 ELSE 0 END) AS immediate
         FROM messages WHERE recipient = ? AND state = 'queued'`
    )
    .get(recipient) as { oldest: number | null; immediate: number | null };
  if (q?.oldest == null) return null;
  // PULL-ONLY: ordinary mail is never nudged, so it has no next nudge.
  if ((q.immediate ?? 0) === 0) return null;
  const last = (db
    .query(`SELECT MAX(timestamp) AS t FROM events WHERE worker_id = ? AND type = 'worker.mail_nudged'`)
    .get(recipient) as { t: number | null }).t ?? 0;
  const window = mailNudgeMs();
  // Mirrors nudgeUnreadMail's schedule. A busy worker DEFERS the nudge (the
  // supervisor logs worker.mail_nudge_deferred); this is the un-deferred time.
  return Math.max(0, Math.max(q.oldest + window, last + window) - at);
}
