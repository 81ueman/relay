import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { listEvents } from "../src/events";
import { reconcile } from "../src/reconciler";
import { MockRuntime, type HerdrIdentity } from "../src/runtime/runtime";
import { attachSession } from "../src/sessions";
import { addTask, claimNext } from "../src/tasks";
import { registerWorker, getWorker, setWorkerContext } from "../src/workers";
import { buildDashboardView } from "../src/dashboard/model";

// T549 RELAY-HIGH-CONTEXT-IDLE-STALL.
//
// Live 2026-09-23: worker rust-http sat idle at ~311K-314K context with runnable
// T543/T544 queued for its role. The supervisor woke it (`worker.woken`,
// "no-working-worker") every few seconds, the session answered `session.idle`,
// and it NEVER claimed. Neither `relay send` nor a direct `herdr agent prompt`
// made it act; only manual detach + respawn recovered it.
//
// The defect is the SILENT idle: a live-but-wedged worker was re-woken forever
// with no explicit escalation. This pins the fix: after `unresponsiveWakeCount`
// wakes without a claim the worker is surfaced as `worker.wake_unresponsive`
// (once per window) and shows in dashboard ATTENTION.

const KEYS = [
  "RELAY_DB", "RELAY_STALL_MS", "RELAY_LEASE_MS", "RELAY_WAKE_COOLDOWN_MS",
  "RELAY_UNRESPONSIVE_WAKES", "RELAY_UNRESPONSIVE_WINDOW_MS", "RELAY_CONTEXT_WEDGE_TOKENS",
];

let dir = "";
let db: Database;
let rt: MockRuntime;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-wedged-"));
  process.env.RELAY_DB = join(dir, "state.db");
  process.env.RELAY_LEASE_MS = "120000";
  process.env.RELAY_STALL_MS = "60000";
  process.env.RELAY_WAKE_COOLDOWN_MS = "0";
  process.env.RELAY_UNRESPONSIVE_WAKES = "3";
  process.env.RELAY_UNRESPONSIVE_WINDOW_MS = "300000";
  delete process.env.RELAY_AUTO_APPROVE;
  db = openDb(process.env.RELAY_DB);
  rt = new MockRuntime();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  for (const k of KEYS) delete process.env[k];
});

function identityFor(id: string, runtimeId: string): HerdrIdentity {
  return { agent: runtimeId, tabId: `tab-${id}`, paneId: `pane-${id}`, workspaceId: "w-test", agentKind: "opencode" };
}

function managedWorker(id: string, role = "worker", runtimeId = `${id}-agent`): void {
  registerWorker(db, id, { role, runtimeId });
  attachSession(db, `ses_${id}`, { role, workerId: id, identity: identityFor(id, runtimeId) });
  rt.setAlive(id, true);
}

function eventTypes(): string[] {
  return listEvents(db, { limit: 10000 }).map((e) => e.type);
}

function unresponsiveCount(): number {
  return eventTypes().filter((t) => t === "worker.wake_unresponsive").length;
}

describe("T549: a woken-but-never-claiming idle worker is surfaced, never silently idle", () => {
  test("three wakes without a claim raise worker.wake_unresponsive once", async () => {
    managedWorker("rust-http", "rust-http");
    // Runnable, role-matched work the worker CAN claim — it just never does.
    addTask(db, { title: "T543 work", role: "rust-http" });

    const t0 = Date.now();
    await reconcile(db, rt, t0 + 1_000); // wake 1
    expect(unresponsiveCount()).toBe(0);

    await reconcile(db, rt, t0 + 2_000); // wake 2
    expect(unresponsiveCount()).toBe(0);

    const r = await reconcile(db, rt, t0 + 3_000); // wake 3: threshold crossed
    expect(unresponsiveCount()).toBe(1);
    expect(r.actions).toContain("unresponsive:rust-http");
    // Still idle — the defect is that nothing was visible, not that the state
    // changed. The worker remains a live managed session.
    expect(getWorker(db, "rust-http")!.state).toBe("idle");
  });

  test("the surfaced event is logged once per window, not every reconcile", async () => {
    managedWorker("rust-http", "rust-http");
    addTask(db, { title: "T543 work", role: "rust-http" });

    const t0 = Date.now();
    for (let i = 1; i <= 3; i++) await reconcile(db, rt, t0 + i * 1_000);
    expect(unresponsiveCount()).toBe(1);

    // More passes inside the window: no repeat.
    for (let i = 4; i <= 8; i++) await reconcile(db, rt, t0 + i * 1_000);
    expect(unresponsiveCount()).toBe(1);
  });

  test("a worker that CLAIMS before the threshold is never flagged unresponsive", async () => {
    managedWorker("rust-http", "rust-http");
    addTask(db, { title: "T543 work", role: "rust-http" });

    const t0 = Date.now();
    await reconcile(db, rt, t0 + 1_000); // wake 1
    // The worker wakes and claims before the third wake: it is responsive.
    claimNext(db, "rust-http");
    await reconcile(db, rt, t0 + 2_000); // no longer idle -> not a candidate
    await reconcile(db, rt, t0 + 3_000);
    expect(unresponsiveCount()).toBe(0);
  });

  test("low-context idleness is not misreported as a context wedge", async () => {
    managedWorker("rust-http", "rust-http");
    addTask(db, { title: "T543 work", role: "rust-http" });

    const t0 = Date.now();
    for (let i = 1; i <= 3; i++) await reconcile(db, rt, t0 + i * 1_000);
    const ev = listEvents(db, { limit: 10000 }).find((e) => e.type === "worker.wake_unresponsive");
    expect(ev).toBeDefined();
    const p = JSON.parse(ev!.payload_json) as { highContext: boolean };
    expect(p.highContext).toBe(false);
  });

  test("a high-context wedge is reported with the token figure", async () => {
    managedWorker("rust-http", "rust-http");
    // Reproduce the live shape: a huge context metric on the worker row.
    setWorkerContext(db, "rust-http", 314000);
    addTask(db, { title: "T543 work", role: "rust-http" });

    const t0 = Date.now();
    for (let i = 1; i <= 3; i++) await reconcile(db, rt, t0 + i * 1_000);

    const ev = listEvents(db, { limit: 10000 }).find((e) => e.type === "worker.wake_unresponsive");
    expect(ev).toBeDefined();
    const p = JSON.parse(ev!.payload_json) as { highContext: boolean; usedTokens: number };
    expect(p.highContext).toBe(true);
    expect(p.usedTokens).toBe(314000);
  });

  test("dashboard ATTENTION surfaces the wedged worker", async () => {
    managedWorker("rust-http", "rust-http");
    addTask(db, { title: "T543 work", role: "rust-http" });

    const t0 = Date.now();
    for (let i = 1; i <= 3; i++) await reconcile(db, rt, t0 + i * 1_000);

    const view = buildDashboardView(db, { root: dir, panes: null, at: t0 + 3_000 });
    const row = view.attention.find((a) => a.id === "rust-http" && a.kind === "worker");
    expect(row?.text ?? "").toContain("woken repeatedly");
    expect(row?.text ?? "").toContain("wedged");
  });

  test("dashboard ATTENTION drops the row once the window has passed (recovered worker)", async () => {
    managedWorker("rust-http", "rust-http");
    addTask(db, { title: "T543 work", role: "rust-http" });

    const t0 = Date.now();
    for (let i = 1; i <= 3; i++) await reconcile(db, rt, t0 + i * 1_000);
    const flagged = buildDashboardView(db, { root: dir, panes: null, at: t0 + 3_000 });
    expect(flagged.attention.some((a) => a.id === "rust-http" && a.text.includes("woken repeatedly"))).toBe(true);

    // Past the unresponsive window with no fresh event: the row is stale history.
    const later = buildDashboardView(db, { root: dir, panes: null, at: t0 + 3_000 + 300_001 });
    expect(later.attention.some((a) => a.id === "rust-http" && a.text.includes("woken repeatedly"))).toBe(false);
  });
});
