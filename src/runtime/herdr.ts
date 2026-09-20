import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { Worker } from "../schema";
import {
  MockRuntime,
  type HerdrIdentity,
  type HerdrIdentityHint,
  type Runtime,
  type RuntimeRecord,
  type StartedRuntime,
} from "./runtime";

// Herdr adapter. Verified against the installed CLI (herdr 0.8.2):
//   herdr agent get <target>                        exit 0 iff the agent exists
//     (target may be an agent name OR a pane id, e.g. w62:p1)
//   herdr agent prompt <target> <text>              fire-and-forget nudge
//   herdr agent send-keys <target> esc|ctrl+c
//   herdr agent read <target> --source recent-unwrapped --lines N
//   herdr agent list                                -> per-agent name/pane_id/tab_id/workspace_id/agent_session
//   herdr agent start <NAME> --kind <KIND> --pane <ID> [--timeout MS]
//     (NAME: [a-z][a-z0-9_-]{0,31}, unique; pane must be at shell prompt)
//   herdr tab create --workspace <WS> --cwd <PATH> --no-focus [--env K=V] [--label T]
//     (returns .result.tab + .result.root_pane; never disturbs user layout)
//   herdr tab get <TAB_ID>                          -> .result.tab.label
//   herdr tab close <TAB_ID>                        (the only way we reap old tabs)
//   herdr pane get <PANE_ID>                         -> .result.pane (agent, agent_session, tab_id, workspace_id, cwd)
// Agent lifecycle: idle | working | blocked | done | unknown.
// NOTE: Herdr idle/wait is NEVER a source of truth; only a wake transport.
//
// Relay is Herdr-only. There is no tmux/other backend and no capability model:
// this is the single production transport.

function runHerdr(args: string[], timeoutMs = 8000): { ok: boolean; stdout: string; stderr: string } {
  try {
    const r = spawnSync("herdr", args, { encoding: "utf-8", timeout: timeoutMs });
    return { ok: r.status === 0, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e) };
  }
}

/** Single place where a Worker maps to a Herdr target. */
export function herdrTarget(w: Pick<Worker, "id" | "runtime_id">): string {
  return w.runtime_id ?? w.id;
}

/**
 * Resolve a worker to a target Herdr will actually accept, using the live agent
 * list. Herdr addresses an agent by name or by pane id, but a stored
 * `runtime_id` is not always a live target: a worker that was registered but
 * never completed a managed attach has `runtime_id = null`, while its agent is
 * running under the sanitized name (`u2-corpus` -> `u2_corpus`). Addressing it
 * by the bare worker id then fails with agent_not_found and the wake is lost.
 *
 * Preference order: the recorded runtime, the worker id, then the sanitized id;
 * each is accepted as a live agent name, or resolved to its pane. Falls back to
 * the recorded/id target so the caller still gets an honest error when nothing
 * matches.
 */
export function resolveHerdrTarget(
  w: Pick<Worker, "id" | "runtime_id">,
  agents: HerdrAgentEntry[]
): string {
  const candidates: string[] = [];
  if (w.runtime_id) candidates.push(w.runtime_id);
  candidates.push(w.id);
  const sanitized = w.id.replace(/-/g, "_");
  if (sanitized !== w.id) candidates.push(sanitized);
  const uniq = [...new Set(candidates)];
  const panes = new Set<string>();
  const paneByName = new Map<string, string>();
  for (const a of agents) {
    const pane = typeof a?.pane_id === "string" ? a.pane_id : "";
    if (pane) panes.add(pane);
    const name = typeof a?.name === "string" ? a.name : "";
    if (name && pane) paneByName.set(name, pane);
  }
  for (const c of uniq) {
    // A name resolves to its pane (always a valid target); a bare pane id is
    // used as-is. The recorded target is never returned unverified if a live
    // match exists.
    const pane = paneByName.get(c);
    if (pane) return pane;
    if (panes.has(c)) return c;
  }
  return uniq[0];
}

/**
 * Workspace the relay is allowed to spawn into. Explicit only: we NEVER let
 * `tab create` fall back to the focused workspace (that is how agents ended up
 * in an unrelated workspace). Fail closed when unset.
 */
export function herdrWorkspace(): string | null {
  const v = process.env.RELAY_HERDR_WORKSPACE ?? process.env.HERDR_WORKSPACE_ID ?? "";
  return v.trim() ? v.trim() : null;
}

function sanitizeAgentName(id: string): string {
  const s = id.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+/, "") || "worker";
  const base = (s.startsWith("-") ? `w${s}` : s).slice(0, 24);
  return base || "worker";
}

/** Agent name is unique per generation so an old tab never collides with a fresh spawn. */
export function agentNameFor(workerId: string, generation: number): string {
  const base = sanitizeAgentName(workerId).slice(0, 27);
  const suffix = `-g${generation}`;
  const name = `${base}${suffix}`.slice(0, 32);
  return /^[a-z]/.test(name) ? name : `w${name}`.slice(0, 32);
}

/** Relay-owned tab label; used to prove ownership before any cleanup. */
export function relayTabLabel(workerId: string, generation: number): string {
  return `relay:${workerId}:g${generation}`;
}

function tryParseJson(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** Defensively extract the new root pane id from `tab create` output. */
function extractRootPaneId(parsed: any): string | null {
  const result = parsed?.result ?? parsed;
  const candidates = [
    result?.root_pane?.pane_id,
    result?.root_pane,
    result?.pane?.pane_id,
    result?.pane,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.includes(":p")) return c;
  }
  return null;
}

/** Defensively extract the new tab id from `tab create` output. */
function extractTabId(parsed: any): string | null {
  const result = parsed?.result ?? parsed;
  const candidates = [result?.tab?.tab_id, result?.tab_id, result?.tab];
  for (const c of candidates) {
    if (typeof c === "string" && c.includes(":t")) return c;
  }
  return null;
}

export interface HerdrAgentEntry {
  name?: string | null;
  agent?: string | null;
  pane_id?: string | null;
  tab_id?: string | null;
  workspace_id?: string | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  agent_session?: { value?: unknown } | null;
}

/** Live Herdr agents. Throws when Herdr itself cannot be queried. */
function listAgents(): HerdrAgentEntry[] {
  const r = runHerdr(["agent", "list"], 8000);
  if (!r.ok) throw new Error(`herdr agent list failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  const parsed = tryParseJson(r.stdout);
  return (parsed?.result?.agents ?? []) as HerdrAgentEntry[];
}

/** One pane's live info, or null when the pane does not exist. */
function getPaneInfo(paneId: string): HerdrAgentEntry | null {
  const r = runHerdr(["pane", "get", paneId], 5000);
  if (!r.ok) return null;
  const parsed = tryParseJson(r.stdout);
  const pane = parsed?.result?.pane;
  return pane && typeof pane === "object" ? (pane as HerdrAgentEntry) : null;
}

/** Resolve a tab id from a live agent name (fallback when history has no tab_id). */
function findTabIdByAgent(agentName: string): string | null {
  let agents: HerdrAgentEntry[];
  try {
    agents = listAgents();
  } catch {
    return null;
  }
  // `agent list` entries carry the agent NAME in `name`; `agent` is the kind
  // (e.g. "opencode"). Match on the name.
  const hit = agents.find((a) => a?.name === agentName);
  return typeof hit?.tab_id === "string" ? hit.tab_id : null;
}

function getTabLabel(tabId: string): string | null {
  const r = runHerdr(["tab", "get", tabId], 5000);
  if (!r.ok) return null;
  const parsed = tryParseJson(r.stdout);
  const label = parsed?.result?.tab?.label;
  return typeof label === "string" ? label : null;
}

/** True if the tab still exists. On an unreadable list we answer true (stay safe). */
function tabExists(tabId: string): boolean {
  const r = runHerdr(["tab", "list"], 8000);
  if (!r.ok) return true;
  const parsed = tryParseJson(r.stdout);
  const tabs: any[] = parsed?.result?.tabs ?? [];
  return tabs.some((t) => t?.tab_id === tabId);
}

/** Retry `agent start` a few times: a freshly created tab's shell may not be ready yet. */
async function startAgentWithRetry(name: string, paneId: string): Promise<void> {
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await Bun.sleep(1500);
    const r = runHerdr(["agent", "start", name, "--kind", "opencode", "--pane", paneId, "--timeout", "60000"], 75000);
    if (r.ok || runHerdr(["agent", "get", name], 5000).ok) return;
    lastErr = (r.stderr || r.stdout).trim().slice(0, 200);
  }
  throw new Error(`herdr agent start failed in ${paneId}: ${lastErr}`);
}

/** Best-effort rollback of a tab WE just created and failed to bring up. */
function closeRelayTab(workerId: string, generation: number, tabId: string): void {
  try {
    if (getTabLabel(tabId) !== relayTabLabel(workerId, generation)) return; // not provably ours
    runHerdr(["tab", "close", tabId], 10000);
  } catch { /* best effort */ }
}

export const BOOTSTRAP_PROMPT = (workerId: string, generation: number, attachToken?: string) =>
  // The first line is a machine-readable marker the relay plugin reads out of
  // this session's own prompt text to auto-attach the RIGHT session. A shared
  // OpenCode server has no per-session env, and may host sessions from several
  // projects at once, so identity travels with the prompt. The attach token is
  // the per-spawn secret the daemon demands before it accepts the attach, which
  // stops a stale or foreign plugin from binding a session it does not own.
  `RELAY-ATTACH worker=${workerId} gen=${generation}${attachToken ? ` token=${attachToken}` : ""}\n` +
  `You are managed by the relay supervisor as worker ${workerId} (generation ${generation}). ` +
  `Load the agent-worker skill, then run \`relay next\` to claim work. ` +
  `Never wait for instructions; after each submit/block run \`relay next\` again.`;

/** Best-effort normalization of a directory for comparison (symlinks, trailing slash). */
function normalizeDir(p: string | null | undefined): string | null {
  if (!p || !p.trim()) return null;
  try {
    return realpathSync(resolvePath(p));
  } catch {
    return resolvePath(p);
  }
}

/** Lenient compatibility: exact, or one is an ancestor of the other. Unprovable => compatible. */
function dirsCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeDir(a);
  const nb = normalizeDir(b);
  if (!na || !nb) return true;
  return na === nb || na.startsWith(nb + "/") || nb.startsWith(na + "/");
}

/**
 * Strict directory overlap for IDENTIFYING a pane: both sides must be known and
 * equal or in an ancestor/descendant relationship. An unknown pane cwd never
 * matches (a pane with no cwd must not manufacture ambiguity).
 */
function dirsOverlap(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeDir(a);
  const nb = normalizeDir(b);
  if (!na || !nb) return false;
  return na === nb || na.startsWith(nb + "/") || nb.startsWith(na + "/");
}

/**
 * Pure directory -> identity resolution. Used when the caller has no pane hint
 * (e.g. this plugin on a shared OpenCode server, whose process env cannot name
 * the session's pane). Exactly one live `opencode` agent must run in the
 * session directory; zero or many is rejected (never guess).
 */
export function pickIdentityByDirectory(
  agents: HerdrAgentEntry[],
  sessionId: string,
  directory: string
): HerdrIdentity {
  const matches = agents.filter(
    (a) => a?.agent === "opencode" && dirsOverlap(directory, a.foreground_cwd ?? a.cwd)
  );
  if (matches.length === 0) {
    throw new Error(`session ${sessionId} is not running inside Herdr (no opencode agent with cwd ${directory})`);
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous Herdr identity for ${sessionId}: ${matches.length} opencode agents in ${directory}`);
  }
  return identityFromAgent(matches[0]);
}

function identityFromAgent(a: HerdrAgentEntry): HerdrIdentity {
  const paneId = typeof a.pane_id === "string" ? a.pane_id : "";
  const tabId = typeof a.tab_id === "string" ? a.tab_id : "";
  if (!paneId || !tabId) throw new Error("Herdr agent entry is missing pane_id/tab_id");
  const agent = typeof a.name === "string" && a.name ? a.name : paneId; // pane id is a valid target
  return {
    agent,
    tabId,
    paneId,
    workspaceId: typeof a.workspace_id === "string" ? a.workspace_id : null,
    agentKind: typeof a.agent === "string" ? a.agent : "unknown",
  };
}

export class HerdrRuntime implements Runtime {
  readonly name = "herdr";

  /**
   * Live Herdr target for a worker: the stored runtime when it still resolves,
   * otherwise the sanitized agent name. See resolveHerdrTarget.
   */
  private target(w: Worker): string {
    try {
      return resolveHerdrTarget(w, listAgents());
    } catch {
      return herdrTarget(w); // Herdr unreachable: keep the recorded target
    }
  }

  async isAlive(w: Worker): Promise<boolean> {
    return runHerdr(["agent", "get", this.target(w)], 5000).ok;
  }

  async wake(w: Worker, text: string): Promise<void> {
    // No --wait: the daemon must never block on an agent turn.
    const target = this.target(w);
    const r = runHerdr(["agent", "prompt", target, text], 10000);
    if (!r.ok) throw new Error(`herdr wake failed for ${target}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  }

  async interrupt(w: Worker): Promise<void> {
    const target = this.target(w);
    const r = runHerdr(["agent", "send-keys", target, "esc"], 5000);
    if (!r.ok) throw new Error(`herdr interrupt failed for ${target}`);
  }

  /**
   * Resolve the Herdr identity of a live OpenCode session for manual attach.
   * Order of trust:
   *   1. A pane that itself reported this exact session id (`agent_session`).
   *   2. Directory identification (`hint.directory`, no `hint.paneId`): exactly
   *      one live opencode agent runs in that directory. This is how a session
   *      on a shared OpenCode server is resolved, since that server's process
   *      env cannot name the session's pane.
   *   3. A caller-supplied pane hint, but only after verifying the pane exists,
   *      runs an opencode agent, and is consistent with the hint (tab/workspace/
   *      session-id/cwd). Ambiguous or unverifiable => throw (never guess).
   */
  async resolveIdentity(input: { sessionId: string; hint?: HerdrIdentityHint }): Promise<HerdrIdentity> {
    const { sessionId, hint } = input;
    const agents = listAgents();

    // 1. Authoritative: Herdr itself maps the session to a pane.
    const reported = agents.filter((a) => a?.agent_session && a.agent_session.value === sessionId);
    if (reported.length > 1) {
      throw new Error(`ambiguous Herdr identity for ${sessionId}: ${reported.length} panes report this session`);
    }
    if (reported.length === 1) return identityFromAgent(reported[0]);

    // 2. No pane hint: identify the pane by the session's working directory. A
    // shared OpenCode server cannot supply a per-session pane env, but the
    // session directory plus live Herdr state DOES identify the pane when it is
    // unique. Zero or many matches is rejected (never guess).
    const paneId = hint?.paneId;
    if (!paneId) {
      if (hint?.directory) return pickIdentityByDirectory(agents, sessionId, hint.directory);
      throw new Error(`session ${sessionId} is not running inside Herdr (no pane mapping and no pane supplied)`);
    }
    const pane = getPaneInfo(paneId);
    if (!pane) throw new Error(`session ${sessionId} is not running inside Herdr (pane ${paneId} not found)`);
    if (hint?.tabId && typeof pane.tab_id === "string" && pane.tab_id !== hint.tabId) {
      throw new Error(`session ${sessionId}: pane ${paneId} is in tab ${pane.tab_id}, not ${hint.tabId}`);
    }
    if (hint?.workspaceId && typeof pane.workspace_id === "string" && pane.workspace_id !== hint.workspaceId) {
      throw new Error(`session ${sessionId}: pane ${paneId} is in workspace ${pane.workspace_id}, not ${hint.workspaceId}`);
    }
    if (typeof pane.agent === "string" && pane.agent !== "opencode") {
      throw new Error(`session ${sessionId}: pane ${paneId} is running ${pane.agent}, not opencode`);
    }
    if (pane.agent_session && pane.agent_session.value && pane.agent_session.value !== sessionId) {
      throw new Error(`session ${sessionId}: pane ${paneId} reports a different session`);
    }
    if (!dirsCompatible(hint?.directory, pane.foreground_cwd ?? pane.cwd)) {
      throw new Error(`session ${sessionId}: pane ${paneId} cwd does not match the session directory`);
    }

    const entry = agents.find((a) => a?.pane_id === paneId);
    if (!entry) throw new Error(`session ${sessionId}: no live Herdr agent in pane ${paneId}`);
    const identity = identityFromAgent(entry);
    if (identity.agentKind !== "opencode") {
      throw new Error(`session ${sessionId}: pane ${paneId} is not an opencode agent`);
    }
    return identity;
  }

  /**
   * Spawn a brand-new generation in a fresh tab in the EXPLICIT relay
   * workspace. Returns Herdr metadata; the daemon records it as 'starting'
   * (relay_owned=true) and only promotes it to 'active' after managed attach.
   */
  async start(w: Worker, generation: number): Promise<StartedRuntime> {
    const workspace = herdrWorkspace();
    if (!workspace) {
      throw new Error(
        "no Herdr workspace configured: set RELAY_HERDR_WORKSPACE (or HERDR_WORKSPACE_ID); refusing to spawn into the focused workspace"
      );
    }
    const cwd = w.cwd ?? process.cwd();
    const name = agentNameFor(w.id, generation);
    const attachToken = randomUUID();
    if (runHerdr(["agent", "get", name], 5000).ok) {
      // The target name already exists. If its tab is provably a relay tab for
      // THIS worker+generation it is a leftover from an earlier attempt or run
      // (e.g. the daemon crashed after create but before recording), so reap it
      // and spawn clean rather than failing forever. Anything else is not ours:
      // refuse instead of clobbering an unrelated agent.
      const staleTab = findTabIdByAgent(name);
      const expected = relayTabLabel(w.id, generation);
      if (staleTab && getTabLabel(staleTab) === expected) {
        runHerdr(["tab", "close", staleTab], 10000);
        for (let i = 0; i < 8 && runHerdr(["agent", "get", name], 3000).ok; i++) await Bun.sleep(500);
      } else {
        throw new Error(`agent ${name} already exists and is not a relay tab for ${expected}`);
      }
    }

    const envArgs: string[] = [
      "--env", "RELAY_MANAGED=1",
      "--env", `RELAY_WORKER=${w.id}`,
      "--env", `RELAY_GENERATION=${generation}`,
    ];
    if (process.env.RELAY_DB) envArgs.push("--env", `RELAY_DB=${process.env.RELAY_DB}`);
    if (process.env.RELAY_SOCK) envArgs.push("--env", `RELAY_SOCK=${process.env.RELAY_SOCK}`);
    // The spawned agent must be able to resolve `relay`/`opencode` exactly
    // like the daemon does; tab shells do not inherit the daemon's PATH.
    if (process.env.PATH) envArgs.push("--env", `PATH=${process.env.PATH}`);

    const tab = runHerdr(
      ["tab", "create", "--workspace", workspace, "--cwd", cwd, "--no-focus", "--label", relayTabLabel(w.id, generation), ...envArgs],
      15000
    );
    if (!tab.ok) throw new Error(`herdr tab create failed: ${(tab.stderr || tab.stdout).trim().slice(0, 200)}`);
    const parsed = tryParseJson(tab.stdout);
    const paneId = extractRootPaneId(parsed);
    const tabId = extractTabId(parsed);
    if (!paneId) {
      if (tabId) closeRelayTab(w.id, generation, tabId);
      throw new Error(`herdr tab create returned no pane id: ${tab.stdout.slice(0, 200)}`);
    }

    try {
      await startAgentWithRetry(name, paneId);
      // NOTE: `start` is a transport primitive ONLY. It does NOT send the
      // bootstrap prompt and does NOT touch the DB: the supervisor must first
      // durably record this generation (relay_owned, attach_token) and only then
      // deliver the bootstrap, so a matching runtime row always exists at the
      // instant the session attaches.
      if (!(await this.isAlive({ ...w, runtime_id: name }))) {
        throw new Error(`started agent ${name} is not reachable`);
      }
      return { runtimeId: name, tabId: tabId ?? undefined, paneId, workspaceId: workspace, attachToken };
    } catch (e) {
      // A brand-new tab that never produced a usable generation is rolled back
      // synchronously so it cannot leak as an untracked duplicate. OLD
      // generations are never closed here; they go through the async cleanup
      // pass after their grace period.
      if (tabId) closeRelayTab(w.id, generation, tabId);
      throw e;
    }
  }

  /**
   * Reap one old generation's tab. Refuses non-relay-owned runtimes outright,
   * and otherwise refuses unless it can PROVE relay ownership via the
   * `relay:<worker>:g<generation>` label. A refused/again-failing cleanup just
   * leaves the tab around; it never blocks fresh work.
   */
  async cleanup(rec: RuntimeRecord): Promise<void> {
    if (rec.relay_owned !== undefined && rec.relay_owned === 0) {
      throw new Error(`refusing to clean non-relay-owned runtime ${rec.worker_id}:g${rec.generation}`);
    }
    let tabId = rec.tab_id;
    if (!tabId && rec.runtime_id) tabId = findTabIdByAgent(rec.runtime_id);
    if (!tabId) {
      throw new Error(`cannot resolve tab for runtime ${rec.runtime_id ?? rec.worker_id}:g${rec.generation}; refusing cleanup`);
    }
    const expected = relayTabLabel(rec.worker_id, rec.generation);
    const label = getTabLabel(tabId);
    if (label === null) {
      // The tab is already gone: there is nothing left to reap, and recording
      // it as cleaned stops a pointless retry loop. If the tab still exists but
      // its label is unreadable we refuse (never close something unverified).
      if (!tabExists(tabId)) return;
      throw new Error(`cannot read label for tab ${tabId}; refusing cleanup`);
    }
    if (label !== expected) throw new Error(`tab ${tabId} label "${label}" != "${expected}"; refusing cleanup`);
    const close = runHerdr(["tab", "close", tabId], 10000);
    if (!close.ok) throw new Error(`herdr tab close ${tabId} failed: ${(close.stderr || close.stdout).trim().slice(0, 200)}`);
  }

  async peek(w: Worker): Promise<string> {
    const r = runHerdr(["agent", "read", herdrTarget(w), "--source", "recent-unwrapped", "--lines", "60"], 8000);
    return r.ok ? r.stdout : "";
  }
}

/**
 * Build the production transport. Relay REQUIRES Herdr: when the CLI/socket is
 * unavailable the daemon must fail fast with a clear error, never silently fall
 * back to a mock (the mock is only for tests, injected via DaemonOptions.runtime).
 */
export function buildRuntime(): Runtime {
  // Explicit, non-silent test/dev opt-in only.
  if (process.env.RELAY_RUNTIME === "mock") return new MockRuntime();
  if (process.env.HERDR_ENV !== "1" && !process.env.HERDR_SOCKET_PATH) {
    throw new Error(
      "relay requires Herdr; herdr CLI/socket is unavailable (no HERDR_ENV/HERDR_SOCKET_PATH). MockRuntime is test-only; run inside Herdr or set RELAY_RUNTIME=mock for tests."
    );
  }
  if (!runHerdr(["agent", "list"], 8000).ok) {
    throw new Error("relay requires Herdr; herdr CLI/socket is unavailable (herdr agent list failed)");
  }
  return new HerdrRuntime();
}
