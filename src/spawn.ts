import { spawnSync } from "node:child_process";

/**
 * `relay worker spawn` / `relay worker reap` — one-command lane setup/teardown.
 *
 * Spawning a managed OpenCode worker was a 4-step manual sequence repeated
 * constantly (herdr worktree create -> herdr agent start -> relay worker
 * register -> prompt the agent to attach). This module orchestrates it, but
 * stays a THIN shell over the same primitives: it never reimplements Herdr and
 * never touches the managed-generation machinery (that is the daemon's, for
 * supervision/recovery). A spawned lane worker is an ADOPTED worker, exactly
 * like `relay worker register --runtime`.
 *
 * Invariants it must not break:
 *   - `agent_attach` is AGENT-DRIVEN: the OpenCode session id does not exist
 *     until the first turn, so spawn only PROMPTS the agent to attach.
 *   - Fail-closed + idempotent: a half-created lane must be resumable/clearly
 *     reported, never left silently registered with no pane.
 */

/** The outcome of one `herdr` invocation, decoupled so tests can inject a fake. */
export interface HerdrResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Injectable command runner (real Herdr by default; a fake in tests). */
export type HerdrRunner = (args: string[], timeoutMs?: number) => HerdrResult;

export function realHerdrRunner(): HerdrRunner {
  return (args, timeoutMs = 30000) => {
    const r = spawnSync("herdr", args, { encoding: "utf-8", timeout: timeoutMs, env: process.env });
    return { ok: r.status === 0, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
  };
}

function parseJson(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Deep-find the first value for `key` anywhere in a parsed Herdr response. */
function findKey(node: any, key: string): any {
  if (node == null || typeof node !== "object") return undefined;
  if (!Array.isArray(node) && key in node) return node[key];
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    const hit = findKey(v, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export interface SpawnOptions {
  id: string;
  role: string;
  kind?: string; // default "opencode"
  base?: string; // default "main"
  label?: string;
  cwd?: string; // use an EXISTING directory instead of creating a worktree
  pane?: string; // explicit root pane for `agent start`
  attach?: boolean; // default true: prompt the agent to attach
  timeoutMs?: number; // agent start timeout, default 90000
  /** Command runner override (tests). */
  run?: HerdrRunner;
}

export interface SpawnResult {
  workerId: string;
  role: string;
  kind: string;
  worktreePath: string;
  workspaceId: string | null;
  paneId: string | null;
  agentName: string;
  createdWorktree: boolean;
  attachPrompted: boolean;
  steps: string[];
}

/**
 * Create a lane worktree (unless `cwd` names an existing directory) and start
 * an agent in its root pane. Returns Herdr metadata; the CALLER registers the
 * worker and prompts the attach (kept separate so a failed registration can be
 * reported before any agent work starts).
 *
 * Herdr `worktree create --no-focus` returns the worktree root path and the
 * opened workspace; `agent start <name> --kind <k> --pane <p> --timeout <ms>`
 * starts the TUI in that workspace's root pane.
 */
export function createLane(opts: SpawnOptions): { worktreePath: string; workspaceId: string | null; paneId: string | null; agentName: string; createdWorktree: boolean; steps: string[] } {
  const run = opts.run ?? realHerdrRunner();
  const kind = opts.kind ?? "opencode";
  const steps: string[] = [];
  let worktreePath = opts.cwd ?? "";
  let workspaceId: string | null = null;
  let createdWorktree = false;

  if (!opts.cwd) {
    const base = opts.base ?? "main";
    const label = opts.label ?? opts.id.toUpperCase();
    const r = run(["worktree", "create", "--branch", opts.id, "--base", base, "--label", label, "--no-focus"], 60000);
    if (!r.ok) throw new Error(`herdr worktree create failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
    const parsed = parseJson(r.stdout);
    worktreePath = String(findKey(parsed, "path") ?? findKey(parsed, "worktree_path") ?? "").trim();
    workspaceId = (findKey(parsed, "open_workspace_id") ?? findKey(parsed, "workspace_id") ?? null) as string | null;
    createdWorktree = true;
    steps.push(`worktree create -> ${worktreePath || "(path unknown)"}${workspaceId ? ` ws=${workspaceId}` : ""}`);
    if (!worktreePath) throw new Error(`herdr worktree create returned no path: ${r.stdout.slice(0, 200)}`);
  }

  // The root pane of the lane's workspace; `agent start` requires an existing
  // pane. Explicit --pane wins; else derive from the worktree's workspace.
  let paneId = opts.pane ?? null;
  if (!paneId) {
    const list = run(["pane", "list", "--json"], 15000);
    const parsed = parseJson(list.stdout);
    const panes = (findKey(parsed, "panes") ?? []) as any[];
    const inWs = workspaceId ? panes.filter((p) => p?.workspace_id === workspaceId) : [];
    const root = inWs.find((p) => p?.is_root || p?.root) ?? inWs[0];
    paneId = (root?.id ?? root?.pane_id ?? null) as string | null;
  }

  const agentName = opts.id;
  const startArgs = ["agent", "start", agentName, "--kind", kind];
  if (paneId) startArgs.push("--pane", paneId);
  startArgs.push("--timeout", String(opts.timeoutMs ?? 90000));
  const started = run(startArgs, (opts.timeoutMs ?? 90000) + 15000);
  if (!started.ok) throw new Error(`herdr agent start failed: ${(started.stderr || started.stdout).trim().slice(0, 200)}`);
  steps.push(`agent start ${agentName} (kind=${kind})${paneId ? ` pane=${paneId}` : ""}`);

  return { worktreePath, workspaceId, paneId, agentName, createdWorktree, steps };
}

/** The attach prompt, kept in one place so spawn and docs agree. */
export function attachPrompt(workerId: string, paneId: string | null): string {
  const pane = paneId ? `pane_id="${paneId}"` : `pane_id=(your pane)`;
  return `Call the agent_attach tool with worker_id="${workerId}" and ${pane}. Reply one line.`;
}

/**
 * Tear a lane down: retire the worker, close its Herdr pane, remove the
 * worktree. Order is deliberate — retire first (so no further work is routed),
 * then close the pane, then remove the worktree. Each step is best-effort and
 * reported; a missing pane/worktree is not an error (idempotent reap).
 */
export function reapLane(opts: {
  workerId: string;
  paneId?: string | null;
  worktreePath?: string | null;
  run?: HerdrRunner;
}): string[] {
  const run = opts.run ?? realHerdrRunner();
  const steps: string[] = [];
  if (opts.paneId) {
    const r = run(["tab", "close", opts.paneId], 15000);
    steps.push(`tab close ${opts.paneId}: ${r.ok ? "ok" : "gone/failed"}`);
  }
  if (opts.worktreePath) {
    const r = run(["worktree", "remove", "--path", opts.worktreePath], 30000);
    steps.push(`worktree remove ${opts.worktreePath}: ${r.ok ? "ok" : "gone/failed"}`);
  }
  return steps;
}
