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
] as const;

/** How long an undelivered message waits before its recipient is nudged, and the nudge cooldown. */
export function mailNudgeMs(): number {
  const v = Number(process.env.RELAY_MAIL_NUDGE_MS ?? "180000");
  return Number.isFinite(v) && v > 0 ? v : 180000;
}

export function immediateKindSql(): string {
  return IMMEDIATE_MAIL_KINDS.map((k) => `'${k}'`).join(",");
}

/**
 * Milliseconds until the recipient's queued mail is next nudged, or null when
 * there is none. 0 means an immediate notice (child_done/child_blocked/...)
 * will be delivered on the next supervisor tick.
 */
export function nextMailNudgeIn(db: Database, recipient: string, at = now()): number | null {
  const q = db
    .query(
      `SELECT MIN(created_at) AS oldest,
              SUM(CASE WHEN kind IN (${immediateKindSql()}) THEN 1 ELSE 0 END) AS immediate
         FROM messages WHERE recipient = ? AND state = 'queued'`
    )
    .get(recipient) as { oldest: number | null; immediate: number | null };
  if (q?.oldest == null) return null;
  if ((q.immediate ?? 0) > 0) return 0;
  const last = (db
    .query(`SELECT MAX(timestamp) AS t FROM events WHERE worker_id = ? AND type = 'worker.mail_nudged'`)
    .get(recipient) as { t: number | null }).t ?? 0;
  const window = mailNudgeMs();
  // Mirrors nudgeUnreadMail: the nudge fires at max(oldest + window, lastNudge + window).
  return Math.max(0, Math.max(q.oldest + window, last + window) - at);
}
