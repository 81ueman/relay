import type { Database } from "bun:sqlite";
import { claimableRunnableTasks, getTask, reviewTasks } from "../tasks";
import { getWorker } from "../workers";
import type { Task, Worker } from "../schema";
import type { DashboardTaskNode } from "./model";

/**
 * Worker -> task affinity, for GROUPING THE WORKERS SECTION ONLY.
 *
 * Workers are flat peers; tasks may form a tree. This module projects each
 * worker onto the authoritative task topology so the dashboard can read like the
 * work does. It is:
 *
 *   - DERIVED: recomputed on every build, never stored. No `parent_worker_id`,
 *     `coordinator_id`, `worker_group_id` or similar column exists, and none may
 *     be added. Grouping is a view, not a relationship.
 *   - NON-HIERARCHICAL: one anchor task per worker, chosen by an explicit
 *     priority rule. Indentation means "relates to this task cluster", never
 *     "reports to". `integration-coord` is a peer of `perf-rust`, not its owner.
 *   - NAME-BLIND: no worker id, role or title is special-cased. A coordinator
 *     appears near the top only because it currently OWNS a cluster-root /
 *     ancestor task, which is observed state.
 *
 * Priority (spec: current > claimable > none; recent history deliberately
 * unused in this first implementation):
 *
 *   1. `worker.current_task_id`      -> source "current_task"
 *   2. a claimable runnable/review task -> source "claimable"
 *   3. nothing derivable             -> source "none"  (AVAILABLE / OTHER)
 */

export type AffinitySource = "current_task" | "claimable" | "none";

export interface WorkerAffinity {
  /** The task the worker is tied to. null = ungrouped. */
  anchorTaskId: string | null;
  /** The cluster to display under (child of the root ancestor, or the root). */
  clusterTaskId: string | null;
  source: AffinitySource;
}

export const NO_AFFINITY: WorkerAffinity = { anchorTaskId: null, clusterTaskId: null, source: "none" };

/** A rendered cluster: a task subtree plus the peer workers projected onto it. */
export interface WorkerCluster {
  /**
   * null for the trailing "AVAILABLE / OTHER" bucket. Kept in one list so the
   * renderer preserves "clusters first, ungrouped last".
   */
  clusterTaskId: string | null;
  /** Cluster header info (from `tasksById`); null for the ungrouped bucket. */
  header: { id: string; title: string } | null;
  /** Peer rows, already ordered by `compareWorkersInCluster`. */
  workerIds: string[];
  /**
   * Runnable work this cluster's members could pick up right now — the
   * dashboard form of `relay status`'s `next:`. DERIVED (never stored) from the
   * same `claimableRunnableTasks` / `reviewTasks` policy `relay next` uses, and
   * never includes a task a member already owns or is anchored on.
   *
   * Ordered by `priority DESC, created_at ASC` (the scheduler's order), deduped.
   */
  claimableTaskIds: string[];
}

export interface AffinityIndex {
  byWorker: Map<string, WorkerAffinity>;
  /** Clusters in WORK-preorder order, with the ungrouped bucket last. */
  clusters: WorkerCluster[];
  /** Preorder index of a task id, matching the WORK section's traversal. */
  preorder: Map<string, number>;
}

export interface AffinityOptions {
  /** The same forest the WORK section renders, so cluster order matches it. */
  forest: DashboardTaskNode[];
  tasksById: Record<string, DashboardTaskNode>;
  /**
   * Relay worker state, used only for the within-cluster ordering. Supplied by
   * the model so this module stays free of worker-row plumbing.
   */
  stateOf?: (workerId: string) => string;
}

export function buildAffinity(
  db: Database,
  workerIds: string[],
  opts: AffinityOptions
): AffinityIndex {
  const preorder = preorderIndex(opts.forest);
  // A worker can anchor on a task the WORK section folded (a done subtree still
  // owned by a slow worker). Such a task has no rendered preorder slot; give the
  // whole out-of-forest set one stable tail region so ordering stays total and
  // deterministic rather than collapsing to MAX_SAFE_INTEGER ties.
  const tail = extendPreorder(preorder, opts.tasksById);
  const byWorker = new Map<string, WorkerAffinity>();
  const dbOrder = memoizedDbPreorder(db);

  for (const id of workerIds) {
    byWorker.set(id, deriveWorkerAffinity(db, id, opts.tasksById, tail, dbOrder));
  }

  // Claimable lists are shared between anchor derivation and the cluster queue;
  // compute once per worker (and once for a missing worker id).
  const claimableCache = new Map<string, Task[]>();
  const claimableOf = (id: string): Task[] => {
    let list = claimableCache.get(id);
    if (list === undefined) {
      const w = getWorker(db, id);
      list = w ? claimableTasksOf(db, w) : [];
      claimableCache.set(id, list);
    }
    return list;
  };

  const clusters = groupIntoClusters(
    workerIds, byWorker, opts.tasksById, tail,
    opts.stateOf ?? (() => "worker"),
    claimableOf
  );
  return { byWorker, clusters, preorder: tail };
}

/**
 * Append DB-shape preorder indices for tasks absent from the rendered forest, so
 * `rank()` never returns MAX_SAFE_INTEGER for a real task id.
 */
function extendPreorder(
  rendered: Map<string, number>,
  tasksById: Record<string, DashboardTaskNode>
): Map<string, number> {
  const missing = Object.keys(tasksById).filter((id) => !rendered.has(id));
  if (!missing.length) return rendered;
  missing.sort();
  const out = new Map(rendered);
  let i = rendered.size;
  for (const id of missing) out.set(id, i++);
  return out;
}

/**
 * Order tasks exactly like the WORK section walks them: depth-first over the
 * forest the renderer is given, children in their rendered order. Cluster order
 * and anchor ordering both key off this, so the two sections line up.
 */
export function preorderIndex(forest: DashboardTaskNode[]): Map<string, number> {
  const index = new Map<string, number>();
  let i = 0;
  const visit = (n: DashboardTaskNode): void => {
    if (index.has(n.id)) return; // cycle / re-entry guard
    index.set(n.id, i++);
    for (const c of n.children) visit(c);
  };
  for (const r of forest) visit(r);
  return index;
}

function deriveWorkerAffinity(
  db: Database,
  workerId: string,
  tasksById: Record<string, DashboardTaskNode>,
  preorder: Map<string, number>,
  dbOrder: () => Map<string, number>
): WorkerAffinity {
  const w = getWorker(db, workerId);
  if (!w) return NO_AFFINITY;

  // 1. Current ownership is observed truth and beats every eligibility rule
  //    (including a task held via `--any-role`: ownership, not role, decides).
  if (w.current_task_id) {
    const task = getTask(db, w.current_task_id);
    if (task) return { anchorTaskId: task.id, clusterTaskId: clusterOf(task, tasksById, preorder), source: "current_task" };
  }

  // 2. No current task: derive affinity from what the worker could CLAIM now.
  const candidate = primaryClaimableTask(db, w, dbOrder);
  if (candidate) {
    return { anchorTaskId: candidate.id, clusterTaskId: clusterOf(candidate, tasksById, preorder), source: "claimable" };
  }

  // 3. Nothing derivable. Deliberately no "recent history" fallback: touching an
  //    old task must not pin a worker to a cluster forever.
  return NO_AFFINITY;
}

/**
 * The single task that gives an idle worker its affinity, chosen
 * deterministically. Role matching is NOT reimplemented here: `reviewTasks` and
 * `claimableRunnableTasks` are the same domain functions `relay next` uses, so a
 * reviewer prefers the review queue first, exactly as `claimNext` does.
 *
 * Selection: priority DESC, then WORK preorder, then created_at, then id. That
 * mirrors the scheduler's `ORDER BY priority DESC, created_at ASC` and adds
 * topology as the tie-break only when the scheduler itself is indifferent.
 */
export function primaryClaimableTask(
  db: Database,
  w: Worker,
  dbOrder?: () => Map<string, number>
): Task | null {
  const order = dbOrder ?? memoizedDbPreorder(db);
  const candidates = claimableTasksOf(db, w);
  if (!candidates.length) return null;
  return pickPrimary(candidates, order);
}

/**
 * Every task this worker could pick up right now, in the scheduler's own order.
 * The ONE place role matching is resolved for the dashboard: `reviewTasks` and
 * `claimableRunnableTasks` are the same domain functions `relay next` uses, so
 * the dashboard cannot drift from the scheduler. A reviewer takes review work
 * first, exactly as `claimNext` does (queued role-gated work only when the
 * review queue is empty).
 */
export function claimableTasksOf(db: Database, w: Worker): Task[] {
  if (w.role === "reviewer") {
    const review = reviewTasks(db);
    if (review.length) return review;
  }
  return claimableRunnableTasks(db, w.id);
}

function pickPrimary(candidates: Task[], order: () => Map<string, number>): Task {
  const preorder = order();
  return [...candidates].sort((a, b) => {
    const pr = (b.priority ?? 0) - (a.priority ?? 0);
    if (pr !== 0) return pr;
    const pa = preorder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const pb = preorder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    if (a.created_at !== b.created_at) return a.created_at - b.created_at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}

/** `dbPreorder`, computed at most once per build (N workers share one index). */
function memoizedDbPreorder(db: Database): () => Map<string, number> {
  let cached: Map<string, number> | null = null;
  return () => (cached ??= dbPreorder(db));
}

/**
 * Preorder over the DB's own parent/child shape, independent of the rendered
 * forest (which folds done subtrees). Used to break ties between claimable
 * candidates, so it stays stable even for a task the WORK section folded away.
 */
function dbPreorder(db: Database): Map<string, number> {
  const rows = db
    .query(`SELECT id, parent_task_id FROM tasks ORDER BY priority DESC, created_at ASC, id ASC`)
    .all() as { id: string; parent_task_id: string | null }[];
  const childrenOf = new Map<string, string[]>();
  const ids = new Set(rows.map((r) => r.id));
  const roots: string[] = [];
  for (const r of rows) {
    if (r.parent_task_id && ids.has(r.parent_task_id) && r.parent_task_id !== r.id) {
      const arr = childrenOf.get(r.parent_task_id) ?? [];
      arr.push(r.id);
      childrenOf.set(r.parent_task_id, arr);
    } else roots.push(r.id);
  }
  const index = new Map<string, number>();
  let i = 0;
  const visit = (id: string): void => {
    if (index.has(id)) return;
    index.set(id, i++);
    for (const c of childrenOf.get(id) ?? []) visit(c);
  };
  for (const r of roots) visit(r);
  for (const r of rows) visit(r.id); // cycles / orphans
  return index;
}

/**
 * Cluster = the child directly below the ROOT ancestor; a root task clusters
 * under itself. This depends only on task-tree shape (no titles, no names), and
 * it keeps a big program root from swallowing every worker into one block.
 */
export function clusterOf(
  task: Task,
  tasksById: Record<string, DashboardTaskNode>,
  preorder: Map<string, number>
): string {
  let node = tasksById[task.id];
  if (!node) return task.id; // not in the rendered forest: stand alone
  const seen = new Set<string>([node.id]);
  while (node.parent && tasksById[node.parent] && !seen.has(node.parent)) {
    const parent = tasksById[node.parent];
    if (!parent.parent) return node.id; // node's parent is a root -> node is the cluster
    seen.add(parent.id);
    node = parent;
  }
  // `node` is a root (or the chain ended): the cluster is the root itself.
  return node.id;
}

function groupIntoClusters(
  workerIds: string[],
  byWorker: Map<string, WorkerAffinity>,
  tasksById: Record<string, DashboardTaskNode>,
  preorder: Map<string, number>,
  stateOf: (workerId: string) => string,
  claimableOf: (workerId: string) => Task[]
): WorkerCluster[] {
  const buckets = new Map<string, string[]>();
  const other: string[] = [];

  for (const id of workerIds) {
    const a = byWorker.get(id) ?? NO_AFFINITY;
    if (a.clusterTaskId == null) {
      other.push(id);
      continue;
    }
    const arr = buckets.get(a.clusterTaskId) ?? [];
    arr.push(id);
    buckets.set(a.clusterTaskId, arr);
  }

  const cmp = makeClusterComparator(byWorker, preorder, stateOf);
  const clusters: WorkerCluster[] = [...buckets.entries()]
    .map(([clusterTaskId, ids]) => {
      const node = tasksById[clusterTaskId];
      return {
        clusterTaskId,
        header: { id: clusterTaskId, title: node?.title ?? "" },
        workerIds: ids.sort(cmp),
        claimableTaskIds: clusterClaimable(ids, byWorker, claimableOf),
      };
    })
    // Cluster order == WORK preorder, so the eye does not jump between sections.
    .sort((a, b) => rank(a.clusterTaskId!, preorder) - rank(b.clusterTaskId!, preorder)
      || (a.clusterTaskId! < b.clusterTaskId! ? -1 : 1));

  // Ungrouped workers are always last, sorted stably by id.
  if (other.length) {
    clusters.push({
      clusterTaskId: null,
      header: null,
      workerIds: other.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
      claimableTaskIds: clusterClaimable(other, byWorker, claimableOf),
    });
  }
  return clusters;
}

/**
 * The runnable work a cluster's members could pick up, deduped and in the
 * scheduler's own order. Excludes any task a member already owns or is anchored
 * on — that is current work, not a queue, and calling it "claimable" would be
 * wrong (the same rule `relay status`'s `next:` applies).
 *
 * Tasks are not attributed to a single worker: several peers of a role may be
 * able to take the same task, and the dashboard must not decide which one does.
 */
function clusterClaimable(
  workerIds: string[],
  byWorker: Map<string, WorkerAffinity>,
  claimableOf: (workerId: string) => Task[]
): string[] {
  const held = new Set<string>();
  for (const id of workerIds) {
    const a = byWorker.get(id);
    if (a?.anchorTaskId) held.add(a.anchorTaskId);
  }
  const seen = new Map<string, Task>();
  for (const id of workerIds) {
    for (const t of claimableOf(id)) {
      if (held.has(t.id)) continue;
      if (!seen.has(t.id)) seen.set(t.id, t);
    }
  }
  return [...seen.values()]
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)
      || a.created_at - b.created_at
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((t) => t.id);
}

function rank(id: string, preorder: Map<string, number>): number {
  return preorder.get(id) ?? Number.MAX_SAFE_INTEGER;
}

const WORKER_STATE_ORDER: Record<string, number> = {
  working: 0, waiting_input: 1, starting: 2, idle: 3, stalled: 4, dead: 5,
};

/**
 * Within a cluster: the anchor's position in the WORK tree first, then current
 * owners before idle-affinity peers, then worker state, then id. A cluster's
 * root owner therefore sorts to the top as a CONSEQUENCE of owning that task —
 * not because its role is coordinator.
 *
 * `stateOf` supplies the Relay worker state (kept out of this module so the
 * ordering stays a pure function of the affinity index + a lookup).
 */
function makeClusterComparator(
  byWorker: Map<string, WorkerAffinity>,
  preorder: Map<string, number>,
  stateOf: (workerId: string) => string
): (a: string, b: string) => number {
  return (a: string, b: string): number => {
    const aa = byWorker.get(a) ?? NO_AFFINITY;
    const ab = byWorker.get(b) ?? NO_AFFINITY;

    const pa = aa.anchorTaskId ? rank(aa.anchorTaskId, preorder) : Number.MAX_SAFE_INTEGER;
    const pb = ab.anchorTaskId ? rank(ab.anchorTaskId, preorder) : Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;

    // current task owner outranks an idle worker that merely could claim.
    const ownA = aa.source === "current_task" ? 0 : 1;
    const ownB = ab.source === "current_task" ? 0 : 1;
    if (ownA !== ownB) return ownA - ownB;

    const sa = WORKER_STATE_ORDER[stateOf(a)] ?? 99;
    const sb = WORKER_STATE_ORDER[stateOf(b)] ?? 99;
    if (sa !== sb) return sa - sb;

    return a < b ? -1 : a > b ? 1 : 0;
  };
}
