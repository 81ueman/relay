// agentctl OpenCode plugin.
//
// Verified against the installed OpenCode v2 plugin API (see the bundled
// herdr-agent-state.js integration): the default export is { id, setup(ctx) }
// with ctx.session.hook / ctx.tool.hook / ctx.event.subscribe, and subscribed
// events carry { type, data } where data.sessionID identifies the session.
//
// Design rules (do not change without updating the supervisor spec):
// - session.idle is a TRIGGER, never task completion. We forward it to the
//   deterministic supervisor (`agentctl event record`) and let SQLite decide.
// - tool.execute.after is liveness only, never progress.
// - All forwarding is best-effort and never throws into OpenCode.
// - Durable work always lives in SQLite first; this plugin only sends signals.

import { execFile } from "node:child_process";

const PLUGIN_ID = "relay.agentctl";

function agentctlBin(): string {
  return process.env.AGENTCTL_BIN ?? "agentctl";
}

/** Best-effort, non-blocking forward to the supervisor. Never throws. */
function forward(args: string[]): void {
  try {
    const child = execFile(agentctlBin(), args, { timeout: 5000 }, () => {});
    child.on("error", () => {});
    // Avoid unhandled rejection / detached handles breaking the host.
    child.unref?.();
  } catch {
    // Reporting must never break the agent session.
  }
}

function sessionIDOf(data: any): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const candidates = [data.sessionID, data.session?.id, data.info?.id, data.form?.sessionID];
  for (const c of candidates) {
    if (typeof c === "string" && c) return c;
  }
  return undefined;
}

function errorOf(data: any): string {
  try {
    const e = data?.error ?? data?.message ?? data;
    return typeof e === "string" ? e.slice(0, 500) : JSON.stringify(e).slice(0, 500);
  } catch {
    return "unknown error";
  }
}

// Event types subscribed (defensive: OpenCode may add more; unknown types are recorded, not acted on).
const IDLE_TYPES = new Set(["session.idle"]);
const ERROR_TYPES = new Set(["session.error", "session.execution.failed"]);
const PERMISSION_ASKED = new Set(["permission.asked", "form.created"]);
const PERMISSION_REPLIED = new Set(["permission.replied", "form.replied", "form.cancelled"]);

async function handleEvent(event: { type?: string; data?: any }): Promise<void> {
  const type = typeof event?.type === "string" ? event.type : "unknown";
  const data = event?.data ?? {};
  const sessionID = sessionIDOf(data);

  if (IDLE_TYPES.has(type)) {
    // Trigger only. The supervisor checks DB: current task? runnable work?
    // and wakes the worker with `agentctl next` or a continue-nudge.
    forward(["event", "record", "--type", "session.idle", ...(sessionID ? ["--session", sessionID] : [])]);
    return;
  }
  if (ERROR_TYPES.has(type)) {
    // Suspect/dead candidate: record + immediate reconcile.
    forward([
      "event", "record", "--type", "session.error",
      ...(sessionID ? ["--session", sessionID] : []),
      "--payload", JSON.stringify({ error: errorOf(data) }),
    ]);
    return;
  }
  if (type === "session.status" || type === "session.created") {
    forward(["event", "record", "--type", type, ...(sessionID ? ["--session", sessionID] : [])]);
    return;
  }
  if (PERMISSION_ASKED.has(type)) {
    // waiting_input bookkeeping only; other workers keep receiving work.
    forward(["event", "record", "--type", "permission.asked", ...(sessionID ? ["--session", sessionID] : [])]);
    return;
  }
  if (PERMISSION_REPLIED.has(type)) {
    forward(["event", "record", "--type", "permission.replied", ...(sessionID ? ["--session", sessionID] : [])]);
    return;
  }
  // Record anything else lightweight for observability; no state changes.
  if (sessionID || type.startsWith("session.") || type.startsWith("permission.") || type.startsWith("tool.")) {
    forward(["event", "record", "--type", type, ...(sessionID ? ["--session", sessionID] : [])]);
  }
}

export default {
  id: PLUGIN_ID,
  async setup(ctx: any) {
    // tool.execute.after -> progress signal is intentionally WEAK (liveness only).
    try {
      await ctx.tool.hook("execute.after", async (input: any) => {
        const sessionID = typeof input?.sessionID === "string" ? input.sessionID : sessionIDOf(input);
        forward(["event", "record", "--type", "tool.execute.after", ...(sessionID ? ["--session", sessionID] : [])]);
      });
    } catch {
      // Older hosts may lack tool hooks; the event stream still covers us.
    }

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            await handleEvent(event);
          } catch {
            // Per-event failure must not kill the stream.
          }
        }
      } catch {
        // Best-effort reporting: a dropped stream must not break the session.
      }
    })();

    return () => controller.abort();
  },
};
