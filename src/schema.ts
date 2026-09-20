// Shared types + SQLite DDL. SQLite is the single source of truth for task state.
// Extra columns beyond the spec minimum are marked [ext].

export const TASK_STATES = [
  "queued",
  "running",
  "review",
  "done",
  "blocked_internal",
  "blocked_human",
  "failed",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const WORKER_STATES = [
  "starting",
  "idle",
  "working",
  "waiting_input",
  "stalled",
  "dead",
] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

export const MESSAGE_STATES = ["queued", "delivered", "acked", "failed"] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];

// Runtime generation lifecycle. A runtime is one Herdr tab + OpenCode session
// generation. Sessions/runtimes are DISPOSABLE; tasks are durable.
export const RUNTIME_STATES = ["starting", "active", "stale", "dead", "cleaned"] as const;
export type RuntimeState = (typeof RUNTIME_STATES)[number];

export interface Task {
  id: string;
  title: string;
  description: string;
  acceptance: string;
  state: TaskState;
  priority: number;
  role: string | null;
  assignee: string | null;
  lease_token: number;
  lease_until: number | null;
  parent_task_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface Worker {
  id: string;
  role: string;
  runtime_id: string | null;
  cwd: string | null; // [ext] spawn metadata for start()
  command: string | null; // [ext] spawn metadata for start()
  opencode_session_id: string | null;
  state: WorkerState;
  current_task_id: string | null;
  generation: number;
  last_seen_at: number;
  last_progress_at: number;
  nudged_at: number | null; // [ext] single-nudge bookkeeping for stalled detection
  created_at: number;
  updated_at: number;
}

/**
 * One spawned runtime generation (Herdr tab + OpenCode session). History /
 * cleanup authority: workers.runtime_id / generation / opencode_session_id
 * keep pointing at the ACTIVE generation only, while this table lets us find
 * and safely clean up old generations later.
 */
export interface WorkerRuntime {
  id: number;
  worker_id: string;
  generation: number;
  runtime_id: string | null; // Herdr agent name (or pane id when the agent is unnamed)
  tab_id: string | null;
  pane_id: string | null;
  workspace_id: string | null;
  session_id: string | null; // OpenCode session bound on managed attach
  attach_token: string | null; // per-spawn secret that legitimises a managed attach
  /**
   * Ownership. 1 = Relay created this Herdr tab (relay_owned=true), so it may
   * later be reaped. 0 = an existing Herdr runtime adopted via manual attach
   * (relay_owned=false): Relay NEVER closes such a tab, ever.
   */
  relay_owned: number;
  state: RuntimeState;
  created_at: number;
  /** When the bootstrap prompt was last delivered for this generation (retry bookkeeping). */
  bootstrap_sent_at: number | null;
  stale_at: number | null;
  cleanup_after: number | null;
  cleaned_at: number | null;
}

export interface Message {
  id: number;
  sender: string;
  recipient: string;
  task_id: string | null;
  kind: string;
  payload: string;
  state: MessageState;
  created_at: number;
  delivered_at: number | null;
  acked_at: number | null;
}

export interface DbEvent {
  id: number;
  timestamp: number;
  source: string;
  worker_id: string | null;
  task_id: string | null;
  type: string;
  payload_json: string;
}

export const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  acceptance TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'queued',
  priority INTEGER NOT NULL DEFAULT 0,
  role TEXT,
  assignee TEXT,
  lease_token INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  parent_task_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'worker',
  runtime_id TEXT,
  opencode_session_id TEXT,
  state TEXT NOT NULL DEFAULT 'starting',
  current_task_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  last_progress_at INTEGER NOT NULL DEFAULT 0,
  nudged_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workers_session ON workers(opencode_session_id);
CREATE INDEX IF NOT EXISTS idx_workers_state ON workers(state);

-- OpenCode sessions: managed/unmanaged gating + zombie protection.
-- A plain opencode launch is UNMANAGED (managed=0): the plugin may load
-- but the daemon ignores its events. agent_attach flips to MANAGED.
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  managed INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  role TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  directory TEXT,
  worktree TEXT,
  attached_at INTEGER,
  detached_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_worker ON sessions(worker_id);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL DEFAULT '',
  recipient TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL DEFAULT 'note',
  payload TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'queued',
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  acked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_recipient_state ON messages(recipient, state);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  worker_id TEXT,
  task_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_id ON events(id);
CREATE INDEX IF NOT EXISTS idx_events_worker_time ON events(worker_id, timestamp);

CREATE TABLE IF NOT EXISTS task_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  worker_id TEXT,
  kind TEXT NOT NULL DEFAULT 'note',
  body TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_notes_task ON task_notes(task_id);

-- Runtime generation history. Sessions/runtimes are disposable; tasks durable.
-- Old generations are marked stale/dead here, then cleaned up ONLY after a
-- grace period and ONLY when they are no longer the worker's current runtime.
CREATE TABLE IF NOT EXISTS worker_runtimes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  runtime_id TEXT,
  tab_id TEXT,
  pane_id TEXT,
  workspace_id TEXT,
  session_id TEXT,
  attach_token TEXT,
  relay_owned INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'starting',
  created_at INTEGER NOT NULL,
  bootstrap_sent_at INTEGER,
  stale_at INTEGER,
  cleanup_after INTEGER,
  cleaned_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_worker_runtimes_worker ON worker_runtimes(worker_id, generation);
CREATE INDEX IF NOT EXISTS idx_worker_runtimes_cleanup ON worker_runtimes(state, cleanup_after);
`;
