import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { listRuntimes } from "../runtimes";
import { STATE_DIR } from "../db";

/**
 * Herdr telemetry for the dashboard. Herdr is execution telemetry, never work
 * state: a pane being `idle` says nothing about task ownership.
 */

export interface PaneTelemetry {
  paneId: string;
  agent: string;
  agentStatus: string; // working / idle / blocked / done / unknown
  title: string;
  cwd: string;
  workspaceId: string;
  tabId: string;
  focused: boolean;
}

function herdrJson(args: string[], timeoutMs = 8000): any | null {
  try {
    // `env: process.env` matters: Bun's spawnSync otherwise resolves `herdr` with
    // the PATH captured at process start, so a runtime PATH change (e.g. a test
    // that puts a fake `herdr` first) is ignored.
    const r = spawnSync("herdr", args, { encoding: "utf-8", timeout: timeoutMs, env: process.env });
    if (r.status !== 0) return null;
    return JSON.parse(String(r.stdout ?? ""));
  } catch {
    return null;
  }
}

function herdrOk(args: string[], timeoutMs = 8000): boolean {
  try {
    const r = spawnSync("herdr", args, { encoding: "utf-8", timeout: timeoutMs, env: process.env });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function isUnder(path: string | null | undefined, root: string): boolean {
  if (!path) return false;
  const a = path.endsWith("/") ? path.slice(0, -1) : path;
  const b = root.endsWith("/") ? root.slice(0, -1) : root;
  return a === b || a.startsWith(b + "/");
}

/** Workspaces relay has actually placed a worker in (so the dashboard follows moves). */
export function relayWorkspaces(db: Database): string[] {
  const ws = new Set<string>();
  for (const r of listRuntimes(db)) if (r.workspace_id) ws.add(r.workspace_id);
  return [...ws];
}

/** Live Herdr panes, or null when Herdr is unavailable (not inside Herdr). */
export function readPanes(opts: {
  workspaces?: string[];
  /**
   * Pane ids relay has a runtime row for. A worker's pane is resolved by its OWN
   * runtime (pane_id / workspace_id), NOT by a cwd prefix: a Herdr WORKTREE pane
   * lives at ~/.herdr/worktrees/<repo>/<wt>, which is not under the repo root, so
   * a global cwd-root filter silently dropped it. Known panes bypass both filters;
   * cwdRoot remains only a best-effort for panes relay has no record of.
   */
  knownPanes?: Iterable<string>;
  cwdRoot?: string;
  excludePane?: string | null;
}): Map<string, PaneTelemetry> | null {
  if (process.env.HERDR_ENV !== "1") return null;
  const d = herdrJson(["pane", "list"]);
  if (!d) return null;
  const panes: PaneTelemetry[] = [];
  for (const p of d?.result?.panes ?? []) {
    const agent = p?.agent ?? "-";
    if (!agent || agent === "-") continue; // shells / one-off commands
    panes.push({
      paneId: p?.pane_id ?? "?",
      agent,
      agentStatus: p?.agent_status ?? "unknown",
      title: p?.terminal_title_stripped ?? p?.terminal_title ?? "",
      cwd: p?.cwd ?? "",
      workspaceId: p?.workspace_id ?? "",
      tabId: p?.tab_id ?? "",
      focused: !!p?.focused,
    });
  }
  const wsSet = new Set(opts.workspaces ?? []);
  const known = new Set(opts.knownPanes ?? []);
  let out = panes;
  if (wsSet.size) out = out.filter((p) => wsSet.has(p.workspaceId) || known.has(p.paneId));
  if (opts.cwdRoot) out = out.filter((p) => isUnder(p.cwd, opts.cwdRoot!) || known.has(p.paneId));
  if (opts.excludePane) out = out.filter((p) => p.paneId !== opts.excludePane);
  return new Map(out.map((p) => [p.paneId, p]));
}

// --------------------------------------------------------------------------- #
// dashboard pane (show / hide / reuse) — a UI pane, NOT a worker runtime
// --------------------------------------------------------------------------- #
const DASHBOARD_PANE = "dashboard-pane";

function paneFile(root: string): string {
  return join(root, STATE_DIR, DASHBOARD_PANE);
}

export function trackedPane(root: string): string | null {
  try {
    const p = paneFile(root);
    if (!existsSync(p)) return null;
    const v = readFileSync(p, "utf-8").trim();
    return v || null;
  } catch {
    return null;
  }
}

function paneAlive(pane: string): boolean {
  return herdrJson(["pane", "get", pane]) !== null;
}

export interface ShowResult {
  pane: string;
  created: boolean;
}

/**
 * Open (or reuse) a dashboard pane next to `target`, or in its own tab.
 * Only tracks panes relay itself created; `hide` closes only the tracked pane.
 */
export function showPane(opts: {
  root: string;
  command: string;
  target?: string | null;
  direction?: "right" | "down";
  tab?: boolean;
  tabLabel?: string;
  tabWorkspace?: string | null;
}): ShowResult {
  const old = trackedPane(opts.root);
  if (old && paneAlive(old)) return { pane: old, created: false };

  let pane: string | null = null;
  if (opts.tab) {
    const ws = opts.tabWorkspace ?? process.env.HERDR_WORKSPACE_ID ?? (opts.target ?? "").split(":")[0] ?? null;
    const argv = ["tab", "create"];
    if (ws) argv.push("--workspace", ws);
    argv.push("--cwd", opts.root, "--label", opts.tabLabel ?? "relay-dashboard", "--no-focus");
    const d = herdrJson(argv);
    pane = d?.result?.root_pane?.pane_id ?? null;
  } else if (opts.target) {
    const d = herdrJson(["pane", "split", "--pane", opts.target, "--direction", opts.direction ?? "right",
                         "--cwd", opts.root, "--no-focus"]);
    pane = d?.result?.pane?.pane_id ?? null;
  } else {
    const d = herdrJson(["pane", "split", "--current", "--direction", opts.direction ?? "right",
                         "--cwd", opts.root, "--no-focus"]);
    pane = d?.result?.pane?.pane_id ?? null;
  }
  if (!pane) throw new Error("failed to create a Herdr pane for the dashboard");
  writeFileSync(paneFile(opts.root), pane);
  herdrOk(["pane", "run", pane, opts.command]);
  return { pane, created: true };
}

/** Close only the tracked dashboard pane. */
export function hidePane(root: string): { pane: string | null; closed: boolean } {
  const pane = trackedPane(root);
  if (!pane) return { pane: null, closed: false };
  try {
    unlinkSync(paneFile(root));
  } catch { /* ignore */ }
  if (paneAlive(pane)) {
    herdrOk(["pane", "close", pane]);
    return { pane, closed: true };
  }
  return { pane, closed: false };
}

/** Focus a pane over the Herdr socket (`pane.focus`), for the OSC8 link handler. */
export function focusPane(paneId: string, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const path = process.env.HERDR_SOCKET_PATH;
    if (!path) return reject(new Error("HERDR_SOCKET_PATH is not set"));
    const sock = createConnection(path);
    let buf = "";
    const done = (err?: Error) => {
      try { sock.destroy(); } catch { /* ignore */ }
      err ? reject(err) : resolve();
    };
    sock.setTimeout(timeoutMs, () => done(new Error("herdr socket timeout")));
    sock.on("connect", () => {
      sock.write(JSON.stringify({ id: "relay-dashboard-focus", method: "pane.focus", params: { pane_id: paneId } }) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      if (!buf.includes("\n")) return;
      const line = buf.split("\n")[0];
      try {
        const res = JSON.parse(line);
        if (res && res.error) return done(new Error(String(res.error?.message ?? res.error)));
        done();
      } catch (e) {
        done(e as Error);
      }
    });
    sock.on("error", (e) => done(e));
  });
}
