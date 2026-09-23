import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { logEvent } from "../src/events";
import { reconcile } from "../src/reconciler";
import { MockRuntime, type HerdrIdentity } from "../src/runtime/runtime";
import { attachSession } from "../src/sessions";
import { addTask, claimNext, getTask, restoreTasksOrphanedByDeadWorker } from "../src/tasks";
import { getWorker, registerWorker } from "../src/workers";

// T523: a worker mid-turn (no plugin heartbeat during a long prompt) can be
// marked dead; its RUNNING assigned tasks are released to queued/unassigned.
// When the session then emits an event it is revived — and used to come back to
// an EMPTY program (live: program-coord-2 lost roots T199/T496/T503). A revive
// must re-adopt the tasks the transient dead window released.

let dir = "";
let db: Database;
let rt: MockRuntime;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-dead-revive-"));
  process.env.RELAY_DB = join(dir, "state.db");
  process.env.RELAY_LEASE_MS = "120000";
  process.env.RELAY_STALL_MS = "60000";
  process.env.RELAY_WAKE_COOLDOWN_MS = "0";
  process.env.RELAY_DEAD_RESTORE_MS = "60000";
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

/** Two running roots assigned to `coord`, then the exact post-transient-dead state. */
function transientDeadWindow(): { r1: string; r2: string } {
  managedWorker("coord", "coordinator");
  const r1 = addTask(db, { title: "root one", role: "coordinator" });
  claimNext(db, "coord");
  const r2 = addTask(db, { title: "root two", role: "coordinator" });
  claimNext(db, "coord");
  // Mark dead + release both roots, exactly as the dead path + lease expiry do.
  db.query(`UPDATE workers SET state = 'dead', current_task_id = NULL WHERE id = 'coord'`).run();
  for (const t of [r1, r2]) {
    db.query(
      `UPDATE tasks SET state = 'queued', assignee = NULL, lease_token = lease_token + 1, lease_until = NULL WHERE id = ?`
    ).run(t.id);
    logEvent(db, { source: "supervisor", workerId: "coord", taskId: t.id, type: "task.requeued_dead_worker" });
  }
  return { r1: r1.id, r2: r2.id };
}

describe("T523: transient dead + revive does not orphan running tasks", () => {
  test("an adopted worker revived by the supervisor re-adopts its released roots", async () => {
    const { r1, r2 } = transientDeadWindow();

    const res = await reconcile(db, rt);

    expect(res.actions).toContain("revived:coord");
    expect(getTask(db, r1)!.state).toBe("running");
    expect(getTask(db, r1)!.assignee).toBe("coord");
    expect(getTask(db, r2)!.state).toBe("running");
    expect(getTask(db, r2)!.assignee).toBe("coord");
    expect(getWorker(db, "coord")!.state).toBe("working");
    expect([r1, r2]).toContain(getWorker(db, "coord")!.current_task_id!);
  });

  test("a REAL dead worker (never revived) leaves its tasks queued", async () => {
    const { r1, r2 } = transientDeadWindow();
    rt.setAlive("coord", false); // transport truly gone; no revive

    await reconcile(db, rt);

    expect(getTask(db, r1)!.state).toBe("queued");
    expect(getTask(db, r1)!.assignee).toBeNull();
    expect(getTask(db, r2)!.state).toBe("queued");
  });

  test("re-adoption is bounded by RELAY_DEAD_RESTORE_MS", () => {
    const { r1 } = transientDeadWindow();
    const t0 = Date.now();
    // Past the grace window: the release is too old to reclaim.
    const restored = restoreTasksOrphanedByDeadWorker(db, "coord", t0 + 61_000);
    expect(restored).toEqual([]);
    expect(getTask(db, r1)!.state).toBe("queued");
    // Inside it: reclaimed.
    const ok = restoreTasksOrphanedByDeadWorker(db, "coord", t0);
    expect(ok).toContain(r1);
    expect(getTask(db, r1)!.state).toBe("running");
  });

  test("a task another worker picked up in the dead window is NOT stolen back", () => {
    const { r1, r2 } = transientDeadWindow();
    managedWorker("other", "coordinator");
    claimNext(db, "other"); // other takes one of the released roots
    const takenByOther = [r1, r2].find((id) => getTask(db, id)!.assignee === "other")!;
    const stillFree = [r1, r2].find((id) => id !== takenByOther)!;

    const restored = restoreTasksOrphanedByDeadWorker(db, "coord");

    expect(restored).toEqual([stillFree]);
    expect(getTask(db, takenByOther)!.assignee).toBe("other");
    expect(getTask(db, stillFree)!.assignee).toBe("coord");
  });
});
