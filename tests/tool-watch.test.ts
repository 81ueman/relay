import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb, now } from "../src/db";
import { listEvents } from "../src/events";
import { handleSocketMessage, type SocketContext } from "../src/socket";
import { reconcile } from "../src/reconciler";
import { buildDashboardView } from "../src/dashboard/model";
import { renderDashboard } from "../src/dashboard/render";
import { MockRuntime } from "../src/runtime/runtime";
import { addTask, claimNext, getTask } from "../src/tasks";
import { attachSession } from "../src/sessions";
import { getWorker, registerWorker, setWorkerState, setWorkerTool } from "../src/workers";
import { toolTelemetry } from "../.opencode/plugins/relay";

// In-flight tool early detection + bounded recovery (Ctrl-B backgrounding).
//
// The invariant these tests protect: a running foreground command is visible to
// relay WHILE it runs (tool.started), surfaced early, and a genuinely overdue
// one is moved to the background exactly once so the session can continue.

const SAVED_ENV: Record<string, string | undefined> = {};
const KEYS = [
  "RELAY_DB", "RELAY_STALL_MS", "RELAY_LEASE_MS", "RELAY_LEASE_LIVENESS_GRACE_MS",
  "RELAY_WAKE_COOLDOWN_MS", "RELAY_TOOL_WARN_MS", "RELAY_TOOL_BACKGROUND_MS",
  "RELAY_TOOL_STALE_GRACE_MS", "RELAY_TOOL_MAX_MS", "RELAY_MAIL_NUDGE_MS",
];

let dir = "";
let db: Database;
let rt: MockRuntime;
let ctx: SocketContext;

beforeEach(() => {
  for (const k of KEYS) SAVED_ENV[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), "relay-tool-watch-"));
  process.env.RELAY_DB = join(dir, "state.db");
  // Keep the stall/lease machinery out of the way: these tests exercise the tool
  // watchdog, and a huge stall timeout makes the reconcile pass deterministic.
  process.env.RELAY_STALL_MS = "9999999";
  process.env.RELAY_LEASE_MS = "9999999";
  process.env.RELAY_LEASE_LIVENESS_GRACE_MS = "9999999";
  process.env.RELAY_WAKE_COOLDOWN_MS = "0";
  process.env.RELAY_TOOL_WARN_MS = "1000";
  process.env.RELAY_TOOL_BACKGROUND_MS = "2000";
  process.env.RELAY_TOOL_STALE_GRACE_MS = "500";
  db = openDb(process.env.RELAY_DB);
  rt = new MockRuntime();
  ctx = { db, runtime: rt, wakeReconcile: { value: false } };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  for (const k of KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

function managed(id: string): void {
  const runtimeId = `${id}-agent`;
  registerWorker(db, id, { role: "worker", runtimeId });
  attachSession(db, `ses_${id}`, {
    role: "worker",
    workerId: id,
    identity: { agent: runtimeId, tabId: `tab-${id}`, paneId: `pane-${id}`, workspaceId: "w-ext", agentKind: "opencode" },
  });
  rt.setAlive(id, true);
}

async function startTool(id: string, payload: Record<string, unknown>): Promise<void> {
  await handleSocketMessage(
    { type: "tool.started", session_id: `ses_${id}`, payload },
    ctx
  );
}

function toolEvents(type: string): number {
  return listEvents(db, { limit: 10000 }).filter((e) => e.type === type).length;
}

describe("in-flight tool marker", () => {
  test("tool.started records the command; tool.execute.after clears it", async () => {
    managed("w1");
    await startTool("w1", { tool: "shell", command: "bun test", timeout_ms: 600000 });
    let w = getWorker(db, "w1")!;
    expect(w.tool_name).toBe("shell");
    expect(w.tool_command).toBe("bun test");
    expect(w.tool_timeout_ms).toBe(600000);
    expect(w.tool_started_at).not.toBeNull();

    await handleSocketMessage(
      { type: "tool.execute.after", session_id: "ses_w1", payload: { tool: "shell", status: "completed" } },
      ctx
    );
    w = getWorker(db, "w1")!;
    expect(w.tool_started_at).toBeNull();
    expect(w.tool_name).toBeNull();
  });

  test("an event for an unmanaged session is ignored (no marker, no write)", async () => {
    await handleSocketMessage(
      { type: "tool.started", session_id: "ses_plain", payload: { tool: "shell", command: "ls" } },
      ctx
    );
    expect(listEvents(db, { limit: 100 }).length).toBe(0);
  });
});

describe("early surfacing", () => {
  test("worker.tool_long is logged once past the warn threshold, not again", async () => {
    managed("w1");
    await startTool("w1", { tool: "shell", command: "sleep 9999" });
    const started = getWorker(db, "w1")!.tool_started_at!;

    await reconcile(db, rt, started + 500);
    expect(toolEvents("worker.tool_long")).toBe(0);

    await reconcile(db, rt, started + 1500);
    expect(toolEvents("worker.tool_long")).toBe(1);

    await reconcile(db, rt, started + 2500);
    expect(toolEvents("worker.tool_long")).toBe(1);
  });

  test("dashboard: an OVERDUE tool is ATTENTION; a merely-running tool is WORKERS status", async () => {
    managed("w1");
    const started = now() - 5 * 60 * 1000;
    // Running past the surfacing threshold but WITHIN its own budget: this is
    // STATUS ("tool shell running"), so it lives on the WORKERS row, not ATTENTION.
    setWorkerTool(db, "w1", { name: "shell", command: "bun test --watch", timeoutMs: 10 * 60 * 1000 }, started);

    let view = buildDashboardView(db, { root: "/tmp", panes: new Map(), at: now() });
    const worker = view.workers.find((w) => w.id === "w1")!;
    expect(worker.tool?.name).toBe("shell");
    expect(worker.tool?.command).toBe("bun test --watch");
    expect(view.attention.some((a) => a.id === "w1" && a.text.includes("tool shell"))).toBe(false);
    let text = renderDashboard(view, { color: false, width: 160 });
    expect(text).toContain("tool:shell"); // status stays visible on the WORKERS row

    // Past its declared timeout: ACTIONABLE, so it rises to ATTENTION with the command.
    setWorkerTool(db, "w1", { name: "shell", command: "bun test --watch", timeoutMs: 60 * 1000 }, started);
    view = buildDashboardView(db, { root: "/tmp", panes: new Map(), at: now() });
    const att = view.attention.find((a) => a.id === "w1" && a.text.includes("tool shell"));
    expect(att).toBeDefined();
    expect(att!.text).toContain("overdue");
    expect(att!.text).toContain("bun test --watch");
  });

  test("a lost finish event is cleared once the marker is stale", async () => {
    process.env.RELAY_TOOL_MAX_MS = "5000"; // no declared timeout => fallback budget
    managed("w1");
    await startTool("w1", { tool: "shell", command: "orphaned" });
    const started = getWorker(db, "w1")!.tool_started_at!;

    await reconcile(db, rt, started + 60000);
    expect(getWorker(db, "w1")!.tool_started_at).toBeNull();
    expect(toolEvents("worker.tool_stale")).toBe(1);
  });
});

describe("bounded recovery (Ctrl-B backgrounding)", () => {
  test("an overdue tool with no declared timeout is backgrounded once and the worker is nudged to check", async () => {
    managed("w1");
    addTask(db, { title: "long build" });
    expect(claimNext(db, "w1")).not.toBeNull();
    await startTool("w1", { tool: "shell", command: "sleep 9999" });
    const started = getWorker(db, "w1")!.tool_started_at!;

    // Below the background threshold: surfaced, not acted on.
    await reconcile(db, rt, started + 1500);
    expect(rt.backgrounded).toEqual([]);

    // Past it: Ctrl-B is sent to the worker's live target.
    await reconcile(db, rt, started + 2500);
    expect(rt.backgrounded).toEqual(["w1-agent"]);
    expect(toolEvents("worker.tool_backgrounded")).toBe(1);
    const nudge = rt.wakes.map((w) => w.text).find((t) => t.includes("BACKGROUND"));
    expect(nudge).toBeDefined();
    expect(nudge).toContain("shell");
    expect(nudge).toContain("BACKGROUND");
    // The point of the nudge: the worker MUST check the command, not assume it.
    expect(nudge).toContain("CHECK IT NOW");
    expect(nudge).toContain("relay wait");

    // Idempotent: never a second Ctrl-B for the same tool run.
    await reconcile(db, rt, started + 3500);
    expect(rt.backgrounded.length).toBe(1);
  });

  test("a tool that declared its own long timeout is left alone until it is overdue", async () => {
    managed("w1");
    addTask(db, { title: "legit build" });
    claimNext(db, "w1");
    await startTool("w1", { tool: "shell", command: "cargo build", timeout_ms: 600000 });
    const started = getWorker(db, "w1")!.tool_started_at!;

    await reconcile(db, rt, started + 300000); // 5m < 10m budget
    expect(rt.backgrounded).toEqual([]);
    expect(getTask(db, "T1")!.state).toBe("running"); // untouched

    await reconcile(db, rt, started + 600000 + 600); // overdue past grace
    expect(rt.backgrounded).toEqual(["w1-agent"]);
  });

  test("RELAY_TOOL_BACKGROUND_MS=0 disables the action but keeps surfacing", async () => {
    process.env.RELAY_TOOL_BACKGROUND_MS = "0";
    managed("w1");
    await startTool("w1", { tool: "shell", command: "sleep 9999" });
    const started = getWorker(db, "w1")!.tool_started_at!;

    await reconcile(db, rt, started + 5000);
    expect(rt.backgrounded).toEqual([]);
    expect(toolEvents("worker.tool_long")).toBe(1);
    expect(getWorker(db, "w1")!.tool_started_at).not.toBeNull();
  });

  test("a worker blocked on a permission prompt is never backgrounded", async () => {
    managed("w1");
    addTask(db, { title: "needs approval" });
    claimNext(db, "w1");
    await startTool("w1", { tool: "shell", command: "cat .env" });
    const started = getWorker(db, "w1")!.tool_started_at!;
    setWorkerState(db, "w1", "waiting_input");

    await reconcile(db, rt, started + 5000);
    expect(rt.backgrounded).toEqual([]);
  });
});

describe("plugin hooks are registered per location", () => {
  test("a second location still registers its tool hooks (not only the first)", async () => {
    const mod = await import("../.opencode/plugins/relay");
    const plugin = mod.default as { setup: (ctx: any) => Promise<unknown> };
    const calls: string[] = [];

    const makeCtx = (dir: string) => ({
      location: { directory: dir },
      tool: {
        transform: async (cb: any) => cb({ add: () => {} }),
        hook: async (name: string) => {
          calls.push(`${dir}:tool.${name}`);
          return { dispose: async () => {} };
        },
      },
      session: {
        hook: async (name: string) => {
          calls.push(`${dir}:session.${name}`);
          return { dispose: async () => {} };
        },
      },
      event: { subscribe: async function* () { /* ends immediately */ } },
    });

    await plugin.setup(makeCtx("/proj/first"));
    await plugin.setup(makeCtx("/proj/second"));

    // The event subscription is server-global (registered once), but tool/session
    // hooks are location-scoped: the SECOND location must still get them, or its
    // tools are invisible to relay (no tool.started / tool.execute.after).
    for (const dir of ["/proj/first", "/proj/second"]) {
      expect(calls).toContain(`${dir}:tool.execute.before`);
      expect(calls).toContain(`${dir}:tool.execute.after`);
      expect(calls).toContain(`${dir}:session.prompt`);
    }
  });
});

describe("plugin telemetry extraction", () => {
  test("shell command + timeout, plain tools, and completion status", () => {
    expect(toolTelemetry({ tool: "shell", input: { command: "bun test", timeout: 5000 } }))
      .toEqual({ tool: "shell", command: "bun test", timeout_ms: 5000 });
    expect(toolTelemetry({ tool: "read", input: { path: "x" } })).toEqual({ tool: "read" });
    expect(toolTelemetry({ tool: "shell", status: "completed" })).toEqual({ tool: "shell", status: "completed" });
    expect(toolTelemetry({})).toEqual({});
  });

  test("an absurdly long command is truncated, never unbounded", () => {
    const long = "x".repeat(2000);
    const got = toolTelemetry({ tool: "shell", input: { command: long } }) as { command: string };
    expect(got.command.length).toBe(500);
  });
});
