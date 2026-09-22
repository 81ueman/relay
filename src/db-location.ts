import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { STATE_DIR, defaultDbPath, gitRepoRoot, outsideRepoDefault } from "./db";

/**
 * T332: control-plane DB location.
 *
 * Historically the control plane lives INSIDE the repo (`<repo>/.relay/`). That
 * is fine for a worktree of the SAME repo (T242 resolves the git common dir),
 * but a DIFFERENT repo (e.g. the relay tool's own worktree coordinating the
 * nv-papers fleet) cannot reach it without a `.relay` symlink or RELAY_DB; moving
 * or renaming a repo moves the control plane; and there is no single fleet view.
 *
 * This module adds an OUTSIDE-the-repo location and a specified resolution order,
 * WITHOUT changing behaviour for existing repos:
 *
 *   1. RELAY_DB env             (explicit wins, always)
 *   2. ~/.config/relay/config.json  {"db": "<path>"}   (explicit, per-user)
 *   3. legacy <repo>/.relay/state.db if it EXISTS      (backward compatible)
 *   4. XDG default ~/.local/state/relay/<project-id>/state.db
 *
 * The socket always lives NEXT TO the db (see db.ts defaultSockPath), so a shared
 * control plane shares its socket automatically.
 *
 * A "project" is identified by a STABLE slug of its control-plane root (the git
 * main worktree root, NOT the cwd), so the same project resolves to the same
 * directory from any subdirectory or linked worktree, and a repo MOVE keeps the
 * id (the id follows the root path, so a move changes it — `relay db move` copies
 * the ledger, which is the supported way to carry it).
 */

export interface Config {
  db?: string;
}

export function configPath(env = process.env, home = homedir()): string {
  if (env.RELAY_CONFIG) return resolve(env.RELAY_CONFIG);
  const xdg = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : join(home, ".config");
  return join(xdg, "relay", "config.json");
}

export function readConfig(path = configPath()): Config {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Config) : {};
  } catch (e) {
    throw new Error(`relay config ${path} is not valid JSON: ${String(e).slice(0, 120)}`);
  }
}

export function stateHome(env = process.env, home = homedir()): string {
  const xdg = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME
    : join(home, ".local", "state");
  return join(xdg, "relay");
}

/**
 * Stable project id: a short readable slug of the repo name plus a hash of the
 * ABSOLUTE control-plane root. The hash keeps two same-named repos apart; the
 * slug keeps it human-readable. Not derived from the cwd (a subdirectory must
 * resolve to the same project). Mirrors `outsideRepoDefault` in db.ts.
 */
export function projectId(root: string): string {
  const abs = resolve(root);
  const name = abs.split("/").filter(Boolean).pop() ?? "project";
  const slug = name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

/**
 * The control-plane root for `dir`: the git main worktree root when there is
 * one, else the nearest ancestor carrying a project anchor (`.git` file/dir or
 * `.relay`), else `dir` itself.
 *
 * The ancestor walk matters for NON-git projects: without it a subdirectory
 * would hash to its own project id and split the ledger. It also matches the
 * legacy resolution, which already walks up to find `.relay`.
 */
export function controlPlaneRoot(dir = process.cwd()): string {
  const git = gitRepoRoot(dir);
  if (git) return git;
  let cur = resolve(dir);
  for (;;) {
    if (existsSync(join(cur, ".git")) || existsSync(join(cur, STATE_DIR))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return resolve(dir);
}

/**
 * The XDG default DB path for a directory, independent of whether it exists.
 * Delegates to db.ts so the location can never drift between the two modules.
 */
export function xdgDefaultDbPath(dir = process.cwd(), env = process.env, home = homedir()): string {
  return outsideRepoDefault(dir, env, home);
}

/** Find a legacy `<repo>/.relay/state.db` walking up from `dir` (T242 semantics). */
export function findLegacyDb(dir = process.cwd(), env: NodeJS.ProcessEnv = process.env): string | null {
  // Mirror db.ts's legacy resolution (ancestor walk + git-common-dir fallback),
  // but with the caller's env, so a test's injected RELAY_DB does not leak in.
  if (env.RELAY_DB) return null; // an explicit env DB is handled by the caller
  let cur = resolve(dir);
  for (;;) {
    const p = join(cur, STATE_DIR, "state.db");
    if (existsSync(p)) return p;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const root = gitRepoRoot(dir);
  if (root && existsSync(join(root, STATE_DIR, "state.db"))) {
    return join(root, STATE_DIR, "state.db");
  }
  return null;
}

export type DbSource = "env" | "config" | "legacy" | "xdg";

export interface ResolvedDb {
  path: string;
  source: DbSource;
}

/**
 * Resolve the control-plane DB path (and its source) WITHOUT creating anything.
 * Mirrors the order documented at the top of this file.
 */
export function resolveDb(opts: { dir?: string; env?: NodeJS.ProcessEnv; home?: string; config?: Config } = {}): ResolvedDb {
  const dir = opts.dir ?? process.cwd();
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();

  if (env.RELAY_DB) return { path: resolve(env.RELAY_DB), source: "env" };

  const cfg = opts.config ?? readConfig(configPath(env, home));
  if (cfg.db) return { path: resolve(cfg.db), source: "config" };

  const legacy = findLegacyDb(dir, env);
  if (legacy) return { path: legacy, source: "legacy" };

  return { path: xdgDefaultDbPath(dir, env, home), source: "xdg" };
}
/** Sidecar files that belong to a control plane (move them all, or lose state). */
const SIDECARS = ["state.db", "state.db-wal", "state.db-shm", "relay.sock", "relay.lock"];

export interface MovePlan {
  from: string;
  to: string;
  files: string[];
  /** True when the destination already has a state.db (would be overwritten). */
  destinationExists: boolean;
  sourceExists: boolean;
}

/** Plan a control-plane move. Pure: inspects the filesystem, changes nothing. */
export function planDbMove(from: string, to: string): MovePlan {
  const fromDir = dirname(resolve(from));
  const files: string[] = [];
  for (const f of SIDECARS) {
    if (existsSync(join(fromDir, f))) files.push(join(fromDir, f));
  }
  return {
    from: resolve(from),
    to: resolve(to),
    files,
    destinationExists: existsSync(resolve(to)),
    sourceExists: existsSync(resolve(from)),
  };
}

/**
 * Apply a move. Refuses to overwrite an existing destination (never clobber a
 * ledger) and refuses if a live socket is present (a daemon may be writing).
 * `renameSync` is atomic on the same filesystem; across filesystems it throws,
 * which surfaces as an error rather than a partial copy.
 */
export function applyDbMove(plan: MovePlan, opts: { force?: boolean } = {}): string[] {
  if (!plan.sourceExists) throw new Error(`no control-plane DB at ${plan.from}`);
  if (plan.destinationExists && !opts.force) {
    throw new Error(`refusing to overwrite an existing control-plane DB at ${plan.to} (pass --force to replace)`);
  }
  const liveSock = join(dirname(plan.from), "relay.sock");
  if (existsSync(liveSock)) {
    throw new Error(`a socket exists at ${liveSock}: a daemon may be live on this control plane. Stop it (or use --force) before moving.`);
  }
  mkdirSync(dirname(plan.to), { recursive: true });
  const moved: string[] = [];
  // state.db first, then its WAL/SHM. If the DB moves but a WAL is left behind
  // the ledger loses recent commits, so this must be all-or-error.
  for (const src of plan.files) {
    const base = src.slice(dirname(plan.from).length + 1);
    const dst = join(dirname(plan.to), base);
    try {
      if (opts.force && existsSync(dst)) rmSync(dst);
      renameSync(src, dst);
      moved.push(dst);
    } catch (e) {
      throw new Error(`failed to move ${src} -> ${dst}: ${String(e).slice(0, 160)}`);
    }
  }
  return moved;
}

/** True when `path` sits under any repo's `.relay` (the legacy in-repo layout). */
export function isLegacyLocation(path: string): boolean {
  return dirname(resolve(path)).endsWith(`/${STATE_DIR}`);
}

/** Human one-liner for `relay db path`. */
export function describeDb(r: ResolvedDb, dir = process.cwd()): string {
  const where = r.source === "legacy" ? " (legacy in-repo)" : r.source === "env" ? " (RELAY_DB)" : r.source === "config" ? " (config)" : " (xdg default)";
  const exists = existsSync(r.path) ? "exists" : "absent";
  const project = projectId(controlPlaneRoot(dir));
  return `${r.path}${where}  [${exists}]  project=${project}`;
}

// re-export for callers that only need the constant
export { STATE_DIR };

/** Best-effort: is a relay daemon process running for this repo? (for `db move`) */
export function daemonLooksLive(dbPath: string): boolean {
  const sock = join(dirname(resolve(dbPath)), "relay.sock");
  if (!existsSync(sock)) return false;
  try {
    const st = statSync(sock);
    return st.isSocket();
  } catch {
    return false;
  }
}

/** A tiny helper for tests: the lock file path beside a db. */
export function lockPathFor(dbPath: string): string {
  return join(dirname(resolve(dbPath)), "relay.lock");
}

/** Kept for symmetry with daemon/singleton usage. */
export function canonicalRootForMove(dir = process.cwd()): string {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return resolve(dir);
  }
}
