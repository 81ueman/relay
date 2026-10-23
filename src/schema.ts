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
  "cancelled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * ISH-808: the states from which a task's lifecycle is OVER.
 *
 * `done` (accepted) and `failed` are the existing terminals; `cancelled` is the
 * explicit CLOSE for work that is superseded / duplicate / obsolete /
 * policy-changed. `blocked_*` is a PARK, not a terminal — it can be unblocked
 * back into the queue. Every "is this finished?" test should read this list so a
 * new terminal cannot be forgotten in one place and honored in another.
 */
export const TERMINAL_TASK_STATES = ["done", "failed", "cancelled"] as const;
export type TerminalTaskState = (typeof TERMINAL_TASK_STATES)[number];
export function isTerminalTaskState(state: string): boolean {
  return (TERMINAL_TASK_STATES as readonly string[]).includes(state);
}

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

/**
 * Code-change workflow phases (ISH-758). `phase` is the STAGE of a code-change
 * task; the existing `state` column stays the single lifecycle source of truth
 * (queued/running/review/done/blocked/failed). There is deliberately no second
 * "workflow state": blocked and terminal live in `state`, so the two concepts do
 * not duplicate each other.
 *
 *   implement -> verify -> review -> integration -> merge_ready -> (accepted)
 *
 * A task with `code_change = 0` has `phase = NULL` and behaves exactly like the
 * legacy task machine (submit -> review -> approve). The phase graph only
 * applies to code-change tasks.
 */
export const CODE_PHASES = ["implement", "verify", "review", "integration", "merge_ready"] as const;
export type CodePhase = (typeof CODE_PHASES)[number];

/** The functional authority a phase requires (see `src/workflow.ts`). */
export const INTEGRATOR_ROLE = "integrator";
export const REVIEWER_ROLE = "reviewer";

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
  plan_id: string | null; // [ext] link to an agent-status plan.json item (nullable)
  // --- code-change workflow (ISH-758) -------------------------------------
  /** "github" | "linear" | ... — the intake provider. NULL on legacy tasks. */
  provider: string | null;
  /** Provider-side issue id (e.g. ISH-758, owner/repo#12). NULL on legacy tasks. */
  issue_id: string | null;
  /** Slice of the issue this task implements; "" is the single/default slice. */
  slice: string | null;
  /** 1 = enforce the mandatory code-change gate (phase graph). 0 = legacy task. */
  code_change: number;
  /** Current workflow phase for a code-change task; NULL for legacy tasks. */
  phase: CodePhase | null;
  /** Monotonic rework counter within `phase` (bumped on verification/review fail). */
  attempt: number;
  /**
   * Phase-derived claim role. `COALESCE(claim_role, role)` is the effective role
   * gate, so a phase can demand `reviewer`/`integrator` without clobbering the
   * task's declared `role`.
   */
  claim_role: string | null;
  /** Linked PR / branch / head. A review PASS is invalid once `head_sha` moves. */
  pr_url: string | null;
  branch: string | null;
  head_sha: string | null;
  /**
   * ISH-759 provider binding: the PR's repo (`owner/name`), base ref + resolved
   * base SHA, and the diff ref (`base...head`). Recorded so a review/verify
   * result is bound to the exact revision it judged, not a re-resolved one.
   */
  pr_repo: string | null;
  pr_base: string | null;
  pr_base_sha: string | null;
  pr_diff: string | null;
  /**
   * ISH-759: the standard commands Relay runs MECHANICALLY in the verify phase,
   * as a JSON `CheckSpec[]`. NULL/`[]` means verify falls back to the manual
   * worker path (legacy ISH-758 behaviour).
   */
  checks_json: string | null;
  /**
   * ISH-759: the per-task worktree Relay runs mechanical verify in. Mechanical
   * verify only PASSes when `git rev-parse HEAD` in this cwd equals `head_sha`,
   * so commands run against the recorded revision, not the daemon's checkout.
   */
  worktree: string | null;
  /** ISH-759: last time this task's provider state was polled (throttle). */
  provider_polled_at: number | null;
  /** ISH-759: the PR `updatedAt` last seen (fetch comments only when it moves). */
  pr_updated_at: string | null;
  /** ISH-759: when the bound PR was confirmed merged (the true "done"). */
  merged_at: number | null;
  /**
   * ISH-1138: when the bound PR was observed CLOSED (not merged). A `done` Task
   * accepted before its PR merged stays in the provider poll until `merged_at`
   * is set or this is set; either way it leaves the poll set for good.
   */
  pr_closed_at: number | null;
  /** Evidence ref for the CURRENT attempt (a structured-result id or note id). */
  result_ref: string | null;
  /** Review profile used for duplicate-dispatch protection (e.g. "default"). */
  review_profile: string | null;
  /** When the mandatory gate was satisfied (TaskAccepted). */
  accepted_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * One structured result (ISH-758). These are the IN-PROCESS source of truth for
 * phase transitions — `relay send` prose is never parsed for a verdict. Stored
 * append-only; the (task, phase, attempt, kind) uniqueness is what refuses a
 * duplicate submission / duplicate review for the same work.
 */
export const RESULT_KINDS = [
  /** an implement/integration attempt was handed in (ISH-759 "ImplementationSubmitted"). */
  "TaskSubmitted",
  "VerificationResult",
  "ReviewResult",
  "ChildBlocked",
  "ChildrenReady",
  "TaskAccepted",
  /**
   * ISH-759: the bound PR was confirmed MERGED on GitHub at the recorded head.
   * This is the only signal that makes a code-change task "truly done" for the
   * provider; a review PASS or an internal TaskAccepted is not a merge.
   */
  "TaskMerged",
] as const;
export type ResultKind = (typeof RESULT_KINDS)[number];

/**
 * ISH-759 mechanical verification outcome. `pass`/`fail` are process exit
 * results; `not_run` is a REQUIRED check that could not be executed and
 * `inconclusive` a check whose result could not be trusted. The latter two BLOCK
 * (never PASS) so a NOT_RUN required test can never satisfy the gate.
 */
export const VERIFY_OUTCOMES = ["pass", "fail", "not_run", "inconclusive"] as const;
export type VerifyOutcome = (typeof VERIFY_OUTCOMES)[number];

export interface TaskResult {
  id: number;
  task_id: string;
  phase: string;
  attempt: number;
  kind: ResultKind;
  worker_id: string | null;
  passed: number | null;
  head_sha: string | null;
  profile: string | null;
  evidence_ref: string | null;
  reason: string | null;
  payload_json: string;
  created_at: number;
}

/**
 * A declared prerequisite edge: `task_id` must not run until `depends_on` is
 * `done`. A task may have several (a review gate waiting on its sibling inputs).
 */
export interface TaskDep {
  task_id: string;
  depends_on: string;
  created_at: number;
}

export interface Worker {
  id: string;
  role: string;
  /**
   * Which agent harness this worker is, from the registry in `src/harness.ts`
   * ("opencode" | "codex" | "claude"). Event-driven harnesses stream
   * session.idle/tool/permission; polled harnesses (codex, claude) have no event
   * stream and their liveness/idle/blocked are POLLED from Herdr agent status.
   * Set at attach time from the resolved Herdr agent kind; defaults to
   * "opencode" so every pre-existing worker row is unchanged.
   *
   * ISH-904: the Factory's reviewer/integrator are NOT harnesses and never own
   * a pane; they store HEADLESS_AGENT_KIND instead (see `src/workers.ts`).
   */
  agent_kind: string;
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
  /**
   * [ext] Bounded "quiet lease": explicit permission for a worker that OWNS a
   * running task to be runtime-idle (session.idle) until `quiet_until` without
   * being treated as an anomaly. It is temporary metadata, NOT a state: the
   * worker stays `working` and the task stays `running`. `quiet_task_id` scopes
   * it to that task so it can never leak onto another task.
   */
  quiet_until: number | null;
  quiet_reason: string | null;
  quiet_task_id: string | null;
  /**
   * [ext] In-flight tool marker. The OpenCode plugin pushes `tool.started` when
   * a tool call begins and the marker is cleared on `tool.execute.after`. This is
   * the EARLY-DETECTION signal a running command cannot otherwise give relay:
   * `tool.execute.after` only fires when the tool FINISHES, and Herdr reports
   * `working` for the whole time, so a hung command used to be invisible until
   * the stall clock fired. `tool_started_at`/`tool_name`/`tool_command` are
   * transport telemetry for surfacing (status/dashboard/events), never a state
   * transition by themselves. `tool_timeout_ms` is the command's own timeout
   * (OpenCode `shell` default is 120000), used to decide when the marker is
   * stale because the finish event was lost.
   */
  tool_name: string | null;
  tool_command: string | null;
  tool_started_at: number | null;
  tool_timeout_ms: number | null;
  /**
   * [ext] Context-window telemetry. The OpenCode plugin forwards
   * `session.context` carrying the latest assistant message's
   * `input + cache.read` (the current prompt/context OCCUPANCY). A Session's
   * session-lifetime `tokens` are forwarded separately as `cumulative_tokens`
   * and are NEVER stored here: conflating the cumulative with occupancy latched
   * this metric on a single reading (T551). The daemon stores the occupancy and
   * the reconciler applies a COOPERATIVE HANDOFF policy at
   * `RELAY_CONTEXT_ROTATE_PCT` of the model limit: ask the worker to checkpoint,
   * then rotate it to a fresh generation. Like the tool marker this is telemetry
   * — it never changes the worker's state, task ownership or lease.
   *
   * `context_rotate_requested_at` is the last time we told the worker to
   * checkpoint (one directive per high-context episode); `context_rotated_at` is
   * the last cooperative rotation (cooldown + "fresh metric" fencing).
   */
  context_used_tokens: number | null;
  context_updated_at: number | null;
  context_rotate_requested_at: number | null;
  context_rotated_at: number | null;
  /**
   * [ext] Retirement tombstone. A retired worker is history only: it is excluded
   * from the operational/supervised sets, from role discovery and from all
   * listings, but its row (and events) survive so earlier references stay
   * resolvable. Used to clean up duplicate registrations (e.g. a worker
   * registered twice under an old and a new id for the same session).
   */
  retired_at: number | null;
  retired_reason: string | null;
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

/**
 * A standing reminder: a recurring relay-generated durable message to one
 * worker, owned by the always-on daemon (not launchd/cron). On each reconcile
 * the daemon enqueues `message` to `worker_id` when `every_ms` has elapsed since
 * `last_sent_at` AND the recipient has no unread mail — so reminders never
 * stack. `relay remind rm` DISABLES (enabled=0) instead of deleting, keeping the
 * row as history.
 */
export interface Reminder {
  id: number;
  worker_id: string;
  message: string;
  kind: string;
  every_ms: number;
  last_sent_at: number | null;
  created_at: number;
  enabled: number;
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

/**
 * ISH-803: the lifecycle of one headless dsh Run (1 Run = 1 process = 1 coding
 * attempt). This is deliberately NOT a second workflow state machine: the Task's
 * `phase`/`attempt` remains the workflow truth, and a Run records the PROCESS
 * attempt and its artifacts. `submitted` means a structured submission was
 * accepted for this Run (which is what advanced the Task) — a clean `exit 0`
 * alone stops at `exited`.
 */
export const RUN_STATES = [
  "starting",
  "running",
  "exited",
  "failed",
  "cancelled",
  "timeout",
  "submitted",
] as const;
export type RunState = (typeof RUN_STATES)[number];

/**
 * One headless dsh Run. Bound at start to (task, phase, attempt, branch, HEAD)
 * and to the files under `output_dir` (stdout/stderr/events/spec) plus the OS
 * process (pid). No Herdr pane, TUI, `dsh web` server or wake subscription is
 * involved; the Run is disposable and the Task is durable.
 */
export interface Run {
  id: string;
  task_id: string;
  phase: string;
  attempt: number;
  generation: number;
  cwd: string;
  /**
   * The branch/HEAD the Run is bound to. `head_sha` is the PRODUCED head
   * (`git rev-parse HEAD` in the cwd at Run end — dsh is asked to commit), not
   * the pre-run revision; `base_head_sha` is the START head, kept as the
   * base/staleness fence. Both are NULL in a non-git cwd.
   */
  branch: string | null;
  head_sha: string | null;
  base_head_sha: string | null;
  prompt: string;
  spec_path: string | null;
  output_dir: string;
  state: RunState;
  pid: number | null;
  exit_code: number | null;
  signal: string | null;
  session_id: string | null;
  stdout_path: string | null;
  stderr_path: string | null;
  events_path: string | null;
  /** ISH-810: the ORIGINAL dsh `--json` JSONL, per-Run evidence (distinct from
   * Relay's own `events.jsonl`). */
  dsh_events_path: string | null;
  /**
   * Retained for compatibility with existing control-plane DBs. The Coding
   * Sandbox execution path was removed (ISH-1098); every new Run leaves this
   * NULL and the value is never read.
   */
  sandbox_name: string | null;
  /**
   * ISH-762: the OS process START TIME of `pid` (`ps -o lstart=`), captured at
   * spawn. Used on adoption to prove a PID still belongs to THIS Run's dsh before
   * any orphan signal is sent — a reused PID must never be killed.
   */
  spawn_lstart: string | null;
  /**
   * ISH-1008: the process that inserted/launched this Run and may still write its
   * terminal row. The periodic liveness sweep refuses to orphan a Run while that
   * launcher is alive (and, for a launch in this process, still finishing), so a
   * slow `git rev-parse` tail is never mistaken for a
   * dead launcher. Both are cleared once the launcher's coroutine is done; NULL
   * means no launcher lease is held (a legacy row from before ISH-1008, or a
   * launch that has already finished).
   */
  launcher_pid: number | null;
  launcher_lstart: string | null;
  error: string | null;
  fast_exit: number;
  started_at: number;
  ended_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * [ext] One attributed token/cost DELTA. The plugin forwards a session's
 * session-lifetime CUMULATIVE usage (`session.usage`); the daemon turns each
 * new reading into the difference from the previous one and records it here,
 * tagged with the worker and the task that worker held at that moment. This is
 * what makes "how much did THIS task cost?" answerable — the raw cumulative
 * alone cannot be attributed across a long-lived session.
 */
export interface UsageSample {
  id: number;
  at: number;
  session_id: string;
  worker_id: string | null;
  task_id: string | null;
  generation: number;
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
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
  plan_id TEXT,
  -- code-change workflow (ISH-758); NULL/0 on legacy tasks.
  provider TEXT,
  issue_id TEXT,
  slice TEXT,
  code_change INTEGER NOT NULL DEFAULT 0,
  phase TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  claim_role TEXT,
  pr_url TEXT,
  branch TEXT,
  head_sha TEXT,
  -- ISH-759 provider binding + mechanical-verify spec.
  pr_repo TEXT,
  pr_base TEXT,
  pr_base_sha TEXT,
  pr_diff TEXT,
  checks_json TEXT,
  worktree TEXT,
  provider_polled_at INTEGER,
  pr_updated_at TEXT,
  merged_at INTEGER,
  pr_closed_at INTEGER,
  result_ref TEXT,
  review_profile TEXT,
  accepted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
-- Idempotent intake identity: at most one task per (provider, issue, slice).
-- Partial so legacy tasks (provider NULL) are never constrained, and so the
-- empty/default slice ("") is itself a real key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_work_identity
  ON tasks(provider, issue_id, slice)
  WHERE provider IS NOT NULL AND issue_id IS NOT NULL AND slice IS NOT NULL;

-- Structured workflow results (ISH-758). Append-only; the unique key refuses a
-- duplicate submission / review / verification for the same (task, phase, attempt).
CREATE TABLE IF NOT EXISTS task_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT '',
  attempt INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  worker_id TEXT,
  passed INTEGER,
  head_sha TEXT,
  profile TEXT,
  evidence_ref TEXT,
  reason TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_results_identity
  ON task_results(task_id, phase, attempt, kind);
CREATE INDEX IF NOT EXISTS idx_task_results_task ON task_results(task_id);
-- Duplicate-dispatch protection for a review of the same PR+HEAD+profile.
CREATE INDEX IF NOT EXISTS idx_task_results_review_head
  ON task_results(task_id, head_sha, profile, kind);

-- Small key/value control plane (ISH-758): a state transition bumps
-- reconcile_request so the daemon wakes IMMEDIATELY instead of waiting for its
-- periodic tick. One row, not a queue.
CREATE TABLE IF NOT EXISTS control (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'worker',
  agent_kind TEXT NOT NULL DEFAULT 'opencode',
  runtime_id TEXT,
  opencode_session_id TEXT,
  state TEXT NOT NULL DEFAULT 'starting',
  current_task_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  last_progress_at INTEGER NOT NULL DEFAULT 0,
  nudged_at INTEGER,
  retired_at INTEGER,
  retired_reason TEXT,
  quiet_until INTEGER,
  quiet_reason TEXT,
  quiet_task_id TEXT,
  tool_name TEXT,
  tool_command TEXT,
  tool_started_at INTEGER,
  tool_timeout_ms INTEGER,
  context_used_tokens INTEGER,
  context_updated_at INTEGER,
  context_rotate_requested_at INTEGER,
  context_rotated_at INTEGER,
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
  updated_at INTEGER NOT NULL,
  -- [ext] Cost/token observability (T551 #8). These hold the last CUMULATIVE
  -- usage the plugin reported for this session; the daemon diffs each new
  -- reading against them and records the delta in usage_samples. They are a
  -- cursor, not a total — do not sum them across sessions.
  usage_cost REAL NOT NULL DEFAULT 0,
  usage_input INTEGER NOT NULL DEFAULT 0,
  usage_output INTEGER NOT NULL DEFAULT 0,
  usage_reasoning INTEGER NOT NULL DEFAULT 0,
  usage_cache_read INTEGER NOT NULL DEFAULT 0,
  usage_cache_write INTEGER NOT NULL DEFAULT 0,
  usage_updated_at INTEGER,
  -- [ext] Compaction observability: session_v2.time_compacting is always NULL,
  -- so the count is reconstructed from plugin compaction events. compaction_open
  -- tracks an in-flight compaction so a started+ended pair counts exactly once.
  compactions INTEGER NOT NULL DEFAULT 0,
  compaction_open INTEGER NOT NULL DEFAULT 0,
  last_compacted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_worker ON sessions(worker_id);

-- [ext] Attributed token/cost deltas (see UsageSample). Append-only: the
-- per-worker/per-task/per-session views are all GROUP BY queries over this.
CREATE TABLE IF NOT EXISTS usage_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  worker_id TEXT,
  task_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  tokens_input INTEGER NOT NULL DEFAULT 0,
  tokens_output INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_samples_task ON usage_samples(task_id);
CREATE INDEX IF NOT EXISTS idx_usage_samples_worker ON usage_samples(worker_id, at);
CREATE INDEX IF NOT EXISTS idx_usage_samples_session ON usage_samples(session_id, at);

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
-- The reconcile pass looks events up by type and by (task, type) every tick;
-- without these each lookup is a full scan of the whole history.
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, id);
CREATE INDEX IF NOT EXISTS idx_events_task_type ON events(task_id, type);

CREATE TABLE IF NOT EXISTS task_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  worker_id TEXT,
  kind TEXT NOT NULL DEFAULT 'note',
  body TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_notes_task ON task_notes(task_id);

-- Declared run-gating prerequisites between tasks (task_id not RUNNABLE until
-- every row's depends_on is 'done'). A join table (not a single column) because
-- a real review gate has several sibling inputs: the live CP-W3 gate T153 waited
-- on T150/T151/T152/T154. Rows are history: deleting a prerequisite is refused
-- while a non-terminal dependent exists (see gc.ts).
CREATE TABLE IF NOT EXISTS task_deps (
  task_id TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, depends_on)
);
CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_deps(task_id);
CREATE INDEX IF NOT EXISTS idx_task_deps_dep ON task_deps(depends_on);

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

-- Standing reminders: the daemon-owned recurring nudge (see Reminder). The
-- daemon enqueues the reminder message to its worker when every_ms has elapsed
-- since last_sent_at and the recipient has no unread mail. enabled=0 is the
-- tombstone the relay remind rm command writes (disable, never delete).
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'note',
  every_ms INTEGER NOT NULL,
  last_sent_at INTEGER,
  created_at INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(enabled, last_sent_at);

-- ISH-803: one-shot headless dsh Run. A Run is a disposable execution attempt
-- (1 Run = 1 process = 1 coding attempt), bound at start to
-- Task/phase/attempt/branch/HEAD. stdout/stderr/events are files under
-- <control-plane>/runs/<run_id>/ (NOT shared /tmp). The Task's phase/attempt
-- stays the workflow truth; this table records the process attempt and its
-- artifacts. A clean exit 0 sets state='exited' and advances NOTHING — only
-- a structured submission bound to this Run (relay run submit) does.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  cwd TEXT NOT NULL,
  branch TEXT,
  head_sha TEXT,
  base_head_sha TEXT,
  prompt TEXT NOT NULL DEFAULT '',
  spec_path TEXT,
  output_dir TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'starting',
  pid INTEGER,
  exit_code INTEGER,
  signal TEXT,
  session_id TEXT,
  stdout_path TEXT,
  stderr_path TEXT,
  events_path TEXT,
  dsh_events_path TEXT,
  -- Legacy (ISH-1098): kept so pre-existing DBs open unchanged. New Runs always
  -- leave it NULL; the Coding Sandbox execution path is removed.
  sandbox_name TEXT,
  spawn_lstart TEXT,
  -- ISH-1008: the launcher process + its spawn identity. A NULL pair means the
  -- launch coroutine is no longer holding a terminal-write lease (or a legacy row).
  launcher_pid INTEGER,
  launcher_lstart TEXT,
  error TEXT,
  fast_exit INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id, phase, attempt);
CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);
-- ISH-1128: heads the read-only provider poll bound onto the Task while a Run
-- was LIVE and the Run's own worktree provably held that commit (HEAD or HEAD
-- reflog). An amended/rebased own head is NOT an ancestor of the produced head,
-- so the submit fence needs this durable observation to tell the Run's OWN
-- earlier push from a foreign writer's head. Additive table: new DBs and
-- existing DBs both get it from SCHEMA (no column migration needed).
CREATE TABLE IF NOT EXISTS run_observed_heads (
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  branch TEXT,
  head_sha TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, head_sha)
);
CREATE INDEX IF NOT EXISTS idx_run_observed_heads_head ON run_observed_heads(head_sha);
-- NOTE: idx_runs_sandbox (runs.sandbox_name) is created by migrate(), NOT here.
-- SCHEMA runs before migrate() (see openDb), and a pre-ISH-1098 runs table has
-- no sandbox_name column yet, so an index on it here would break opening every
-- existing control-plane DB.

-- Legacy (ISH-1098): the unused Coding Sandbox mapping. The table is retained
-- so an existing control-plane DB keeps opening unchanged; Relay never reads or
-- writes it.
CREATE TABLE IF NOT EXISTS sandboxes (
  task_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  agent TEXT NOT NULL DEFAULT 'shell',
  source TEXT NOT NULL,
  workspace TEXT,
  branch TEXT,
  head_sha TEXT,
  state TEXT NOT NULL DEFAULT 'creating',
  evidence_dir TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  removed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sandboxes_state ON sandboxes(state);
CREATE INDEX IF NOT EXISTS idx_sandboxes_name ON sandboxes(name);
`;
