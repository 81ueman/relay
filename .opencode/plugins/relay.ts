// relay OpenCode plugin — OpenCode V2 plugin API.
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
//   Use agent_attach (custom tool) or `relay session attach` to manage one.
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
//   ln -s "$(pwd)/.opencode/plugins/relay.ts" ~/.config/opencode/plugins/relay.ts

import net from "node:net";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const PLUGIN_ID = "relay";

// A fresh value per module evaluation. The module is evaluated once and
// `setup()` then runs once per project location; a hot reload is a NEW module
// evaluation. Comparing this token lets the newest code take over the
// server-global forwarder, while locations in the same load still dedupe.
const LOAD = Symbol("relay.plugin.load");

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
  /** sessionID -> project directory (resolved once from the server, successes only). */
  directoryCache: Map<string, string | null>;
  /** directory -> MAIN git worktree root (or null). Cached: never spawn git per event. */
  repoRootCache: Map<string, string | null>;
  /** Sessions we already told the daemon to attach (marker or env). */
  autoAttached: Set<string>;
  /** sessionID -> last auto-attach attempt time (retry cooldown). */
  attachAttemptAt: Map<string, number>;
  /** sessionID -> per-spawn identity seen in a marker, awaiting a successful attach. */
  pendingAttach: Map<string, { workerId?: string; generation: number; token?: string }>;
  /** sessionID -> last context value forwarded (dedupe unchanged readings). */
  contextLast: Map<string, number>;
  /** sessionID -> time the last context reading was forwarded (per-session throttle). */
  contextSentAt: Map<string, number>;
  /** The live forwarder's controller (aborted when a reload takes over). */
  controller?: AbortController;
}

// Shared across every loaded copy in this server process.
const G: RelayPluginState = ((globalThis as any).__relayPlugin ??= {
  toolLocations: new Set(),
  generationCache: new Map(),
  detachedCache: new Set(),
  directoryCache: new Map(),
  repoRootCache: new Map(),
  autoAttached: new Set(),
  attachAttemptAt: new Map(),
  pendingAttach: new Map(),
  contextLast: new Map(),
  contextSentAt: new Map(),
}) as RelayPluginState;

// A hot reload can adopt a globalThis state object created by an older load that
// lacks newer fields. Normalize them rather than crashing on undefined.
G.toolLocations ??= new Set();
G.generationCache ??= new Map();
G.detachedCache ??= new Set();
G.directoryCache ??= new Map();
G.repoRootCache ??= new Map();
G.autoAttached ??= new Set();
G.attachAttemptAt ??= new Map();
G.pendingAttach ??= new Map();
G.contextLast ??= new Map();
G.contextSentAt ??= new Map();

// Env-only auto attach is OFF by default: a shared server's process env names
// at most one worker, so it cannot identify a session. Opt in only for
// dedicated one-server-per-worker deployments.
const AUTO_ATTACH_FROM_ENV = process.env.RELAY_AUTO_ATTACH === "1";
const ENV_WORKER = process.env.RELAY_WORKER;
const ENV_GENERATION = (() => {
  const n = Number(process.env.RELAY_GENERATION ?? "");
  return Number.isInteger(n) && n > 0 ? n : undefined;
})();

// Per-spawn marker carried in the relay bootstrap prompt. `token` is optional
// (manual attaches have none; relay-spawned attaches always do).
const ATTACH_MARKER = /RELAY-ATTACH\s+worker=([A-Za-z0-9._-]+)\s+gen=(\d+)(?:\s+token=([A-Za-z0-9._-]+))?/;

/**
 * The MAIN worktree root of the git repo containing `directory`, or null.
 *
 * A linked worktree (`~/.herdr/worktrees/<repo>/<lane>`) has no ancestor
 * `.relay`; the git COMMON dir points at the MAIN checkout's `.git`, whose
 * parent is the main worktree root. Same repository, so resolving there can
 * never cross-route to another project. Cached per directory: socketPathFor runs
 * on every forwarded event and must not spawn git each time.
 */
export function gitRepoRoot(directory: string): string | null {
  const key = path.resolve(directory);
  const cached = G.repoRootCache.get(key);
  if (cached !== undefined) return cached;
  let root: string | null = null;
  try {
    const out = execFileSync("git", ["-C", key, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) root = path.dirname(out);
  } catch {
    root = null;
  }
  G.repoRootCache.set(key, root);
  return root;
}

/**
 * Resolve the daemon socket for a session's project directory.
 *
 * INVARIANT (fail closed): when the session directory IS known we NEVER fall
 * back to a process-global `RELAY_SOCK`. A shared OpenCode server hosts
 * sessions from many projects and its env may name another project's daemon; a
 * wrong socket would route one project's events into another project's control
 * plane. So, with a known directory:
 *   1. the nearest existing `<dir>/.relay/relay.sock` (walking up), else
 *   2. the nearest `<dir>/.relay/` (socket not created yet), else
 *   3. the MAIN checkout's `.relay` via the git common dir (git worktree), else
 *   4. no socket at all (drop).
 * `RELAY_SOCK` is only consulted when the directory is unknown AND the
 * deployment explicitly opts into dedicated single-project mode
 * (`RELAY_DEDICATED=1`). Otherwise there is no session→project evidence, so
 * the only safe action is to drop.
 */
export function socketPathFor(directory?: string | null): string | null {
  const envSock = process.env.RELAY_SOCK;

  if (!directory) {
    // No directory: only the explicit dedicated single-project fallback is safe.
    return process.env.RELAY_DEDICATED === "1" ? (envSock ?? null) : null;
  }

  const walk = (fn: (dir: string) => string | null): string | null => {
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
    const sock = path.join(d, ".relay", "relay.sock");
    return existsSync(sock) ? sock : null;
  });
  if (existing) return existing;

  const relayDir = walk((d) => (existsSync(path.join(d, ".relay")) ? d : null));
  if (relayDir) return path.join(relayDir, ".relay", "relay.sock");

  // Git-worktree fallback (same repository => still fail closed across projects).
  const root = gitRepoRoot(directory);
  if (root) {
    const rootSock = path.join(root, ".relay", "relay.sock");
    if (existsSync(rootSock)) return rootSock;
    if (existsSync(path.join(root, ".relay"))) return rootSock;
  }

  // Known directory with no project control plane: NEVER another project's
  // RELAY_SOCK. Fail closed.
  return null;
}

/** Fire-and-forget event forward. Never throws, never blocks the session. */
function sendEvent(msg: Record<string, unknown>, directory?: string | null): void {
  const sockPath = socketPathFor(directory);
  if (!sockPath) return; // no project daemon: drop rather than cross-route
  const line = JSON.stringify(msg) + "\n";
  try {
    const sock = net.createConnection(sockPath);
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
export function sendRequest(
  msg: Record<string, unknown>,
  directory?: string | null,
  timeoutMs = 4000
): Promise<any> {
  const sockPath = socketPathFor(directory);
  if (!sockPath) return Promise.resolve({ ok: false, reason: "no-socket" });
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
      sock = net.createConnection(sockPath);
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
 * process env). `Session.Info` carries it under `location.directory`. Only
 * SUCCESSFUL lookups are cached: a transient failure must not pin the session
 * to the env fallback forever, so the next event retries.
 */
export async function directoryFor(ctx: any, sessionID?: string): Promise<string | undefined> {
  if (!sessionID || !sessionID.startsWith("ses")) return undefined;
  const cached = G.directoryCache.get(sessionID);
  if (typeof cached === "string" && cached) return cached;
  let dir: string | null = null;
  try {
    const info = await ctx.session.get({ sessionID });
    const candidate = info?.location?.directory ?? info?.directory;
    if (typeof candidate === "string" && candidate) dir = candidate;
  } catch {
    // Unknown/unmounted session: do NOT cache the miss; retry on the next event.
  }
  if (dir) {
    G.directoryCache.set(sessionID, dir);
    return dir;
  }
  return undefined;
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

// Auto-attach is retried on later prompts/events, but at most once per cooldown
// so a daemon outage cannot turn every event into a socket round-trip.
const ATTACH_RETRY_MS = 1500;

/** Local attach bookkeeping (a subset of RelayPluginState, for testing). */
export interface AttachState {
  autoAttached: Set<string>;
  attachAttemptAt: Map<string, number>;
  generationCache: Map<string, number>;
  detachedCache: Set<string>;
}

/**
 * Whether a fresh auto-attach attempt is allowed now. Never once attached;
 * otherwise rate-limited to one attempt per cooldown.
 */
export function attachAllowed(
  state: AttachState, sessionID: string, nowMs: number, cooldownMs = ATTACH_RETRY_MS
): boolean {
  if (!sessionID) return false;
  if (state.autoAttached.has(sessionID)) return false;
  const last = state.attachAttemptAt.get(sessionID);
  if (last !== undefined && nowMs - last < cooldownMs) return false;
  return true;
}

/**
 * Apply the daemon's attach response. ONLY an explicit
 * `{ok:true, managed:true, generation:G}` binds the session locally. Anything
 * else (ok=false, a rejection, a timeout, no daemon) leaves the caches
 * untouched, so the next event retries and no stale generation is ever cached.
 */
export function applyAttachResult(
  state: AttachState, sessionID: string, requestedGeneration: number, res: any
): boolean {
  if (!res || res.ok !== true || res.managed !== true) return false;
  state.autoAttached.add(sessionID);
  state.attachAttemptAt.delete(sessionID);
  const g =
    typeof res.generation === "number" && Number.isInteger(res.generation)
      ? res.generation
      : requestedGeneration;
  state.generationCache.set(sessionID, g);
  state.detachedCache.delete(sessionID);
  return true;
}

/**
 * Bind a session to a worker/generation: request/response with the daemon. The
 * local generation cache is only populated after the daemon confirms the
 * attach, so a failed/absent daemon can never poison a later event.
 */
async function autoAttach(
  sessionID: string, workerId: string | undefined, generation: number,
  directory?: string, token?: string
): Promise<boolean> {
  if (!attachAllowed(G, sessionID, Date.now())) return false;
  G.attachAttemptAt.set(sessionID, Date.now());
  const res = await sendRequest(
    {
      type: "session.attach",
      session_id: sessionID,
      worker_id: workerId,
      generation,
      token,
      directory,
    },
    directory
  );
  const bound = applyAttachResult(G, sessionID, generation, res);
  if (bound) G.pendingAttach.delete(sessionID);
  return bound;
}

/**
 * Retry a previously-seen marker identity on a later event (status/idle/tool).
 * A failed attach never poisons the cache, so the next event is a retry trigger;
 * the per-session cooldown inside autoAttach keeps it to one attempt per window.
 */
function retryPendingAttach(sessionID: string | undefined, directory?: string): void {
  if (!sessionID) return;
  const pending = G.pendingAttach.get(sessionID);
  if (!pending) return;
  void autoAttach(sessionID, pending.workerId, pending.generation, directory, pending.token);
}

/** Per-session identity from the relay bootstrap prompt marker. */
export async function maybeAttachFromText(ctx: any, sessionID: string | undefined, text: string): Promise<boolean> {
  if (!sessionID || !sessionID.startsWith("ses_")) return false;
  const m = ATTACH_MARKER.exec(text || "");
  if (!m) return false;
  // The marker is authoritative for worker/generation/token; it is never
  // derived from the shared server's process env. Remember it so a failed
  // attach can be retried when the next status/idle event arrives.
  const pending = { workerId: m[1], generation: Number(m[2]), token: m[3] };
  G.pendingAttach.set(sessionID, pending);
  const directory = await directoryFor(ctx, sessionID);
  return autoAttach(sessionID, pending.workerId, pending.generation, directory, pending.token);
}

/** Opt-in env auto attach (only safe when one server serves exactly one worker). */
async function maybeAttachFromEnv(sessionID: string | undefined, directory?: string): Promise<boolean> {
  if (!AUTO_ATTACH_FROM_ENV || !sessionID || !sessionID.startsWith("ses_")) return false;
  if (ENV_GENERATION === undefined) return false;
  G.pendingAttach.set(sessionID, { workerId: ENV_WORKER, generation: ENV_GENERATION });
  return autoAttach(sessionID, ENV_WORKER, ENV_GENERATION, directory);
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
// Early hang detection: sent from the tool `execute.before` hook, so relay knows
// a command is running WHILE it runs (execute.after only fires at the end, and
// Herdr reports `working` the whole time).
const TOOL_STARTED = "tool.started";

// Context-window telemetry. The V2 SDK confirms two token-bearing events:
// `EventMessageUpdated` (properties.info is an AssistantMessage whose `tokens`
// is `{input, output, reasoning, cache:{read,write}}`) and `EventSessionUpdated`
// (properties.info is a Session with the same `tokens` shape, plus `model`).
//
// We deliberately do NOT gate detection on these names: `maybeForwardContext`
// scans ANY event for assistant token usage, so a host event-name change or a
// new token-bearing event cannot silently disable context detection. The set
// below only documents the confirmed host names.
export const CONTEXT_USAGE_TYPES = new Set(["message.updated", "session.updated"]);
// At most one `session.context` per session per window: the stream is
// high-frequency and the metric barely moves within a few seconds.
const CONTEXT_THROTTLE_MS = 5000;

/**
 * Transport telemetry extracted from a tool hook event. `tool` identifies the
 * tool; for `shell` the command and timeout tell relay WHAT is running and how
 * long it was allowed to run. Every field is defensive: the event shape is host
 * data and is never trusted to be complete.
 */
export function toolTelemetry(event: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const tool = typeof event?.tool === "string" ? event.tool : undefined;
  if (tool) out.tool = tool;
  const input = event?.input && typeof event.input === "object" ? event.input : undefined;
  const cmd = input?.command ?? input?.cmd;
  if (typeof cmd === "string" && cmd) out.command = cmd.length > 500 ? cmd.slice(0, 500) : cmd;
  const timeout = input?.timeout;
  if (typeof timeout === "number" && timeout > 0) out.timeout_ms = timeout;
  if (typeof event?.status === "string") out.status = event.status;
  return out;
}

/**
 * Defensive recursive finder for an assistant token-usage object: a nested
 * object with a numeric `input` and a numeric `cache.read` (schema
 * `TokenUsage.Info` / `AssistantMessage.tokens`). Bounded depth, never throws —
 * the event payload is host data and may be any shape, including a future one.
 */
export function tokenUsageOf(data: unknown, depth = 0): { input: number; cacheRead: number } | null {
  if (depth > 6 || !data || typeof data !== "object") return null;
  try {
    const obj = data as Record<string, unknown>;
    const input = obj.input;
    const cache = obj.cache as Record<string, unknown> | undefined;
    const cacheRead =
      cache && typeof cache === "object" ? (cache as Record<string, unknown>).read : undefined;
    if (
      typeof input === "number" &&
      Number.isFinite(input) &&
      typeof cacheRead === "number" &&
      Number.isFinite(cacheRead)
    ) {
      return { input, cacheRead };
    }
    for (const value of Object.values(obj)) {
      const found = tokenUsageOf(value, depth + 1);
      if (found) return found;
    }
  } catch {
    // Never throw out of a best-effort telemetry scan.
  }
  return null;
}

/** Bounded recursive search for a model id anywhere nearby (`modelID`, `model.id`). */
function findModelID(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || !value || typeof value !== "object") return undefined;
  try {
    const obj = value as Record<string, unknown>;
    if (typeof obj.modelID === "string" && obj.modelID) return obj.modelID;
    if (typeof obj.model === "string" && obj.model) return obj.model;
    const model = obj.model;
    if (model && typeof model === "object") {
      const id = (model as Record<string, unknown>).id ?? (model as Record<string, unknown>).modelID;
      if (typeof id === "string" && id) return id;
    }
    for (const child of Object.values(obj)) {
      const found = findModelID(child, depth + 1);
      if (found) return found;
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Current context occupancy of the latest assistant message: `input +
 * cache.read` (the prompt/context tokens in play), or undefined when no token
 * usage is present in the event.
 */
export function contextUsedTokens(data: unknown): { used: number; model?: string } | undefined {
  const usage = tokenUsageOf(data);
  if (!usage) return undefined;
  const used = usage.input + usage.cacheRead;
  if (!Number.isFinite(used) || used <= 0) return undefined;
  return { used, model: findModelID(data) };
}

/**
 * Forward `session.context` when an event carries assistant token usage.
 * Best-effort (never throws); throttled per session (at most one per
 * `CONTEXT_THROTTLE_MS`) and deduped (an unchanged reading is never re-sent).
 * The daemon treats the event as telemetry only — no state change, no wake.
 */
function maybeForwardContext(sessionID: string | undefined, data: unknown, directory?: string): void {
  try {
    if (!sessionID) return;
    const reading = contextUsedTokens(data);
    if (!reading) return;
    const at = Date.now();
    const last = G.contextLast.get(sessionID);
    if (last !== undefined && last === reading.used) return; // nothing new
    const sentAt = G.contextSentAt.get(sessionID) ?? 0;
    if (at - sentAt < CONTEXT_THROTTLE_MS) return; // rate limit
    G.contextLast.set(sessionID, reading.used);
    G.contextSentAt.set(sessionID, at);
    sendEvent(
      {
        type: "session.context",
        ...withGeneration(sessionID, {
          payload: { used_tokens: reading.used, ...(reading.model ? { model: reading.model } : {}) },
        }),
      },
      directory
    );
  } catch {
    // Telemetry must never break a session.
  }
}

async function forwardEvent(
  ctx: any,
  type: string,
  sessionID: string | undefined,
  data: any,
  directoryHint?: string
): Promise<void> {
  const directory = directoryHint ?? (await directoryFor(ctx, sessionID));

  if (AUTO_ATTACH_FROM_ENV) void maybeAttachFromEnv(sessionID, directory);
  // A marker was seen but the attach had not (yet) succeeded: any later event is
  // a retry trigger (rate-limited by the per-session cooldown).
  retryPendingAttach(sessionID, directory);

  // Context-window telemetry is scanned from EVERY event, not gated on a
  // hard-coded name (see CONTEXT_USAGE_TYPES): any event carrying assistant
  // token usage must be able to trigger `session.context`.
  maybeForwardContext(sessionID, data, directory);

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
  if (type === TOOL_STARTED) {
    if (sessionID && G.detachedCache.has(sessionID)) return;
    sendEvent({ type: TOOL_STARTED, ...withGeneration(sessionID, { payload: toolTelemetry(data) }) }, directory);
    return;
  }
  if (type === TOOL_AFTER) {
    // High-frequency path: skip the socket entirely for sessions we detached
    // in-process. Everything else is gated daemon-side (cheap local write).
    if (sessionID && G.detachedCache.has(sessionID)) return;
    sendEvent({ type: TOOL_AFTER, ...withGeneration(sessionID, { payload: toolTelemetry(data) }) }, directory);
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
    void maybeAttachFromText(ctx, sessionID, stringsOf(data).join("\n"));
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
          pane_id: { type: "string", description: "Your Herdr pane id (e.g. \"$HERDR_PANE_ID\"). REQUIRED in a shared checkout where several agents run in the same directory, because the daemon cannot otherwise tell which pane this session is (Herdr does not always report agent_session)." },
        },
        additionalProperties: false,
      },
      async execute(raw: any, context: any): Promise<{ content: string }> {
        const args = (raw ?? {}) as { role?: string; worker_id?: string; generation?: number; token?: string; pane_id?: string };
        const sessionID: string = context?.sessionID;
        const directory = await directoryFor(ctx, sessionID);
        const res = await sendRequest(
          {
            type: "session.attach",
            session_id: sessionID,
            role: args.role,
            worker_id: args.worker_id,
            generation: args.generation,
            token: args.token,
            pane_id: args.pane_id,
            directory,
          },
          directory
        );
        if (!res?.ok) {
          return {
            content: `attach failed (${res?.reason ?? "unknown"}). Is the relay daemon running for this project? Start it with \`relay daemon\` in the project root, then retry. Equivalent CLI: \`relay session attach --session ${sessionID} --dir <project>\`. If the reason is ambiguous identity / no pane mapping, pass pane_id: "$HERDR_PANE_ID" (several agents share this directory).`,
          };
        }
        G.generationCache.set(sessionID, res.generation);
        G.attachAttemptAt.delete(sessionID);
        G.pendingAttach.delete(sessionID);
        G.detachedCache.delete(sessionID);
        return {
          content: `attached as worker ${res.worker_id} (generation ${res.generation}). Load the agent-worker skill and run \`relay next\`.`,
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
        G.attachAttemptAt.delete(sessionID);
        G.pendingAttach.delete(sessionID);
        // Drop the cached directory too: a detached session may be recreated
        // elsewhere, and a stale directory would re-route its events.
        G.directoryCache.delete(sessionID);
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

    // Per-LOCATION hooks. Tool and session hooks are scoped to the location
    // whose `setup()` registered them, so EVERY location must register its own.
    // Registering them once "server-globally" (as the event stream is) leaves
    // every OTHER location unobserved: its tools fire no execute.before/after,
    // so relay sees no tool.started and no tool liveness at all. (Found live: a
    // second location loaded first after a service restart and the fleet's tool
    // events vanished while session.idle still flowed.)

    // The relay bootstrap marker is in a spawned session's own prompt text.
    // This hook is the reliable signal (the raw event type name may change).
    try {
      await ctx.session.hook("prompt", async (event: any) => {
        try {
          const sessionID = typeof event?.sessionID === "string" ? event.sessionID : undefined;
          const text = stringsOf(event?.prompt ?? event).join("\n");
          // Request/response runs in the background so a slow/absent daemon can
          // never stall the prompt; the caches are only set once it confirms.
          void maybeAttachFromText(ctx, sessionID, text);
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

    // Early hang detection: announce the tool BEFORE it runs, so a long/hung
    // command is visible to relay while it is still running. Best-effort, like
    // every other forward; a host without the hook still gets after-events.
    try {
      await ctx.tool.hook("execute.before", async (event: any) => {
        try {
          const sessionID = typeof event?.sessionID === "string" ? event.sessionID : sessionIDOf(event);
          await forwardEvent(ctx, TOOL_STARTED, sessionID, event);
        } catch {
          // Never break the session.
        }
      });
    } catch {
      // Older hosts may lack tool hooks; after-events still cover liveness.
    }

    // Exactly one SERVER-GLOBAL forwarder across every location in this module
    // load: the event subscription is server-wide, so it is registered exactly
    // once. A hot reload (new LOAD) takes ownership and aborts the previous
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
