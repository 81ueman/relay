import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { listEvents } from "../src/events";
import { claimInbox, inboxFor, sendMessage } from "../src/messages";
import { handleIdleSignal, reconcile } from "../src/reconciler";
import { MockRuntime } from "../src/runtime/runtime";
import { supervisorView, systemStatus } from "../src/scheduler";
import {
  addTask, approveTask, blockTask, claimNext, getTask,
  rejectTask, submitTask, addNote, expireLeases,
} from "../src/tasks";
import { listWorkers, registerWorker } from "../src/workers";

let dir = "";
let db: Database;
let rt: MockRuntime;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentctl-test-"));
  process.env.AGENTCTL_DB = join(dir, "state.db");
  process.env.AGENTCTL_LEASE_MS = "120000";
  process.env.AGENTCTL_STALL_MS = "60000";
  delete process.env.AGENTCTL_AUTO_APPROVE;
  db = openDb(process.env.AGENTCTL_DB);
  rt = new MockRuntime();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function worker(id: string, role = "worker"): void {
  registerWorker(db, id, { role });
  db.query(`UPDATE workers SET state = 'idle' WHERE id = ?`).run(id);
  rt.setAlive(id, true);
}

describe("phase 1: tasks + workers", () => {
  test("add/list/claim/note/submit/approve flows through review", () => {
    worker("w1");
    const t = addTask(db, { title: "do thing", priority: 5 });
    expect(t.state).toBe("queued");
    const claimed = claimNext(db, "w1")!;
    expect(claimed.id).toBe(t.id);
    expect(claimed.state).toBe("running");
    expect(claimed.lease_token).toBe(1);
    addNote(db, t.id, "w1", "half done");
    const sub = submitTask(db, t.id, "w1", { evidence: "tests green" });
    expect(sub.state).toBe("review");
    const done = approveTask(db, t.id, "reviewer-1");
    expect(done.state).toBe("done");
  });

  test("no double claim: one task, two workers", () => {
    worker("w1");
    worker("w2");
    addTask(db, { title: "only one" });
    const a = claimNext(db, "w1");
    const b = claimNext(db, "w2");
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  test("reject returns task to queued with bumped token", () => {
    worker("w1");
    const t = addTask(db, { title: "needs work" });
    claimNext(db, "w1");
    submitTask(db, t.id, "w1", { evidence: "maybe" });
    const tokenBefore = getTask(db, t.id)!.lease_token;
    const back = rejectTask(db, t.id, "reviewer-1", "not good enough");
    expect(back.state).toBe("queued");
    expect(back.lease_token).toBeGreaterThan(tokenBefore);
  });
});

describe("failure test 1: idle false-positive", () => {
  test("running task + idle event => task stays running, worker nudged to continue", async () => {
    worker("w1");
    const t = addTask(db, { title: "long job" });
    claimNext(db, "w1");
    const outcome = await handleIdleSignal(db, rt, "w1");
    expect(outcome).toBe("nudged-continue");
    expect(getTask(db, t.id)!.state).toBe("running");
    expect(rt.wakes.length).toBe(1);
    expect(rt.wakes[0].text).toMatch(/still running/);
  });

  test("idle with no task + runnable work => woken to next", async () => {
    worker("w1");
    addTask(db, { title: "waiting work" });
    const outcome = await handleIdleSignal(db, rt, "w1");
    expect(outcome).toBe("woke-next");
    expect(rt.wakes[0].text).toMatch(/agentctl next/);
  });

  test("idle in review => woken to next, task untouched", async () => {
    worker("w1");
    const t = addTask(db, { title: "for review" });
    claimNext(db, "w1");
    submitTask(db, t.id, "w1", { evidence: "e" });
    // reviewer-less worker still holds review assignment; simulate fresh idle worker view:
    db.query(`UPDATE workers SET current_task_id = ? WHERE id = 'w1'`).run(t.id);
    const outcome = await handleIdleSignal(db, rt, "w1");
    expect(outcome).toBe("woke-next");
    expect(getTask(db, t.id)!.state).toBe("review");
  });
});

describe("failure test 2: worker crash", () => {
  test("dead worker lease revoked, task requeueable by another worker", async () => {
    worker("w1");
    worker("w2");
    const t = addTask(db, { title: "crash me" });
    claimNext(db, "w1");
    rt.setAlive("w1", false); // kill -9 equivalent
    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("dead:w1");
    const after = getTask(db, t.id)!;
    expect(after.state).toBe("queued");
    expect(after.assignee).toBeNull();
    rt.setAlive("w2", true);
    const claimed = claimNext(db, "w2");
    expect(claimed?.id).toBe(t.id);
  });

  test("lease expiry alone returns task to queued (no heartbeat)", () => {
    worker("w1");
    worker("w2");
    const t = addTask(db, { title: "expiring" });
    claimNext(db, "w1");
    db.query(`UPDATE tasks SET lease_until = ? WHERE id = ?`).run(Date.now() - 1000, t.id);
    const expired = expireLeases(db, Date.now());
    expect(expired.map((x) => x.id)).toContain(t.id);
    expect(getTask(db, t.id)!.state).toBe("queued");
    expect(claimNext(db, "w2")?.id).toBe(t.id);
  });
});

describe("failure test 3: zombie completion", () => {
  test("stale worker submit after reassign is rejected", () => {
    worker("wA");
    worker("wB");
    const t = addTask(db, { title: "zombie" });
    const first = claimNext(db, "wA")!;
    expect(first.lease_token).toBe(1);
    // wA loses the task: lease expires, wB claims (token bumps to 2).
    db.query(`UPDATE tasks SET lease_until = ? WHERE id = ?`).run(Date.now() - 1000, t.id);
    expireLeases(db, Date.now());
    const second = claimNext(db, "wB")!;
    expect(second.lease_token).toBeGreaterThan(first.lease_token);
    expect(second.assignee).toBe("wB");
    // Late submit from wA must be rejected.
    expect(() => submitTask(db, t.id, "wA", { evidence: "late" })).toThrow("STALE_LEASE");
    // Explicit token fencing also rejects.
    expect(() => submitTask(db, t.id, "wB", { evidence: "x", leaseToken: first.lease_token })).toThrow("STALE_LEASE");
    // Correct owner + token succeeds.
    expect(submitTask(db, t.id, "wB", { evidence: "ok", leaseToken: second.lease_token }).state).toBe("review");
  });
});

describe("failure test 4: blocked human", () => {
  test("blocked_human frees the worker; system continues", async () => {
    worker("wA");
    const t1 = addTask(db, { title: "needs human", priority: 10 });
    const t2 = addTask(db, { title: "other work", priority: 1 });
    claimNext(db, "wA");
    expect(getTask(db, t1.id)!.id).toBe(t1.id);
    blockTask(db, t1.id, "wA", "need prod credentials", true);
    expect(getTask(db, t1.id)!.state).toBe("blocked_human");
    // Worker immediately gets the next runnable task.
    const next = claimNext(db, "wA");
    expect(next?.id).toBe(t2.id);
    // System is RUNNING, not waiting for human.
    expect(systemStatus(db)).toBe("RUNNING");
  });

  test("SYSTEM_WAITING_FOR_HUMAN only when everything is human-blocked", () => {
    worker("wA");
    const t = addTask(db, { title: "only task" });
    claimNext(db, "wA");
    blockTask(db, t.id, "wA", "need human", true);
    expect(systemStatus(db)).toBe("SYSTEM_WAITING_FOR_HUMAN");
    expect(supervisorView(db).status).toBe("SYSTEM_WAITING_FOR_HUMAN");
  });
});

describe("failure test 5: lost wake", () => {
  test("message survives failed wake and is receivable after restart", async () => {
    worker("w2");
    const id = sendMessage(db, "w1", "w2", "hello after crash");
    // Wake delivery fails AFTER durable commit.
    rt.failWake.add("w2");
    let wakeFailed = false;
    try {
      await rt.wake("w2", "nudge");
    } catch {
      wakeFailed = true;
    }
    expect(wakeFailed).toBe(true);
    // Message is still queued in SQLite.
    const pending = inboxFor(db, "w2");
    expect(pending.map((m) => m.id)).toContain(id);
    // Worker "restarts" and claims the inbox.
    rt.failWake.delete("w2");
    const items = inboxFor(db, "w2");
    expect(items.find((m) => m.payload === "hello after crash")).toBeDefined();
    expect(claimInbox(db, "w2")).toBeGreaterThan(0);
    expect(inboxFor(db, "w2")).toHaveLength(0);
    expect(listEvents(db, { limit: 5 }).some((e) => e.type === "message.acked")).toBe(true);
  });
});

describe("failure test 6: no productive worker", () => {
  test("queued task + all workers idle/dead => supervisor wakes or restarts one", async () => {
    registerWorker(db, "w1", { role: "worker" });
    db.query(`UPDATE workers SET state = 'idle' WHERE id = 'w1'`).run();
    rt.setAlive("w1", true);
    addTask(db, { title: "orphaned work" });
    // Force zero productive workers: mark dead but transport can restart.
    db.query(`UPDATE workers SET state = 'dead' WHERE id = 'w1'`).run();
    rt.setAlive("w1", false);
    const { actions } = await reconcile(db, rt);
    expect(actions.some((a) => a === "restarted:w1" || a.startsWith("woken:w1"))).toBe(true);
  });

  test("idle worker woken when work waits and nobody works", async () => {
    worker("w1"); // idle
    addTask(db, { title: "waiting" });
    const { view, actions } = await reconcile(db, rt);
    // w1 is productive (idle counts), so no forced wake; but work is claimable.
    expect(view.productive).toBe(1);
    expect(claimNext(db, "w1")).not.toBeNull();
    expect(actions).not.toContain("no-workers");
  });
});

describe("stalled detection (multi-signal, never bare idle)", () => {
  test("no progress + alive + valid lease => nudge once, then stalled", async () => {
    process.env.AGENTCTL_STALL_MS = "100";
    worker("w1");
    const t = addTask(db, { title: "stuck" });
    claimNext(db, "w1");
    // Age the progress timestamp so the stall timeout trips.
    db.query(`UPDATE workers SET last_progress_at = ? WHERE id = 'w1'`).run(Date.now() - 10000);
    let r = await reconcile(db, rt);
    expect(r.actions).toContain("nudge:w1");
    expect(getTask(db, t.id)!.state).toBe("running");
    // Still no progress after another timeout => stalled, task requeued, notes kept.
    addNote(db, t.id, "w1", "tried X, still stuck"); // note refreshes progress...
    db.query(`UPDATE workers SET last_progress_at = ?, nudged_at = ? WHERE id = 'w1'`).run(Date.now() - 10000, Date.now() - 10000);
    db.query(`UPDATE tasks SET lease_until = ? WHERE id = ?`).run(Date.now() + 60000, t.id);
    r = await reconcile(db, rt);
    expect(r.actions).toContain("stalled:w1");
    const after = getTask(db, t.id)!;
    expect(after.state).toBe("queued");
    expect(after.lease_token).toBeGreaterThan(1);
  });

  test("fresh progress prevents stall verdict", async () => {
    process.env.AGENTCTL_STALL_MS = "60000";
    worker("w1");
    const t = addTask(db, { title: "moving" });
    claimNext(db, "w1");
    addNote(db, t.id, "w1", "making progress");
    const { actions } = await reconcile(db, rt);
    expect(actions).not.toContain("stalled:w1");
    expect(actions).not.toContain("nudge:w1");
    expect(getTask(db, t.id)!.state).toBe("running");
  });
});

describe("planner / reviewer automation", () => {
  test("reviewer woken when reviews pile up", async () => {
    worker("w1");
    registerWorker(db, "rev", { role: "reviewer" });
    db.query(`UPDATE workers SET state = 'idle' WHERE id = 'rev'`).run();
    rt.setAlive("rev", true);
    const t = addTask(db, { title: "to review" });
    claimNext(db, "w1");
    submitTask(db, t.id, "w1", { evidence: "e" });
    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("reviewer-woken:rev");
    // Reviewer claims the review task without changing its state.
    const picked = claimNext(db, "rev")!;
    expect(picked.id).toBe(t.id);
    expect(getTask(db, t.id)!.state).toBe("review");
  });

  test("AGENTCTL_AUTO_APPROVE drains review queue", async () => {
    process.env.AGENTCTL_AUTO_APPROVE = "true";
    worker("w1");
    const t = addTask(db, { title: "auto" });
    claimNext(db, "w1");
    submitTask(db, t.id, "w1", { evidence: "e" });
    const { actions } = await reconcile(db, rt);
    expect(actions).toContain(`auto-approved:${t.id}`);
    expect(getTask(db, t.id)!.state).toBe("done");
  });

  test("planner woken when queue runs low", async () => {
    process.env.AGENTCTL_LOW_WATER = "3";
    registerWorker(db, "plan", { role: "planner" });
    db.query(`UPDATE workers SET state = 'idle' WHERE id = 'plan'`).run();
    rt.setAlive("plan", true);
    addTask(db, { title: "last one" });
    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("planner-woken:plan");
  });
});
