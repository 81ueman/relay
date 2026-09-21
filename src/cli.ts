#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultDbPath, initControlPlane, now, openDb, STATE_DIR } from "./db";
import { formatEvent, listEvents, logEvent } from "./events";
import { ackMessage, claimInbox, deliverMessage, getMessage, inboxFor, RELAY_TAG, sendMessage, unreadCounts } from "./messages";
import { runDaemon } from "./daemon";
import { handleErrorSignal, handleIdleSignal, reconcile } from "./reconciler";
import { buildRuntime, HerdrRuntime } from "./runtime/herdr";
import { supervisorView, isOperationalWorker } from "./scheduler";
import { attachSession, detachSession, getSession, listSessions } from "./sessions";
import { listRuntimes } from "./runtimes";
import type { Task } from "./schema";
import {
  addTask, approveTask, blockTask, claimNext, claimTask, claimableRunnableTasks, getNotes, getTask,
  listTasks, rejectTask, releaseTask, runnableTasks, submitTask, taskCounts, unblockTask,
  unclaimableRunnableTasks, addNote, setTaskPlan, waitTask,
} from "./tasks";
import {
  bindSession, findWorkerBySession, getWorker, listWorkers,
  quietActive, registerWorker, retireWorker, setWorkerState, touchSeen, unretireWorker,
} from "./workers";
import { resolveWorkerIdentity } from "./identity";
import { runDashboard } from "./dashboard/command";

// A role is "known" if it matches a registered worker or a built-in special role.
// Used for a non-fatal warning on `task add --role`, never a rejection.
function knownRole(db: ReturnType<typeof openDb>, role: string): boolean {
  if (role === "worker" || role === "planner" || role === "reviewer") return true;
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

  relay session attach --session <sid> [--role worker] [--worker <id>] [--dir <d>] [--worktree <w>] [--pane <p>] [--tab <t>]
  relay session detach --session <sid>
  relay session list
  relay session status --session <sid>

  relay runtime list [--worker <id>] [--state <state>]

  relay task add "description" [--title T] [--acceptance A] [--priority N] [--role R] [--parent T1] [--plan <plan-id>]
  relay task link <task-id> <plan-id>
  relay task unlink <task-id>
  relay task list [--state <state>]
  relay task show <id> [--json]

  relay next [--worker <id>] [--role <r>] [--any-role]
  relay claim <task-id> [--worker <id>] [--role <r>] [--any-role]
  relay note <task-id> "progress" [--worker <id>]
  relay submit <task-id> --evidence "..." [--worker <id>] [--lease <token>]
  relay approve <task-id> [--worker <id>]
  relay reject <task-id> "reason" [--worker <id>]
  relay block <task-id> "reason" [--worker <id>] [--human]
  relay unblock <task-id> [--worker <id>]
  relay release <task-id> [--worker <id>]
  relay wait <task-id> --for <30s|2m|1h> "reason" [--worker <id>]

  relay send <worker-id> "message" [--task <tid>] [--kind <k>]
  relay inbox [--worker <id>] [--claim] [--ack <msg-id>]

  relay status
  relay dashboard [--watch] [--show [--tab]] [--hide] [--doctor] [--json] [--runtime-history]
  relay events [--follow] [--limit N]

  # Debug entrypoint (the OpenCode plugin normally talks to the daemon socket)
  relay event record --type <t> [--session <sid>] [--worker <id>] [--task <tid>] [--payload <json>]

Worker identity: --worker flag, $RELAY_WORKER, your Herdr pane, or .relay/worker-id
DB: $RELAY_DB or the nearest .relay/state.db (searched upward from cwd; WAL mode)
Env: RELAY_LEASE_MS RELAY_LEASE_LIVENESS_GRACE_MS RELAY_STALL_MS RELAY_LOW_WATER
     RELAY_AUTO_APPROVE RELAY_INTERVAL_MS RELAY_ROLE_STRICT (default true)
     RELAY_MAIL_NUDGE_MS
Spawn: RELAY_HERDR_WORKSPACE (required to spawn; else $HERDR_WORKSPACE_ID)
Manual attach: requires a live Herdr agent (use --pane/--tab or $HERDR_PANE_ID/$HERDR_TAB_ID)
Runtime cleanup: RELAY_RUNTIME_CLEANUP_GRACE_MS RELAY_ATTACH_TIMEOUT_MS RELAY_RESTART_COOLDOWN_MS
Restart cap: RELAY_RESTART_CAP (default 3) RELAY_RESTART_CAP_WINDOW_MS (default 1800000)
Herdr is required. RELAY_RUNTIME=mock is test-only.
Help: relay <command> [subcommand] --help
`;
}

// Per-command help. Keys are the command path ("task", "task add", ...).
// Longer (more specific) keys win; a group help covers its subcommands.
const COMMAND_HELP: Record<string, { about: string; usage: string[] }> = {
  init: {
    about: "Create .relay/state.db (WAL) and the control-plane schema in the current directory.",
    usage: ["relay init"],
  },
  daemon: {
    about: "Run the supervisor loop (reconcile + lease/stall handling).",
    usage: ["relay daemon [--once] [--interval <ms>]", "  --once            run a single pass, then exit", "  --interval <ms>   loop interval (default $RELAY_INTERVAL_MS)"],
  },
  worker: {
    about: "Manage worker identities (the assignees in the durable task ledger).",
    usage: [
      "relay worker register <id> [--role worker] [--runtime <herdr-target>] [--session <sid>] [--cwd <dir>] [--command <cmd>]",
      "relay worker list [--all]",
      "relay worker status <id>",
      "relay worker bind <id> --session <sid>",
      "relay worker retire <id> [--reason <text>]",
      "relay worker unretire <id>",
    ],
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
      "relay session attach --session <sid> [--role R] [--worker W] [--dir D] [--worktree W] [--pane P] [--tab T]",
      "relay session detach --session <sid>",
      "relay session list",
      "relay session status --session <sid>",
    ],
  },
  "session attach": {
    about: "Attach a session. The Herdr agent is resolved and verified BEFORE touching the DB (fail-closed).",
    usage: ["relay session attach --session <sid> [--role R] [--worker W] [--dir D] [--worktree W] [--pane P] [--tab T]"],
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
      'relay task add "description" [--title T] [--acceptance A] [--priority N] [--role R] [--parent T1] [--plan <plan-id>]',
      "relay task list [--state <state>]",
      "relay task show <id> [--json]",
      "relay task link <id> <plan-id>",
      "relay task unlink <id>",
    ],
  },
  "task add": {
    about: "Queue a new task. --parent nests it under T1; approving a child then tells the immediate parent (one-hop completion bubbling: a child_done note on the parent, children_done when all direct children are done, and a durable message to the parent's current assignee). A --role makes the task claimable only by a worker of that role by default; an unknown role warns (non-fatal), and a role no registered worker has is surfaced as Unclaimable in `relay status`. --plan <plan-id> records which agent-status plan.json item this task belongs to.",
    usage: ['relay task add "description" [--title T] [--acceptance A] [--priority N] [--role R] [--parent T1] [--plan <plan-id>]'],
  },
  "task list": { about: "List tasks (id, state, priority, role, assignee, plan, title).", usage: ["relay task list [--state <state>]"] },
  "task show": { about: "Print one task as JSON. Notes go to stderr so stdout stays parseable; --json emits ONE document with the task and its notes.", usage: ["relay task show <id> [--json]"] },
  "task link": { about: "Link a task to a plan.json item (agent-status shows the plan status from relay).", usage: ["relay task link <task-id> <plan-id>"] },
  "task unlink": { about: "Remove a task's plan linkage.", usage: ["relay task unlink <task-id>"] },
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
  reject: { about: "Reject a reviewed task (task -> queued).", usage: ['relay reject <task-id> "reason" [--worker <id>]'] },
  block: { about: "Block a task. --human marks it blocked_human (needs a person).", usage: ['relay block <task-id> "reason" [--worker <id>] [--human]'] },
  unblock: { about: "Unblock a task.", usage: ["relay unblock <task-id> [--worker <id>]"] },
  release: {
    about: "Hand a RUNNING task back to the queue cleanly (no block/reject note): clears assignee + lease, bumps the fencing token. The current assignee or any human/worker may release.",
    usage: ["relay release <task-id> [--worker <id>]"],
  },
  wait: {
    about: "Declare a BOUNDED quiet lease on a running task you own: you may be runtime-idle (session idle) until the deadline without being treated as stalled. Does not change worker/task state or ownership; cleared by note/submit/block/release/claim, and by expiry.",
    usage: ['relay wait <task-id> --for <30s|2m|1h> "reason" [--worker <id>]'],
  },
  send: { about: "Send a durable peer-to-peer message to another worker; the best-effort wake is delivered after the commit.", usage: ['relay send <worker-id> "message" [--task <tid>] [--kind <k>]'] },
  inbox: { about: "Read (and optionally claim/ack) the worker's own inbox.", usage: ["relay inbox [--worker <id>] [--claim] [--ack <msg-id>]"] },
  status: { about: "Print workers, task counts, and the supervisor view (lightweight inspection).", usage: ["relay status"] },
  dashboard: {
    about: "Read-only human dashboard: Relay task tree + workers (current runtime overlaid) + attention, with Herdr pane links. Never mutates state; --show/--hide manage only its own UI pane.",
    usage: [
      "relay dashboard",
      "relay dashboard --watch [--interval <ms>]",
      "relay dashboard --show [--pane <id>] [--direction right|down] [--tab]",
      "relay dashboard --hide",
      "relay dashboard --doctor",
      "relay dashboard --json [--runtime-history]",
    ],
  },
  events: { about: "Print recent events, or follow them (Ctrl-C to stop).", usage: ["relay events [--follow] [--limit N]"] },
  event: {
    about: "Debug entrypoint: record an event. session.idle/error drive the same state machine as the daemon.",
    usage: ["relay event record --type <t> [--session <sid>] [--worker <id>] [--task <tid>] [--payload <json>]"],
  },
};

const GROUP_COMMANDS = new Set(["worker", "session", "task", "event"]);

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

/** Notes worth surfacing when a worker picks up a task (context, not state). */
const TASK_CONTEXT_KINDS = new Set([
  "child_done",
  "children_done",
  "blocked_human",
  "blocked_internal",
  "reject",
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

/** Positional args only, skipping flags and their values (e.g. ["T12","reason"]). */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("-")) { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
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
          if (!sessionId) throw new Error("usage: relay session attach --session <sid> [--role R] [--worker W] [--dir D] [--pane P] [--tab T]");
          // Manual attach: the session must provably live inside a Herdr agent.
          // Resolve + verify BEFORE touching the DB; unverifiable => fail closed.
          // `--dir <project>` identifies the pane from the session's working
          // directory (exactly one opencode agent there); it takes precedence
          // over the caller's $HERDR_* env, which leaks the CALLER's pane when
          // attaching a session in another pane/workspace.
          const dir = flag(rest, "--dir") ?? undefined;
          const rt = buildRuntime();
          const identity = await rt.resolveIdentity({
            sessionId,
            hint: {
              paneId: flag(rest, "--pane") ?? (dir ? undefined : process.env.HERDR_PANE_ID),
              tabId: flag(rest, "--tab") ?? (dir ? undefined : process.env.HERDR_TAB_ID),
              workspaceId: flag(rest, "--workspace") ?? (dir ? undefined : process.env.HERDR_WORKSPACE_ID),
              directory: dir,
            },
          });
          const s = attachSession(db, sessionId, {
            role: flag(rest, "--role") ?? undefined,
            workerId: flag(rest, "--worker") ?? undefined,
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
          const desc = argv[2];
          if (!desc) throw new Error('usage: relay task add "description" [...]');
          const rest = argv.slice(2);
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
          });
          console.log(`${t.id} queued priority=${t.priority}${t.plan_id ? ` plan=${t.plan_id}` : ""}`);
        } else if (sub === "list") {
          const state = flag(argv.slice(1), "--state");
          for (const t of listTasks(db, state)) {
            console.log(`${t.id}\t${t.state}\tprio=${t.priority}\trole=${t.role ?? "-"}\tassignee=${t.assignee ?? "-"}\tplan=${t.plan_id ?? "-"}\t${t.title}`);
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
        } else if (sub === "show") {
          const id = argv[2];
          if (!id) throw new Error("usage: relay task show <id> [--json]");
          const t = getTask(db, id);
          if (!t) throw new Error(`unknown task: ${id}`);
          const notes = getNotes(db, id);
          if (hasFlag(argv.slice(2), "--json")) {
            // One self-contained JSON document (task + notes) for agents.
            console.log(JSON.stringify({ ...t, notes }, null, 2));
          } else {
            // stdout stays a single parseable JSON document; the human-readable
            // notes go to stderr so `relay task show <id> | jq` keeps working.
            console.log(JSON.stringify(t, null, 2));
            for (const n of notes) {
              console.error(`  [${n.kind}] ${n.worker_id ?? "?"}: ${n.body}`);
            }
          }
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
        const claimed = claimTask(db, id, workerId, {
          role: flag(argv, "--role") ?? undefined,
          strictRole: hasFlag(argv, "--any-role") ? false : undefined,
        });
        console.log(`${claimed.id} lease=${claimed.lease_token}`);
        printTaskContext(db, claimed.id);
        break;
      }

      case "note": {
        const id = argv[1];
        const body = argv[2];
        if (!id || !body) throw new Error('usage: relay note <task-id> "progress"');
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
        const t = submitTask(db, id, workerId, {
          evidence,
          leaseToken: leaseRaw !== undefined ? Number(leaseRaw) : undefined,
        });
        console.log(`${t.id} -> review`);
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

      case "reject": {
        const id = argv[1];
        const reason = argv[2];
        if (!id || !reason) throw new Error('usage: relay reject <task-id> "reason"');
        const workerId = resolveWorkerId(db, flag(argv, "--worker"));
        const t = rejectTask(db, id, workerId, reason);
        console.log(`${t.id} -> queued`);
        break;
      }

      case "block": {
        const id = argv[1];
        const reason = argv[2];
        if (!id || !reason) throw new Error('usage: relay block <task-id> "reason" [--human]');
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
        const id = sendMessage(db, sender, recipient, payload, {
          taskId: flag(argv, "--task") ?? undefined,
          kind: flag(argv, "--kind") ?? undefined,
        });
        // Best-effort wake AFTER durable commit. Failure keeps the message queued.
        // Routing lives in the adapter (worker.runtime_id); the recipient is an
        // ordinary worker id (peers message each other directly).
        const existing = getWorker(db, recipient);
        const targetRow = existing ?? {
          id: recipient, role: "worker", runtime_id: null, cwd: null, command: null,
          opencode_session_id: null, state: "idle" as const, current_task_id: null,
          generation: 0, last_seen_at: 0, last_progress_at: 0, nudged_at: null,
          retired_at: null, retired_reason: null,
          quiet_until: null, quiet_reason: null, quiet_task_id: null,
          created_at: 0, updated_at: 0,
        };
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
        const reviews = tasksInState(db, "review");
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
          console.log(`${w.id}  ${w.state}  ${w.current_task_id ?? "-"}  last progress ${prog}${quiet}  ${nextLabel(w)}`);
        }
        console.log("");
        console.log("Tasks");
        console.log("-----");
        for (const s of ["queued", "running", "review", "blocked_internal", "blocked_human", "done", "failed"]) {
          console.log(`${s.padEnd(16)} ${counts[s] ?? 0}`);
        }
        const stranded = unclaimableRunnableTasks(db);
        console.log("");
        console.log("Unclaimable");
        console.log("-----------");
        if (stranded.length === 0) console.log("(none)");
        for (const t of stranded) console.log(`${t.id}  role=${t.role}  ${t.title}`);
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
          const { actions } = await reconcile(db, rt);
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
