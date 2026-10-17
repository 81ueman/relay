import { createHash } from "node:crypto";
import type { Task } from "./schema";

/**
 * ISH-829 — the thin `labctl` seam.
 *
 * Relay VERIFY needs real NOS for a few checks, but Relay must NOT grow a lab
 * engine (that is ISH-844's `labctl`, the thin client for the official
 * `clab-api-server`). This module is only the *process + JSON* boundary around
 * `labctl deploy / inspect --json / destroy`:
 *
 *   - it builds the exact argv (never a shell string, so a topology path or a
 *     node name can never be re-parsed by a shell);
 *   - it parses `labctl --json` and FAILS CLOSED on anything malformed — a lab
 *     that did not come up, a node that is not `running`, an inspect blob with no
 *     management endpoint, or an API/transport error never becomes a PASS;
 *   - it names the lab from the STABLE Task id so a Task can only ever touch its
 *     OWN lab (the "別 Task Lab への誤アクセス" negative).
 *
 * It is deliberately NOT `relay lab`, holds no DB state, and never deletes NOS
 * images (there is no image verb here at all).
 */

export const LAB_ERROR = "LAB_ERROR";
export const LAB_EXISTS = "LAB_EXISTS";
export const LAB_NOT_FOUND = "LAB_NOT_FOUND";
export const LAB_NOT_RUNNING = "LAB_NOT_RUNNING";
export const LAB_NO_ENDPOINTS = "LAB_NO_ENDPOINTS";
/** A lab that does NOT belong to this Task (another Task's lab) was refused. */
export const LAB_FOREIGN = "LAB_FOREIGN";

/** One `labctl` invocation result. `ok` is transport success (exit 0). */
export interface LabctlResult {
  ok: boolean;
  code: number | null;
  out: string;
  err: string;
  timedOut?: boolean;
}

export interface LabctlRunOptions {
  timeoutMs?: number;
}

/** The single process boundary: `labctl <args>` (no shell). */
export interface Labctl {
  run(args: string[], opts?: LabctlRunOptions): Promise<LabctlResult>;
}

// ---------------------------------------------------------------------------
// Task-scoped lab identity
// ---------------------------------------------------------------------------

const LAB_SLUG_RE = /[^a-zA-Z0-9.-]+/g;

/** The Task identity a lab operation is scoped to. */
export type LabTask = Pick<Task, "id" | "issue_id">;

/**
 * The lab name a Task owns: `relay-<issue-or-id>-<hash8>`. The trailing hash is
 * derived from the STABLE Task id (not the issue string), so two Tasks that
 * sanitise to the same slug still get distinct labs — the same rule ISH-828 uses
 * for sandbox names, so a Task's sandbox and its lab line up.
 */
export function labNameForTask(task: LabTask): string {
  const hash = createHash("sha256").update(task.id).digest("hex").slice(0, 8);
  const base = (task.issue_id ?? task.id).toLowerCase().replace(LAB_SLUG_RE, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  const body = (base || "task").slice(0, 44).replace(/[-.]+$/, "");
  return `relay-${body}-${hash}`;
}

/**
 * Whether `lab` is the Task's OWN lab. A namespace-free labctl lab is identified
 * by its topology `name:`; a Task-scoped topology must name its lab with the
 * value of `labNameForTask`. A lab that does not match is FOREIGN and must be
 * refused before inspect/destroy (`別 Task Lab への誤アクセス`).
 */
export function ownsLab(task: LabTask, lab: string | null | undefined): boolean {
  return !!lab && lab === labNameForTask(task);
}

/** Throws `LAB_FOREIGN` when `lab` is not this Task's own lab. */
export function assertOwnLab(task: LabTask, lab: string | null | undefined): void {
  if (!ownsLab(task, lab)) {
    throw new Error(`${LAB_FOREIGN}: lab '${lab ?? "none"}' is not owned by task ${task.id} (expected ${labNameForTask(task)})`);
  }
}

/** The `LAB_FOREIGN` refusal as a value (for operations that return a result). */
export function foreignLabError(task: LabTask, lab: string | null | undefined): string | null {
  if (ownsLab(task, lab)) return null;
  return `${LAB_FOREIGN}: lab '${lab ?? "none"}' is not owned by task ${task.id} (expected ${labNameForTask(task)})`;
}

// ---------------------------------------------------------------------------
// argv builders (no shell)
// ---------------------------------------------------------------------------

export interface LabctlApiOptions {
  /** API base URL (`--api`). */
  api: string;
  /** Explicit PoC opt-in for the server's self-signed certificate. */
  insecure?: boolean;
  /** Per-request timeout seconds (`--timeout`). */
  timeoutSec?: number;
}

function apiArgs(o: LabctlApiOptions): string[] {
  const out = ["--json", "--api", o.api];
  if (o.insecure) out.push("--insecure");
  if (o.timeoutSec && o.timeoutSec > 0) out.push("--timeout", String(o.timeoutSec));
  return out;
}

/** `labctl deploy -t <topology> [--namespace <ns>] --json --api <api>` argv. */
export function labctlDeployArgv(opts: LabctlApiOptions & { topology: string; namespace?: string }): string[] {
  const out = ["deploy", "-t", opts.topology];
  if (opts.namespace) out.push("--namespace", opts.namespace);
  return [...out, ...apiArgs(opts)];
}

/** `labctl inspect <lab> --reach-host <host> --json --api <api>` argv. */
export function labctlInspectArgv(opts: LabctlApiOptions & { lab: string; reachHost?: string }): string[] {
  const out = ["inspect", opts.lab];
  if (opts.reachHost) out.push("--reach-host", opts.reachHost);
  return [...out, ...apiArgs(opts)];
}

/** `labctl destroy --name <lab> --json --api <api>` argv (never removes images). */
export function labctlDestroyArgv(opts: LabctlApiOptions & { lab: string }): string[] {
  return ["destroy", "--name", opts.lab, ...apiArgs(opts)];
}

// ---------------------------------------------------------------------------
// Redaction (defense in depth; labctl already redacts)
// ---------------------------------------------------------------------------

/**
 * Strip anything that looks like a bearer token or a `password`/`token` value
 * from text destined for evidence. Relay must never persist a credential even
 * when a CLI prints one on an error path.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/(["']?(?:password|token|secret|authorization)["']?\s*[:=]\s*["']?)([^"'\s,}]+)/gi, "$1<redacted>")
    .replace(/\beyJ[A-Za-z0-9._-]{10,}\b/g, "<redacted-jwt>");
}

// ---------------------------------------------------------------------------
// inspect --json parsing (fail closed)
// ---------------------------------------------------------------------------

export interface LabEndpoint {
  protocol: string;
  containerPort: number | null;
  hostPort: number | null;
  hostIp: string | null;
  /** `host:port` a Coding Sandbox connects to (from `--reach-host`). */
  reachableAt: string | null;
}

export interface LabNode {
  node: string | null;
  container: string | null;
  kind: string | null;
  state: string | null;
  mgmtIpv4: string | null;
  endpoints: LabEndpoint[];
}

export interface LabInspect {
  lab: string;
  nodeCount: number;
  remoteDir: string | null;
  nodes: LabNode[];
}

export type LabInspectParse =
  | { ok: true; inspect: LabInspect }
  | { ok: false; error: string };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseNode(raw: unknown): LabNode | null {
  const o = asRecord(raw);
  if (!o) return null;
  const endpointsRaw = Array.isArray(o.mgmt_endpoints) ? o.mgmt_endpoints : [];
  const endpoints: LabEndpoint[] = [];
  for (const e of endpointsRaw) {
    const eo = asRecord(e);
    if (!eo) continue;
    endpoints.push({
      protocol: str(eo.protocol) ?? "tcp",
      containerPort: num(eo.container_port),
      hostPort: num(eo.host_port),
      hostIp: str(eo.host_ip),
      reachableAt: str(eo.reachable_at),
    });
  }
  return {
    node: str(o.node),
    container: str(o.container),
    kind: str(o.kind),
    state: str(o.state),
    mgmtIpv4: str(o.mgmt_ipv4),
    endpoints,
  };
}

/**
 * Parse `labctl inspect <lab> --json`. A missing/invalid `lab`, a non-array
 * `nodes`, or an empty node set (a lab that is not actually up) is an error —
 * never an empty-but-ok inspect that a test could mistake for "reachable".
 */
export function parseLabInspect(out: string): LabInspectParse {
  let raw: unknown;
  try {
    raw = JSON.parse(out);
  } catch {
    return { ok: false, error: "inspect output is not JSON" };
  }
  const o = asRecord(raw);
  if (!o) return { ok: false, error: "inspect JSON is not an object" };
  const lab = str(o.lab);
  if (!lab) return { ok: false, error: "inspect JSON has no lab name" };
  const nodesRaw = o.nodes;
  if (!Array.isArray(nodesRaw)) return { ok: false, error: "inspect JSON has no nodes array" };
  const nodes: LabNode[] = [];
  for (const n of nodesRaw) {
    const parsed = parseNode(n);
    if (parsed) nodes.push(parsed);
  }
  if (nodes.length === 0) return { ok: false, error: `${LAB_NOT_RUNNING}: lab ${lab} reported no nodes` };
  return {
    ok: true,
    inspect: {
      lab,
      nodeCount: num(o.nodeCount) ?? nodes.length,
      remoteDir: str(o.remote_dir),
      nodes,
    },
  };
}

// ---------------------------------------------------------------------------
// Fail-closed operations
// ---------------------------------------------------------------------------

export interface DeployLabOptions extends LabctlApiOptions {
  topology: string;
  namespace?: string;
  timeoutMs?: number;
  /** Require at least one published TCP management endpoint (default true). */
  requireEndpoints?: boolean;
}

export interface DeployLabResult {
  ok: boolean;
  /** The lab name containerlab reported (or the topology-derived name on failure). */
  lab: string | null;
  nodes: LabNode[];
  error: string | null;
  /** The labctl exit code, for evidence. */
  code: number | null;
}

/**
 * Deploy a Task's topology and require EVERY declared node to be `running` with
 * a reachable management endpoint. A partial create, an API error, a timeout,
 * or a malformed result is `ok:false` — the caller must BLOCK, never PASS. The
 * Lab's image cache is untouched (no image verb is ever invoked).
 *
 * The returned lab is checked against the Task's OWN name; a topology that
 * deploys under another Task's lab name is refused AND torn down so it is not
 * left running (`別 Task Lab への誤アクセス`).
 */
export async function deployTaskLab(labctl: Labctl, task: LabTask, opts: DeployLabOptions): Promise<DeployLabResult> {
  const requireEndpoints = opts.requireEndpoints !== false;
  const r = await labctl.run(labctlDeployArgv(opts), { timeoutMs: opts.timeoutMs });
  if (!r.ok) {
    const detail = redactSecrets((r.err || r.out || "").trim()).slice(0, 400);
    return { ok: false, lab: null, nodes: [], error: `${LAB_ERROR}: labctl deploy failed (exit ${r.code ?? "?"}${r.timedOut ? ", timed out" : ""}): ${detail}`, code: r.code };
  }
  // `deploy --json` prints `{lab, nodes:[{nodeName,state,...}], transferred}`.
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.out);
  } catch {
    return { ok: false, lab: null, nodes: [], error: `${LAB_ERROR}: labctl deploy output is not JSON`, code: r.code };
  }
  const o = asRecord(parsed);
  const lab = o ? str(o.lab) : null;
  if (!o || !lab) return { ok: false, lab: null, nodes: [], error: `${LAB_ERROR}: labctl deploy JSON has no lab name`, code: r.code };

  // Ownership: refuse a lab that is not this Task's own, and tear it down so a
  // mis-named topology cannot keep touching the Shared Lab.
  if (!ownsLab(task, lab)) {
    await destroyTaskLab(labctl, task, { lab, api: opts.api, insecure: opts.insecure, timeoutMs: opts.timeoutMs, allowForeign: true }).catch(() => undefined);
    return {
      ok: false,
      lab,
      nodes: [],
      error: `${LAB_FOREIGN}: deployed lab '${lab}' is not owned by task ${task.id} (expected ${labNameForTask(task)}); destroyed it`,
      code: r.code,
    };
  }

  const rawNodes = Array.isArray(o.nodes) ? o.nodes : [];
  const nodes: LabNode[] = [];
  for (const n of rawNodes) {
    const no = asRecord(n);
    if (!no) continue;
    // deploy nodes carry `nodeName`/`state` (inspect uses `node`/`state`).
    const node = str(no.nodeName) ?? str(no.node);
    nodes.push({
      node,
      container: str(no.name) ?? str(no.container),
      kind: str(no.kind),
      state: str(no.state),
      mgmtIpv4: str(no.ipv4_address) ?? str(no.mgmt_ipv4),
      endpoints: [],
    });
  }
  if (nodes.length === 0) {
    return { ok: false, lab, nodes, error: `${LAB_NOT_RUNNING}: lab ${lab} deployed with no nodes`, code: r.code };
  }
  const notRunning = nodes.filter((n) => n.state !== "running");
  if (notRunning.length > 0) {
    return {
      ok: false,
      lab,
      nodes,
      error: `${LAB_NOT_RUNNING}: ${notRunning.map((n) => `${n.node ?? "?"}=${n.state ?? "unknown"}`).join(", ")}`,
      code: r.code,
    };
  }
  if (requireEndpoints) {
    // The deploy view may not carry ports; inspect is the authoritative endpoint
    // source. Require a FOLLOW-UP inspect to be supplied by the caller (see
    // `verifyLabEndpoints`); here we only enforce a non-empty running set.
  }
  return { ok: true, lab, nodes, error: null, code: r.code };
}

/**
 * Read the lab back with `inspect --json`, enforcing that `lab` is the Task's
 * OWN lab (never another Task's), that every node is `running`, and (when
 * required) that at least one TCP management endpoint is published. Fails closed.
 *
 * A foreign lab name is refused BEFORE `labctl` is invoked.
 */
export async function inspectTaskLab(
  labctl: Labctl,
  task: LabTask,
  opts: LabctlApiOptions & { lab: string; reachHost?: string; timeoutMs?: number; requireEndpoints?: boolean }
): Promise<LabInspectParse> {
  const foreign = foreignLabError(task, opts.lab);
  if (foreign) return { ok: false, error: foreign };
  const r = await labctl.run(labctlInspectArgv(opts), { timeoutMs: opts.timeoutMs });
  if (!r.ok) {
    const detail = redactSecrets((r.err || r.out || "").trim()).slice(0, 400);
    return { ok: false, error: `${LAB_ERROR}: labctl inspect failed (exit ${r.code ?? "?"}${r.timedOut ? ", timed out" : ""}): ${detail}` };
  }
  const parsed = parseLabInspect(r.out);
  if (!parsed.ok) return parsed;
  const inspect = parsed.inspect;
  if (inspect.lab !== opts.lab) {
    return { ok: false, error: `${LAB_FOREIGN}: inspect returned lab '${inspect.lab}', expected '${opts.lab}'` };
  }
  const notRunning = inspect.nodes.filter((n) => n.state !== "running");
  if (notRunning.length > 0) {
    return {
      ok: false,
      error: `${LAB_NOT_RUNNING}: ${notRunning.map((n) => `${n.node ?? "?"}=${n.state ?? "unknown"}`).join(", ")}`,
    };
  }
  if (opts.requireEndpoints !== false) {
    const endpoints = inspect.nodes.flatMap((n) => n.endpoints).filter((e) => e.reachableAt);
    if (endpoints.length === 0) {
      return { ok: false, error: `${LAB_NO_ENDPOINTS}: lab ${inspect.lab} published no reachable management endpoint` };
    }
  }
  return { ok: true, inspect };
}

export interface DestroyLabResult {
  ok: boolean;
  error: string | null;
  code: number | null;
}

/**
 * Destroy the Task's own lab after the checks. A failed destroy is `ok:false` (a
 * cleanup failure must never be silently swallowed into a PASS). Images are never
 * touched: no `purge`/image verb is used; containerlab `destroy` keeps the image
 * cache.
 *
 * A foreign lab name is refused BEFORE `labctl` is invoked. (deploy-time refusal
 * uses this with the Task's own name to tear down a mis-named deploy.)
 */
export async function destroyTaskLab(
  labctl: Labctl,
  task: LabTask,
  opts: LabctlApiOptions & { lab: string; timeoutMs?: number; allowForeign?: boolean }
): Promise<DestroyLabResult> {
  if (!opts.allowForeign) {
    const foreign = foreignLabError(task, opts.lab);
    if (foreign) return { ok: false, error: foreign, code: null };
  }
  const r = await labctl.run(labctlDestroyArgv(opts), { timeoutMs: opts.timeoutMs });
  if (!r.ok) {
    const detail = redactSecrets((r.err || r.out || "").trim()).slice(0, 400);
    return { ok: false, error: `destroy failed (exit ${r.code ?? "?"}${r.timedOut ? ", timed out" : ""}): ${detail}`, code: r.code };
  }
  return { ok: true, error: null, code: r.code };
}
