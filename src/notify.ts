import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { STATE_DIR } from "./db";
import { logEvent } from "./events";
import { operatorId, sendMessage } from "./messages";
import type { Task } from "./schema";

/**
 * Operator notifications for work completion. The integrator is a worker with no
 * task, so none of the existing nudges (stall/review/queue-low) ever target it;
 * without these it can only poll. Both notices are durable messages, so they
 * survive a restart and reach the operator through the normal inbox path.
 *
 * RELAY_NOTIFY_ON = off | task | drain | both   (default off, opt-in)
 * Env wins, else a one-line `.relay/notify` file (so a worker's CLI approval sees
 * the same setting without exporting anything).
 */

export type NotifyOn = "off" | "task" | "drain" | "both";

export function notifyOn(cwd = process.cwd()): NotifyOn {
  let raw = (process.env.RELAY_NOTIFY_ON ?? "").trim();
  if (!raw) {
    try {
      raw = readFileSync(join(cwd, STATE_DIR, "notify"), "utf-8").trim();
    } catch { /* no file */ }
  }
  const v = raw.toLowerCase();
  return v === "task" || v === "drain" || v === "both" ? v : "off";
}

function wants(kind: "task" | "drain"): boolean {
  const m = notifyOn();
  return m === "both" || m === kind;
}

/**
 * A durable "task done" notice to the operator, sent at the approval point.
 * No-op without a configured operator or when disabled.
 */
export function notifyTaskDone(db: Database, task: Task, actor: string): number | null {
  if (!wants("task")) return null;
  const op = operatorId();
  if (!op) return null;
  const id = sendMessage(db, "relay", op, `${task.id} done (approved by ${actor}): ${task.title}`, {
    kind: "notify",
    taskId: task.id,
  });
  logEvent(db, {
    source: "supervisor",
    taskId: task.id,
    type: "notify.task_done",
    payload: { messageId: id, operator: op },
  });
  return id;
}

/**
 * A one-shot "grid drained" notice. Debounced durably: it fires only when work
 * has happened since the last drain notice (`task.*` events after the previous
 * `supervisor.grid_drained`), so it never repeats while the grid stays empty and
 * re-arms when new work appears.
 */
export function notifyGridDrained(db: Database): number | null {
  if (!wants("drain")) return null;
  const op = operatorId();
  if (!op) return null;
  const last = (db
    .query(`SELECT MAX(id) AS id FROM events WHERE type = 'supervisor.grid_drained'`)
    .get() as { id: number | null }).id ?? 0;
  const since = (db
    .query(`SELECT COUNT(*) AS n FROM events WHERE type LIKE 'task.%' AND id > ?`)
    .get(last) as { n: number }).n;
  if (since === 0) return null; // already notified for this drain
  const id = sendMessage(db, "relay", op, "all tasks done; nothing queued/running/review/blocked", {
    kind: "notify",
  });
  logEvent(db, {
    source: "supervisor",
    type: "supervisor.grid_drained",
    payload: { messageId: id, operator: op },
  });
  return id;
}
