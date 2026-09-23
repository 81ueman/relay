import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { sendMessage } from "../src/messages";
import { reconcile } from "../src/reconciler";
import { MockRuntime, type HerdrIdentity } from "../src/runtime/runtime";
import { attachSession } from "../src/sessions";
import { addTask } from "../src/tasks";
import { registerWorker } from "../src/workers";

// T542: when a worker's wake channel is UNROUTABLE (logical runtime_id with no
// live agent) the supervisor must not retry+log every tick — 326+ wake_failed
// events. It backs off like a delivered nudge and marks the channel unroutable.
// (Target RESOLUTION is fixed in resolveHerdrTarget; this pins the no-spin bound.)

let dir = "";
let db: Database;
let rt: MockRuntime;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-unroutable-"));
  process.env.RELAY_DB = join(dir, "state.db");
  process.env.RELAY_LEASE_MS = "120000";
  process.env.RELAY_STALL_MS = "60000";
  process.env.RELAY_WAKE_COOLDOWN_MS = "600000";
  process.env.RELAY_MAIL_NUDGE_MS = "600000";
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

function count(type: string): number {
  return (db.query(`SELECT COUNT(*) AS n FROM events WHERE type = ?`).get(type) as { n: number }).n;
}

describe("T542: an unroutable wake channel does not spin", () => {
  test("mail wake: one failure per window, then a retry after it", async () => {
    managedWorker("coord", "coordinator");
    sendMessage(db, "relay", "coord", "hello", { kind: "note" });
    rt.failWake.add("coord");

    const t0 = Date.now();
    await reconcile(db, rt, t0);
    expect(count("worker.wake_failed")).toBe(1);
    expect(count("worker.wake_unroutable")).toBe(1);

    await reconcile(db, rt, t0 + 1000); // inside the window: backed off
    expect(count("worker.wake_failed")).toBe(1);

    await reconcile(db, rt, t0 + 601_000); // past it: one more attempt
    expect(count("worker.wake_failed")).toBe(2);
  });

  test("idle wake: a failed nudge is logged once per wake cooldown", async () => {
    managedWorker("helper", "helper-role");
    addTask(db, { title: "helper work", role: "helper-role" });
    rt.failWake.add("helper");

    const t0 = Date.now();
    await reconcile(db, rt, t0);
    expect(count("worker.wake_failed")).toBe(1);
    expect(count("worker.wake_unroutable")).toBe(1);

    await reconcile(db, rt, t0 + 1000); // still inside the cooldown
    expect(count("worker.wake_failed")).toBe(1);
  });
});
