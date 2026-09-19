import type { Database } from "bun:sqlite";
import { now } from "./db";
import type { DbEvent } from "./schema";

export interface LogEventInput {
  source: string;
  workerId?: string | null;
  taskId?: string | null;
  type: string;
  payload?: unknown;
}

export function logEvent(db: Database, e: LogEventInput): number {
  const r = db
    .query(
      `INSERT INTO events (timestamp, source, worker_id, task_id, type, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      now(),
      e.source,
      e.workerId ?? null,
      e.taskId ?? null,
      e.type,
      JSON.stringify(e.payload ?? {})
    );
  return Number(r.lastInsertRowid);
}

export function listEvents(db: Database, opts: { limit?: number; sinceId?: number } = {}): DbEvent[] {
  const limit = Math.min(opts.limit ?? 100, 1000);
  if (opts.sinceId !== undefined) {
    return db
      .query(`SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?`)
      .all(opts.sinceId, limit) as DbEvent[];
  }
  return db.query(`SELECT * FROM events ORDER BY id DESC LIMIT ?`).all(limit) as DbEvent[];
}

export function formatEvent(e: DbEvent): string {
  const ts = new Date(e.timestamp).toISOString();
  const who = e.worker_id ?? "-";
  const task = e.task_id ?? "-";
  return `#${e.id} ${ts} [${e.source}] ${e.type} worker=${who} task=${task} ${e.payload_json}`;
}

/** Count session.idle events for a worker since its last progress (premature-stop signal). */
export function countIdleSinceProgress(db: Database, workerId: string): number {
  const w = db.query(`SELECT last_progress_at FROM workers WHERE id = ?`).get(workerId) as {
    last_progress_at: number;
  } | null;
  if (!w) return 0;
  const r = db
    .query(
      `SELECT COUNT(*) AS n FROM events
       WHERE worker_id = ? AND type = 'session.idle' AND timestamp >= ?`
    )
    .get(workerId, w.last_progress_at) as { n: number };
  return r.n;
}
