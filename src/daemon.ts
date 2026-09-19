import { existsSync } from "node:fs";
import { defaultDbPath, defaultSockPath, openDb } from "./db";
import { logEvent } from "./events";
import { buildRuntime } from "./runtime/herdr";
import type { Runtime } from "./runtime/runtime";
import { reconcile } from "./reconciler";
import { startSocketServer, type SocketContext } from "./socket";

export interface DaemonOptions {
  dbPath?: string;
  sockPath?: string;
  intervalMs?: number;
  once?: boolean;
  runtime?: Runtime;
  noSocket?: boolean;
}

/**
 * Deterministic supervisor loop: 250ms ticks, reconcile at most every
 * intervalMs (default 1500ms) or immediately when woken by socket events.
 * The Unix socket also serves idle/error signals with the REAL runtime.
 */
export async function runDaemon(opts: DaemonOptions = {}): Promise<void> {
  const dbPath = opts.dbPath ?? defaultDbPath();
  if (!existsSync(dbPath)) {
    console.error(`[agentctl] DB not found at ${dbPath}. Run \`agentctl init\` first.`);
    process.exit(1);
  }
  const intervalMs = opts.intervalMs ?? Number(process.env.AGENTCTL_INTERVAL_MS ?? "1500");
  const rt = opts.runtime ?? buildRuntime();
  const sockPath = opts.sockPath ?? defaultSockPath();
  console.error(`[agentctl] daemon starting db=${dbPath} interval=${intervalMs}ms runtime=${rt.name}`);

  let stop = false;
  const onSignal = () => { stop = true; };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const ctx: SocketContext = { db: openDb(dbPath), runtime: rt, wakeReconcile: { value: true } };
  let sock: { stop: () => void; path: string } | null = null;
  if (!opts.once && !opts.noSocket) {
    try {
      sock = startSocketServer(ctx, sockPath);
      console.error(`[agentctl] socket listening at ${sock.path}`);
    } catch (e) {
      console.error(`[agentctl] socket unavailable (${String(e).slice(0, 120)}); continuing poll-only`);
    }
  }

  try {
    let lastReconcile = 0;
    for (;;) {
      const nowMs = Date.now();
      if (ctx.wakeReconcile.value || nowMs - lastReconcile >= intervalMs) {
        ctx.wakeReconcile.value = false;
        lastReconcile = nowMs;
        try {
          const { view, actions } = await reconcile(ctx.db, rt);
          if (actions.length > 0) {
            console.error(
              `[agentctl] reconcile status=${view.status} runnable=${view.runnable} working=${view.working} actions=${actions.join(",")}`
            );
          }
        } catch (e) {
          console.error(`[agentctl] reconcile error: ${String(e)}`);
          try { logEvent(ctx.db, { source: "supervisor", type: "supervisor.error", payload: { error: String(e) } }); } catch { /* ignore */ }
        }
      }
      if (opts.once || stop) break;
      await Bun.sleep(250);
    }
  } finally {
    sock?.stop();
    ctx.db.close();
  }
  console.error("[agentctl] daemon stopped");
}
