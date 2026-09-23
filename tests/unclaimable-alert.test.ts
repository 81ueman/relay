import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { reconcile } from "../src/reconciler";
import { MockRuntime, type HerdrIdentity } from "../src/runtime/runtime";
import { attachSession } from "../src/sessions";
import { addTask, claimNext } from "../src/tasks";
import { registerWorker } from "../src/workers";

// T516: a task that becomes runnable while its role matches NO registered worker
// is offered to nobody. Relay detected it (status Attention) but only PASSIVELY,
// and the supervisor's unclaimable branch was masked by an idle worker of another
// role (`wake-suppressed`) or by a successful wake for other work. The fix pushes
// a durable message to the responsible owner, evaluated independently of the wake
// loop, bounded by a cooldown.

let dir = "";
let db: Database;
let rt: MockRuntime;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-unclaimable-"));
  process.env.RELAY_DB = join(dir, "state.db");
  process.env.RELAY_LEASE_MS = "120000";
  process.env.RELAY_STALL_MS = "60000";
  process.env.RELAY_WAKE_COOLDOWN_MS = "0";
  process.env.RELAY_UNCLAIMABLE_ALERT_MS = "60000";
  delete process.env.RELAY_AUTO_APPROVE;
  delete process.env.RELAY_HUMAN;
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

function messagesFor(id: string): { kind: string; task_id: string | null }[] {
  return db
    .query(`SELECT kind, task_id FROM messages WHERE recipient = ?`)
    .all(id) as { kind: string; task_id: string | null }[];
}

function eventsOfType(type: string): { task_id: string | null }[] {
  return db.query(`SELECT task_id FROM events WHERE type = ?`).all(type) as { task_id: string | null }[];
}

/** A coordinator holding a running parent, with an unclaimable child under it. */
function coordinatorWithUnclaimableChild(): { parent: string; child: string } {
  managedWorker("coord", "coordinator");
  const parent = addTask(db, { title: "workstream", role: "coordinator" });
  claimNext(db, "coord");
  const child = addTask(db, { title: "needs a sym-cond worker", role: "sym-cond", parentTaskId: parent.id });
  return { parent: parent.id, child: child.id };
}

describe("T516: unclaimable runnable work notifies the responsible owner", () => {
  test("a durable message reaches the parent's assignee (the responsible owner)", async () => {
    const { child } = coordinatorWithUnclaimableChild();

    const r = await reconcile(db, rt);

    expect(r.view.unclaimable).toBe(1);
    expect(r.actions).toContain(`unclaimable:${child}`);
    const msg = messagesFor("coord").find((m) => m.kind === "unclaimable_role");
    expect(msg).toBeDefined();
    expect(msg!.task_id).toBe(child);
    expect(eventsOfType("task.unclaimable_notified").some((e) => e.task_id === child)).toBe(true);
  });

  test("NOT masked by a successful wake for another role's work", async () => {
    const { child } = coordinatorWithUnclaimableChild();
    // A second, idle worker with its OWN claimable work: the wake loop succeeds
    // (woken=true), which used to skip the whole unclaimable branch.
    managedWorker("helper", "helper-role");
    addTask(db, { title: "helper work", role: "helper-role" });

    const r = await reconcile(db, rt);

    expect(r.actions).toContain("woken:helper");
    expect(r.actions).toContain(`unclaimable:${child}`);
    expect(messagesFor("coord").some((m) => m.kind === "unclaimable_role" && m.task_id === child)).toBe(true);
  });

  test("NOT masked by an idle worker of another role (wake-suppressed)", async () => {
    const { child } = coordinatorWithUnclaimableChild();
    // helper has claimable work, but a long wake cooldown means the wake is
    // suppressed -> woken=false -> the old code reported 'wake-suppressed'.
    process.env.RELAY_WAKE_COOLDOWN_MS = "600000";
    process.env.RELAY_UNCLAIMABLE_ALERT_MS = "0"; // always alert: isolate the masking
    managedWorker("helper", "helper-role");
    addTask(db, { title: "helper work", role: "helper-role" });
    await reconcile(db, rt); // first pass wakes helper, consuming the cooldown
    rt.wakes.length = 0;

    const r = await reconcile(db, rt);

    expect(r.actions).toContain("wake-suppressed");
    expect(r.actions).toContain(`unclaimable:${child}`);
  });

  test("re-alert is bounded by the cooldown, not every tick", async () => {
    const { child } = coordinatorWithUnclaimableChild();

    const t0 = Date.now();
    await reconcile(db, rt, t0);
    expect(messagesFor("coord").filter((m) => m.kind === "unclaimable_role").length).toBe(1);

    const within = await reconcile(db, rt, t0 + 1000);
    expect(within.actions).not.toContain(`unclaimable:${child}`);
    expect(messagesFor("coord").filter((m) => m.kind === "unclaimable_role").length).toBe(1);

    const after = await reconcile(db, rt, t0 + 61_000);
    expect(after.actions).toContain(`unclaimable:${child}`);
    expect(messagesFor("coord").filter((m) => m.kind === "unclaimable_role").length).toBe(2);
  });

  test("no assigned ancestor: logged LOUD as unrouted, no message sent", async () => {
    managedWorker("coord", "coordinator");
    // Parentless unclaimable task: nothing to resolve an owner from.
    const orphan = addTask(db, { title: "nobody can take this", role: "ghost-role" });

    const r = await reconcile(db, rt);

    expect(r.actions).toContain(`unclaimable:${orphan.id}`);
    expect(eventsOfType("task.unclaimable_unrouted").some((e) => e.task_id === orphan.id)).toBe(true);
    expect(messagesFor("coord")).toEqual([]);
  });
});
