import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { reconcile } from "../src/reconciler";
import { MockRuntime, type HerdrIdentity } from "../src/runtime/runtime";
import { attachSession } from "../src/sessions";
import { addTask, claimNext, getTask } from "../src/tasks";
import { getWorker, registerWorker } from "../src/workers";

// T532: a long model turn forwards NO plugin events, so event-only liveness
// expires and a LIVE, mid-turn session is declared dead — its program released
// and its (adopted) generation refused a restart every cooldown. Herdr knows the
// pane is `working`; that must count as alive.

let dir = "";
let db: Database;
let rt: MockRuntime;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-midturn-"));
  process.env.RELAY_DB = join(dir, "state.db");
  process.env.RELAY_LEASE_MS = "120000";
  process.env.RELAY_STALL_MS = "60000";
  process.env.RELAY_WAKE_COOLDOWN_MS = "0";
  process.env.RELAY_RESTART_COOLDOWN_MS = "30000";
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

function eventsOfType(type: string): number {
  return (db.query(`SELECT COUNT(*) AS n FROM events WHERE type = ?`).get(type) as { n: number }).n;
}

/** A coordinator mid-turn on a running root, with the isAlive probe failing. */
function midTurn(): string {
  managedWorker("coord", "coordinator");
  const root = addTask(db, { title: "root", role: "coordinator" });
  claimNext(db, "coord");
  rt.setAlive("coord", false); // stale/renamed target: probe fails...
  rt.setWorking("coord", true); // ...but Herdr reports the pane is WORKING
  return root.id;
}

describe("T532: a working pane is never declared dead", () => {
  test("isAlive=false + pane working => alive-by-pane, task kept", async () => {
    const root = midTurn();

    const r = await reconcile(db, rt);

    expect(r.actions).toContain("alive-by-pane:coord");
    expect(r.actions.some((a) => a.startsWith("dead:"))).toBe(false);
    expect(getWorker(db, "coord")!.state).not.toBe("dead");
    expect(getTask(db, root)!.state).toBe("running");
    expect(getTask(db, root)!.assignee).toBe("coord");
    expect(eventsOfType("worker.restart_refused")).toBe(0);
    expect(eventsOfType("worker.dead")).toBe(0);
  });

  test("a dead-marked worker whose pane is working is revived, not released", async () => {
    const root = midTurn();
    db.query(`UPDATE workers SET state = 'dead' WHERE id = 'coord'`).run();

    const r = await reconcile(db, rt);

    expect(r.actions).toContain("revived-by-pane:coord");
    expect(getWorker(db, "coord")!.state).toBe("working");
    expect(getTask(db, root)!.state).toBe("running");
    expect(getTask(db, root)!.assignee).toBe("coord");
  });

  test("a genuinely dead worker (pane NOT working) is still marked dead", async () => {
    const root = midTurn();
    rt.setWorking("coord", false);

    const r = await reconcile(db, rt);

    expect(r.actions).toContain("dead:coord");
    expect(getWorker(db, "coord")!.state).toBe("dead");
    expect(getTask(db, root)!.state).toBe("queued");
  });

  test("restart_refused is latched per generation (no repeated refusal log)", async () => {
    midTurn();
    rt.setWorking("coord", false); // genuinely not working: the refusal path runs
    const t0 = Date.now();

    await reconcile(db, rt, t0);
    expect(eventsOfType("worker.restart_refused")).toBe(1);

    // The worker is revived by an event and declared dead again after the
    // cooldown: the SAME generation must not log a second refusal.
    db.query(`UPDATE workers SET state = 'working' WHERE id = 'coord'`).run();
    await reconcile(db, rt, t0 + 60_000);
    expect(eventsOfType("worker.restart_refused")).toBe(1);
  });
});
