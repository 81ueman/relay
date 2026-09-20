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
import { attachSession, getSession } from "../src/sessions";
import {
  cleanupCandidates,
  findRuntime,
  listRuntimes,
  recordRuntime,
} from "../src/runtimes";
import { addTask, approveTask, claimNext, getTask, submitTask } from "../src/tasks";
import { getWorker, listWorkers, registerWorker } from "../src/workers";

// Runtime lifecycle correctness (spec section 15). Sessions/runtimes are
// disposable; tasks durable. Restart = stale old + fresh generation, and old
// tabs are reaped only later, only when provably relay-owned.

let dir = "";
let db: Database;
let rt: MockRuntime;
let ctx: SocketContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-lifecycle-"));
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

function eventCount(): number {
  return listEvents(db, { limit: 10000 }).length;
}

/**
 * Register a worker and give it a MANAGED session + a relay-owned active runtime
 * at `generation`. Only managed workers are schedulable/restartable, so every
 * lifecycle fixture must go through the real attach path.
 */
function seedWorker(id: string, generation: number, runtimeId: string | null, state = "idle", role = "worker"): void {
  registerWorker(db, id, { role });
  const token = `seed-${id}-g${generation}`;
  recordRuntime(db, {
    workerId: id,
    generation,
    runtimeId,
    tabId: runtimeId ? `tab-${id}-g${generation}` : null,
    state: "starting",
    relayOwned: 1,
    attachToken: token,
  });
  attachSession(db, `ses_${id}_g${generation}`, {
    workerId: id,
    role,
    generation,
    attachToken: token,
  });
  db.query(`UPDATE workers SET state = ?, runtime_id = COALESCE(?, runtime_id) WHERE id = ?`).run(
    state,
    runtimeId,
    id
  );
  rt.setAlive(id, true);
}

describe("1. fresh restart creates a new generation", () => {
  test("g1 active -> restart -> g1 stale + g2 active after managed attach", async () => {
    seedWorker("w1", 1, "rt-w1-g1");
    recordRuntime(db, { workerId: "w1", generation: 1, runtimeId: "rt-w1-g1", tabId: "tab-w1-g1", state: "active" });

    rt.setAlive("w1", false); // transport gone -> real restart
    await reconcile(db, rt);

    const g1 = findRuntime(db, "w1", 1)!;
    const g2 = findRuntime(db, "w1", 2)!;
    expect(g1.state).toBe("stale");
    expect(g2.state).toBe("starting");
    expect(g1.runtime_id).not.toBe(g2.runtime_id);
    expect(getWorker(db, "w1")!.generation).toBe(2);

    // Managed attach lands for the fresh generation (relay-spawned env), with
    // the per-spawn token the runtime recorded.
    attachSession(db, "ses-w1-g2", { workerId: "w1", role: "worker", generation: 2, attachToken: "mock-token-w1-g2" });
    await reconcile(db, rt);

    expect(findRuntime(db, "w1", 2)!.state).toBe("active");
    const w = getWorker(db, "w1")!;
    expect(w.generation).toBe(2);
    expect(w.state).toBe("idle");
    expect(w.opencode_session_id).toBe("ses-w1-g2");
  });
});

describe("2. old runtime is not immediately destroyed", () => {
  test("right after restart the old tab still exists and is only scheduled for later cleanup", async () => {
    seedWorker("w1", 1, "rt-w1-g1");
    recordRuntime(db, { workerId: "w1", generation: 1, runtimeId: "rt-w1-g1", tabId: "tab-w1-g1", state: "active" });

    rt.setAlive("w1", false);
    await reconcile(db, rt);

    const g1 = findRuntime(db, "w1", 1)!;
    expect(g1.state).toBe("stale");
    expect(g1.cleanup_after).not.toBeNull();
    expect(g1.cleanup_after!).toBeGreaterThan(Date.now());
    expect(rt.cleanups).toHaveLength(0); // nothing destroyed synchronously
  });
});

describe("3. cleanup after grace period", () => {
  test("stale + expired grace + newer generation => cleanup called, state cleaned", async () => {
    seedWorker("w1", 2, "rt-w1-g2");
    recordRuntime(db, {
      workerId: "w1",
      generation: 1,
      runtimeId: "rt-w1-g1",
      tabId: "tab-w1-g1",
      state: "stale",
      cleanupAfter: Date.now() - 1000,
    });
    expect(cleanupCandidates(db, Date.now())).toHaveLength(1);

    await reconcile(db, rt);

    expect(rt.cleanups).toContain("rt-w1-g1");
    expect(findRuntime(db, "w1", 1)!.state).toBe("cleaned");
  });
});

describe("4. never cleanup current generation", () => {
  test("active current runtime and same-generation stale rows are never candidates", async () => {
    seedWorker("w1", 2, "rt-w1-g2");
    recordRuntime(db, { workerId: "w1", generation: 2, runtimeId: "rt-w1-g2", tabId: "tab-w1-g2", state: "active" });
    // A same-generation stale row must still be protected (generation >= current).
    recordRuntime(db, {
      workerId: "w1",
      generation: 2,
      runtimeId: "rt-w1-g2-dup",
      state: "stale",
      cleanupAfter: Date.now() - 1000,
    });

    await reconcile(db, rt);

    expect(rt.cleanups).toHaveLength(0);
    const active = listRuntimes(db, { workerId: "w1", generation: 2 }).find((r) => r.runtime_id === "rt-w1-g2")!;
    expect(active.state).toBe("active");
    const dup = listRuntimes(db, { workerId: "w1", generation: 2 }).find((r) => r.runtime_id === "rt-w1-g2-dup")!;
    expect(dup.state).toBe("stale"); // protected by generation >= current, not cleaned
  });
});

describe("5. cleanup failure retries without breaking work", () => {
  test("cleanup throw logs runtime.cleanup_failed, task unaffected, later pass succeeds", async () => {
    seedWorker("w1", 2, "rt-w1-g2");
    const t = addTask(db, { title: "keep moving" });
    claimNext(db, "w1");
    recordRuntime(db, {
      workerId: "w1",
      generation: 1,
      runtimeId: "rt-w1-g1",
      tabId: "tab-w1-g1",
      state: "stale",
      cleanupAfter: Date.now() - 1000,
    });
    rt.failCleanup.add("rt-w1-g1");

    const first = await reconcile(db, rt);
    expect(first.actions.some((a) => a.startsWith("cleanup-failed:"))).toBe(true);
    expect(findRuntime(db, "w1", 1)!.state).toBe("stale"); // remains for retry
    expect(listEvents(db, { limit: 500 }).some((e) => e.type === "runtime.cleanup_failed")).toBe(true);
    expect(getTask(db, t.id)!.state).toBe("running"); // work untouched
    expect(getWorker(db, "w1")!.current_task_id).toBe(t.id);

    rt.failCleanup.delete("rt-w1-g1");
    await reconcile(db, rt);
    expect(rt.cleanups).toContain("rt-w1-g1");
    expect(findRuntime(db, "w1", 1)!.state).toBe("cleaned");
  });
});

describe("6. relay-spawned session auto attaches", () => {
  test("attach with worker + generation registers managed and activates the fresh runtime", async () => {
    registerWorker(db, "w1", { role: "worker" });
    db.query(`UPDATE workers SET state = 'starting', generation = 2, runtime_id = 'rt-w1-g2' WHERE id = 'w1'`).run();
    recordRuntime(db, {
      workerId: "w1",
      generation: 2,
      runtimeId: "rt-w1-g2",
      tabId: "tab-w1-g2",
      state: "starting",
      relayOwned: 1,
      attachToken: "tok-w1-g2",
    });

    const res = await handleSocketMessage(
      { type: "session.attach", session_id: "ses-spawn", worker_id: "w1", generation: 2, role: "worker", token: "tok-w1-g2" },
      ctx
    );
    expect(res.ok).toBe(true);
    expect(res.generation).toBe(2);

    const s = getSession(db, "ses-spawn")!;
    expect(s.managed).toBe(1);
    expect(s.worker_id).toBe("w1");
    expect(s.generation).toBe(2);

    const w = getWorker(db, "w1")!;
    expect(w.generation).toBe(2);
    expect(w.state).toBe("idle");
    expect(w.opencode_session_id).toBe("ses-spawn");

    const g2 = findRuntime(db, "w1", 2)!;
    expect(g2.state).toBe("active");
    expect(g2.session_id).toBe("ses-spawn");
  });
});

describe("7. manual standalone stays unmanaged", () => {
  test("plain opencode session event: no DB write, no runtime call", async () => {
    const before = eventCount();
    const res = await handleSocketMessage({ type: "session.idle", session_id: "ses-plain" }, ctx);
    expect(res).toMatchObject({ ok: true, ignored: "unmanaged" });
    expect(eventCount()).toBe(before);
    expect(rt.targets).toHaveLength(0);
    expect(rt.wakes).toHaveLength(0);
    expect(rt.starts).toHaveLength(0);
  });
});

describe("8. permission wait is not wakeable", () => {
  test("waiting_input worker holding T1 never receives NEXT_NUDGE while T2 is queued", async () => {
    seedWorker("w1", 1, "rt-w1-g1");
    const t1 = addTask(db, { title: "T1", priority: 10 });
    const t2 = addTask(db, { title: "T2", priority: 1 });
    expect(claimNext(db, "w1")?.id).toBe(t1.id);
    db.query(`UPDATE workers SET state = 'waiting_input' WHERE id = 'w1'`).run();

    const { actions } = await reconcile(db, rt);
    expect(actions.some((a) => a.startsWith("woken:"))).toBe(false);
    expect(rt.wakes).toHaveLength(0);
    expect(getWorker(db, "w1")!.state).toBe("waiting_input");
    expect(getWorker(db, "w1")!.current_task_id).toBe(t1.id);
    expect(getTask(db, t2.id)!.state).toBe("queued");
  });
});

describe("9. all work complete stays quiet", () => {
  test("no planner wake when queued/running/review/blocked are all zero", async () => {
    seedWorker("w1", 1, "rt-w1-g1");
    seedWorker("plan", 1, "rt-plan-g1", "idle", "planner");

    const t = addTask(db, { title: "the only task" });
    claimNext(db, "w1");
    submitTask(db, t.id, "w1", { evidence: "done" });
    approveTask(db, t.id, "supervisor");
    expect(getTask(db, t.id)!.state).toBe("done");

    rt.wakes.length = 0;
    const { actions } = await reconcile(db, rt);
    expect(actions).not.toContain("planner-woken:plan");
    expect(rt.wakes).toHaveLength(0);
    expect(listWorkers(db).length).toBeGreaterThan(0); // planner exists but stays quiet
  });
});

describe("10. non-session ids are rejected", () => {
  test("a shell/command id never becomes a managed session", async () => {
    const before = eventCount();
    const res = await handleSocketMessage(
      { type: "session.attach", session_id: "sh_0ba8abc", worker_id: "w1", generation: 1 },
      ctx
    );
    expect(res).toMatchObject({ ok: false, reason: "not-a-session-id" });
    expect(getSession(db, "sh_0ba8abc")).toBeNull();
    expect(listWorkers(db)).toHaveLength(0);
    expect(eventCount()).toBe(before);
  });
});

describe("11. a fresh generation supersedes the old session", () => {
  test("attaching g2 detaches the worker's g1 session so its events stop counting", async () => {
    registerWorker(db, "w1", { role: "worker" });
    recordRuntime(db, {
      workerId: "w1", generation: 1, runtimeId: "rt-w1-g1", state: "starting", relayOwned: 1, attachToken: "tok-g1",
    });
    attachSession(db, "ses-w1-g1", { workerId: "w1", role: "worker", generation: 1, attachToken: "tok-g1" });
    expect(getSession(db, "ses-w1-g1")!.managed).toBe(1);

    recordRuntime(db, {
      workerId: "w1", generation: 2, runtimeId: "rt-w1-g2", state: "starting", relayOwned: 1, attachToken: "tok-g2",
    });
    attachSession(db, "ses-w1-g2", { workerId: "w1", role: "worker", generation: 2, attachToken: "tok-g2" });

    expect(getSession(db, "ses-w1-g1")!.managed).toBe(0); // old session fenced out
    expect(getSession(db, "ses-w1-g2")!.managed).toBe(1);
    expect(getWorker(db, "w1")!.opencode_session_id).toBe("ses-w1-g2");
    expect(findRuntime(db, "w1", 2)!.state).toBe("active");
  });
});

describe("12. relay generations require the per-spawn attach token", () => {
  test("an attach without the recorded token is rejected; the legit token succeeds", async () => {
    seedWorker("w1", 1, "rt-w1-g1");
    recordRuntime(db, { workerId: "w1", generation: 1, runtimeId: "rt-w1-g1", state: "active" });
    rt.setAlive("w1", false);
    await reconcile(db, rt);
    expect(findRuntime(db, "w1", 2)!.attach_token).toBe("mock-token-w1-g2");

    // A stale/foreign plugin (no token) must not be able to bind this generation.
    const bad = await handleSocketMessage(
      { type: "session.attach", session_id: "ses-intruder", worker_id: "w1", generation: 2 },
      ctx
    );
    expect(bad).toMatchObject({ ok: false });
    expect(getSession(db, "ses-intruder")).toBeNull();

    const good = await handleSocketMessage(
      { type: "session.attach", session_id: "ses-w1-g2", worker_id: "w1", generation: 2, token: "mock-token-w1-g2" },
      ctx
    );
    expect(good).toMatchObject({ ok: true, worker_id: "w1" });
    expect(getSession(db, "ses-w1-g2")!.managed).toBe(1);
  });
});

describe("13. repeated cleanup failures are log-deduped", () => {
  test("a failing cleanup logs once per window but keeps retrying", async () => {
    seedWorker("w1", 2, "rt-w1-g2");
    recordRuntime(db, {
      workerId: "w1",
      generation: 1,
      runtimeId: "rt-w1-g1",
      tabId: "tab-w1-g1",
      state: "stale",
      cleanupAfter: Date.now() - 1000,
    });
    rt.failCleanup.add("rt-w1-g1");

    await reconcile(db, rt);
    await reconcile(db, rt);
    await reconcile(db, rt);

    const failures = listEvents(db, { limit: 1000 }).filter((e) => e.type === "runtime.cleanup_failed");
    expect(failures).toHaveLength(1); // one log line, not one per tick
    expect(findRuntime(db, "w1", 1)!.state).toBe("stale"); // still retryable
  });
});

describe("14. a failed restart backs off instead of retrying every tick", () => {
  test("a spawn that keeps failing logs worker.restart_failed once per cooldown window", async () => {
    process.env.RELAY_RESTART_COOLDOWN_MS = "60000";
    seedWorker("w1", 1, "rt-w1-g1");
    recordRuntime(db, { workerId: "w1", generation: 1, runtimeId: "rt-w1-g1", state: "active" });
    rt.setAlive("w1", false);
    rt.failStart.add("w1");

    await reconcile(db, rt);
    await reconcile(db, rt);
    await reconcile(db, rt);

    const failures = listEvents(db, { limit: 1000 }).filter((e) => e.type === "worker.restart_failed");
    expect(failures).toHaveLength(1); // one log line, not one per tick
    expect(getWorker(db, "w1")!.state).toBe("dead");
  });
});
