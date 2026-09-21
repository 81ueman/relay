import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { STATE_DIR } from "./db";
import { logEvent } from "./events";
import { operators, sendMessage } from "./messages";
import type { Task } from "./schema";

/**
 * Operator notifications for work completion. The integrator is a worker with no
 * task, so none of the existing nudges (stall/review/queue-low) ever target it;
 * without these it can only poll. Notices are durable messages, so they survive
 * a restart and reach each recipient through the normal inbox path.
 *
 * Enable: RELAY_NOTIFY_ON = off | task | drain | both   (default off).
 * Config lives in RELAY_NOTIFY_ON / `.relay/notify` (env wins).
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

// --- hierarchical routing ---------------------------------------------------

export interface NotifyRoute {
  /** Exact role or glob (e.g. "perf-*"). */
  role: string;
  to: string[];
}
export interface NotifyRoutes {
  /** Top rollup; ALWAYS receives (task) and is the drain target. */
  default: string[];
  routes: NotifyRoute[];
}

const EMPTY_ROUTES: NotifyRoutes = { default: [], routes: [] };

/**
 * Routing table: `.relay/notify-routes.json`, or inline JSON in
 * RELAY_NOTIFY_ROUTES (env wins). Example:
 *   { "default": ["top-coord"],
 *     "routes": [ { "role": "perf-*", "to": ["dp-coord", "top-coord"] } ] }
 */
export function notifyRoutes(cwd = process.cwd()): NotifyRoutes {
  let raw = (process.env.RELAY_NOTIFY_ROUTES ?? "").trim();
  if (!raw) {
    try {
      raw = readFileSync(join(cwd, STATE_DIR, "notify-routes.json"), "utf-8").trim();
    } catch { return EMPTY_ROUTES; }
  }
  if (!raw) return EMPTY_ROUTES;
  try {
    const d = JSON.parse(raw) as { default?: unknown; routes?: unknown };
    const def = Array.isArray(d.default) ? d.default.filter((x): x is string => typeof x === "string") : [];
    const routes = Array.isArray(d.routes)
      ? (d.routes as unknown[])
          .filter((r): r is { role: string; to: unknown[] } =>
            !!r && typeof r === "object" && typeof (r as { role?: unknown }).role === "string" &&
            Array.isArray((r as { to?: unknown }).to))
          .map((r) => ({ role: r.role, to: r.to.filter((x): x is string => typeof x === "string") }))
      : [];
    return { default: def, routes };
  } catch {
    return EMPTY_ROUTES;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Exact match, or a glob where `*` matches any run of characters. */
export function roleMatches(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  if (!pattern.includes("*")) return false;
  return new RegExp("^" + pattern.split("*").map(escapeRe).join(".*") + "$").test(value);
}

/**
 * Recipients for a task-completion notice: the DEFAULT rollup ALWAYS receives,
 * plus the recipients of the FIRST route whose role glob matches the task role.
 * With no routing configured at all, fall back to the legacy operator list.
 * Deduped (a recipient listed twice gets ONE message).
 */
export function notifyRecipients(
  role: string | null,
  routes: NotifyRoutes,
  fallback: string[]
): string[] {
  const configured = routes.default.length > 0 || routes.routes.length > 0;
  const out = [...routes.default];
  if (role) {
    const route = routes.routes.find((r) => roleMatches(r.role, role));
    if (route) out.push(...route.to);
  }
  if (!configured) out.push(...fallback);
  return [...new Set(out.filter(Boolean))];
}

/**
 * Durable "task done" notices, one per routed recipient. Route by the TASK's
 * role; the default rollup always receives. No-op without recipients/disabled.
 */
export function notifyTaskDone(db: Database, task: Task, actor: string): string[] {
  if (!wants("task")) return [];
  const recipients = notifyRecipients(task.role ?? null, notifyRoutes(), operators());
  if (recipients.length === 0) return [];
  const payload = `${task.id} done (approved by ${actor}): ${task.title}`;
  for (const r of recipients) {
    sendMessage(db, "relay", r, payload, { kind: "notify", taskId: task.id });
  }
  logEvent(db, {
    source: "supervisor",
    taskId: task.id,
    type: "notify.task_done",
    payload: { recipients, role: task.role ?? null },
  });
  return recipients;
}

/**
 * A one-shot "grid drained" notice to the default rollup. Debounced durably by
 * event id: it fires only when work happened since the last drain notice, so it
 * never repeats while empty and re-arms when new work appears.
 * Returns the recipients that were notified (empty = none).
 */
export function notifyGridDrained(db: Database): string[] {
  if (!wants("drain")) return [];
  const routes = notifyRoutes();
  const recipients = [...new Set(routes.default.length > 0 ? routes.default : operators())].filter(Boolean);
  if (recipients.length === 0) return [];
  const last = (db
    .query(`SELECT MAX(id) AS id FROM events WHERE type = 'supervisor.grid_drained'`)
    .get() as { id: number | null }).id ?? 0;
  const since = (db
    .query(`SELECT COUNT(*) AS n FROM events WHERE type LIKE 'task.%' AND id > ?`)
    .get(last) as { n: number }).n;
  if (since === 0) return []; // already notified for this drain
  for (const r of recipients) {
    sendMessage(db, "relay", r, "all tasks done; nothing queued/running/review/blocked", { kind: "notify" });
  }
  logEvent(db, {
    source: "supervisor",
    type: "supervisor.grid_drained",
    payload: { recipients },
  });
  return recipients;
}
