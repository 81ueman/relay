import type { Database } from "bun:sqlite";
import { now } from "./db";
import { logEvent } from "./events";
import type { HerdrIdentity } from "./runtime/runtime";
import {
  findRuntime,
  listRuntimes,
  markRuntimeActive,
  markRuntimeStale,
  recordRuntime,
} from "./runtimes";
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
   * Explicit generation. Relay-spawned sessions pass the generation from the
   * bootstrap marker (authoritative, must match the relay-owned runtime row).
   * Manual attaches omit it and get a fresh bumped generation.
   */
  generation?: number;
  /**
   * Per-spawn secret from the bootstrap marker. Required for relay-spawned
   * attaches once the runtime recorded a token; without it a stale/foreign
   * plugin (or another project's session on a shared server) cannot bind.
   */
  attachToken?: string;
  /**
   * Resolved Herdr identity for a MANUAL attach. Required whenever `generation`
   * is absent: Relay refuses to manage an OpenCode session it cannot prove is
   * running inside a Herdr agent (no half-managed state is ever created).
   */
  identity?: HerdrIdentity;
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
 * Attach a live OpenCode session to relay management. Atomic: all validation
 * happens before any write, so a rejected attach leaves no half-managed state.
 *
 * - Relay-spawned (`opts.generation` set): the matching relay-owned runtime row
 *   must exist and be starting/active; the per-spawn token must match.
 * - Manual (`opts.identity` required): registers the EXISTING Herdr runtime as
 *   active with relay_owned=false. Relay never restarts or closes it.
 *
 * Returns the session row + bound worker id.
 */
export function attachSession(db: Database, sessionId: string, opts: AttachOptions = {}): Session {
  const t = now();
  const prev = getSession(db, sessionId);
  const role = opts.role ?? prev?.role ?? "worker";
  const workerId = opts.workerId ?? prev?.worker_id ?? slugSession(sessionId);
  const spawned = opts.generation !== undefined;

  // A managed session belongs to exactly one worker. Refuse a cross-worker
  // steal (e.g. a stale plugin on a shared server claiming another session).
  if (prev && prev.managed === 1 && prev.worker_id && prev.worker_id !== workerId) {
    throw new Error(`attach rejected: ${sessionId} is already managed by ${prev.worker_id}`);
  }

  const runtimeRow = spawned ? findRuntime(db, workerId, opts.generation!) : null;
  if (spawned) {
    if (!runtimeRow) {
      throw new Error(`attach rejected: no runtime row for ${workerId} g${opts.generation}`);
    }
    if (runtimeRow.relay_owned !== 1) {
      throw new Error(`attach rejected: runtime ${workerId} g${opts.generation} is not relay-owned`);
    }
    if (runtimeRow.state !== "starting" && runtimeRow.state !== "active") {
      throw new Error(`attach rejected: runtime ${workerId} g${opts.generation} is ${runtimeRow.state}`);
    }
    if (runtimeRow.attach_token && opts.attachToken !== runtimeRow.attach_token) {
      throw new Error(`attach rejected: bad token for ${workerId} g${opts.generation}`);
    }
  } else if (!opts.identity?.agent) {
    throw new Error("attach failed: session is not running inside Herdr");
  }

  const generation = spawned ? opts.generation! : (prev?.generation ?? 0) + 1;
  const worker = getWorker(db, workerId) ?? registerWorker(db, workerId, { role, sessionId });

  // Supersede the worker's previous session: events from the old generation's
  // session must no longer drive this worker (zombie protection on the way in).
  const prevBound = worker.opencode_session_id;
  if (prevBound && prevBound !== sessionId) {
    db.query(`UPDATE sessions SET managed = 0, detached_at = ?, updated_at = ? WHERE session_id = ? AND worker_id = ?`).run(
      t,
      t,
      prevBound,
      worker.id
    );
  }

  const runtimeId = spawned ? (runtimeRow!.runtime_id ?? worker.runtime_id) : opts.identity!.agent;
  db.query(
    `UPDATE workers
       SET opencode_session_id = ?, role = COALESCE(?, role), runtime_id = COALESCE(?, runtime_id),
           state = 'idle', generation = ?, nudged_at = NULL, updated_at = ?
     WHERE id = ?`
  ).run(sessionId, opts.role ?? null, runtimeId ?? null, generation, t, worker.id);

  if (spawned) {
    // Promote the matching freshly spawned runtime row.
    markRuntimeActive(db, runtimeRow!.id, sessionId, t);
  } else {
    // Adopt the EXISTING Herdr runtime: active, relay_owned=false, never closed.
    // Any relay-owned active row for this worker is retired first.
    for (const active of listRuntimes(db, { workerId: worker.id, state: "active" })) {
      markRuntimeStale(db, active.id, t);
    }
    recordRuntime(db, {
      workerId: worker.id,
      generation,
      runtimeId: opts.identity!.agent,
      tabId: opts.identity!.tabId,
      paneId: opts.identity!.paneId,
      workspaceId: opts.identity!.workspaceId,
      sessionId,
      relayOwned: 0,
      state: "active",
    });
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
    payload: { sessionId, generation, role, spawned },
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

/**
 * Strict worker/session fencing for inbound managed events. Returns the worker
 * id only when ALL bindings agree:
 *   session.worker_id == worker.id
 *   session.generation == worker.generation
 *   session.session_id == worker.opencode_session_id
 * Otherwise the event is ignored (a stale/old session can never affect the
 * current worker).
 */
export function managedWorkerForSession(db: Database, session: Session): string | null {
  if (!session.worker_id) return null;
  const w = getWorker(db, session.worker_id);
  if (!w) return null;
  if (w.opencode_session_id !== session.session_id) return null;
  if (w.generation !== session.generation) return null;
  return w.id;
}
