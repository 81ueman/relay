import type { Database } from "bun:sqlite";
import { now } from "./db";
import { logEvent } from "./events";

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

/** Acknowledge (consume) all pending inbox messages. Returns count acked. */
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
