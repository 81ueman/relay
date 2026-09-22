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
 * Kinds that may pre-empt the idle wait via the STABILIZATION/starvation cap
 * (T329): completion notices and `--urgent`. Ordinary kinds still DEFER while a
 * worker is busy and are delivered at idle — they are never dropped (T339); they
 * simply have no fast-path to interrupt a busy turn.
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

/**
 * The starvation cap for ORDINARY (non-actionable) mail. It may legitimately
 * wait a whole turn, so it gets a LONGER bound than actionable mail: a busy
 * worker is nudged once after this, but ordinary mail is otherwise delivered at
 * the next idle/turn boundary (T339).
 */
export function ordinaryStarvationCapMs(): number {
  const v = Number(process.env.RELAY_MAIL_ORDINARY_STARVATION_MS ?? String(2 * starvationCapMs()));
  return Number.isFinite(v) && v > 0 ? v : 2 * starvationCapMs();
}

export function immediateKindSql(): string {
  return IMMEDIATE_MAIL_KINDS.map((k) => `'${k}'`).join(",");
}

/**
 * Milliseconds until the recipient's queued mail is next nudged, or null when
 * there is none. Both classes deliver at the turn boundary; the difference is
 * only the STARVATION cap (ordinary mail waits longer). Returns the un-deferred
 * schedule (a busy worker defers it; the supervisor logs mail_nudge_deferred).
 */
export function nextMailNudgeIn(db: Database, recipient: string, at = now()): number | null {
  const q = db
    .query(
      `SELECT MIN(CASE WHEN kind IN (${immediateKindSql()}) THEN created_at END) AS oldest,
              MIN(CASE WHEN kind NOT IN (${immediateKindSql()}) THEN created_at END) AS oldest_ordinary
         FROM messages WHERE recipient = ? AND state = 'queued'`
    )
    .get(recipient) as { oldest: number | null; oldest_ordinary: number | null };
  const oldest = q?.oldest ?? q?.oldest_ordinary ?? null;
  if (oldest == null) return null;
  const last = (db
    .query(`SELECT MAX(timestamp) AS t FROM events WHERE worker_id = ? AND type = 'worker.mail_nudged'`)
    .get(recipient) as { t: number | null }).t ?? 0;
  const window = mailNudgeMs();
  // Mirrors nudgeUnreadMail's schedule. A busy worker DEFERS the nudge (the
  // supervisor logs worker.mail_nudge_deferred); this is the un-deferred time.
  return Math.max(0, Math.max(oldest + window, last + window) - at);
}
