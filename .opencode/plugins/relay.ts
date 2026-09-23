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
  /** sessionID -> last cumulative usage forwarded (dedupe unchanged readings). */
  usageLast: Map<string, string>;
  /** sessionID -> time the last usage reading was forwarded (per-session throttle). */
  usageSentAt: Map<string, number>;
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
  usageLast: new Map(),
  usageSentAt: new Map(),
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
G.usageLast ??= new Map();
G.usageSentAt ??= new Map();

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
  const candidates = [
    data.sessionID,
    data.session?.id,
    data.info?.id,
    data.form?.sessionID,
    // Some V2 events (e.g. session.next.compaction.*) nest their payload under
    // `data`; accept that shape too so the event is never dropped for want of a
    // session id.
    data.data?.sessionID,
  ];
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

// Token-bearing events. Two KINDS of token usage arrive, and they must never be
// conflated — reading a cumulative total as occupancy is what latched the
// reconciler's rotation guard (T551):
//
//   OCCUPANCY (per message / per step): `message.updated`
//     (properties.info is an AssistantMessage whose `tokens` is
//     `{input, output, reasoning, cache:{read,write}}`) and `session.step.ended`
//     (`data = {sessionID, assistantMessageID, cost, tokens, ...}`).
//   CUMULATIVE (session lifetime): `session.usage.updated`
//     (`data = {sessionID, cost, tokens}`) and a full Session object.
//
// The names actually emitted by OpenCode 2.0.4 are the `session.*` forms above
// (NOT the SDK's `session.updated`), which is why classification keys off the
// SHAPE (role / assistantMessageID / sessionID+cost+tokens), not the name.
//
// We deliberately do NOT gate detection on event names: `maybeForwardContext`
// and `maybeForwardUsage` scan EVERY event, so a host rename or a new
// token-bearing event cannot silently disable detection. The set below only
// documents the confirmed host names.
export const CONTEXT_USAGE_TYPES = new Set([
  "message.updated",
  "session.step.ended",
  "session.usage.updated",
  "session.updated",
]);
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
 * Where a token-usage object was found. `message` is an AssistantMessage's
 * per-turn `tokens` (current context OCCUPANCY). `session` is a Session's
 * session-lifetime `tokens` (CUMULATIVE — must never be read as occupancy).
 * `unknown` keeps the historical best-effort behaviour when the host wraps the
 * usage in a shape we do not recognise, so a host rename cannot silently
 * disable context detection.
 */
export type TokenUsageSource = "message" | "session" | "unknown";

export interface TokenUsage {
  input: number;
  cacheRead: number;
  source: TokenUsageSource;
}

/** A `TokenUsage.Info` / `tokens` object: numeric `input` and `cache.read`. */
function isTokenUsageObject(value: unknown): value is { input: number; cache: { read: number } } {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  const cache = obj.cache;
  return (
    typeof obj.input === "number" &&
    Number.isFinite(obj.input) &&
    !!cache &&
    typeof cache === "object" &&
    typeof (cache as Record<string, unknown>).read === "number" &&
    Number.isFinite((cache as Record<string, unknown>).read)
  );
}

/**
 * Classify the object that HOLDS a `tokens` object (its parent, not the tokens
 * object itself). An AssistantMessage carries `role: "assistant"`; a Session
 * carries project/directory/slug identity and no role. This distinction is the
 * whole point of the metric split: only a message's tokens are occupancy.
 */
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}

/**
 * Classify the object that HOLDS a `tokens` object (its parent, not the tokens
 * object itself). Observed host shapes (OpenCode 2.0.4):
 *
 *   message.updated      properties.info = AssistantMessage {role:"assistant", tokens}
 *   session.step.ended   data = {sessionID, assistantMessageID, cost, tokens, ...}
 *   session.usage.updated data = {sessionID, cost, tokens}   <- SESSION CUMULATIVE
 *   session (full)       info = Session {id:"ses_...", projectID, cost, tokens}
 *
 * Only an assistant message / a per-step usage is occupancy; the session-level
 * usage event and a full Session are cumulative.
 */
function classifyTokenContainer(container: Record<string, unknown> | undefined): TokenUsageSource {
  if (!container) return "unknown";
  // Per-message / per-step usage (occupancy): role or an assistant message id.
  if (container.role === "assistant") return "message";
  if (typeof container.assistantMessageID === "string") return "message";
  // Session-level usage event: {sessionID, cost, tokens} with no message id.
  if (typeof container.sessionID === "string" && "cost" in container && isObject(container.tokens)) {
    return "session";
  }
  // A full Session object. Its own id is `ses_...`; projectID/directory/title are
  // present on the API shape but not guaranteed on a streamed one.
  if (typeof container.id === "string" && container.id.startsWith("ses")) return "session";
  if (
    typeof container.projectID === "string" ||
    typeof container.directory === "string" ||
    (typeof container.slug === "string" && typeof container.title === "string")
  ) {
    return "session";
  }
  return "unknown";
}

/**
 * Defensive recursive collector for token-usage objects. Bounded depth, never
 * throws — the event payload is host data and may be any shape, including a
 * future one. Each match records the SOURCE of its parent container so the
 * caller can tell occupancy (assistant message) from cumulative (session).
 */
export function collectTokenUsage(
  data: unknown,
  depth = 0,
  out: TokenUsage[] = [],
  container?: Record<string, unknown>
): TokenUsage[] {
  if (depth > 6 || !data || typeof data !== "object") return out;
  try {
    const obj = data as Record<string, unknown>;
    if (isTokenUsageObject(obj)) {
      out.push({
        input: obj.input,
        cacheRead: (obj.cache as { read: number }).read,
        source: classifyTokenContainer(container),
      });
      return out;
    }
    for (const value of Object.values(obj)) {
      collectTokenUsage(value, depth + 1, out, obj);
    }
  } catch {
    // Never throw out of a best-effort telemetry scan.
  }
  return out;
}

/**
 * First token-usage object found anywhere in `data`, or null. Historical API
 * kept for callers that only need the raw numbers; `contextUsedTokens` is the
 * one that separates occupancy from cumulative.
 */
export function tokenUsageOf(data: unknown): { input: number; cacheRead: number } | null {
  const first = collectTokenUsage(data)[0];
  return first ? { input: first.input, cacheRead: first.cacheRead } : null;
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
 * Token reading for a host event, split by MEANING:
 *   - `used`       current context OCCUPANCY (an assistant message's
 *                  `input + cache.read`). Only this may drive rotation.
 *   - `cumulative` session-lifetime prompt tokens (a Session's `tokens`).
 *                  Telemetry only — never occupancy.
 *
 * A message reading wins over a session reading. When the only match is a
 * Session, `used` is deliberately left undefined so the reconciler's
 * high-context guard cannot latch on a cumulative total (the T551 bug: a
 * session's 49,880,961 cumulative was read as 359K of occupancy). An
 * unrecognised wrapper still falls back to `used` so a host rename cannot
 * silently disable detection.
 */
export function contextUsedTokens(
  data: unknown
): { used?: number; cumulative?: number; model?: string } | undefined {
  const usages = collectTokenUsage(data);
  if (usages.length === 0) return undefined;
  const model = findModelID(data);
  const size = (u: TokenUsage | undefined): number | undefined => {
    if (!u) return undefined;
    const n = u.input + u.cacheRead;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const used =
    size(usages.find((u) => u.source === "message")) ??
    size(usages.find((u) => u.source === "unknown"));
  if (used !== undefined) return { used, ...(model ? { model } : {}) };
  const cumulative = size(usages.find((u) => u.source === "session"));
  if (cumulative !== undefined) return { cumulative, ...(model ? { model } : {}) };
  return undefined;
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
    // Dedupe on whichever value moved. A cumulative-only reading (session.updated)
    // carries no occupancy and is forwarded as telemetry WITHOUT `used_tokens`,
    // so the daemon can log it but never applies it to the rotation guard.
    const marker = reading.used ?? reading.cumulative ?? 0;
    const at = Date.now();
    const last = G.contextLast.get(sessionID);
    if (last !== undefined && last === marker) return; // nothing new
    const sentAt = G.contextSentAt.get(sessionID) ?? 0;
    if (at - sentAt < CONTEXT_THROTTLE_MS) return; // rate limit
    G.contextLast.set(sessionID, marker);
    G.contextSentAt.set(sessionID, at);
    const payload: Record<string, unknown> = {};
    if (reading.used !== undefined) payload.used_tokens = reading.used;
    if (reading.cumulative !== undefined) payload.cumulative_tokens = reading.cumulative;
    if (reading.model) payload.model = reading.model;
    sendEvent(
      {
        type: "session.context",
        ...withGeneration(sessionID, { payload }),
      },
      directory
    );
  } catch {
    // Telemetry must never break a session.
  }
}

/**
 * A session's session-lifetime CUMULATIVE cost and token counts, read from a
 * Session object (`session.updated`). Unlike `contextUsedTokens` this is NOT
 * occupancy — it is the running total the daemon diffs to attribute cost to a
 * task. Returns undefined when no Session carrying tokens is present.
 */
export interface SessionUsage {
  cost: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

function isSessionContainer(obj: Record<string, unknown>): boolean {
  if (obj.role === "assistant") return false;
  if (typeof obj.assistantMessageID === "string") return false;
  // session.usage.updated: {sessionID, cost, tokens}
  if (typeof obj.sessionID === "string" && "cost" in obj && isObject(obj.tokens)) return true;
  if (typeof obj.id === "string" && obj.id.startsWith("ses")) return true;
  return (
    typeof obj.projectID === "string" ||
    typeof obj.directory === "string" ||
    (typeof obj.slug === "string" && typeof obj.title === "string")
  );
}

export function sessionUsageOf(data: unknown, depth = 0): SessionUsage | undefined {
  if (depth > 6 || !data || typeof data !== "object") return undefined;
  try {
    const obj = data as Record<string, unknown>;
    if (isSessionContainer(obj)) {
      const tokens = obj.tokens as Record<string, unknown> | undefined;
      if (tokens && typeof tokens === "object") {
        const cache = tokens.cache as Record<string, unknown> | undefined;
        const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
        return {
          cost: num(obj.cost),
          input: num(tokens.input),
          output: num(tokens.output),
          reasoning: num(tokens.reasoning),
          cacheRead: cache ? num(cache.read) : 0,
          cacheWrite: cache ? num(cache.write) : 0,
        };
      }
    }
    for (const value of Object.values(obj)) {
      const found = sessionUsageOf(value, depth + 1);
      if (found) return found;
    }
  } catch {
    // Never throw out of a best-effort telemetry scan.
  }
  return undefined;
}

/**
 * Forward a session's cumulative usage (`session.usage`) when a Session event
 * carries it. Throttled per session and deduped on the whole reading, like
 * `session.context`. The daemon turns it into an attributed delta.
 */
function maybeForwardUsage(sessionID: string | undefined, data: unknown, directory?: string): void {
  try {
    if (!sessionID) return;
    const reading = sessionUsageOf(data);
    if (!reading) return;
    // Dedupe on the whole reading, not just cost: a free/zero-cost model still
    // moves tokens, and the daemon needs those deltas.
    const marker = `${reading.cost}:${reading.input}:${reading.output}:${reading.reasoning}:${reading.cacheRead}:${reading.cacheWrite}`;
    const last = G.usageLast.get(sessionID);
    if (last !== undefined && last === marker) return; // nothing new
    const at = Date.now();
    const sentAt = G.usageSentAt.get(sessionID) ?? 0;
    if (at - sentAt < CONTEXT_THROTTLE_MS) return; // rate limit
    G.usageLast.set(sessionID, marker);
    G.usageSentAt.set(sessionID, at);
    sendEvent(
      {
        type: "session.usage",
        ...withGeneration(sessionID, {
          payload: {
            cost: reading.cost,
            input: reading.input,
            output: reading.output,
            reasoning: reading.reasoning,
            cache_read: reading.cacheRead,
            cache_write: reading.cacheWrite,
          },
        }),
      },
      directory
    );
  } catch {
    // Telemetry must never break a session.
  }
}

/**
 * Normalize a compaction event type onto a single status. The host emits
 * `session.next.compaction.started/ended` (SDK) and `session.compaction.*`
 * (observed in the binary) plus the durable `session.compacted`; match
 * defensively by substring so a rename cannot silently drop the signal.
 * `compaction.delta` is deliberately ignored (it fires many times per run).
 */
export function compactionStatusOf(type: string): "started" | "ended" | "failed" | "completed" | undefined {
  if (type === "session.compacted") return "completed";
  if (/compaction\.started/.test(type)) return "started";
  if (/compaction\.ended/.test(type)) return "ended";
  if (/compaction\.failed/.test(type)) return "failed";
  return undefined;
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
  // Cumulative cost/token telemetry (`session.usage`), also scanned from every
  // event so a Session-bearing event cannot silently stop reporting usage.
  maybeForwardUsage(sessionID, data, directory);

  // Compaction observability: normalize the several host event names onto one
  // status. `session_v2.time_compacting` is always NULL, so this is the only
  // reliable signal that a compaction happened.
  const compaction = compactionStatusOf(type);
  if (compaction) {
    const d = data as { reason?: unknown; data?: { reason?: unknown } } | undefined;
    const reason =
      typeof d?.reason === "string" ? d.reason : typeof d?.data?.reason === "string" ? d.data.reason : undefined;
    sendEvent(
      {
        type: "session.compaction",
        ...withGeneration(sessionID, { payload: { status: compaction, ...(reason ? { reason } : {}) } }),
      },
      directory
    );
    return;
  }

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
