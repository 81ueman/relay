import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { now, STATE_DIR } from "./db";
import { logEvent } from "./events";

/**
 * The human operator's mailbox. There is no Herdr agent called `human`, so mail
 * addressed here is delivered through the configured operator alias instead of
 * a wake that can never succeed.
 */
export const HUMAN_RECIPIENT = "human";

/** Split an id list on commas / whitespace / newlines. */
function parseIds(raw: string): string[] {
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Worker ids that field `human`-addressed mail (a coordinator hierarchy).
 *   RELAY_OPERATOR=a,b,c  (wins), else `.relay/operator` (comma/space/newline list).
 * Unset => `human` mail has no delivery target; it stays visible in `relay status`.
 */
export function operators(cwd = process.cwd()): string[] {
  const env = (process.env.RELAY_OPERATOR ?? "").trim();
  if (env) return parseIds(env);
  try {
    const v = readFileSync(join(cwd, STATE_DIR, "operator"), "utf-8").trim();
    if (v) return parseIds(v);
  } catch { /* no operator file */ }
  return [];
}

/** The primary operator (first), for callers that take a single target. */
export function operatorId(cwd = process.cwd()): string | null {
  return operators(cwd)[0] ?? null;
}

/**
 * Mailboxes `workerId` may read and ack. ANY configured operator also fields
 * `human`-addressed mail. The stored `recipient` is never rewritten.
 * Accepts a single id or a list (backwards compatible).
 */
export function mailboxesFor(workerId: string, operator: string | string[] | null): string[] {
  const ops = Array.isArray(operator) ? operator : operator ? [operator] : [];
  return ops.includes(workerId) ? [workerId, HUMAN_RECIPIENT] : [workerId];
}

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

export function inboxFor(
  db: Database,
  workerId: string,
  onlyPending = false,
  extra: string[] = []
): InboxItem[] {
  const recipients = [workerId, ...extra];
  const ph = recipients.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT id, sender, recipient, task_id, kind, payload, state, created_at FROM messages
       WHERE recipient IN (${ph}) ${onlyPending ? "AND state = 'queued'" : "AND state IN ('queued','delivered')"}
       ORDER BY id ASC`
    )
    .all(...recipients) as InboxItem[];
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

/** Mark one message acked (recipient consumed it; an operator may ack `human` mail). */
export function ackMessage(
  db: Database,
  id: number,
  workerId: string,
  operator: string | string[] | null = null
): InboxItem {
  const m = getMessage(db, id);
  if (!m) throw new Error(`unknown message: ${id}`);
  if (!mailboxesFor(workerId, operator).includes(m.recipient)) {
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
export function claimInbox(db: Database, workerId: string, extra: string[] = []): number {
  const t = now();
  const recipients = [workerId, ...extra];
  const ph = recipients.map(() => "?").join(",");
  const pending = db
    .query(`SELECT id FROM messages WHERE recipient IN (${ph}) AND state IN ('queued','delivered')`)
    .all(...recipients) as { id: number }[];
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
