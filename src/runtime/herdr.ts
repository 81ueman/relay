import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Worker } from "../schema";
import { MockRuntime, type Runtime, type RuntimeRecord, type StartedRuntime } from "./runtime";

// Herdr adapter. Verified against the installed CLI (herdr 0.8.2):
//   herdr agent get <target>                        exit 0 iff the agent exists
//   herdr agent prompt <target> <text>              fire-and-forget nudge
//   herdr agent send-keys <target> esc|ctrl+c
//   herdr agent read <target> --source recent-unwrapped --lines N
//   herdr agent start <NAME> --kind <KIND> --pane <ID> [--timeout MS]
//     (NAME: [a-z][a-z0-9_-]{0,31}, unique; pane must be at shell prompt)
//   herdr tab create --workspace <WS> --cwd <PATH> --no-focus [--env K=V] [--label T]
//     (returns .result.tab + .result.root_pane; never disturbs user layout)
//   herdr tab get <TAB_ID>                          -> .result.tab.label
//   herdr tab close <TAB_ID>                        (the only way we reap old tabs)
//   herdr agent list                                -> per-agent tab_id/workspace_id
// Agent lifecycle: idle | working | blocked | done | unknown.
// NOTE: Herdr idle/wait is NEVER a source of truth; only a wake transport.

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
 * Workspace the relay is allowed to spawn into. Explicit only: we NEVER let
 * `tab create` fall back to the focused workspace (that is how agents ended up
 * in an unrelated workspace). Fail closed when unset.
 */
export function herdrWorkspace(): string | null {
  const v = process.env.AGENTCTL_HERDR_WORKSPACE ?? process.env.HERDR_WORKSPACE_ID ?? "";
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

/** Resolve a tab id from a live agent name (fallback when history has no tab_id). */
function findTabIdByAgent(agentName: string): string | null {
  const r = runHerdr(["agent", "list"], 8000);
  if (!r.ok) return null;
  const parsed = tryParseJson(r.stdout);
  const agents: any[] = parsed?.result?.agents ?? [];
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
  `Load the agent-worker skill, then run \`agentctl next\` to claim work. ` +
  `Never wait for instructions; after each submit/block run \`agentctl next\` again.`;

export class HerdrRuntime implements Runtime {
  readonly name = "herdr";

  async isAlive(w: Worker): Promise<boolean> {
    return runHerdr(["agent", "get", herdrTarget(w)], 5000).ok;
  }

  async wake(w: Worker, text: string): Promise<void> {
    // No --wait: the daemon must never block on an agent turn.
    const r = runHerdr(["agent", "prompt", herdrTarget(w), text], 10000);
    if (!r.ok) throw new Error(`herdr wake failed for ${herdrTarget(w)}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  }

  async interrupt(w: Worker): Promise<void> {
    const r = runHerdr(["agent", "send-keys", herdrTarget(w), "esc"], 5000);
    if (!r.ok) throw new Error(`herdr interrupt failed for ${herdrTarget(w)}`);
  }

  /**
   * Spawn a brand-new generation in a fresh tab in the EXPLICIT relay
   * workspace. Returns Herdr metadata; the daemon records it as 'starting'
   * and only promotes it to 'active' after managed attach lands.
   */
  async start(w: Worker, generation: number): Promise<StartedRuntime> {
    const workspace = herdrWorkspace();
    if (!workspace) {
      throw new Error(
        "no Herdr workspace configured: set AGENTCTL_HERDR_WORKSPACE (or HERDR_WORKSPACE_ID); refusing to spawn into the focused workspace"
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
      "--env", "AGENTCTL_MANAGED=1",
      "--env", `AGENTCTL_WORKER=${w.id}`,
      "--env", `AGENTCTL_GENERATION=${generation}`,
    ];
    if (process.env.AGENTCTL_DB) envArgs.push("--env", `AGENTCTL_DB=${process.env.AGENTCTL_DB}`);
    if (process.env.AGENTCTL_SOCK) envArgs.push("--env", `AGENTCTL_SOCK=${process.env.AGENTCTL_SOCK}`);
    // The spawned agent must be able to resolve `agentctl`/`opencode` exactly
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
      // Best-effort bootstrap: a hiccup here must not abort an otherwise good spawn.
      try {
        await this.wake({ ...w, runtime_id: name }, BOOTSTRAP_PROMPT(w.id, generation, attachToken));
      } catch { /* the daemon's wake loop will kick it once active */ }
      if (!(await this.isAlive({ ...w, runtime_id: name }))) {
        throw new Error(`started agent ${name} is not reachable`);
      }
      return { runtimeId: name, tabId: tabId ?? undefined, paneId, attachToken };
    } catch (e) {
      // A brand-new tab that never produced a usable generation is rolled back
      // synchronously so it cannot leak as an untracked duplicate. OLD
      // generations are never closed here; they go through the async cleanup
      // pass after their grace period.
      if (tabId) closeRelayTab(w.id, generation, tabId);
      throw e;
    }
  }

  async restart(w: Worker, generation: number): Promise<StartedRuntime> {
    // Best effort: stop the current turn, then spawn a fresh generation.
    // Old tabs are deliberately left alone here; cleanup is a separate pass.
    try {
      await this.interrupt(w);
    } catch { /* already dead or unreachable */ }
    return this.start(w, generation);
  }

  /**
   * Reap one old generation's tab. Refuses unless it can PROVE relay ownership
   * via the `relay:<worker>:g<generation>` label. A refused/again-failing
   * cleanup just leaves the tab around; it never blocks fresh work.
   */
  async cleanup(rec: RuntimeRecord): Promise<void> {
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

/** Build the real transport when herdr is usable, else a DB-only mock. */
export function buildRuntime(): Runtime {
  if (process.env.AGENTCTL_RUNTIME === "mock") return new MockRuntime();
  if (process.env.HERDR_ENV !== "1" && !process.env.HERDR_SOCKET_PATH) {
    return new MockRuntime();
  }
  try {
    const probe = Bun.spawnSync(["herdr", "agent", "list"]);
    if (probe.exitCode !== 0) throw new Error("herdr CLI unavailable");
    return new HerdrRuntime();
  } catch {
    return new MockRuntime();
  }
}
