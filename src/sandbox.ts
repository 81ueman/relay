import type { Database } from "bun:sqlite";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { now, projectRoot } from "./db";
import { logEvent } from "./events";
import { childEnv } from "./child-env";
import type { Sandbox, SandboxState, Task } from "./schema";

/**
 * ISH-828 — Docker Sandboxes ("sbx") execution boundary and the durable
 * Task -> Coding Sandbox mapping.
 *
 * This module is deliberately THIN: it knows how to spell the `sbx`
 * create/exec/list/stop/rm commands and how to persist the mapping in SQLite.
 * It does NOT know about dsh, the Task phase machine, verification or review —
 * that composition is `src/sandbox-lifecycle.ts`.
 *
 * Design constraints (from ISH-828 / ISH-821):
 *   - ONE Task = ONE Coding Sandbox (a private in-container Git clone, Docker
 *     Sandboxes **clone mode**). `sbx create --clone` is run from the MAIN host
 *     checkout, never a linked git worktree — a worktree has no separate clone
 *     to hand to the sandbox and would leak the lane path.
 *   - The sandbox name/branch/HEAD mapping is DURABLE (SQLite), so a FIX reuses
 *     the SAME sandbox with a fresh dsh Run and the produced commit is fetched
 *     back with `git fetch sandbox-<name>`.
 *   - No new framework, no VM provider abstraction, no `relay lab`. The whole
 *     `sbx` surface is a few argv builders plus a synchronous runner seam.
 */

export const SANDBOX_ERROR = "SANDBOX_ERROR";
/** A second writer into the same Task sandbox was refused. */
export const DUPLICATE_SANDBOX_WRITER = "DUPLICATE_SANDBOX_WRITER";

// ---------------------------------------------------------------------------
// The `sbx` CLI seam (injectable so tests drive a fake binary, no Docker)
// ---------------------------------------------------------------------------

export interface SbxResult {
  ok: boolean;
  code: number | null;
  out: string;
  err: string;
}

export interface SbxRunOptions {
  cwd?: string;
  /** Hard budget for a single `sbx` invocation. */
  timeoutMs?: number;
}

/** The one-shot `sbx` verbs (create / ls / stop / rm / cp / inspect). */
export interface SbxCli {
  run(args: string[], opts?: SbxRunOptions): SbxResult;
}

function toSbxResult(e: unknown): SbxResult {
  const anyE = e as {
    status?: number | null;
    stdout?: Buffer | string;
    stderr?: Buffer | string;
    message?: string;
  };
  return {
    ok: false,
    code: typeof anyE.status === "number" ? anyE.status : null,
    out: (anyE.stdout ?? "").toString().trim(),
    err: (anyE.stderr ?? anyE.message ?? "").toString().trim(),
  };
}

/** The real boundary: `sbx <args>` as a host subprocess (never through a shell). */
export const realSbxCli: SbxCli = {
  run(args, opts = {}) {
    try {
      const out = execFileSync("sbx", args, {
        cwd: opts.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: opts.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        // ISH-828: the sbx client gets the small child allowlist, not all of process.env.
        env: childEnv(),
      });
      return { ok: true, code: 0, out: out.trim(), err: "" };
    } catch (e) {
      return toSbxResult(e);
    }
  },
};

/** `sbx create --clone --name <name> <agent> <source>` argv. Always clone mode. */
export function sbxCreateArgv(opts: {
  name: string;
  agent: string;
  source: string;
  cpus?: number;
  memory?: string;
}): string[] {
  const argv = ["create", "--clone", "--name", opts.name];
  if (opts.cpus && opts.cpus > 0) argv.push("--cpus", String(opts.cpus));
  if (opts.memory) argv.push("--memory", opts.memory);
  argv.push(opts.agent, opts.source);
  return argv;
}

/** `sbx exec [-w DIR] [-e K=V] <name> <argv...>` argv. */
export function sbxExecArgv(
  name: string,
  argv: string[],
  opts: { workdir?: string; env?: Record<string, string> } = {}
): string[] {
  const out = ["exec"];
  if (opts.workdir) out.push("-w", opts.workdir);
  for (const [k, v] of Object.entries(opts.env ?? {})) out.push("-e", `${k}=${v}`);
  out.push(name, ...argv);
  return out;
}

/** A `bash -lc <script>` command pair, the only shell form Relay uses in a sandbox. */
export function bashLc(script: string): [string, string, string] {
  return ["bash", "-lc", script];
}

export interface SandboxListEntry {
  name: string;
  agent?: string;
  status?: string;
  workspaces?: string[];
}

/** Parse `sbx ls --json`; a malformed/absent list is `[]` (never a fake entry). */
export function parseSandboxList(out: string): SandboxListEntry[] {
  try {
    const raw = JSON.parse(out);
    if (!Array.isArray(raw)) return [];
    const rows: SandboxListEntry[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      if (typeof o.name !== "string") continue;
      rows.push({
        name: o.name,
        agent: typeof o.agent === "string" ? o.agent : undefined,
        status: typeof o.status === "string" ? o.status : undefined,
        workspaces: Array.isArray(o.workspaces) ? o.workspaces.filter((w): w is string => typeof w === "string") : undefined,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

export function sbxList(cli: SbxCli = realSbxCli, opts: SbxRunOptions = {}): SbxListResult {
  const r = cli.run(["ls", "--json"], opts);
  if (!r.ok) {
    return { ok: false, sandboxes: [], error: r.err || `sbx ls exited ${r.code ?? "?"}` };
  }
  return { ok: true, sandboxes: parseSandboxList(r.out) };
}

export interface SbxListResult {
  /** False when `sbx ls` itself failed (never confused with an empty list). */
  ok: boolean;
  sandboxes: SandboxListEntry[];
  error?: string;
}

/**
 * Whether `name` is present, distinguishing a LISTING FAILURE (`ok:false`) from a
 * confirmed absent entry (`ok:true, present:false`). Callers must fail closed on
 * `ok:false` — never treat a transient `ls` error as "no sandboxes".
 */
export function sbxSandboxState(
  cli: SbxCli,
  name: string,
  opts: SbxRunOptions = {}
): { ok: boolean; present: boolean; entry: SandboxListEntry | null; error?: string } {
  const listing = sbxList(cli, opts);
  if (!listing.ok) return { ok: false, present: false, entry: null, error: listing.error };
  const entry = listing.sandboxes.find((s) => s.name === name) ?? null;
  return { ok: true, present: entry !== null, entry };
}

// ---------------------------------------------------------------------------
// Task -> sandbox identity
// ---------------------------------------------------------------------------

const SBX_NAME_RE = /[^a-zA-Z0-9.-]+/g;
/**
 * The sandbox name a Task owns: `relay-<issue-or-id>[-<slice>]-<hash8>`. The
 * trailing hash is derived from the Task's STABLE `id`, so two Tasks that share a
 * sanitised/truncated issue+slice slug (e.g. different providers, or an id that
 * collides after sanitising) still get distinct sandboxes ("別Taskは別Sandbox").
 * sbx names start with a letter/number and use only [A-Za-z0-9.-]; max 60 chars.
 */
export function sandboxNameForTask(task: Pick<Task, "id" | "issue_id" | "slice">): string {
  const hash = createHash("sha256").update(task.id).digest("hex").slice(0, 8);
  const base = (task.issue_id ?? task.id).toLowerCase();
  const slug = base.replace(SBX_NAME_RE, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  const slice = (task.slice ?? "").trim();
  const suffix = slice ? `-${slice.replace(SBX_NAME_RE, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")}` : "";
  // "relay-" (6) + slug (<=44) + "-" (1) + hash (8) <= 60.
  const body = `${slug || "task"}${suffix}`.slice(0, 44).replace(/[-.]+$/, "");
  return `relay-${body}-${hash}`;
}

/** The host git remote sbx configures for `<name>`'s clone (see ISH-822/828). */
export function sandboxRemote(name: string): string {
  return `sandbox-${name}`;
}

export interface MainCheckout {
  root: string;
  /** False when `dir` is a linked git worktree (git dir != common dir). */
  isMain: boolean;
}

/**
 * The MAIN checkout of the repo containing `dir`. `sbx create --clone` must run
 * against this, never a linked worktree. `isMain` is measured (git dir vs git
 * common dir), not assumed from the path shape.
 */
export function resolveMainCheckout(dir: string = projectRoot()): MainCheckout | null {
  const common = execFileSyncSafe(["git", "-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const gitDir = execFileSyncSafe(["git", "-C", dir, "rev-parse", "--path-format=absolute", "--git-dir"]);
  if (!common || !gitDir) return null;
  return { root: dirname(common), isMain: common === gitDir };
}

function execFileSyncSafe(argv: string[]): string | null {
  try {
    const out = execFileSync(argv[0], argv.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const t = out.trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** Run a host git command (never throws); used for the main-checkout guard. */
export function hostGit(cwd: string, args: string[]): SbxResult {
  const p = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return {
    ok: p.status === 0,
    code: p.status,
    out: (p.stdout ?? "").toString().trim(),
    err: (p.stderr ?? p.error?.message ?? "").toString().trim(),
  };
}

// ---------------------------------------------------------------------------
// Durable mapping (SQLite)
// ---------------------------------------------------------------------------

export function getSandbox(db: Database, taskId: string): Sandbox | null {
  return (db.query(`SELECT * FROM sandboxes WHERE task_id = ?`).get(taskId) as Sandbox | null) ?? null;
}

export function listSandboxes(db: Database, state?: SandboxState): Sandbox[] {
  const sql = state
    ? `SELECT * FROM sandboxes WHERE state = ? ORDER BY created_at ASC`
    : `SELECT * FROM sandboxes ORDER BY created_at ASC`;
  return (state ? db.query(sql).all(state) : db.query(sql).all()) as Sandbox[];
}

export interface UpsertSandboxInput {
  taskId: string;
  name: string;
  agent: string;
  source: string;
  workspace?: string | null;
  branch?: string | null;
  headSha?: string | null;
  state: SandboxState;
  evidenceDir?: string | null;
}

/** Insert or refresh the Task's sandbox mapping (one row per Task). */
export function upsertSandbox(db: Database, input: UpsertSandboxInput): Sandbox {
  const t = now();
  db.query(
    `INSERT INTO sandboxes (task_id, name, agent, source, workspace, branch, head_sha, state, evidence_dir, created_at, updated_at, removed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(task_id) DO UPDATE SET
       name = excluded.name,
       agent = excluded.agent,
       source = excluded.source,
       workspace = COALESCE(excluded.workspace, sandboxes.workspace),
       branch = COALESCE(excluded.branch, sandboxes.branch),
       head_sha = COALESCE(excluded.head_sha, sandboxes.head_sha),
       state = excluded.state,
       evidence_dir = COALESCE(excluded.evidence_dir, sandboxes.evidence_dir),
       updated_at = excluded.updated_at,
       removed_at = NULL`
  ).run(
    input.taskId,
    input.name,
    input.agent,
    input.source,
    input.workspace ?? null,
    input.branch ?? null,
    input.headSha ?? null,
    input.state,
    input.evidenceDir ?? null,
    t,
    t
  );
  return getSandbox(db, input.taskId)!;
}

export function updateSandboxState(
  db: Database,
  taskId: string,
  patch: Partial<Pick<Sandbox, "state" | "workspace" | "branch" | "head_sha" | "evidence_dir">>
): Sandbox | null {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (patch.state !== undefined) {
    sets.push("state = ?");
    args.push(patch.state);
  }
  if (patch.workspace !== undefined) {
    sets.push("workspace = ?");
    args.push(patch.workspace);
  }
  if (patch.branch !== undefined) {
    sets.push("branch = ?");
    args.push(patch.branch);
  }
  if (patch.head_sha !== undefined) {
    sets.push("head_sha = ?");
    args.push(patch.head_sha);
  }
  if (patch.evidence_dir !== undefined) {
    sets.push("evidence_dir = ?");
    args.push(patch.evidence_dir);
  }
  if (patch.state === "removed") sets.push(`removed_at = ${now()}`);
  if (sets.length === 0) return getSandbox(db, taskId);
  sets.push("updated_at = ?");
  args.push(now());
  args.push(taskId);
  db.query(`UPDATE sandboxes SET ${sets.join(", ")} WHERE task_id = ?`).run(...(args as (string | number | null)[]));
  return getSandbox(db, taskId);
}

/** Record the sandbox mapping transition on the durable event log. */
export function logSandbox(db: Database, taskId: string, type: string, payload: Record<string, unknown>): void {
  logEvent(db, { source: "sandbox", taskId, type, payload });
}
