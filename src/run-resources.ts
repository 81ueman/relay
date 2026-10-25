import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { defaultDbPath } from "./db";

/**
 * ISH-1221 — Relay-labelled container/volume inventory and reclamation.
 *
 * Relay itself does not start containers; the worker/reviewer processes it
 * launches do. Relay therefore hands them the label values
 * (`RELAY_DOCKER_LABEL_PLANE` / `RELAY_DOCKER_LABEL_TASK` /
 * `RELAY_DOCKER_LABEL_RUN`) and reclaims exactly those labels. It NEVER lists,
 * stops or deletes an unlabelled container or volume (other projects share the
 * host) and NEVER has an image-removal path (the cEOS/NOS images are
 * hand-imported and cannot be re-pulled).
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
 * `resolve` (not realpath) keeps the id stable for the same configured path.
 */
export function controlPlaneId(dbPath: string = defaultDbPath()): string {
  return createHash("sha256").update(resolve(dbPath)).digest("hex").slice(0, 12);
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
  /** Docker has no cheap per-volume size; the leak report shows `-`. */
  sizeBytes: number | null;
}

export interface RunResourceSnapshot {
  containers: RunContainer[];
  volumes: RunVolume[];
  /** Non-null when the container inventory could not be read (docker absent/down). */
  containerError: string | null;
  /** Non-null when the volume inventory could not be read. */
  volumeError: string | null;
}

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type DockerExec = (argv: string[], timeoutMs?: number) => ExecResult;

export interface RunResourceDocker {
  /** Every container/volume carrying a Relay label (`relay.plane`/`relay.task`/`relay.run`). */
  snapshot(): RunResourceSnapshot;
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
    snapshot: () => ({ containers: [], volumes: [], containerError: reason, volumeError: reason }),
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

function readVolumes(exec: DockerExec): { volumes: RunVolume[]; error: string | null } {
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
    volumes.push({ name, plane: labels.plane, taskId: labels.taskId, runId: labels.runId, sizeBytes: null });
  }
  return { volumes, error: errors.length > 0 ? errors.join("; ") : null };
}

/** The production Docker inventory/removal implementation. */
export function realRunResourceDocker(exec: DockerExec = realDockerExec()): RunResourceDocker {
  return {
    snapshot() {
      const c = readContainers(exec);
      const v = readVolumes(exec);
      return {
        containers: c.containers,
        volumes: v.volumes,
        containerError: c.error,
        volumeError: v.error,
      };
    },
    removeContainer(id) {
      // `-v` also removes the ANONYMOUS volumes of this container (the 2–5 GB
      // `dind-var-lib-docker-*` ones named in ISH-1221). It cannot touch a
      // named/unlabelled volume owned by another container.
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
