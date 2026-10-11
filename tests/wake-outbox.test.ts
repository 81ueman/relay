import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { MockRuntime, type HerdrIdentity } from "../src/runtime/runtime";
import { attachSession } from "../src/sessions";
import { handleSocketMessage, type SocketContext } from "../src/socket";
import { registerWorker } from "../src/workers";
import { awaitWake, clearWake, enqueueWake, pendingWake, takeWake, wakeWorker } from "../src/wake-outbox";

// T-WAKE-OUTBOX: plugin-woken harnesses (dsh) PULL their nudge from a durable
// queue instead of receiving a Herdr-pane keystroke.

const DSH_SESSION = "session-23274032-a2fc-4be5-9803-07cfeea34058";
const dshIdentity: HerdrIdentity = {
  agent: "dsh", tabId: "w6D:t9", paneId: "w6D:p9", workspaceId: "w6D", agentKind: "dsh",
};

let dir = "";
let db: Database;
let rt: MockRuntime;
let ctx: SocketContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-wake-"));
  db = openDb(join(dir, "state.db"));
  rt = new MockRuntime();
  ctx = { db, runtime: rt, wakeReconcile: { value: false } };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("wake outbox: enqueue/take", () => {
  test("take returns the queued nudge and clears it (delivered exactly once)", () => {
    enqueueWake(db, "w1", "continue T1", "idle-premature");
    const w = takeWake(db, "w1")!;
    expect(w.text).toBe("continue T1");
    expect(w.reason).toBe("idle-premature");
    expect(takeWake(db, "w1")).toBeNull();
    expect(pendingWake(db, "w1")).toBeNull();
  });

  test("the newest nudge REPLACES the old one (stale instruction never delivered)", () => {
    enqueueWake(db, "w1", "old nudge");
    enqueueWake(db, "w1", "new nudge");
    expect(takeWake(db, "w1")!.text).toBe("new nudge");
  });

  test("clearWake drops a pending nudge", () => {
    enqueueWake(db, "w1", "x");
    clearWake(db, "w1");
    expect(takeWake(db, "w1")).toBeNull();
  });
});

describe("awaitWake long-poll", () => {
  test("returns immediately when a nudge is already queued", async () => {
    enqueueWake(db, "w1", "ready");
    const w = await awaitWake(db, "w1", 5000);
    expect(w!.text).toBe("ready");
  });

  test("times out with null when nothing arrives", async () => {
    const w = await awaitWake(db, "w1", 120);
    expect(w).toBeNull();
  });

  test("picks up a nudge enqueued DURING the wait (cross-process write)", async () => {
    const started = Date.now();
    const p = awaitWake(db, "w1", 3000);
    setTimeout(() => enqueueWake(db, "w1", "late nudge"), 60);
    const w = await p;
    expect(w!.text).toBe("late nudge");
    expect(Date.now() - started).toBeLessThan(2500);
  });
});

describe("wakeWorker routes by harness", () => {
  test("a dsh worker is queued, never typed into a pane", async () => {
    const w = registerWorker(db, "dsh-1", { role: "worker", agentKind: "dsh" });
    await wakeWorker(rt, db, w, "continue T1", "idle-premature");
    expect(rt.wakes).toHaveLength(0);
    expect(takeWake(db, "dsh-1")!.text).toBe("continue T1");
  });

  test("an opencode worker is woken through the runtime (Herdr pane)", async () => {
    const w = registerWorker(db, "oc-1", { role: "worker", agentKind: "opencode" });
    await wakeWorker(rt, db, w, "continue T1", "idle-premature");
    expect(rt.wakes.map((x) => x.workerId)).toEqual(["oc-1"]);
    expect(pendingWake(db, "oc-1")).toBeNull();
  });
});

describe("socket worker.wake.await", () => {
  test("an attached dsh session can pull its queued nudge, then waits", async () => {
    registerWorker(db, "dsh-1", { role: "worker", agentKind: "dsh" });
    attachSession(db, DSH_SESSION, { role: "worker", workerId: "dsh-1", agentKind: "dsh", identity: dshIdentity });
    enqueueWake(db, "dsh-1", "do the thing", "wake");
    const res = await handleSocketMessage({ type: "worker.wake.await", session_id: DSH_SESSION, wait_ms: 0 }, ctx);
    expect(res).toMatchObject({ ok: true, wake: { text: "do the thing" } });
    // Drained: a second immediate poll finds nothing.
    const res2 = await handleSocketMessage({ type: "worker.wake.await", session_id: DSH_SESSION, wait_ms: 0 }, ctx);
    expect(res2).toMatchObject({ ok: true, wake: null });
  });

  test("an unknown worker is not an error — the plugin just keeps polling", async () => {
    const res = await handleSocketMessage({ type: "worker.wake.await", worker_id: "ghost", wait_ms: 0 }, ctx);
    expect(res).toMatchObject({ ok: true, wake: null });
  });

  test("an unattached session still HOLDS the poll window (never hot-loops the client)", async () => {
    const started = Date.now();
    const res = await handleSocketMessage(
      { type: "worker.wake.await", session_id: DSH_SESSION, wait_ms: 150 },
      ctx
    );
    expect(res).toMatchObject({ ok: true, wake: null });
    expect(Date.now() - started).toBeGreaterThanOrEqual(120);
  });
});
