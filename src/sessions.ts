import type { Database } from "bun:sqlite";
import { now } from "./db";
import { logEvent } from "./events";
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
 * Bumps the generation so stale events from a previous epoch are ignored.
 * No process restart required. Returns the session row + bound worker id.
 */
export function attachSession(
  db: Database,
  sessionId: string,
  opts: { role?: string; workerId?: string; directory?: string; worktree?: string } = {}
): Session {
  const t = now();
  const role = opts.role ?? "worker";
  const workerId = opts.workerId ?? slugSession(sessionId);
  const worker = getWorker(db, workerId) ?? registerWorker(db, workerId, { role });
  db.query(`UPDATE workers SET opencode_session_id = ?, updated_at = ? WHERE id = ?`).run(sessionId, t, worker.id);

  const prev = getSession(db, sessionId);
  const generation = (prev?.generation ?? 0) + 1;
  db.query(
    `INSERT INTO sessions (session_id, managed, worker_id, role, generation, directory, worktree, attached_at, detached_at, updated_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       managed = 1, worker_id = excluded.worker_id, role = excluded.role,
       generation = excluded.generation, directory = excluded.directory, worktree = excluded.worktree,
       attached_at = excluded.attached_at, detached_at = NULL, updated_at = excluded.updated_at`
  ).run(sessionId, worker.id, role, generation, opts.directory ?? null, opts.worktree ?? null, t, t);
  logEvent(db, { source: "supervisor", workerId: worker.id, type: "session.attached", payload: { sessionId, generation, role } });
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
 * event must be ignored (unmanaged session or stale generation). Never writes.
 */
export function gateEvent(
  db: Database,
  sessionId: string | undefined,
  eventGeneration?: number
): { ok: true; session: Session } | { ok: false; reason: string } {
  if (!sessionId) return { ok: false, reason: "no-session" };
  const s = getSession(db, sessionId);
  if (!s || s.managed !== 1) return { ok: false, reason: "unmanaged" };
  if (eventGeneration !== undefined && eventGeneration !== s.generation) {
    return { ok: false, reason: "stale-generation" };
  }
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
