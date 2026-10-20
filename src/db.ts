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
    // Which agent harness the worker is (see src/harness.ts): polled harnesses
    // (codex, claude) have no plugin event stream, so liveness is polled from
    // Herdr agent status. Existing rows are opencode.
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
    // Context-window telemetry + cooperative-handoff rotation bookkeeping
    // (`session.context` from the plugin; see Worker.context_used_tokens).
    if (!columnExists(db, "workers", "context_used_tokens")) {
      db.exec("ALTER TABLE workers ADD COLUMN context_used_tokens INTEGER;");
    }
    if (!columnExists(db, "workers", "context_updated_at")) {
      db.exec("ALTER TABLE workers ADD COLUMN context_updated_at INTEGER;");
    }
    if (!columnExists(db, "workers", "context_rotate_requested_at")) {
      db.exec("ALTER TABLE workers ADD COLUMN context_rotate_requested_at INTEGER;");
    }
    if (!columnExists(db, "workers", "context_rotated_at")) {
      db.exec("ALTER TABLE workers ADD COLUMN context_rotated_at INTEGER;");
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
    // Code-change workflow columns (ISH-758). Additive + nullable/0-default so a
    // pre-existing DB keeps every legacy task on the legacy machine.
    const taskCols: [string, string][] = [
      ["provider", "TEXT"],
      ["issue_id", "TEXT"],
      ["slice", "TEXT"],
      ["code_change", "INTEGER NOT NULL DEFAULT 0"],
      ["phase", "TEXT"],
      ["attempt", "INTEGER NOT NULL DEFAULT 0"],
      ["claim_role", "TEXT"],
      ["pr_url", "TEXT"],
      ["branch", "TEXT"],
      ["head_sha", "TEXT"],
      // ISH-759 provider binding + mechanical-verify spec + merge confirmation.
      ["pr_repo", "TEXT"],
      ["pr_base", "TEXT"],
      ["pr_base_sha", "TEXT"],
      ["pr_diff", "TEXT"],
      ["checks_json", "TEXT"],
      ["worktree", "TEXT"],
      ["provider_polled_at", "INTEGER"],
      ["pr_updated_at", "TEXT"],
      ["merged_at", "INTEGER"],
      ["result_ref", "TEXT"],
      ["review_profile", "TEXT"],
      ["accepted_at", "INTEGER"],
    ];
    for (const [col, type] of taskCols) {
      if (!columnExists(db, "tasks", col)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${type};`);
    }
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_work_identity
         ON tasks(provider, issue_id, slice)
         WHERE provider IS NOT NULL AND issue_id IS NOT NULL AND slice IS NOT NULL;`
    );
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
  // Cost/token + compaction observability on sessions (T551 #8). The cursor
  // columns default to 0/NULL, so an existing session simply baselines on its
  // first `session.usage` reading.
  if (columnExists(db, "sessions", "session_id")) {
    if (!columnExists(db, "sessions", "usage_cost")) {
      db.exec("ALTER TABLE sessions ADD COLUMN usage_cost REAL NOT NULL DEFAULT 0;");
    }
    if (!columnExists(db, "sessions", "usage_input")) {
      db.exec("ALTER TABLE sessions ADD COLUMN usage_input INTEGER NOT NULL DEFAULT 0;");
    }
    if (!columnExists(db, "sessions", "usage_output")) {
      db.exec("ALTER TABLE sessions ADD COLUMN usage_output INTEGER NOT NULL DEFAULT 0;");
    }
    if (!columnExists(db, "sessions", "usage_reasoning")) {
      db.exec("ALTER TABLE sessions ADD COLUMN usage_reasoning INTEGER NOT NULL DEFAULT 0;");
    }
    if (!columnExists(db, "sessions", "usage_cache_read")) {
      db.exec("ALTER TABLE sessions ADD COLUMN usage_cache_read INTEGER NOT NULL DEFAULT 0;");
    }
    if (!columnExists(db, "sessions", "usage_cache_write")) {
      db.exec("ALTER TABLE sessions ADD COLUMN usage_cache_write INTEGER NOT NULL DEFAULT 0;");
    }
    if (!columnExists(db, "sessions", "usage_updated_at")) {
      db.exec("ALTER TABLE sessions ADD COLUMN usage_updated_at INTEGER;");
    }
    if (!columnExists(db, "sessions", "compactions")) {
      db.exec("ALTER TABLE sessions ADD COLUMN compactions INTEGER NOT NULL DEFAULT 0;");
    }
    if (!columnExists(db, "sessions", "compaction_open")) {
      db.exec("ALTER TABLE sessions ADD COLUMN compaction_open INTEGER NOT NULL DEFAULT 0;");
    }
    if (!columnExists(db, "sessions", "last_compacted_at")) {
      db.exec("ALTER TABLE sessions ADD COLUMN last_compacted_at INTEGER;");
    }
  }
  // ISH-803 Runs: base_head_sha (the pre-run HEAD fence) was added after the
  // runs table first shipped, so a DB created by that build needs the column.
  if (columnExists(db, "runs", "id") && !columnExists(db, "runs", "base_head_sha")) {
    db.exec("ALTER TABLE runs ADD COLUMN base_head_sha TEXT;");
  }
  // ISH-810 Runs: the per-Run path of the ORIGINAL dsh `--json` JSONL evidence.
  if (columnExists(db, "runs", "id") && !columnExists(db, "runs", "dsh_events_path")) {
    db.exec("ALTER TABLE runs ADD COLUMN dsh_events_path TEXT;");
  }
  // ISH-762 Runs: the spawn-time process identity token (`ps -o lstart=`), so an
  // adopted Run's orphan can be proven to still be the SAME dsh before any signal.
  if (columnExists(db, "runs", "id") && !columnExists(db, "runs", "spawn_lstart")) {
    db.exec("ALTER TABLE runs ADD COLUMN spawn_lstart TEXT;");
  }
  // ISH-828 Runs: the Coding Sandbox a Run executed in (NULL for a worktree Run).
  if (columnExists(db, "runs", "id") && !columnExists(db, "runs", "sandbox_name")) {
    db.exec("ALTER TABLE runs ADD COLUMN sandbox_name TEXT;");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_runs_sandbox ON runs(sandbox_name);");
  // NOTE: (worker_id, generation) is kept unique by application logic (the
  // monotonic `nextGeneration` helper), not by a DB constraint. Legacy rows may
  // legitimately share a generation (e.g. an active row plus a protected stale
  // duplicate from a botched spawn), so a UNIQUE index would reject valid
  // history. The fencing invariant only requires that a LIVE generation is
  // never re-created; that is enforced at the attach path.
}

/**
 * Bounded wait for a competing SQLite writer before the lock is surfaced as
 * SQLITE_BUSY. Connections that must react to contention immediately (the
 * supervisor lock) deliberately use 0 instead.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/** Apply the bounded writer-contention wait to one connection. */
export function setBusyTimeout(db: Database, timeoutMs = SQLITE_BUSY_TIMEOUT_MS): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new Error(`invalid SQLite busy_timeout: ${timeoutMs}`);
  }
  db.exec(`PRAGMA busy_timeout = ${timeoutMs};`);
}

/**
 * True only for transient writer-lock contention: SQLITE_BUSY (including
 * SQLITE_BUSY_SNAPSHOT) or SQLite's "database is locked" message. Other write
 * failures are genuine and must fail closed rather than be retried.
 */
export function isSqliteBusy(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && (code === "SQLITE_BUSY" || code.startsWith("SQLITE_BUSY_"))) {
    return true;
  }
  const message = e instanceof Error ? e.message : String(e);
  return /database is locked/i.test(message);
}

export function openDb(path?: string): Database {
  const p = path ?? defaultDbPath();
  mkdirSync(dirname(p), { recursive: true });
  const db = new Database(p, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  setBusyTimeout(db);
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
