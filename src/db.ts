import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { SCHEMA } from "./schema";

export const STATE_DIR = ".relay";

/**
 * The MAIN worktree root of the git repository containing `dir`, or null when
 * `dir` is not in a git repo (or git is unavailable).
 *
 * A linked git worktree (e.g. `~/.herdr/worktrees/<repo>/<lane>`) has no
 * ancestor `.relay`, so the directory walk cannot find the control plane. The
 * git COMMON dir always points at the MAIN checkout's `.git`, whose parent is
 * the main worktree root — same repository, so this never cross-routes to
 * another project's control plane.
 */
export function gitRepoRoot(dir: string): string | null {
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    return dirname(out);
  } catch {
    return null;
  }
}

export function defaultDbPath(cwd = process.cwd()): string {
  if (process.env.RELAY_DB) return resolve(process.env.RELAY_DB);
  // Reuse the checkout's EXISTING control plane. Running a relay command from a
  // subdirectory must not silently create a SECOND `.relay/state.db` there (that
  // split the task ledger); walk up to the nearest existing one.
  let cur = resolve(cwd);
  for (;;) {
    const p = join(cur, STATE_DIR, "state.db");
    if (existsSync(p)) return p;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // Worktree fallback: a linked worktree lives outside the main checkout, with
  // no ancestor `.relay`. Resolve the MAIN repo through the git common dir and
  // reuse ITS control plane, so a worktree session/CLI finds the daemon/socket
  // automatically instead of creating a split ledger.
  const root = gitRepoRoot(cwd);
  if (root && existsSync(join(root, STATE_DIR))) {
    return join(root, STATE_DIR, "state.db");
  }
  // T332: no in-repo control plane found. Backward compatible default: the cwd
  // `.relay` (unchanged). An EXPLICIT config `db` (or RELAY_DB, handled above)
  // can point the CLI at a shared control plane outside the repo; the XDG
  // location is reachable via `relay db`/`outsideRepoDefault` but is NOT imposed
  // on a directory that previously used `<cwd>/.relay`.
  const cfgDb = explicitConfigDb();
  if (cfgDb) return cfgDb;
  return join(cwd, STATE_DIR, "state.db");
}

/** An explicit `db` from ~/.config/relay/config.json, or null. */
function explicitConfigDb(): string | null {
  const cfgPath = relayConfigPath();
  if (!existsSync(cfgPath)) return null;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as { db?: string };
    if (cfg && typeof cfg.db === "string" && cfg.db) return resolve(cfg.db);
  } catch (e) {
    throw new Error(`relay config ${cfgPath} is not valid JSON: ${String(e).slice(0, 120)}`);
  }
  return null;
}

/** `~/.config/relay/config.json` (or $RELAY_CONFIG / $XDG_CONFIG_HOME). */
function relayConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.RELAY_CONFIG) return resolve(env.RELAY_CONFIG);
  const xdg = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config");
  return join(xdg, "relay", "config.json");
}

/**
 * The T332 out-of-repo default: an explicit config `db` wins, else the fixed XDG
 * state location `~/.local/state/relay/<project-id>/state.db`, where the project
 * id is a stable slug of the git MAIN worktree root (NOT the cwd), so the same
 * project resolves identically from any subdirectory or linked worktree.
 *
 * `env`/`home` are injectable so tests can drive the resolution without touching
 * the real user environment.
 */
export function outsideRepoDefault(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.RELAY_DB) return resolve(env.RELAY_DB);
  const cfgPath = relayConfigPath(env, home);
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as { db?: string };
      if (cfg && typeof cfg.db === "string" && cfg.db) return resolve(cfg.db);
    } catch (e) {
      throw new Error(`relay config ${cfgPath} is not valid JSON: ${String(e).slice(0, 120)}`);
    }
  }
  const root = projectRoot(cwd);
  const name = root.split("/").filter(Boolean).pop() ?? "project";
  const slug = name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  const hash = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 12);
  const xdgState = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME
    : join(home, ".local", "state");
  return join(xdgState, "relay", `${slug}-${hash}`, "state.db");
}

/**
 * The project anchor for a directory: the git main worktree root, else the
 * nearest ancestor carrying `.git` or `.relay`, else `dir`. Mirrored in
 * db-location.ts `controlPlaneRoot` (db.ts cannot import it: that module imports
 * db.ts). The ancestor walk is what keeps a subdirectory from hashing to its own
 * project id and splitting the ledger.
 */
export function projectRoot(dir = process.cwd()): string {
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

export function defaultSockPath(cwd = process.cwd()): string {
  if (process.env.RELAY_SOCK) return resolve(process.env.RELAY_SOCK);
  // The socket lives beside the resolved DB (same control plane).
  return join(dirname(defaultDbPath(cwd)), "relay.sock");
}

function columnExists(db: Database, table: string, column: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

/** Idempotent migrations for DBs created by older versions. */
function migrate(db: Database): void {
  if (columnExists(db, "workers", "id")) {
    if (!columnExists(db, "workers", "cwd")) {
      db.exec("ALTER TABLE workers ADD COLUMN cwd TEXT;");
    }
    if (!columnExists(db, "workers", "command")) {
      db.exec("ALTER TABLE workers ADD COLUMN command TEXT;");
    }
    // Which agent runtime the worker is (opencode vs codex): codex has no plugin
    // event stream, so liveness is polled from Herdr agent status. Existing rows
    // are opencode.
    if (!columnExists(db, "workers", "agent_kind")) {
      db.exec("ALTER TABLE workers ADD COLUMN agent_kind TEXT NOT NULL DEFAULT 'opencode';");
    }
    // Retirement tombstone: see Worker.retired_at. The index is created here (not
    // in SCHEMA) because SCHEMA runs first on DBs that predate the column.
    if (!columnExists(db, "workers", "retired_at")) {
      db.exec("ALTER TABLE workers ADD COLUMN retired_at INTEGER;");
    }
    if (!columnExists(db, "workers", "retired_reason")) {
      db.exec("ALTER TABLE workers ADD COLUMN retired_reason TEXT;");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_workers_retired ON workers(retired_at);");
    // Quiet lease metadata (bounded intentional session-idle permission).
    if (!columnExists(db, "workers", "quiet_until")) {
      db.exec("ALTER TABLE workers ADD COLUMN quiet_until INTEGER;");
    }
    if (!columnExists(db, "workers", "quiet_reason")) {
      db.exec("ALTER TABLE workers ADD COLUMN quiet_reason TEXT;");
    }
    if (!columnExists(db, "workers", "quiet_task_id")) {
      db.exec("ALTER TABLE workers ADD COLUMN quiet_task_id TEXT;");
    }
    // In-flight tool marker (early hang detection: `tool.started` from the plugin).
    if (!columnExists(db, "workers", "tool_name")) {
      db.exec("ALTER TABLE workers ADD COLUMN tool_name TEXT;");
    }
    if (!columnExists(db, "workers", "tool_command")) {
      db.exec("ALTER TABLE workers ADD COLUMN tool_command TEXT;");
    }
    if (!columnExists(db, "workers", "tool_started_at")) {
      db.exec("ALTER TABLE workers ADD COLUMN tool_started_at INTEGER;");
    }
    if (!columnExists(db, "workers", "tool_timeout_ms")) {
      db.exec("ALTER TABLE workers ADD COLUMN tool_timeout_ms INTEGER;");
    }
  }
  // `claimed` task state was removed: anything left there is runnable work.
  try {
    db.exec("UPDATE tasks SET state = 'queued' WHERE state = 'claimed';");
  } catch { /* tasks table may not exist yet on first init */ }
  // Plan linkage: relay stores which agent-status plan item a task belongs to, so
  // the dashboard joins on data instead of parsing the title. The index is created
  // here (not in SCHEMA) because SCHEMA runs before this on DBs that predate the
  // column, where "CREATE INDEX ... (plan_id)" would fail.
  if (columnExists(db, "tasks", "id")) {
    if (!columnExists(db, "tasks", "plan_id")) {
      db.exec("ALTER TABLE tasks ADD COLUMN plan_id TEXT;");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id);");
  }
  // Per-spawn attach token (generation fencing for managed attaches).
  if (columnExists(db, "worker_runtimes", "id") && !columnExists(db, "worker_runtimes", "attach_token")) {
    db.exec("ALTER TABLE worker_runtimes ADD COLUMN attach_token TEXT;");
  }
  // Ownership: rows predating manual attach were all relay-spawned tabs.
  if (columnExists(db, "worker_runtimes", "id") && !columnExists(db, "worker_runtimes", "relay_owned")) {
    db.exec("ALTER TABLE worker_runtimes ADD COLUMN relay_owned INTEGER NOT NULL DEFAULT 1;");
  }
  if (columnExists(db, "worker_runtimes", "id") && !columnExists(db, "worker_runtimes", "workspace_id")) {
    db.exec("ALTER TABLE worker_runtimes ADD COLUMN workspace_id TEXT;");
  }
  // Bootstrap delivery bookkeeping: when the fresh generation last got its
  // bootstrap prompt (so a failed wake can be retried after a cooldown without
  // discarding the generation).
  if (columnExists(db, "worker_runtimes", "id") && !columnExists(db, "worker_runtimes", "bootstrap_sent_at")) {
    db.exec("ALTER TABLE worker_runtimes ADD COLUMN bootstrap_sent_at INTEGER;");
  }
  // NOTE: (worker_id, generation) is kept unique by application logic (the
  // monotonic `nextGeneration` helper), not by a DB constraint. Legacy rows may
  // legitimately share a generation (e.g. an active row plus a protected stale
  // duplicate from a botched spawn), so a UNIQUE index would reject valid
  // history. The fencing invariant only requires that a LIVE generation is
  // never re-created; that is enforced at the attach path.
}

export function openDb(path?: string): Database {
  const p = path ?? defaultDbPath();
  mkdirSync(dirname(p), { recursive: true });
  const db = new Database(p, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Initialize a fresh control plane directory (idempotent). */
export function initControlPlane(cwd = process.cwd()): string {
  const dir = join(cwd, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  const dbPath = process.env.RELAY_DB ? resolve(process.env.RELAY_DB) : join(dir, "state.db");
  const dbExists = existsSync(dbPath);
  const db = openDb(dbPath);
  db.close();
  return `${dbExists ? "exists" : "created"}:${dbPath}`;
}

export function now(): number {
  return Date.now();
}
