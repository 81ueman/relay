import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { reconcile } from "../src/reconciler";
import { MockRuntime, type HerdrIdentity } from "../src/runtime/runtime";
import { attachSession } from "../src/sessions";
import { addTask, claimNext, submitTask } from "../src/tasks";
import { registerWorker, getWorker } from "../src/workers";
import { needsWorkerWakeup } from "../src/scheduler";

// Regression: "a queued role-gated task with a matching idle (not retired, no
// quiet lease, no current task) worker is woken; if it is not claimed it is
// re-woken (not silently dropped)".
//
// The original bug was `needsWorkerWakeup` requiring `working === 0`. In a
// parallel fleet some worker is almost always busy, so an idle role-matched
// worker was never nudged and its queued task sat until a human ran
// `relay next --worker <id>` by hand.

let dir = "";
let db: Database;
let rt: MockRuntime;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-wake-"));
  process.env.RELAY_DB = join(dir, "state.db");
  process.env.RELAY_LEASE_MS = "120000";
  process.env.RELAY_STALL_MS = "60000";
  process.env.RELAY_WAKE_COOLDOWN_MS = "0";
  delete process.env.RELAY_AUTO_APPROVE;
  db = openDb(process.env.RELAY_DB);
  rt = new MockRuntime();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function identityFor(id: string, runtimeId: string): HerdrIdentity {
  return { agent: runtimeId, tabId: `tab-${id}`, paneId: `pane-${id}`, workspaceId: "w-test", agentKind: "opencode" };
}

function managedWorker(id: string, role = "worker", runtimeId = `${id}-agent`): void {
  registerWorker(db, id, { role, runtimeId });
  attachSession(db, `ses_${id}`, { role, workerId: id, identity: identityFor(id, runtimeId) });
  rt.setAlive(id, true);
}

const wokenIds = () => rt.wakes.map((w) => w.workerId);

describe("wake: queued role-gated task + matching idle worker", () => {
  test("unrelated workers BUSY (working != 0) does not suppress the wake", async () => {
    managedWorker("coord", "coordinator");
    managedWorker("control-rust", "control-rust");
    const held = addTask(db, { title: "coord holds work", role: "coordinator" });
    claimNext(db, "coord");
    const child = addTask(db, { title: "gated child", role: "control-rust" });

    const r = await reconcile(db, rt);

    expect(r.view.runnable).toBeGreaterThan(0);
    expect(r.view.working).toBeGreaterThan(0); // the bug's trigger: someone else is busy
    expect(getWorker(db, "control-rust")!.state).toBe("idle");
    expect(wokenIds()).toContain("control-rust");
    expect(r.actions).toContain("woken:control-rust");
    expect(held.id).toBeDefined();
    expect(child.id).toBeDefined();
  });

  test("TWO workers of one role, one busy + one idle -> the IDLE one is woken", async () => {
    managedWorker("control-rust", "control-rust");
    managedWorker("control-rust-2", "control-rust");
    managedWorker("coord", "coordinator");

    // control-rust is busy on its own task...
    const mine = addTask(db, { title: "already mine", role: "control-rust" });
    claimNext(db, "control-rust");
    // ...while a second role-matching task appears; control-rust-2 is idle.
    const queued = addTask(db, { title: "queued for the free peer", role: "control-rust" });
    addTask(db, { title: "coord work", role: "coordinator" });
    claimNext(db, "coord");

    const r = await reconcile(db, rt);

    expect(getWorker(db, "control-rust")!.current_task_id).toBe(mine.id);
    expect(getWorker(db, "control-rust-2")!.state).toBe("idle");
    expect(wokenIds()).toContain("control-rust-2");
    expect(r.view.runnable).toBeGreaterThan(0);
    expect(queued.id).toBeDefined();
  });

  test("EVERY idle role-matched worker is woken, not just the first by id", async () => {
    managedWorker("a-rust", "perf-rust");
    managedWorker("b-rust", "perf-rust");
    managedWorker("coord", "coordinator");
    addTask(db, { title: "rust 1", role: "perf-rust" });
    addTask(db, { title: "rust 2", role: "perf-rust" });
    addTask(db, { title: "coord work", role: "coordinator" });
    claimNext(db, "coord");

    await reconcile(db, rt);

    expect(wokenIds()).toContain("a-rust");
    expect(wokenIds()).toContain("b-rust");
  });

  test("a retired worker is never woken; its role's task surfaces as unclaimable", async () => {
    managedWorker("rev-old", "reviewer");
    managedWorker("coord", "coordinator");
    db.query(`UPDATE workers SET retired_at = ? WHERE id = 'rev-old'`).run(Date.now());
    // A pre-created reviewer gate is only runnable once something is in review
    // (T225), so put one task in review to exercise the unclaimable path rather
    // than the new not-yet-runnable path.
    const impl = addTask(db, { title: "impl", role: "coordinator" });
    claimNext(db, "coord");
    submitTask(db, impl.id, "coord");
    addTask(db, { title: "needs review", role: "reviewer" });
    addTask(db, { title: "coord work", role: "coordinator" });
    claimNext(db, "coord");

    const r = await reconcile(db, rt);

    expect(wokenIds()).not.toContain("rev-old");
    expect(r.view.unclaimable).toBe(1);
    expect(r.actions.some((a) => a.startsWith("unclaimable:"))).toBe(true);
  });

  test("wake is repeated across passes when the task stays unclaimed (not silently dropped)", async () => {
    managedWorker("control-go", "control-go");
    managedWorker("coord", "coordinator");
    addTask(db, { title: "gated child", role: "control-go" });
    addTask(db, { title: "coord work", role: "coordinator" });
    claimNext(db, "coord");

    await reconcile(db, rt);
    expect(wokenIds()).toContain("control-go");

    // Worker was nudged but did not claim. The next pass must nudge again rather
    // than treat the earlier nudge as consumption of the candidate.
    rt.wakes.length = 0;
    await reconcile(db, rt);
    expect(wokenIds()).toContain("control-go");
  });

  test("storm guard: the per-worker cooldown prevents a wake every pass", async () => {
    process.env.RELAY_WAKE_COOLDOWN_MS = "600000"; // 10 min, so the second pass is inside it
    managedWorker("control-go", "control-go");
    managedWorker("coord", "coordinator");
    addTask(db, { title: "gated child", role: "control-go" });
    addTask(db, { title: "coord work", role: "coordinator" });
    claimNext(db, "coord");

    await reconcile(db, rt);
    const afterFirst = wokenIds().filter((w) => w === "control-go").length;
    await reconcile(db, rt);
    const afterSecond = wokenIds().filter((w) => w === "control-go").length;

    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1); // still one: cooldown suppressed the repeat
  });

  test("a worker with nothing claimable is not woken", async () => {
    managedWorker("control-go", "control-go");
    managedWorker("coord", "coordinator");
    addTask(db, { title: "rust only", role: "perf-rust" }); // no perf-rust worker exists
    addTask(db, { title: "coord work", role: "coordinator" });
    claimNext(db, "coord");

    await reconcile(db, rt);

    expect(wokenIds()).not.toContain("control-go");
    expect(wokenIds()).not.toContain("coord");
  });

  test("waiting_input workers are never wake candidates", async () => {
    managedWorker("control-go", "control-go");
    managedWorker("coord", "coordinator");
    addTask(db, { title: "held by control-go", role: "control-go" });
    claimNext(db, "control-go");
    db.query(`UPDATE workers SET state = 'waiting_input' WHERE id = 'control-go'`).run();
    addTask(db, { title: "second gated child", role: "control-go" });
    addTask(db, { title: "coord work", role: "coordinator" });
    claimNext(db, "coord");

    await reconcile(db, rt);

    expect(wokenIds()).not.toContain("control-go");
  });
});

describe("needsWorkerWakeup", () => {
  test("runnable work is enough; a busy fleet no longer suppresses it", () => {
    const base = { review: 0, claimableReview: 0, unfinished: 1, working: 0, status: "RUNNING" as const, unclaimable: 0 };
    expect(needsWorkerWakeup({ ...base, runnable: 1, working: 0 })).toBe(true);
    expect(needsWorkerWakeup({ ...base, runnable: 1, working: 6 })).toBe(true); // the fix
    expect(needsWorkerWakeup({ ...base, runnable: 0, working: 0 })).toBe(false);
  });
});
