import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { listEvents } from "../src/events";
import { handleSocketMessage, type SocketContext } from "../src/socket";
import { MockRuntime } from "../src/runtime/runtime";
import { supervisorView } from "../src/scheduler";
import { attachSession, detachSession, getSession } from "../src/sessions";
import { addTask, blockTask, claimNext, getTask } from "../src/tasks";
import { getWorker, registerWorker } from "../src/workers";

// Correctness contract for the relay control plane (spec section 11).

// Minimal verified Herdr identity for manual-attach tests (production resolves
// this from Herdr directly; tests inject it).
const IDENTITY = { agent: "herdr-agent", tabId: "tab-ext", paneId: "pane-ext", workspaceId: "w-ext", agentKind: "opencode" };

let dir = "";
let db: Database;
let rt: MockRuntime;
let ctx: SocketContext;

function eventCount(): number {
  return listEvents(db, { limit: 10000 }).length;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentctl-contract-"));
  process.env.AGENTCTL_DB = join(dir, "state.db");
  process.env.AGENTCTL_LEASE_MS = "120000";
  process.env.AGENTCTL_STALL_MS = "60000";
  process.env.AGENTCTL_WAKE_COOLDOWN_MS = "0";
  delete process.env.AGENTCTL_AUTO_APPROVE;
  db = openDb(process.env.AGENTCTL_DB);
  rt = new MockRuntime();
  ctx = { db, runtime: rt, wakeReconcile: { value: false } };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Register a worker and attach a managed session. Only managed workers are
 * schedulable: `idleWorkers()` ignores a plain registered worker.
 */
function idleWorker(id: string, role = "worker", extra: Record<string, unknown> = {}): void {
  const runtimeId = (extra.runtimeId as string | undefined) ?? `${id}-agent`;
  registerWorker(db, id, { role, runtimeId });
  attachSession(db, `ses_${id}`, {
    role,
    workerId: id,
    identity: { agent: runtimeId, tabId: `tab-${id}`, paneId: `pane-${id}`, workspaceId: "w-ext", agentKind: "opencode" },
  });
  rt.setAlive(id, true);
}

describe("A. idle workers + queued task", () => {
  test("w1 idle, w2 idle, T1 queued => one worker receives NEXT_NUDGE", async () => {
    idleWorker("w1");
    idleWorker("w2");
    addTask(db, { title: "T1" });
    addTask(db, { title: "T2" });
    addTask(db, { title: "T3" });
    const { reconcile } = await import("../src/reconciler");
    const { view, actions } = await reconcile(db, rt);
    expect(view.working).toBe(0);
    expect(actions.some((a) => a.startsWith("woken:"))).toBe(true);
    expect(rt.wakes.length).toBe(1);
    expect(rt.wakes[0].text).toMatch(/agentctl next/);
    // DB unchanged by the wake itself: task still queued, worker still idle.
    expect(getTask(db, "T1")!.state).toBe("queued");
    expect(getWorker(db, rt.wakes[0].workerId)!.state).toBe("idle");
  });

  test("wake cooldown suppresses repeat wakes to the same worker", async () => {
    process.env.AGENTCTL_WAKE_COOLDOWN_MS = "60000";
    idleWorker("w1");
    addTask(db, { title: "T1" });
    const { reconcile } = await import("../src/reconciler");
    await reconcile(db, rt);
    expect(rt.wakes.length).toBe(1);
    await reconcile(db, rt);
    expect(rt.wakes.length).toBe(1); // suppressed, no spam
  });
});

describe("B. standalone OpenCode (unmanaged)", () => {
  test("idle/tool/error from unmanaged session: no DB mutation, no runtime call", async () => {
    idleWorker("w1");
    const t = addTask(db, { title: "work" });
    claimNext(db, "w1");
    const before = eventCount();
    for (const type of ["session.idle", "tool.execute.after", "session.error"]) {
      const res = await handleSocketMessage({ type, session_id: "ses-standalone" }, ctx);
      expect(res).toMatchObject({ ok: true, ignored: "unmanaged" });
    }
    expect(eventCount()).toBe(before); // zero writes, not even a log row
    expect(rt.wakes).toHaveLength(0);
    expect(rt.targets).toHaveLength(0); // no Herdr call whatsoever
    expect(rt.starts).toHaveLength(0);
    expect(getTask(db, t.id)!.state).toBe("running");
  });
});

describe("C. dynamic attach/detach", () => {
  test("unmanaged -> attach -> managed; events processed only while managed", async () => {
    // Unmanaged: ignored.
    let res = await handleSocketMessage({ type: "session.idle", session_id: "ses-live" }, ctx);
    expect(res).toMatchObject({ ignored: "unmanaged" });

    // Attach mid-session (no restart): returns worker + generation. Manual
    // attach requires a verified Herdr identity (injected here).
    rt.setIdentity("ses-live", IDENTITY);
    res = await handleSocketMessage(
      { type: "session.attach", session_id: "ses-live", role: "worker", directory: "/tmp", worktree: "/tmp" },
      ctx
    );
    expect(res.ok).toBe(true);
    const s = getSession(db, "ses-live")!;
    expect(s.managed).toBe(1);
    expect(s.generation).toBe(1);
    expect(res).toMatchObject({ worker_id: s.worker_id, generation: 1 });

    // Now the same idle is processed (no task, no work => idle-no-work, but logged).
    const before = eventCount();
    res = await handleSocketMessage({ type: "session.idle", session_id: "ses-live", generation: 1 }, ctx);
    expect(res).toMatchObject({ ok: true, outcome: "idle-no-work" });
    expect(eventCount()).toBeGreaterThan(before);

    // Detach: back to a normal session, events ignored again, zero writes.
    res = await handleSocketMessage({ type: "session.detach", session_id: "ses-live" }, ctx);
    expect(res.ok).toBe(true);
    expect(getSession(db, "ses-live")!.managed).toBe(0);
    const afterDetach = eventCount();
    res = await handleSocketMessage({ type: "session.idle", session_id: "ses-live", generation: 1 }, ctx);
    expect(res).toMatchObject({ ignored: "unmanaged" });
    expect(eventCount()).toBe(afterDetach);
  });
});

describe("D. idle uses the injected (real) runtime", () => {
  test("managed worker with running task + idle => runtime.wake called, task untouched", async () => {
    const s = attachSession(db, "ses-d", { role: "worker", identity: IDENTITY });
    const workerId = s.worker_id!;
    rt.setAlive(workerId, true);
    db.query(`UPDATE workers SET state = 'idle' WHERE id = ?`).run(workerId);
    const t = addTask(db, { title: "running job" });
    claimNext(db, workerId);
    const res = await handleSocketMessage({ type: "session.idle", session_id: "ses-d", generation: s.generation }, ctx);
    expect(res).toMatchObject({ ok: true, outcome: "nudged-continue" });
    expect(rt.wakes.length).toBe(1);
    expect(rt.wakes[0].workerId).toBe(workerId);
    expect(rt.wakes[0].text).toMatch(/still running/);
    expect(getTask(db, t.id)!.state).toBe("running");
    expect(getTask(db, t.id)!.assignee).toBe(workerId);
  });

  // OpenCode 2.0.x never emits `session.idle`; a finished execution (or an
  // interrupt) is the turn-complete signal. It must behave exactly like idle.
  test("execution.succeeded / interrupted are accepted as the turn-complete idle", async () => {
    const s = attachSession(db, "ses-exec", { role: "worker", identity: IDENTITY });
    const workerId = s.worker_id!;
    rt.setAlive(workerId, true);
    db.query(`UPDATE workers SET state = 'idle' WHERE id = ?`).run(workerId);
    addTask(db, { title: "queued while the turn finishes" });

    const succeeded = await handleSocketMessage(
      { type: "session.execution.succeeded", session_id: "ses-exec", generation: s.generation },
      ctx
    );
    expect(succeeded).toMatchObject({ ok: true, outcome: "woke-next" });
    expect(rt.wakes.length).toBe(1);

    const interrupted = await handleSocketMessage(
      { type: "session.execution.interrupted", session_id: "ses-exec", generation: s.generation },
      ctx
    );
    expect(interrupted).toMatchObject({ ok: true, outcome: "woke-next" });
    expect(rt.wakes.length).toBe(2);
  });
});

describe("E. dead worker real restart", () => {
  test("missing process/session => task requeued, token bumped, start/restart called, recoverable", async () => {
    idleWorker("w1");
    const t = addTask(db, { title: "doomed" });
    claimNext(db, "w1");
    const tokenBefore = getTask(db, t.id)!.lease_token;
    rt.setAlive("w1", false); // process/session entirely gone
    const { reconcile } = await import("../src/reconciler");
    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("dead:w1");
    expect(actions).toContain(`requeued:${t.id}`);
    expect(rt.starts).toContain("w1"); // real restart, not just ctrl+c
    const after = getTask(db, t.id)!;
    expect(after.state).toBe("queued");
    expect(after.assignee).toBeNull();
    expect(after.lease_token).toBeGreaterThan(tokenBefore);
    // Worker is recoverable: fresh generation, no stuck task, can claim again.
    const w = getWorker(db, "w1")!;
    expect(w.current_task_id).toBeNull();
    expect(w.generation).toBeGreaterThan(0);
    rt.setAlive("w1", true);
    expect(claimNext(db, "w1")?.id).toBe(t.id);
  });
});

describe("F. runtime_id routing", () => {
  test("every runtime call targets runtime_id, never the worker id", async () => {
    idleWorker("worker-1", "worker", { runtimeId: "pane-special" });
    const w = getWorker(db, "worker-1")!;
    await rt.isAlive(w);
    await rt.wake(w, "hi");
    await rt.interrupt(w);
    await rt.peek(w);
    await rt.start(w, 1);
    for (const t of rt.targets) {
      expect(t.target).toBe("pane-special");
    }
    expect(rt.targets.map((t) => t.op).sort()).toEqual(["interrupt", "isAlive", "peek", "start", "wake"]);
    // And the reconciler wake path routes the same way.
    rt.targets.length = 0;
    rt.wakes.length = 0;
    addTask(db, { title: "routed work" });
    const { reconcile } = await import("../src/reconciler");
    await reconcile(db, rt);
    expect(rt.wakes.length).toBe(1);
    expect(rt.wakes[0].target).toBe("pane-special");
    expect(rt.targets.every((t) => t.target === "pane-special")).toBe(true);
  });
});

describe("G. zombie session protection", () => {
  test("gen-1 event cannot touch a gen-2 worker", async () => {
    const s1 = attachSession(db, "ses-z", { role: "worker", identity: IDENTITY });
    expect(s1.generation).toBe(1);
    // The Herdr pane moved (new tab/pane): a re-attach with a DIFFERENT verified
    // identity is not the same binding, so it gets a fresh generation. (An
    // identical binding is idempotent — see the manual-attach idempotency test.)
    const s2 = attachSession(db, "ses-z", {
      role: "worker",
      workerId: s1.worker_id!,
      identity: { ...IDENTITY, agent: "herdr-agent-2", tabId: "tab-ext-2", paneId: "pane-ext-2" },
    });
    expect(s2.generation).toBe(2);
    const before = eventCount();
    const stale = await handleSocketMessage({ type: "session.idle", session_id: "ses-z", generation: 1 }, ctx);
    expect(stale).toMatchObject({ ignored: "stale-generation" });
    expect(eventCount()).toBe(before); // zero effect
    expect(rt.wakes).toHaveLength(0);
    const fresh = await handleSocketMessage({ type: "session.idle", session_id: "ses-z", generation: 2 }, ctx);
    expect(fresh.ok).toBe(true);
    expect((fresh as { outcome?: string }).outcome).toBe("idle-no-work");
  });
});

describe("H. human block never stops other work", () => {
  test("T1 blocked_human, T2 queued => worker takes T2; system stays RUNNING", async () => {
    idleWorker("w1");
    const t1 = addTask(db, { title: "needs human", priority: 10 });
    const t2 = addTask(db, { title: "other", priority: 1 });
    expect(claimNext(db, "w1")?.id).toBe(t1.id);
    blockTask(db, t1.id, "w1", "need creds", true);
    expect(claimNext(db, "w1")?.id).toBe(t2.id);
    expect(supervisorView(db).status).toBe("RUNNING");
    void t1;
  });
});

describe("message per-ID deliver/ack", () => {
  test("deliver + ack by id; bulk claim stays compatible", async () => {
    const { sendMessage } = await import("../src/messages");
    const { deliverMessage, ackMessage, getMessage } = await import("../src/messages");
    idleWorker("w1");
    idleWorker("w2");
    const id = sendMessage(db, "w1", "w2", "peer hello");
    expect(getMessage(db, id)!.state).toBe("queued");
    expect(deliverMessage(db, id).state).toBe("delivered");
    expect(ackMessage(db, id, "w2").state).toBe("acked");
    expect(() => ackMessage(db, id, "w1")).toThrow();
  });
});
