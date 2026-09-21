import type { Database } from "bun:sqlite";
import { now } from "./db";
import { logEvent } from "./events";

/**
 * Prefix for relay-originated text (wake prompts and self-generated messages), so
 * it is never mistaken for a human or peer message in the agent's session.
 */
export const RELAY_TAG = "relay: ";

export function sendMessage(
  db: Database,
  sender: string,
  recipient: string,
  payload: string,
  opts: { taskId?: string; kind?: string } = {}
): number {
  const r = db
    .query(
      `INSERT INTO messages (sender, recipient, task_id, kind, payload, state, created_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?)`
    )
    .run(sender, recipient, opts.taskId ?? null, opts.kind ?? "note", payload, now());
  const id = Number(r.lastInsertRowid);
  logEvent(db, { source: "cli", workerId: sender, taskId: opts.taskId, type: "message.sent", payload: { id, recipient } });
  return id;
}

export interface InboxItem {
  id: number;
  sender: string;
  recipient: string;
  task_id: string | null;
  kind: string;
  payload: string;
  state: string;
  created_at: number;
}

export function inboxFor(db: Database, workerId: string, onlyPending = false): InboxItem[] {
  const rows = db
    .query(
      `SELECT id, sender, recipient, task_id, kind, payload, state, created_at FROM messages
       WHERE recipient = ? ${onlyPending ? "AND state = 'queued'" : "AND state IN ('queued','delivered')"}
       ORDER BY id ASC`
    )
    .all(workerId) as InboxItem[];
  // Reading the inbox marks queued messages delivered (durable; survives restarts).
  const t = now();
  for (const m of rows) {
    if ((m.state as string) === "queued") {
      db.query(`UPDATE messages SET state = 'delivered', delivered_at = ? WHERE id = ?`).run(t, m.id);
      m.state = "delivered";
    }
  }
  return rows;
}

export function getMessage(db: Database, id: number): InboxItem | null {
  return (
    (db
      .query(`SELECT id, sender, recipient, task_id, kind, payload, state, created_at FROM messages WHERE id = ?`)
      .get(id) as InboxItem | null) ?? null
  );
}

/** Mark one message delivered (it reached the recipient's inbox view). */
export function deliverMessage(db: Database, id: number): InboxItem {
  const m = getMessage(db, id);
  if (!m) throw new Error(`unknown message: ${id}`);
  if (m.state === "queued") {
    db.query(`UPDATE messages SET state = 'delivered', delivered_at = ? WHERE id = ?`).run(now(), id);
  }
  return getMessage(db, id)!;
}

/** Mark one message acked (the recipient consumed it). */
export function ackMessage(db: Database, id: number, workerId: string): InboxItem {
  const m = getMessage(db, id);
  if (!m) throw new Error(`unknown message: ${id}`);
  if (m.recipient !== workerId) {
    throw new Error(`message ${id} belongs to ${m.recipient}, not ${workerId}`);
  }
  const t = now();
  db.query(
    `UPDATE messages SET state = 'acked', delivered_at = COALESCE(delivered_at, ?), acked_at = ? WHERE id = ?`
  ).run(t, t, id);
  logEvent(db, { source: "worker", workerId, type: "message.acked", payload: { id } });
  return getMessage(db, id)!;
}

/** Acknowledge (consume) all pending inbox messages. Returns count acked. Kept for CLI compat. */
export function claimInbox(db: Database, workerId: string): number {
  const t = now();
  const pending = db
    .query(`SELECT id FROM messages WHERE recipient = ? AND state IN ('queued','delivered')`)
    .all(workerId) as { id: number }[];
  for (const m of pending) {
    db.query(
      `UPDATE messages SET state = 'acked', delivered_at = COALESCE(delivered_at, ?), acked_at = ? WHERE id = ?`
    ).run(t, t, m.id);
  }
  if (pending.length > 0) {
    logEvent(db, { source: "worker", workerId, type: "message.acked", payload: { count: pending.length } });
  }
  return pending.length;
}

export interface UnreadCount {
  recipient: string;
  /** Never read (the send-time wake never landed or was missed). */
  queued: number;
  /** Read but not yet acked. */
  delivered: number;
}

/** Undelivered/unarcked mail per recipient, for `relay status`. */
export function unreadCounts(db: Database): UnreadCount[] {
  return db
    .query(
      `SELECT recipient,
              SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END) AS queued,
              SUM(CASE WHEN state = 'delivered' THEN 1 ELSE 0 END) AS delivered
         FROM messages
        WHERE state IN ('queued','delivered')
        GROUP BY recipient
        ORDER BY recipient`
    )
    .all() as UnreadCount[];
}
