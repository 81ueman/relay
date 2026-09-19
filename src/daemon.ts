import { existsSync } from "node:fs";
import { defaultDbPath, openDb } from "./db";
import { logEvent } from "./events";
import { HerdrRuntime } from "./runtime/herdr";
import { MockRuntime, type Runtime } from "./runtime/runtime";
import { reconcile } from "./reconciler";

export interface DaemonOptions {
  dbPath?: string;
  intervalMs?: number;
  once?: boolean;
  runtime?: Runtime;
}

function buildRuntime(): Runtime {
  if (process.env.AGENTCTL_RUNTIME === "mock") return new MockRuntime();
  if (!process.env.HERDR_SOCKET_PATH && process.env.HERDR_ENV !== "1") {
    // Outside Herdr there is nothing to wake; daemon still reconciles DB state
    // (lease expiry, resync, auto-approve) and records intended wakes.
    console.error("[agentctl] HERDR_ENV not set: using mock transport (DB-only mode)");
    return new MockRuntime();
  }
  try {
    const probe = Bun.spawnSync(["herdr", "agent", "list"]);
    if (probe.exitCode !== 0) throw new Error("herdr CLI unavailable");
    return new HerdrRuntime();
  } catch {
    console.error("[agentctl] herdr CLI unavailable: using mock transport (DB-only mode)");
    return new MockRuntime();
  }
}

/** Deterministic supervisor loop: poll + event-driven wake-ups via plugin `event record`. */
export async function runDaemon(opts: DaemonOptions = {}): Promise<void> {
  const dbPath = opts.dbPath ?? defaultDbPath();
  if (!existsSync(dbPath)) {
    console.error(`[agentctl] DB not found at ${dbPath}. Run \`agentctl init\` first.`);
    process.exit(1);
  }
  const intervalMs = opts.intervalMs ?? Number(process.env.AGENTCTL_INTERVAL_MS ?? "1500");
  const rt = opts.runtime ?? buildRuntime();
  console.error(`[agentctl] daemon starting db=${dbPath} interval=${intervalMs}ms runtime=${rt.name}`);

  let stop = false;
  const onSignal = () => { stop = true; };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  for (;;) {
    const db = openDb(dbPath);
    try {
      const { view, actions } = await reconcile(db, rt);
      if (actions.length > 0) {
        console.error(`[agentctl] reconcile status=${view.status} runnable=${view.runnable} review=${view.review} actions=${actions.join(",")}`);
      }
    } catch (e) {
      console.error(`[agentctl] reconcile error: ${String(e)}`);
      try { logEvent(db, { source: "supervisor", type: "supervisor.error", payload: { error: String(e) } }); } catch { /* ignore */ }
    } finally {
      db.close();
    }
    if (opts.once || stop) break;
    await Bun.sleep(intervalMs);
  }
  console.error("[agentctl] daemon stopped");
}
