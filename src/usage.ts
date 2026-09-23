import type { Database } from "bun:sqlite";
import { now } from "./db";
import { logEvent } from "./events";
import type { UsageSample } from "./schema";
import { getSession } from "./sessions";

/**
 * Cost/token observability (T551 #8).
 *
 * The OpenCode plugin reports a session's session-lifetime CUMULATIVE cost and
 * token counts (`session.usage`). The raw cumulative cannot answer "what did
 * THIS task cost?" because a session can outlive many tasks. So the daemon
 * keeps the last cumulative as a per-session CURSOR and records each new
 * reading's DIFFERENCE as one `usage_samples` row, tagged with the worker and
 * the task the worker held at that moment.
 *
 * Compaction is tracked the same way: `session_v2.time_compacting` is always
 * NULL, so the count is reconstructed from plugin compaction events.
 */

/** A cumulative reading as forwarded by the plugin. */
export interface UsageReading {
  cost: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface RecordUsageOptions {
  sessionId: string;
  workerId: string | null;
  taskId: string | null;
  generation: number;
  reading: UsageReading;
  at?: number;
}

function clampDelta(next: number, prev: number): number {
  const d = (Number.isFinite(next) ? next : 0) - (Number.isFinite(prev) ? prev : 0);
  return d > 0 ? d : 0;
}

function isZeroDelta(d: {
  cost: number;
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
}): boolean {
  return (
    d.cost <= 0 &&
    d.input <= 0 &&
    d.output <= 0 &&
    d.reasoning <= 0 &&
    d.cache_read <= 0 &&
    d.cache_write <= 0
  );
}

/**
 * Fold a new cumulative reading into the session cursor and record the delta.
 *
 * The FIRST reading for a session only establishes the BASELINE: a session
 * adopted mid-life (or one that started before relay began observing) must not
 * dump its entire history onto whatever task it happens to hold right now.
 * Returns the recorded sample, or null when the reading was a baseline / empty.
 */
export function recordSessionUsage(db: Database, opts: RecordUsageOptions): UsageSample | null {
  const at = opts.at ?? now();
  const s = getSession(db, opts.sessionId);
  if (!s) return null;
  const first = s.usage_updated_at === null;
  const r = opts.reading;

  const delta = {
    cost: clampDelta(r.cost, s.usage_cost),
    input: clampDelta(r.input, s.usage_input),
    output: clampDelta(r.output, s.usage_output),
    reasoning: clampDelta(r.reasoning, s.usage_reasoning),
    cache_read: clampDelta(r.cacheRead, s.usage_cache_read),
    cache_write: clampDelta(r.cacheWrite, s.usage_cache_write),
  };

  // Advance the cursor to the new cumulative whether or not a delta is recorded.
  db.query(
    `UPDATE sessions SET usage_cost = ?, usage_input = ?, usage_output = ?, usage_reasoning = ?,
       usage_cache_read = ?, usage_cache_write = ?, usage_updated_at = ?, updated_at = ?
     WHERE session_id = ?`
  ).run(r.cost, r.input, r.output, r.reasoning, r.cacheRead, r.cacheWrite, at, at, opts.sessionId);

  if (first || isZeroDelta(delta)) return null;

  db.query(
    `INSERT INTO usage_samples (at, session_id, worker_id, task_id, generation, cost,
       tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    at,
    opts.sessionId,
    opts.workerId,
    opts.taskId,
    opts.generation,
    delta.cost,
    delta.input,
    delta.output,
    delta.reasoning,
    delta.cache_read,
    delta.cache_write
  );
  return db.query(`SELECT * FROM usage_samples WHERE id = last_insert_rowid()`).get() as UsageSample;
}

export type CompactionStatus = "started" | "ended" | "failed" | "completed";

export interface RecordCompactionOptions {
  sessionId: string;
  status: CompactionStatus;
  reason?: string | null;
  at?: number;
}

/**
 * Record a compaction event. Counts each compaction EXACTLY ONCE: a `started`
 * counts immediately; a terminal status (`ended`/`failed`/`completed`) only
 * counts when no `started` was seen (so a missed start still yields a count and
 * a started+ended pair never double-counts). Every status is logged as an event
 * for reconciliation.
 */
export function recordSessionCompaction(
  db: Database,
  opts: RecordCompactionOptions
): { counted: boolean } {
  const at = opts.at ?? now();
  const s = getSession(db, opts.sessionId);
  if (!s) return { counted: false };

  let counted = false;
  if (opts.status === "started") {
    db.query(
      `UPDATE sessions SET compactions = compactions + 1, compaction_open = 1, updated_at = ? WHERE session_id = ?`
    ).run(at, opts.sessionId);
    counted = true;
  } else if (s.compaction_open === 1) {
    db.query(
      `UPDATE sessions SET compaction_open = 0, last_compacted_at = ?, updated_at = ? WHERE session_id = ?`
    ).run(at, at, opts.sessionId);
  } else {
    db.query(
      `UPDATE sessions SET compactions = compactions + 1, last_compacted_at = ?, updated_at = ? WHERE session_id = ?`
    ).run(at, at, opts.sessionId);
    counted = true;
  }

  logEvent(db, {
    source: "opencode",
    workerId: s.worker_id,
    type: "session.compaction",
    payload: { sessionId: opts.sessionId, status: opts.status, reason: opts.reason ?? null, counted },
  });
  return { counted };
}

export type UsageGroup = "worker" | "task" | "session";

export interface UsageRow {
  key: string;
  cost: number;
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
  samples: number;
  compactions: number;
}

const GROUP_COLUMN: Record<UsageGroup, string> = {
  worker: "worker_id",
  task: "task_id",
  session: "session_id",
};

function compactionCounts(db: Database, group: UsageGroup): Map<string, number> {
  const out = new Map<string, number>();
  if (group === "task") return out; // compactions are session-scoped, not task-scoped
  const col = group === "worker" ? "worker_id" : "session_id";
  const rows = db
    .query(
      `SELECT ${col} AS k, SUM(compactions) AS n FROM sessions WHERE ${col} IS NOT NULL GROUP BY ${col} HAVING SUM(compactions) > 0`
    )
    .all() as { k: string; n: number }[];
  for (const r of rows) out.set(r.k, r.n ?? 0);
  return out;
}

/** Aggregate attributed usage by worker, task or session, newest cost first. */
export function usageReport(db: Database, group: UsageGroup, since?: number): UsageRow[] {
  const col = GROUP_COLUMN[group];
  const where = since !== undefined ? "WHERE at >= ?" : "";
  const sql = `SELECT COALESCE(${col}, '(unattributed)') AS key,
      SUM(cost) AS cost,
      SUM(tokens_input) AS input,
      SUM(tokens_output) AS output,
      SUM(tokens_reasoning) AS reasoning,
      SUM(tokens_cache_read) AS cache_read,
      SUM(tokens_cache_write) AS cache_write,
      COUNT(*) AS samples
    FROM usage_samples ${where}
    GROUP BY ${col}
    ORDER BY cost DESC, input DESC`;
  const rows = (since !== undefined ? db.query(sql).all(since) : db.query(sql).all()) as Omit<
    UsageRow,
    "compactions"
  >[];
  const compactions = compactionCounts(db, group);
  const merged = new Map<string, UsageRow>();
  for (const r of rows) merged.set(r.key, { ...r, compactions: compactions.get(r.key) ?? 0 });
  // A session can compact before it reports any attributable usage (its first
  // reading is only a baseline). Surface those so compaction is never hidden.
  for (const [key, n] of compactions) {
    if (!merged.has(key)) {
      merged.set(key, {
        key,
        cost: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        cache_read: 0,
        cache_write: 0,
        samples: 0,
        compactions: n,
      });
    }
  }
  return [...merged.values()].sort(
    (a, b) => b.cost - a.cost || b.input - a.input || b.compactions - a.compactions
  );
}

export interface UsageTotals {
  cost: number;
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
  samples: number;
}

export function usageTotals(db: Database, since?: number): UsageTotals {
  const where = since !== undefined ? "WHERE at >= ?" : "";
  const sql = `SELECT COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(tokens_input), 0) AS input,
      COALESCE(SUM(tokens_output), 0) AS output, COALESCE(SUM(tokens_reasoning), 0) AS reasoning,
      COALESCE(SUM(tokens_cache_read), 0) AS cache_read, COALESCE(SUM(tokens_cache_write), 0) AS cache_write,
      COUNT(*) AS samples
    FROM usage_samples ${where}`;
  const r = (since !== undefined ? db.query(sql).get(since) : db.query(sql).get()) as UsageTotals | null;
  return (
    r ?? { cost: 0, input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, samples: 0 }
  );
}
