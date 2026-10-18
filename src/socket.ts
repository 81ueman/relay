import type { Database } from "bun:sqlite";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { defaultSockPath } from "./db";
import { logEvent } from "./events";
import { resolveKind } from "./harness";
import { handleErrorSignal, handleIdleSignal, reconcile } from "./reconciler";
import { providerDepsFromEnv } from "./provider-adapters";
import type { HerdrIdentity, Runtime } from "./runtime/runtime";
import { contextLimitTokens } from "./scheduler";
import { attachSession, detachSession, gateEvent, getSession, managedWorkerForSession, releaseUnhostedBinding } from "./sessions";
import type { DaemonIdentity } from "./singleton";
import { reviveWorkerRestoringTasks } from "./tasks";
import { recordSessionCompaction, recordSessionUsage, type CompactionStatus, type UsageReading } from "./usage";
import { getWorker, setWorkerState, setWorkerTool, clearWorkerTool, setWorkerContext, touchSeen } from "./workers";

// JSON Lines over a Unix domain socket. Small protocol:
//   {"type":"session.idle","session_id":"ses_xxx","generation":2}
//     (also accepted raw as session.execution.succeeded / .interrupted)
//   {"type":"session.error",...,"payload":{...}}
//   {"type":"permission.asked" | "permission.replied" | "tool.started" | "tool.execute.after" | "session.status" | ..., ...}
//   {"type":"session.context","session_id":...,"payload":{"used_tokens":N,"model":"..."}}
//     (context-window telemetry: `input + cache.read` of the latest assistant
//      message; drives the cooperative-handoff rotation policy)
//   {"type":"session.usage","session_id":...,"payload":{"cost":N,"input":N,"output":N,
//     "reasoning":N,"cache_read":N,"cache_write":N}}
//     (CUMULATIVE session cost/tokens; the daemon diffs it against the session
//      cursor and records the delta attributed to the worker's current task)
//   {"type":"session.compaction","session_id":...,"payload":{"status":"started|ended|failed|completed","reason":"..."}}
//     (compaction observability; session_v2.time_compacting is always NULL)
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
  /**
   * Agent harness kind (`opencode|codex|claude`). OpenCode (`ses...`) sessions
   * are recognized by shape and need no declaration; a bare UUID is ambiguous
   * (codex vs claude) and MUST pass `kind` so the `ses...` guard is not weakened.
   */
  kind?: string;
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
  /**
   * Daemon identity (pid / DB path / runtime). Echoed by `ping` so a starting
   * daemon can prove whether a live socket belongs to the SAME control-plane DB
   * before it ever considers the socket stale (single-supervisor guard).
   */
  identity?: DaemonIdentity;
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
// In-flight tool early detection. `tool.started` marks the command a worker is
// executing RIGHT NOW; `tool.execute.after` clears the marker. An absent
// `tool.execute.after` is exactly what a hang looks like, so the finish side is
// best-effort and the reconciler also sweeps stale markers.
const TOOL_STARTED = "tool.started";
const TOOL_AFTER = "tool.execute.after";

function numOrZero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Parse a cumulative `session.usage` payload. Returns null when nothing
 * measurable arrived (a defensive parse of host data — never a crash).
 */
function usageReadingFromPayload(payload: unknown): UsageReading | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const reading: UsageReading = {
    cost: numOrZero(p.cost),
    input: numOrZero(p.input),
    output: numOrZero(p.output),
    reasoning: numOrZero(p.reasoning),
    cacheRead: numOrZero(p.cache_read),
    cacheWrite: numOrZero(p.cache_write),
  };
  const any =
    reading.cost > 0 ||
    reading.input > 0 ||
    reading.output > 0 ||
    reading.reasoning > 0 ||
    reading.cacheRead > 0 ||
    reading.cacheWrite > 0;
  return any ? reading : null;
}

function compactionStatusOf(v: unknown): CompactionStatus | null {
  return v === "started" || v === "ended" || v === "failed" || v === "completed" ? v : null;
}

export async function handleSocketMessage(msg: SocketMessage, ctx: SocketContext): Promise<Record<string, unknown>> {
  const { db, runtime } = ctx;
  const type = msg.type;

  if (type === "ping") {
    return { ok: true, pong: true, ...(ctx.identity ? { identity: ctx.identity } : {}) };
  }

  if (type === "session.attach") {
    if (!msg.session_id) return { ok: false, reason: "no-session" };
    // Defense in depth: only a session id its harness could have minted is
    // accepted. OpenCode (`ses...`) is recognized by shape; a bare UUID is
    // ambiguous (codex vs claude) and is accepted ONLY when the client declares
    // `kind` — the opencode guard is never weakened (an undeclared non-`ses` id
    // is refused). See `src/harness.ts`.
    const kind = resolveKind(msg.session_id, msg.kind);
    if (!kind) return { ok: false, reason: "not-a-session-id" };

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
            agentKind: kind,
          },
        });
      } catch (e) {
        const reason = String(e).slice(0, 200);
        // Manual attach verification failed. Log it: the client gets the reason,
        // but without a server event an operator can never see WHY a worker
        // ended up unattached (and possibly working anyway).
        logEvent(db, {
          source: "opencode",
          workerId: msg.worker_id,
          type: "session.attach_failed",
          payload: { sessionId: msg.session_id, stage: "identity", directory: msg.directory ?? null, reason },
        });
        return { ok: false, reason };
      }

      // The session id is the durable identity, but a worker's binding recorded
      // before an OpenCode/Herdr restart can point at a session Herdr no longer
      // hosts. Correct it (release the dead binding) so the live session can
      // re-bind, instead of failing with "already managed by <dead session>".
      // A binding whose session is still live is left untouched for
      // attachSession's steal guard to reject.
      const targetWorker = msg.worker_id ?? getSession(db, msg.session_id)?.worker_id;
      if (targetWorker) {
        try {
          releaseUnhostedBinding(db, targetWorker, msg.session_id, await runtime.reportedSessions());
        } catch (e) {
          return { ok: false, reason: String(e).slice(0, 200) };
        }
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
        agentKind: kind,
        identity,
      });
    } catch (e) {
      const reason = String(e).slice(0, 200);
      logEvent(db, {
        source: "opencode",
        workerId: msg.worker_id,
        type: "session.attach_failed",
        payload: { sessionId: msg.session_id, stage: "attach", reason },
      });
      return { ok: false, reason };
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

  // T393: a managed event PROVES the session is live. If a failed liveness probe
  // left this worker `dead`/`stalled`, revive it BEFORE handling the event: a
  // dead-marked-but-live session would otherwise keep running unsupervised and
  // the supervisor could spawn a duplicate generation for the same worker.
  // T523: also re-adopt the running tasks a transient dead window released.
  reviveWorkerRestoringTasks(db, workerId);

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
    const { actions } = await reconcile(db, runtime, undefined, providerDepsFromEnv()).catch((e) => ({ actions: [`error:${String(e).slice(0, 100)}`] }));
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

  // In-flight tool telemetry. `tool.started` records the running command; the
  // matching `tool.execute.after` clears it. Neither is a state transition:
  // task semantics stay explicit (`relay submit` / `relay block`).
  if (type === TOOL_STARTED) {
    touchSeen(db, workerId);
    const p = (msg.payload ?? {}) as { tool?: unknown; command?: unknown; timeout_ms?: unknown };
    const tool = typeof p.tool === "string" ? p.tool : "";
    if (tool) {
      setWorkerTool(db, workerId, {
        name: tool,
        command: typeof p.command === "string" ? p.command : null,
        timeoutMs: typeof p.timeout_ms === "number" && p.timeout_ms > 0 ? p.timeout_ms : null,
      });
    }
    logEvent(db, { source: "opencode", workerId, type, payload: msg.payload ?? {} });
    return { ok: true };
  }

  if (type === TOOL_AFTER) {
    clearWorkerTool(db, workerId);
    touchSeen(db, workerId);
    logEvent(db, { source: "opencode", workerId, type, payload: msg.payload ?? {} });
    return { ok: true };
  }

  // Context-window telemetry from the plugin. Like the tool marker it is
  // TELEMETRY: no state change, no `touchSeen`. The reconciler's
  // cooperative-handoff policy reads the persisted metric on a later pass. A
  // non-positive/non-finite value is ignored (a defensive parse of host data,
  // never a crash).
  //
  // `used_tokens` is current context OCCUPANCY (an assistant message's
  // `input + cache.read`) and is the ONLY value allowed to drive rotation.
  // `cumulative_tokens` is session-lifetime telemetry from `session.updated`:
  // it is logged but NEVER written to `context_used_tokens` — reading a
  // cumulative total as occupancy is what latched the high-context guard on a
  // single reading (T551). A payload carrying only the cumulative is accepted
  // and recorded as telemetry, not rejected.
  if (type === "session.context") {
    const p = (msg.payload ?? {}) as {
      used_tokens?: unknown;
      cumulative_tokens?: unknown;
      model?: unknown;
    };
    const model = typeof p.model === "string" && p.model ? p.model : undefined;
    const cumulative =
      typeof p.cumulative_tokens === "number" &&
      Number.isFinite(p.cumulative_tokens) &&
      p.cumulative_tokens > 0
        ? p.cumulative_tokens
        : null;
    const used =
      typeof p.used_tokens === "number" && Number.isFinite(p.used_tokens) && p.used_tokens > 0
        ? p.used_tokens
        : null;
    // Defence in depth for sessions still running an OLD plugin that forwards a
    // Session's cumulative as `used_tokens`: an occupancy above the model limit
    // is impossible, so it must never reach the rotation guard.
    if (used !== null && used > contextLimitTokens()) {
      return { ok: true, ignored: "context-over-limit" };
    }
    if (used === null) {
      if (cumulative !== null) {
        logEvent(db, {
          source: "opencode",
          workerId,
          type,
          payload: { cumulative_tokens: cumulative, model: model ?? null },
        });
        return { ok: true, ignored: "cumulative-only" };
      }
      return { ok: true, ignored: "bad-context" };
    }
    logEvent(db, {
      source: "opencode",
      workerId,
      type,
      payload: { used_tokens: used, cumulative_tokens: cumulative, model: model ?? null },
    });
    setWorkerContext(db, workerId, used);
    return { ok: true };
  }

  // Cost/token observability (T551 #8). The plugin forwards a session's
  // session-lifetime CUMULATIVE cost/tokens (`session.usage`); the daemon diffs
  // it against the per-session cursor and records the delta attributed to the
  // worker's CURRENT task. TELEMETRY: no state change, no `touchSeen`.
  if (type === "session.usage") {
    const reading = usageReadingFromPayload(msg.payload);
    if (!reading) return { ok: true, ignored: "bad-usage" };
    const w = getWorker(db, workerId);
    const sample = recordSessionUsage(db, {
      sessionId: session.session_id,
      workerId,
      taskId: w?.current_task_id ?? null,
      generation: session.generation,
      reading,
    });
    return { ok: true, ...(sample ? { recorded: true } : { ignored: "baseline-or-empty" }) };
  }

  // Compaction observability: `session_v2.time_compacting` is always NULL, so
  // the count is reconstructed from these events (see usage.ts). Every status
  // is logged; the counter increments exactly once per compaction.
  if (type === "session.compaction") {
    const p = (msg.payload ?? {}) as { status?: unknown; reason?: unknown };
    const status = compactionStatusOf(p.status);
    if (!status) return { ok: true, ignored: "bad-compaction" };
    const reason = typeof p.reason === "string" ? p.reason : null;
    const { counted } = recordSessionCompaction(db, { sessionId: session.session_id, status, reason });
    return { ok: true, counted };
  }

  // Liveness only. Explicit `relay note` remains the strongest progress signal.
  touchSeen(db, workerId);
  logEvent(db, { source: "opencode", workerId, type, payload: msg.payload ?? {} });
  return { ok: true };
}

export interface SocketHandle {
  path: string;
  stop(): void;
}

/**
 * Bind the relay unix socket.
 *
 * Ownership is decided by the CALLER before this is called (the daemon runs the
 * `assertSocketFree` probe/lock guard, `src/singleton.ts`). This function NEVER
 * unlinks a pre-existing path — an unconditional unlink is exactly what let a
 * second daemon steal a live daemon's socket. A bind failure propagates: in
 * production the daemon must fail startup rather than run socket-less and
 * reconcile the same DB as a second supervisor.
 *
 * `stop()` removes the path ONLY if it is still the exact socket this call
 * bound (inode check), so a late shutdown never deletes a newer daemon's socket.
 */
export function startSocketServer(ctx: SocketContext, sockPath?: string): SocketHandle {
  const path = sockPath ?? defaultSockPath();
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
  let ino: number | bigint | null = null;
  try { ino = statSync(path).ino; } catch { ino = null; }
  let stopped = false;
  return {
    path,
    stop() {
      if (stopped) return;
      stopped = true;
      try { server.stop(); } catch { /* ignore */ }
      // Remove the socket file only while it is provably the one we bound.
      try {
        if (ino !== null && existsSync(path) && statSync(path).ino === ino) unlinkSync(path);
      } catch { /* ignore */ }
    },
  };
}
