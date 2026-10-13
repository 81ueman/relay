import type { Database } from "bun:sqlite";
import { now } from "./db";
import { logEvent } from "./events";

/**
 * Durable immediate-reconcile signal (ISH-758). A task-state transition bumps a
 * monotonic token in the one-row `control` table; the daemon notices the change
 * on its fast tick and reconciles at once. Kept in its own module (imports
 * nothing from tasks/workflow) so the core task machine and the workflow can both
 * raise it without an import cycle.
 */
export const RECONCILE_KEY = "reconcile_request";

export function requestReconcile(db: Database, reason = ""): number {
  const t = now();
  db.query(
    `INSERT INTO control (key, value, updated_at) VALUES (?, '1', ?)
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at`
  ).run(RECONCILE_KEY, t);
  const row = db.query(`SELECT value FROM control WHERE key = ?`).get(RECONCILE_KEY) as { value: string };
  logEvent(db, { source: "workflow", type: "workflow.reconcile_requested", payload: { reason, token: row.value } });
  return Number(row.value);
}

/** The current reconcile-request token ("" when never requested). */
export function reconcileRequestToken(db: Database): string {
  const row = db.query(`SELECT value FROM control WHERE key = ?`).get(RECONCILE_KEY) as { value: string } | null;
  return row?.value ?? "";
}
