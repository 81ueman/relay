import { spawnSync } from "node:child_process";
import type { Database } from "bun:sqlite";
import { now } from "../db";
import { unreadCounts } from "../messages";
import { nextMailNudgeIn } from "../mail-policy";
import { findRuntime, listRuntimes } from "../runtimes";
import { getNotes, listTasks, taskCounts, unclaimableRunnableTasks } from "../tasks";
import { toolWarnMs } from "../scheduler";
import { listWorkers, quietActive, type WorkerRow } from "../workers";
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
  const view: DashboardView = {
    root,
    summary: {
      total: tasks.length,
      done: counts["done"] ?? 0,
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
      depth: 0, children: [], allDone: false, subtreeSize: 1,
    };
  }
  const order: Record<string, number> = {};
  TASK_STATE_ORDER.forEach((s, i) => (order[s] = i));
  order["done"] = TASK_STATE_ORDER.length;
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
    // Early hang detection: a command that has been running past the warn
    // threshold is surfaced WITH its text, before the stall clock can see it
    // (Herdr reports `working` for the whole command, so the stall path is blind).
    if (w.tool && w.tool.ageMs > toolWarnMs()) {
      const budget = w.tool.timeoutMs != null ? `, timeout ${Math.round(w.tool.timeoutMs / 1000)}s` : "";
      const cmd = w.tool.command ? `: ${w.tool.command}` : "";
      out.push({ kind: "worker", id: w.id, ageMs: w.tool.ageMs,
                 text: `tool ${w.tool.name} running${cmd}${budget}` });
    }
    if (w.state === "starting" && (w.progressAgeMs ?? 0) > 120_000) {
      out.push({ kind: "worker", id: w.id, ageMs: null, text: `starting for a while (attach stuck?)` });
    }
    if (w.unread) {
      const next = nextMailNudgeIn(db, w.id, at);
      const when = next == null ? "" : next <= 0 ? " (nudge now)" : ` (next nudge in ${Math.ceil(next / 1000)}s)`;
      out.push({ kind: "worker", id: w.id, ageMs: null, text: `unread messages=${w.unread}${when}` });
    }
    if (!w.paneId) {
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
