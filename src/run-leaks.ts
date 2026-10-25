import type { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { defaultDbPath, now, projectRoot, STATE_DIR } from "./db";
import { isTerminalTaskState, type TaskState } from "./schema";
import { findActiveWriter } from "./dsh-runner";
import { defaultRunsRoot, pathSizeBytes, scratchPathSegment } from "./scratch";
import { dindVolumeNamesForWorkspace, dindVolumeNamesFromContainerLabels, workspacePathVariants } from "./devcontainer-id";
import {
  controlPlaneNamespace,
  disabledRunResourceDocker,
  isStoppedDevcontainer,
  type DevcontainerContainer,
  type RunResourceDocker,
} from "./run-resources";

/**
 * ISH-1221/1222 — orphan report for run-scoped resources.
 *
 * The report is READ-ONLY. It lists resources that are attributable to Relay and
 * whose Run/Task is over (or whose Task no longer exists):
 *
 *   - per-Run / per-review scratch roots (with a recursive size);
 *   - Task and disposable review worktrees (with a size);
 *   - Relay-labelled containers;
 *   - devcontainer containers attributed by their exact `devcontainer.local_folder`
 *     label on a Relay-owned worktree path (ISH-1224);
 *   - Relay-labelled volumes + the exact devcontainer `dind-var-lib-docker-*`
 *     named volumes derived from a Run's recorded workspace or a holding
 *     devcontainer's labels, with Docker's reported size.
 *
 * It never lists an unlabelled container/volume unless a devcontainer container
 * is attributable by its EXACT `devcontainer.local_folder` label on a Relay-owned
 * worktree path (ISH-1224; a dind volume held by such a container is listed with
 * the holder and its size). `relay.plane` is authoritative: another control
 * plane's `relay.task=T1` is NOT reported as this plane's orphan (Task ids repeat
 * across checkouts). `relay run list --leaks` renders this for the gateway patrol.
 */

export type LeakKind =
  | "scratch"
  | "review-scratch"
  | "worktree"
  | "review-worktree"
  | "container"
  | "volume"
  | "dind-volume";

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
  /** ISH-1222: the workspace the Run recorded; the dind id is derived from it. */
  cwd: string;
  /** ISH-1222: exact dind names recorded at launch (JSON string[]), if any. */
  devcontainer_volumes: string | null;
}

const LIVE_RUN_STATES = new Set(["starting", "running"]);

function addEntry(report: LeakReport, entry: LeakEntry): void {
  report.entries.push(entry);
  if (entry.sizeBytes !== null) report.totalBytes += entry.sizeBytes;
}

function isUnder(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}

/** Parse the exact dind names recorded on a Run; malformed JSON is ignored. */
function parseRecordedDind(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string" && v.startsWith("dind-var-lib-docker-"))
      : [];
  } catch {
    return [];
  }
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
  const runs = db
    .query(`SELECT id, task_id, output_dir, state, cwd, devcontainer_volumes FROM runs`)
    .all() as RunRow[];
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

  // ISH-1222/1224: every exact dind name a Run's recorded workspace can own.
  // Only Relay-owned roots are considered (a devcontainer in the main checkout or
  // a human workspace is not a Task resource). The first (run-scoped) owner wins;
  // a Task worktree fallback covers a Task whose Run row is gone. A dind volume's
  // identity is per-WORKSPACE, so the owner records every path spelling that
  // derives the name (a FIX attempt reuses the same worktree).
  interface DindOwner {
    taskId: string | null;
    runId: string | null;
    workspaces: Set<string>;
  }
  const dindOwners = new Map<string, DindOwner>();
  /** workspace path variant -> first owner (used for devcontainer containers). */
  const workspaceOwners = new Map<string, { taskId: string | null; runId: string | null }>();
  /** Every Relay-owned workspace spelling passed to the Docker seam. */
  const relayWorkspaces = new Set<string>();
  const addDindName = (name: string, taskId: string | null, runId: string | null, variants: string[]): void => {
    if (!name.startsWith("dind-var-lib-docker-")) return;
    let owner = dindOwners.get(name);
    if (!owner) {
      owner = { taskId, runId, workspaces: new Set() };
      dindOwners.set(name, owner);
    }
    for (const variant of variants) owner.workspaces.add(variant);
  };
  const addDindOwner = (
    path: string,
    taskId: string | null,
    runId: string | null,
    recorded: string[] = []
  ): void => {
    if (!isUnder(path, worktreesRoot) && !isUnder(path, reviewWorktreesRoot)) return;
    const variants = workspacePathVariants(path);
    for (const variant of variants) {
      relayWorkspaces.add(variant);
      if (!workspaceOwners.has(variant)) workspaceOwners.set(variant, { taskId, runId });
    }
    for (const name of recorded) addDindName(name, taskId, runId, variants);
    for (const name of dindVolumeNamesForWorkspace(path, { recorded: true })) {
      addDindName(name, taskId, runId, variants);
    }
  };
  for (const run of runs) {
    addDindOwner(run.cwd, run.task_id, run.id, parseRecordedDind(run.devcontainer_volumes));
  }
  for (const task of tasks) {
    if (task.worktree) addDindOwner(task.worktree, task.id, null);
  }
  const liveWorkspaces = new Set(
    runs.filter((r) => LIVE_RUN_STATES.has(r.state)).flatMap((r) => workspacePathVariants(r.cwd))
  );

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
    // A reviewer can start a devcontainer in its disposable worktree too; the
    // derived dind volume is named after that path and must not leak.
    addDindOwner(path, task?.id ?? null, null);
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

  // 5. Relay-labelled containers/volumes + exact derived dind volumes. Only a
  // label, an exact derived dind name, or an exact `devcontainer.local_folder`
  // path is evidence; an unrelated unlabelled resource is never listed/touched.
  let snapshot;
  try {
    snapshot = (opts.docker ?? disabledRunResourceDocker()).snapshot({
      dindVolumeNames: [...dindOwners.keys()],
      devcontainerWorkspaces: [...relayWorkspaces],
    });
  } catch (e) {
    report.dockerErrors.push(e instanceof Error ? e.message : String(e));
    return report;
  }
  if (snapshot.containerError) report.dockerErrors.push(`containers: ${snapshot.containerError}`);
  if (snapshot.volumeError) report.dockerErrors.push(`volumes: ${snapshot.volumeError}`);
  if (snapshot.sizeError) report.dockerErrors.push(`volume sizes: ${snapshot.sizeError}`);
  if (snapshot.devcontainerError) report.dockerErrors.push(`devcontainers: ${snapshot.devcontainerError}`);
  const listedContainers = new Set<string>();
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
    listedContainers.add(c.id);
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
  const listedVolumes = new Set<string>();
  for (const v of snapshot.volumes) {
    // No Relay label at all -> not Relay's resource: never list or touch it.
    if (!v.taskId && !v.runId) continue;
    if (!belongsToThisPlane(v, plane, runById)) continue;
    listedVolumes.add(v.name);
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

  // ISH-1224: stopped devcontainer containers are unlabelled by Relay, but their
  // exact `devcontainer.local_folder` label points at a Relay-owned workspace.
  // Only an exact path match is attributed (never a name/prefix scan), and the
  // container is listed only when that workspace has no live Run. A listed
  // holder is what lets the dind entry name its container even when Docker's
  // `Links` count is > 0 (the old `inUse` skip hid the leaks this issue is for).
  const holdersByVolume = new Map<string, DevcontainerContainer[]>();
  for (const c of snapshot.devcontainerContainers ?? []) {
    // Only a stopped holder is a leak; a running/paused one may be in active use.
    if (!isStoppedDevcontainer(c.state)) continue;
    const variants = workspacePathVariants(c.localFolder);
    const workspaceKey = variants.find((path) => workspaceOwners.has(path));
    if (!workspaceKey) continue; // not a Relay-owned workspace of this plane
    const owner = workspaceOwners.get(workspaceKey)!;
    const run = owner.runId ? runById.get(owner.runId) ?? null : null;
    const task = owner.taskId ? taskById.get(owner.taskId) ?? null : run ? taskById.get(run.task_id) ?? null : null;
    const taskId = owner.taskId ?? run?.task_id ?? null;
    const workspaceIsLive = variants.some((path) => liveWorkspaces.has(path));
    const runIsLive = !!run && LIVE_RUN_STATES.has(run.state);
    const orphan = !task || (isTerminalTaskState(task.state) && !liveTaskIds.has(task.id)) || (run !== null && !runIsLive);
    if (!orphan || workspaceIsLive) continue;
    const held = new Set(dindVolumeNamesFromContainerLabels(c.localFolder, c.configFile));
    if (held.size === 0) {
      // No config label and no live config file: fall back to the exact names
      // already attributed to this SAME Relay-owned path (never a glob).
      for (const [name, volumeOwner] of dindOwners) {
        if ([...volumeOwner.workspaces].some((variant) => variants.includes(variant))) held.add(name);
      }
    }
    for (const name of held) {
      if (!name.startsWith("dind-var-lib-docker-")) continue;
      const volumeOwner = dindOwners.get(name);
      if (!volumeOwner) {
        dindOwners.set(name, { taskId, runId: owner.runId, workspaces: new Set(variants) });
      } else {
        for (const variant of variants) volumeOwner.workspaces.add(variant);
      }
      const holders = holdersByVolume.get(name) ?? [];
      holders.push(c);
      holdersByVolume.set(name, holders);
    }
    if (listedContainers.has(c.id)) continue;
    listedContainers.add(c.id);
    addEntry(report, {
      kind: "container",
      id: c.id,
      taskId,
      runId: owner.runId,
      path: null,
      sizeBytes: c.sizeBytes,
      detail: [
        c.name ? `name=${c.name}` : null,
        c.state ? `state=${c.state}` : null,
        `devcontainer local_folder=${c.localFolder}`,
      ]
        .filter(Boolean)
        .join(" "),
    });
  }

  // ISH-1222: the devcontainer dind named volumes. They are normally unlabelled,
  // so attribution is the EXACT name derived from the Run's recorded workspace
  // (or the holding devcontainer's labels); an unrelated
  // `dind-var-lib-docker-*` volume is not in `dindOwners` and never appears here.
  // ISH-1224: a volume held by an ATTRIBUTED stopped devcontainer is reported
  // with that holder (and its size), instead of being hidden by `Links` > 0.
  for (const v of snapshot.dindVolumes) {
    if (listedVolumes.has(v.name)) continue;
    const owner = dindOwners.get(v.name);
    if (!owner) continue;
    const run = owner.runId ? runById.get(owner.runId) ?? null : null;
    const task = owner.taskId ? taskById.get(owner.taskId) ?? null : run ? taskById.get(run.task_id) ?? null : null;
    const taskId = owner.taskId ?? run?.task_id ?? null;
    const workspaceIsLive = [...owner.workspaces].some((path) => liveWorkspaces.has(path));
    const runIsLive = !!run && LIVE_RUN_STATES.has(run.state);
    const orphan = !task || (isTerminalTaskState(task.state) && !liveTaskIds.has(task.id)) || (run !== null && !runIsLive);
    if (!orphan || workspaceIsLive) continue;
    const holders = holdersByVolume.get(v.name) ?? [];
    // An in-use volume with no attributable holder is still not provably a leak:
    // it may be a running devcontainer of another Task/project. Keep the old
    // conservative skip; an attributed holder is reclaimed by cleanup first.
    if (v.inUse && holders.length === 0) continue;
    const holderDetail =
      holders.length > 0
        ? `held by container ${holders.map((h) => `${h.id}${h.name ? ` (${h.name})` : ""}`).join(", ")}`
        : null;
    addEntry(report, {
      kind: "dind-volume",
      id: v.name,
      taskId,
      runId: owner.runId,
      path: null,
      sizeBytes: v.sizeBytes,
      detail: ["dind (derived devcontainer volume)", holderDetail].filter(Boolean).join("; "),
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
