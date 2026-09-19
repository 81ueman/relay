import type { Database } from "bun:sqlite";
import { now } from "./db";
import { logEvent } from "./events";
import { findRuntime, markRuntimeActive } from "./runtimes";
import { getWorker, registerWorker } from "./workers";

export interface Session {
  session_id: string;
  managed: number; // 0 = unmanaged, 1 = managed
  worker_id: string | null;
  role: string | null;
  generation: number;
  directory: string | null;
  worktree: string | null;
  attached_at: number | null;
  detached_at: number | null;
  updated_at: number;
}

export interface AttachOptions {
  role?: string;
  workerId?: string;
  directory?: string;
  worktree?: string;
  /**
   * Explicit generation. Relay-spawned sessions pass the generation from
   * AGENTCTL_GENERATION (authoritative, must match the worker/runtime row).
   * Manual mid-flight attaches omit it and get a fresh bumped generation,
   * which is returned to the plugin and cached for fencing.
   */
  generation?: number;
}

export function getSession(db: Database, sessionId: string): Session | null {
  return (db.query(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId) as Session | null) ?? null;
}

export function listSessions(db: Database): Session[] {
  return db.query(`SELECT * FROM sessions ORDER BY updated_at DESC`).all() as Session[];
}

export function isManaged(db: Database, sessionId: string): boolean {
  const s = getSession(db, sessionId);
  return !!s && s.managed === 1;
}

function slugSession(sessionId: string): string {
  const short = sessionId.replace(/^ses_?/, "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "x";
  return `sess-${short.toLowerCase()}`;
}

/**
 * Attach a live OpenCode session to relay management.
 *
 * - Relay-spawned (opts.generation set): the generation is authoritative and
 *   the matching freshly spawned runtime row is promoted to active.
 * - Manual attach (no generation): bump the generation and return it; the
 *   plugin caches it so subsequent events fence correctly.
 *
 * No process restart required. Returns the session row + bound worker id.
 */
export function attachSession(db: Database, sessionId: string, opts: AttachOptions = {}): Session {
  const t = now();
  const prev = getSession(db, sessionId);
  const role = opts.role ?? prev?.role ?? "worker";
  const workerId = opts.workerId ?? prev?.worker_id ?? slugSession(sessionId);
  const worker = getWorker(db, workerId) ?? registerWorker(db, workerId, { role, sessionId });
  const generation = opts.generation ?? (prev?.generation ?? 0) + 1;

  db.query(`UPDATE workers SET opencode_session_id = ?, role = COALESCE(?, role), updated_at = ? WHERE id = ?`).run(
    sessionId,
    opts.role ?? null,
    t,
    worker.id
  );

  if (opts.generation !== undefined) {
    // Relay-spawned: adopt the generation and leave 'starting/restarting' only
    // now that managed attach has actually landed.
    db.query(
      `UPDATE workers
         SET generation = ?,
             state = CASE WHEN state IN ('starting','restarting') THEN 'idle' ELSE state END,
             updated_at = ?
       WHERE id = ?`
    ).run(generation, t, worker.id);

    // Promote the matching freshly spawned runtime row.
    const rt = findRuntime(db, worker.id, generation);
    if (rt && (rt.state === "starting" || rt.state === "active")) {
      markRuntimeActive(db, rt.id, sessionId, t);
      if (rt.runtime_id) db.query(`UPDATE workers SET runtime_id = ? WHERE id = ?`).run(rt.runtime_id, worker.id);
    }
  }

  db.query(
    `INSERT INTO sessions (session_id, managed, worker_id, role, generation, directory, worktree, attached_at, detached_at, updated_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       managed = 1, worker_id = excluded.worker_id, role = excluded.role,
       generation = excluded.generation, directory = excluded.directory, worktree = excluded.worktree,
       attached_at = excluded.attached_at, detached_at = NULL, updated_at = excluded.updated_at`
  ).run(sessionId, worker.id, role, generation, opts.directory ?? null, opts.worktree ?? null, t, t);
  logEvent(db, {
    source: "supervisor",
    workerId: worker.id,
    type: "session.attached",
    payload: { sessionId, generation, role, spawned: opts.generation !== undefined },
  });
  return getSession(db, sessionId)!;
}

/** Detach: the session returns to a plain standalone OpenCode session. */
export function detachSession(db: Database, sessionId: string): Session | null {
  const t = now();
  const s = getSession(db, sessionId);
  if (!s) return null;
  db.query(`UPDATE sessions SET managed = 0, detached_at = ?, updated_at = ? WHERE session_id = ?`).run(t, t, sessionId);
  if (s.worker_id) {
    const w = getWorker(db, s.worker_id);
    // Release the session binding; a task-holding worker keeps its task (explicit CLI moves it).
    if (w && w.opencode_session_id === sessionId && !w.current_task_id) {
      db.query(`UPDATE workers SET opencode_session_id = NULL, state = 'idle', updated_at = ? WHERE id = ?`).run(t, w.id);
    } else if (w && w.opencode_session_id === sessionId) {
      db.query(`UPDATE workers SET opencode_session_id = NULL, updated_at = ? WHERE id = ?`).run(t, w.id);
    }
  }
  logEvent(db, { source: "supervisor", workerId: s.worker_id, type: "session.detached", payload: { sessionId } });
  return getSession(db, sessionId)!;
}

/**
 * Gate an inbound session event. Returns the managed session, or null when the
 * event must be ignored. Managed events MUST carry a generation: a missing or
 * mismatched generation is ignored (zombie protection). Never writes.
 */
export function gateEvent(
  db: Database,
  sessionId: string | undefined,
  eventGeneration?: number
): { ok: true; session: Session } | { ok: false; reason: string } {
  if (!sessionId) return { ok: false, reason: "no-session" };
  const s = getSession(db, sessionId);
  if (!s || s.managed !== 1) return { ok: false, reason: "unmanaged" };
  if (eventGeneration === undefined) return { ok: false, reason: "no-generation" };
  if (eventGeneration !== s.generation) return { ok: false, reason: "stale-generation" };
  return { ok: true, session: s };
}

/** Resolve a session event to its bound worker (session row first, worker binding fallback). */
export function workerForSession(db: Database, session: Session): string | null {
  if (session.worker_id && getWorker(db, session.worker_id)) return session.worker_id;
  const w = db.query(`SELECT id FROM workers WHERE opencode_session_id = ?`).get(session.session_id) as {
    id: string;
  } | null;
  return w?.id ?? null;
}
