import type { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { defaultSockPath } from "./db";
import { logEvent } from "./events";
import { handleErrorSignal, handleIdleSignal, reconcile } from "./reconciler";
import type { Runtime } from "./runtime/runtime";
import { attachSession, detachSession, gateEvent, workerForSession } from "./sessions";
import { getWorker, setWorkerState, touchSeen } from "./workers";

// JSON Lines over a Unix domain socket. Small protocol:
//   {"type":"session.idle","session_id":"ses_xxx","generation":2}
//   {"type":"session.error",...,"payload":{...}}
//   {"type":"permission.asked" | "permission.replied" | "tool.execute.after" | "session.status" | ..., ...}
//   {"type":"session.attach","session_id":...,"role":...,"worker_id":...,"directory":...,"worktree":...}
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
}

export interface SocketContext {
  db: Database;
  runtime: Runtime;
  /** Set when the daemon should reconcile immediately. */
  wakeReconcile: { value: boolean };
}

const IDLE_TYPES = new Set(["session.idle"]);
const ERROR_TYPES = new Set(["session.error", "session.execution.failed"]);

export async function handleSocketMessage(msg: SocketMessage, ctx: SocketContext): Promise<Record<string, unknown>> {
  const { db, runtime } = ctx;
  const type = msg.type;

  if (type === "ping") return { ok: true, pong: true };

  if (type === "session.attach") {
    if (!msg.session_id) return { ok: false, reason: "no-session" };
    const s = attachSession(db, msg.session_id, {
      role: msg.role, workerId: msg.worker_id, directory: msg.directory, worktree: msg.worktree,
    });
    ctx.wakeReconcile.value = true;
    return { ok: true, worker_id: s.worker_id, generation: s.generation };
  }

  if (type === "session.detach") {
    if (!msg.session_id) return { ok: false, reason: "no-session" };
    const s = detachSession(db, msg.session_id);
    return { ok: true, managed: s ? s.managed === 1 : false };
  }

  // All other events are gated on managed sessions first (no writes when ignored).
  const gate = gateEvent(db, msg.session_id, msg.generation);
  if (!gate.ok) return { ok: true, ignored: gate.reason };
  const session = gate.session;
  const workerId = workerForSession(db, session);

  if (IDLE_TYPES.has(type)) {
    if (!workerId) return { ok: true, ignored: "no-worker" };
    const outcome = await handleIdleSignal(db, runtime, workerId);
    ctx.wakeReconcile.value = true;
    return { ok: true, outcome };
  }

  if (ERROR_TYPES.has(type)) {
    if (!workerId) return { ok: true, ignored: "no-worker" };
    const err = typeof msg.payload === "string" ? msg.payload : JSON.stringify(msg.payload ?? {});
    const outcome = handleErrorSignal(db, workerId, err.slice(0, 500));
    ctx.wakeReconcile.value = true; // suspect/dead candidate: reconcile now
    // Run one immediate pass so crash recovery doesn't wait for the tick.
    const { actions } = await reconcile(db, runtime).catch((e) => ({ actions: [`error:${String(e).slice(0, 100)}`] }));
    void outcome;
    return { ok: true, reconciled: actions };
  }

  if (type === "permission.asked") {
    if (workerId) {
      touchSeen(db, workerId);
      const w = getWorker(db, workerId)!;
      if (w.state === "working") setWorkerState(db, workerId, "waiting_input");
      logEvent(db, { source: "opencode", workerId, type, payload: msg.payload ?? {} });
    }
    return { ok: true };
  }

  // Liveness only. Explicit `agentctl note` remains the strongest progress signal.
  if (workerId) {
    touchSeen(db, workerId);
    logEvent(db, { source: "opencode", workerId, type, payload: msg.payload ?? {} });
  }
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
