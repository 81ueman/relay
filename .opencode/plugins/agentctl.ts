// agentctl OpenCode plugin (relay) — OpenCode V2 plugin API.
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
// - PER-SESSION routing. A single OpenCode server (`opencode serve --service`)
//   hosts sessions from many projects and its process env names none of them,
//   so we NEVER trust process env for socket path, pane identity, or
//   generation. The session id and its project directory are the only
//   authoritative inputs; the directory (asked of `ctx.session.get`, which
//   returns it under `location.directory`) picks the daemon socket, and the
//   daemon resolves the Herdr identity itself.
// - The relay bootstrap marker travels with a spawned session's own prompt
//   text, so the `prompt` hook (not a guessed event type) is what binds the
//   RIGHT session of a shared server to its worker/generation.
// - Loaded shape is the V2 default export `{ id, setup(ctx) }`. Tools are
//   registered through `ctx.tool.transform`; hooks/events come from
//   `ctx.tool.hook` / `ctx.session.hook` / `ctx.event.subscribe`. The V1
//   `tool()` helper / returned hook object does not run under OpenCode 2.
//
// Installing this file both in a project (`.opencode/plugins/`) and globally
// (`~/.config/opencode/plugins/`) makes the same location load two copies. All
// copies share state on `globalThis`: tools are registered once per location,
// and exactly one server-global forwarder (prompt hook + tool hook + event
// subscription) exists, so events are never forwarded twice. The tools are
// per-location, so symlink it globally to get agent_attach/agent_detach in
// every project:
//
//   ln -s "$(pwd)/.opencode/plugins/agentctl.ts" ~/.config/opencode/plugins/agentctl.ts

import net from "node:net";
import { existsSync } from "node:fs";
import path from "node:path";

const PLUGIN_ID = "relay.agentctl";

// A fresh value per module evaluation. The module is evaluated once and
// `setup()` then runs once per project location; a hot reload is a NEW module
// evaluation. Comparing this token lets the newest code take over the
// server-global forwarder, while locations in the same load still dedupe.
const LOAD = Symbol("relay.agentctl.load");

interface RelayPluginState {
  /** Module load that currently owns the server-global forwarder. */
  forwarderLoad?: symbol;
  /** Module load + locations whose tool catalog already got the tools. */
  toolsLoad?: symbol;
  toolLocations: Set<string>;
  /** sessionID -> generation observed at attach (zombie protection). */
  generationCache: Map<string, number>;
  /** Sessions detached via the in-process tool: skip even the socket write. */
  detachedCache: Set<string>;
  /** sessionID -> project directory (resolved once from the server). */
  directoryCache: Map<string, string | null>;
  /** Sessions we already told the daemon to attach (marker or env). */
  autoAttached: Set<string>;
  /** The live forwarder's controller (aborted when a reload takes over). */
  controller?: AbortController;
}

// Shared across every loaded copy in this server process.
const G: RelayPluginState = ((globalThis as any).__relayAgentctl ??= {
  toolLocations: new Set(),
  generationCache: new Map(),
  detachedCache: new Set(),
  directoryCache: new Map(),
  autoAttached: new Set(),
}) as RelayPluginState;

// Env-only auto attach is OFF by default: a shared server's process env names
// at most one worker, so it cannot identify a session. Opt in only for
// dedicated one-server-per-worker deployments.
const AUTO_ATTACH_FROM_ENV = process.env.AGENTCTL_AUTO_ATTACH === "1";
const ENV_WORKER = process.env.AGENTCTL_WORKER;
const ENV_GENERATION = (() => {
  const n = Number(process.env.AGENTCTL_GENERATION ?? "");
  return Number.isInteger(n) && n > 0 ? n : undefined;
})();

// Per-spawn marker carried in the relay bootstrap prompt. `token` is optional
// (manual attaches have none; relay-spawned attaches always do).
const ATTACH_MARKER = /RELAY-ATTACH\s+worker=([A-Za-z0-9._-]+)\s+gen=(\d+)(?:\s+token=([A-Za-z0-9._-]+))?/;

/**
 * Resolve the daemon socket for a session's project directory.
 *
 * Priority:
 *   1. the nearest existing `.agentctl/relay.sock` walking up from the session
 *      directory (a session opened in a subdirectory still finds its project);
 *   2. `AGENTCTL_SOCK` — only meaningful for a dedicated server/CLI run;
 *   3. the nearest `.agentctl/` dir walking up (socket not created yet);
 *   4. `<directory>/.agentctl/relay.sock`.
 */
function socketPathFor(directory?: string | null): string {
  const walk = (fn: (dir: string) => string | null): string | null => {
    if (!directory) return null;
    let dir = directory;
    for (let i = 0; i < 16; i++) {
      const hit = fn(dir);
      if (hit) return hit;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  };

  const existing = walk((d) => {
    const sock = path.join(d, ".agentctl", "relay.sock");
    return existsSync(sock) ? sock : null;
  });
  if (existing) return existing;

  const envSock = process.env.AGENTCTL_SOCK;
  if (envSock && !directory) return envSock;

  const agentctlDir = walk((d) => (existsSync(path.join(d, ".agentctl")) ? d : null));
  if (agentctlDir) return path.join(agentctlDir, ".agentctl", "relay.sock");

  if (envSock) return envSock;
  return path.join(directory ?? process.cwd(), ".agentctl", "relay.sock");
}

/** Fire-and-forget event forward. Never throws, never blocks the session. */
function sendEvent(msg: Record<string, unknown>, directory?: string | null): void {
  const line = JSON.stringify(msg) + "\n";
  try {
    const sock = net.createConnection(socketPathFor(directory));
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
function sendRequest(
  msg: Record<string, unknown>,
  directory?: string | null,
  timeoutMs = 4000
): Promise<any> {
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
      sock = net.createConnection(socketPathFor(directory));
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

/** Collect every string in a nested value (bounded), for marker scanning. */
function stringsOf(value: unknown, out: string[] = [], depth = 0): string[] {
  if (out.length > 200 || depth > 6) return out;
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) stringsOf(v, out, depth + 1);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) stringsOf(v, out, depth + 1);
  }
  return out;
}

/**
 * The session's project directory, asked of the OpenCode server (never the
 * process env). `Session.Info` carries it under `location.directory`. Cached
 * per session. Returns undefined when unknown.
 */
async function directoryFor(ctx: any, sessionID?: string): Promise<string | undefined> {
  if (!sessionID || !sessionID.startsWith("ses")) return undefined;
  if (G.directoryCache.has(sessionID)) return G.directoryCache.get(sessionID) ?? undefined;
  let dir: string | null = null;
  try {
    const info = await ctx.session.get({ sessionID });
    const candidate = info?.location?.directory ?? info?.directory;
    if (typeof candidate === "string" && candidate) dir = candidate;
  } catch {
    // Unknown/unmounted session: leave undefined and fall back to the env sock.
  }
  G.directoryCache.set(sessionID, dir);
  return dir ?? undefined;
}

function generationFor(sessionID: string | undefined): number | undefined {
  // Only an attach this plugin performed is trustworthy. The server's process
  // env belongs to the server, not the session, so it is never a generation.
  if (!sessionID) return undefined;
  return G.generationCache.get(sessionID);
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
function autoAttach(sessionID: string, workerId: string | undefined, generation: number, directory?: string, token?: string): void {
  if (G.autoAttached.has(sessionID)) return;
  G.autoAttached.add(sessionID);
  G.generationCache.set(sessionID, generation);
  sendEvent(
    {
      type: "session.attach",
      session_id: sessionID,
      worker_id: workerId,
      generation,
      token,
      role: "worker",
      directory,
    },
    directory
  );
}

/** Per-session identity from the relay bootstrap prompt marker. */
async function maybeAttachFromText(ctx: any, sessionID: string | undefined, text: string): Promise<boolean> {
  if (!sessionID || G.autoAttached.has(sessionID) || !sessionID.startsWith("ses_")) return false;
  const m = ATTACH_MARKER.exec(text || "");
  if (!m) return false;
  const directory = await directoryFor(ctx, sessionID);
  autoAttach(sessionID, m[1], Number(m[2]), directory, m[3]);
  return true;
}

/** Opt-in env auto attach (only safe when one server serves exactly one worker). */
function maybeAttachFromEnv(sessionID: string | undefined, directory?: string): void {
  if (!AUTO_ATTACH_FROM_ENV || !sessionID || !sessionID.startsWith("ses_")) return;
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

function directoryOfEvent(data: any): string | undefined {
  const d = data?.location?.directory;
  return typeof d === "string" && d ? d : undefined;
}

function errorOf(data: any): string {
  try {
    const e = data?.error ?? data?.message ?? data;
    return typeof e === "string" ? e.slice(0, 500) : JSON.stringify(e).slice(0, 500);
  } catch {
    return "unknown error";
  }
}

// OpenCode 2.0.x does NOT emit `session.idle` on the plugin event stream: a
// finished execution (`session.execution.succeeded`) or an interrupt is the
// turn-complete signal. Normalize both onto the stable `session.idle` protocol
// type — the supervisor treats it as a trigger, never as task completion.
const IDLE_TYPES = new Set([
  "session.idle",
  "session.execution.succeeded",
  "session.execution.interrupted",
]);
const ERROR_TYPES = new Set(["session.error", "session.execution.failed"]);
const PERMISSION_ASKED = new Set(["permission.asked", "form.created"]);
const PERMISSION_REPLIED = new Set(["permission.replied", "form.replied", "form.cancelled"]);
const LIVENESS_TYPES = new Set(["session.status", "session.created", "session.viewed"]);
// tool.execute.after also arrives via the tool hook; both paths funnel here.
const TOOL_AFTER = "tool.execute.after";

async function forwardEvent(
  ctx: any,
  type: string,
  sessionID: string | undefined,
  data: any,
  directoryHint?: string
): Promise<void> {
  const directory = directoryHint ?? (await directoryFor(ctx, sessionID));

  if (AUTO_ATTACH_FROM_ENV) maybeAttachFromEnv(sessionID, directory);

  if (IDLE_TYPES.has(type)) {
    // Always forwarded; the daemon gates on managed + generation. Normalized to
    // the protocol's `session.idle` so the daemon never has to know the host's
    // raw execution event name.
    sendEvent({ type: "session.idle", ...withGeneration(sessionID) }, directory);
    return;
  }
  if (ERROR_TYPES.has(type)) {
    // Always forwarded; the daemon gates on managed + generation.
    sendEvent({ type, ...withGeneration(sessionID, { payload: { error: errorOf(data) } }) }, directory);
    return;
  }
  if (PERMISSION_ASKED.has(type)) {
    sendEvent({ type: "permission.asked", ...withGeneration(sessionID) }, directory);
    return;
  }
  if (PERMISSION_REPLIED.has(type)) {
    sendEvent({ type: "permission.replied", ...withGeneration(sessionID) }, directory);
    return;
  }
  if (LIVENESS_TYPES.has(type)) {
    sendEvent({ type, ...withGeneration(sessionID) }, directory);
    return;
  }
  if (type === TOOL_AFTER) {
    // High-frequency path: skip the socket entirely for sessions we detached
    // in-process. Everything else is gated daemon-side (cheap local write).
    if (sessionID && G.detachedCache.has(sessionID)) return;
    sendEvent({ type: TOOL_AFTER, ...withGeneration(sessionID) }, directory);
  }
}

async function handleStreamEvent(ctx: any, event: { type?: string; data?: any }): Promise<void> {
  const type = typeof event?.type === "string" ? event.type : "unknown";
  const data = event?.data;
  const sessionID = sessionIDOf(data);
  const directoryHint = directoryOfEvent(data);
  if (sessionID && directoryHint) G.directoryCache.set(sessionID, directoryHint);
  // Marker fallback for hosts whose prompt hook does not deliver the text.
  if (type === "session.inbox.enqueued" || type === "session.renamed") {
    await maybeAttachFromText(ctx, sessionID, stringsOf(data).join("\n"));
  }
  await forwardEvent(ctx, type, sessionID, data, directoryHint);
}

// --- custom tools (V2 `ctx.tool.transform`) --------------------------------

async function registerTools(ctx: any): Promise<void> {
  await ctx.tool.transform((editor: any) => {
    editor.add({
      name: "agent_attach",
      description:
        "Attach this OpenCode session to relay supervision as a managed worker. After attaching, session idle/error events drive the deterministic task supervisor (SQLite-backed). No process restart needed.",
      input: {
        type: "object",
        properties: {
          role: { type: "string", description: "worker (default), planner, reviewer, coordinator" },
          worker_id: { type: "string", description: "Existing worker id to bind, else auto-derived" },
          generation: { type: "number", description: "Relay generation to bind (relay-spawned sessions); omit for a manual attach" },
          token: { type: "string", description: "Per-spawn attach token (relay-spawned sessions)" },
        },
        additionalProperties: false,
      },
      async execute(raw: any, context: any): Promise<{ content: string }> {
        const args = (raw ?? {}) as { role?: string; worker_id?: string; generation?: number; token?: string };
        const sessionID: string = context?.sessionID;
        const directory = await directoryFor(ctx, sessionID);
        const res = await sendRequest(
          {
            type: "session.attach",
            session_id: sessionID,
            role: args.role ?? "worker",
            worker_id: args.worker_id,
            generation: args.generation,
            token: args.token,
            directory,
          },
          directory
        );
        if (!res?.ok) {
          return {
            content: `attach failed (${res?.reason ?? "unknown"}). Is the relay daemon running for this project? Start it with \`agentctl daemon\` in the project root, then retry. Equivalent CLI: \`agentctl session attach --session ${sessionID} --dir <project>\`.`,
          };
        }
        G.generationCache.set(sessionID, res.generation);
        G.detachedCache.delete(sessionID);
        return {
          content: `attached as worker ${res.worker_id} (generation ${res.generation}). Load the agent-worker skill and run \`agentctl next\`.`,
        };
      },
    });

    editor.add({
      name: "agent_detach",
      description:
        "Detach this OpenCode session from relay supervision. The session returns to a normal standalone session; its events are ignored afterwards.",
      input: { type: "object", properties: {}, additionalProperties: false },
      async execute(_raw: any, context: any): Promise<{ content: string }> {
        const sessionID: string = context?.sessionID;
        const directory = await directoryFor(ctx, sessionID);
        const res = await sendRequest({ type: "session.detach", session_id: sessionID }, directory);
        if (!res?.ok) {
          // Rejected (e.g. the worker still owns a task): stay managed. Do not
          // poison the local caches — the session is NOT detached.
          return { content: `detach failed (${res?.reason ?? "unknown"}); session is still managed.` };
        }
        G.detachedCache.add(sessionID);
        G.generationCache.delete(sessionID);
        return { content: "detached. This session is now a normal standalone OpenCode session." };
      },
    });
  });
}

// --- export -----------------------------------------------------------------

export default {
  id: PLUGIN_ID,
  async setup(ctx: any) {
    // Tools are registered per location; dedupe when both a project copy and
    // the global copy have loaded the same location. Scoped to this load so a
    // hot reload re-registers them (the host rebuilds the catalog).
    const location = typeof ctx?.location?.directory === "string" ? ctx.location.directory : "(unknown)";
    if (G.toolsLoad !== LOAD) {
      G.toolsLoad = LOAD;
      G.toolLocations = new Set();
    }
    if (!G.toolLocations.has(location)) {
      G.toolLocations.add(location);
      try {
        await registerTools(ctx);
      } catch {
        // A host without the tool transform: events still forward; attach via CLI.
      }
    }

    // Exactly one server-global forwarder across every location in this module
    // load. A hot reload (new LOAD) takes ownership and aborts the previous
    // forwarder, so a code change applies without a server restart.
    if (G.forwarderLoad === LOAD) return;
    G.forwarderLoad = LOAD;
    const previous = G.controller;
    G.controller = undefined;
    if (previous) {
      try {
        previous.abort();
      } catch {
        // Already gone: nothing to stop.
      }
    }

    // The relay bootstrap marker is in a spawned session's own prompt text.
    // This hook is the reliable signal (the raw event type name may change).
    try {
      await ctx.session.hook("prompt", async (event: any) => {
        try {
          const sessionID = typeof event?.sessionID === "string" ? event.sessionID : undefined;
          const text = stringsOf(event?.prompt ?? event).join("\n");
          await maybeAttachFromText(ctx, sessionID, text);
        } catch {
          // Never break the session.
        }
      });
    } catch {
      // Older hosts may lack the prompt hook; the event stream fallback covers us.
    }

    try {
      await ctx.tool.hook("execute.after", async (event: any) => {
        try {
          const sessionID = typeof event?.sessionID === "string" ? event.sessionID : sessionIDOf(event);
          await forwardEvent(ctx, TOOL_AFTER, sessionID, event);
        } catch {
          // Never break the session.
        }
      });
    } catch {
      // Older hosts may lack tool hooks; the event stream still covers us.
    }

    const controller = new AbortController();
    G.controller = controller;
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            await handleStreamEvent(ctx, event);
          } catch {
            // Per-event failure must not kill the stream.
          }
        }
      } catch {
        // Best-effort reporting: a dropped stream must not break the session.
      }
    })();

    return () => {
      controller.abort();
      // Only the owner clears state; a newer load may already have taken over.
      if (G.controller === controller) {
        G.controller = undefined;
        G.forwarderLoad = undefined;
      }
    };
  },
};
