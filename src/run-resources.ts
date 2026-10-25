import { spawnSync } from "node:child_process";

/**
 * ISH-1221 — Relay-labelled container/volume inventory and reclamation.
 *
 * Relay itself does not start containers; the worker/reviewer processes it
 * launches do. Relay therefore hands them the label values
 * (`RELAY_DOCKER_LABEL_TASK` / `RELAY_DOCKER_LABEL_RUN`) and reclaims exactly
 * those labels. It NEVER lists, stops or deletes an unlabelled container or
 * volume (other projects share the host) and NEVER has an image-removal path
 * (the cEOS/NOS images are hand-imported and cannot be re-pulled).
 */

export const RELAY_TASK_LABEL = "relay.task";
export const RELAY_RUN_LABEL = "relay.run";

export interface RunContainer {
  id: string;
  name: string;
  taskId: string | null;
  runId: string | null;
  state: string | null;
  /** Docker's writable-layer size (`docker ps --size`), when reported. */
  sizeBytes: number | null;
}

export interface RunVolume {
  name: string;
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
  /** Every container/volume carrying a Relay label (`relay.task`). */
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

/** Docker labels are a comma-separated `k=v` list. */
export function parseDockerLabels(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
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

function labelMap(raw: unknown): { taskId: string | null; runId: string | null } {
  const labels = parseDockerLabels(raw);
  const taskId = (labels[RELAY_TASK_LABEL] ?? "").trim() || null;
  const runId = (labels[RELAY_RUN_LABEL] ?? "").trim() || null;
  return { taskId, runId };
}

function readContainers(exec: DockerExec): { containers: RunContainer[]; error: string | null } {
  const r = exec([
    "ps",
    "-a",
    "--filter",
    `label=${RELAY_TASK_LABEL}`,
    "--size",
    "--no-trunc",
    "--format",
    "{{json .}}",
  ]);
  if (!r.ok) return { containers: [], error: (r.stderr || r.stdout || "docker ps failed").slice(0, 300) };
  const containers: RunContainer[] = [];
  for (const row of parseJsonLines(r.stdout)) {
    const id = String(row.ID ?? "").trim();
    if (!id) continue;
    const labels = labelMap(row.Labels);
    containers.push({
      id,
      name: String(row.Names ?? "").trim(),
      taskId: labels.taskId,
      runId: labels.runId,
      state: typeof row.State === "string" ? row.State : null,
      sizeBytes: parseDockerSize(row.Size),
    });
  }
  return { containers, error: null };
}

function readVolumes(exec: DockerExec): { volumes: RunVolume[]; error: string | null } {
  const listed = exec(["volume", "ls", "--filter", `label=${RELAY_TASK_LABEL}`, "--format", "{{.Name}}"]);
  if (!listed.ok) return { volumes: [], error: (listed.stderr || listed.stdout || "docker volume ls failed").slice(0, 300) };
  const volumes: RunVolume[] = [];
  for (const name of listed.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const inspected = exec(["volume", "inspect", "--format", "{{json .}}", name]);
    let labels: { taskId: string | null; runId: string | null } = { taskId: null, runId: null };
    if (inspected.ok) {
      const rows = parseJsonLines(inspected.stdout);
      if (rows[0]) labels = labelMap((rows[0] as { Labels?: unknown }).Labels);
    }
    volumes.push({ name, taskId: labels.taskId, runId: labels.runId, sizeBytes: null });
  }
  return { volumes, error: null };
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
      const r = exec(["rm", "-f", id]);
      return { ok: r.ok, error: r.ok ? "" : (r.stderr || r.stdout || "docker rm failed").slice(0, 300) };
    },
    removeVolume(name) {
      // Never `-f`: a volume still in use must fail visibly, and no prune path exists.
      const r = exec(["volume", "rm", name]);
      return { ok: r.ok, error: r.ok ? "" : (r.stderr || r.stdout || "docker volume rm failed").slice(0, 300) };
    },
  };
}

/** True when a container/volume is attributable to a Relay label. */
export function isRelayAttributed(r: { taskId: string | null; runId: string | null }): boolean {
  return !!(r.taskId || r.runId);
}
