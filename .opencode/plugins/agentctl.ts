// agentctl OpenCode plugin (relay).
//
// Transport: Unix domain socket to the relay daemon — NEVER a subprocess per
// event (tool.execute.after is high-frequency). Protocol is JSON Lines:
//
//   {"type":"session.idle","session_id":"ses_xxx","generation":2} -> {"ok":true,...}
//
// Design rules:
// - session.idle is a TRIGGER, never task completion. The deterministic
//   supervisor (SQLite + real Herdr runtime) decides.
// - Plain `opencode` sessions are UNMANAGED by default: events are forwarded
//   cheaply but the daemon ignores them (no DB write, no Herdr call, no claim).
//   Use agent_attach (custom tool) or `agentctl session attach` to manage one.
// - All forwarding is best-effort and never throws into OpenCode.
// - Verified against the installed OpenCode v2 API shapes: the default
//   { id, setup } export (proven by the bundled herdr integration) and the
//   official Plugin function type (for custom tools). A module-level guard
//   ensures only one shape activates if a host loads both.

import net from "node:net";
import path from "node:path";

const PLUGIN_ID = "relay.agentctl";

let initialized = false;
// sessionID -> generation observed at attach (zombie protection on the way in).
const generationCache = new Map<string, number>();
// Sessions detached via the in-process tool: skip even the socket write for pings.
const detachedCache = new Set<string>();

// Relay-spawned sessions are launched with AGENTCTL_MANAGED=1 and an explicit
// worker + generation. A plain `opencode` launch has none of these and stays
// unmanaged.
const MANAGED = process.env.AGENTCTL_MANAGED === "1";
const ENV_WORKER = process.env.AGENTCTL_WORKER;
const ENV_GENERATION = (() => {
  const n = Number(process.env.AGENTCTL_GENERATION ?? "");
  return Number.isFinite(n) && n > 0 ? n : undefined;
})();
// Env-only auto attach is OFF by default. A single OpenCode server can host
// many sessions (`opencode serve --service`) and its process env names only one
// worker, so env cannot identify a session. It is opt-in for dedicated
// one-server-per-worker deployments.
const AUTO_ATTACH_FROM_ENV = process.env.AGENTCTL_AUTO_ATTACH === "1";
const autoAttached = new Set<string>();

// Herdr sets these on every pane process. For a manual attach the daemon
// verifies them against live Herdr state (never trusts them blindly): the pane
// must exist, run an opencode agent, and be consistent with the hint.
const HERDR_PANE_ID = process.env.HERDR_ENV === "1" ? process.env.HERDR_PANE_ID : undefined;
const HERDR_TAB_ID = process.env.HERDR_ENV === "1" ? process.env.HERDR_TAB_ID : undefined;
const HERDR_WORKSPACE_ID = process.env.HERDR_ENV === "1" ? process.env.HERDR_WORKSPACE_ID : undefined;

function herdrIdentityFields(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (HERDR_PANE_ID) out.pane_id = HERDR_PANE_ID;
  if (HERDR_TAB_ID) out.tab_id = HERDR_TAB_ID;
  if (HERDR_WORKSPACE_ID) out.workspace_id = HERDR_WORKSPACE_ID;
  return out;
}

// Per-spawn marker carried in the relay bootstrap prompt. It travels with the
// session's own prompt text, so this plugin can bind the RIGHT session to the
// intended worker/generation even when many sessions share one server (whose
// process env identifies nobody).
const ATTACH_MARKER = /RELAY-ATTACH\s+worker=([A-Za-z0-9._-]+)\s+gen=(\d+)(?:\s+token=([A-Za-z0-9._-]+))?/;
// Only these carry prompt text; scanning the high-frequency stream for a marker
// would be pointless (and there is nothing to find once attached).
const ATTACH_HINT_TYPES = new Set([
  "session.inbox.enqueued",
  "session.renamed",
  "session.created",
  "session.idle",
  "session.status",
  "session.viewed",
]);

function sockPath(explicitDir?: string): string {
  if (process.env.AGENTCTL_SOCK) return process.env.AGENTCTL_SOCK;
  const dir = explicitDir ?? process.cwd();
  return path.join(dir, ".agentctl", "relay.sock");
}

/** Fire-and-forget event forward. Never throws, never blocks the session. */
function sendEvent(msg: Record<string, unknown>, explicitDir?: string): void {
  const line = JSON.stringify(msg) + "\n";
  try {
    const sock = net.createConnection(sockPath(explicitDir));
    const done = () => {
      try { sock.destroy(); } catch { /* ignore */ }
    };
    sock.setTimeout(500, done);
    sock.on("error", done);
    sock.on("connect", () => {
      try {
        sock.write(line, () => done());
      } catch {
        done();
      }
    });
  } catch {
    // Daemon down or socket missing: the plugin stays silent.
  }
}

/** Request/response for tools (attach/detach need the daemon's answer). */
function sendRequest(msg: Record<string, unknown>, explicitDir?: string, timeoutMs = 4000): Promise<any> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: any) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    let sock: net.Socket;
    try {
      sock = net.createConnection(sockPath(explicitDir));
    } catch {
      resolve({ ok: false, reason: "no-daemon" });
      return;
    }
    let buf = "";
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
    sock.on("error", () => {
      clearTimeout(timer);
      finish({ ok: false, reason: "no-daemon" });
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        clearTimeout(timer);
        try {
          finish(JSON.parse(buf.slice(0, idx)));
        } catch {
          finish({ ok: false, reason: "bad-response" });
        }
      }
    });
    sock.on("connect", () => {
      try {
        sock.write(JSON.stringify(msg) + "\n");
      } catch {
        clearTimeout(timer);
        finish({ ok: false, reason: "write-failed" });
      }
    });
  });
}

function generationFor(sessionID: string | undefined): number | undefined {
  // Cached generation wins (it is set by auto-attach from env, or by a manual
  // attach's response); otherwise fall back to the env generation.
  if (sessionID) {
    const cached = generationCache.get(sessionID);
    if (cached !== undefined) return cached;
  }
  return ENV_GENERATION;
}

function withGeneration(sessionID: string | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...extra };
  if (sessionID) {
    out.session_id = sessionID;
    const g = generationFor(sessionID);
    if (g !== undefined) out.generation = g;
  }
  return out;
}

/**
 * Bind a session to a worker/generation and tell the daemon. Fire-and-forget:
 * the generation is cached locally so later events fence correctly.
 */
function autoAttach(
  sessionID: string,
  workerId: string | undefined,
  generation: number,
  directory?: string,
  token?: string
): void {
  if (autoAttached.has(sessionID)) return;
  autoAttached.add(sessionID);
  generationCache.set(sessionID, generation);
  sendEvent(
    {
      type: "session.attach",
      session_id: sessionID,
      worker_id: workerId,
      generation,
      token,
      role: "worker",
      directory,
      ...herdrIdentityFields(),
    },
    directory
  );
}

/** Per-session identity from the relay bootstrap prompt marker. */
function maybeAttachFromMarker(sessionID: string | undefined, data: any, directory?: string): void {
  if (!sessionID || autoAttached.has(sessionID) || !sessionID.startsWith("ses_")) return;
  let text = "";
  try {
    text = [data?.item?.payload?.text, data?.text, data?.title, data?.input?.prompt, data?.prompt]
      .filter((x) => typeof x === "string")
      .join("\n");
    if (!text) text = JSON.stringify(data ?? {});
  } catch {
    return;
  }
  const m = ATTACH_MARKER.exec(text);
  if (m) autoAttach(sessionID, m[1], Number(m[2]), directory, m[3]);
}

/** Opt-in env auto attach (only safe when one server serves exactly one worker). */
function maybeAttachFromEnv(sessionID: string | undefined, directory?: string): void {
  if (!AUTO_ATTACH_FROM_ENV || !MANAGED || !sessionID || !sessionID.startsWith("ses_")) return;
  if (ENV_GENERATION === undefined) return;
  autoAttach(sessionID, ENV_WORKER, ENV_GENERATION, directory);
}

function sessionIDOf(data: any): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const candidates = [data.sessionID, data.session?.id, data.info?.id, data.form?.sessionID];
  for (const c of candidates) {
    if (typeof c === "string" && c) return c;
  }
  return undefined;
}

function errorOf(data: any): string {
  try {
    const e = data?.error ?? data?.message ?? data;
    return typeof e === "string" ? e.slice(0, 500) : JSON.stringify(e).slice(0, 500);
  } catch {
    return "unknown error";
  }
}

const IDLE_TYPES = new Set(["session.idle"]);
const ERROR_TYPES = new Set(["session.error", "session.execution.failed"]);
const PERMISSION_ASKED = new Set(["permission.asked", "form.created"]);
const PERMISSION_REPLIED = new Set(["permission.replied", "form.replied", "form.cancelled"]);
const LIVENESS_TYPES = new Set(["session.status", "session.created", "session.viewed"]);
// tool.execute.after arrives via the tool hook (see setup); keep it out of the
// event-stream switch so the two paths stay explicit.
const TOOL_AFTER = "tool.execute.after";

function forwardEvent(type: string, sessionID: string | undefined, data: any, explicitDir?: string): void {
  // Attach THIS session only when the event proves its per-session identity:
  // either the relay bootstrap marker in its own prompt text, or (opt-in) env.
  if (ATTACH_HINT_TYPES.has(type)) maybeAttachFromMarker(sessionID, data, explicitDir);
  maybeAttachFromEnv(sessionID, explicitDir);
  if (IDLE_TYPES.has(type) || ERROR_TYPES.has(type)) {
    // Always forwarded; the daemon gates on managed + generation.
    const payload = ERROR_TYPES.has(type) ? { payload: { error: errorOf(data) } } : {};
    sendEvent({ type, ...withGeneration(sessionID, payload) }, explicitDir);
    return;
  }
  if (PERMISSION_ASKED.has(type)) {
    sendEvent({ type: "permission.asked", ...withGeneration(sessionID) }, explicitDir);
    return;
  }
  if (PERMISSION_REPLIED.has(type)) {
    sendEvent({ type: "permission.replied", ...withGeneration(sessionID) }, explicitDir);
    return;
  }
  if (LIVENESS_TYPES.has(type)) {
    sendEvent({ type, ...withGeneration(sessionID) }, explicitDir);
    return;
  }
  if (type === TOOL_AFTER) {
    // High-frequency path: skip the socket entirely for sessions we detached
    // in-process. Everything else is gated daemon-side (cheap local write).
    if (sessionID && detachedCache.has(sessionID)) return;
    sendEvent({ type: TOOL_AFTER, ...withGeneration(sessionID) }, explicitDir);
  }
}

async function handleStreamEvent(event: { type?: string; data?: any }, explicitDir?: string): Promise<void> {
  const type = typeof event?.type === "string" ? event.type : "unknown";
  forwardEvent(type, sessionIDOf(event?.data), event?.data, explicitDir);
}

// --- custom tools (official Plugin shape) ---------------------------------

async function buildTools(): Promise<Record<string, any>> {
  let tool: any;
  try {
    ({ tool } = await import("@opencode-ai/plugin"));
  } catch {
    return {}; // offline / no install: events still forward; attach via CLI.
  }
  return {
    agent_attach: tool({
      description:
        "Attach this OpenCode session to relay supervision as a managed worker. After attaching, session idle/error events drive the deterministic task supervisor (SQLite-backed). No process restart needed.",
      args: {
        role: tool.schema.string().optional().describe("worker (default), planner, reviewer, coordinator"),
        worker_id: tool.schema.string().optional().describe("Existing worker id to bind, else auto-derived"),
        generation: tool.schema.number().optional().describe("Relay generation to bind (relay-spawned sessions); omit for a manual attach"),
        token: tool.schema.string().optional().describe("Per-spawn attach token (relay-spawned sessions)"),
      },
      async execute(args: { role?: string; worker_id?: string; generation?: number; token?: string }, context: any): Promise<string> {
        const res = await sendRequest(
          {
            type: "session.attach",
            session_id: context.sessionID,
            role: args.role ?? "worker",
            worker_id: args.worker_id,
            generation: args.generation,
            token: args.token,
            directory: context.directory,
            worktree: context.worktree,
            ...herdrIdentityFields(),
          },
          context.directory
        );
        if (!res?.ok) {
          return `attach failed (${res?.reason ?? "unknown"}). Is the relay daemon running? Start it with \`agentctl daemon\` in the project root, then retry. Equivalent CLI: \`agentctl session attach --session ${context.sessionID}\`.`;
        }
        generationCache.set(context.sessionID, res.generation);
        detachedCache.delete(context.sessionID);
        return `attached as worker ${res.worker_id} (generation ${res.generation}). Load the agent-worker skill and run \`agentctl next\`.`;
      },
    }),
    agent_detach: tool({
      description:
        "Detach this OpenCode session from relay supervision. The session returns to a normal standalone session; its events are ignored afterwards.",
      args: {},
      async execute(_args: Record<string, never>, context: any): Promise<string> {
        const res = await sendRequest(
          { type: "session.detach", session_id: context.sessionID },
          context.directory
        );
        detachedCache.add(context.sessionID);
        generationCache.delete(context.sessionID);
        if (!res?.ok) return `detach failed (${res?.reason ?? "unknown"}); session treated as detached locally.`;
        return "detached. This session is now a normal standalone OpenCode session.";
      },
    }),
  };
}

// --- exports ---------------------------------------------------------------

export default {
  id: PLUGIN_ID,
  async setup(ctx: any) {
    if (initialized) return;
    initialized = true;

    try {
      await ctx.tool.hook("execute.after", async (input: any) => {
        const sessionID = typeof input?.sessionID === "string" ? input.sessionID : sessionIDOf(input);
        forwardEvent(TOOL_AFTER, sessionID, input);
      });
    } catch {
      // Older hosts may lack tool hooks; the event stream still covers us.
    }

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            await handleStreamEvent(event);
          } catch {
            // Per-event failure must not kill the stream.
          }
        }
      } catch {
        // Best-effort reporting: a dropped stream must not break the session.
      }
    })();

    return () => controller.abort();
  },
};

// Official Plugin-function shape (enables agent_attach/agent_detach tools).
// Ignored by hosts that only support the default export (like the v2 setup
// shape above); the module guard prevents double activation otherwise.
export const RelayPlugin = async (input: any) => {
  if (initialized) return {};
  initialized = true;
  const directory = input?.directory;
  return {
    tool: await buildTools(),
    event: async ({ event }: any) => {
      try {
        await handleStreamEvent(event, directory);
      } catch {
        // Never break the session.
      }
    },
    "tool.execute.after": async (toolInput: any) => {
      try {
        const sessionID = typeof toolInput?.sessionID === "string" ? toolInput.sessionID : sessionIDOf(toolInput);
        forwardEvent(TOOL_AFTER, sessionID, toolInput, directory);
      } catch {
        // Never break the session.
      }
    },
  };
};
