#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultDbPath, initControlPlane, now, openDb } from "./db";
import { formatEvent, listEvents, logEvent } from "./events";
import { ackMessage, claimInbox, deliverMessage, getMessage, inboxFor, sendMessage } from "./messages";
import { runDaemon } from "./daemon";
import { handleErrorSignal, handleIdleSignal, reconcile } from "./reconciler";
import { buildRuntime, HerdrRuntime } from "./runtime/herdr";
import { supervisorView } from "./scheduler";
import { attachSession, detachSession, getSession, listSessions } from "./sessions";
import { listRuntimes } from "./runtimes";
import {
  addTask, approveTask, blockTask, claimNext, claimTask, getNotes, getTask,
  listTasks, rejectTask, submitTask, taskCounts, unblockTask, addNote,
} from "./tasks";
import {
  bindSession, findWorkerBySession, getWorker, listWorkers,
  registerWorker, setWorkerState, touchSeen,
} from "./workers";

function usage(): string {
  return `agentctl — lightweight supervisor for Herdr + OpenCode agents (SQLite is the source of truth)

Usage:
  agentctl init
  agentctl daemon [--once] [--interval <ms>]

  agentctl worker register <id> --role worker [--runtime <herdr-target>] [--session <sid>] [--cwd <dir>] [--command <cmd>]
  agentctl worker list
  agentctl worker status <id>
  agentctl worker bind <id> --session <sid>

  agentctl session attach --session <sid> [--role worker] [--worker <id>] [--dir <d>] [--worktree <w>] [--pane <p>] [--tab <t>]
  agentctl session detach --session <sid>
  agentctl session list
  agentctl session status --session <sid>

  agentctl runtime list [--worker <id>] [--state <state>]

  agentctl task add "description" [--title T] [--acceptance A] [--priority N] [--role R] [--parent T1]
  agentctl task list [--state <state>]
  agentctl task show <id>

  agentctl next [--worker <id>]
  agentctl claim <task-id> [--worker <id>]
  agentctl note <task-id> "progress" [--worker <id>]
  agentctl submit <task-id> --evidence "..." [--worker <id>] [--lease <token>]
  agentctl approve <task-id> [--worker <id>]
  agentctl reject <task-id> "reason" [--worker <id>]
  agentctl block <task-id> "reason" [--worker <id>] [--human]
  agentctl unblock <task-id> [--worker <id>]

  agentctl send <worker-id> "message" [--task <tid>] [--kind <k>]
  agentctl inbox [--worker <id>] [--claim] [--ack <msg-id>]

  agentctl status
  agentctl events [--follow] [--limit N]

  # Debug entrypoint (the OpenCode plugin normally talks to the daemon socket)
  agentctl event record --type <t> [--session <sid>] [--worker <id>] [--task <tid>] [--payload <json>]

Worker identity: --worker flag, $AGENTCTL_WORKER, or .agentctl/worker-id
DB: $AGENTCTL_DB or .agentctl/state.db (WAL mode)
Env: AGENTCTL_LEASE_MS AGENTCTL_STALL_MS AGENTCTL_LOW_WATER AGENTCTL_AUTO_APPROVE AGENTCTL_INTERVAL_MS
Spawn: AGENTCTL_HERDR_WORKSPACE (required to spawn; else $HERDR_WORKSPACE_ID)
Manual attach: requires a live Herdr agent (use --pane/--tab or $HERDR_PANE_ID/$HERDR_TAB_ID)
Runtime cleanup: AGENTCTL_RUNTIME_CLEANUP_GRACE_MS AGENTCTL_ATTACH_TIMEOUT_MS AGENTCTL_RESTART_COOLDOWN_MS
Herdr is required. AGENTCTL_RUNTIME=mock is test-only.
`;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function resolveWorkerId(explicit?: string): string {
  if (explicit) return explicit;
  const env = process.env.AGENTCTL_WORKER;
  if (env) return env;
  const f = join(process.cwd(), ".agentctl", "worker-id");
  if (existsSync(f)) {
    const v = readFileSync(f, "utf-8").trim();
    if (v) return v;
  }
  throw new Error("no worker identity: pass --worker <id>, set $AGENTCTL_WORKER, or run `agentctl worker register`");
}

function fmtAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(usage());
    return;
  }

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

  const db = openDb(defaultDbPath());
  try {
    switch (cmd) {
      case "worker": {
        const sub = argv[1];
        if (sub === "register") {
          const id = argv[2];
          if (!id) throw new Error("usage: agentctl worker register <id> --role worker");
          const role = flag(argv.slice(2), "--role") ?? "worker";
          const runtimeId = flag(argv.slice(2), "--runtime");
          const sessionId = flag(argv.slice(2), "--session");
          const w = registerWorker(db, id, {
            role,
            runtimeId: runtimeId ?? undefined,
            sessionId: sessionId ?? undefined,
            cwd: flag(argv.slice(2), "--cwd") ?? undefined,
            command: flag(argv.slice(2), "--command") ?? undefined,
          });
          setWorkerState(db, id, "idle");
          // Remember a default worker identity for this checkout.
          try { writeFileSync(join(process.cwd(), ".agentctl", "worker-id"), id); } catch { /* ignore */ }
          console.log(`registered ${w.id} role=${w.role}`);
        } else if (sub === "list") {
          for (const w of listWorkers(db)) {
            console.log(`${w.id}\t${w.role}\t${w.state}\tgen=${w.generation}\truntime=${w.runtime_id ?? "-"}\ttask=${w.current_task_id ?? "-"}\tsession=${w.opencode_session_id ?? "-"}`);
          }
        } else if (sub === "status") {
          const id = argv[2];
          if (!id) throw new Error("usage: agentctl worker status <id>");
          const w = getWorker(db, id);
          if (!w) throw new Error(`unknown worker: ${id}`);
          console.log(JSON.stringify(w, null, 2));
        } else if (sub === "bind") {
          const id = argv[2];
          const sessionId = flag(argv.slice(2), "--session");
          if (!id || !sessionId) throw new Error("usage: agentctl worker bind <id> --session <sid>");
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
          if (!sessionId) throw new Error("usage: agentctl session attach --session <sid> [--role R] [--worker W] [--pane P] [--tab T]");
          // Manual attach: the session must provably live inside a Herdr agent.
          // Resolve + verify BEFORE touching the DB; unverifiable => fail closed.
          const rt = buildRuntime();
          const identity = await rt.resolveIdentity({
            sessionId,
            hint: {
              paneId: flag(rest, "--pane") ?? process.env.HERDR_PANE_ID,
              tabId: flag(rest, "--tab") ?? process.env.HERDR_TAB_ID,
              workspaceId: flag(rest, "--workspace") ?? process.env.HERDR_WORKSPACE_ID,
              directory: flag(rest, "--dir") ?? undefined,
            },
          });
          const s = attachSession(db, sessionId, {
            role: flag(rest, "--role") ?? undefined,
            workerId: flag(rest, "--worker") ?? undefined,
            directory: flag(rest, "--dir") ?? undefined,
            worktree: flag(rest, "--worktree") ?? undefined,
            identity,
          });
          console.log(
            `attached ${s.session_id} worker=${s.worker_id} generation=${s.generation} agent=${identity.agent} tab=${identity.tabId} relay_owned=false`
          );
        } else if (sub === "detach") {
          const sessionId = flag(rest, "--session");
          if (!sessionId) throw new Error("usage: agentctl session detach --session <sid>");
          const s = detachSession(db, sessionId);
          console.log(s ? `detached ${s.session_id}` : "no such session (already unmanaged)");
        } else if (sub === "list") {
          for (const s of listSessions(db)) {
            console.log(`${s.session_id}\t${s.managed === 1 ? "managed" : "unmanaged"}\tworker=${s.worker_id ?? "-"}\tgen=${s.generation}`);
          }
        } else if (sub === "status") {
          const sessionId = flag(rest, "--session");
          if (!sessionId) throw new Error("usage: agentctl session status --session <sid>");
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
        if (sub !== "list") throw new Error("usage: agentctl runtime list [--worker <id>] [--state <state>]");
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
          if (!desc) throw new Error('usage: agentctl task add "description" [...]');
          const rest = argv.slice(2);
          const t = addTask(db, {
            title: flag(rest, "--title") ?? desc.slice(0, 80),
            description: desc,
            acceptance: flag(rest, "--acceptance") ?? "",
            priority: flag(rest, "--priority") ? Number(flag(rest, "--priority")) : 0,
            role: flag(rest, "--role") ?? undefined,
            parentTaskId: flag(rest, "--parent") ?? undefined,
          });
          console.log(`${t.id} queued priority=${t.priority}`);
        } else if (sub === "list") {
          const state = flag(argv.slice(1), "--state");
          for (const t of listTasks(db, state)) {
            console.log(`${t.id}\t${t.state}\tprio=${t.priority}\trole=${t.role ?? "-"}\tassignee=${t.assignee ?? "-"}\t${t.title}`);
          }
        } else if (sub === "show") {
          const id = argv[2];
          if (!id) throw new Error("usage: agentctl task show <id>");
          const t = getTask(db, id);
          if (!t) throw new Error(`unknown task: ${id}`);
          console.log(JSON.stringify(t, null, 2));
          for (const n of getNotes(db, id)) {
            console.log(`  [${n.kind}] ${n.worker_id ?? "?"}: ${n.body}`);
          }
        } else {
          throw new Error(`unknown task subcommand: ${sub}`);
        }
        break;
      }

      case "next": {
        const workerId = resolveWorkerId(flag(argv, "--worker"));
        const t = claimNext(db, workerId);
        if (!t) {
          console.log("NO_TASK");
        } else {
          console.log(`${t.id} lease=${t.lease_token} until=${t.lease_until}`);
          console.log(`title: ${t.title}`);
          if (t.description) console.log(`desc: ${t.description}`);
          if (t.acceptance) console.log(`accept: ${t.acceptance}`);
        }
        break;
      }

      case "claim": {
        const id = argv[1];
        if (!id) throw new Error("usage: agentctl claim <task-id>");
        const workerId = resolveWorkerId(flag(argv, "--worker"));
        const claimed = claimTask(db, id, workerId);
        console.log(`${claimed.id} lease=${claimed.lease_token}`);
        break;
      }

      case "note": {
        const id = argv[1];
        const body = argv[2];
        if (!id || !body) throw new Error('usage: agentctl note <task-id> "progress"');
        const workerId = resolveWorkerId(flag(argv, "--worker"));
        addNote(db, id, workerId, body);
        console.log("noted");
        break;
      }

      case "submit": {
        const id = argv[1];
        if (!id) throw new Error("usage: agentctl submit <task-id> --evidence ...");
        const workerId = resolveWorkerId(flag(argv, "--worker"));
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
        if (!id) throw new Error("usage: agentctl approve <task-id>");
        const workerId = resolveWorkerId(flag(argv, "--worker"));
        const t = approveTask(db, id, workerId);
        console.log(`${t.id} -> done`);
        break;
      }

      case "reject": {
        const id = argv[1];
        const reason = argv[2];
        if (!id || !reason) throw new Error('usage: agentctl reject <task-id> "reason"');
        const workerId = resolveWorkerId(flag(argv, "--worker"));
        const t = rejectTask(db, id, workerId, reason);
        console.log(`${t.id} -> queued`);
        break;
      }

      case "block": {
        const id = argv[1];
        const reason = argv[2];
        if (!id || !reason) throw new Error('usage: agentctl block <task-id> "reason" [--human]');
        const workerId = resolveWorkerId(flag(argv, "--worker"));
        const t = blockTask(db, id, workerId, reason, hasFlag(argv, "--human"));
        console.log(`${t.id} -> ${t.state}`);
        break;
      }

      case "unblock": {
        const id = argv[1];
        if (!id) throw new Error("usage: agentctl unblock <task-id>");
        const workerId = resolveWorkerId(flag(argv, "--worker"));
        const t = unblockTask(db, id, workerId);
        console.log(`${t.id} -> ${t.state}`);
        break;
      }

      case "send": {
        const recipient = argv[1];
        const payload = argv[2];
        if (!recipient || !payload) throw new Error('usage: agentctl send <worker-id> "message"');
        const sender = process.env.AGENTCTL_WORKER ?? "human";
        const id = sendMessage(db, sender, recipient, payload, {
          taskId: flag(argv, "--task") ?? undefined,
          kind: flag(argv, "--kind") ?? undefined,
        });
        // Best-effort wake AFTER durable commit. Failure keeps the message queued.
        // Routing lives in the adapter (worker.runtime_id); callers pass Worker rows.
        const existing = getWorker(db, recipient);
        const targetRow = existing ?? {
          id: recipient, role: "worker", runtime_id: null, cwd: null, command: null,
          opencode_session_id: null, state: "idle" as const, current_task_id: null,
          generation: 0, last_seen_at: 0, last_progress_at: 0, nudged_at: null,
          created_at: 0, updated_at: 0,
        };
        try {
          const rt = new HerdrRuntime();
          await rt.wake(targetRow, `You have a new durable message (id ${id}). Run \`agentctl inbox --claim\` to receive it.`);
          console.log(`sent msg=${id} (wake delivered)`);
        } catch (e) {
          console.log(`sent msg=${id} (wake failed, message remains queued: ${String(e).slice(0, 120)})`);
        }
        break;
      }

      case "inbox": {
        const workerId = resolveWorkerId(flag(argv, "--worker"));
        const ackId = flag(argv, "--ack");
        if (ackId !== undefined) {
          const m = ackMessage(db, Number(ackId), workerId);
          console.log(`acked #${m.id} (state=${m.state})`);
        } else if (hasFlag(argv, "--claim")) {
          const items = inboxFor(db, workerId);
          for (const m of items) {
            console.log(`#${m.id} from=${m.sender} kind=${m.kind} task=${m.task_id ?? "-"}: ${m.payload}`);
          }
          const n = claimInbox(db, workerId);
          console.log(`acked=${n}`);
        } else {
          const items = inboxFor(db, workerId);
          if (items.length === 0) console.log("INBOX_EMPTY");
          for (const m of items) {
            console.log(`#${m.id} from=${m.sender} kind=${m.kind} task=${m.task_id ?? "-"}: ${m.payload}`);
          }
        }
        break;
      }

      case "status": {
        const t = now();
        const workers = listWorkers(db);
        const counts = taskCounts(db);
        const view = supervisorView(db);
        console.log("Workers");
        console.log("-------");
        if (workers.length === 0) console.log("(none)");
        for (const w of workers) {
          const prog = w.last_progress_at ? fmtAge(t - w.last_progress_at) : "-";
          console.log(`${w.id}  ${w.state}  ${w.current_task_id ?? "-"}  last progress ${prog}`);
        }
        console.log("");
        console.log("Tasks");
        console.log("-----");
        for (const s of ["queued", "running", "review", "blocked_internal", "blocked_human", "done", "failed"]) {
          console.log(`${s.padEnd(16)} ${counts[s] ?? 0}`);
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
          console.error("[agentctl] following events (Ctrl-C to stop)");
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
        if (sub !== "record") throw new Error("usage: agentctl event record --type <t> [...]");
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
  console.error(`agentctl: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
