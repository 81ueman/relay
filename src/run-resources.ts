import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { defaultDbPath } from "./db";
import { canonicalizeDbPath } from "./singleton";
import {
  dindVolumeNamesFromContainerLabels,
  workspacePathVariants,
} from "./devcontainer-id";

/**
 * ISH-1221/1222 — Relay-labelled container/volume inventory and reclamation.
 *
 * Relay itself does not start containers; the worker/reviewer processes it
 * launches do. Relay therefore hands them the label values
 * (`RELAY_DOCKER_LABEL_PLANE` / `RELAY_DOCKER_LABEL_TASK` /
 * `RELAY_DOCKER_LABEL_RUN`) and reclaims exactly those labels. It NEVER lists,
 * stops or deletes an untraceable unlabelled container/volume (other projects
 * share the host) and NEVER has an image-removal path (the cEOS/NOS images are
 * hand-imported and cannot be re-pulled).
 *
 * The unlabelled exceptions are the devcontainer `dind-var-lib-docker-*` volume
 * and (ISH-1224) the devcontainer CONTAINER. The feature cannot label the volume,
 * so Relay derives its exact name from the Run's recorded workspace/config
 * (`src/devcontainer-id.ts`). Only that exact recorded name is inspected/removed
 * — never a `dind-*` scan — and only when no container still references it. The
 * container is attributed by its exact `devcontainer.local_folder` label on a
 * Relay-owned worktree path, so a stopped holder can be reclaimed before its
 * named volume instead of hiding the leak behind Docker's `Links` count.
 *
 * `relay.task=T1` is NOT globally unique: every control plane numbers its own
 * Tasks from T1 (`src/tasks.ts`). The `relay.plane=<hash>` label namespaces the
 * resource to the control plane whose DB created it, so the relay and ishiul
 * control planes on one host never reclaim each other's T1. A resource without
 * the plane label is only attributable through a globally unique Run id.
 */

export const RELAY_PLANE_LABEL = "relay.plane";
export const RELAY_TASK_LABEL = "relay.task";
export const RELAY_RUN_LABEL = "relay.run";

/**
 * Stable control-plane namespace from the DB path (12 hex chars of SHA-256).
 *
 * ISH-1222: hash the CANONICAL path, not the configured spelling. On macOS
 * `/tmp` is a symlink to `/private/tmp`; if the daemon and the CLI reached the
 * same DB through those two spellings, the old `resolve`-only id differed and
 * cleanup silently skipped every labelled resource (fail-safe, but a leak).
 * `canonicalizeDbPath` realpaths the file (or its existing parent directory) and
 * falls back to `resolve` for a not-yet-created path, mirroring the daemon's
 * singleton identity.
 */
export function controlPlaneId(dbPath: string = defaultDbPath()): string {
  return createHash("sha256").update(canonicalizeDbPath(dbPath)).digest("hex").slice(0, 12);
}

/**
 * The namespace of the OPEN DB. `Database.filename` is the actual control-plane
 * path, so two checkouts (or an explicit `RELAY_DB`) cannot collide even when
 * both are reached through the same cwd/default.
 */
export function controlPlaneNamespace(db: { filename?: string }): string {
  return controlPlaneId(db.filename ?? defaultDbPath());
}

export interface RunContainer {
  id: string;
  name: string;
  plane: string | null;
  taskId: string | null;
  runId: string | null;
  state: string | null;
  /** Docker's writable-layer size (`docker ps --size`), when reported. */
  sizeBytes: number | null;
}

export interface RunVolume {
  name: string;
  plane: string | null;
  taskId: string | null;
  runId: string | null;
  /**
   * Docker's reported volume size (`docker system df -v`), when available. A
   * missing size is `null`, never a guess; the leak report renders `-`.
   */
  sizeBytes: number | null;
  /** Docker reports at least one container referencing this volume. */
  inUse: boolean;
}

/**
 * ISH-1224: a devcontainer container, attributed by its EXACT
 * `devcontainer.local_folder` label on a workspace path the caller declared
 * Relay-owned. It never comes from a name/prefix scan, and it is not a
 * Relay-labelled resource (the devcontainer feature cannot apply Relay labels).
 * `configFile` is the optional exact `devcontainer.config_file` label, which
 * together with `localFolder` reproduces the dind volume id.
 */
export interface DevcontainerContainer {
  id: string;
  name: string;
  state: string | null;
  /** Docker's writable-layer size (`docker ps --size`), when reported. */
  sizeBytes: number | null;
  /** Exact `devcontainer.local_folder` label (a Relay-owned worktree path). */
  localFolder: string;
  /** Exact `devcontainer.config_file` label, when the CLI recorded one. */
  configFile: string | null;
}

/**
 * ISH-1224: only a STOPPED devcontainer is a reclaimable holder. A running,
 * paused or restarting devcontainer may still be in use by a human/editor, so the
 * patrol leaves it (and its volume) alone; the acceptance is explicitly about a
 * stopped holder.
 */
export function isStoppedDevcontainer(state: string | null): boolean {
  if (!state) return false;
  return ["created", "exited", "dead"].includes(state.toLowerCase());
}

export interface RunResourceSnapshot {
  containers: RunContainer[];
  /** Volumes carrying a Relay label (`relay.task`/`relay.run`). */
  volumes: RunVolume[];
  /**
   * ISH-1222: exact `dind-var-lib-docker-*` volumes derived from a Run's
   * recorded devcontainer id. They are usually UNLABELLED (the devcontainer
   * feature does not support labels), so they are attributed by exact derived
   * name, never by a prefix/pattern scan.
   */
  dindVolumes: RunVolume[];
  /** ISH-1224: devcontainer containers attributable by exact local_folder. */
  devcontainerContainers: DevcontainerContainer[];
  /** Non-null when the container inventory could not be read (docker absent/down). */
  containerError: string | null;
  /** Non-null when the labelled volume inventory could not be read. */
  volumeError: string | null;
  /** Non-null when the optional volume-size probe failed (sizes then stay null). */
  sizeError: string | null;
  /** Non-null when the devcontainer-container inventory could not be read. */
  devcontainerError: string | null;
}

export interface SnapshotOptions {
  /**
   * Exact, already-derived dind volume names to resolve (deduped by the caller).
   * This is NOT a search pattern: the real implementation only `inspect`s these
   * names and never enumerates other `dind-var-lib-docker-*` volumes.
   */
  dindVolumeNames?: readonly string[];
  /**
   * ISH-1224: exact Relay-owned workspace paths. A devcontainer container is
   * included ONLY when its `devcontainer.local_folder` label resolves to one of
   * these paths (logical or realpath spelling); no prefix/glob scan is used.
   */
  devcontainerWorkspaces?: readonly string[];
}

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type DockerExec = (argv: string[], timeoutMs?: number) => ExecResult;

export interface RunResourceDocker {
  /** Relay-labelled resources + the exact dind names in `opts`. */
  snapshot(opts?: SnapshotOptions): RunResourceSnapshot;
  removeContainer(id: string): { ok: boolean; error: string };
  removeVolume(name: string): { ok: boolean; error: string };
}

/** Real `docker` runner. `docker` absent is reported as a failed read, never a throw. */
export function realDockerExec(): DockerExec {
  return (argv, timeoutMs = 20_000) => {
    const p = spawnSync("docker", argv, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return {
      ok: p.status === 0,
      stdout: String(p.stdout ?? "").trim(),
      stderr: String(p.stderr ?? p.error?.message ?? "").trim(),
    };
  };
}

/**
 * The DEFAULT when no seam is passed. It contacts no host Docker at all, so the
 * library (and `bun test`) can never remove a container by accident. The CLI is
 * the one production caller and explicitly passes `realRunResourceDocker()`;
 * tests pass a fake. An explicit seam is the opt-in.
 */
export function disabledRunResourceDocker(
  reason = "docker inventory disabled: no RunResourceDocker seam was passed"
): RunResourceDocker {
  return {
    snapshot: () => ({
      containers: [],
      volumes: [],
      dindVolumes: [],
      devcontainerContainers: [],
      containerError: reason,
      volumeError: reason,
      sizeError: null,
      devcontainerError: reason,
    }),
    removeContainer: () => ({ ok: false, error: reason }),
    removeVolume: () => ({ ok: false, error: reason }),
  };
}

/** Parse a `docker --format '{{json .}}'` line stream. Malformed lines are skipped. */
function parseJsonLines(raw: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split("\n").map((s) => s.trim()).filter(Boolean)) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) out.push(value as Record<string, unknown>);
    } catch {
      /* a non-JSON line adds no inventory; it must not abort the read */
    }
  }
  return out;
}

/**
 * Docker labels arrive in TWO shapes: `docker ps --format '{{json .}}'` gives a
 * comma-separated `k=v` string, while `docker volume inspect` gives a JSON
 * object. Accept both so a volume's labels are never silently lost.
 */
export function parseDockerLabels(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string" && key.trim()) out[key.trim()] = value.trim();
    }
    return out;
  }
  if (typeof raw !== "string" || !raw.trim()) return out;
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    if (key) out[key] = part.slice(eq + 1).trim();
  }
  return out;
}

/** Parse Docker's human size (`1.2MB (virtual 3.4GB)`) to bytes, or null. */
export function parseDockerSize(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/([\d.]+)\s*([kmgt]?i?b)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase().replace("ib", "b");
  const mult: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
  return Math.round(n * (mult[unit] ?? 1));
}

function labelMap(raw: unknown): { plane: string | null; taskId: string | null; runId: string | null } {
  const labels = parseDockerLabels(raw);
  const plane = (labels[RELAY_PLANE_LABEL] ?? "").trim() || null;
  const taskId = (labels[RELAY_TASK_LABEL] ?? "").trim() || null;
  const runId = (labels[RELAY_RUN_LABEL] ?? "").trim() || null;
  return { plane, taskId, runId };
}

/**
 * Read containers matching EITHER Relay label family. Two queries are needed
 * because Docker ANDs multiple `label=` filters; merging by id lists a resource
 * that carries only `relay.run` (the run-id fallback is a real path, not dead
 * code). A failed query is reported but does not discard the other's inventory.
 */
function readContainers(exec: DockerExec): { containers: RunContainer[]; error: string | null } {
  const byId = new Map<string, RunContainer>();
  const errors: string[] = [];
  for (const label of [RELAY_TASK_LABEL, RELAY_RUN_LABEL]) {
    const r = exec([
      "ps",
      "-a",
      "--filter",
      `label=${label}`,
      "--size",
      "--no-trunc",
      "--format",
      "{{json .}}",
    ]);
    if (!r.ok) {
      errors.push((r.stderr || r.stdout || `docker ps (${label}) failed`).slice(0, 300));
      continue;
    }
    for (const row of parseJsonLines(r.stdout)) {
      const id = String(row.ID ?? "").trim();
      if (!id || byId.has(id)) continue;
      const labels = labelMap(row.Labels);
      byId.set(id, {
        id,
        name: String(row.Names ?? "").trim(),
        plane: labels.plane,
        taskId: labels.taskId,
        runId: labels.runId,
        state: typeof row.State === "string" ? row.State : null,
        sizeBytes: parseDockerSize(row.Size),
      });
    }
  }
  return { containers: [...byId.values()], error: errors.length > 0 ? errors.join("; ") : null };
}

/**
 * ISH-1224: read devcontainer containers by their OWN `devcontainer.local_folder`
 * label. Docker cannot filter on the label VALUE here without one query per
 * path, so one read-only `ps` with the label PRESENCE filter is filtered in
 * memory against the caller's exact Relay-owned paths. Nothing outside that
 * exact set is returned, so an unrelated project's devcontainer can never reach
 * the leak report or the cleanup plan.
 */
function readDevcontainerContainers(
  exec: DockerExec,
  workspaces: readonly string[]
): { containers: DevcontainerContainer[]; error: string | null } {
  if (workspaces.length === 0) return { containers: [], error: null };
  const allowed = new Set(workspaces.flatMap((path) => workspacePathVariants(path)));
  const r = exec([
    "ps",
    "-a",
    "--filter",
    "label=devcontainer.local_folder",
    "--size",
    "--no-trunc",
    "--format",
    "{{json .}}",
  ]);
  if (!r.ok) {
    return {
      containers: [],
      error: (r.stderr || r.stdout || "docker ps (devcontainer.local_folder) failed").slice(0, 300),
    };
  }
  const byId = new Map<string, DevcontainerContainer>();
  for (const row of parseJsonLines(r.stdout)) {
    const id = String(row.ID ?? "").trim();
    if (!id || byId.has(id)) continue;
    const labels = parseDockerLabels(row.Labels);
    const localFolder = (labels["devcontainer.local_folder"] ?? "").trim();
    if (!localFolder) continue;
    if (!workspacePathVariants(localFolder).some((path) => allowed.has(path))) continue;
    const configFile = (labels["devcontainer.config_file"] ?? "").trim() || null;
    byId.set(id, {
      id,
      name: String(row.Names ?? "").trim(),
      state: typeof row.State === "string" ? row.State : null,
      sizeBytes: parseDockerSize(row.Size),
      localFolder,
      configFile,
    });
  }
  return { containers: [...byId.values()], error: null };
}

/**
 * ISH-1222: per-volume sizes + reference counts from `docker system df -v`.
 * Docker has no per-volume size in `volume inspect`; this is the one read that
 * reports it. Best-effort: a failed/older probe leaves sizes null (the leak
 * report renders `-`) and is surfaced separately, never as a reason to remove
 * anything. `Links` > 0 means a container (possibly the unlabelled devcontainer)
 * still references the volume; the leak report shows it with its attributed
 * holder, and cleanup removes that holder before the volume.
 */
function readVolumeUsage(exec: DockerExec): {
  sizeBytes: Map<string, number>;
  inUse: Map<string, boolean>;
  error: string | null;
} {
  const sizeBytes = new Map<string, number>();
  const inUse = new Map<string, boolean>();
  const r = exec(["system", "df", "-v", "--format", "json"], 60_000);
  if (!r.ok) {
    return {
      sizeBytes,
      inUse,
      error: (r.stderr || r.stdout || "docker system df -v failed").slice(0, 300),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return { sizeBytes, inUse, error: "docker system df -v returned non-JSON output" };
  }
  const rows =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { Volumes?: unknown }).Volumes)
      ? ((parsed as { Volumes: unknown[] }).Volumes)
      : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const name = String((row as { Name?: unknown }).Name ?? "").trim();
    if (!name) continue;
    const size = parseDockerSize((row as { Size?: unknown }).Size);
    if (size !== null) sizeBytes.set(name, size);
    const links = Number((row as { Links?: unknown }).Links);
    if (Number.isFinite(links)) inUse.set(name, links > 0);
  }
  return { sizeBytes, inUse, error: null };
}

function readVolumes(
  exec: DockerExec,
  usage: { sizeBytes: Map<string, number>; inUse: Map<string, boolean> }
): { volumes: RunVolume[]; error: string | null } {
  const names = new Set<string>();
  const errors: string[] = [];
  for (const label of [RELAY_TASK_LABEL, RELAY_RUN_LABEL]) {
    const listed = exec(["volume", "ls", "--filter", `label=${label}`, "--format", "{{.Name}}"]);
    if (!listed.ok) {
      errors.push((listed.stderr || listed.stdout || `docker volume ls (${label}) failed`).slice(0, 300));
      continue;
    }
    for (const name of listed.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) names.add(name);
  }
  const volumes: RunVolume[] = [];
  for (const name of names) {
    const inspected = exec(["volume", "inspect", "--format", "{{json .}}", name]);
    let labels: { plane: string | null; taskId: string | null; runId: string | null } = {
      plane: null,
      taskId: null,
      runId: null,
    };
    if (inspected.ok) {
      const rows = parseJsonLines(inspected.stdout);
      if (rows[0]) labels = labelMap((rows[0] as { Labels?: unknown }).Labels);
    }
    volumes.push({
      name,
      plane: labels.plane,
      taskId: labels.taskId,
      runId: labels.runId,
      sizeBytes: usage.sizeBytes.get(name) ?? null,
      inUse: usage.inUse.get(name) ?? false,
    });
  }
  return { volumes, error: errors.length > 0 ? errors.join("; ") : null };
}

/**
 * The production Docker inventory/removal implementation.
 *
 * `dindVolumeNames` is the caller's exact derived set. ISH-1224 additionally
 * inspects the exact dind name implied by an ATTRIBUTED devcontainer container's
 * own `local_folder`/`config_file` labels: that recovers a volume whose worktree
 * and config are already gone but whose stopped container still carries the
 * labels. Both inputs are exact names; there is no `volume ls dind-*` scan, so an
 * unrelated devcontainer volume is never listed, sized for removal, or rm'd.
 */
export function realRunResourceDocker(exec: DockerExec = realDockerExec()): RunResourceDocker {
  return {
    snapshot(opts: SnapshotOptions = {}) {
      const c = readContainers(exec);
      const dc = readDevcontainerContainers(exec, opts.devcontainerWorkspaces ?? []);
      const usage = readVolumeUsage(exec);
      const v = readVolumes(exec, usage);
      const labelled = new Set(v.volumes.map((x) => x.name));
      const dindNames = new Set(opts.dindVolumeNames ?? []);
      for (const container of dc.containers) {
        for (const name of dindVolumeNamesFromContainerLabels(container.localFolder, container.configFile)) {
          dindNames.add(name);
        }
      }
      const dindVolumes: RunVolume[] = [];
      for (const name of dindNames) {
        if (labelled.has(name)) continue;
        const inspected = exec(["volume", "inspect", "--format", "{{json .}}", name]);
        if (!inspected.ok) continue; // absent (or unreadable): nothing to reclaim
        const rows = parseJsonLines(inspected.stdout);
        const labels = rows[0] ? labelMap((rows[0] as { Labels?: unknown }).Labels) : { plane: null, taskId: null, runId: null };
        dindVolumes.push({
          name,
          plane: labels.plane,
          taskId: labels.taskId,
          runId: labels.runId,
          sizeBytes: usage.sizeBytes.get(name) ?? null,
          inUse: usage.inUse.get(name) ?? false,
        });
      }
      return {
        containers: c.containers,
        volumes: v.volumes,
        dindVolumes,
        devcontainerContainers: dc.containers,
        containerError: c.error,
        volumeError: v.error,
        sizeError: usage.error,
        devcontainerError: dc.error,
      };
    },
    removeContainer(id) {
      // ISH-1222 correction: `-v` removes only a container's ANONYMOUS volumes.
      // The devcontainer `dind-var-lib-docker-*` volume is NAMED, so it is
      // reclaimed explicitly by its derived name, never by this flag.
      const r = exec(["rm", "-f", "-v", id]);
      return { ok: r.ok, error: r.ok ? "" : (r.stderr || r.stdout || "docker rm failed").slice(0, 300) };
    },
    removeVolume(name) {
      // Never `-f`: a volume still in use must fail visibly, and no prune path exists.
      const r = exec(["volume", "rm", name]);
      return { ok: r.ok, error: r.ok ? "" : (r.stderr || r.stdout || "docker volume rm failed").slice(0, 300) };
    },
  };
}
