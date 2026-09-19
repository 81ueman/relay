#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultDbPath, initControlPlane, now, openDb } from "./db";
import { formatEvent, listEvents, logEvent } from "./events";
import { claimInbox, inboxFor, sendMessage } from "./messages";
import { runDaemon } from "./daemon";
import { handleErrorSignal, handleIdleSignal, reconcile } from "./reconciler";
import { HerdrRuntime } from "./runtime/herdr";
import { MockRuntime } from "./runtime/runtime";
import { supervisorView } from "./scheduler";
import {
  addTask, approveTask, blockTask, claimNext, claimTask, getNotes, getTask,
  listTasks, rejectTask, submitTask, taskCounts, addNote,
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

  agentctl worker register <id> --role worker [--runtime <herdr-target>] [--session <sid>]
  agentctl worker list
  agentctl worker status <id>
  agentctl worker bind <id> --session <sid>

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

  agentctl send <worker-id> "message" [--task <tid>] [--kind <k>]
  agentctl inbox [--worker <id>] [--claim]

  agentctl status
  agentctl events [--follow] [--limit N]

  # OpenCode plugin entrypoint (records an event; daemon reconciles within ~1-2s)
  agentctl event record --type <t> [--session <sid>] [--worker <id>] [--task <tid>] [--payload <json>]

Worker identity: --worker flag, $AGENTCTL_WORKER, or .agentctl/worker-id
DB: $AGENTCTL_DB or .agentctl/state.db (WAL mode)
Env: AGENTCTL_LEASE_MS AGENTCTL_STALL_MS AGENTCTL_LOW_WATER AGENTCTL_AUTO_APPROVE AGENTCTL_INTERVAL_MS
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
          const w = registerWorker(db, id, { role, runtimeId: runtimeId ?? undefined, sessionId: sessionId ?? undefined });
          setWorkerState(db, id, "idle");
          // Remember a default worker identity for this checkout.
          try { writeFileSync(join(process.cwd(), ".agentctl", "worker-id"), id); } catch { /* ignore */ }
          console.log(`registered ${w.id} role=${w.role}`);
        } else if (sub === "list") {
          for (const w of listWorkers(db)) {
            console.log(`${w.id}\t${w.role}\t${w.state}\t${w.current_task_id ?? "-"}\tsession=${w.opencode_session_id ?? "-"}`);
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
        const target = getWorker(db, recipient);
        const herdrTarget = target?.runtime_id ?? recipient;
        try {
          const rt = new HerdrRuntime();
          await rt.wake(herdrTarget, `You have a new durable message (id ${id}). Run \`agentctl inbox --claim\` to receive it.`);
          console.log(`sent msg=${id} (wake delivered)`);
        } catch (e) {
          console.log(`sent msg=${id} (wake failed, message remains queued: ${String(e).slice(0, 120)})`);
        }
        break;
      }

      case "inbox": {
        const workerId = resolveWorkerId(flag(argv, "--worker"));
        if (hasFlag(argv, "--claim")) {
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
        for (const s of ["queued", "claimed", "running", "review", "blocked_internal", "blocked_human", "done", "failed"]) {
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
        // session.idle is a trigger only: record + run the idle state machine inline
        // so single-shot environments get correct behavior even without a daemon.
        const rt = new MockRuntime(); // event path never blocks on transport
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
