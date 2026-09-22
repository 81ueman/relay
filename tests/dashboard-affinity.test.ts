import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { buildDashboardView, type DashboardView } from "../src/dashboard/model";
import { renderDashboard, renderDashboardJson } from "../src/dashboard/render";
import { addTask, claimTask } from "../src/tasks";
import { registerWorker } from "../src/workers";

// WORKERS grouping is a PROJECTION of the authoritative task tree onto flat
// workers. These tests pin the properties the feature promises:
//   - current ownership gives the strongest affinity,
//   - claim eligibility gives an idle worker a useful affinity,
//   - everything else stays ungrouped,
//   - no worker hierarchy is invented and no worker is duplicated.
//
// No worker/role/coordinator name is special-cased anywhere.

let dir = "";
let db: Database;
const at = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-affinity-"));
  mkdirSync(join(dir, ".relay"), { recursive: true });
  db = openDb(join(dir, ".relay", "state.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function view(): DashboardView {
  return buildDashboardView(db, { root: dir, panes: null, at });
}

const clusterIds = (v: DashboardView): (string | null)[] =>
  v.workerClusters.map((c) => c.clusterTaskId);

const clusterOf = (v: DashboardView, workerId: string): string | null =>
  v.workers.find((w) => w.id === workerId)!.affinity.clusterTaskId;

const anchorOf = (v: DashboardView, workerId: string): string | null =>
  v.workers.find((w) => w.id === workerId)!.affinity.anchorTaskId;

/** Every worker id appears exactly once across every cluster. */
function assertRenderedOnce(v: DashboardView): void {
  const seen: string[] = [];
  for (const c of v.workerClusters) seen.push(...c.workerIds);
  expect(seen.length).toBe(v.workers.length);
  expect(new Set(seen).size).toBe(v.workers.length);
  expect(new Set(seen)).toEqual(new Set(v.workers.map((w) => w.id)));
}

/**
 * The program root is a container, not work: mark it running so tests control
 * exactly which leaf tasks are claimable. Role-less QUEUED tasks are claimable
 * by anyone (that is correct Relay behaviour), which would otherwise mask the
 * task the test means to exercise.
 */
function sealRoot(id: string): void {
  db.query(`UPDATE tasks SET state = 'running' WHERE id = ?`).run(id);
}

describe("worker affinity (dashboard projection)", () => {
  test("1. current task determines the anchor", () => {
    const root = addTask(db, { title: "root" });
    const t = addTask(db, { title: "work", parentTaskId: root.id });
    registerWorker(db, "w1", { role: "rust" });
    claimTask(db, t.id, "w1");
    const v = view();
    expect(anchorOf(v, "w1")).toBe(t.id);
    expect(v.workers.find((w) => w.id === "w1")!.affinity.source).toBe("current_task");
  });

  test("2. anchor ancestry determines the cluster", () => {
    // root -> mid -> leaf; leaf's cluster is `mid` (the child directly under root).
    const root = addTask(db, { title: "root" });
    const mid = addTask(db, { title: "mid", parentTaskId: root.id });
    const leaf = addTask(db, { title: "leaf", parentTaskId: mid.id });
    registerWorker(db, "w1");
    claimTask(db, leaf.id, "w1");
    const v = view();
    expect(anchorOf(v, "w1")).toBe(leaf.id);
    expect(clusterOf(v, "w1")).toBe(mid.id);
  });

  test("3. root-child cluster grouping works (root's own subtree is the cluster)", () => {
    const root = addTask(db, { title: "root" });
    const a = addTask(db, { title: "a", parentTaskId: root.id });
    const b = addTask(db, { title: "b", parentTaskId: root.id });
    registerWorker(db, "wa", { role: "x" });
    registerWorker(db, "wb", { role: "x" });
    claimTask(db, a.id, "wa");
    claimTask(db, b.id, "wb");
    const v = view();
    // a and b are siblings: same cluster (root's subtree), two peer rows.
    expect(clusterOf(v, "wa")).toBe(a.id);
    expect(clusterOf(v, "wb")).toBe(b.id);
    const clusters = clusterIds(v).filter((c) => c !== null);
    expect(clusters).toContain(a.id);
    expect(clusters).toContain(b.id);
  });

  test("4. idle worker with a claimable role task joins that cluster", () => {
    const root = addTask(db, { title: "root" });
    sealRoot(root.id);
    const coordTask = addTask(db, { title: "coord", parentTaskId: root.id, role: "coordinator" });
    const queued = addTask(db, { title: "queued work", parentTaskId: coordTask.id, role: "rust" });
    registerWorker(db, "coord", { role: "coordinator" });
    claimTask(db, coordTask.id, "coord");
    registerWorker(db, "rust-idle", { role: "rust" }); // idle, no current task
    const v = view();
    expect(anchorOf(v, "rust-idle")).toBe(queued.id);
    expect(clusterOf(v, "rust-idle")).toBe(coordTask.id);
    expect(v.workers.find((w) => w.id === "rust-idle")!.taskId).toBeNull(); // not ownership
  });

  test("5. worker with no current and no claimable task goes to OTHER", () => {
    const root = addTask(db, { title: "root" });
    sealRoot(root.id);
    // A DONE task is not runnable, so it gives no claim affinity. (A queued
    // role-less task WOULD be claimable by anyone — that is correct, not a bug.)
    const done = addTask(db, { title: "finished", parentTaskId: root.id });
    db.query(`UPDATE tasks SET state = 'done' WHERE id = ?`).run(done.id);
    registerWorker(db, "lonely", { role: "rust" });
    const v = view();
    expect(v.workers.find((w) => w.id === "lonely")!.affinity.source).toBe("none");
    expect(clusterIds(v)).toContain(null);
    const other = v.workerClusters.find((c) => c.clusterTaskId === null)!;
    expect(other.workerIds).toContain("lonely");
  });

  test("6. worker is rendered exactly once", () => {
    const root = addTask(db, { title: "root" });
    sealRoot(root.id);
    const t = addTask(db, { title: "t", parentTaskId: root.id, role: "rust" });
    registerWorker(db, "rust-1", { role: "rust" });
    registerWorker(db, "rust-2", { role: "rust" });
    claimTask(db, t.id, "rust-1");
    const v = view();
    // rust-1 owns `t`; rust-2 cannot claim it (it is running), so rust-2 is
    // ungrouped. Both must still render exactly once.
    expect(anchorOf(v, "rust-1")).toBe(t.id);
    expect(anchorOf(v, "rust-2")).toBeNull();
    assertRenderedOnce(v);
  });

  test("7. worker is not duplicated across multiple claimable clusters", () => {
    // Two queued tasks the SAME role can claim, in two different clusters.
    const root = addTask(db, { title: "root" });
    const c1 = addTask(db, { title: "c1", parentTaskId: root.id });
    const c2 = addTask(db, { title: "c2", parentTaskId: root.id });
    addTask(db, { title: "q1", parentTaskId: c1.id, role: "rust" });
    addTask(db, { title: "q2", parentTaskId: c2.id, role: "rust" });
    registerWorker(db, "rust-1", { role: "rust" });
    const v = view();
    assertRenderedOnce(v);
  });

  test("8. deterministic primary anchor among multiple claimable tasks", () => {
    const root = addTask(db, { title: "root" });
    const c1 = addTask(db, { title: "c1", parentTaskId: root.id });
    const c2 = addTask(db, { title: "c2", parentTaskId: root.id });
    // Higher priority must win regardless of creation order.
    addTask(db, { title: "low", parentTaskId: c1.id, role: "rust", priority: 1 });
    const high = addTask(db, { title: "high", parentTaskId: c2.id, role: "rust", priority: 9 });
    registerWorker(db, "rust-1", { role: "rust" });
    const first = anchorOf(view(), "rust-1");
    expect(first).toBe(high.id);
    expect(anchorOf(view(), "rust-1")).toBe(first); // stable across rebuilds
  });

  test("9. current task wins over a claimable candidate", () => {
    const root = addTask(db, { title: "root" });
    const c1 = addTask(db, { title: "c1", parentTaskId: root.id });
    const c2 = addTask(db, { title: "c2", parentTaskId: root.id });
    const held = addTask(db, { title: "held", parentTaskId: c1.id, role: "rust", priority: 1 });
    const queued = addTask(db, { title: "queued", parentTaskId: c2.id, role: "rust", priority: 99 });
    registerWorker(db, "rust-1", { role: "rust" });
    claimTask(db, held.id, "rust-1");
    const v = view();
    expect(anchorOf(v, "rust-1")).toBe(held.id);
    expect(clusterOf(v, "rust-1")).toBe(c1.id);
    expect(v.tasksById[queued.id]).toBeDefined(); // the higher-priority queued task exists
  });

  test("10. coordinator names/roles receive no special hard-coded treatment", () => {
    const root = addTask(db, { title: "root" });
    const coordTask = addTask(db, { title: "coord", parentTaskId: root.id });
    const other = addTask(db, { title: "other work", parentTaskId: root.id, role: "rust" });
    // A worker whose id LOOKS like a coordinator but holds no task must NOT be
    // treated specially: it is grouped purely by claim eligibility.
    registerWorker(db, "program-coord", { role: "coordinator" });
    registerWorker(db, "integration-coord", { role: "coordinator" });
    registerWorker(db, "rust-1", { role: "rust" });
    claimTask(db, other.id, "rust-1");
    // Give BOTH coordinators a claimable coordinator task in `coordTask`'s cluster.
    addTask(db, { title: "coord queued", parentTaskId: coordTask.id, role: "coordinator" });
    const v = view();
    // The name alone does not put them at the top of anything; eligibility does.
    expect(anchorOf(v, "program-coord")).not.toBeNull();
    expect(clusterOf(v, "integration-coord")).toBe(clusterOf(v, "program-coord"));
    assertRenderedOnce(v);
  });

  test("11. sibling-task workers render as peer rows in the same cluster", () => {
    const root = addTask(db, { title: "root" });
    const parent = addTask(db, { title: "parent", parentTaskId: root.id });
    const s1 = addTask(db, { title: "s1", parentTaskId: parent.id });
    const s2 = addTask(db, { title: "s2", parentTaskId: parent.id });
    registerWorker(db, "w1");
    registerWorker(db, "w2");
    claimTask(db, s1.id, "w1");
    claimTask(db, s2.id, "w2");
    const v = view();
    expect(clusterOf(v, "w1")).toBe(parent.id);
    expect(clusterOf(v, "w2")).toBe(parent.id);
    const cluster = v.workerClusters.find((c) => c.clusterTaskId === parent.id)!;
    expect(cluster.workerIds.sort()).toEqual(["w1", "w2"]);
    assertRenderedOnce(v);
  });

  test("12. cluster order matches WORK preorder", () => {
    const root = addTask(db, { title: "root" });
    const first = addTask(db, { title: "first", parentTaskId: root.id });
    const second = addTask(db, { title: "second", parentTaskId: root.id });
    const t1 = addTask(db, { title: "t1", parentTaskId: first.id });
    const t2 = addTask(db, { title: "t2", parentTaskId: second.id });
    registerWorker(db, "z-worker"); // id sorts LAST alphabetically, but owns `first`
    registerWorker(db, "a-worker"); // id sorts FIRST, but owns `second`
    claimTask(db, t1.id, "z-worker");
    claimTask(db, t2.id, "a-worker");
    const v = view();
    const ordered = clusterIds(v).filter((c): c is string => c !== null);
    // `first` precedes `second` in the WORK forest, so its cluster comes first
    // even though the owner's worker id sorts later.
    expect(ordered.indexOf(first.id)).toBeLessThan(ordered.indexOf(second.id));
  });

  test("13. within-cluster ordering is deterministic, owner before idle peer", () => {
    const root = addTask(db, { title: "root" });
    const cluster = addTask(db, { title: "cluster", parentTaskId: root.id });
    const held = addTask(db, { title: "held", parentTaskId: cluster.id, role: "rust" });
    const queued = addTask(db, { title: "queued", parentTaskId: cluster.id, role: "rust" });
    // `root` and `cluster` are role-less queued tasks that any worker could claim;
    // mark them running so the only claimable work is the rust pair below.
    for (const id of [root.id, cluster.id]) {
      db.query(`UPDATE tasks SET state = 'running' WHERE id = ?`).run(id);
    }
    registerWorker(db, "rust-owner", { role: "rust" });
    registerWorker(db, "rust-idle", { role: "rust" });
    claimTask(db, held.id, "rust-owner");
    const v = view();
    const c = v.workerClusters.find((x) => x.clusterTaskId === cluster.id)!;
    // Owner of `held` (preorder 1) before idle peer anchored at `queued` (preorder 2).
    expect(c.workerIds[0]).toBe("rust-owner");
    expect(anchorOf(v, "rust-idle")).toBe(queued.id);
    // Rebuild is byte-stable.
    expect(view().workerClusters.find((x) => x.clusterTaskId === cluster.id)!.workerIds).toEqual(c.workerIds);
  });

  test("14. an unclaimable task does not attract workers", () => {
    // All workers of the required role are retired -> the task is unclaimable.
    const root = addTask(db, { title: "root" });
    db.query(`UPDATE tasks SET state = 'running' WHERE id = ?`).run(root.id);
    const t = addTask(db, { title: "orphan", parentTaskId: root.id, role: "rust" });
    registerWorker(db, "rust-1", { role: "rust" });
    db.query(`UPDATE workers SET retired_at = ? WHERE id = 'rust-1'`).run(at);
    registerWorker(db, "unrelated", { role: "go" });
    const v = view();
    expect(anchorOf(v, "unrelated")).toBeNull();
    expect(v.workers.find((w) => w.id === "unrelated")!.affinity.source).toBe("none");
    expect(v.attention.some((a) => a.kind === "task" && a.id === t.id)).toBe(true);
  });

  test("15. reviewer current review task determines the cluster", () => {
    const root = addTask(db, { title: "root" });
    const cluster = addTask(db, { title: "cluster", parentTaskId: root.id });
    const work = addTask(db, { title: "work", parentTaskId: cluster.id });
    registerWorker(db, "rev", { role: "reviewer" });
    // Reviewers do not use `claimTask`; put the task in review and assign it.
    db.query(`UPDATE tasks SET state = 'review', assignee = 'rev' WHERE id = ?`).run(work.id);
    db.query(`UPDATE workers SET current_task_id = ?, state = 'working' WHERE id = 'rev'`).run(work.id);
    const v = view();
    expect(anchorOf(v, "rev")).toBe(work.id);
    expect(clusterOf(v, "rev")).toBe(cluster.id);
  });

  test("16. narrow layout keeps grouping", () => {
    const root = addTask(db, { title: "root" });
    const cluster = addTask(db, { title: "a fairly long cluster title", parentTaskId: root.id });
    const t = addTask(db, { title: "t", parentTaskId: cluster.id });
    registerWorker(db, "w1");
    claimTask(db, t.id, "w1");
    const wide = renderDashboard(view(), { width: 140 });
    const narrow = renderDashboard(view(), { width: 40 });
    // The cluster header survives at every width; only the row tail degrades.
    expect(wide).toContain(cluster.id);
    expect(narrow).toContain(cluster.id);
    expect(narrow).toContain("w1");
    for (const line of narrow.split("\n")) {
      if (line.includes("w1 ")) expect(line.length).toBeLessThanOrEqual(40 + 20);
    }
  });

  test("17. render --json exposes derived affinity", () => {
    const root = addTask(db, { title: "root" });
    db.query(`UPDATE tasks SET state = 'running' WHERE id = ?`).run(root.id);
    const cluster = addTask(db, { title: "cluster", parentTaskId: root.id, role: "ops" });
    const t = addTask(db, { title: "t", parentTaskId: cluster.id, role: "ops" });
    db.query(`UPDATE tasks SET state = 'running' WHERE id = ?`).run(cluster.id);
    registerWorker(db, "w1", { role: "ops" });
    registerWorker(db, "idle-one", { role: "rust" }); // nothing it can claim
    claimTask(db, t.id, "w1");
    const parsed = JSON.parse(renderDashboardJson(view()));
    const w1 = parsed.workers.find((w: { id: string }) => w.id === "w1");
    expect(w1.affinity).toEqual({
      anchor_task_id: t.id,
      cluster_task_id: cluster.id,
      source: "current_task",
    });
    const idle = parsed.workers.find((w: { id: string }) => w.id === "idle-one");
    expect(idle.affinity).toEqual({
      anchor_task_id: null,
      cluster_task_id: null,
      source: "none",
    });
    expect(Array.isArray(parsed.worker_clusters)).toBe(true);
    const ids = parsed.worker_clusters.flatMap((c: { workers: string[] }) => c.workers);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("19. a worker owning a task inside a folded (all-done) subtree still gets a stable rank", () => {
    const root = addTask(db, { title: "root" });
    sealRoot(root.id);
    const doneParent = addTask(db, { title: "done parent", parentTaskId: root.id });
    const held = addTask(db, { title: "held", parentTaskId: doneParent.id });
    // The whole `doneParent` subtree is done, so WORK folds it — but `held` is
    // still owned. The anchor must still resolve, and cluster ordering must be
    // a total, repeatable order (no MAX_SAFE_INTEGER ties).
    for (const id of [doneParent.id, held.id]) {
      db.query(`UPDATE tasks SET state = 'done' WHERE id = ?`).run(id);
    }
    registerWorker(db, "slow", { role: "rust" });
    db.query(`UPDATE workers SET current_task_id = ?, state = 'working' WHERE id = 'slow'`).run(held.id);
    const v = view();
    expect(anchorOf(v, "slow")).toBe(held.id);
    expect(clusterOf(v, "slow")).toBe(doneParent.id);
    const once = v.workerClusters.map((c) => [c.clusterTaskId, [...c.workerIds]]);
    const twice = view().workerClusters.map((c) => [c.clusterTaskId, [...c.workerIds]]);
    expect(once).toEqual(twice);
    assertRenderedOnce(v);
  });

  test("20. cluster header shows the claimable queue of its members, matching `relay status` next:", () => {
    const root = addTask(db, { title: "root" });
    sealRoot(root.id);
    const cluster = addTask(db, { title: "cluster", parentTaskId: root.id, role: "coord" });
    const queued = addTask(db, { title: "queued work", parentTaskId: cluster.id, role: "rust" });
    registerWorker(db, "coord", { role: "coord" });
    claimTask(db, cluster.id, "coord");
    registerWorker(db, "rust-idle", { role: "rust" });
    const v = view();
    const c = v.workerClusters.find((x) => x.clusterTaskId === cluster.id)!;
    // rust-idle is anchored ON `queued`, so it is current affinity, not a queue.
    expect(c.workerIds).toContain("rust-idle");
    expect(anchorOf(v, "rust-idle")).toBe(queued.id);
    expect(c.claimableTaskIds).toEqual([]);
  });

  test("21. a cluster with a member that can claim EXTRA work lists it in the header queue", () => {
    const root = addTask(db, { title: "root" });
    sealRoot(root.id);
    const cluster = addTask(db, { title: "cluster", parentTaskId: root.id, role: "coord" });
    const held = addTask(db, { title: "held", parentTaskId: cluster.id, role: "coord" });
    const extra = addTask(db, { title: "extra rust work", parentTaskId: cluster.id, role: "rust" });
    registerWorker(db, "coord", { role: "coord" });
    registerWorker(db, "rust-busy", { role: "rust" });
    claimTask(db, held.id, "coord");
    // rust-busy holds `extra`? No: to keep `extra` claimable it must stay queued.
    // Give rust-busy a current task OUTSIDE so `extra` remains a queue item and
    // rust-busy still has cluster affinity via that task.
    const elsewhere = addTask(db, { title: "elsewhere", parentTaskId: cluster.id, role: "rust" });
    claimTask(db, elsewhere.id, "rust-busy");
    const v = view();
    const c = v.workerClusters.find((x) => x.clusterTaskId === cluster.id)!;
    expect(c.workerIds).toContain("rust-busy");
    expect(c.claimableTaskIds).toContain(extra.id);
  });

  test("22. the cluster queue excludes tasks its members already own", () => {
    const root = addTask(db, { title: "root" });
    sealRoot(root.id);
    const cluster = addTask(db, { title: "cluster", parentTaskId: root.id, role: "rust" });
    const owned = addTask(db, { title: "owned", parentTaskId: cluster.id, role: "rust2" });
    registerWorker(db, "rust2-owner", { role: "rust2" });
    claimTask(db, owned.id, "rust2-owner");
    registerWorker(db, "rust-claim", { role: "rust" });
    db.query(`UPDATE workers SET current_task_id = ?, state = 'working' WHERE id = 'rust-claim'`).run(cluster.id);
    const v = view();
    const c = v.workerClusters.find((x) => x.clusterTaskId === cluster.id)!;
    expect(c.claimableTaskIds).not.toContain(owned.id);
  });

  test("23. --json exposes the cluster claimable queue", () => {
    const root = addTask(db, { title: "root" });
    sealRoot(root.id);
    const cluster = addTask(db, { title: "cluster", parentTaskId: root.id, role: "coord" });
    const extra = addTask(db, { title: "extra", parentTaskId: cluster.id, role: "rust" });
    const elsewhere = addTask(db, { title: "elsewhere", parentTaskId: cluster.id, role: "rust" });
    registerWorker(db, "coord", { role: "coord" });
    registerWorker(db, "rust-1", { role: "rust" });
    db.query(`UPDATE workers SET current_task_id = ?, state = 'working' WHERE id = 'coord'`).run(cluster.id);
    // rust-1 takes one rust task, so the OTHER rust task stays a queue item while
    // rust-1 still has cluster affinity via its current task.
    claimTask(db, elsewhere.id, "rust-1");
    const parsed = JSON.parse(renderDashboardJson(view()));
    const c = parsed.worker_clusters.find((x: { cluster_task_id: string }) => x.cluster_task_id === cluster.id);
    expect(c.claimable_task_ids).toContain(extra.id);
    // The OTHER bucket can never have a claimable queue: a worker with claimable
    // work always gets an anchor, and so a cluster.
    for (const cl of parsed.worker_clusters) {
      if (cl.cluster_task_id === null) expect(cl.claimable_task_ids).toEqual([]);
    }
  });

  test("24. the header renders the queue text, capped to one line", () => {
    const root = addTask(db, { title: "root" });
    sealRoot(root.id);
    const cluster = addTask(db, { title: "cluster", parentTaskId: root.id, role: "coord" });
    registerWorker(db, "coord", { role: "coord" });
    db.query(`UPDATE workers SET current_task_id = ?, state = 'working' WHERE id = 'coord'`).run(cluster.id);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(addTask(db, { title: `q${i}`, parentTaskId: cluster.id, role: "rust" }).id);
    }
    registerWorker(db, "seed", { role: "rust" });
    const v = view();
    const c = v.workerClusters.find((x) => x.clusterTaskId === cluster.id)!;
    // Six queued, but `seed` is ANCHORED on one of them, so five remain as queue.
    expect(c.claimableTaskIds.length).toBe(5);
    const text = renderDashboard(v, { width: 120 });
    const workersSection = text.split("WORKERS")[1];
    const headerLine = workersSection.split("\n").find((l) => l.includes(cluster.id))!;
    expect(headerLine).toContain("next:");
    expect(headerLine).toContain("+1 more"); // cap 4, so 4 shown + 1 extra
    expect(c.workerIds).toContain("seed");
  });

  test("18. no durable worker hierarchy/group columns are added", () => {
    const cols = db.query(`PRAGMA table_info(workers)`).all() as { name: string }[];
    const names = cols.map((c) => c.name);
    for (const forbidden of ["parent_worker_id", "coordinator_id", "worker_group_id", "cluster_task_id", "affinity", "group_id"]) {
      expect(names).not.toContain(forbidden);
    }
    const taskCols = (db.query(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map((c) => c.name);
    for (const forbidden of ["cluster_task_id", "group_id", "owner_worker_id"]) {
      expect(taskCols).not.toContain(forbidden);
    }
  });
});
