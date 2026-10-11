// relay <-> DeepSeek Harness (dsh) bridge — pure core.
//
// Everything here is transport/shaping with NO dsh or cordis imports, so it is
// unit-testable and reviewable on its own. lib/index.js is the thin dsh glue
// that calls into it.
//
// Protocol: relay's daemon speaks JSON Lines over a unix domain socket
// (src/socket.ts). Each request gets exactly one response line. The bridge
// forwards session events (fire-and-forget) and long-polls for a queued nudge
// (`worker.wake.await`) that a plugin-woken harness pulls instead of receiving a
// Herdr-pane keystroke.

import { existsSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve as resolvePath } from "node:path";

/**
 * Resolve the relay unix socket for a session's working directory. Mirrors
 * relay's own `defaultSockPath` (src/db.ts): `RELAY_SOCK` wins, else walk up to
 * the nearest `.relay`/`.git` marker and use `<root>/.relay/relay.sock`.
 */
export function resolveRelaySocket(cwd, env = process.env) {
  if (env && env.RELAY_SOCK) return resolvePath(env.RELAY_SOCK);
  let cur = resolvePath(cwd || process.cwd());
  for (let i = 0; i < 256; i++) {
    if (existsSync(join(cur, ".git")) || existsSync(join(cur, ".relay"))) {
      return join(cur, ".relay", "relay.sock");
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return join(resolvePath(cwd || process.cwd()), ".relay", "relay.sock");
}

const DSH_SESSION_RE =
  /^(?:[a-z0-9_-]+-)?session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a dsh session id (`session-<uuid>`, optionally prefixed). */
export function isDshSessionId(id) {
  return DSH_SESSION_RE.test(String(id ?? ""));
}

/**
 * Map one dsh `session/event` (the append-only session log feed) to a relay
 * message, or null when relay does not track it.
 *
 * Only the in-flight tool marker is forwarded: `tool/call` -> `tool.started`
 * (relay records the running command) and `tool/result` -> `tool.execute.after`
 * (relay clears it). This is what lets relay tell "long tool" from "hung".
 * Turn/idle is driven by the agent status feed, not the log.
 */
export function relayEventForSessionEvent(event) {
  const type = event && event.type;
  if (type === "tool/call") {
    return {
      type: "tool.started",
      payload: { tool: String(event.name ?? "tool"), call_id: String(event.callId ?? "") },
    };
  }
  if (type === "tool/result") {
    return {
      type: "tool.execute.after",
      payload: { call_id: String((event.message && event.message.id) ?? ""), is_error: !!(event && event.error) },
    };
  }
  return null;
}

/**
 * Map a dsh `agent/status` transition to a relay message.
 *   idle    -> session.idle   (the turn closed; relay's deterministic supervisor
 *                              decides what happens next — never "task done")
 *   running -> session.status (a turn is executing; liveness only)
 */
export function relayEventForAgentStatus(status) {
  if (status === "idle") return { type: "session.idle" };
  if (status === "running") return { type: "session.status", payload: { status: "working" } };
  return null;
}

/**
 * A JSON-Lines request/response client for one relay socket. A fresh connection
 * per request keeps it stateless and matches relay's one-response-per-line
 * server. Resolves null (never throws) on timeout/transport error.
 */
export function relayRequest(sockPath, msg, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    let buf = "";
    let sock;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      try {
        if (sock) sock.destroy();
      } catch {
        /* already closed */
      }
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), Math.max(1, timeoutMs));
    try {
      sock = net.connect({ path: sockPath });
    } catch {
      clearTimeout(timer);
      finish(null);
      return;
    }
    sock.on("connect", () => {
      try {
        sock.write(JSON.stringify(msg) + "\n");
      } catch {
        clearTimeout(timer);
        finish(null);
      }
    });
    sock.on("data", (d) => {
      buf += d.toString();
      const i = buf.indexOf("\n");
      if (i >= 0) {
        clearTimeout(timer);
        try {
          finish(JSON.parse(buf.slice(0, i)));
        } catch {
          finish(null);
        }
      }
    });
    sock.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    sock.on("close", () => {
      clearTimeout(timer);
      finish(null);
    });
  });
}

/** Convenience wrapper: one client bound to one socket path. */
export class RelayClient {
  constructor(sockPath, { timeoutMs = 8000 } = {}) {
    this.sockPath = sockPath;
    this.timeoutMs = timeoutMs;
  }

  /** Fire-and-forget event forward. Returns true when relay acked. */
  async notify(msg) {
    const res = await relayRequest(this.sockPath, msg, this.timeoutMs);
    return !!(res && res.ok);
  }

  /**
   * Long-poll for the next queued nudge for this session. Returns the wake
   * object `{reason,text,created_at}` or null on timeout. The client timeout
   * exceeds the server window so a slow poll is never mistaken for a dead one.
   */
  async awaitWake(sessionId, { waitMs = 25000 } = {}) {
    const res = await relayRequest(
      this.sockPath,
      { type: "worker.wake.await", session_id: sessionId, wait_ms: waitMs },
      waitMs + 8000
    );
    return res && res.ok ? (res.wake ?? null) : null;
  }
}
