import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { listEvents } from "../src/events";
import { handleIdleSignal, reconcile } from "../src/reconciler";
import { MockRuntime } from "../src/runtime/runtime";
import { WORKER_STATES } from "../src/schema";
import {
  addNote, addTask, approveTask, blockTask, claimTask, getTask, releaseTask, submitTask, waitTask,
} from "../src/tasks";
import { getWorker, quietActive, registerWorker, setQuiet } from "../src/workers";
import { attachSession } from "../src/sessions";

// Bounded quiet lease: a worker that OWNS a running task may declare that it is
// intentionally runtime-idle for a limited time. It is temporary metadata, never
// a state, and never leaks onto another task.

let dir = "";
let db: Database;
let rt: MockRuntime;
const savedNudge = process.env.RELAY_MAIL_NUDGE_MS;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-quiet-"));
  db = openDb(join(dir, "state.db"));
  rt = new MockRuntime();
  registerWorker(db, "w1", { role: "worker" });
  registerWorker(db, "w2", { role: "worker" });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  if (savedNudge === undefined) delete process.env.RELAY_MAIL_NUDGE_MS;
  else process.env.RELAY_MAIL_NUDGE_MS = savedNudge;
});

/** Claim a fresh task for `worker` and return its id. */
function owned(worker = "w1", title = "work"): string {
  const t = addTask(db, { title });
  claimTask(db, t.id, worker);
  return t.id;
}

describe("quiet lease", () => {
  test("1+4+5. wait on an owned running task succeeds, keeps state=working, stores bounded reason", () => {
    const id = owned("w1");
    const before = Date.now();
    const { until } = waitTask(db, id, "w1", 120_000, "benchmark running in background");

    expect(until).toBeGreaterThan(before);
    const w = getWorker(db, "w1")!;
    expect(w.state).toBe("working"); // 4: no state change
    expect(w.quiet_until).toBe(until);
    expect(w.quiet_reason).toBe("benchmark running in background");
    expect(w.quiet_task_id).toBe(id);
    expect(quietActive(w)).toBe(true);
    expect(getTask(db, id)!.state).toBe("running"); // task state unchanged
    expect(listEvents(db, { limit: 20 }).some((e) => e.type === "worker.quiet_started")).toBe(true);
  });

  test("2. wait on another worker's task fails", () => {
    const id = owned("w1");
    expect(() => waitTask(db, id, "w2", 60_000, "not mine")).toThrow(/owned by w1/);
  });

  test("3. wait on a non-running task fails", () => {
    const t = addTask(db, { title: "queued" });
    expect(() => waitTask(db, t.id, "w1", 60_000, "nope")).toThrow(/cannot wait/);
  });

  test("6. session.idle during an active quiet lease does not nudge", async () => {
    const id = owned("w1");
    waitTask(db, id, "w1", 120_000, "waiting");
    const outcome = await handleIdleSignal(db, rt, "w1");
    expect(outcome).toBe("quiet");
    expect(rt.wakes).toHaveLength(0);
    expect(getWorker(db, "w1")!.state).toBe("working");
  });

  test("7. session.idle WITHOUT quiet still nudges", async () => {
    owned("w1");
    const outcome = await handleIdleSignal(db, rt, "w1");
    expect(outcome).toBe("nudged-continue");
    expect(rt.wakes).toHaveLength(1);
    expect(rt.wakes[0].text).toMatch(/still running/);
  });

  test("8. quiet expiry clears the lease (commit) and wakes the owner", async () => {
    const id = owned("w1");
    setQuiet(db, "w1", id, Date.now() - 1, "expired"); // already past
    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("quiet-expired:w1");
    expect(getWorker(db, "w1")!.quiet_until).toBeNull();
    expect(getWorker(db, "w1")!.quiet_reason).toBeNull();
    expect(rt.wakes.some((w) => w.workerId === "w1")).toBe(true);
    expect(listEvents(db, { limit: 20 }).some((e) => e.type === "worker.quiet_expired")).toBe(true);
  });

  test("expiry wake is suppressed when the worker no longer holds the task", async () => {
    const id = owned("w1");
    setQuiet(db, "w1", id, Date.now() - 1, "expired");
    db.query(`UPDATE workers SET current_task_id = NULL, state = 'idle' WHERE id = 'w1'`).run();
    const { actions } = await reconcile(db, rt); // stale quiet_task_id => cleared, no wake
    expect(actions).toContain("quiet-cleared:w1");
    expect(rt.wakes).toHaveLength(0);
  });

  test("9. relay note clears quiet", () => {
    const id = owned("w1");
    waitTask(db, id, "w1", 120_000, "waiting");
    addNote(db, id, "w1", "resumed");
    expect(getWorker(db, "w1")!.quiet_until).toBeNull();
  });

  test("10+11+12. submit / block / release clear quiet", () => {
    const t1 = owned("w1");
    waitTask(db, t1, "w1", 120_000, "w");
    submitTask(db, t1, "w1", { evidence: "x" });
    expect(getWorker(db, "w1")!.quiet_until).toBeNull();

    const t2 = owned("w1");
    waitTask(db, t2, "w1", 120_000, "w");
    blockTask(db, t2, "w1", "stuck", false);
    expect(getWorker(db, "w1")!.quiet_until).toBeNull();

    const t3 = owned("w1");
    waitTask(db, t3, "w1", 120_000, "w");
    releaseTask(db, t3, "w1");
    expect(getWorker(db, "w1")!.quiet_until).toBeNull();
  });

  test("13. claiming a NEW task does not inherit an old quiet lease", () => {
    const t1 = owned("w1");
    waitTask(db, t1, "w1", 120_000, "waiting on t1");
    releaseTask(db, t1, "w1");
    const t2 = owned("w1", "next work");
    const w = getWorker(db, "w1")!;
    expect(w.quiet_until).toBeNull();
    expect(w.quiet_task_id).toBeNull();
    expect(quietActive(w)).toBe(false);
    expect(getTask(db, t2)!.assignee).toBe("w1");
  });

  test("14. a dead worker is recovered immediately, ignoring an active quiet lease", async () => {
    const id = owned("w1");
    // Make it supervised: a managed session is the operational signal.
    attachSession(db, "ses_w1", {
      workerId: "w1",
      identity: { agent: "a1", tabId: "w9:t1", paneId: "w9:p1", workspaceId: "w9", agentKind: "opencode" },
    });
    waitTask(db, id, "w1", 3_600_000, "long quiet");
    rt.setAlive("w1", false); // transport gone, quiet is NOT liveness
    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("dead:w1");
    expect(getTask(db, id)!.state).toBe("queued");
  });

  test("15. a Herdr-busy worker needs no quiet lease (foreground work is not stalled)", async () => {
    owned("w1");
    db.query(`UPDATE workers SET last_progress_at = 0 WHERE id = 'w1'`).run();
    rt.setWorking("w1", true);
    const { actions } = await reconcile(db, rt);
    expect(actions.some((a) => a.startsWith("nudge:") || a.startsWith("stall"))).toBe(false);
    expect(getWorker(db, "w1")!.quiet_until).toBeNull(); // quiet not required
  });

  test("16. child_done can wake a quiet parent early", async () => {
    const parent = addTask(db, { title: "parent" });
    claimTask(db, parent.id, "w1");
    waitTask(db, parent.id, "w1", 3_600_000, "waiting for children");

    const child = addTask(db, { title: "child", parentTaskId: parent.id });
    claimTask(db, child.id, "w2");
    submitTask(db, child.id, "w2", { evidence: "x" });
    approveTask(db, child.id, "reviewer"); // enqueues a child_done message to w1

    process.env.RELAY_MAIL_NUDGE_MS = "600000"; // large window: only immediate kinds fire
    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("mail-nudged:w1"); // quiet does NOT block useful wake
  });

  test("17. quiet is visible in `relay status`", () => {
    const id = owned("w1");
    waitTask(db, id, "w1", 120_000, "benchmark running in background");
    const p = Bun.spawnSync(["bun", "src/cli.ts", "status"], {
      cwd: process.cwd(),
      env: { ...process.env, RELAY_DB: join(dir, "state.db") },
    });
    const out = p.stdout.toString();
    expect(out).toContain("quiet");
    expect(out).toContain("benchmark running in background");
  });

  test("18. quiet creates no new task/worker state", () => {
    expect(WORKER_STATES).toEqual(["starting", "idle", "working", "waiting_input", "stalled", "dead"]);
    const id = owned("w1");
    waitTask(db, id, "w1", 60_000, "w");
    const w = getWorker(db, "w1")!;
    expect(WORKER_STATES).toContain(w.state);
    expect(w.state).toBe("working");
  });
});
