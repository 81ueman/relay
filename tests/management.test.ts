import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { handleSocketMessage, type SocketContext } from "../src/socket";
import { MockRuntime, type HerdrIdentity } from "../src/runtime/runtime";
import { reconcile } from "../src/reconciler";
import { idleWorkers } from "../src/scheduler";
import { getSession } from "../src/sessions";
import { findRuntime, listRuntimes, recordRuntime } from "../src/runtimes";
import { addTask, claimNext, getTask, submitTask } from "../src/tasks";
import { getWorker, registerWorker } from "../src/workers";

// State-machine correctness for the edges of detach / permission / attach.
//   - detach really ends Relay management (no wake, no restart, no stall watch)
//   - permission.replied releases waiting_input
//   - the relay-spawn attach token is fail-closed
//   - manual attach is idempotent and cannot steal a busy/foreign worker

const IDENTITY: HerdrIdentity = {
  agent: "herdr-a",
  tabId: "w9:t2",
  paneId: "w9:p3",
  workspaceId: "w9",
  agentKind: "opencode",
};
const OTHER: HerdrIdentity = {
  agent: "herdr-b",
  tabId: "w9:t7",
  paneId: "w9:p8",
  workspaceId: "w9",
  agentKind: "opencode",
};

let dir = "";
let db: Database;
let rt: MockRuntime;
let ctx: SocketContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-management-"));
  process.env.RELAY_DB = join(dir, "state.db");
  process.env.RELAY_LEASE_MS = "120000";
  process.env.RELAY_STALL_MS = "60000";
  process.env.RELAY_WAKE_COOLDOWN_MS = "0";
  process.env.RELAY_RESTART_COOLDOWN_MS = "0";
  process.env.RELAY_ATTACH_TIMEOUT_MS = "30000";
  process.env.RELAY_RUNTIME_CLEANUP_GRACE_MS = "300000";
  delete process.env.RELAY_AUTO_APPROVE;
  db = openDb(process.env.RELAY_DB);
  rt = new MockRuntime();
  ctx = { db, runtime: rt, wakeReconcile: { value: false } };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Manual (Herdr) attach through the socket, with an injected verified identity. */
async function manualAttach(sessionId: string, identity: HerdrIdentity, workerId = "w1") {
  rt.setIdentity(sessionId, identity);
  return handleSocketMessage(
    {
      type: "session.attach",
      session_id: sessionId,
      role: "worker",
      worker_id: workerId,
      pane_id: identity.paneId,
      tab_id: identity.tabId,
      workspace_id: identity.workspaceId ?? undefined,
    },
    ctx
  );
}

async function detach(sessionId: string) {
  return handleSocketMessage({ type: "session.detach", session_id: sessionId }, ctx);
}

describe("A. a detached worker is no longer wakeable", () => {
  test("detach then queued work: no wake, no NEXT_NUDGE, not in idleWorkers()", async () => {
    await manualAttach("ses_w1", IDENTITY, "w1");
    expect((await detach("ses_w1")).ok).toBe(true);

    addTask(db, { title: "T1" });
    const { actions } = await reconcile(db, rt);

    expect(rt.wakes).toHaveLength(0);
    expect(actions.some((a) => a.startsWith("woken:"))).toBe(false);
    expect(idleWorkers(db).some((w) => w.id === "w1")).toBe(false);
  });
});

describe("B. a detached worker is not restarted", () => {
  test("Herdr agent disappears after detach: rt.start is never called", async () => {
    await manualAttach("ses_w1", IDENTITY, "w1");
    await detach("ses_w1");

    rt.setAlive("w1", false);
    rt.starts.length = 0;
    const { actions } = await reconcile(db, rt);

    expect(rt.starts).not.toContain("w1");
    expect(actions.some((a) => a === "dead:w1" || a === "restarted:w1" || a.startsWith("stalled:"))).toBe(false);
    expect(getWorker(db, "w1")!.opencode_session_id).toBeNull();
    expect(getWorker(db, "w1")!.state).not.toBe("starting");
  });
});

describe("C. detach of a task-holding worker is rejected", () => {
  test("active task => ok=false, session/binding/task all unchanged", async () => {
    await manualAttach("ses_w1", IDENTITY, "w1");
    const t = addTask(db, { title: "held" });
    claimNext(db, "w1");

    const res = await detach("ses_w1");
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toMatch(/still owns task/);

    expect(getSession(db, "ses_w1")!.managed).toBe(1);
    expect(getWorker(db, "w1")!.opencode_session_id).toBe("ses_w1");
    expect(getTask(db, t.id)!.state).toBe("running");
    expect(getTask(db, t.id)!.assignee).toBe("w1");
  });
});

describe("D. detach succeeds once the task is released", () => {
  test("submit then detach: session unmanaged, session binding cleared, not schedulable", async () => {
    await manualAttach("ses_w1", IDENTITY, "w1");
    const t = addTask(db, { title: "release me" });
    claimNext(db, "w1");
    submitTask(db, t.id, "w1", { evidence: "e" });

    const res = await detach("ses_w1");
    expect(res.ok).toBe(true);
    expect(getSession(db, "ses_w1")!.managed).toBe(0);
    expect(getSession(db, "ses_w1")!.detached_at).not.toBeNull();
    expect(getWorker(db, "w1")!.opencode_session_id).toBeNull();
    expect(idleWorkers(db).some((w) => w.id === "w1")).toBe(false);
  });
});

describe("E. permission.replied restores working", () => {
  test("working on T1 -> asked -> waiting_input -> replied -> working", async () => {
    await manualAttach("ses_w1", IDENTITY, "w1");
    const t = addTask(db, { title: "T1" });
    claimNext(db, "w1");

    await handleSocketMessage({ type: "permission.asked", session_id: "ses_w1", generation: 1 }, ctx);
    expect(getWorker(db, "w1")!.state).toBe("waiting_input");

    await handleSocketMessage({ type: "permission.replied", session_id: "ses_w1", generation: 1 }, ctx);
    expect(getWorker(db, "w1")!.state).toBe("working");
    expect(getWorker(db, "w1")!.current_task_id).toBe(t.id);
  });
});

describe("F. permission.replied without a task restores idle", () => {
  test("waiting_input with no current task -> replied -> idle", async () => {
    await manualAttach("ses_w1", IDENTITY, "w1");
    db.query(`UPDATE workers SET state = 'waiting_input' WHERE id = 'w1'`).run();

    const res = await handleSocketMessage({ type: "permission.replied", session_id: "ses_w1", generation: 1 }, ctx);
    expect(res.ok).toBe(true);
    expect(getWorker(db, "w1")!.state).toBe("idle");
  });
});

describe("G. submitting from waiting_input normalizes to idle", () => {
  test("waiting_input + running T1 -> submit -> no task, idle", async () => {
    await manualAttach("ses_w1", IDENTITY, "w1");
    const t = addTask(db, { title: "T1" });
    claimNext(db, "w1");
    db.query(`UPDATE workers SET state = 'waiting_input' WHERE id = 'w1'`).run();

    submitTask(db, t.id, "w1", { evidence: "e" });
    const w = getWorker(db, "w1")!;
    expect(w.current_task_id).toBeNull();
    expect(w.state).toBe("idle");
  });
});

describe("H. tokenless relay runtime attach is rejected", () => {
  test("relay-owned starting runtime with no recorded token => reject, no half-state", async () => {
    registerWorker(db, "w1", { role: "worker" });
    recordRuntime(db, {
      workerId: "w1",
      generation: 1,
      runtimeId: "rt-g1",
      relayOwned: 1,
      state: "starting",
      attachToken: null,
    });

    const res = await handleSocketMessage(
      { type: "session.attach", session_id: "ses_h", worker_id: "w1", generation: 1 },
      ctx
    );
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toMatch(/no attach token/);
    expect(findRuntime(db, "w1", 1)!.state).toBe("starting");
    expect(getSession(db, "ses_h")).toBeNull();
  });
});

describe("I. correct spawned attach is accepted", () => {
  test("matching token => attach succeeds, runtime active", async () => {
    registerWorker(db, "w1", { role: "worker" });
    recordRuntime(db, {
      workerId: "w1",
      generation: 1,
      runtimeId: "rt-g1",
      relayOwned: 1,
      state: "starting",
      attachToken: "secret-A",
    });

    const res = await handleSocketMessage(
      { type: "session.attach", session_id: "ses_i", worker_id: "w1", generation: 1, token: "secret-A" },
      ctx
    );
    expect(res.ok).toBe(true);
    expect(findRuntime(db, "w1", 1)!.state).toBe("active");
    expect(getSession(db, "ses_i")!.managed).toBe(1);
  });
});

describe("J. an active generation cannot be taken by another session", () => {
  test("g1 active on ses_A: ses_B with the valid token is still rejected", async () => {
    registerWorker(db, "w1", { role: "worker" });
    recordRuntime(db, {
      workerId: "w1",
      generation: 1,
      runtimeId: "rt-g1",
      relayOwned: 1,
      state: "starting",
      attachToken: "secret-A",
    });
    const a = await handleSocketMessage(
      { type: "session.attach", session_id: "ses_A", worker_id: "w1", generation: 1, token: "secret-A" },
      ctx
    );
    expect(a.ok).toBe(true);

    const b = await handleSocketMessage(
      { type: "session.attach", session_id: "ses_B", worker_id: "w1", generation: 1, token: "secret-A" },
      ctx
    );
    expect(b.ok).toBe(false);
    expect(String(b.reason)).toMatch(/already active/);
    expect(getSession(db, "ses_A")!.managed).toBe(1);
    expect(getWorker(db, "w1")!.opencode_session_id).toBe("ses_A");
    expect(findRuntime(db, "w1", 1)!.session_id).toBe("ses_A");
  });
});

describe("K. manual attach is idempotent for the same binding", () => {
  test("same session/worker/Herdr agent/tab/pane => no new generation or runtime row", async () => {
    await manualAttach("ses_k", IDENTITY, "w1");
    const before = getWorker(db, "w1")!;
    const rowsBefore = listRuntimes(db, { workerId: "w1" }).length;

    const res = await manualAttach("ses_k", IDENTITY, "w1");
    expect(res.ok).toBe(true);
    expect(res.generation).toBe(before.generation);

    const after = getWorker(db, "w1")!;
    expect(after.generation).toBe(before.generation);
    expect(after.opencode_session_id).toBe("ses_k");
    expect(listRuntimes(db, { workerId: "w1" }).length).toBe(rowsBefore);
  });
});

describe("L. manual attach to a busy worker is rejected", () => {
  test("w1 owns T1 => ses_new attach rejected; task and binding untouched", async () => {
    await manualAttach("ses_A", IDENTITY, "w1");
    const t = addTask(db, { title: "busy" });
    claimNext(db, "w1");

    const res = await manualAttach("ses_new", OTHER, "w1");
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toMatch(/busy with task/);

    expect(getTask(db, t.id)!.state).toBe("running");
    expect(getTask(db, t.id)!.assignee).toBe("w1");
    expect(getWorker(db, "w1")!.opencode_session_id).toBe("ses_A");
  });
});

describe("M. manual attach cannot steal another managed worker binding", () => {
  test("w1 managed by ses_A, idle => ses_B attach rejected", async () => {
    await manualAttach("ses_A", IDENTITY, "w1");

    const res = await manualAttach("ses_B", OTHER, "w1");
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toMatch(/already managed by ses_A/);
    expect(getWorker(db, "w1")!.opencode_session_id).toBe("ses_A");
    expect(getSession(db, "ses_A")!.managed).toBe(1);
  });
});
