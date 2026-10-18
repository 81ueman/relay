import { spawnSync } from "node:child_process";
import type { Database } from "bun:sqlite";
import { now } from "../db";
import { unreadCounts } from "../messages";
import { findRuntime, listRuntimes } from "../runtimes";
import { getNotes, listTasks, taskCounts, unclaimableRunnableTasks } from "../tasks";
import { toolHardCapMs, toolMaxMs, toolNoOutputMs, toolWarnMs, unresponsiveWindowMs } from "../scheduler";
import { listWorkers, isHeadlessWorker, quietActive, type WorkerRow } from "../workers";
import type { Task, WorkerRuntime } from "../schema";
import { readPanes, relayWorkspaces, type PaneTelemetry } from "./herdr";
import { buildAffinity, NO_AFFINITY, type WorkerAffinity, type WorkerCluster } from "./affinity";

/**
 * Dashboard view model. Built ONLY from Relay domain functions + Herdr
 * telemetry: Worker (durable identity) and Runtime (disposable generation) stay
 * separate here; the renderer overlays the current runtime onto the worker row.
 */

export type ExecutionState = "busy" | "idle" | "quiet" | "!idle" | "starting" | "unavailable";

export interface DashboardTaskNode {
  id: string;
  title: string;
  state: string;
  role: string | null;
  assignee: string | null;
  parent: string | null;
  priority: number | null;
  updatedAt: number;
  depth: number;
  children: DashboardTaskNode[];
  allDone: boolean;
  /** True when this node has children (a roll-up / group node, never a work unit). */
  isContainer: boolean;
  subtreeSize: number;
}

export interface DashboardRuntime {
  generation: number | null;
  state: string | null;
  relayOwned: number | null;
  runtimeId: string | null;
  paneId: string | null;
}

export interface DashboardOldRuntime extends DashboardRuntime {
  cleanupOverdue: boolean;
}

export interface DashboardWorker {
  id: string;
  role: string;
  state: string; // Relay worker state
  taskId: string | null;
  exec: ExecutionState; // Herdr execution telemetry (separate column; renderer uses this)
  execution: { state: ExecutionState; paneId: string | null; agentStatus: string | null }; // nested for --json
  generation: number;
  paneId: string | null;
  /**
   * ISH-904: whether a visible Herdr runtime pane is EXPECTED for this worker.
   * Headless principals (the Factory's `claude-review`/`factory-integrator`) have
   * no pane, so "starting for a while" / "no visible runtime pane" would be a
   * permanent false ATTENTION. The surface and `relay status` must agree.
   */
  paneSupervised: boolean;
  progressAgeMs: number | null;
  /**
   * In-flight tool telemetry (`tool.started`/`tool.execute.after`), surfaced for
   * early hang detection. `null` when no tool is currently running. Read-only:
   * never part of Relay state.
   */
  tool: { name: string; command: string | null; ageMs: number; timeoutMs: number | null } | null;
  quietRemainingMs: number | null;
  quietReason: string | null;
  unread: number;
  runtime: DashboardRuntime; // current runtime (JSON keeps the split)
  oldRuntimes: DashboardOldRuntime[];
  /**
   * DERIVED task affinity used to group the WORKERS section. Not a stored
   * relationship: recomputed each build, and never a worker hierarchy.
   */
  affinity: WorkerAffinity;
}

export interface DashboardAttention {
  kind: "worker" | "task";
  id: string;
  text: string;
  ageMs: number | null;
}

export interface DashboardGit {
  branch: string;
  headSha: string;
  head: string;
  dirty: number;
}

export interface DashboardView {
  root: string;
  summary: {
    total: number;
    done: number;
    /** Container / roll-up nodes (excluded from `total` and `counts`). */
    groups: number;
    counts: Record<string, number>;
    workers: number;
    working: number;
    herdr: boolean;
  };
  taskForest: DashboardTaskNode[];
  tasksById: Record<string, DashboardTaskNode>;
  workers: DashboardWorker[];
  /**
   * WORKERS-section projection: flat peers grouped by derived task affinity.
   * Clusters follow WORK preorder; the ungrouped bucket (`clusterTaskId: null`)
   * is last. Display only — no durable grouping exists.
   */
  workerClusters: WorkerCluster[];
  attention: DashboardAttention[];
  git: DashboardGit;
}

const TASK_STATE_ORDER = ["running", "queued", "review", "blocked_human", "blocked_internal", "failed"];

export interface BuildOptions {
  /** Repo root (defaults derived from the DB path by the caller). */
  root: string;
  /** Injected panes for tests; otherwise read live Herdr state. */
  panes?: Map<string, PaneTelemetry> | null;
  /** Exclude this pane (the dashboard's own pane). */
  excludePane?: string | null;
  at?: number;
}

export function buildDashboardView(db: Database, opts: BuildOptions): DashboardView {
  const at = opts.at ?? now();
  const root = opts.root;

  // Runtimes are read FIRST so their pane ids can be handed to readPanes as
  // `knownPanes`: a worker's pane is resolved by its OWN runtime, not by a
  // global cwd-root prefix (a Herdr worktree pane lives outside the repo root).
  const runtimeRows = listRuntimes(db);
  const runtimesByWorker = new Map<string, WorkerRuntime[]>();
  for (const r of runtimeRows) {
    const arr = runtimesByWorker.get(r.worker_id) ?? [];
    arr.push(r);
    runtimesByWorker.set(r.worker_id, arr);
  }
  const knownPanes = new Set(runtimeRows.map((r) => r.pane_id).filter((p): p is string => !!p));

  const panes = opts.panes !== undefined
    ? opts.panes
    : readPanes({ workspaces: relayWorkspaces(db), knownPanes, cwdRoot: root, excludePane: opts.excludePane ?? null });
  const herdrOn = panes !== null;

  // ---- tasks: a forest by parent_task_id (work decomposition only) ----------
  const tasks = listTasks(db);
  const { forest, byId } = buildForest(tasks);

  // ---- workers: durable identity + its CURRENT runtime ----------------------
  const unread = new Map(unreadCounts(db).map((u) => [u.recipient, u.queued + u.delivered]));

  const workers: DashboardWorker[] = listWorkers(db).map((w) => {
    const rows = runtimesByWorker.get(w.id) ?? [];
    const current = findRuntime(db, w.id, w.generation)
      ?? rows.find((r) => r.generation === w.generation)
      ?? null;
    const pane = current?.pane_id ? panes?.get(current.pane_id) ?? null : null;
    const qActive = quietActive(w, at);
    const quietRemainingMs = w.quiet_until != null && w.quiet_until > at ? w.quiet_until - at : null;
    const old = rows
      .filter((r) => r.id !== current?.id && r.state !== "cleaned")
      .map<DashboardOldRuntime>((r) => ({
        generation: r.generation,
        state: r.state,
        relayOwned: r.relay_owned,
        runtimeId: r.runtime_id,
        paneId: r.pane_id,
        cleanupOverdue: r.relay_owned === 1 && r.state !== "active" && r.state !== "starting"
          && r.cleanup_after != null && r.cleanup_after <= at,
      }));
    const execLabel = executionState(w, pane, qActive, herdrOn);
    const tool = w.tool_started_at != null && w.tool_name
      ? {
          name: w.tool_name,
          command: w.tool_command,
          ageMs: Math.max(0, at - w.tool_started_at),
          timeoutMs: w.tool_timeout_ms,
        }
      : null;
    return {
      id: w.id,
      role: w.role,
      state: w.state,
      taskId: w.current_task_id,
      exec: execLabel,
      execution: { state: execLabel, paneId: current?.pane_id ?? null, agentStatus: pane?.agentStatus ?? null },
      generation: w.generation,
      paneId: current?.pane_id ?? null,
      paneSupervised: !isHeadlessWorker(w),
      progressAgeMs: w.last_progress_at ? Math.max(0, at - w.last_progress_at) : null,
      tool,
      quietRemainingMs,
      quietReason: w.quiet_reason,
      unread: unread.get(w.id) ?? 0,
      runtime: {
        generation: current?.generation ?? null,
        state: current?.state ?? null,
        relayOwned: current?.relay_owned ?? null,
        runtimeId: current?.runtime_id ?? null,
        paneId: current?.pane_id ?? null,
      },
      oldRuntimes: old,
      affinity: NO_AFFINITY, // overwritten below, once the forest is known
    };
  });
  workers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // ---- worker -> task affinity (DERIVED; grouping projection only) ----------
  // Built from the SAME forest the WORK section renders, so cluster order
  // matches WORK preorder. Reuses `claimableRunnableTasks` / `reviewTasks`
  // rather than reimplementing role matching, and writes nothing to the DB.
  const workerState = new Map(workers.map((w) => [w.id, w.state]));
  const affinity = buildAffinity(db, workers.map((w) => w.id), {
    forest,
    tasksById: byId,
    stateOf: (id) => workerState.get(id) ?? "idle",
  });
  for (const w of workers) w.affinity = affinity.byWorker.get(w.id) ?? NO_AFFINITY;

  // ---- attention (derived only; never written to the DB) --------------------
  const attention = deriveAttention(db, workers, tasks, at);

  const counts = taskCounts(db);
  const containers = tasks.filter((t) => byId[t.id].isContainer);
  // Containers are structure, not work: keep them out of the work counts so the
  // summary reads the same whether or not a roll-up was introduced.
  for (const t of containers) counts[t.state] = Math.max(0, (counts[t.state] ?? 0) - 1);
  const view: DashboardView = {
    root,
    summary: {
      total: tasks.length - containers.length,
      done: counts["done"] ?? 0,
      groups: containers.length,
      counts,
      workers: workers.length,
      working: workers.filter((w) => w.state === "working").length,
      herdr: herdrOn,
    },
    taskForest: forest,
    tasksById: byId,
    workers,
    workerClusters: affinity.clusters,
    attention,
    git: readGit(root),
  };
  return view;
}

function executionState(
  w: WorkerRow,
  pane: PaneTelemetry | null,
  quiet: boolean,
  herdrOn: boolean
): ExecutionState {
  if (!herdrOn) return "unavailable";
  if (w.state === "starting") return "starting";
  if (pane && pane.agentStatus === "working") return "busy";
  if (quiet) return "quiet";
  if (w.state === "working" && w.current_task_id && pane) return "!idle";
  if (!pane) return "unavailable";
  return "idle";
}

export function buildForest(tasks: Task[]): { forest: DashboardTaskNode[]; byId: Record<string, DashboardTaskNode> } {
  const byId: Record<string, DashboardTaskNode> = {};
  for (const t of tasks) {
    byId[t.id] = {
      id: t.id, title: t.title, state: t.state, role: t.role, assignee: t.assignee,
      parent: t.parent_task_id, priority: t.priority, updatedAt: t.updated_at,
      depth: 0, children: [], allDone: false, isContainer: false, subtreeSize: 1,
    };
  }
  const order: Record<string, number> = {};
  TASK_STATE_ORDER.forEach((s, i) => (order[s] = i));
  order["done"] = TASK_STATE_ORDER.length;
  // ISH-808: the other terminal state. Ordered with `done` (bottom), still
  // rendered, never surfaced as ATTENTION (deriveAttention only flags non-terminal
  // blockers).
  order["cancelled"] = TASK_STATE_ORDER.length + 1;
  const cmp = (a: DashboardTaskNode, b: DashboardTaskNode) =>
    (order[a.state] ?? 99) - (order[b.state] ?? 99)
    || (b.priority ?? 0) - (a.priority ?? 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const forest: DashboardTaskNode[] = [];
  const childrenOf = new Map<string, DashboardTaskNode[]>();
  for (const t of tasks) {
    const node = byId[t.id];
    const p = t.parent_task_id;
    if (p && byId[p] && p !== t.id) {
      const arr = childrenOf.get(p) ?? [];
      arr.push(node);
      childrenOf.set(p, arr);
    } else {
      forest.push(node);
    }
  }
  // attach + post-order sizes (orphan/cycle safe: a node is reachable once)
  const seen = new Set<string>();
  const visit = (n: DashboardTaskNode, depth: number): { size: number; allDone: boolean } => {
    seen.add(n.id);
    n.depth = depth;
    const kids = (childrenOf.get(n.id) ?? []).filter((k) => !seen.has(k.id));
    kids.sort(cmp);
    n.children = kids;
    n.isContainer = kids.length > 0;
    let size = 1;
    let allDone = n.state === "done";
    for (const k of kids) {
      const r = visit(k, depth + 1);
      size += r.size;
      allDone = allDone && r.allDone;
    }
    n.subtreeSize = size;
    n.allDone = allDone;
    return { size, allDone };
  };
  forest.sort(cmp);
  for (const r of forest) if (!seen.has(r.id)) visit(r, 0);
  for (const t of tasks) if (!seen.has(byId[t.id].id)) visit(byId[t.id], 0); // cycles
  return { forest, byId };
}

function deriveAttention(
  db: Database,
  workers: DashboardWorker[],
  tasks: Task[],
  at: number
): DashboardAttention[] {
  const out: DashboardAttention[] = [];
  for (const w of workers) {
    if (w.state === "dead" || w.state === "stalled") {
      out.push({ kind: "worker", id: w.id, text: `${w.state} generation=${w.generation}`, ageMs: null });
    }
    if (w.state === "working" && w.exec === "!idle") {
      out.push({ kind: "worker", id: w.id, ageMs: w.progressAgeMs,
                 text: `${w.taskId ?? "-"} working but runtime idle, no quiet lease` });
    }
    // Tools are STATUS on the WORKERS row (`tool:<name> <age>`). They rise to
    // ATTENTION when they are ACTIONABLE: past their own timeout, past the HARD
    // CAP, past the no-output window (a wedged long-budget tool must not wait out
    // its whole budget — T345), or stale (no finish event was ever seen).
    if (w.tool) {
      const cap = toolHardCapMs();
      const noOut = toolNoOutputMs();
      const pastBudget = w.tool.timeoutMs != null && w.tool.ageMs > w.tool.timeoutMs;
      const pastCap = cap > 0 && w.tool.ageMs > cap && w.tool.ageMs > toolWarnMs();
      const noOutput = noOut > 0 && w.tool.ageMs > noOut;
      const overdue = pastBudget || pastCap || noOutput;
      const stale = w.tool.ageMs > toolMaxMs();
      if (overdue || stale) {
        const budget = w.tool.timeoutMs != null ? `, timeout ${Math.round(w.tool.timeoutMs / 1000)}s` : "";
        const cmd = w.tool.command ? `: ${w.tool.command}` : "";
        out.push({ kind: "worker", id: w.id, ageMs: w.tool.ageMs,
                   text: `tool ${w.tool.name} ${stale ? "stale" : "overdue"}${cmd}${budget}` });
      }
    }
    if (w.paneSupervised && w.state === "starting" && (w.progressAgeMs ?? 0) > 120_000) {
      out.push({ kind: "worker", id: w.id, ageMs: null, text: `starting for a while (attach stuck?)` });
    }
    // `unread messages` is STATUS, not attention: it lives on the WORKERS row
    // (`mail:N`), so a worker with queued mail does not pad ATTENTION.
    // ISH-904: a headless principal has no pane BY DESIGN; only a pane-supervised
    // worker with no visible runtime is actionable.
    if (w.paneSupervised && !w.paneId) {
      out.push({ kind: "worker", id: w.id, ageMs: null, text: "supervised worker has no visible runtime pane" });
    }
    for (const r of w.oldRuntimes) {
      if (r.cleanupOverdue) {
        out.push({ kind: "worker", id: w.id, ageMs: null,
                   text: `old runtime g${r.generation} ${r.state}, cleanup overdue` });
      }
    }
  }
  const unclaimable = new Set(unclaimableRunnableTasks(db).map((t) => t.id));
  for (const t of tasks) {
    if (unclaimable.has(t.id)) {
      out.push({ kind: "task", id: t.id, ageMs: null, text: `unclaimable role=${t.role}` });
    } else if (t.state === "blocked_human" || t.state === "blocked_internal") {
      const note = getNotes(db, t.id).reverse().find((n) => n.kind === t.state);
      out.push({ kind: "task", id: t.id, ageMs: null,
                 text: `${t.state}${note?.body ? `: ${note.body}` : ""}` });
    } else if (t.state === "failed") {
      out.push({ kind: "task", id: t.id, ageMs: null, text: "failed" });
    }
  }
  // T549: a worker woken repeatedly for claimable work that never claims is
  // WEDGED, not idle. Surface it (once per window the supervisor logs it) so a
  // high-context unresponsive session is never a silent idle. Bounded to the
  // window so a recovered worker does not show a stale row forever.
  const unresponsive = db
    .query(
      `SELECT worker_id AS id, MAX(timestamp) AS at, MAX(payload_json) AS p
         FROM events WHERE type = 'worker.wake_unresponsive'
        GROUP BY worker_id`
    )
    .all() as { id: string; at: number; p: string }[];
  const window = unresponsiveWindowMs();
  const seenWorkers = new Set(workers.map((w) => w.id));
  for (const u of unresponsive) {
    if (!seenWorkers.has(u.id)) continue;
    if (workers.some((w) => w.id === u.id && w.state === "dead")) continue;
    if (window > 0 && at - u.at > window) continue;
    let usedTokens: number | null = null;
    let highContext = false;
    try {
      const p = JSON.parse(u.p) as { usedTokens?: number | null; highContext?: boolean };
      usedTokens = p.usedTokens ?? null;
      highContext = p.highContext === true;
    } catch { /* ignore malformed */ }
    const ctx = usedTokens ? ` at ${Math.round(usedTokens / 1000)}K tokens` : "";
    // Only a HIGH-context session is the known wedge. A low-context worker that
    // was merely slow to start gets a softer, non-alarming row (live: rust-http
    // flagged at 121K and claimed ~20s later).
    out.push({
      kind: "worker",
      id: u.id,
      ageMs: u.at ? at - u.at : null,
      text: highContext
        ? `idle, woken repeatedly for runnable work but not claiming${ctx} — session may be wedged (detach + respawn)`
        : `idle, woken repeatedly for runnable work but not claiming${ctx} — slow to start?`,
    });
  }
  return out;
}

function readGit(root: string): DashboardGit {
  const run = (args: string[]): string | null => {
    try {
      const r = spawnSync("git", args, { cwd: root, encoding: "utf-8", timeout: 10_000, env: process.env });
      return r.status === 0 ? String(r.stdout ?? "").trim() : null;
    } catch {
      return null;
    }
  };
  const head = run(["log", "-1", "--format=%h %s"]) ?? "?";
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]) ?? "?";
  const dirty = (run(["status", "--porcelain"]) ?? "").split("\n").filter((l) => l.trim()).length;
  return { head, headSha: head.split(" ")[0], branch, dirty };
}
