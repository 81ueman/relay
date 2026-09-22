import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { listEvents } from "../src/events";
import { handleSocketMessage, type SocketContext } from "../src/socket";
import { MockRuntime } from "../src/runtime/runtime";
import { reconcile } from "../src/reconciler";
import { addNote, addTask, claimNext, getTask } from "../src/tasks";
import { attachSession, getSession } from "../src/sessions";
import { findRuntime, recordRuntime } from "../src/runtimes";
import { getWorker, registerWorker, setWorkerState } from "../src/workers";
import {
  CONTEXT_USAGE_TYPES,
  contextUsedTokens,
  tokenUsageOf,
} from "../.opencode/plugins/relay";

// Context-aware cooperative handoff.
//
// Invariants these tests protect:
//   - `session.context` is TELEMETRY: it persists the metric only (no state
//     change, no liveness touch);
//   - below the threshold nothing happens;
//   - above it the worker is asked ONCE to checkpoint, then rotated at a turn
//     boundary (or after the grace) to a fresh generation;
//   - an owned RUNNING task is requeued before the swap (never stranded) and the
//     predecessor's handoff reaches the successor's bootstrap;
//   - an adopted (relay_owned=0) lane is refused, never spawned;
//   - a stale-generation context event is fenced out;
//   - a cooldown (and a required FRESH metric) prevents a rotation storm.

const SAVED_ENV: Record<string, string | undefined> = {};
const KEYS = [
  "RELAY_DB", "RELAY_STALL_MS", "RELAY_LEASE_MS", "RELAY_LEASE_LIVENESS_GRACE_MS",
  "RELAY_WAKE_COOLDOWN_MS", "RELAY_RESTART_COOLDOWN_MS", "RELAY_RESTART_CAP",
  "RELAY_CONTEXT_ROTATE_PCT", "RELAY_CONTEXT_ROTATE_COOLDOWN_MS",
  "RELAY_CONTEXT_ROTATE_GRACE_MS", "RELAY_RUNTIME_CLEANUP_GRACE_MS",
];

let dir = "";
let db: Database;
let rt: MockRuntime;
let ctx: SocketContext;

beforeEach(() => {
  for (const k of KEYS) SAVED_ENV[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), "relay-context-rot-"));
  process.env.RELAY_DB = join(dir, "state.db");
  // Keep the stall/lease machinery out of the way: these tests exercise the
  // rotation policy, so a huge stall timeout makes a reconcile pass deterministic.
  process.env.RELAY_STALL_MS = "9999999";
  process.env.RELAY_LEASE_MS = "9999999";
  process.env.RELAY_LEASE_LIVENESS_GRACE_MS = "9999999";
  process.env.RELAY_WAKE_COOLDOWN_MS = "0";
  process.env.RELAY_RESTART_COOLDOWN_MS = "0";
  process.env.RELAY_RESTART_CAP = "100";
  process.env.RELAY_CONTEXT_ROTATE_PCT = "80";
  process.env.RELAY_CONTEXT_ROTATE_COOLDOWN_MS = "900000";
  process.env.RELAY_CONTEXT_ROTATE_GRACE_MS = "180000";
  process.env.RELAY_RUNTIME_CLEANUP_GRACE_MS = "300000";
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

function eventTypes(): string[] {
  return listEvents(db, { limit: 10000 }).map((e) => e.type);
}

/** Register a worker and bind a MANAGED relay-spawned session at `generation`. */
function seedSpawned(id: string, generation: number, state = "idle"): void {
  registerWorker(db, id, { role: "worker" });
  const token = `seed-${id}-g${generation}`;
  recordRuntime(db, {
    workerId: id,
    generation,
    runtimeId: `rt-${id}-g${generation}`,
    tabId: `tab-${id}-g${generation}`,
    state: "starting",
    relayOwned: 1,
    attachToken: token,
  });
  attachSession(db, `ses_${id}`, { workerId: id, role: "worker", generation, attachToken: token });
  db.query(`UPDATE workers SET state = ? WHERE id = ?`).run(state, id);
  rt.setAlive(id, true);
}

/** Register a worker and ADOPT an existing runtime (relay_owned=0) via a manual attach. */
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

async function sendContext(id: string, used: unknown, generation?: number): Promise<Record<string, unknown>> {
  return handleSocketMessage(
    {
      type: "session.context",
      session_id: `ses_${id}`,
      ...(generation !== undefined ? { generation } : {}),
      payload: { used_tokens: used, model: "deepseek-v4.1-flash" },
    },
    ctx
  );
}

describe("session.context is telemetry", () => {
  test("persists used_tokens/updated_at without a state or liveness change", async () => {
    seedSpawned("w1", 1);
    const before = getWorker(db, "w1")!;

    const res = await sendContext("w1", 900000);
    expect(res).toMatchObject({ ok: true });

    const w = getWorker(db, "w1")!;
    expect(w.context_used_tokens).toBe(900000);
    expect(w.context_updated_at).not.toBeNull();
    // Telemetry only: no state transition and no `touchSeen` (like tool.started).
    expect(w.state).toBe("idle");
    expect(w.last_seen_at).toBe(before.last_seen_at);
  });

  test("a non-positive value is ignored (defensive parse)", async () => {
    seedSpawned("w1", 1);
    const res = await sendContext("w1", -1);
    expect(res).toMatchObject({ ok: true, ignored: "bad-context" });
    expect(getWorker(db, "w1")!.context_used_tokens).toBeNull();
  });
});

describe("cooperative rotation policy", () => {
  test("below the threshold: no request and no rotation", async () => {
    seedSpawned("w1", 1);
    await sendContext("w1", 500000); // 50%

    await reconcile(db, rt);

    expect(getWorker(db, "w1")!.context_rotate_requested_at).toBeNull();
    expect(eventTypes()).not.toContain("worker.context_rotate_requested");
    expect(rt.starts).toHaveLength(0);
  });

  test("above the threshold: ONE checkpoint directive is delivered", async () => {
    seedSpawned("w1", 1);
    await sendContext("w1", 900000); // 90%

    await reconcile(db, rt);

    const w = getWorker(db, "w1")!;
    expect(w.context_rotate_requested_at).not.toBeNull();
    expect(eventTypes()).toContain("worker.context_rotate_requested");
    // The directive is NOT the rotation: a later pass rotates at a boundary.
    expect(rt.starts).toHaveLength(0);

    const nudge = rt.wakes.map((x) => x.text).find((t) => t.includes("CONTEXT HIGH"));
    expect(nudge).toBeDefined();
    expect(nudge).toContain("HANDOFF");
    expect(nudge).toContain("END YOUR TURN");

    const msg = db
      .query(`SELECT kind, payload FROM messages WHERE recipient = 'w1' ORDER BY id DESC LIMIT 1`)
      .get() as { kind: string; payload: string };
    expect(msg.kind).toBe("handoff");
    expect(msg.payload).toContain("CONTEXT HIGH");
  });

  test("idle worker rotates to generation+1; owned task is requeued and the handoff reaches the successor", async () => {
    seedSpawned("w1", 1);
    addTask(db, { title: "context work" });
    expect(claimNext(db, "w1")).not.toBeNull();
    addNote(db, "T1", "w1", "HANDOFF: files a.ts,b.ts; next: run tests; blockers: none");

    await sendContext("w1", 900000);
    await reconcile(db, rt); // phase 1: request
    expect(rt.starts).toHaveLength(0);

    // The worker reaches a turn boundary (a real rotation waits for this).
    setWorkerState(db, "w1", "idle");
    await reconcile(db, rt); // phase 2: rotate

    const w = getWorker(db, "w1")!;
    expect(w.generation).toBe(2);
    expect(findRuntime(db, "w1", 1)!.state).toBe("stale");
    // The old session is superseded so its events can no longer drive the worker.
    expect(getSession(db, "ses_w1")!.managed).toBe(0);
    // The running task was requeued (bumped fencing token), not stranded.
    const task = getTask(db, "T1")!;
    expect(task.state).toBe("queued");
    expect(task.assignee).toBeNull();
    expect(task.lease_token).toBeGreaterThanOrEqual(2);
    expect(w.current_task_id).toBeNull();
    expect(w.context_rotated_at).not.toBeNull();

    expect(eventTypes()).toContain("worker.context_rotate");
    expect(eventTypes()).toContain("task.requeued_context_rotate");

    const bootstrap = rt.wakes
      .map((x) => x.text)
      .find((t) => t.includes("RELAY-ATTACH") && t.includes("gen=2"));
    expect(bootstrap).toBeDefined();
    expect(bootstrap).toContain("files a.ts");
    expect(bootstrap).toContain("was requeued; re-claim it");
  });

  test("grace elapsed rotates even though a task-owning worker never reports idle", async () => {
    seedSpawned("w1", 1);
    addTask(db, { title: "long context work" });
    claimNext(db, "w1"); // state stays 'working'
    await sendContext("w1", 900000);

    const t0 = 1_000_000;
    await reconcile(db, rt, t0); // request
    expect(rt.starts).toHaveLength(0);

    // Not yet: the worker is working and the grace has not elapsed.
    await reconcile(db, rt, t0 + 1000);
    expect(rt.starts).toHaveLength(0);

    // Past the grace: rotate anyway, so a high-context worker cannot loop forever.
    await reconcile(db, rt, t0 + 180001);
    expect(rt.starts).toHaveLength(1);
    expect(getWorker(db, "w1")!.generation).toBe(2);
  });
});

describe("safety fences", () => {
  test("an adopted (relay_owned=0) worker is refused, never spawned", async () => {
    managed("w1");
    await sendContext("w1", 900000);

    await reconcile(db, rt);

    const w = getWorker(db, "w1")!;
    expect(rt.starts).toHaveLength(0);
    expect(w.generation).toBe(1);
    expect(w.context_rotate_requested_at).toBeNull();
    expect(eventTypes()).toContain("worker.context_rotate_refused");
  });

  test("a stale-generation context event is ignored (fenced)", async () => {
    seedSpawned("w1", 1);
    const res = await sendContext("w1", 900000, 0); // generation 0 != 1
    expect(res).toMatchObject({ ok: true, ignored: "stale-generation" });
    expect(getWorker(db, "w1")!.context_used_tokens).toBeNull();
  });

  test("the context cooldown prevents a rotation storm", async () => {
    seedSpawned("w1", 1);
    await sendContext("w1", 900000);
    await reconcile(db, rt); // request
    setWorkerState(db, "w1", "idle");
    await reconcile(db, rt); // rotate -> g2
    expect(rt.starts).toHaveLength(1);
    expect(getWorker(db, "w1")!.generation).toBe(2);
    const rotationsAfterFirst = eventTypes().filter((t) => t === "worker.context_rotate").length;
    expect(rotationsAfterFirst).toBe(1);

    // The fresh generation attaches and immediately reports a high context.
    const g2 = findRuntime(db, "w1", 2)!;
    const attached = await handleSocketMessage(
      { type: "session.attach", session_id: "ses_w1b", worker_id: "w1", generation: 2, token: g2.attach_token ?? undefined },
      ctx
    );
    expect(attached).toMatchObject({ ok: true, generation: 2 });
    await handleSocketMessage(
      { type: "session.context", session_id: "ses_w1b", payload: { used_tokens: 900000 } },
      ctx
    );

    await reconcile(db, rt);

    // Cooldown holds: no second rotation, no new request.
    expect(rt.starts).toHaveLength(1);
    expect(getWorker(db, "w1")!.generation).toBe(2);
    expect(getWorker(db, "w1")!.context_rotate_requested_at).toBeNull();
    expect(eventTypes().filter((t) => t === "worker.context_rotate").length).toBe(rotationsAfterFirst);
  });
});

describe("plugin context extraction", () => {
  test("tokenUsageOf finds nested assistant tokens; model id is nearby", () => {
    const data = {
      sessionID: "ses_x",
      info: {
        role: "assistant",
        modelID: "deepseek-v4.1-flash",
        tokens: { input: 900000, output: 120, reasoning: 0, cache: { read: 1000, write: 0 } },
      },
    };
    expect(tokenUsageOf(data)).toEqual({ input: 900000, cacheRead: 1000 });
    expect(contextUsedTokens(data)).toEqual({ used: 901000, model: "deepseek-v4.1-flash" });
    expect(CONTEXT_USAGE_TYPES.has("message.updated")).toBe(true);
    expect(CONTEXT_USAGE_TYPES.has("session.updated")).toBe(true);
  });

  test("the scan is defensive: no usage is undefined and malformed input never throws", () => {
    expect(tokenUsageOf({})).toBeNull();
    expect(tokenUsageOf(null)).toBeNull();
    expect(tokenUsageOf("nope")).toBeNull();
    expect(tokenUsageOf({ input: "x", cache: { read: 2 } })).toBeNull();
    expect(contextUsedTokens({ input: 0, cache: { read: 0 } })).toBeUndefined();
  });
});
