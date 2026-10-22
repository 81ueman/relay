import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { reconcile } from "../src/reconciler";
import { MockRuntime } from "../src/runtime/runtime";
import { addTask } from "../src/tasks";

// The no-idle-worker branch runs on every tick while the fleet is saturated.
// Logging it unconditionally grew the event log by one row per tick (live: ~73K
// rows, 61% of all events) and made every reconcile scan slower. It must log on
// a view change, and re-log an unchanged view only once per window.

let dir = "";
let db: Database;
let rt: MockRuntime;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-no-idle-"));
  process.env.RELAY_DB = join(dir, "state.db");
  process.env.RELAY_NO_IDLE_LOG_WINDOW_MS = "600000";
  db = openDb(process.env.RELAY_DB);
  rt = new MockRuntime();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.RELAY_NO_IDLE_LOG_WINDOW_MS;
});

function count(): number {
  return (
    db.query(`SELECT COUNT(*) AS n FROM events WHERE type = 'supervisor.no_idle_worker'`).get() as { n: number }
  ).n;
}

describe("supervisor.no_idle_worker is logged on change, not every tick", () => {
  test("unchanged view: one row per window", async () => {
    addTask(db, { title: "queued" });
    const t0 = Date.now();

    for (let i = 0; i < 5; i++) {
      const r = await reconcile(db, rt, t0 + i * 1500);
      expect(r.actions).toContain("no-idle-worker");
    }
    expect(count()).toBe(1);

    await reconcile(db, rt, t0 + 600_000 + 5000);
    expect(count()).toBe(2);
  });

  test("changed view: logged immediately", async () => {
    addTask(db, { title: "first" });
    const t0 = Date.now();
    await reconcile(db, rt, t0);
    expect(count()).toBe(1);

    addTask(db, { title: "second" });
    await reconcile(db, rt, t0 + 1500);
    expect(count()).toBe(2);
  });
});
