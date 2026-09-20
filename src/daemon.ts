import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { defaultDbPath, defaultSockPath, openDb } from "./db";
import { logEvent } from "./events";
import { buildRuntime } from "./runtime/herdr";
import type { Runtime } from "./runtime/runtime";
import { reconcile } from "./reconciler";
import { startSocketServer, type SocketContext, type SocketHandle } from "./socket";
import {
  acquireLock,
  assertSocketFree,
  daemonIdentity,
  defaultLockPath,
  type LockHandle,
} from "./singleton";

export interface DaemonOptions {
  dbPath?: string;
  sockPath?: string;
  lockPath?: string;
  intervalMs?: number;
  once?: boolean;
  runtime?: Runtime;
  /**
   * Explicit TEST-ONLY bypass of the single-supervisor guard: no lock, no socket
   * ownership probe, no bind. Unit/integration tests inject a MockRuntime and
   * reconcile a throwaway DB directly. The production CLI never sets this.
   */
  noSocket?: boolean;
}

/**
 * Deterministic supervisor loop: 250ms ticks, reconcile at most every
 * intervalMs (default 1500ms) or immediately when woken by socket events.
 * The Unix socket also serves idle/error signals with the REAL runtime.
 *
 * Single-supervisor boundary (see `src/singleton.ts`): one control-plane DB has
 * at most one active daemon. Startup acquires a DB-keyed lock and probes the
 * socket; a live daemon is rejected, a stale socket is reclaimed, and a bind
 * failure is fatal. `--once` runs the SAME acquisition (it executes a supervisor
 * pass) but does not bind, since it never serves.
 */
export async function runDaemon(opts: DaemonOptions = {}): Promise<void> {
  const dbPath = opts.dbPath ?? defaultDbPath();
  if (!existsSync(dbPath)) {
    console.error(`[relay] DB not found at ${dbPath}. Run \`relay init\` first.`);
    process.exit(1);
  }
  const intervalMs = opts.intervalMs ?? Number(process.env.RELAY_INTERVAL_MS ?? "1500");
  const rt = opts.runtime ?? buildRuntime();
  const sockPath = opts.sockPath ?? defaultSockPath();
  const guard = !opts.noSocket;

  let lock: LockHandle | null = null;
  let sock: SocketHandle | null = null;
  let db: Database | null = null;
  let stop = false;
  const onSignal = () => { stop = true; };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    if (guard) {
      // Fail fast BEFORE any DB/runtime work: a second supervisor must never
      // reconcile. Acquire the DB-keyed lock first, then prove the socket is
      // either absent, stale (reclaimable), or ours to bind — never a live
      // daemon's (that socket is never unlinked).
      lock = acquireLock(opts.lockPath ?? defaultLockPath(dbPath));
      await assertSocketFree(sockPath, dbPath);
    }

    db = openDb(dbPath);
    const ctx: SocketContext = {
      db,
      runtime: rt,
      wakeReconcile: { value: true },
      identity: daemonIdentity(dbPath, sockPath, rt.name),
    };
    console.error(`[relay] daemon starting db=${dbPath} interval=${intervalMs}ms runtime=${rt.name}`);

    if (guard && !opts.once) {
      // Bind failure is FATAL in production: a socket-less daemon would keep
      // polling the same DB as a second supervisor and break the singleton.
      sock = startSocketServer(ctx, sockPath);
      console.error(`[relay] socket listening at ${sock.path}`);
    }

    let lastReconcile = 0;
    for (;;) {
      const nowMs = Date.now();
      if (ctx.wakeReconcile.value || nowMs - lastReconcile >= intervalMs) {
        ctx.wakeReconcile.value = false;
        lastReconcile = nowMs;
        try {
          const { view, actions } = await reconcile(db, rt);
          if (actions.length > 0) {
            console.error(
              `[relay] reconcile status=${view.status} runnable=${view.runnable} working=${view.working} actions=${actions.join(",")}`
            );
          }
        } catch (e) {
          console.error(`[relay] reconcile error: ${String(e)}`);
          try { logEvent(db, { source: "supervisor", type: "supervisor.error", payload: { error: String(e) } }); } catch { /* ignore */ }
        }
      }
      if (opts.once || stop) break;
      await Bun.sleep(250);
    }
  } finally {
    // Graceful shutdown: stop serving, release the lock, close the DB. The socket
    // path is removed by sock.stop() only while it is still ours.
    sock?.stop();
    lock?.release();
    db?.close();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  console.error("[relay] daemon stopped");
}
