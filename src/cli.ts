#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defaultDbPath, defaultSockPath, initControlPlane, now, openDb, outsideRepoDefault, projectRoot, STATE_DIR } from "./db";
import {
  applyDbMove, configPath, describeDb, findLegacyDb, planDbMove, readConfig, resolveDb,
} from "./db-location";
import { formatEvent, listEvents, logEvent } from "./events";
import { currentDiskStatus, formatBytes, latestLaunchRefusal } from "./disk-guard";
import { AGENT_KINDS_HELP, inferKind, isKnownKind } from "./harness";
import { ackMessage, claimInbox, deliverMessage, getMessage, inboxFor, RELAY_TAG, sendMessage, unreadCounts } from "./messages";
import { isImmediateKind } from "./mail-policy";
import { daemonBuildWarning, staleBuildWarning, versionLine } from "./version";
import { probeSocket } from "./singleton";
import { runDaemon } from "./daemon";
import { handleErrorSignal, handleIdleSignal, reconcile } from "./reconciler";
import { buildRuntime, HerdrRuntime } from "./runtime/herdr";
import { supervisorView, isOperationalWorker } from "./scheduler";
import { attachSession, detachSession, getSession, listSessions, releaseUnhostedBinding } from "./sessions";
import { listRuntimes, adoptRuntimeTarget } from "./runtimes";
import type { Task } from "./schema";
import {
  addTask, approveTask, blockTask, cancelTask, claimNext, claimTask, claimableRunnableTasks, getNotes, getTask,
  listTasks, notesClaimingApproval, notYetRunnableTasks, rejectTask, releaseTask, reviewHeldByLiveReviewer, runnableTasks, setTaskDependencies,
  submitTask, taskCounts, taskDependencies, taskChildren, setTaskParent, unblockTask,
  unclaimableRunnableTasks, addNote, setTaskPlan, waitTask,
} from "./tasks";
import { acceptTask, confirmMerged, intakeTask, recordReview, recordVerification, runMechanicalVerification, submitPhase, taskChecks } from "./workflow";
import { requestRebase } from "./rebase";
import { defaultRunner, type CheckSpec } from "./verify";
import { acceptRunSubmission, getRun, listRuns, startDshRun } from "./dsh-runner";
import { formatDshEvent, readDshEvents } from "./dsh-events";
import { parseRunFailureClass } from "./run-failure";
import { signalRunProcess } from "./run-signal";
import {
  applyWorkspaceCleanup,
  ensureTaskWorktree,
  launchTaskRun,
} from "./run-lifecycle";
import { factoryNativeReviewDepsFromEnv, operatorProviderDepsFromEnv } from "./provider-adapters";
import { checkMergeGate, formatMergeGateDecision } from "./merge-gate";
import { resolveTaskPrTarget } from "./pr-target";
import { runFactoryTask } from "./factory";
import {
  findFactoryOutcomeForRun,
  formatFactoryFailureLines,
  formatStoredFactoryOutcome,
  latestFactoryOutcome,
} from "./factory-failure";
import { DEFAULT_REVIEW_MODEL } from "./reviewer-runner";
import { bindTaskPr, formatPrBindingResult } from "./pr-binding";
import {
  bindSession, findWorkerBySession, getWorker, listWorkers,
  quietActive, registerWorker, retireWorker, setWorkerState, touchSeen, unretireWorker,
} from "./workers";
import { resolveWorkerIdentity } from "./identity";
import { usageReport, usageTotals, type UsageGroup, type UsageRow } from "./usage";
import { attachPrompt, createLane, realHerdrRunner, reapLane } from "./spawn";
import { runDashboard } from "./dashboard/command";
import { runWeb } from "./web";
import { runGc } from "./gc";
import { addReminder, disableReminder, listReminders } from "./reminders";

// A role is "known" if it matches a registered worker or a built-in special role.
// Used for a non-fatal warning on `task add --role`, never a rejection.
function knownRole(db: ReturnType<typeof openDb>, role: string): boolean {
  if (role === "worker" || role === "planner" || role === "reviewer" || role === "integrator") return true;
  return listWorkers(db).some((w) => w.role === role);
}

function usage(): string {
  return `relay — lightweight supervisor for Herdr + OpenCode agents (SQLite is the source of truth)

Usage:
  relay init
  relay daemon [--once] [--interval <ms>]

  relay worker register <id> --role worker [--runtime <herdr-target>] [--session <sid>] [--cwd <dir>] [--command <cmd>]
  relay worker list [--all]
  relay worker status <id>
  relay worker bind <id> --session <sid>
  relay worker retire <id> [--reason <text>]
  relay worker unretire <id>

  relay session attach --session <sid> [--role worker] [--worker <id>] [--kind opencode|codex] [--dir <d>] [--worktree <w>] [--pane <p>] [--tab <t>]
  relay session detach --session <sid>
  relay session list
  relay session status --session <sid>

  relay runtime list [--worker <id>] [--state <state>]

  relay task add "description" [--title T] [--acceptance A] [--priority N] [--role R] [--parent T1] [--plan <plan-id>] [--depends-on T1,T2]
  relay task intake --provider P --issue ID [--slice S] [--title T] [--description D] [--code-change] [--pr URL] [--branch B] [--head SHA] [--repo R] [--base REF] [--check name=cmd ...] [--worktree DIR]
  relay task link <task-id> <plan-id>
  relay task unlink <task-id>
  relay task depend <task-id> <dep-id...> | --clear
  relay task list [--state <state>]
  relay task show <id> [--json]

  relay result submit <task-id> [--evidence E] [--head SHA] [--lease N] [--worker <id>]
  relay result verify <task-id> --pass|--fail [--evidence E] [--head SHA] [--worker <id>]
  relay result review <task-id> --pass|--fail|--blocked [--head SHA] [--profile P] [--reason R] [--supersedes <result-id>] [--reviewer <id>] [--worker <id>]
  relay result rebase <task-id> --reason "<why>" [--head SHA] [--worker <id>]   # integrator/gateway: merge_ready + CONFLICTING PR -> implement attempt+1 (no review verdict)
  relay result merged <task-id> [--head SHA] [--repo R] [--reason R]
  relay result accept <task-id> [--worker <id>]
  relay verify <task-id> [--cwd <dir>] [--head SHA]   # mechanical verify (Relay runs the commands)
  relay merge-check <task-id> [--json] [--authority merge]   # read-only HEAD-bound merge readiness (dry-run; hosted CI is informational)
  relay pr bind <task-id> [--json]   # READ-ONLY: bind the produced commit (task.head_sha) to a real PR the Agent created (re-read/verify; Relay never writes to GitHub)

  relay next [--worker <id>] [--role <r>] [--any-role]
  relay claim <task-id> [--worker <id>] [--role <r>] [--any-role]
  relay note <task-id> "progress" [--worker <id>]
  relay submit <task-id> --evidence "..." [--worker <id>] [--lease <token>]
  relay approve <task-id> [--worker <id>]
  relay reject <task-id> "reason" | --reason <text> [--worker <id>]
  relay block <task-id> "reason" | --reason <text> [--worker <id>] [--human]
  relay unblock <task-id> [--worker <id>]
  relay release <task-id> [--worker <id>]
  relay wait <task-id> --for <30s|2m|1h> "reason" [--worker <id>]

  relay run start <task-id> [--cwd DIR] [--prompt TEXT] [--permission MODE] [--timeout 30m] [--json]
  relay run launch <task-id> [--timeout 30m] [--permission MODE] [--json]   # ensure worktree + pin brief + ONE dsh Run
  relay run factory <task-id> [--max-attempts N] [--dsh BIN] [--reviewer CMD] [--model M] [--permission MODE] [--timeout 30m] [--json]  # code-change tasks only; dsh -> VERIFY -> Claude review -> MergeReady
  relay run worktree <task-id> [--branch B] [--base REF] [--path DIR] [--json]
  relay run cleanup <task-id> [--abort REASON] [--apply] [--force] [--json]
  relay run list [--task <id>] [--json]
  relay run show <run-id> [--json]          # a headless dsh Run (no Herdr)
  relay run logs <run-id> [--tail N]
  relay run cancel <run-id>
  relay run submit <run-id> [--evidence E] [--summary S]   # structured submission (exit 0 alone does NOT submit)

  relay send <worker-id> "message" [--task <tid>] [--kind <k>]
  relay inbox [--worker <id>] [--claim] [--ack <msg-id>]

  relay remind add <worker-id> --every <30s|30m|1h> "message" [--kind note]
  relay remind list [--json] [--all]
  relay remind rm <id>

  relay status
  relay cost [--by worker|task|session] [--since 24h] [--json]
  relay dashboard [--watch] [--show [--tab]] [--hide] [--doctor] [--json] [--runtime-history]
  relay web [--host <h>] [--port <n>] [--token <t>]
  relay events [--follow] [--limit N]
  relay gc [--apply] [--with-history] [--older-than <30s|2m|1h>] [--json]
  relay db path | sources | move <path> [--apply]
  relay config

  # Debug entrypoint (the OpenCode plugin normally talks to the daemon socket)
  relay event record --type <t> [--session <sid>] [--worker <id>] [--task <tid>] [--payload <json>]

Worker identity: --worker flag, $RELAY_WORKER, your Herdr pane, or .relay/worker-id
DB: $RELAY_DB, else $RELAY_CONFIG/~/.config/relay/config.json {"db":...}, else the
    nearest .relay/state.db (upward from cwd; WAL), else <cwd>/.relay/state.db.
    "relay db path|sources" show which wins; "relay db move" relocates it safely.Env: RELAY_LEASE_MS RELAY_LEASE_LIVENESS_GRACE_MS RELAY_STALL_MS RELAY_LOW_WATER
     RELAY_AUTO_APPROVE RELAY_INTERVAL_MS RELAY_ROLE_STRICT (default true)
     RELAY_MAIL_NUDGE_MS RELAY_MAIL_STARVATION_MS RELAY_MAIL_ORDINARY_STARVATION_MS
     RELAY_HUMAN (blocked_human recipient; else nearest assigned ancestor)
Spawn: RELAY_HERDR_WORKSPACE (required to spawn; else $HERDR_WORKSPACE_ID)
Manual attach: requires a live Herdr agent (use --pane/--tab or $HERDR_PANE_ID/$HERDR_TAB_ID)
Runtime cleanup: RELAY_RUNTIME_CLEANUP_GRACE_MS RELAY_ATTACH_TIMEOUT_MS RELAY_RESTART_COOLDOWN_MS
Run disk guard: RELAY_MIN_FREE_DISK_BYTES (default 20 GiB; 0 = threshold off)
Restart cap: RELAY_RESTART_CAP (default 3) RELAY_RESTART_CAP_WINDOW_MS (default 1800000)
Herdr is required. RELAY_RUNTIME=mock is test-only.
Help: relay <command> [subcommand] --help
Version: relay --version   (installed build; rebuild with: bun run build && cp dist/cli.js ~/.local/share/relay/cli.js)
`;
}

// Per-command help. Keys are the command path ("task", "task add", ...).
// Longer (more specific) keys win; a group help covers its subcommands.
const COMMAND_HELP: Record<string, { about: string; usage: string[] }> = {
  init: {
    about: "Create .relay/state.db (WAL) and the control-plane schema in the current directory.",
    usage: ["relay init"],
  },
  run: {
    about:
      "ISH-803/ISH-810 one-shot headless dsh Runs: 1 Run = 1 `dsh --profile headless --json` process = 1 coding attempt, in the Task's worktree, with NO Herdr pane/TUI/`dsh web`/wake/attach. Under <control-plane>/runs/<run-id>/: stdout.log (raw dsh JSONL), stderr.log (reasoning/errors), dsh.jsonl (the ORIGINAL dsh session/status/text/tool_call/tool_result/final events, per-Run evidence) and events.jsonl (Relay's own lifecycle log, kept distinct). A process `exit 0` or a terminal `final` does NOT complete anything — only `relay run submit` (a structured submission bound to the Run/Task/phase/attempt/branch/HEAD) advances the Task. `start` waits for the Run to reach a terminal state (there is no detached mode yet). Permissions are the worktree: $DSH_PERMISSION_MODE=workspace-write by default. " +
      "ISH-760 adds the Task lifecycle: `launch` owns ONE branch+worktree per Task, pins the task spec + verification steps + prior findings into the worktree BEFORE launch, and runs ONE disposable dsh Run per phase/attempt (a FIX is the SAME worktree + findings + a NEW Run). A second writer on the same worktree/branch is refused until the previous Run ends; different worktrees/branches may run in parallel. `worktree` creates/selects the worktree; `cleanup` reclaims it only when safe (real merge or --abort, no open PR, no active writer, no uncommitted changes, relay-owned) and retains the run logs. `relay run logs <run-id>` renders the read-only dsh session/status/text/tool_call/tool_result/final chronology from the per-Run dsh.jsonl (no TUI/Web UI needed). " +
      "ISH-762 adds `relay run factory <task-id>`: the whole factory for ONE Task with no hand-driven pane for the coding — a real headless dsh Run implements, Relay mechanically VERIFYs the recorded HEAD, an INDEPENDENT headless Claude reviewer (`claude -p --output-format json`) returns a structured FIX/PASS (FIX = the SAME worktree + findings + a FRESH Run), and a PASS reaches read-only MergeReady. It never pushes, merges, accepts or writes a provider." +
      " ISH-1013: a non-ready Factory outcome is classified from the EXISTING rows (code rework exhausted / infra blocked / permission-or-human decision / missing-or-inconclusive evidence / stale head / unknown) with the last Run/attempt/HEAD, failing check/review/log references and a concrete next action. The same projection is stored as a durable `factory.outcome` event and shown by `relay run show` / `relay run logs` and `relay task show`; `relay run factory --json` carries it as `failure`.",
    usage: [
      "relay run start <task-id> [--cwd DIR] [--prompt TEXT] [--permission MODE] [--timeout 30m] [--json]",
      "relay run launch <task-id> [--timeout 30m] [--permission MODE] [--json]",
      "relay run factory <task-id> [--max-attempts N] [--dsh BIN] [--reviewer CMD] [--model M] [--permission MODE] [--timeout 30m] [--json]",
      "relay run worktree <task-id> [--branch B] [--base REF] [--path DIR] [--json]",
      "relay run cleanup <task-id> [--abort REASON] [--apply] [--force] [--json]",
      "relay run list [--task <id>] [--limit N] [--json]",
      "relay run show <run-id> [--json]",
      "relay run logs <run-id> [--tail N]",
      "relay run cancel <run-id>",
      "relay run submit <run-id> [--evidence E] [--summary S] [--head SHA]",
    ],
  },
  "run factory": {
    about:
      "Drive ONE code-change Task through the whole factory: headless dsh implement -> Relay mechanical VERIFY -> independent headless Claude review/FIX -> integration -> read-only MergeReady. It NEVER pushes, merges, accepts or writes to a provider. " +
      "CODE-CHANGE TASKS ONLY: a task must have a workflow phase (created with `relay task intake --code-change`); a plain `relay task add` task is refused UP FRONT, before any worktree, with the re-intake instruction. " +
      "VERIFY needs at least ONE REQUIRED mechanical check recorded at intake (`--check name=command`); with none (or only optional checks) the outcome is `no_checks` — an unrun gate is never a PASS. " +
      "`--permission MODE` is forwarded to the headless dsh Run (default `workspace-write`). `--timeout` is the per-Run budget, `--max-attempts` the coding/review attempt cap (it also bounds a fresh IMPLEMENT Run issued for a repairable `NO_IMPLEMENTATION`/partial-commit failure; ENOSPC/resource/permission/auth/unknown failures are never auto-retried). " +
      "The task branch is cut from the SOURCE repo's freshly fetched `origin/main` (or the task's `pr_base`), and a resolved base behind `origin/main` is warned about, never silently accepted. " +
      "ISH-1013: every non-ready result carries a `failure` object: a minimal `class`, the concrete evidence-derived `cause`, the last Run/attempt/HEAD, bounded evidence references (`run show/logs`, check/review/evidence paths), and `next` (what to fix, what to read, the existing safe resume command, and the condition that permits resume). Classification never auto-unblocks: a HOLD, missing permission, live writer or stale/old HEAD stays blocked until an explicit `relay unblock` or a fresh HEAD-bound result. " +
      "ISH-1128: a Task already parked by the OLD stale-HEAD refusal (a Run that amended and force-pushed its own head) is resumed at the parked Run's produced head WITHOUT re-implementing: `relay unblock <task-id>`, `relay claim <task-id> --worker <coordinator>`, then `relay result submit <task-id> --head <parked-run-produced-head> --evidence \"recovered from parked run <run-id>\" --worker <coordinator>` (see docs/run-lifecycle.md).",
    usage: [
      "relay run factory <task-id> [--max-attempts N] [--dsh BIN] [--reviewer CMD] [--model M] [--permission MODE] [--timeout 30m] [--repo DIR] [--review-worktrees DIR] [--json]",
    ],
  },
  db: {
    about:
      "Inspect and move the control-plane DB. Resolution order: RELAY_DB > ~/.config/relay/config.json {\"db\":\"...\"} > legacy <repo>/.relay/state.db if present > XDG default ~/.local/state/relay/<project>/state.db. The socket always sits NEXT TO the db. `move` is dry-run by default, refuses to overwrite an existing DB, and refuses while a socket is present (a daemon may be live).",
    usage: [
      "relay db path",
      "relay db sources",
      "relay db move <path-to-state.db> [--apply] [--force]",
    ],
  },
  config: {
    about: "Print the relay config file path and its contents ({\"db\": \"<state.db>\"} points the CLI at a shared control plane outside the repo).",
    usage: ["relay config"],
  },
  daemon: {
    about: "Run the supervisor loop (reconcile + lease/stall handling).",
    usage: ["relay daemon [--once] [--interval <ms>]", "  --once            run a single pass, then exit", "  --interval <ms>   loop interval (default $RELAY_INTERVAL_MS)"],
  },
  worker: {
    about: "Manage worker identities (the assignees in the durable task ledger).",
    usage: [
      "relay worker register <id> [--role worker] [--runtime <herdr-target>] [--session <sid>] [--cwd <dir>] [--command <cmd>]",
      "relay worker spawn <id> --role <R> [--kind opencode|codex] [--base <ref>] [--label <L>] [--cwd <dir>] [--no-attach]",
      "relay worker reap <id> [--worktree <path>] [--pane <pane>]",
      "relay worker list [--all]",
      "relay worker status <id>",
      "relay worker bind <id> --session <sid>",
      "relay worker retire <id> [--reason <text>]",
      "relay worker unretire <id>",
    ],
  },
  "worker spawn": {
    about:
      "One-command lane setup: create the Herdr worktree (+workspace), start the agent in its root pane, register the worker (adopted, not a managed generation) and prompt the agent to call agent_attach (the session id only exists after the first turn, so attach is agent-driven). Prints the worktree path + pane/workspace. --no-attach skips the prompt; --cwd reuses an existing directory instead of creating a worktree.",
    usage: [
      "relay worker spawn <id> --role <R> [--kind opencode|codex] [--base <ref>] [--label <L>] [--cwd <dir>] [--pane <pane>] [--no-attach]",
    ],
  },
  "worker reap": {
    about:
      "One-command lane teardown (inverse of spawn): retire the worker (so no work is routed), close its Herdr pane and remove the worktree. Best-effort and idempotent — an already-gone pane/worktree is reported, not an error. Paths are read from the worker row unless --worktree/--pane override.",
    usage: ["relay worker reap <id> [--worktree <path>] [--pane <pane>] [--reason <text>]"],
  },
  "worker register": {
    about: "Register a worker. Also writes .relay/worker-id, a SHARED-checkout default used only when --worker/$RELAY_WORKER/the caller's pane cannot name a worker.",
    usage: ['relay worker register <id> [--role worker] [--runtime <herdr-target>] [--session <sid>] [--cwd <dir>] [--command <cmd>]'],
  },
  "worker list": { about: "List workers ({id,role,state,gen,runtime,task,session}). Retired workers are hidden unless --all.", usage: ["relay worker list [--all]"] },
  "worker status": { about: "Print one worker as JSON.", usage: ["relay worker status <id>"] },
  "worker bind": { about: "Bind a worker to an OpenCode session id.", usage: ["relay worker bind <id> --session <sid>"] },
  "worker retire": {
    about: "Retire a worker (history only): hidden from list/status and excluded from scheduling, stalling and role discovery. The row and its events survive. Refused while the worker still owns a task.",
    usage: ['relay worker retire <id> [--reason <text>]'],
  },
  "worker unretire": { about: "Reverse a retirement so the worker becomes schedulable again.", usage: ["relay worker unretire <id>"] },
  session: {
    about: "Manage OpenCode sessions attached to Herdr agents.",
    usage: [
      "relay session attach --session <sid> [--role R] [--worker W] [--kind opencode|codex] [--dir D] [--worktree W] [--pane P] [--tab T]",
      "relay session detach --session <sid>",
      "relay session list",
      "relay session status --session <sid>",
    ],
  },
  "session attach": {
    about: "Attach a session. The Herdr agent is resolved and verified BEFORE touching the DB (fail-closed). An OpenCode session has a `ses...` id; a codex session has a UUID id and MUST pass --kind codex (the opencode guard is not weakened).",
    usage: ["relay session attach --session <sid> [--role R] [--worker W] [--kind opencode|codex] [--dir D] [--worktree W] [--pane P] [--tab T]"],
  },
  "session detach": { about: "Detach a managed session.", usage: ["relay session detach --session <sid>"] },
  "session list": { about: "List sessions.", usage: ["relay session list"] },
  "session status": { about: "Print one session as JSON (or 'unmanaged').", usage: ["relay session status --session <sid>"] },
  runtime: {
    about: "List runtime rows (external vs relay-owned) and their cleanup deadlines.",
    usage: ["relay runtime list [--worker <id>] [--state <state>]"],
  },
  task: {
    about: "Manage tasks in the durable ledger.",
    usage: [
      'relay task add "description" [--title T] [--acceptance A] [--priority N] [--role R] [--parent T1] [--plan <plan-id>] [--depends-on T1,T2]',
      "relay task list [--state <state>]",
      "relay task show <id> [--json]",
      "relay task link <id> <plan-id>",
      "relay task unlink <id>",
      "relay task depend <id> <dep-id...> | --clear",
      'relay task cancel <task-id> --reason <text>',
    ],
  },
  "task add": {
    about: "Queue a new task. --parent nests it under T1; approving a child then tells the immediate parent (one-hop completion bubbling: a child_done note on the parent, children_done when all direct children are done, and a durable message to the parent's current assignee). A --role makes the task claimable only by a worker of that role by default; an unknown role warns (non-fatal), and a role no registered worker has is surfaced as Unclaimable in `relay status`. --plan <plan-id> records which agent-status plan.json item this task belongs to. --depends-on T1,T2 declares prerequisites: the task is NOT runnable (never offered by `relay next`, never claimable, never woken) until every one is done.",
    usage: ['relay task add "description" [--title T] [--acceptance A] [--priority N] [--role R] [--parent T1] [--plan <plan-id>] [--depends-on T1,T2]'],
  },
  "task cancel": {
    about:
      "Close a task in the explicit terminal state `cancelled` (distinct from `done` and from the reversible `blocked_*` parks). Use it for work that is superseded / duplicate / obsolete / policy-changed. The task leaves `relay next` / claim / wake / Unclaimable / Attention, ownership is released, and the reason is recorded as a `cancel` note + event. `done`/`failed` are refused; re-cancelling is an idempotent no-op.",
    usage: ['relay task cancel <task-id> --reason <text> [--worker <id>]'],
  },
  "task intake": {
    about:
      "Idempotent code-change intake, keyed by (provider, issue ID, slice). Replaying the same intake returns the SAME task; a different --slice of the same issue is a DIFFERENT task. --code-change marks it as a code-change task, which enforces the mandatory phase gate (implement -> verify -> review -> integration -> merge_ready -> merged); `relay approve`/RELAY_AUTO_APPROVE can never complete it. --description records the Task description used in the coding/review briefs (distinct from --title). --pr/--branch/--head/--repo/--base link the PR; a review PASS is invalid once the head moves. --check name=command (repeatable) makes verify MECHANICAL: Relay runs the command in --worktree and only passes when that checkout's `git rev-parse HEAD` equals --head (no LLM waits).",
    usage: [
      "relay task intake --provider P --issue ID [--slice S] [--title T] [--description D] [--role R] [--priority N] [--parent T1] [--code-change] [--pr URL] [--branch B] [--head SHA] [--repo R] [--base REF] [--check name=cmd ...] [--worktree DIR]",
    ],
  },
  result: {
    about:
      "Record a STRUCTURED workflow result and advance the task's phase (the source of truth — `relay send` prose is never parsed for a verdict). submit advances implement/integration; verify and review record an outcome; review --blocked parks the task for a human; merged confirms a real GitHub merge (the only 'truly done' signal for a task with a PR); accept is the only way a code-change task becomes terminal internally (it must be at merge_ready). Duplicate/stale results are refused, and an unresolved NG at the same HEAD is never cleared by a later OK alone. A merge_ready task whose bound PR is CONFLICTING can be returned to implement at attempt+1 by the coordinator: `relay result rebase <id> --reason \"<why>\"` (integrator or Gateway/human authority). That route records NO review verdict, refuses an unresolved reviewer NG/HOLD, and the new HEAD needs a fresh VERIFY + independent review. A reviewer may instead return it with `relay result review <id> --fail --reason \"<why>\"`, optionally naming the PASS being replaced with `--supersedes <result-id>`.",
    usage: [
      "relay result submit <task-id> [--evidence E] [--head SHA] [--lease N] [--worker <id>]",
      "relay result verify <task-id> --pass|--fail [--evidence E] [--head SHA] [--worker <id>]",
      "relay result review <task-id> --pass|--fail|--blocked [--head SHA] [--profile P] [--reason R] [--supersedes <result-id>] [--reviewer <id>] [--worker <id>]",
      "relay result rebase <task-id> --reason <text> [--head SHA] [--worker <id>]",
      "relay result merged <task-id> [--head SHA] [--repo R] [--reason R]",
      "relay result accept <task-id> [--worker <id>]",
    ],
  },
  "result rebase": {
    about:
      "ISH-1122: return a merge_ready code-change Task to implement at attempt+1 when its bound/observed PR is CONFLICTING at the recorded HEAD (a sibling lane merged first). The reason becomes the FIX brief; the prior PASS stays as history but no longer authorises a merge, so the produced HEAD needs a fresh VERIFY and a fresh independent review. Refused unless the PR is observed CONFLICTING (a mergeable PR, unknown mergeability, or an unreadable PR is never assumed), and refused when an unresolved reviewer NG/HOLD or owner HOLD exists. It never records a review verdict and never pushes, rebases, merges or writes a provider. Authority: an integrator identity or the Task's Gateway/human. The read-only `gh` reader is auto-detected when RELAY_PROVIDER_GITHUB is unset; `off` disables it.",
    usage: ["relay result rebase <task-id> --reason <text> [--head SHA] [--worker <id>]"],
  },
  verify: {
    about:
      "Run a task's mechanical-verify checks (the standard commands recorded at intake) and advance the phase from the PROCESS EXIT RESULT: pass -> review, fail -> implement FIX, a required NOT_RUN/INCONCLUSIVE -> BLOCKED. The daemon does this automatically for a Relay-owned verify phase; this entrypoint is for an explicit run.",
    usage: ["relay verify <task-id> [--cwd <dir>] [--head SHA]"],
  },
  "merge-check": {
    about:
      "READ-ONLY, HEAD-bound merge readiness (dry-run by default). Judges the GitHub PR (OPEN, non-draft, head/base/diff, mergeability, re-fetched `merged`), the required mechanical VERIFY at the CURRENT head, a trusted independent review OK pinned to that head, an unresolved NG, an owner HOLD and dependent change order, and prints READY / BLOCKED with concrete reasons. ISH-1140: GitHub-hosted CI (check runs) is NEVER a gate — it is read only for the informational `hosted_ci: not verified | passing | failing` field, so failing or absent hosted checks cannot block. It NEVER pushes, rebases or merges: a real merge needs a point-of-use authority (ISH-288), so without one the verdict is BLOCKED/NO_PERMISSION. --authority merge only assumes the permission for the DRY-RUN verdict; it performs nothing. A conflict raises IntegrationRequired for a Gateway routing decision. --json emits the structured decision.",
    usage: ["relay merge-check <task-id> [--json] [--authority merge]"],
  },
  pr: {
    about:
      "ISH-880/885/1087 READ-ONLY Task↔PR check. Bridges a produced commit to a real GitHub PR and binds the PR's CURRENT remote HEAD to the SAME Task/attempt — by READING GitHub only. The head is ALWAYS the Task's produced commit (`task.head_sha`, a full 40-hex SHA) — there is no caller-supplied head. It re-reads an already-recorded PR (owner/repo#n) or adopts an existing PR for the task's (repo, branch), and requires its live head to equal the produced commit; a moved/unreadable PR, a different/fork repo, or no identity/adoptable PR is BLOCKED (never a fake pass). The repo is resolved from the Task's recorded identity, else the Task workspace's `origin`, so a Task that records only a branch still binds its PR. Relay NEVER writes to GitHub — no push, no create/update, no review; the Coding Agent performs those with normal `git`/`gh`, then Relay observes. The read-only `gh` reader is auto-detected when RELAY_PROVIDER_GITHUB is unset; `off` disables it.",
    usage: ["relay pr bind <task-id> [--repo R] [--json]"],
  },
  "task list": { about: "List tasks (id, state, priority, role, assignee, plan, depends, title).", usage: ["relay task list [--state <state>]"] },
  "task show": { about: "Print one task as JSON (includes depends_on). Notes go to stderr so stdout stays parseable; --json emits ONE document with the task, its dependencies and its notes.", usage: ["relay task show <id> [--json]"] },
  "task link": { about: "Link a task to a plan.json item (agent-status shows the plan status from relay).", usage: ["relay task link <task-id> <plan-id>"] },
  "task unlink": { about: "Remove a task's plan linkage.", usage: ["relay task unlink <task-id>"] },
  "task depend": {
    about: "Set (or clear) a task's run-gating prerequisites. A queued task with an unmet prerequisite is not runnable: `relay next` never offers it, it is never woken, and an explicit `relay claim` refuses it (not bypassable by --any-role). A pre-created review gate MUST declare its inputs this way, or it stays non-runnable until something is in review.",
    usage: [
      "relay task depend <task-id> <dep-id...>",
      "relay task depend <task-id> --clear",
    ],
  },
  "task reparent": {
    about: "Set (or clear, with --clear) a task's parent. `--parent` was creation-only, so a subtree created without it was orphaned: no child_done bubbling and the wrong tree, fixable only by raw SQLite surgery. The new parent must exist and must not be a descendant of the task (cycle refused).",
    usage: [
      "relay task reparent <task-id> <new-parent-id>",
      "relay task reparent <task-id> --clear",
      "relay task move <task-id> <new-parent-id>   # alias",
    ],
  },
  next: {
    about: "Claim the next queued task the worker's role may take (prints NO_TASK if none). Role matching is STRICT by default: a role-tagged task is only claimable by a worker registered with that role; role-less tasks by anyone.",
    usage: [
      "relay next [--worker <id>] [--role <r>] [--any-role]",
      "  --role <r>   match this role instead of the worker's registered role",
      "  --any-role   recovery override: ignore task roles (old any-worker behavior)",
    ],
  },
  claim: {
    about: "Claim a specific task. Role matching is STRICT by default (see `relay next --help`).",
    usage: [
      "relay claim <task-id> [--worker <id>] [--role <r>] [--any-role]",
      "  --any-role   recovery override: ignore the task's role",
    ],
  },
  note: { about: "Record a progress note (the strongest liveness signal).", usage: ['relay note <task-id> "progress" [--worker <id>]'] },
  submit: { about: "Submit work for review (task -> review).", usage: ['relay submit <task-id> --evidence "..." [--worker <id>] [--lease <token>]'] },
  approve: { about: "Approve a reviewed task (task -> done).", usage: ["relay approve <task-id> [--worker <id>]"] },
  reject: { about: "Reject a reviewed task (task -> queued).", usage: ['relay reject <task-id> "reason" | --reason <text> [--worker <id>]'] },
  block: { about: "Block a task. --human marks it blocked_human (needs a person).", usage: ['relay block <task-id> "reason" | --reason <text> [--worker <id>] [--human]'] },
  unblock: { about: "Unblock a task.", usage: ["relay unblock <task-id> [--worker <id>]"] },
  release: {
    about: "Hand a RUNNING task back to the queue cleanly (no block/reject note): clears assignee + lease, bumps the fencing token. The current assignee or any human/worker may release.",
    usage: ["relay release <task-id> [--worker <id>]"],
  },
  wait: {
    about: "Declare a BOUNDED quiet lease on a running task you own: you may be runtime-idle (session idle) until the deadline without being treated as stalled. Does not change worker/task state or ownership; cleared by note/submit/block/release/claim, and by expiry.",
    usage: ['relay wait <task-id> --for <30s|2m|1h> "reason" [--worker <id>]'],
  },
  send: {
    about:
      "Send a durable peer-to-peer message to another worker. It is delivered at the recipient's next idle/turn boundary and DEFERS while the worker is mid-turn (never interrupts). --urgent (kind=urgent) is the only way to force a genuine mid-work wake; completion kinds (child_done/...) may also pre-empt via the starvation cap. --kind sets the message kind.",
    usage: [
      'relay send <worker-id> "message" [--task <tid>] [--kind <k>]',
      'relay send <worker-id> "message" --urgent   # interrupt a busy worker',
    ],
  },
  inbox: { about: "Read (and optionally claim/ack) the worker's own inbox.", usage: ["relay inbox [--worker <id>] [--claim] [--ack <msg-id>]"] },
  remind: {
    about:
      "Standing reminders: the always-on daemon enqueues a recurring durable message to a worker — the daemon owns the schedule (no launchd/cron). A reminder fires when --every has elapsed since its last send AND the recipient has no unread mail, so reminders never stack behind an unread one. rm DISABLES (enabled=0) rather than deleting, keeping the row as history.",
    usage: [
      'relay remind add <worker-id> --every <30s|30m|1h> "message" [--kind note]',
      "relay remind list [--json] [--all]",
      "relay remind rm <id>",
    ],
  },
  status: { about: "Print workers, task counts, and the supervisor view (lightweight inspection).", usage: ["relay status"] },
  web: {
    about:
      "Small read/write web view of the control plane (Bun.serve, one self-contained page, no new dependencies). Binds 127.0.0.1 by default; --host 0.0.0.0 opts into a non-loopback bind (e.g. Tailscale), and a token (--token or RELAY_WEB_TOKEN) is then required on every request (Authorization: Bearer <t> or ?token=<t>) because the tailnet can reach it. GETs read the shared SQLite WAL read-only; the page's send form POSTs through the same durable `relay send` enqueue path.",
    usage: [
      "relay web [--host <h>] [--port <n>] [--token <t>]",
      "  --host <h>   bind address (default 127.0.0.1; use 0.0.0.0 for a tailnet)",
      "  --port <n>   listen port (default 8787)",
      "  --token <t>  shared secret required on every request (env: RELAY_WEB_TOKEN)",
    ],
  },
  dashboard: {
    about:
      "Read-only human dashboard: Relay task tree + workers (current runtime overlaid) + attention, with Herdr pane links. Never mutates state; --show/--hide manage only its own UI pane. " +
      "--watch clips each frame to the pane (reserving the bottom row so it cannot scroll/accumulate) and freezes on space/p (PAUSED); while paused, ↑/↓ (j/k, PageUp/Down) scroll so the clipped tail is readable. " +
      "Inside a Herdr pane it draws INLINE by default (`herdr pane read` reads the normal screen; alt-screen can look blank); --alt-screen forces the alternate screen (nothing in scrollback) and --no-alt-screen forces inline anywhere. " +
      "The WORKERS section has a column header: STATE is Relay's durable ownership (working/idle/stalled/dead) and EXEC is Herdr's transport/execution telemetry (busy/quiet/!idle).",
    usage: [
      "relay dashboard",
      "relay dashboard --watch [--interval <ms>] [--alt-screen|--no-alt-screen]",
      "relay dashboard --show [--pane <id>] [--direction right|down] [--tab]",
      "relay dashboard --hide",
      "relay dashboard --doctor",
      "relay dashboard --json [--runtime-history]",
    ],
  },
  cost: {
    about:
      "Attributed token/cost usage (from the plugin's session.usage telemetry). Groups by worker (default), task or session; deltas are attributed to the task the worker held when they were reported. --since accepts 30s/2m/1h/24h.",
    usage: ["relay cost [--by worker|task|session] [--since 24h] [--json]"],
  },
  events: { about: "Print recent events, or follow them (Ctrl-C to stop).", usage: ["relay events [--follow] [--limit N]"] },
  gc: {
    about:
      "Purge historical rows: retired workers, terminal (done/failed) tasks, stale/dead/cleaned runtimes, and unmanaged/retired sessions. DRY-RUN by default; --apply deletes. Refuses to touch non-retired workers or non-terminal tasks, and a terminal task still required as a dependency or with a non-terminal child is skipped. events/messages/task_notes are NEVER removed unless --with-history.",
    usage: [
      "relay gc [--apply] [--with-history] [--older-than <30s|2m|1h>] [--json]",
      "  --apply          actually delete (default: report only)",
      "  --with-history   also delete events/messages/task_notes referencing purged rows",
      "  --older-than <d> only purge rows older than this (grace window)",
    ],
  },
  event: {
    about: "Debug entrypoint: record an event. session.idle/error drive the same state machine as the daemon.",
    usage: ["relay event record --type <t> [--session <sid>] [--worker <id>] [--task <tid>] [--payload <json>]"],
  },
};

const GROUP_COMMANDS = new Set(["worker", "session", "task", "event", "remind", "run"]);

function commandUsage(path: string[]): string {
  for (let n = path.length; n >= 1; n--) {
    const key = path.slice(0, n).join(" ");
    const h = COMMAND_HELP[key];
    if (!h) continue;
    const lines = [
      `relay ${key}`,
      "",
      `  ${h.about}`,
      "",
      "Usage:",
      ...h.usage.map((u) => `  ${u}`),
      "",
      "Options:",
      "  -h, --help   show this help",
    ];
    if (GROUP_COMMANDS.has(key)) {
      lines.push("", `  Run \`relay ${key} <subcommand> --help\` for details.`);
    }
    lines.push("");
    return lines.join("\n");
  }
  return usage();
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

/**
 * Collect values of a REPEATABLE value flag, each also comma-split, e.g.
 * `--depends-on T1,T2 --depends-on T3` -> ["T1","T2","T3"]. A flag-like or
 * missing value is ignored rather than stored as a task id.
 */
function flagValues(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== name) continue;
    const v = args[i + 1];
    if (v !== undefined && !v.startsWith("-")) out.push(...v.split(","));
    i++;
  }
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Like flagValues but WITHOUT comma-splitting (for command strings). */
function flagRepeated(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== name) continue;
    const v = args[i + 1];
    if (v !== undefined && !v.startsWith("-")) out.push(v);
    i++;
  }
  return out;
}

/** Parse repeatable `--check name=command` flags into mechanical-verify specs. */
function parseCheckFlags(values: string[]): CheckSpec[] {
  const out: CheckSpec[] = [];
  for (const v of values) {
    const eq = v.indexOf("=");
    if (eq <= 0) throw new Error(`--check must be name=command (got '${v}')`);
    out.push({ name: v.slice(0, eq).trim(), command: v.slice(eq + 1).trim(), required: true });
  }
  return out;
}

function resolveWorkerId(db: ReturnType<typeof openDb>, explicit?: string): string {
  const f = join(process.cwd(), STATE_DIR, "worker-id");
  let fileDefault: string | undefined;
  if (existsSync(f)) {
    const v = readFileSync(f, "utf-8").trim();
    if (v) fileDefault = v;
  }
  return resolveWorkerIdentity({
    db,
    explicit,
    envWorker: process.env.RELAY_WORKER,
    paneId: process.env.HERDR_PANE_ID,
    fileDefault,
  });
}

function fmtAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function fmtCost(n: number): string {
  return `$${n.toFixed(4)}`;
}

/** Collapse whitespace and cap a command string for a one-line status row. */
function truncText(s: string, max = 48): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : one.slice(0, Math.max(1, max - 1)) + "…";
}

/** Notes worth surfacing when a worker picks up a task (context, not state). */
const TASK_CONTEXT_KINDS = new Set([
  "child_done",
  "children_done",
  "child_cancelled",
  "blocked_human",
  "blocked_internal",
  "reject",
  "cancel",
  "evidence",
]);

/** Tasks in a given state, in the same order the scheduler would offer them. */
function tasksInState(db: ReturnType<typeof openDb>, state: string): Task[] {
  return db
    .query(`SELECT * FROM tasks WHERE state = ? ORDER BY priority DESC, created_at ASC`)
    .all(state) as Task[];
}

/** `T1,T2,+3 more` — cap a "next" list so a long queue stays one line. */
function truncIds(rows: Task[], cap = 5): string {
  const ids = rows.slice(0, cap).map((t) => t.id);
  const extra = rows.length - ids.length;
  return extra > 0 ? `${ids.join(",")},+${extra} more` : ids.join(",");
}

/**
 * Print the task's relevant notes when it is claimed, so a worker that takes
 * over a parent (or any task) does not miss a child completion or a prior
 * block/reject. Appended AFTER the existing output, so stdout parsing of the
 * first line keeps working. `--json` callers already get all notes.
 */
function printTaskContext(db: ReturnType<typeof openDb>, taskId: string): void {
  for (const n of getNotes(db, taskId).filter((x) => TASK_CONTEXT_KINDS.has(x.kind))) {
    console.log(`  [${n.kind}] ${n.worker_id ?? "?"}: ${n.body}`);
  }
}

/** Parse "30s" / "2m" / "1h" (a bare number means seconds) into milliseconds. */function parseDuration(s: string): number {
  const m = /^(\d+)(s|m|h)?$/.exec(s.trim());
  if (!m) throw new Error(`invalid duration '${s}' (use e.g. 30s, 2m, 1h)`);
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  const ms = unit === "h" ? n * 3_600_000 : unit === "m" ? n * 60_000 : n * 1_000;
  if (ms <= 0) throw new Error(`duration must be positive: ${s}`);
  return ms;
}

/** Render an interval ms back to its compact `30s` / `30m` / `1h` form. */
function fmtEvery(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

/**
 * Flags that CONSUME the following token as their value. Boolean flags
 * (`--human`, `--any-role`, `--json`, ...) are deliberately absent, so a
 * positional immediately after one is not swallowed.
 */
const VALUE_FLAGS = new Set([
  "--worker", "--reason", "--evidence", "--lease", "--kind", "--task", "--for",
  "--role", "--state", "--limit", "--interval", "--session", "--runtime", "--cwd",
  "--command", "--title", "--kind", "--acceptance", "--priority", "--parent", "--plan",
  "--dir", "--worktree", "--pane", "--tab", "--workspace", "--type", "--payload",
  "--ack", "--depends-on", "--older-than", "--base", "--label", "--since", "--by",
  "--every",
  // ISH-803 headless Run flags.
  "--head", "--phase", "--attempt", "--branch", "--summary", "--permission",
  "--timeout", "--prompt", "--tail",
  // ISH-760 worktree/cleanup flags.
  "--abort", "--path",
]);

/** Positional args only, skipping flags and their (known) values, e.g. ["T12","reason"]. */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("-")) {
      if (VALUE_FLAGS.has(args[i])) i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

/**
 * Resolve REQUIRED free text (a reason / note body) from its positional form OR
 * its `--flag <text>` form, in any order. Fail closed: a missing value or a bare
 * flag token is refused instead of being persisted as the text.
 *
 * Regression (`send-guard` sibling): `relay block T152 --reason "the real
 * explanation" --worker w` read `argv[2]`, which is the literal "--reason", and
 * stored that as the block reason while discarding the explanation.
 *
 * @param args      the command's own args, starting with the task id
 * @param usageLine the command's usage string, restated on failure
 * @param flagName  the optional `--flag <text>` form (omitted when there is none)
 */
function resolveText(args: string[], usageLine: string, flagName?: string): string {
  const explicit = flagName ? flag(args, flagName) : undefined;
  const text = explicit ?? positionals(args)[1];
  const where = flagName ? `positionally or via ${flagName} <text>` : "positionally";
  if (text === undefined || text.trim() === "") {
    throw new Error(`${usageLine}\n  the text is required (pass it ${where}, after the task id)`);
  }
  if (text.startsWith("-")) {
    throw new Error(
      `${usageLine}\n  refusing the flag-like text "${text}" — pass the text ${where}, after the task id`
    );
  }
  return text;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--version" || argv[0] === "-V" || argv[0] === "version") {
    console.log(versionLine());
    const warn = staleBuildWarning();
    if (warn) console.error(warn);
    return;
  }
  if (argv.length === 0 || argv[0] === "help" || argv.some((a) => a === "--help" || a === "-h")) {
    const path = argv.filter((a) => a !== "help" && a !== "--help" && a !== "-h");
    console.log(commandUsage(path));
    return;
  }
  const cmd = argv[0];

  if (cmd === "init") {
    console.log(initControlPlane(process.cwd()));
    return;
  }

  if (cmd === "db") {
    const sub = argv[1];
    const resolved = resolveDb();
    if (!sub || sub === "path") {
      console.log(describeDb(resolved));
      return;
    }
    if (sub === "sources") {
      // Show the whole resolution order with which one wins, for debugging a
      // split ledger (a stale RELAY_DB or config is the usual culprit).
      const cfg = configPath();
      console.log(`RELAY_DB      ${process.env.RELAY_DB ? resolve(process.env.RELAY_DB) : "-"}`);
      console.log(`config        ${existsSync(cfg) ? `${cfg} -> ${readConfig(cfg).db ?? "-"}` : `${cfg} (absent)`}`);
      console.log(`legacy        ${findLegacyDb() ?? "-"}`);
      console.log(`xdg default   ${outsideRepoDefault()}`);
      console.log(`=> resolved   ${resolved.path} (${resolved.source})`);
      return;
    }
    if (sub === "move") {
      const dest = argv[2] ? resolve(argv[2]) : resolveDb().path === outsideRepoDefault() ? "" : outsideRepoDefault();
      if (!dest) throw new Error("usage: relay db move <path-to-state.db> [--apply] [--force]\n  (dry-run by default; target must be a state.db path)");
      const plan = planDbMove(resolved.path, dest);
      console.log(`from:   ${plan.from}${plan.sourceExists ? "" : "  (MISSING)"}`);
      console.log(`to:     ${plan.to}${plan.destinationExists ? "  (EXISTS — would be refused)" : ""}`);
      console.log(`files:  ${plan.files.length ? plan.files.join(", ") : "(none)"}`);
      if (!hasFlag(argv, "--apply")) {
        console.log("dry-run: nothing moved. Re-run with --apply (and stop the daemon first).");
        return;
      }
      const moved = applyDbMove(plan, { force: hasFlag(argv, "--force") });
      console.log(`moved ${moved.length} file(s): ${moved.join(", ")}`);
      console.log(`NOTE: point the fleet at it with RELAY_DB=${plan.to} or {"db":"${plan.to}"} in ${configPath()}; the daemon still needs a restart.`);
      return;
    }
    throw new Error(`unknown db subcommand: ${sub} (try: relay db path | sources | move)`);
  }

  if (cmd === "config") {
    // Read-only: printing the config path/value helps set RELAY_DB correctly.
    const cfg = configPath();
    if (!existsSync(cfg)) {
      console.log(`${cfg} (absent)`);
      console.log(`create it with: {"db": "<path-to-state.db>"}`);
      return;
    }
    console.log(`${cfg}`);
    console.log(JSON.stringify(readConfig(cfg), null, 2));
    return;
  }

  if (cmd === "daemon") {
    const once = hasFlag(argv, "--once");
    const interval = flag(argv, "--interval") ? Number(flag(argv, "--interval")) : undefined;
    await runDaemon({ once, intervalMs: interval });
    return;
  }

  if (cmd === "dashboard") {
    process.exitCode = await runDashboard(argv.slice(1));
    return;
  }

  if (cmd === "web") {
    // Long-running server: handled before the command DB is opened (like
    // dashboard) so the CLI's single handle is never held open afterward.
    await runWeb(argv.slice(1));
    return;
  }

  const db = openDb(defaultDbPath());
  try {
    switch (cmd) {
      case "worker": {
        const sub = argv[1];
        if (sub === "register") {
          const id = argv[2];
          if (!id) throw new Error("usage: relay worker register <id> --role worker");
          const role = flag(argv.slice(2), "--role") ?? "worker";
          const runtimeId = flag(argv.slice(2), "--runtime");
          const sessionId = flag(argv.slice(2), "--session");
          const existing = getWorker(db, id);
          const w = registerWorker(db, id, {
            role,
            runtimeId: runtimeId ?? undefined,
            sessionId: sessionId ?? undefined,
            cwd: flag(argv.slice(2), "--cwd") ?? undefined,
            command: flag(argv.slice(2), "--command") ?? undefined,
          });
          // Never flip an EXISTING worker to idle: it may be mid-task, and a
          // registration is not evidence its work stopped. Only a fresh
          // registration (state 'starting') is normalized to idle.
          if (!existing) setWorkerState(db, id, "idle");
          // `--runtime` names an EXISTING Herdr target. Record a real adopted
          // worker_runtimes row (active, relay_owned=0) — setting only
          // workers.runtime_id left the worker invisible to every projection
          // that reads worker_runtimes (dashboard/status pane resolution).
          if (runtimeId) {
            adoptRuntimeTarget(db, { workerId: id, generation: w.generation, target: runtimeId });
          }
          // Remember a default worker identity for this checkout.
          try { writeFileSync(join(process.cwd(), STATE_DIR, "worker-id"), id); } catch { /* ignore */ }
          console.log(`registered ${w.id} role=${w.role}`);
        } else if (sub === "list") {
          const all = hasFlag(argv.slice(2), "--all");
          for (const w of listWorkers(db, { includeRetired: all })) {
            const retired = w.retired_at ? `\tRETIRED(${w.retired_reason ?? "-"})` : "";
            const quiet = quietActive(w) ? `\tquiet=${fmtAge((w.quiet_until ?? now()) - now())} (${w.quiet_reason ?? "-"})` : "";
            console.log(`${w.id}\t${w.role}\t${w.state}\tgen=${w.generation}\truntime=${w.runtime_id ?? "-"}\ttask=${w.current_task_id ?? "-"}\tsession=${w.opencode_session_id ?? "-"}${quiet}${retired}`);
          }
        } else if (sub === "retire") {
          const id = argv[2];
          if (!id) throw new Error("usage: relay worker retire <id> [--reason <text>]");
          const w = retireWorker(db, id, flag(argv.slice(2), "--reason") ?? undefined);
          console.log(`retired ${w.id} role=${w.role}${w.retired_reason ? ` reason=${w.retired_reason}` : ""}`);
        } else if (sub === "spawn") {
          const id = argv[2];
          if (!id) {
            throw new Error(
              `usage: relay worker spawn <id> --role <R> [--kind ${AGENT_KINDS_HELP}] [--base <ref>] [--label <L>] ` +
              "[--cwd <existing-dir>] [--pane <pane>] [--no-attach]"
            );
          }
          const rest = argv.slice(2);
          const role = flag(rest, "--role") ?? "worker";
          const kind = flag(rest, "--kind") ?? "opencode";
          if (!isKnownKind(kind)) throw new Error(`unknown --kind '${kind}' (expected ${AGENT_KINDS_HELP})`);
          const wantAttach = !hasFlag(rest, "--no-attach");
          if (!knownRole(db, role)) {
            console.error(
              `relay: warning: role '${role}' matches no registered worker and is not a known special role ` +
                `(worker/planner/reviewer); the lane's tasks may be unclaimable.`
            );
          }
          // Fail closed before doing anything external: a duplicate id would
          // otherwise create a worktree/agent we cannot register.
          const existing = getWorker(db, id);
          if (existing && existing.retired_at === null && existing.opencode_session_id) {
            throw new Error(`worker ${id} already exists and is attached; use 'relay worker reap ${id}' to tear it down first`);
          }
          const created = createLane({
            id,
            role,
            kind,
            base: flag(rest, "--base") ?? undefined,
            label: flag(rest, "--label") ?? undefined,
            cwd: flag(rest, "--cwd") ?? undefined,
            pane: flag(rest, "--pane") ?? undefined,
          });
          for (const s of created.steps) console.log(`  ${s}`);
          // Register exactly like `relay worker register --runtime`, so the lane
          // worker is an ADOPTED (relay_owned=0) worker, not a managed generation.
          const w = registerWorker(db, id, {
            role,
            agentKind: kind,
            runtimeId: created.paneId ?? undefined,
            cwd: created.worktreePath,
          });
          if (!existing) setWorkerState(db, id, "idle");
          if (created.paneId) {
            adoptRuntimeTarget(db, { workerId: id, generation: w.generation, target: created.paneId });
          }
          let attachPrompted = false;
          if (wantAttach) {
            const prompt = attachPrompt(id, created.paneId);
            const r = (realHerdrRunner())(["agent", "prompt", created.agentName, prompt], 60000);
            attachPrompted = r.ok;
            if (!r.ok) {
              console.error(`relay: warning: could not prompt ${id} to attach: ${(r.stderr || r.stdout).trim().slice(0, 160)}`);
              console.error(`relay: run: herdr agent prompt ${id} '${prompt}'`);
            } else {
              console.log(`  prompted ${id} to attach`);
            }
          }
          console.log(`spawned ${w.id} role=${w.role} kind=${kind}`);
          console.log(`  worktree: ${created.worktreePath}`);
          console.log(`  pane:     ${created.paneId ?? "-"}${created.workspaceId ? `  workspace: ${created.workspaceId}` : ""}`);
          if (!wantAttach) console.log(`  attach skipped (--no-attach); prompt it later: relay worker status ${w.id}`);
        } else if (sub === "reap") {
          const id = argv[2];
          if (!id) throw new Error("usage: relay worker reap <id> [--worktree <path>] [--pane <pane>]");
          const rest = argv.slice(2);
          const w = getWorker(db, id);
          if (!w) throw new Error(`unknown worker: ${id}`);
          const paneId = flag(rest, "--pane") ?? w.runtime_id ?? null;
          const worktreePath = flag(rest, "--worktree") ?? w.cwd ?? null;
          // Retire FIRST so no further work is routed to the lane.
          const retired = retireWorker(db, id, flag(rest, "--reason") ?? "reaped");
          console.log(`retired ${retired.id}`);
          const steps = reapLane({ workerId: id, paneId, worktreePath });
          for (const s of steps) console.log(`  ${s}`);
          console.log(`reaped ${id}${paneId ? ` pane=${paneId}` : ""}${worktreePath ? ` worktree=${worktreePath}` : ""}`);
        } else if (sub === "unretire") {
          const id = argv[2];
          if (!id) throw new Error("usage: relay worker unretire <id>");
          const w = unretireWorker(db, id);
          console.log(`unretired ${w.id} role=${w.role} state=${w.state}`);
        } else if (sub === "status") {
          const id = argv[2];
          if (!id) throw new Error("usage: relay worker status <id>");
          const w = getWorker(db, id);
          if (!w) throw new Error(`unknown worker: ${id}`);
          console.log(JSON.stringify(w, null, 2));
        } else if (sub === "bind") {
          const id = argv[2];
          const sessionId = flag(argv.slice(2), "--session");
          if (!id || !sessionId) throw new Error("usage: relay worker bind <id> --session <sid>");
          const w = bindSession(db, id, sessionId);
          // Same adopted-runtime recording as `register --runtime`: bind is the
          // other way a worker gets a Herdr target, and the projections read
          // worker_runtimes, not workers.runtime_id.
          if (w.runtime_id) adoptRuntimeTarget(db, { workerId: id, generation: w.generation, target: w.runtime_id });
          console.log(`bound ${w.id} session=${w.opencode_session_id}`);
        } else {
          throw new Error(`unknown worker subcommand: ${sub}`);
        }
        break;
      }

      case "session": {
        const sub = argv[1];
        const rest = argv.slice(2);
        if (sub === "attach") {
          const sessionId = flag(rest, "--session");
          if (!sessionId) throw new Error(`usage: relay session attach --session <sid> [--role R] [--worker W] [--kind ${AGENT_KINDS_HELP}] [--dir D] [--pane P] [--tab T]`);
          // Manual attach: the session must provably live inside a Herdr agent.
          // Resolve + verify BEFORE touching the DB; unverifiable => fail closed.
          // `--dir <project>` identifies the pane from the session's working
          // directory (exactly one opencode agent there); it takes precedence
          // over the caller's $HERDR_* env, which leaks the CALLER's pane when
          // attaching a session in another pane/workspace.
          const dir = flag(rest, "--dir") ?? undefined;
          const declaredKind = flag(rest, "--kind") ?? undefined;
          if (declaredKind && !isKnownKind(declaredKind)) {
            throw new Error(`unknown --kind '${declaredKind}' (expected ${AGENT_KINDS_HELP})`);
          }
          // An explicit --pane likewise supersedes the caller's env: the pane's
          // own live workspace/tab is authoritative, so a stale $HERDR_WORKSPACE_ID
          // or $HERDR_TAB_ID from the caller must not veto the attach.
          const explicitPane = flag(rest, "--pane");
          const noEnv = !!dir || !!explicitPane;
          const rt = buildRuntime();
          const identity = await rt.resolveIdentity({
            sessionId,
            hint: {
              paneId: explicitPane ?? (dir ? undefined : process.env.HERDR_PANE_ID),
              tabId: flag(rest, "--tab") ?? (noEnv ? undefined : process.env.HERDR_TAB_ID),
              workspaceId: flag(rest, "--workspace") ?? (noEnv ? undefined : process.env.HERDR_WORKSPACE_ID),
              directory: dir,
              // A bare-UUID session (codex/claude) is declared with `--kind`;
              // `ses...` (opencode) is inferred. See src/harness.ts.
              agentKind: declaredKind ?? inferKind(sessionId),
            },
          });
          // Correct a stale stored binding before attachSession's steal guard:
          // if the worker's recorded session is no longer hosted by Herdr (e.g.
          // after a restart), release it so this live session can take over.
          const explicitWorker = flag(rest, "--worker") ?? process.env.RELAY_WORKER;
          const targetWorker = explicitWorker ?? getSession(db, sessionId)?.worker_id;
          if (targetWorker) {
            releaseUnhostedBinding(db, targetWorker, sessionId, await rt.reportedSessions());
          }
          const s = attachSession(db, sessionId, {
            role: flag(rest, "--role") ?? undefined,
            workerId: flag(rest, "--worker") ?? undefined,
            agentKind: declaredKind,
            directory: dir,
            worktree: flag(rest, "--worktree") ?? undefined,
            identity,
          });
          console.log(
            `attached ${s.session_id} worker=${s.worker_id} generation=${s.generation} agent=${identity.agent} tab=${identity.tabId} relay_owned=false`
          );
        } else if (sub === "detach") {
          const sessionId = flag(rest, "--session");
          if (!sessionId) throw new Error("usage: relay session detach --session <sid>");
          const s = detachSession(db, sessionId);
          console.log(s ? `detached ${s.session_id}` : "no such session (already unmanaged)");
        } else if (sub === "list") {
          for (const s of listSessions(db)) {
            console.log(`${s.session_id}\t${s.managed === 1 ? "managed" : "unmanaged"}\tworker=${s.worker_id ?? "-"}\tgen=${s.generation}`);
          }
        } else if (sub === "status") {
          const sessionId = flag(rest, "--session");
          if (!sessionId) throw new Error("usage: relay session status --session <sid>");
          const s = getSession(db, sessionId);
          if (!s) {
            console.log("unmanaged (unknown session)");
          } else {
            console.log(JSON.stringify(s, null, 2));
          }
        } else {
          throw new Error(`unknown session subcommand: ${sub}`);
        }
        break;
      }

      case "runtime": {
        const sub = argv[1];
        if (sub !== "list") throw new Error("usage: relay runtime list [--worker <id>] [--state <state>]");
        const rest = argv.slice(2);
        const workerId = flag(rest, "--worker");
        const state = flag(rest, "--state");
        const rows = listRuntimes(db, { workerId, state: state as never });
        if (rows.length === 0) console.log("(none)");
        for (const r of rows) {
          const age = fmtAge(now() - r.created_at);
          console.log(
            `${r.worker_id}\tg${r.generation}\t${r.state}\towned=${r.relay_owned === 1 ? "relay" : "external"}\truntime=${r.runtime_id ?? "-"}\ttab=${r.tab_id ?? "-"}\tws=${r.workspace_id ?? "-"}\tsession=${r.session_id ?? "-"}\tage=${age}\tcleanup_after=${r.cleanup_after ? new Date(r.cleanup_after).toISOString() : "-"}`
          );
        }
        break;
      }

      case "task": {
        const sub = argv[1];
        if (sub === "add") {
          const rest = argv.slice(2);
          // The description is the first POSITIONAL (same blind-argv[2] class as
          // block/reject/note): `task add --title X "desc"` used to store the
          // literal "--title" as the description.
          const desc = positionals(rest)[0];
          if (!desc) throw new Error('usage: relay task add "description" [...]');
          const role = flag(rest, "--role") ?? undefined;
          if (role && !knownRole(db, role)) {
            console.error(
              `relay: warning: task role '${role}' matches no registered worker and is not a known special role ` +
                `(worker/planner/reviewer); the task may be unclaimable until a matching worker is registered.`
            );
          }
          const t = addTask(db, {
            title: flag(rest, "--title") ?? desc.slice(0, 80),
            description: desc,
            acceptance: flag(rest, "--acceptance") ?? "",
            priority: flag(rest, "--priority") ? Number(flag(rest, "--priority")) : 0,
            role,
            parentTaskId: flag(rest, "--parent") ?? undefined,
            planId: flag(rest, "--plan") ?? undefined,
            dependsOn: flagValues(rest, "--depends-on"),
          });
          const deps = taskDependencies(db, t.id);
          console.log(`${t.id} queued priority=${t.priority}${t.plan_id ? ` plan=${t.plan_id}` : ""}${deps.length ? ` depends_on=${deps.join(",")}` : ""}`);
        } else if (sub === "intake") {
          const rest = argv.slice(2);
          const provider = flag(rest, "--provider");
          const issueId = flag(rest, "--issue");
          if (!provider || !issueId) {
            throw new Error("usage: relay task intake --provider P --issue ID [--slice S] [--title T] [--description D] [--code-change] [--pr URL] [--branch B] [--head SHA]");
          }
          const t = intakeTask(db, {
            provider,
            issueId,
            slice: flag(rest, "--slice") ?? "",
            title: flag(rest, "--title") ?? undefined,
            description: flag(rest, "--description") ?? undefined,
            acceptance: flag(rest, "--acceptance") ?? undefined,
            priority: flag(rest, "--priority") ? Number(flag(rest, "--priority")) : 0,
            role: flag(rest, "--role") ?? undefined,
            codeChange: hasFlag(rest, "--code-change"),
            parentTaskId: flag(rest, "--parent") ?? undefined,
            prUrl: flag(rest, "--pr") ?? undefined,
            branch: flag(rest, "--branch") ?? undefined,
            headSha: flag(rest, "--head") ?? undefined,
            prRepo: flag(rest, "--repo") ?? undefined,
            prBase: flag(rest, "--base") ?? undefined,
            prBaseSha: flag(rest, "--base-sha") ?? undefined,
            prDiff: flag(rest, "--diff") ?? undefined,
            checks: parseCheckFlags(flagRepeated(rest, "--check")),
            worktree: flag(rest, "--worktree") ?? undefined,
          });
          console.log(
            `${t.id} ${t.code_change === 1 ? `code-change phase=${t.phase}` : "task"} provider=${t.provider} issue=${t.issue_id} slice=${t.slice === "" ? "-" : t.slice} state=${t.state}`
          );
        } else if (sub === "list") {
          const state = flag(argv.slice(1), "--state");
          for (const t of listTasks(db, state)) {
            const deps = taskDependencies(db, t.id);
            console.log(`${t.id}\t${t.state}\tprio=${t.priority}\trole=${t.role ?? "-"}\tassignee=${t.assignee ?? "-"}\tparent=${t.parent_task_id ?? "-"}\tplan=${t.plan_id ?? "-"}\tdepends=${deps.length ? deps.join(",") : "-"}\t${t.title}`);
          }
        } else if (sub === "link") {
          const [taskId, planId] = [argv[2], argv[3]];
          if (!taskId || !planId) throw new Error("usage: relay task link <task-id> <plan-id>");
          const t = setTaskPlan(db, taskId, planId);
          console.log(`${t.id} plan=${planId}`);
        } else if (sub === "unlink") {
          const taskId = argv[2];
          if (!taskId) throw new Error("usage: relay task unlink <task-id>");
          const t = setTaskPlan(db, taskId, null);
          console.log(`${t.id} plan=-`);
        } else if (sub === "depend") {
          const taskId = argv[2];
          if (!taskId) {
            throw new Error("usage: relay task depend <task-id> <dep-id...> | --clear\n  (a gated task is not runnable until every dep-id is done)");
          }
          const rest = argv.slice(2);
          const clear = hasFlag(rest, "--clear");
          const deps = clear ? [] : positionals(rest).slice(1);
          const t = setTaskDependencies(db, taskId, deps);
          const got = taskDependencies(db, t.id);
          console.log(`${t.id} depends_on=${got.length ? got.join(",") : "-"}`);
          if (!clear && got.length === 0) {
            console.error(`relay: warning: ${t.id} has no prerequisites; it is ungated (pass --clear to be explicit)`);
          }
        } else if (sub === "reparent" || sub === "move") {
          const taskId = argv[2];
          const parentId = argv[3];
          if (!taskId) {
            throw new Error(
              `usage: relay task ${sub} <task-id> <new-parent-id> | --clear\n  ` +
              `(parents were creation-only; this fixes an orphaned subtree so child_done bubbles)`
            );
          }
          const clear = hasFlag(argv.slice(2), "--clear");
          if (!clear && !parentId) throw new Error(`usage: relay task ${sub} <task-id> <new-parent-id> | --clear`);
          const t = setTaskParent(db, taskId, clear ? null : parentId);
          console.log(`${t.id} parent=${t.parent_task_id ?? "-"}${clear ? " (unparented)" : ""}`);
          if (!clear) {
            const kids = taskChildren(db, parentId).map((k) => k.id);
            console.log(`  ${parentId} now has ${kids.length} direct child(ren): ${kids.join(",") || "-"}`);
          }
        } else if (sub === "show") {
          const id = argv[2];
          if (!id) throw new Error("usage: relay task show <id> [--json]");
          const t = getTask(db, id);
          if (!t) throw new Error(`unknown task: ${id}`);
          const notes = getNotes(db, id);
          const deps = taskDependencies(db, id);
          // ISH-1013: the latest Factory outcome (classification/evidence/next)
          // is part of the existing Task document, not a new dashboard store.
          const factory = latestFactoryOutcome(db, t.id);
          if (hasFlag(argv.slice(2), "--json")) {
            // One self-contained JSON document (task + notes + deps) for agents.
            console.log(JSON.stringify({ ...t, depends_on: deps, notes, ...(factory ? { factory } : {}) }, null, 2));
          } else {
            // stdout stays a single parseable JSON document; the human-readable
            // notes go to stderr so `relay task show <id> | jq` keeps working.
            console.log(JSON.stringify({ ...t, depends_on: deps, ...(factory ? { factory } : {}) }, null, 2));
            if (deps.length) console.error(`  depends_on: ${deps.join(", ")}`);
            for (const n of notes) {
              console.error(`  [${n.kind}] ${n.worker_id ?? "?"}: ${n.body}`);
            }
            if (factory) {
              for (const line of formatStoredFactoryOutcome(factory)) console.error(`  ${line}`);
            }
          }
        } else if (sub === "cancel") {
          // ISH-808: the explicit terminal CLOSE. Reason is required (audit),
          // and may be positional or `--reason <text>` like block/reject.
          const rest = argv.slice(2);
          const id = positionals(rest)[0];
          const usage = 'usage: relay task cancel <task-id> --reason <text> [--worker <id>]';
          if (!id) throw new Error(usage);
          const reason = resolveText(rest, usage, "--reason");
          const workerId = resolveWorkerId(db, flag(rest, "--worker"));
          const t = cancelTask(db, id, workerId, reason);
          console.log(`${t.id} -> cancelled`);
        } else {
          throw new Error(`unknown task subcommand: ${sub}`);
        }
        break;
      }

      case "next": {
        const workerId = resolveWorkerId(db, flag(argv, "--worker"));
        const t = claimNext(db, workerId, {
          role: flag(argv, "--role") ?? undefined,
          strictRole: hasFlag(argv, "--any-role") ? false : undefined,
        });
        if (!t) {
          console.log("NO_TASK");
        } else {
          console.log(`${t.id} lease=${t.lease_token} until=${t.lease_until}`);
          console.log(`title: ${t.title}`);
          if (t.description) console.log(`desc: ${t.description}`);
          if (t.acceptance) console.log(`accept: ${t.acceptance}`);
          printTaskContext(db, t.id);
        }
        break;
      }

      case "claim": {
        const id = argv[1];
        if (!id) throw new Error("usage: relay claim <task-id>");
        const workerId = resolveWorkerId(db, flag(argv, "--worker"));
        // Naming a queued reviewer GATE is a deliberate act: it opens the gate's
        // "something must be in review" churn guard (which exists to stop the
        // AUTOMATIC `relay next`/scheduler from grabbing a standing gate). Any
        // other reviewer claim is still refused inside claimTask.
        const target = getTask(db, id);
        const namedReviewerGate = !!target && target.role === "reviewer" && target.state === "queued";
        const claimed = claimTask(db, id, workerId, {
          role: flag(argv, "--role") ?? undefined,
          strictRole: hasFlag(argv, "--any-role") ? false : undefined,
          allowReviewerGate: namedReviewerGate,
        });
        console.log(`${claimed.id} lease=${claimed.lease_token}`);
        printTaskContext(db, claimed.id);
        break;
      }

      case "note": {
        const rest = argv.slice(1);
        const id = positionals(rest)[0];
        const usage = 'usage: relay note <task-id> "progress" [--worker <id>]';
        if (!id) throw new Error(usage);
        const body = resolveText(rest, usage);
        const workerId = resolveWorkerId(db, flag(argv, "--worker"));
        addNote(db, id, workerId, body);
        console.log("noted");
        break;
      }

      case "submit": {
        const id = argv[1];
        if (!id) throw new Error("usage: relay submit <task-id> --evidence ...");
        const workerId = resolveWorkerId(db, flag(argv, "--worker"));
        const evidence = flag(argv, "--evidence") ?? "";
        const leaseRaw = flag(argv, "--lease");
        const leaseToken = leaseRaw !== undefined ? Number(leaseRaw) : undefined;
        // A code-change task advances by STRUCTURED phase results; route it to
        // the workflow so `relay submit` cannot skip verify/integration.
        const target = getTask(db, id);
        if (target?.code_change === 1) {
          const t = submitPhase(db, id, workerId, {
            evidence,
            headSha: flag(argv, "--head") ?? undefined,
            leaseToken,
          });
          console.log(`${t.id} -> phase=${t.phase} state=${t.state}`);
        } else {
          const t = submitTask(db, id, workerId, { evidence, leaseToken });
          console.log(`${t.id} -> review`);
        }
        break;
      }

      case "approve": {
        const id = argv[1];
        if (!id) throw new Error("usage: relay approve <task-id>");
        const workerId = resolveWorkerId(db, flag(argv, "--worker"));
        const t = approveTask(db, id, workerId);
        console.log(`${t.id} -> done`);
        break;
      }

      case "result": {
        const sub = argv[1];
        const id = argv[2];
        const rest = argv.slice(2);
        const usage =
          "usage: relay result submit|verify|review|rebase|accept <task-id> [--pass|--fail] [--head SHA] [--worker <id>] ...";
        if (!sub || !id) throw new Error(usage);
        const workerId = resolveWorkerId(db, flag(argv, "--worker"));
        if (sub === "rebase") {
          // ISH-1122: the coordinator's merge_ready + CONFLICTING-PR route back to
          // implement at attempt+1. It is NOT a review verdict: recordReview is
          // deliberately not called, and an unresolved NG/HOLD refuses. ISH-1087:
          // this operator path auto-detects the read-only gh reader, so the shell
          // needs no RELAY_PROVIDER_GITHUB=gh; an explicit `off` still disables it.
          const t = await requestRebase(db, id, workerId, {
            reason: flag(rest, "--reason") ?? "",
            headSha: flag(rest, "--head") ?? undefined,
            deps: await operatorProviderDepsFromEnv(),
          });
          console.log(
            `${t.id} -> phase=${t.phase} state=${t.state} attempt=${t.attempt} ` +
            `(rebase requested; the prior PASS no longer authorises a merge)`
          );
        } else if (sub === "submit") {
          const t = submitPhase(db, id, workerId, {
            evidence: flag(rest, "--evidence") ?? undefined,
            headSha: flag(rest, "--head") ?? undefined,
            leaseToken: flag(rest, "--lease") !== undefined ? Number(flag(rest, "--lease")) : undefined,
          });
          console.log(`${t.id} -> phase=${t.phase} state=${t.state}`);
        } else if (sub === "verify") {
          const passed = hasFlag(rest, "--pass");
          const failed = hasFlag(rest, "--fail");
          if (passed === failed) throw new Error("relay result verify requires exactly one of --pass / --fail");
          const t = recordVerification(db, id, workerId, {
            passed,
            evidence: flag(rest, "--evidence") ?? undefined,
            headSha: flag(rest, "--head") ?? undefined,
            leaseToken: flag(rest, "--lease") !== undefined ? Number(flag(rest, "--lease")) : undefined,
          });
          console.log(`${t.id} -> phase=${t.phase} state=${t.state}`);
        } else if (sub === "review") {
          const passed = hasFlag(rest, "--pass");
          const failed = hasFlag(rest, "--fail");
          const blocked = hasFlag(rest, "--blocked");
          const chosen = [passed, failed, blocked].filter(Boolean).length;
          if (chosen !== 1) {
            throw new Error("relay result review requires exactly one of --pass / --fail / --blocked");
          }
          const supersedesRaw = flag(rest, "--supersedes");
          const t = recordReview(db, id, workerId, {
            verdict: passed ? "pass" : failed ? "fix" : "blocked",
            headSha: flag(rest, "--head") ?? undefined,
            profile: flag(rest, "--profile") ?? undefined,
            reason: flag(rest, "--reason") ?? undefined,
            evidence: flag(rest, "--evidence") ?? undefined,
            externalReviewer: flag(rest, "--reviewer") ?? undefined,
            source: flag(rest, "--source") ?? undefined,
            supersedesResultId: supersedesRaw !== undefined ? Number(supersedesRaw) : undefined,
          });
          console.log(`${t.id} -> phase=${t.phase} state=${t.state}`);
        } else if (sub === "merged") {
          const t = confirmMerged(db, id, {
            headSha: flag(rest, "--head") ?? undefined,
            repo: flag(rest, "--repo") ?? undefined,
            actor: flag(rest, "--worker") ? resolveWorkerId(db, flag(rest, "--worker")) : "cli",
            reason: flag(rest, "--reason") ?? undefined,
          });
          console.log(`${t.id} -> merged_at=${t.merged_at} phase=${t.phase} state=${t.state}`);
        } else if (sub === "accept") {
          const t = acceptTask(db, id, workerId);
          console.log(`${t.id} -> done (accepted)`);
        } else {
          throw new Error(`unknown result subcommand: ${sub}`);
        }
        break;
      }

      case "verify": {
        // ISH-759: run a task's standard commands mechanically and advance from
        // the process exit result. Normally the daemon does this automatically;
        // this entrypoint is for an explicit/manual run.
        const rest = argv.slice(1);
        const id = positionals(rest)[0];
        if (!id) throw new Error("usage: relay verify <task-id> [--cwd <dir>] [--head SHA]");
        const task = getTask(db, id);
        if (!task) throw new Error(`unknown task: ${id}`);
        const checks = taskChecks(task);
        if (checks.length === 0) throw new Error(`task ${id} has no mechanical checks (intake it with --check name=command)`);
        const explicitCwd = flag(rest, "--cwd");
        const cwd = explicitCwd ?? task.worktree ?? process.env.RELAY_VERIFY_CWD ?? process.cwd();
        const { task: after, outcome, checks: executed, stale } = await runMechanicalVerification(db, id, {
          checks,
          runner: defaultRunner,
          cwd,
          headSha: flag(rest, "--head") ?? undefined,
        });
        for (const c of executed) {
          console.log(`check ${c.name}: ${c.outcome}${c.exitCode === null ? "" : ` (exit ${c.exitCode})`}`);
        }
        console.log(`${after.id} verify=${outcome}${stale ? " stale-discarded" : ""} -> phase=${after.phase} state=${after.state}`);
        break;
      }

      case "merge-check": {
        // ISH-761: read-only, HEAD-bound merge readiness (dry-run by default).
        // This endpoint NEVER pushes, rebases or merges; it only reports the
        // structured decision. Without a point-of-use merge authority the verdict
        // is BLOCKED/NO_PERMISSION; --authority merge assumes it for the DRY-RUN
        // verdict only and performs nothing.
        const rest = argv.slice(1);
        const id = positionals(rest)[0];
        if (!id) throw new Error("usage: relay merge-check <task-id> [--json] [--authority merge]");
        const task = getTask(db, id);
        if (!task) throw new Error(`unknown task: ${id}`);
        // ISH-1087: auto-detect the read-only gh reader for the operator path so
        // `merge-check` sees the worker's PR without every shell exporting
        // RELAY_PROVIDER_GITHUB=gh. An explicit `off` still disables it.
        const base = await operatorProviderDepsFromEnv();
        const authority = flag(rest, "--authority") === "merge" ? { ...base.authority, merge: true } : base.authority;
        const repo = resolveTaskPrTarget(task)?.repo ?? null;
        const decision = await checkMergeGate(db, id, { ...base, repo, authority });
        if (!decision) throw new Error(`unknown task: ${id}`);
        console.log(hasFlag(rest, "--json") ? JSON.stringify(decision, null, 2) : formatMergeGateDecision(decision));
        break;
      }

      case "pr": {
        // ISH-880/885: READ-ONLY bind of a Task's produced commit to a real PR
        // and its current remote HEAD. Relay never writes to GitHub — the Coding
        // Agent pushes and creates/updates the PR with normal `git`/`gh` first.
        const rest = argv.slice(1);
        const sub = rest[0];
        if (sub !== "bind") throw new Error("usage: relay pr bind <task-id> [--repo R] [--json]");
        const args = rest.slice(1);
        const id = positionals(args)[0];
        if (!id) throw new Error("usage: relay pr bind <task-id> [--repo R] [--json]");
        if (!getTask(db, id)) throw new Error(`unknown task: ${id}`);
        // ISH-1087: the live operator observation was PROVIDER_UNREADABLE simply
        // because the shell had not exported RELAY_PROVIDER_GITHUB=gh. Auto-detect
        // an authenticated gh (read-only) and resolve the repo from the task
        // workspace, so the existing PR is bound instead of reported as NO_PR.
        const base = await operatorProviderDepsFromEnv();
        const result = await bindTaskPr(db, id, {
          github: base.github,
          repo: flag(args, "--repo") ?? undefined,
        });
        console.log(hasFlag(args, "--json") ? JSON.stringify(result, null, 2) : formatPrBindingResult(result));
        if (result.status === "blocked") process.exitCode = 1;
        break;
      }

      case "reject": {
        const rest = argv.slice(1);
        const id = positionals(rest)[0];
        const usage = 'usage: relay reject <task-id> "reason" | --reason <text> [--worker <id>]';
        if (!id) throw new Error(usage);
        const reason = resolveText(rest, usage, "--reason");
        const workerId = resolveWorkerId(db, flag(argv, "--worker"));
        const t = rejectTask(db, id, workerId, reason);
        console.log(`${t.id} -> queued`);
        break;
      }

      case "block": {
        const rest = argv.slice(1);
        const id = positionals(rest)[0];
        const usage = 'usage: relay block <task-id> "reason" | --reason <text> [--worker <id>] [--human]';
        if (!id) throw new Error(usage);
        const reason = resolveText(rest, usage, "--reason");
        const workerId = resolveWorkerId(db, flag(argv, "--worker"));
        const t = blockTask(db, id, workerId, reason, hasFlag(argv, "--human"));
        console.log(`${t.id} -> ${t.state}`);
        break;
      }

      case "unblock": {
        const id = argv[1];
        if (!id) throw new Error("usage: relay unblock <task-id>");
        const workerId = resolveWorkerId(db, flag(argv, "--worker"));
        const t = unblockTask(db, id, workerId);
        console.log(`${t.id} -> ${t.state}`);
        break;
      }

      case "release": {
        const id = argv[1];
        if (!id) throw new Error("usage: relay release <task-id> [--worker <id>]");
        const workerId = resolveWorkerId(db, flag(argv, "--worker"));
        const t = releaseTask(db, id, workerId);
        console.log(`${t.id} -> ${t.state} lease=${t.lease_token}`);
        break;
      }

      case "wait": {
        const id = argv[1];
        const durRaw = flag(argv, "--for");
        const reason = positionals(argv.slice(1))[1];
        if (!id || !durRaw || !reason) {
          throw new Error('usage: relay wait <task-id> --for <30s|2m|1h> "reason"');
        }
        const workerId = resolveWorkerId(db, flag(argv, "--worker"));
        const { until } = waitTask(db, id, workerId, parseDuration(durRaw), reason);
        console.log(`${id} quiet until ${new Date(until).toLocaleString()}`);
        console.log(`reason: ${reason}`);
        break;
      }

      case "send": {
        const recipient = argv[1];
        const payload = argv[2];
        if (!recipient) throw new Error('usage: relay send <worker-id> "message" [--task <tid>] [--kind <k>]');
        if (recipient.startsWith("-")) {
          throw new Error(
            `usage: relay send <worker-id> "message" [--task <tid>] [--kind <k>]\n` +
            `  expected the RECIPIENT first, got the flag "${recipient}" (options come after the message)`
          );
        }
        // A missing/empty body must never become a durable row. Quoting is the
        // usual culprit: `relay send w --worker w "hi"` puts "--worker" in the
        // body position and silently drops the real message, so a flag-like body
        // is refused instead of being mailed.
        if (!payload || payload.trim() === "") {
          throw new Error('relay send: refusing to send an empty message (usage: relay send <worker-id> "message")');
        }
        if (payload.startsWith("-")) {
          throw new Error(
            `relay send: refusing to send the flag-like body "${payload}" — the message is the SECOND argument, ` +
            `after the recipient (usage: relay send <worker-id> "message" [--task <tid>] [--kind <k>]). ` +
            `If you meant an option, move it after the message.`
          );
        }
        const sender = process.env.RELAY_WORKER ?? "cli";
        // `--urgent` marks genuine interrupts (kind=urgent => an immediate kind):
        // they MAY wake a busy worker. Ordinary peer mail is PULL-ONLY — it does
        // NOT wake, it surfaces at the recipient's next `relay inbox` (T329).
        const urgent = hasFlag(argv, "--urgent");
        const kind = urgent ? "urgent" : (flag(argv, "--kind") ?? undefined);
        const id = sendMessage(db, sender, recipient, payload, {
          taskId: flag(argv, "--task") ?? undefined,
          kind,
        });
        // Best-effort wake AFTER durable commit, and ONLY for actionable mail:
        // an ordinary message never interrupts the recipient mid-work.
        const existing = getWorker(db, recipient);
        const targetRow = existing ?? {
          id: recipient, role: "worker", agent_kind: "opencode", runtime_id: null, cwd: null, command: null,
          opencode_session_id: null, state: "idle" as const, current_task_id: null,
          generation: 0, last_seen_at: 0, last_progress_at: 0, nudged_at: null,
          retired_at: null, retired_reason: null,
          quiet_until: null, quiet_reason: null, quiet_task_id: null,
          tool_name: null, tool_command: null, tool_started_at: null, tool_timeout_ms: null,
          context_used_tokens: null, context_updated_at: null,
          context_rotate_requested_at: null, context_rotated_at: null,
          created_at: 0, updated_at: 0,
        };
        if (!isImmediateKind(kind)) {
          console.log(`sent msg=${id} (queued; delivered at the recipient's next idle; use --urgent to interrupt)`);
          break;
        }
        try {
          const rt = new HerdrRuntime();
          await rt.wake(targetRow, `${RELAY_TAG}A durable message arrived (id ${id}). Not urgent — finish what you are doing, then run \`relay inbox --claim\` when you reach a stopping point. It is stored and will not be lost.`);
          console.log(`sent msg=${id} (wake delivered)`);
        } catch (e) {
          console.log(`sent msg=${id} (wake failed, message remains queued: ${String(e).slice(0, 120)})`);
        }
        break;
      }

      case "inbox": {
        const workerId = resolveWorkerId(db, flag(argv, "--worker"));
        const ackId = flag(argv, "--ack");
        if (ackId !== undefined) {
          const m = ackMessage(db, Number(ackId), workerId);
          console.log(`acked #${m.id} (state=${m.state})`);
        } else if (hasFlag(argv, "--claim")) {
          const items = inboxFor(db, workerId);
          for (const m of items) {
            console.log(`#${m.id} to=${m.recipient} from=${m.sender} kind=${m.kind} task=${m.task_id ?? "-"}: ${m.payload}`);
          }
          const n = claimInbox(db, workerId);
          console.log(`acked=${n}`);
        } else {
          const items = inboxFor(db, workerId);
          if (items.length === 0) console.log("INBOX_EMPTY");
          for (const m of items) {
            console.log(`#${m.id} to=${m.recipient} from=${m.sender} kind=${m.kind} task=${m.task_id ?? "-"}: ${m.payload}`);
          }
        }
        break;
      }

      case "remind": {
        const sub = argv[1];
        if (sub === "add") {
          const rest = argv.slice(2);
          const usageLine = 'usage: relay remind add <worker-id> --every <30s|30m|1h> "message" [--kind note]';
          const workerId = positionals(rest)[0];
          if (!workerId) throw new Error(usageLine);
          const everyRaw = flag(rest, "--every");
          if (!everyRaw) throw new Error(`${usageLine}\n  --every is required (e.g. --every 30m)`);
          const everyMs = parseDuration(everyRaw);
          const message = resolveText(rest, usageLine);
          const kind = flag(rest, "--kind") ?? "note";
          const w = getWorker(db, workerId);
          if (!w) throw new Error(`${usageLine}\n  unknown worker: ${workerId} (register it first)`);
          if (w.retired_at !== null) throw new Error(`${usageLine}\n  worker ${workerId} is retired`);
          const r = addReminder(db, workerId, message, everyMs, kind);
          console.log(`reminder #${r.id} -> ${r.worker_id} every=${fmtEvery(r.every_ms)} kind=${r.kind}: ${r.message}`);
        } else if (sub === "list") {
          const rest = argv.slice(2);
          const rows = listReminders(db, { includeDisabled: hasFlag(rest, "--all") });
          if (hasFlag(rest, "--json")) {
            console.log(JSON.stringify(rows, null, 2));
          } else if (rows.length === 0) {
            console.log("no reminders");
          } else {
            for (const r of rows) {
              const last = r.last_sent_at ? `${fmtAge(now() - r.last_sent_at)} ago` : "never";
              console.log(
                `#${r.id}\t${r.worker_id}\tevery=${fmtEvery(r.every_ms)}\tkind=${r.kind}\tlast=${last}${r.enabled ? "" : "\tDISABLED"}: ${r.message}`
              );
            }
          }
        } else if (sub === "rm" || sub === "remove") {
          const idRaw = argv[2];
          if (!idRaw || !/^\d+$/.test(idRaw)) throw new Error("usage: relay remind rm <id>");
          const r = disableReminder(db, Number(idRaw));
          console.log(`disabled reminder #${r.id} (${r.worker_id}); it will not fire again`);
        } else {
          throw new Error(
            'usage: relay remind add <worker-id> --every <30s|30m|1h> "message" [--kind note]\n' +
              "       relay remind list [--json] [--all]\n" +
              "       relay remind rm <id>"
          );
        }
        break;
      }

      case "gc": {
        // Explicit, safe purge of historical rows. Dry-run by default; only
        // `--apply` deletes, and only retired workers / terminal tasks /
        // terminal runtimes / unmanaged-or-retired sessions. History
        // (events/messages/task_notes) is untouched unless --with-history.
        const rest = argv.slice(1);
        const apply = hasFlag(rest, "--apply");
        const withHistory = hasFlag(rest, "--with-history");
        const olderRaw = flag(rest, "--older-than");
        const olderThanMs = olderRaw ? parseDuration(olderRaw) : 0;
        const plan = runGc(db, { apply, withHistory, olderThanMs });
        if (hasFlag(rest, "--json")) {
          console.log(JSON.stringify(plan, null, 2));
          break;
        }
        console.log(`relay gc — ${plan.applied ? "APPLIED" : "dry-run (pass --apply to delete)"}`);
        const list = (ids: (string | number)[]) => (ids.length ? `  ${ids.join(",")}` : "");
        console.log(`workers:   ${plan.workers.length}${list(plan.workers)}`);
        console.log(`tasks:     ${plan.tasks.length}${list(plan.tasks)}`);
        console.log(`sessions:  ${plan.sessions.length}${list(plan.sessions)}`);
        console.log(`runtimes:  ${plan.runtimes.length}${list(plan.runtimes)}`);
        if (withHistory) {
          console.log(`history:   events=${plan.history.events} messages=${plan.history.messages} task_notes=${plan.history.task_notes} task_results=${plan.history.task_results}`);
        }
        console.log(`skipped:   ${plan.skipped.length}`);
        for (const s of plan.skipped) console.log(`  ${s.kind} ${s.id}: ${s.reason}`);
        if (!plan.applied) console.log("nothing was deleted (dry-run)");
        break;
      }

      case "run": {
        const sub = argv[1];
        const rest = argv.slice(2);
        const outputRoot = join(dirname(defaultDbPath()), "runs");
        if (!sub || sub === "list") {
          const limitRaw = flag(rest, "--limit");
          const runs = listRuns(db, {
            taskId: flag(rest, "--task") ?? undefined,
            limit: limitRaw ? Number(limitRaw) : undefined,
          });
          if (hasFlag(rest, "--json")) {
            console.log(JSON.stringify(runs, null, 2));
            break;
          }
          if (runs.length === 0) console.log("(no runs)");
          for (const r of runs) {
            console.log(
              `${r.id}  ${r.state.padEnd(9)}  task=${r.task_id}  phase=${r.phase}/${r.attempt}  exit=${r.exit_code ?? "-"}  pid=${r.pid ?? "-"}  ${r.cwd}`
            );
          }
          break;
        }
        if (sub === "start") {
          const id = positionals(rest)[0];
          if (!id) {
            throw new Error(
              "usage: relay run start <task-id> [--cwd DIR] [--prompt TEXT] [--permission MODE] [--timeout 30m] [--json]"
            );
          }
          const timeoutRaw = flag(rest, "--timeout");
          const handle = await startDshRun(db, {
            taskId: id,
            cwd: flag(rest, "--cwd") ?? undefined,
            prompt: flag(rest, "--prompt") ?? undefined,
            outputRoot,
            permissionMode: flag(rest, "--permission") ?? undefined,
            timeoutMs: timeoutRaw ? parseDuration(timeoutRaw) : undefined,
          });
          // ALWAYS await the Run BEFORE the DB is closed: the completion closure
          // writes the final state to SQLite, so returning early would close the
          // handle under it (RangeError) and leave the Run `running` forever.
          const r = await handle.wait();
          if (hasFlag(rest, "--json")) {
            console.log(JSON.stringify(r, null, 2));
          } else {
            console.log(`${r.id} -> state=${r.state} exit=${r.exit_code ?? "-"} pid=${r.pid ?? "-"}`);
            console.log(`output: ${r.output_dir}`);
          }
          if (r.state !== "exited") process.exitCode = 1;
          break;
        }
        if (sub === "show") {
          const id = positionals(rest)[0];
          if (!id) throw new Error("usage: relay run show <run-id> [--json]");
          const r = getRun(db, id);
          if (!r) throw new Error(`unknown run: ${id}`);
          // ISH-1008: the liveness sweep stores `cause=<CLASS>` in `error`.
          // Project it explicitly so a died Run reads the same in text and JSON.
          const failureClass = parseRunFailureClass(r.error);
          // ISH-1013: the durable Factory failure/next-action projection, when
          // this Run is the one the Factory stopped on (read-only; no new store).
          const factory = findFactoryOutcomeForRun(db, r);
          if (hasFlag(rest, "--json")) {
            const out: Record<string, unknown> = { ...r };
            if (failureClass) out.failure_class = failureClass;
            if (factory) out.factory = factory;
            console.log(JSON.stringify(out, null, 2));
            break;
          }
          for (const [k, v] of Object.entries(r)) console.log(`${k}: ${v ?? "-"}`);
          if (failureClass) console.log(`failure_class: ${failureClass}`);
          if (factory) {
            console.log("");
            for (const line of formatStoredFactoryOutcome(factory)) console.log(line);
          }
          break;
        }
        if (sub === "logs") {
          const id = positionals(rest)[0];
          if (!id) throw new Error("usage: relay run logs <run-id> [--tail N]");
          const r = getRun(db, id);
          if (!r) throw new Error(`unknown run: ${id}`);
          // ISH-1013: put the Factory classification/next action BEFORE the raw
          // logs, so a rotated/empty log still explains why the Run stopped.
          const factory = findFactoryOutcomeForRun(db, r);
          if (factory) {
            console.log(`--- factory outcome (task ${r.task_id} ${r.phase}/${r.attempt}) ---`);
            for (const line of formatStoredFactoryOutcome(factory)) console.log(line);
            console.log("");
          }
          const tailRaw = flag(rest, "--tail");
          const n = tailRaw ? Number(tailRaw) : 50;
          for (const [label, p] of [
            ["stdout", r.stdout_path],
            ["stderr", r.stderr_path],
          ] as const) {
            if (!p || !existsSync(p)) continue;
            const lines = readFileSync(p, "utf-8").split("\n");
            console.log(`--- ${label} (${p}) ---`);
            console.log(lines.slice(Math.max(0, lines.length - 1 - n)).join("\n"));
          }
          // ISH-810: the dsh `--json` execution-event chronology (sessionid /
          // status / tool_call / tool_result / text / final), the read-only Run
          // history. Read from the ORIGINAL dsh JSONL evidence, not a re-encode.
          if (r.dsh_events_path && existsSync(r.dsh_events_path)) {
            const events = readDshEvents(r.dsh_events_path);
            console.log(
              `--- dsh events (${r.dsh_events_path}; session=${r.session_id ?? "-"}) ---`
            );
            const shown = events.slice(Math.max(0, events.length - n));
            shown.forEach((e, i) => console.log(`${events.length - shown.length + i + 1}. ${formatDshEvent(e.event)}`));
            if (events.length === 0) console.log("(no dsh events)");
          }
          break;
        }
        if (sub === "cancel") {
          const id = positionals(rest)[0];
          if (!id) throw new Error("usage: relay run cancel <run-id>");
          const r = getRun(db, id);
          if (!r) throw new Error(`unknown run: ${id}`);
          if (r.state !== "running" && r.state !== "starting") {
            console.log(`${id} is ${r.state}; nothing to cancel`);
            break;
          }
          // Mark the request in the row BEFORE signalling so the process that
          // owns the Run records it as `cancelled`, not a bare signal failure.
          db.query(`UPDATE runs SET signal = 'cancelled', updated_at = ? WHERE id = ?`).run(now(), id);
          signalRunProcess(r.pid);
          console.log(`${id} cancel signalled (pid ${r.pid ?? "-"})`);
          break;
        }
        if (sub === "submit") {
          const id = positionals(rest)[0];
          if (!id) throw new Error("usage: relay run submit <run-id> [--evidence E] [--summary S]");
          const attemptRaw = flag(rest, "--attempt");
          const r = acceptRunSubmission(db, {
            runId: id,
            taskId: flag(rest, "--task") ?? undefined,
            phase: flag(rest, "--phase") ?? undefined,
            attempt: attemptRaw !== undefined ? Number(attemptRaw) : undefined,
            branch: flag(rest, "--branch") ?? undefined,
            headSha: flag(rest, "--head") ?? undefined,
            summary: flag(rest, "--summary") ?? undefined,
            evidence: flag(rest, "--evidence") ?? undefined,
          });
          const t = getTask(db, r.task_id);
          console.log(`${r.id} accepted -> task ${r.task_id} phase=${t?.phase} state=${t?.state}`);
          break;
        }
        if (sub === "worktree") {
          // ISH-760: create/select and OWN the single branch + worktree for a Task.
          const id = positionals(rest)[0];
          if (!id) throw new Error("usage: relay run worktree <task-id> [--branch B] [--base REF] [--path DIR] [--json]");
          const b = ensureTaskWorktree(db, id, {
            branch: flag(rest, "--branch") ?? undefined,
            base: flag(rest, "--base") ?? undefined,
            path: flag(rest, "--path") ?? undefined,
            onWarning: (m) => console.error(`relay: warning: ${m}`),
          });
          if (hasFlag(rest, "--json")) {
            console.log(JSON.stringify(b, null, 2));
            break;
          }
          console.log(`${id} worktree=${b.worktree} branch=${b.branch} ${b.created ? "(created)" : "(reused)"}`);
          break;
        }
        if (sub === "launch") {
          // ISH-760 lifecycle entrypoint: ensure worktree -> pin brief (task +
          // checks + prior findings) -> ONE disposable dsh Run. A duplicate
          // writer on the same worktree/branch is refused by the runner.
          const id = positionals(rest)[0];
          if (!id) throw new Error("usage: relay run launch <task-id> [--timeout 30m] [--permission MODE] [--json]");
          const timeoutRaw = flag(rest, "--timeout");
          const launched = await launchTaskRun(db, id, {
            timeoutMs: timeoutRaw ? parseDuration(timeoutRaw) : undefined,
            permissionMode: flag(rest, "--permission") ?? undefined,
            onWarning: (m) => console.error(`relay: warning: ${m}`),
          });
          const r = await launched.handle.wait();
          if (hasFlag(rest, "--json")) {
            console.log(
              JSON.stringify(
                { run: r, worktree: launched.worktree, branch: launched.branch, findings: launched.findings, warnings: launched.warnings },
                null,
                2
              )
            );
          } else {
            console.log(`${r.id} -> state=${r.state} exit=${r.exit_code ?? "-"}`);
            console.log(`worktree: ${launched.worktree} (branch ${launched.branch})`);
            console.log(
              `brief: ${launched.briefPath}${launched.findings.length ? ` (${launched.findings.length} prior finding(s))` : ""}`
            );
            console.log(`output: ${r.output_dir}`);
            console.log("note: exit 0 is NOT a submission; advance the task with `relay run submit <run-id>`");
          }
          if (r.state !== "exited") process.exitCode = 1;
          break;
        }
        if (sub === "factory") {
          // ISH-762: drive ONE Task through the whole factory — a real headless
          // dsh Run implements, Relay mechanically VERIFYs, an independent
          // headless Claude reviewer FIXes/PASSes, and PASS reaches read-only
          // MergeReady. No hand-driven TUI/pane for the coding.
          const id = positionals(rest)[0];
          if (!id) {
            throw new Error(
              "usage: relay run factory <task-id> [--max-attempts N] [--dsh BIN] [--reviewer CMD] [--model M] [--permission MODE] [--timeout 30m] [--review-worktrees DIR] [--repo DIR] [--pr-repo OWNER/NAME] [--json]"
            );
          }
          const timeoutRaw = flag(rest, "--timeout");
          const maxRaw = flag(rest, "--max-attempts");
          const repoRoot = flag(rest, "--repo") ?? projectRoot();
          // ISH-1087: the live Factory path uses the operator deps, so an
          // authenticated gh is enough to read the PR and post/read back the
          // native review. No PR = the review stage blocks (never MergeReady).
          const providers = await operatorProviderDepsFromEnv();
          const nativeReview = await factoryNativeReviewDepsFromEnv();
          const result = await runFactoryTask(db, id, {
            repo: flag(rest, "--repo") ?? undefined,
            prRepo: flag(rest, "--pr-repo") ?? undefined,
            dshBin: flag(rest, "--dsh") ?? process.env.RELAY_DSH_BIN ?? undefined,
            reviewerCommand: flag(rest, "--reviewer") ?? process.env.RELAY_REVIEW_CMD ?? undefined,
            reviewerModel: flag(rest, "--model") ?? process.env.RELAY_REVIEW_MODEL ?? DEFAULT_REVIEW_MODEL,
            timeoutMs: timeoutRaw ? parseDuration(timeoutRaw) : undefined,
            permissionMode: flag(rest, "--permission") ?? undefined,
            maxAttempts: maxRaw ? Number(maxRaw) : undefined,
            // ISH-904: surface a stale/behind base and a failed origin refresh.
            onWarning: (m) => console.error(`relay: warning: ${m}`),
            // ISH-829: the independent reviewer reads a detached read-only
            // worktree at the fixed head, outside the writer's checkout.
            reviewWorktreeRoot: flag(rest, "--review-worktrees") ?? join(repoRoot, STATE_DIR, "review-worktrees"),
            // ISH-883/1087: the Factory authorizes the reviewer's COMMENT review
            // (owner decision) and resolves the author from the gh login. An
            // explicit RELAY_GITHUB_REVIEW_WRITE=0 disables it, and the Factory
            // then refuses to reach MergeReady.
            nativeReview,
            requireNativeReview: true,
            // ISH-885: the READ-ONLY Task↔PR check. Relay re-reads the PR the
            // Coding Agent created/updated and binds its current remote HEAD;
            // Relay never writes to GitHub.
            prBinding: providers.github ? { github: providers.github } : undefined,
            // ISH-761/1087: the same read-only readers evaluate the gate, so a
            // bound PR is visible even when the caller supplied no explicit deps.
            mergeGateDeps: providers,
          });
          if (hasFlag(rest, "--json")) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`${id} factory -> ${result.outcome} (head ${result.head ?? "-"})`);
            for (const a of result.attempts) {
              console.log(
                `  attempt ${a.attempt}: run=${a.runId ?? "-"} verify=${a.verifyOutcome ?? "-"} review=${a.reviewVerdict ?? "-"} head=${a.producedHead ?? "-"}`
              );
            }
            if (result.gate) console.log(`  merge gate: ${result.gate.status} (read-only; NOT merged)`);
            if (result.reason) console.log(`  reason: ${result.reason}`);
            // ISH-1013: the same classification/next action `--json` carries.
            if (result.failure) {
              for (const line of formatFactoryFailureLines(result.failure)) console.log(`  ${line}`);
            }
          }
          if (result.outcome !== "merge_ready") process.exitCode = 1;
          break;
        }
        if (sub === "cleanup") {
          // ISH-760 safe cleanup: merged or explicit abort, no open PR, no active
          // writer, no uncommitted changes, relay-owned. Run logs are retained.
          const id = positionals(rest)[0];
          if (!id) throw new Error("usage: relay run cleanup <task-id> [--abort REASON] [--apply] [--force] [--json]");
          const abort = flag(rest, "--abort") ?? undefined;
          const apply = hasFlag(rest, "--apply");
          const plan = applyWorkspaceCleanup(db, id, {
            apply,
            force: hasFlag(rest, "--force"),
            abort,
          });
          if (hasFlag(rest, "--json")) {
            console.log(JSON.stringify(plan, null, 2));
            break;
          }
          const verdict = plan.apply ? (plan.removed ? "REMOVED" : plan.remove ? "would remove" : "skipped") : "dry-run (pass --apply)";
          console.log(`relay run cleanup ${id} — ${verdict}`);
          console.log(`  worktree: ${plan.worktree ?? "-"}  branch: ${plan.branch ?? "-"}`);
          console.log(`  retained runs (evidence): ${plan.retainedRuns}`);
          for (const reason of plan.reasons) console.log(`  skip: ${reason}`);
          break;
        }
        throw new Error(`unknown run subcommand: ${sub} (try: start|launch|worktree|cleanup|list|show|logs|cancel|submit)`);
      }

      case "status": {
        const t = now();
        const workers = listWorkers(db);
        const counts = taskCounts(db);
        const view = supervisorView(db);
        // Presentation only: annotate each worker with what it would pick up next.
        // Same policy `relay next` uses — strictly role-matched queued tasks
        // (review tasks for a reviewer), from the same ordered runnable list, so
        // the two never disagree. No scheduling behaviour changes.
        const claimable = new Map<string, Task[]>();
        // T346: only reviews a reviewer could actually take are "next" — a
        // review held by a live, working reviewer is not up for grabs, so it
        // must not be advertised (mirrors `relay next`/claimNext).
        const reviews = tasksInState(db, "review").filter((r) => !reviewHeldByLiveReviewer(db, r));
        for (const w of workers) {
          const rows = w.role === "reviewer" ? reviews : claimableRunnableTasks(db, w.id);
          // Never list the task the worker is already holding: it is not "next",
          // and calling it actionable would be wrong. (Seen on a reviewer that
          // took T136 into review and then saw "next: T136".)
          claimable.set(w.id, rows.filter((x) => x.id !== w.current_task_id));
        }
        // One "next" list may be shared by several workers of the same role
        // (e.g. two reviewers): those queued tasks are not waiting on any single
        // one of them, so say so instead of implying a specific worker is the
        // blocker. Same for a free worker and a busy one of the same role.
        const sharers = new Map<string, number>();
        for (const w of workers) {
          const ids = claimable.get(w.id)!.map((x) => x.id).join(",");
          if (!ids) continue;
          sharers.set(ids, (sharers.get(ids) ?? 0) + 1);
        }
        const nextLabel = (w: typeof workers[number]): string => {
          const rows = claimable.get(w.id)!;
          const ids = rows.map((x) => x.id).join(",");
          if (ids && (sharers.get(ids) ?? 0) > 1) return `next: ${ids} (queued, role match; any ${w.role})`;
          if (w.state === "working") return rows.length ? `next: ${truncIds(rows)} (queued, role match)` : "next: (none)";
          // idle / stalled / starting / waiting_input: this is the actionable line
          // the supervisor acts on — a free worker with role-matched work.
          return rows.length
            ? `next: ${truncIds(rows)} (runnable, role match — wake me)`
            : "next: (none)";
        };
        console.log("Workers");
        console.log("-------");
        if (workers.length === 0) console.log("(none)");
        for (const w of workers) {
          const prog = w.last_progress_at ? fmtAge(t - w.last_progress_at) : "-";
          const quiet = quietActive(w, t)
            ? `  quiet ${fmtAge((w.quiet_until ?? t) - t)}${w.quiet_reason ? `  ${w.quiet_reason}` : ""}`
            : "";
          // In-flight tool telemetry (early detection): show the running command
          // and how long it has been going, before the stall clock can see it.
          const tool = w.tool_started_at != null && w.tool_name
            ? `  tool ${w.tool_name} ${fmtAge(t - w.tool_started_at)}${w.tool_command ? `: ${truncText(w.tool_command)}` : ""}`
            : "";
          console.log(`${w.id}  ${w.state}  ${w.current_task_id ?? "-"}  last progress ${prog}${quiet}${tool}  ${nextLabel(w)}`);
        }
        console.log("");
        console.log("Tasks");
        console.log("-----");
        for (const s of ["queued", "running", "review", "blocked_internal", "blocked_human", "done", "failed", "cancelled"]) {
          console.log(`${s.padEnd(16)} ${counts[s] ?? 0}`);
        }
        const stranded = unclaimableRunnableTasks(db);
        console.log("");
        console.log("Unclaimable");
        console.log("-----------");
        if (stranded.length === 0) console.log("(none)");
        for (const t of stranded) console.log(`${t.id}  role=${t.role}  ${t.title}`);
        // Queued work that is deliberately NOT runnable yet (declared prerequisite
        // unmet, or a pre-created reviewer gate with nothing in review). Visible
        // so gated work is never mistaken for a stranded/unclaimable task.
        const gated = notYetRunnableTasks(db);
        console.log("");
        console.log("Waiting (not yet runnable)");
        console.log("--------------------------");
        if (gated.length === 0) console.log("(none)");
        for (const t of gated) {
          const deps = taskDependencies(db, t.id);
          const why =
            t.code_change === 1 && t.phase === "merge_ready"
              ? "merge_ready (awaiting TaskAccepted)"
              : deps.length
                ? `depends_on=${deps.join(",")}`
                : "reviewer gate (nothing in review)";
          console.log(`${t.id}  role=${t.role ?? "-"}  ${why}  ${t.title}`);
        }
        // A note can claim APPROVE without a transition (T151): the task then
        // looks unreviewed while the reviewer believes it is finished. Surface
        // the mismatch; `status` never mutates state.
        const approveVerdicts = notesClaimingApproval(db);
        console.log("");
        console.log("Attention");
        console.log("---------");
        if (approveVerdicts.length === 0) console.log("(none)");
        for (const { task, note } of approveVerdicts) {
          console.log(
            `${task.id}  state=${task.state}  assignee=${task.assignee ?? "-"}  ` +
              `note claims APPROVE but the task was never approved (${note.worker_id ?? "?"})`
          );
        }
        const unattached = workers.filter((w) => w.current_task_id && !isOperationalWorker(db, w));
        console.log("");
        console.log("Unattached (holding a task)");
        console.log("---------------------------");
        if (unattached.length === 0) console.log("(none)");
        for (const w of unattached) {
          console.log(`${w.id}  task=${w.current_task_id}  runtime=${w.runtime_id ?? "-"}  session=${w.opencode_session_id ?? "-"}  (no managed session: relay cannot wake it by name)`);
        }
        const unread = unreadCounts(db);
        console.log("");
        console.log("Unread mail");
        console.log("-----------");
        if (unread.length === 0) console.log("(none)");
        for (const u of unread) {
          console.log(`${u.recipient}  queued=${u.queued}  delivered=${u.delivered}`);
        }
        console.log("");
        console.log("System");
        console.log("------");
        console.log(view.status);
        // ISH-1009: surface the pre-launch disk guard with the MEASURED free
        // space (not just a sticky warning), plus the last durable refusal. A
        // failure to measure is shown as REFUSING, never as healthy.
        const disk = currentDiskStatus(db);
        console.log("");
        console.log("Disk guard");
        console.log("----------");
        for (const p of disk.probes) {
          const measured = p.error ? `probe FAILED: ${p.error}` : `${formatBytes(p.freeBytes)} free`;
          const low = disk.reason === "low_disk" && p.freeBytes !== null && p.freeBytes < disk.minFreeBytes;
          console.log(`${p.path}  ${measured} (min ${formatBytes(disk.minFreeBytes)})${low ? "  BELOW MINIMUM" : ""}`);
        }
        if (disk.reason === "probe_failed") console.log("launch guard: REFUSING — probe failed (fail closed)");
        else if (disk.reason === "low_disk") console.log(`launch guard: REFUSING — below the ${formatBytes(disk.minFreeBytes)} minimum`);
        else console.log("launch guard: OK");
        const refusal = latestLaunchRefusal(db);
        if (refusal) {
          console.log(
            `last launch refusal: ${refusal.taskId ?? "-"} ${refusal.reason} ` +
              `free=${formatBytes(refusal.freeBytes)} threshold=${formatBytes(refusal.minFreeBytes)} ` +
              `at ${new Date(refusal.at).toISOString()}` +
              `${refusal.error ? ` — ${refusal.error}` : ""}`
          );
        }
        // The daemon is a long-lived process: a rebuilt/reinstalled CLI does not
        // change it. Report the RUNNING daemon's build so a stale supervisor is
        // visible instead of silently serving old code.
        const probe = await probeSocket(defaultSockPath());
        if (probe.status === "live") {
          const build = probe.identity?.build ?? null;
          console.log(`daemon ${probe.identity?.pid ?? "?"} build ${build ?? "unknown"}`);
          const drift = daemonBuildWarning(build);
          if (drift) console.log(drift);
        } else {
          console.log(`daemon ${probe.status}`);
        }
        break;
      }

      case "cost": {
        const by = (flag(argv, "--by") ?? "worker") as UsageGroup;
        if (by !== "worker" && by !== "task" && by !== "session") {
          throw new Error(`invalid --by '${by}' (use worker, task or session)`);
        }
        const sinceRaw = flag(argv, "--since");
        const since = sinceRaw ? now() - parseDuration(sinceRaw) : undefined;
        const rows = usageReport(db, by, since);
        const totals = usageTotals(db, since);
        if (hasFlag(argv, "--json")) {
          console.log(JSON.stringify({ by, since: since ?? null, rows, totals }, null, 2));
          break;
        }
        const window = sinceRaw ? `last ${sinceRaw}` : "all time";
        console.log(`Usage by ${by} (${window})`);
        console.log("");
        if (rows.length === 0) {
          console.log("(no usage recorded yet — the plugin reports session.usage on each turn)");
          break;
        }
        const header =
          `${"KEY".padEnd(22)} ${"COST".padStart(10)} ${"INPUT".padStart(12)} ` +
          `${"OUTPUT".padStart(10)} ${"CACHE-READ".padStart(13)} ${"COMPACT".padStart(7)}`;
        console.log(header);
        console.log("-".repeat(header.length));
        for (const r of rows) {
          console.log(
            `${r.key.padEnd(22).slice(0, 22)} ${fmtCost(r.cost).padStart(10)} ${fmtInt(r.input).padStart(12)} ` +
              `${fmtInt(r.output).padStart(10)} ${fmtInt(r.cache_read).padStart(13)} ${String(r.compactions).padStart(7)}`
          );
        }
        console.log("-".repeat(header.length));
        console.log(
          `${"TOTAL".padEnd(22)} ${fmtCost(totals.cost).padStart(10)} ${fmtInt(totals.input).padStart(12)} ` +
            `${fmtInt(totals.output).padStart(10)} ${fmtInt(totals.cache_read).padStart(13)}`
        );
        break;
      }

      case "events": {
        const follow = hasFlag(argv, "--follow");
        const limit = flag(argv, "--limit") ? Number(flag(argv, "--limit")) : 50;
        if (!follow) {
          const evts = listEvents(db, { limit }).reverse();
          for (const e of evts) console.log(formatEvent(e));
        } else {
          let since = 0;
          const latest = listEvents(db, { limit: 1 });
          if (latest.length > 0) since = latest[0].id;
          console.error("[relay] following events (Ctrl-C to stop)");
          for (;;) {
            const evts = listEvents(db, { sinceId: since });
            for (const e of evts) {
              console.log(formatEvent(e));
              since = e.id;
            }
            await Bun.sleep(500);
          }
        }
        break;
      }

      case "event": {
        const sub = argv[1];
        if (sub !== "record") throw new Error("usage: relay event record --type <t> [...]");
        const rest = argv.slice(2);
        const type = flag(rest, "--type");
        if (!type) throw new Error("event record requires --type");
        const sessionId = flag(rest, "--session");
        let workerId = flag(rest, "--worker");
        const taskId = flag(rest, "--task");
        let payload: unknown = {};
        const rawPayload = flag(rest, "--payload");
        if (rawPayload) {
          try { payload = JSON.parse(rawPayload); } catch { payload = { raw: rawPayload }; }
        }
        if (!workerId && sessionId) {
          workerId = findWorkerBySession(db, sessionId)?.id;
        }
        // Debug path: same idle state machine the daemon runs, but with the
        // REAL runtime so wakes actually reach Herdr agents.
        const rt = buildRuntime();
        if (type === "session.idle" && workerId) {
          const outcome = await handleIdleSignal(db, rt, workerId);
          console.log(`idle:${outcome}`);
        } else if (type === "session.error" && workerId) {
          const err = typeof payload === "object" && payload !== null ? JSON.stringify(payload) : String(payload);
          console.log(handleErrorSignal(db, workerId, err));
          const { actions } = await reconcile(db, rt, undefined, await operatorProviderDepsFromEnv());
          console.log(`reconciled:${actions.join(",") || "noop"}`);
        } else if (type === "permission.asked" && workerId) {
          touchSeen(db, workerId);
          const w = getWorker(db, workerId)!;
          if (w.state === "working") setWorkerState(db, workerId, "waiting_input");
          logEvent(db, { source: "opencode", workerId, taskId, type, payload });
          console.log("waiting_input");
        } else if ((type === "permission.replied" || type === "tool.execute.after") && workerId) {
          // Tool activity = liveness only, NOT task progress. Explicit `note` stays strongest.
          touchSeen(db, workerId);
          logEvent(db, { source: "opencode", workerId, taskId, type, payload });
          console.log("seen");
        } else {
          touchSeenSafe(db, workerId);
          logEvent(db, { source: "opencode", workerId: workerId ?? null, taskId, type, payload });
          console.log("recorded");
        }
        break;
      }

      default:
        throw new Error(`unknown command: ${cmd}\n${usage()}`);
    }
  } finally {
    db.close();
  }
}

function touchSeenSafe(db: ReturnType<typeof openDb>, workerId: string | undefined): void {
  if (!workerId) return;
  try {
    if (getWorker(db, workerId)) touchSeen(db, workerId);
  } catch { /* ignore */ }
}

main().catch((e) => {
  console.error(`relay: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
