import type { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { defaultSockPath } from "./db";
import { logEvent } from "./events";
import { handleErrorSignal, handleIdleSignal, reconcile } from "./reconciler";
import type { HerdrIdentity, Runtime } from "./runtime/runtime";
import { attachSession, detachSession, gateEvent, managedWorkerForSession } from "./sessions";
import { getWorker, setWorkerState, touchSeen } from "./workers";

// JSON Lines over a Unix domain socket. Small protocol:
//   {"type":"session.idle","session_id":"ses_xxx","generation":2}
//     (also accepted raw as session.execution.succeeded / .interrupted)
//   {"type":"session.error",...,"payload":{...}}
//   {"type":"permission.asked" | "permission.replied" | "tool.execute.after" | "session.status" | ..., ...}
//   {"type":"session.attach","session_id":...,"role":...,"worker_id":...,"generation":N,...}
//     (generation present = relay-spawned session; absent = manual attach, then
//      the daemon resolves the Herdr identity from the session `directory`
//      and/or pane_id/tab_id/workspace_id hints; unverifiable => rejected,
//      never guessed)
//   {"type":"session.detach","session_id":...}
//   {"type":"ping"}
// Response per line: {"ok":true,...} or {"ok":false,"reason":...}
// Unmanaged / stale-generation events are ignored WITHOUT any DB write.

export interface SocketMessage {
  type: string;
  session_id?: string;
  generation?: number;
  payload?: unknown;
  role?: string;
  worker_id?: string;
  directory?: string;
  worktree?: string;
  /** Per-spawn attach secret (relay-spawned generations only). */
  token?: string;
  /** Herdr identity hints (manual attach): directory is authoritative when no pane is given. */
  pane_id?: string;
  tab_id?: string;
  workspace_id?: string;
}

export interface SocketContext {
  db: Database;
  runtime: Runtime;
  /** Set when the daemon should reconcile immediately. */
  wakeReconcile: { value: boolean };
}

// `session.idle` is the stable protocol type; the OpenCode plugin normalizes
// OpenCode 2's `session.execution.succeeded` / `.interrupted` onto it. Accept
// the raw execution variants too, so a raw client can never silently lose the
// turn-complete trigger.
const IDLE_TYPES = new Set([
  "session.idle",
  "session.execution.succeeded",
  "session.execution.interrupted",
]);
const ERROR_TYPES = new Set(["session.error", "session.execution.failed"]);
// The plugin normalizes permission/form replies into `permission.replied`; accept
// the raw OpenCode forms too in one place. A reply NEVER means the task is done —
// task semantics stay explicit (`relay submit` / `relay block`).
const PERMISSION_ASKED = new Set(["permission.asked", "form.created"]);
const PERMISSION_REPLIED = new Set(["permission.replied", "form.replied", "form.cancelled"]);

export async function handleSocketMessage(msg: SocketMessage, ctx: SocketContext): Promise<Record<string, unknown>> {
  const { db, runtime } = ctx;
  const type = msg.type;

  if (type === "ping") return { ok: true, pong: true };

  if (type === "session.attach") {
    if (!msg.session_id) return { ok: false, reason: "no-session" };
    // Defense in depth: a session id must look like an OpenCode session
    // (`ses...`). Shell/command ids (`sh_...`) and other host ids must never
    // become managed sessions, whatever a plugin version sends.
    if (!/^ses/.test(msg.session_id)) return { ok: false, reason: "not-a-session-id" };

    // Manual attach (no generation): the session must PROVABLY be running inside
    // a Herdr agent. Resolve + verify BEFORE any DB write so a rejected attach
    // leaves zero half-managed state.
    let identity: HerdrIdentity | undefined;
    if (typeof msg.generation !== "number") {
      try {
        identity = await runtime.resolveIdentity({
          sessionId: msg.session_id,
          hint: {
            paneId: msg.pane_id,
            tabId: msg.tab_id,
            workspaceId: msg.workspace_id,
            directory: msg.directory,
          },
        });
      } catch (e) {
        return { ok: false, reason: String(e).slice(0, 200) };
      }
    }

    let s;
    try {
      s = attachSession(db, msg.session_id, {
        role: msg.role,
        workerId: msg.worker_id,
        directory: msg.directory,
        worktree: msg.worktree,
        // Relay-spawned sessions send the authoritative generation; manual
        // attaches omit it and get a bumped one plus the resolved identity.
        generation: typeof msg.generation === "number" ? msg.generation : undefined,
        attachToken: msg.token,
        identity,
      });
    } catch (e) {
      return { ok: false, reason: String(e).slice(0, 200) };
    }
    ctx.wakeReconcile.value = true;
    return { ok: true, worker_id: s.worker_id, generation: s.generation, managed: true };
  }

  if (type === "session.detach") {
    if (!msg.session_id) return { ok: false, reason: "no-session" };
    try {
      const s = detachSession(db, msg.session_id);
      return { ok: true, managed: s ? s.managed === 1 : false };
    } catch (e) {
      return { ok: false, reason: String(e).slice(0, 200) };
    }
  }

  // All other events are gated on managed sessions first (no writes when ignored).
  const gate = gateEvent(db, msg.session_id, msg.generation);
  if (!gate.ok) return { ok: true, ignored: gate.reason };
  const session = gate.session;
  // Strict fencing: the session, its generation and the worker binding must all
  // agree, or the event belongs to a superseded/foreign session.
  const workerId = managedWorkerForSession(db, session);
  if (!workerId) return { ok: true, ignored: "fenced-out" };

  if (IDLE_TYPES.has(type)) {
    const outcome = await handleIdleSignal(db, runtime, workerId);
    ctx.wakeReconcile.value = true;
    return { ok: true, outcome };
  }

  if (ERROR_TYPES.has(type)) {
    const err = typeof msg.payload === "string" ? msg.payload : JSON.stringify(msg.payload ?? {});
    const outcome = handleErrorSignal(db, workerId, err.slice(0, 500));
    ctx.wakeReconcile.value = true; // suspect/dead candidate: reconcile now
    // Run one immediate pass so crash recovery doesn't wait for the tick.
    const { actions } = await reconcile(db, runtime).catch((e) => ({ actions: [`error:${String(e).slice(0, 100)}`] }));
    void outcome;
    return { ok: true, reconciled: actions };
  }

  if (PERMISSION_ASKED.has(type)) {
    touchSeen(db, workerId);
    const w = getWorker(db, workerId)!;
    if (w.state === "working") setWorkerState(db, workerId, "waiting_input");
    logEvent(db, { source: "opencode", workerId, type, payload: msg.payload ?? {} });
    return { ok: true };
  }

  if (PERMISSION_REPLIED.has(type)) {
    touchSeen(db, workerId);
    const w = getWorker(db, workerId)!;
    // The reply restores the state the permission interrupted. Never infer task
    // completion from a form cancellation.
    if (w.state === "waiting_input" || w.state === "working") {
      setWorkerState(db, workerId, w.current_task_id ? "working" : "idle");
    }
    logEvent(db, { source: "opencode", workerId, type, payload: msg.payload ?? {} });
    return { ok: true };
  }

  // Liveness only. Explicit `relay note` remains the strongest progress signal.
  touchSeen(db, workerId);
  logEvent(db, { source: "opencode", workerId, type, payload: msg.payload ?? {} });
  return { ok: true };
}

export function startSocketServer(ctx: SocketContext, sockPath?: string): { stop: () => void; path: string } {
  const path = sockPath ?? defaultSockPath();
  try { unlinkSync(path); } catch { /* stale socket */ }
  const server = Bun.listen({
    unix: path,
    socket: {
      data(socket, data) {
        const sock = socket as unknown as { __buf?: string };
        sock.__buf = (sock.__buf ?? "") + data.toString();
        let idx: number;
        while ((idx = sock.__buf.indexOf("\n")) >= 0) {
          const line = sock.__buf.slice(0, idx).trim();
          sock.__buf = sock.__buf.slice(idx + 1);
          if (!line) continue;
          void (async () => {
            try {
              const msg = JSON.parse(line) as SocketMessage;
              const res = await handleSocketMessage(msg, ctx);
              socket.write(JSON.stringify(res) + "\n");
            } catch (e) {
              try { socket.write(JSON.stringify({ ok: false, reason: String(e).slice(0, 200) }) + "\n"); } catch { /* closed */ }
            }
          })();
        }
      },
      error() { /* best effort; ignore */ },
    },
  });
  return { stop: () => server.stop(), path };
}
