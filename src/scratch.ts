import { existsSync, mkdirSync, readdirSync, lstatSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defaultDbPath } from "./db";
import { RELAY_PLANE_LABEL } from "./run-resources";

/**
 * ISH-1221 — Relay-owned, per-Run scratch.
 * ISH-1225 — the build cache is scoped to the TASK, not the Run.
 *
 * A headless Run and a headless review are both coding processes that write
 * build scratch somewhere. If they use the host default (`/tmp/<name>`,
 * `target/` in the checkout, ...), that resource is not attributable to the
 * Run/Task and outlives it. Relay therefore creates one scratch root per
 * execution under its OWN output directory and hands it to the process:
 *
 *   <control-plane>/runs/<run-id>/scratch/
 *     tmp/                 $TMPDIR / $TMP / $TEMP
 *
 * Reviews use `<control-plane>/runs/reviews/<task>/<attempt>-<head>/scratch`.
 * `TMPDIR` stays per-execution: it is small and disposable.
 *
 * The Cargo build cache must be reusable across phases instead. Every
 * implement/FIX Run, the mechanical VERIFY and the reviewer use the SAME
 * Task-scoped directory:
 *
 *   <task-worktree>/target        $CARGO_TARGET_DIR
 *
 * The worktree is Relay-created/owned and is removed by `relay run cleanup`
 * with the Task, so the build cache is reclaimed exactly when the Task's
 * workspace is. `target/` is inside the Run's writable workspace (a
 * `workspace-write` Run can write it) and is the natural Cargo default, so
 * VERIFY and a FIX Run reuse the artifacts the IMPLEMENT Run just built.
 *
 * The Run's stdout/stderr/dsh.jsonl and events.jsonl stay in
 * `<control-plane>/runs/<run-id>/` as RETAINED evidence; cleanup removes only
 * the `scratch` subtree (plus the Task worktree/target). Nothing here ever
 * uses a shared `/tmp` path.
 */

export const SCRATCH_DIR_NAME = "scratch";
export const SCRATCH_TMP_DIR = "tmp";
/**
 * ISH-1221's legacy per-Run cargo target directory name. ISH-1225 creates no
 * runtime path from it (a scratch root written by an older Relay is still
 * removed whole by cleanup).
 */
export const SCRATCH_CARGO_DIR = "cargo-target";
/** The Task-scoped Cargo build directory inside the Task worktree. */
export const TASK_CARGO_DIR = "target";

/** The default `<control-plane>/runs` root (same default as `startDshRun`). */
export function defaultRunsRoot(): string {
  return join(dirname(defaultDbPath()), "runs");
}

/** A safe path segment from a Task id (mirrors run-lifecycle's sanitizeId). */
export function scratchPathSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
}

/** One Run's scratch root: `<run output dir>/scratch`. */
export function runScratchRoot(runOutputDir: string): string {
  return join(runOutputDir, SCRATCH_DIR_NAME);
}

/**
 * ISH-1225: the ONE Cargo build directory a Task shares across every phase.
 * It lives inside the Task worktree so a `workspace-write` Run can write it,
 * VERIFY's natural Cargo default finds it, and Task cleanup removes it.
 */
export function taskCargoTarget(worktree: string): string {
  return join(worktree, TASK_CARGO_DIR);
}

/** One review's scratch root under the same Relay-owned runs root. */
export function reviewScratchRoot(
  outputRoot: string | undefined,
  taskId: string,
  attempt: number,
  head: string | null | undefined
): string {
  const shortHead = head ? head.slice(0, 10) : "none";
  return join(outputRoot ?? defaultRunsRoot(), "reviews", scratchPathSegment(taskId), `${attempt}-${shortHead}`);
}

/** All review scratch for one Task (what cleanup owns). */
export function reviewScratchTaskRoot(outputRoot: string | undefined, taskId: string): string {
  return join(outputRoot ?? defaultRunsRoot(), "reviews", scratchPathSegment(taskId));
}

/**
 * Create the per-execution scratch root + its TMPDIR child. Idempotent.
 * ISH-1225: no `cargo-target/` is created here — the build cache belongs to the
 * Task worktree (see `taskCargoTarget`), so a second Run must not mint one.
 */
export function ensureScratchRoot(root: string): string {
  mkdirSync(join(root, SCRATCH_TMP_DIR), { recursive: true });
  return root;
}

/**
 * The environment a Run/review receives. Relay-owned values WIN over an
 * inherited host TMPDIR, so a focused check cannot silently fall back to the
 * shared `/tmp`. `RELAY_DOCKER_LABEL_*` makes it easy for the process to label
 * any container/volume it starts; cleanup removes exactly those labels.
 *
 * `plane` namespaces the labels to THIS control plane. `relay.task=T1` alone is
 * ambiguous on a shared host (every checkout numbers its own Tasks from T1), so
 * a resource missing the plane label is only matched through its Run id.
 *
 * `cargoTargetDir` is the Task-level build cache shared with VERIFY and the
 * reviewer (ISH-1225). It is NOT derived from the per-Run scratch root: a caller
 * that omits it gets no `CARGO_TARGET_DIR` from Relay (never a fresh per-Run
 * target), and production callers always pass the Task worktree's `target/`.
 */
export function scratchEnv(
  root: string,
  ids: { plane: string; taskId: string; runId: string },
  opts: { cargoTargetDir?: string } = {}
): Record<string, string> {
  const tmp = join(root, SCRATCH_TMP_DIR);
  const env: Record<string, string> = {
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    RELAY_SCRATCH_DIR: root,
    RELAY_TMPDIR: tmp,
    RELAY_TASK_ID: ids.taskId,
    RELAY_RUN_ID: ids.runId,
    RELAY_DOCKER_LABEL_PLANE: `${RELAY_PLANE_LABEL}=${ids.plane}`,
    RELAY_DOCKER_LABEL_TASK: `relay.task=${ids.taskId}`,
    RELAY_DOCKER_LABEL_RUN: `relay.run=${ids.runId}`,
  };
  if (opts.cargoTargetDir) {
    env.CARGO_TARGET_DIR = opts.cargoTargetDir;
    env.RELAY_CARGO_TARGET_DIR = opts.cargoTargetDir;
    env.RELAY_TASK_CARGO_TARGET_DIR = opts.cargoTargetDir;
  }
  return env;
}

/** Remove a scratch root; true when something was actually removed. */
export function removeScratchRoot(root: string): boolean {
  if (!existsSync(root)) return false;
  rmSync(root, { recursive: true, force: true });
  return true;
}

/**
 * Recursive on-disk size for the leak report. Symlinks are counted by their own
 * link size and never followed (a worktree can contain a link back to the
 * source checkout). A missing/unreadable path is `null`, never a throw.
 *
 * `exclude` lets the leak report size a worktree and its Task build directory
 * separately without double-counting the same bytes (ISH-1225).
 */
export function pathSizeBytes(path: string, exclude: readonly string[] = []): number | null {
  let total = 0;
  const skip = new Set(exclude.map((p) => resolve(p)));
  const stack = [path];
  try {
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (skip.has(resolve(cur))) continue;
      const st = lstatSync(cur);
      if (st.isDirectory()) {
        total += st.size;
        for (const entry of readdirSync(cur, { withFileTypes: true })) {
          stack.push(join(cur, entry.name));
        }
      } else {
        total += st.size;
      }
    }
    return total;
  } catch {
    return null;
  }
}

/** Format bytes for the human leak report. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}
