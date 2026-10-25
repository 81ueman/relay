import type { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultDbPath, now, projectRoot, STATE_DIR } from "./db";
import { isTerminalTaskState, type TaskState } from "./schema";
import { findActiveWriter } from "./dsh-runner";
import { defaultRunsRoot, pathSizeBytes, scratchPathSegment } from "./scratch";
import {
  controlPlaneNamespace,
  disabledRunResourceDocker,
  type RunResourceDocker,
} from "./run-resources";

/**
 * ISH-1221 — orphan report for run-scoped resources.
 *
 * The report is READ-ONLY. It lists resources that are attributable to Relay and
 * whose Run/Task is over (or whose Task no longer exists):
 *
 *   - per-Run / per-review scratch roots (with a recursive size);
 *   - Task and disposable review worktrees (with a size);
 *   - Relay-labelled containers/volumes (with the size Docker reports).
 *
 * It never lists an unlabelled container/volume (other projects share the host)
 * and has no image path at all. The `relay.plane` namespace is authoritative:
 * another control plane's `relay.task=T1` is NOT reported as this plane's
 * orphan (Task ids repeat across checkouts). `relay run list --leaks` renders
 * this for the gateway patrol.
 */

export type LeakKind = "scratch" | "review-scratch" | "worktree" | "review-worktree" | "container" | "volume";

export interface LeakEntry {
  kind: LeakKind;
  /** A path, container id/name or volume name. */
  id: string;
  taskId: string | null;
  runId: string | null;
  path: string | null;
  sizeBytes: number | null;
  detail: string | null;
}

export interface LeakReport {
  checkedAt: number;
  entries: LeakEntry[];
  totalBytes: number;
  /** Docker unavailability is reported, not hidden (no container check ran). */
  dockerErrors: string[];
}

export interface LeakScanOptions {
  repo?: string;
  outputRoot?: string;
  worktreesRoot?: string;
  reviewWorktreesRoot?: string;
  docker?: RunResourceDocker;
}

interface TaskRow {
  id: string;
  state: TaskState;
  worktree: string | null;
  branch: string | null;
}

interface RunRow {
  id: string;
  task_id: string;
  output_dir: string;
  state: string;
}

const LIVE_RUN_STATES = new Set(["starting", "running"]);

function addEntry(report: LeakReport, entry: LeakEntry): void {
  report.entries.push(entry);
  if (entry.sizeBytes !== null) report.totalBytes += entry.sizeBytes;
}

export function scanRunLeaks(db: Database, opts: LeakScanOptions = {}): LeakReport {
  const report: LeakReport = { checkedAt: now(), entries: [], totalBytes: 0, dockerErrors: [] };
  const plane = controlPlaneNamespace(db);
  const repo = opts.repo ?? projectRoot();
  const outputRoot = opts.outputRoot ?? defaultRunsRoot();
  const worktreesRoot = opts.worktreesRoot ?? join(dirname(defaultDbPath()), "worktrees");
  const reviewWorktreesRoot = opts.reviewWorktreesRoot ?? join(repo, STATE_DIR, "review-worktrees");

  const tasks = db
    .query(`SELECT id, state, worktree, branch FROM tasks`)
    .all() as TaskRow[];
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const runs = db.query(`SELECT id, task_id, output_dir, state FROM runs`).all() as RunRow[];
  const runById = new Map(runs.map((r) => [r.id, r]));
  const liveRunIds = new Set(runs.filter((r) => LIVE_RUN_STATES.has(r.state)).map((r) => r.id));
  const liveTaskIds = new Set(runs.filter((r) => LIVE_RUN_STATES.has(r.state)).map((r) => r.task_id));

  const writerCache = new Map<string, boolean>();
  const hasLiveWriter = (task: TaskRow): boolean => {
    if (liveTaskIds.has(task.id)) return true;
    if (!task.worktree) return false;
    const cached = writerCache.get(task.id);
    if (cached !== undefined) return cached;
    const writer = findActiveWriter(db, { cwd: task.worktree, branch: task.branch });
    writerCache.set(task.id, !!writer);
    return !!writer;
  };

  // 1. Per-Run scratch: a terminal Run's scratch is orphaned by definition.
  for (const run of runs) {
    if (liveRunIds.has(run.id)) continue;
    const scratch = join(run.output_dir, "scratch");
    if (!existsSync(scratch)) continue;
    addEntry(report, {
      kind: "scratch",
      id: scratch,
      taskId: run.task_id,
      runId: run.id,
      path: scratch,
      sizeBytes: pathSizeBytes(scratch),
      detail: `run ${run.state}`,
    });
  }

  // 2. Review scratch: task-scoped directory under <runs>/reviews/<task>/.
  const reviewsRoot = join(outputRoot, "reviews");
  if (existsSync(reviewsRoot)) {
    const bySegment = new Map(tasks.map((t) => [scratchPathSegment(t.id), t]));
    for (const name of safeReaddir(reviewsRoot)) {
      const dir = join(reviewsRoot, name);
      const task = bySegment.get(name) ?? null;
      // A review scratch for a live Task may be an in-flight review; do not
      // report it as a leak until the Task is terminal.
      if (task && !isTerminalTaskState(task.state)) continue;
      addEntry(report, {
        kind: "review-scratch",
        id: dir,
        taskId: task?.id ?? null,
        runId: null,
        path: dir,
        sizeBytes: pathSizeBytes(dir),
        detail: task ? `task ${task.state}` : "task not found",
      });
    }
  }

  // 3. Task worktrees: terminal Task + no writer. A directory under the Relay
  // root with no Task row is orphaned too.
  const reportedWorktrees = new Set<string>();
  for (const task of tasks) {
    if (!task.worktree || !existsSync(task.worktree)) continue;
    if (!isTerminalTaskState(task.state) || hasLiveWriter(task)) continue;
    reportedWorktrees.add(task.worktree);
    addEntry(report, {
      kind: "worktree",
      id: task.worktree,
      taskId: task.id,
      runId: null,
      path: task.worktree,
      sizeBytes: pathSizeBytes(task.worktree),
      detail: `task ${task.state}`,
    });
  }
  for (const name of safeReaddir(worktreesRoot)) {
    const path = join(worktreesRoot, name);
    if (reportedWorktrees.has(path)) continue;
    const task = tasks.find((t) => t.worktree === path || t.id === name) ?? null;
    if (task && !isTerminalTaskState(task.state)) continue;
    if (task && hasLiveWriter(task)) continue;
    addEntry(report, {
      kind: "worktree",
      id: path,
      taskId: task?.id ?? null,
      runId: null,
      path,
      sizeBytes: pathSizeBytes(path),
      detail: task ? `task ${task.state}` : "task not found",
    });
  }

  // 4. Disposable review worktrees. Infer the Task from its `<task>-<attempt>-<head>`
  // name; an unknown name is still Relay-owned (it lives under the review root).
  for (const name of safeReaddir(reviewWorktreesRoot)) {
    const path = join(reviewWorktreesRoot, name);
    const task = tasks.find((t) => name === t.id || name.startsWith(`${t.id}-`)) ?? null;
    if (task && !isTerminalTaskState(task.state)) continue;
    if (task && hasLiveWriter(task)) continue;
    addEntry(report, {
      kind: "review-worktree",
      id: path,
      taskId: task?.id ?? null,
      runId: null,
      path,
      sizeBytes: pathSizeBytes(path),
      detail: task ? `task ${task.state}` : "task not found",
    });
  }

  // 5. Relay-labelled containers/volumes. Only the label is evidence: an
  // unlabelled resource is not Relay's and is never listed or touched.
  let snapshot;
  try {
    snapshot = (opts.docker ?? disabledRunResourceDocker()).snapshot();
  } catch (e) {
    report.dockerErrors.push(e instanceof Error ? e.message : String(e));
    return report;
  }
  if (snapshot.containerError) report.dockerErrors.push(`containers: ${snapshot.containerError}`);
  if (snapshot.volumeError) report.dockerErrors.push(`volumes: ${snapshot.volumeError}`);
  for (const c of snapshot.containers) {
    // No Relay label at all -> not Relay's resource: never list or touch it.
    if (!c.taskId && !c.runId) continue;
    // Another control plane's resource, or a bare task id with no plane and no
    // Run id this DB knows: not provably ours, so not reported.
    if (!belongsToThisPlane(c, plane, runById)) continue;
    const run = c.runId ? runById.get(c.runId) ?? null : null;
    const task = c.taskId ? taskById.get(c.taskId) ?? null : run ? taskById.get(run.task_id) ?? null : null;
    const taskId = c.taskId ?? run?.task_id ?? null;
    const runIsLive = !!run && LIVE_RUN_STATES.has(run.state);
    const orphan = !task || (isTerminalTaskState(task.state) && !liveTaskIds.has(task.id)) || (run !== null && !runIsLive);
    if (!orphan) continue;
    addEntry(report, {
      kind: "container",
      id: c.id,
      taskId,
      runId: c.runId,
      path: null,
      sizeBytes: c.sizeBytes,
      detail: [c.name ? `name=${c.name}` : null, c.state ? `state=${c.state}` : null].filter(Boolean).join(" "),
    });
  }
  for (const v of snapshot.volumes) {
    // No Relay label at all -> not Relay's resource: never list or touch it.
    if (!v.taskId && !v.runId) continue;
    if (!belongsToThisPlane(v, plane, runById)) continue;
    const run = v.runId ? runById.get(v.runId) ?? null : null;
    const task = v.taskId ? taskById.get(v.taskId) ?? null : run ? taskById.get(run.task_id) ?? null : null;
    const taskId = v.taskId ?? run?.task_id ?? null;
    const runIsLive = !!run && LIVE_RUN_STATES.has(run.state);
    const orphan = !task || (isTerminalTaskState(task.state) && !liveTaskIds.has(task.id)) || (run !== null && !runIsLive);
    if (!orphan) continue;
    addEntry(report, {
      kind: "volume",
      id: v.name,
      taskId,
      runId: v.runId,
      path: null,
      sizeBytes: v.sizeBytes,
      detail: null,
    });
  }
  return report;
}

/**
 * Plane-scoped attribution. A plane label must match this control plane. With
 * no plane label only a Run id present in THIS DB is unique enough to attribute
 * (`relay.task=T1` is reused by every checkout).
 */
function belongsToThisPlane(
  resource: { plane: string | null; runId: string | null },
  plane: string,
  runById: Map<string, RunRow>
): boolean {
  if (resource.plane !== null) return resource.plane === plane;
  return !!(resource.runId && runById.has(resource.runId));
}

function safeReaddir(root: string): string[] {
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
}
