import type { Database } from "bun:sqlite";
import { existsSync, statfsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defaultDbPath } from "./db";
import { logEvent } from "./events";
import { bashLc, sbxExecArgv, type SbxCli } from "./sandbox";

/**
 * ISH-1009 — pre-launch disk-space guard for dsh Runs.
 *
 * A Run needs room for the worktree, the process output and the task build
 * artefacts. On 2026-10-20 the host data volume filled and six Runs died with
 * ENOSPC while Relay kept launching (see ISH-1008). This module measures the
 * volumes Relay actually depends on (the Task worktrees root and the Relay DB
 * location) BEFORE a Run row is inserted or a process is spawned:
 *
 *   - free space below `RELAY_MIN_FREE_DISK_BYTES` (default 20 GiB) refuses the
 *     launch. The Task row is untouched and stays queued, so the next launch
 *     attempt after space is freed proceeds normally;
 *   - a probe failure is NEVER a pass: the launch is refused with the probe
 *     error (fail closed);
 *   - every refusal is durable: event `run.launch_refused` with reason
 *     `low_disk` (or `probe_failed`), the measured bytes and the threshold. The
 *     dashboard and `relay status` read that event (and re-measure current
 *     space) so the refusal is visible without digging through logs.
 *
 * Sandbox Runs also probe the in-sandbox DinD volume (`/var/lib/docker`, 10g by
 * default) with a separate, smaller threshold (`RELAY_MIN_FREE_DIND_BYTES`,
 * default 2 GiB; 0 disables). That probe is an `sbx exec df`, the same cheap
 * transport the sandbox lifecycle already uses for liveness.
 */

export const LOW_DISK = "LOW_DISK";
export const DISK_PROBE_FAILED = "DISK_PROBE_FAILED";
export const LAUNCH_REFUSED_EVENT = "run.launch_refused";

/** 20 GiB: enough for a worktree plus a build tree, per ISH-1009. */
export const DEFAULT_MIN_FREE_DISK_BYTES = 20 * 1024 ** 3;
/** The sandbox DinD volume defaults to 10g, so its floor is deliberately lower. */
export const DEFAULT_MIN_FREE_DIND_BYTES = 2 * 1024 ** 3;

function envBytes(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) return fallback;
  return Math.floor(v);
}

/** Configured host/worktree floor. `0` turns off the low-water comparison. */
export function minFreeDiskBytes(env: NodeJS.ProcessEnv = process.env): number {
  return envBytes(env.RELAY_MIN_FREE_DISK_BYTES, DEFAULT_MIN_FREE_DISK_BYTES);
}

/** Configured in-sandbox DinD floor. `0` disables the DinD probe. */
export function minFreeDindBytes(env: NodeJS.ProcessEnv = process.env): number {
  return envBytes(env.RELAY_MIN_FREE_DIND_BYTES, DEFAULT_MIN_FREE_DIND_BYTES);
}

/** A probe returns free bytes for a path and throws when it cannot measure. */
export type DiskProbe = (path: string) => number;

export interface DiskProbeResult {
  path: string;
  freeBytes: number | null;
  error: string | null;
}

export interface DiskStatus {
  minFreeBytes: number;
  probes: DiskProbeResult[];
  /** The smallest successfully measured free space, or null when all failed. */
  freeBytes: number | null;
  ok: boolean;
  reason: "low_disk" | "probe_failed" | null;
  error: string | null;
}

/** The DB file behind this connection, or null for an in-memory DB. */
export function databaseFilePath(db: Database): string | null {
  try {
    const rows = db.query("PRAGMA database_list").all() as { name: string; file: string | null }[];
    const main = rows.find((r) => r.name === "main") ?? rows[0];
    if (!main?.file) return null;
    return resolve(main.file);
  } catch {
    return null;
  }
}

/**
 * The volumes a launch depends on: the worktrees root (where the Task workspace
 * and its build output live) and the Relay DB directory. `worktreesRoot` is
 * passed by the Task lifecycle when it is overridden; otherwise it mirrors
 * `taskWorktreesRoot()` (sibling of the DB).
 */
export function defaultDiskPaths(db: Database, opts: { worktreesRoot?: string | null } = {}): string[] {
  const dbPath = databaseFilePath(db) ?? defaultDbPath();
  const worktreesRoot = opts.worktreesRoot ? resolve(opts.worktreesRoot) : join(dirname(dbPath), "worktrees");
  return dedupePaths([worktreesRoot, dirname(dbPath)]);
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    const abs = resolve(p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

/**
 * Free bytes available to this user on the filesystem holding `path`.
 *
 * The path need not exist yet (the worktrees root often does not on a fresh
 * control plane): the nearest existing ancestor is measured, which is the same
 * volume a new directory will land on. Exceptions propagate so callers can fail
 * closed with the actual probe error.
 */
export function probeFreeBytes(path: string): number {
  let cur = resolve(path);
  for (;;) {
    if (existsSync(cur)) {
      const st = statfsSync(cur);
      return st.bavail * st.bsize;
    }
    const parent = dirname(cur);
    if (parent === cur) throw new Error(`no existing filesystem path at or above ${path}`);
    cur = parent;
  }
}

/** The in-sandbox DinD volume probe (`df -Pk /var/lib/docker`, available KiB). */
export function probeSandboxDindFreeBytes(cli: SbxCli, name: string): number {
  const r = cli.run(sbxExecArgv(name, bashLc("df -Pk /var/lib/docker 2>/dev/null | awk 'NR==2 {print $4}'")));
  if (!r.ok) {
    throw new Error(`sbx exec df /var/lib/docker failed (exit ${r.code ?? "?"}): ${(r.err || r.out).trim().slice(0, 300) || "no output"}`);
  }
  const raw = (r.out ?? "").trim().split(/\s+/).pop() ?? "";
  const kib = Number(raw);
  if (!Number.isFinite(kib) || kib < 0) {
    throw new Error(`sbx exec df /var/lib/docker returned no usable size: ${(r.out ?? "").trim().slice(0, 300) || "empty"}`);
  }
  return Math.floor(kib * 1024);
}

/** Pure decision: measure every path and compare the smallest value. */
export function evaluateDiskSpace(opts: {
  paths: string[];
  minFreeBytes: number;
  probe?: DiskProbe;
}): DiskStatus {
  const probe = opts.probe ?? probeFreeBytes;
  const paths = dedupePaths(opts.paths);
  const probes: DiskProbeResult[] = [];
  if (paths.length === 0) {
    return {
      minFreeBytes: opts.minFreeBytes,
      probes,
      freeBytes: null,
      ok: false,
      reason: "probe_failed",
      error: "no disk paths configured",
    };
  }
  let freeBytes: number | null = null;
  const errors: string[] = [];
  for (const path of paths) {
    try {
      const value = probe(path);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`probe returned an invalid free-space value: ${String(value)}`);
      }
      probes.push({ path, freeBytes: Math.floor(value), error: null });
      freeBytes = freeBytes === null ? Math.floor(value) : Math.min(freeBytes, Math.floor(value));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      probes.push({ path, freeBytes: null, error });
      errors.push(`${path}: ${error}`);
    }
  }
  if (errors.length > 0) {
    return {
      minFreeBytes: opts.minFreeBytes,
      probes,
      freeBytes,
      ok: false,
      reason: "probe_failed",
      error: errors.join("; "),
    };
  }
  if (opts.minFreeBytes > 0 && freeBytes !== null && freeBytes < opts.minFreeBytes) {
    return {
      minFreeBytes: opts.minFreeBytes,
      probes,
      freeBytes,
      ok: false,
      reason: "low_disk",
      error: null,
    };
  }
  return {
    minFreeBytes: opts.minFreeBytes,
    probes,
    freeBytes,
    ok: true,
    reason: null,
    error: null,
  };
}

/** Current status for this control plane (read-only; never throws). */
export function currentDiskStatus(db: Database, opts: { worktreesRoot?: string | null; paths?: string[] } = {}): DiskStatus {
  return evaluateDiskSpace({
    paths: opts.paths ?? defaultDiskPaths(db, { worktreesRoot: opts.worktreesRoot }),
    minFreeBytes: minFreeDiskBytes(),
  });
}

export type DiskRefusalReason = "low_disk" | "probe_failed";

export interface DiskRefusal {
  reason: DiskRefusalReason;
  /** Which launch path was refused. */
  target: "host" | "sandbox";
  /** The host volume check or the in-sandbox DinD check. */
  scope: "host" | "dind";
  taskId: string | null;
  phase: string | null;
  /** The sandbox whose DinD volume was measured (null for host checks). */
  sandbox: string | null;
  minFreeBytes: number;
  freeBytes: number | null;
  probes: DiskProbeResult[];
  error: string | null;
  message: string;
}

export class LaunchDiskError extends Error {
  readonly code: string;
  readonly refusal: DiskRefusal;

  constructor(refusal: DiskRefusal) {
    super(refusal.message);
    this.name = "LaunchDiskError";
    this.code = refusal.reason === "low_disk" ? LOW_DISK : DISK_PROBE_FAILED;
    this.refusal = refusal;
  }
}

export function isLaunchDiskError(e: unknown): e is LaunchDiskError {
  return e instanceof LaunchDiskError;
}

export interface DiskGuardOptions {
  /** Override the configured floor. `0` disables the comparison (probe still runs). */
  minFreeBytes?: number;
  /** Test/operator seam; may throw to simulate a probe failure. */
  probe?: DiskProbe;
  /** Override the paths measured (default: worktrees root + DB volume). */
  paths?: string[];
}

export interface AssertDiskOptions extends DiskGuardOptions {
  taskId?: string | null;
  phase?: string | null;
  target: "host" | "sandbox";
  scope?: "host" | "dind";
  /** The sandbox name for a DinD check (event evidence only). */
  sandbox?: string | null;
}

function refusalMessage(reason: DiskRefusalReason, target: "host" | "sandbox", scope: "host" | "dind", status: DiskStatus): string {
  const where = scope === "dind" ? "in-sandbox DinD volume" : target === "sandbox" ? "host volume for the sandbox Run" : "host volume for the Run";
  if (reason === "probe_failed") {
    return `${DISK_PROBE_FAILED}: refusing to launch a Run: free-space probe failed for the ${where}: ${status.error ?? "unknown probe error"}`;
  }
  return (
    `${LOW_DISK}: refusing to launch a Run: ${formatBytes(status.freeBytes)} free on the ${where} ` +
    `is below the ${formatBytes(status.minFreeBytes)} minimum; free space and retry`
  );
}

/**
 * Measure, emit a durable `run.launch_refused` on failure, then throw. Callers
 * invoke this BEFORE inserting a Run row / creating a workspace / spawning dsh,
 * so a refusal leaves the Task queued and starts nothing.
 */
export function assertLaunchDiskSpace(db: Database, opts: AssertDiskOptions): DiskStatus {
  const minFreeBytes = opts.minFreeBytes ?? minFreeDiskBytes();
  const status = evaluateDiskSpace({
    paths: opts.paths ?? defaultDiskPaths(db),
    minFreeBytes,
    probe: opts.probe,
  });
  if (status.ok) return status;
  const reason: DiskRefusalReason = status.reason === "probe_failed" ? "probe_failed" : "low_disk";
  const scope = opts.scope ?? "host";
  const message = refusalMessage(reason, opts.target, scope, status);
  const refusal: DiskRefusal = {
    reason,
    target: opts.target,
    scope,
    taskId: opts.taskId ?? null,
    phase: opts.phase ?? null,
    sandbox: opts.sandbox ?? null,
    minFreeBytes: status.minFreeBytes,
    freeBytes: status.freeBytes,
    probes: status.probes,
    error: status.error,
    message,
  };
  logEvent(db, {
    source: "disk-guard",
    taskId: opts.taskId ?? null,
    type: LAUNCH_REFUSED_EVENT,
    payload: {
      reason,
      target: opts.target,
      scope,
      taskId: opts.taskId ?? null,
      phase: opts.phase ?? null,
      sandbox: opts.sandbox ?? null,
      minFreeBytes: status.minFreeBytes,
      freeBytes: status.freeBytes,
      probes: status.probes,
      error: status.error,
      message,
    },
  });
  throw new LaunchDiskError(refusal);
}

export interface LaunchRefusalRecord {
  at: number;
  taskId: string | null;
  reason: string;
  target: string | null;
  scope: string | null;
  sandbox: string | null;
  minFreeBytes: number | null;
  freeBytes: number | null;
  error: string | null;
  message: string | null;
}

/** The latest durable launch refusal, for `relay status` / the dashboard. */
export function latestLaunchRefusal(db: Database): LaunchRefusalRecord | null {
  const row = db
    .query(`SELECT timestamp, task_id, payload_json FROM events WHERE type = ? ORDER BY id DESC LIMIT 1`)
    .get(LAUNCH_REFUSED_EVENT) as { timestamp: number; task_id: string | null; payload_json: string } | null;
  if (!row) return null;
  let p: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) p = parsed as Record<string, unknown>;
  } catch {
    /* malformed history is still a refusal; report the event itself */
  }
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    at: row.timestamp,
    taskId: row.task_id,
    reason: str(p.reason) ?? "unknown",
    target: str(p.target),
    scope: str(p.scope),
    sandbox: str(p.sandbox),
    minFreeBytes: num(p.minFreeBytes),
    freeBytes: num(p.freeBytes),
    error: str(p.error),
    message: str(p.message),
  };
}

/** Human bytes (`20.0 GiB`). Never throws on a missing/invalid measurement. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = Math.max(0, bytes);
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** The probe that best explains the status: an error first, else the smallest free value. */
export function worstDiskProbe(status: DiskStatus): DiskProbeResult | null {
  const failed = status.probes.find((p) => p.error !== null);
  if (failed) return failed;
  let worst: DiskProbeResult | null = null;
  for (const p of status.probes) {
    if (p.freeBytes === null) continue;
    if (!worst || (worst.freeBytes !== null && p.freeBytes < worst.freeBytes)) worst = p;
  }
  return worst;
}

/** One-line status/refusal summary shared by the dashboard and `relay status`. */
export function formatDiskStatus(status: DiskStatus): string {
  if (status.reason === "probe_failed") {
    return `probe FAILED: ${status.error ?? "unknown probe error"}; Run launches refused`;
  }
  if (status.reason === "low_disk") {
    return `${formatBytes(status.freeBytes)} free — BELOW the ${formatBytes(status.minFreeBytes)} minimum; Run launches refused`;
  }
  return `${formatBytes(status.freeBytes)} free (min ${formatBytes(status.minFreeBytes)})`;
}
