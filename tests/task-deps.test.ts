import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { listEvents } from "../src/events";
import { reconcile } from "../src/reconciler";
import { MockRuntime } from "../src/runtime/runtime";
import { attachSession } from "../src/sessions";
import {
  addTask,
  approveTask,
  claimNext,
  claimTask,
  claimableRunnableTasks,
  isRunnableNow,
  notYetRunnableTasks,
  reviewPending,
  runnableTasks,
  setTaskDependencies,
  submitTask,
  taskDependencies,
} from "../src/tasks";
import { getWorker, registerWorker } from "../src/workers";

// T225: a pre-created queued role=reviewer task used to be runnable the instant
// it was queued, so the scheduler woke an idle reviewer and `relay next` claimed
// it BEFORE its sibling implementation was submitted (claim/release churn). A
// task may now declare prerequisites (task_deps); a queued reviewer gate is only
// runnable once something is in review (or its declared deps are done).

let dir = "";
let db: Database;
let rt: MockRuntime;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-deps-"));
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

function managed(id: string, role = "worker"): void {
  registerWorker(db, id, { role, runtimeId: `${id}-agent` });
  attachSession(db, `ses_${id}`, {
    role,
    workerId: id,
    identity: { agent: `${id}-agent`, tabId: `tab-${id}`, paneId: `pane-${id}`, workspaceId: "w", agentKind: "opencode" },
  });
  rt.setAlive(id, true);
}

const wokenIds = () => rt.wakes.map((w) => w.workerId);

describe("declared prerequisites gate a task out of the runnable set", () => {
  test("a dependent task is not runnable/claimable until its prerequisite is done", () => {
    managed("w1");
    const impl = addTask(db, { title: "impl" });
    const review = addTask(db, { title: "review it", dependsOn: [impl.id] });

    expect(taskDependencies(db, review.id)).toEqual([impl.id]);
    expect(runnableTasks(db).map((t) => t.id)).toEqual([impl.id]);
    expect(isRunnableNow(db, review)).toBe(false);
    expect(notYetRunnableTasks(db).map((t) => t.id)).toEqual([review.id]);

    // claimNext takes the runnable prerequisite, not the gated dependent.
    expect(claimNext(db, "w1")!.id).toBe(impl.id);
    // An explicit claim of the gated dependent is refused (not bypassable).
    expect(() => claimTask(db, review.id, "w1")).toThrow(/not yet runnable/);

    // Once the prerequisite is done, the dependent becomes runnable.
    submitTask(db, impl.id, "w1");
    approveTask(db, impl.id, "reviewer");
    expect(isRunnableNow(db, review)).toBe(true);
    expect(runnableTasks(db).map((t) => t.id)).toEqual([review.id]);
    expect(claimNext(db, "w1")!.id).toBe(review.id);
  });

  test("claim is refused while a prerequisite is only in review (not done)", () => {
    managed("w1");
    const impl = addTask(db, { title: "impl" });
    const dependent = addTask(db, { title: "dependent", dependsOn: [impl.id] });
    claimNext(db, "w1"); // impl
    submitTask(db, impl.id, "w1"); // impl -> review
    expect(() => claimTask(db, dependent.id, "w1")).toThrow(/not yet runnable/);
    expect(runnableTasks(db)).toHaveLength(0);
  });

  test("addTask records deps atomically and a bad dependency is refused", () => {
    expect(() => addTask(db, { title: "bad", dependsOn: ["T404"] })).toThrow(/unknown dependency/);
    const a = addTask(db, { title: "a" });
    expect(() => addTask(db, { title: "ok", dependsOn: [a.id] })).not.toThrow();
    // The rejected task left no row behind; the two good ones did.
    expect(db.query(`SELECT COUNT(*) AS n FROM tasks`).get()).toMatchObject({ n: 2 });
  });

  test("setTaskDependencies replaces, clears and rejects cycles/self", () => {
    const a = addTask(db, { title: "a" });
    const b = addTask(db, { title: "b" });
    const c = addTask(db, { title: "c" });

    setTaskDependencies(db, b.id, [a.id]);
    setTaskDependencies(db, c.id, [a.id, b.id]);
    expect(taskDependencies(db, c.id)).toEqual([a.id, b.id]);

    // a -> c would close a cycle (c already depends on a).
    expect(() => setTaskDependencies(db, a.id, [c.id])).toThrow(/cycle/);
    expect(() => setTaskDependencies(db, a.id, [a.id])).toThrow(/itself/);

    // Clearing removes the gate (and its rows).
    setTaskDependencies(db, c.id, []);
    expect(taskDependencies(db, c.id)).toEqual([]);
    // b is still gated by a (not done); a and the cleared c are runnable.
    expect(runnableTasks(db).map((t) => t.id).sort()).toEqual([a.id, c.id].sort());
    expect(listEvents(db, { limit: 50 }).some((e) => e.type === "task.depends_set")).toBe(true);
    expect(listEvents(db, { limit: 50 }).some((e) => e.type === "task.depends_cleared")).toBe(true);
  });
});

describe("reviewer gate: not runnable before its sibling is submitted (T225)", () => {
  test("a queued reviewer gate is not offered while nothing is in review", async () => {
    managed("reviewer", "reviewer");
    managed("dev", "worker");
    const gate = addTask(db, { title: "standing review gate", role: "reviewer" });
    // An implementation sibling exists but is still queued/running.
    const impl = addTask(db, { title: "impl", role: "worker" });

    expect(reviewPending(db)).toBe(false);
    expect(claimableRunnableTasks(db, "reviewer").map((t) => t.id)).not.toContain(gate.id);
    expect(notYetRunnableTasks(db).map((t) => t.id)).toEqual([gate.id]);

    // No wake for the reviewer — the gate is not runnable.
    const { actions } = await reconcile(db, rt);
    expect(wokenIds()).not.toContain("reviewer");
    expect(actions.some((a) => a.includes("reviewer"))).toBe(false);

    // relay next does not claim the gate; it takes the worker's impl task.
    expect(claimNext(db, "reviewer")).toBeNull();
    expect(claimNext(db, "dev")!.id).toBe(impl.id);
  });

  test("once the sibling is submitted the gate becomes runnable (and the reviewer is woken)", async () => {
    managed("reviewer", "reviewer");
    managed("dev", "worker");
    const gate = addTask(db, { title: "standing review gate", role: "reviewer" });
    const impl = addTask(db, { title: "impl", role: "worker" });
    expect(claimNext(db, "dev")!.id).toBe(impl.id);
    submitTask(db, impl.id, "dev"); // impl -> review

    expect(reviewPending(db)).toBe(true);
    expect(claimableRunnableTasks(db, "reviewer").map((t) => t.id)).toEqual([gate.id]);
    expect(notYetRunnableTasks(db)).toHaveLength(0);

    const { actions } = await reconcile(db, rt);
    expect(wokenIds()).toContain("reviewer");
    expect(actions.some((a) => a.startsWith("reviewer-woken"))).toBe(true);
  });

  test("a gate with declared deps runs when they are done, even with nothing in review", () => {
    managed("reviewer", "reviewer");
    managed("dev", "worker");
    const input = addTask(db, { title: "input" });
    const gate = addTask(db, { title: "gate", role: "reviewer", dependsOn: [input.id] });

    // The gate itself is gated out; only the role-less input is claimable.
    expect(claimableRunnableTasks(db, "reviewer").map((t) => t.id)).not.toContain(gate.id);
    expect(notYetRunnableTasks(db).map((t) => t.id)).toEqual([gate.id]);

    claimNext(db, "dev"); // input
    submitTask(db, input.id, "dev");
    approveTask(db, input.id, "reviewer");

    expect(reviewPending(db)).toBe(false);
    expect(claimableRunnableTasks(db, "reviewer").map((t) => t.id)).toEqual([gate.id]);
  });
});
