import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { listEvents } from "../src/events";
import { MockRuntime } from "../src/runtime/runtime";
import { reconcile } from "../src/reconciler";
import { supervisorView } from "../src/scheduler";
import { attachSession } from "../src/sessions";
import {
  addTask,
  claimNext,
  claimTask,
  expireLeases,
  getNotes,
  getTask,
  releaseTask,
  unclaimableRunnableTasks,
} from "../src/tasks";
import { getWorker, registerWorker } from "../src/workers";

// A. `relay release` — clean hand-back of a running task.
// B. Role-aware claiming — STRICT by default (breaking, intended).
// C. Liveness-aware lease expiry — crash recovery only.

let dir = "";
let db: Database;
let rt: MockRuntime;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-release-"));
  process.env.RELAY_DB = join(dir, "state.db");
  process.env.RELAY_LEASE_MS = "120000";
  process.env.RELAY_STALL_MS = "60000";
  process.env.RELAY_WAKE_COOLDOWN_MS = "0";
  process.env.RELAY_RESTART_COOLDOWN_MS = "0";
  delete process.env.RELAY_AUTO_APPROVE;
  delete process.env.RELAY_ROLE_STRICT;
  delete process.env.RELAY_LEASE_LIVENESS_GRACE_MS;
  db = openDb(process.env.RELAY_DB);
  rt = new MockRuntime();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Register + attach a managed session so the worker is schedulable/wakeable. */
function managedWorker(id: string, role = "worker"): void {
  registerWorker(db, id, { role });
  attachSession(db, `ses_${id}`, {
    role,
    workerId: id,
    identity: { agent: `${id}-agent`, tabId: `tab-${id}`, paneId: `pane-${id}`, workspaceId: "w-test", agentKind: "opencode" },
  });
  rt.setAlive(id, true);
}

// ---------------------------------------------------------------------------
describe("A. release — clean hand-back (running -> queued)", () => {
  test("release nulls assignee/lease, bumps the fencing token, and clears the owner's pointer", () => {
    registerWorker(db, "w1", { role: "worker" });
    const t = addTask(db, { title: "mis-claimed" });
    const claimed = claimNext(db, "w1")!;
    expect(claimed.state).toBe("running");
    const tokenBefore = claimed.lease_token;

    const released = releaseTask(db, t.id, "w1");
    expect(released.state).toBe("queued");
    expect(released.assignee).toBeNull();
    expect(released.lease_until).toBeNull();
    expect(released.lease_token).toBe(tokenBefore + 1);

    const owner = getWorker(db, "w1")!;
    expect(owner.current_task_id).toBeNull();
    expect(owner.state).toBe("idle"); // normalized out of `working`

    const notes = getNotes(db, t.id);
    expect(notes.some((n) => n.kind === "release" && n.worker_id === "w1")).toBe(true);
    expect(listEvents(db, { limit: 100 }).some((e) => e.type === "task.released")).toBe(true);
  });

  test("after release a DIFFERENT worker can claim it (fencing token increased)", () => {
    registerWorker(db, "w1", { role: "worker" });
    registerWorker(db, "w2", { role: "worker" });
    const t = addTask(db, { title: "handoff" });
    const first = claimNext(db, "w1")!;
    releaseTask(db, t.id, "w1");

    const second = claimNext(db, "w2")!;
    expect(second.id).toBe(t.id);
    expect(second.assignee).toBe("w2");
    expect(second.lease_token).toBeGreaterThan(first.lease_token);
  });

  test("release on a non-running task throws", () => {
    registerWorker(db, "w1", { role: "worker" });
    const t = addTask(db, { title: "still queued" });
    expect(() => releaseTask(db, t.id, "w1")).toThrow(/cannot release task in state queued/);
  });

  test("a human/other worker may release a task it does not own (recovery path)", () => {
    registerWorker(db, "owner", { role: "worker" });
    registerWorker(db, "operator", { role: "worker" });
    const t = addTask(db, { title: "owner gone" });
    claimNext(db, "owner");

    const released = releaseTask(db, t.id, "operator");
    expect(released.state).toBe("queued");
    expect(released.assignee).toBeNull();
    // The previous owner no longer holds the task...
    expect(getWorker(db, "owner")!.current_task_id).toBeNull();
    expect(getWorker(db, "operator")!.current_task_id).toBeNull();
    // ...and a later claim gets a higher token, fencing the old owner out.
    expect(claimNext(db, "owner")!.lease_token).toBe(released.lease_token + 1);
  });
});

// ---------------------------------------------------------------------------
describe("B. role-aware claiming — strict by default", () => {
  test("a role-tagged task is NOT stolen by role=worker; the matching role claims it", () => {
    registerWorker(db, "w-generic", { role: "worker" });
    registerWorker(db, "w-rust", { role: "dataplane-rust" });
    const t = addTask(db, { title: "rust work", role: "dataplane-rust" });

    // Strict default: the generic worker stays idle (NO_TASK), it does not steal.
    expect(claimNext(db, "w-generic")).toBeNull();
    expect(getWorker(db, "w-generic")!.state).toBe("idle");

    const claimed = claimNext(db, "w-rust")!;
    expect(claimed.id).toBe(t.id);
    expect(claimed.role).toBe("dataplane-rust");
    expect(claimed.assignee).toBe("w-rust");
  });

  test("role IS NULL tasks stay claimable by any worker", () => {
    registerWorker(db, "w1", { role: "worker" });
    const t = addTask(db, { title: "unscoped" });
    expect(t.role).toBeNull();
    expect(claimNext(db, "w1")?.id).toBe(t.id);
  });

  test("--role override (opts.role) matches an explicit role for the call", () => {
    registerWorker(db, "w-generic", { role: "worker" });
    addTask(db, { title: "planner work", role: "planner" });
    expect(claimNext(db, "w-generic", { role: "planner" })?.role).toBe("planner");
  });

  test("--any-role / RELAY_ROLE_STRICT=false restores the old any-worker behavior", () => {
    registerWorker(db, "w1", { role: "worker" });
    addTask(db, { title: "any-role override", role: "dataplane-rust" });
    expect(claimNext(db, "w1", { strictRole: false })?.role).toBe("dataplane-rust");

    // Env escape hatch, same effect.
    process.env.RELAY_ROLE_STRICT = "false";
    registerWorker(db, "w2", { role: "worker" });
    addTask(db, { title: "env override", role: "dataplane-rust" });
    expect(claimNext(db, "w2")).not.toBeNull();
    delete process.env.RELAY_ROLE_STRICT;
  });

  test("claimTask is role-gated too (--any-role overrides)", () => {
    registerWorker(db, "w1", { role: "worker" });
    const t = addTask(db, { title: "specific", role: "dataplane-rust" });
    expect(() => claimTask(db, t.id, "w1")).toThrow(/does not match/);
    const claimed = claimTask(db, t.id, "w1", { strictRole: false });
    expect(claimed.state).toBe("running");
    expect(claimed.assignee).toBe("w1");
  });

  test("supervisor view exposes a task as unclaimable when no worker role matches", () => {
    registerWorker(db, "w-generic", { role: "worker" });
    addTask(db, { title: "stranded", role: "dataplane-rust" });
    expect(supervisorView(db).unclaimable).toBe(1);
    expect(unclaimableRunnableTasks(db).map((t) => t.role)).toEqual(["dataplane-rust"]);

    registerWorker(db, "w-rust", { role: "dataplane-rust" });
    expect(supervisorView(db).unclaimable).toBe(0);
    expect(unclaimableRunnableTasks(db)).toHaveLength(0);
  });

  test("reconciler does not wake a role=worker for a rust-only queue, but wakes the rust worker", async () => {
    managedWorker("w-generic", "worker");
    addTask(db, { title: "rust only", role: "dataplane-rust" });

    const first = await reconcile(db, rt);
    expect(first.actions.some((a) => a.startsWith("woken:"))).toBe(false);
    expect(first.actions.some((a) => a.startsWith("unclaimable:"))).toBe(true);
    expect(rt.wakes).toHaveLength(0);
    expect(first.view.unclaimable).toBe(1);

    managedWorker("w-rust", "dataplane-rust");
    const second = await reconcile(db, rt);
    expect(second.actions.some((a) => a.startsWith("woken:"))).toBe(true);
    expect(rt.wakes.at(-1)?.workerId).toBe("w-rust");
  });
});

// ---------------------------------------------------------------------------
describe("C. liveness-aware lease expiry — crash recovery only", () => {
  test("a live, recently-seen worker keeps its lapsed lease (not expired)", () => {
    managedWorker("w1", "worker");
    const t = addTask(db, { title: "long job" });
    claimNext(db, "w1");
    const leaseUntil = getTask(db, t.id)!.lease_until!;

    // Advance past the 120 s lease but still inside the liveness grace window.
    const expired = expireLeases(db, leaseUntil + 60000);
    expect(expired).toHaveLength(0);

    const after = getTask(db, t.id)!;
    expect(after.state).toBe("running");
    expect(after.assignee).toBe("w1");
    expect(after.lease_token).toBe(1);
  });

  test("a dead worker's lapsed lease IS revoked (crash recovery)", () => {
    managedWorker("w1", "worker");
    const t = addTask(db, { title: "crash" });
    claimNext(db, "w1");
    db.query(`UPDATE workers SET state = 'dead' WHERE id = 'w1'`).run();

    const expired = expireLeases(db, getTask(db, t.id)!.lease_until! + 1);
    expect(expired.map((x) => x.id)).toContain(t.id);
    const after = getTask(db, t.id)!;
    expect(after.state).toBe("queued");
    expect(after.assignee).toBeNull();
    expect(after.lease_token).toBe(2);
  });

  test("a missing worker's lapsed lease IS revoked (crash recovery)", () => {
    registerWorker(db, "ghost", { role: "worker" });
    const t = addTask(db, { title: "ghost work" });
    claimNext(db, "ghost");
    db.query(`DELETE FROM workers WHERE id = 'ghost'`).run();

    const expired = expireLeases(db, getTask(db, t.id)!.lease_until! + 1);
    expect(expired.map((x) => x.id)).toContain(t.id);
    expect(getTask(db, t.id)!.state).toBe("queued");
  });

  test("reconcile still requeues a transport-dead worker whose DB row looks fresh", async () => {
    managedWorker("w1", "worker");
    const t = addTask(db, { title: "killed" });
    claimNext(db, "w1");
    rt.setAlive("w1", false);

    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("dead:w1");
    expect(actions).toContain(`requeued:${t.id}`);
    expect(getTask(db, t.id)!.state).toBe("queued");
  });

  test("reconcile holds a lapsed lease while the Herdr agent is still alive", async () => {
    managedWorker("w1", "worker");
    const t = addTask(db, { title: "long build" });
    claimNext(db, "w1");
    const leaseUntil = getTask(db, t.id)!.lease_until!;
    // The worker has run no relay command for a long time (one long tool call),
    // so its DB liveness looks stale and the lease has lapsed...
    db.query(`UPDATE workers SET last_seen_at = 0, last_progress_at = 0 WHERE id = 'w1'`).run();
    // ...but its Herdr agent is still there, so this is NOT a crash.
    rt.setAlive("w1", true);

    const { actions } = await reconcile(db, rt, leaseUntil + 1);
    expect(actions).not.toContain(`lease-expired:${t.id}`);
    const after = getTask(db, t.id)!;
    expect(after.state).toBe("running");
    expect(after.assignee).toBe("w1");
  });

  test("reconcile still expires a lapsed lease once the Herdr agent is gone", async () => {
    managedWorker("w1", "worker");
    const t = addTask(db, { title: "vanished" });
    claimNext(db, "w1");
    const leaseUntil = getTask(db, t.id)!.lease_until!;
    db.query(`UPDATE workers SET last_seen_at = 0, last_progress_at = 0 WHERE id = 'w1'`).run();
    rt.setAlive("w1", false);

    const { actions } = await reconcile(db, rt, leaseUntil + 1);
    expect(actions).toContain(`lease-expired:${t.id}`);
    expect(getTask(db, t.id)!.state).toBe("queued");
  });

  test("an idle worker still holding a running task is nudged, not skipped", async () => {
    managedWorker("w1", "worker");
    const t = addTask(db, { title: "premature stop" });
    claimNext(db, "w1");
    // A session rebind used to force this exact drift: idle while owning a task.
    db.query(`UPDATE workers SET state = 'idle', last_progress_at = 0, nudged_at = NULL WHERE id = 'w1'`).run();

    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("nudge:w1");
    expect(getWorker(db, "w1")!.nudged_at).not.toBeNull();
    expect(getTask(db, t.id)!.state).toBe("running");
  });

  test("a LAPSED lease does not suppress the nudge for a live worker", async () => {
    managedWorker("w1", "worker");
    const t = addTask(db, { title: "lapsed but alive" });
    claimNext(db, "w1");
    const leaseUntil = getTask(db, t.id)!.lease_until!;
    db.query(`UPDATE workers SET last_progress_at = 0, nudged_at = NULL WHERE id = 'w1'`).run();
    rt.setAlive("w1", true); // transport alive => lease held, not revoked

    const { actions } = await reconcile(db, rt, leaseUntil + 1);
    expect(actions).not.toContain(`lease-expired:${t.id}`);
    expect(actions).toContain("nudge:w1");
    expect(getTask(db, t.id)!.state).toBe("running");
  });
});
