import type { Database } from "bun:sqlite";
import { now } from "./db";
import { logEvent } from "./events";
import { sendMessage } from "./messages";
import type { Reminder } from "./schema";

// Standing reminders: a DAEMON-OWNED recurring nudge. relay's daemon is already
// continuously running, so it — not launchd/cron/a timer — owns the schedule.
//
// On each reconcile pass the daemon enqueues `message` to `worker_id` when
// `every_ms` has elapsed since `last_sent_at`. The send goes through the normal
// durable-message path (`sendMessage`), so the existing mail-nudge safety net
// (src/mail-policy.ts / nudgeUnreadMail) delivers it at the recipient's next
// idle boundary exactly like any other mail.
//
// ANTI-SPAM: a reminder whose recipient already has unread (queued or delivered,
// i.e. not-acked) mail is SKIPPED and its `last_sent_at` is left untouched, so a
// reminder can never stack a second copy behind an unread one. It re-arms as
// soon as the recipient drains its inbox.

/** Insert a new enabled reminder. Baseline `last_sent_at = at` so the FIRST
 *  nudge comes one full interval after creation, not immediately. */
export function addReminder(
  db: Database,
  workerId: string,
  message: string,
  everyMs: number,
  kind = "note",
  at = now()
): Reminder {
  if (!workerId) throw new Error("reminder requires a worker id");
  if (!message || message.trim() === "") throw new Error("reminder message must not be empty");
  if (!Number.isFinite(everyMs) || everyMs <= 0) {
    throw new Error(`reminder interval must be positive (got ${everyMs}ms)`);
  }
  const r = db
    .query(
      `INSERT INTO reminders (worker_id, message, kind, every_ms, last_sent_at, created_at, enabled)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
    .run(workerId, message, kind, everyMs, at, at);
  const id = Number(r.lastInsertRowid);
  logEvent(db, { source: "cli", workerId, type: "reminder.added", payload: { id, everyMs, kind } });
  return getReminder(db, id)!;
}

export function getReminder(db: Database, id: number): Reminder | null {
  return (
    (db.query(`SELECT * FROM reminders WHERE id = ?`).get(id) as Reminder | null) ?? null
  );
}

export function listReminders(db: Database, opts: { includeDisabled?: boolean } = {}): Reminder[] {
  const where = opts.includeDisabled ? "" : "WHERE enabled = 1";
  return db.query(`SELECT * FROM reminders ${where} ORDER BY id ASC`).all() as Reminder[];
}

/** `relay remind rm`: DISABLE (a tombstone), never delete, so the row is history. */
export function disableReminder(db: Database, id: number): Reminder {
  const r = getReminder(db, id);
  if (!r) throw new Error(`unknown reminder: ${id}`);
  db.query(`UPDATE reminders SET enabled = 0 WHERE id = ?`).run(id);
  logEvent(db, { source: "cli", workerId: r.worker_id, type: "reminder.disabled", payload: { id } });
  return getReminder(db, id)!;
}

/**
 * Reminders whose interval has elapsed AND whose recipient has no unread mail.
 * One small indexed query; the anti-spam filter is a NOT EXISTS on messages so
 * the tick never allocates or scans message bodies.
 */
export function dueReminders(db: Database, at = now()): Reminder[] {
  return db
    .query(
      `SELECT r.* FROM reminders r
        WHERE r.enabled = 1
          AND (? - COALESCE(r.last_sent_at, 0)) >= r.every_ms
          AND NOT EXISTS (
            SELECT 1 FROM messages m
             WHERE m.recipient = r.worker_id AND m.state IN ('queued','delivered')
          )
        ORDER BY r.id ASC`
    )
    .all(at) as Reminder[];
}

/**
 * Deliver every due reminder: enqueue the durable message, then advance
 * `last_sent_at`. At most one reminder per worker per pass (so two due reminders
 * for the same worker cannot stack in one tick). Returns the number sent.
 */
export function processReminders(db: Database, actions: string[], at = now()): number {
  let sent = 0;
  const alreadySent = new Set<string>();
  for (const r of dueReminders(db, at)) {
    if (alreadySent.has(r.worker_id)) continue;
    const msgId = sendMessage(db, "reminder", r.worker_id, r.message, { kind: r.kind });
    db.query(`UPDATE reminders SET last_sent_at = ? WHERE id = ?`).run(at, r.id);
    logEvent(db, {
      source: "supervisor",
      workerId: r.worker_id,
      type: "reminder.sent",
      payload: { reminder: r.id, message: msgId, kind: r.kind },
    });
    actions.push(`remind-sent:${r.id}:${r.worker_id}`);
    alreadySent.add(r.worker_id);
    sent++;
  }
  return sent;
}
