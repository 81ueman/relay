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
import { addTask, claimTask, submitTask } from "../src/tasks";
import { getWorker, registerWorker, setWorkerState } from "../src/workers";

// T345: in-flight/backgrounded tool bookkeeping, an overdue signal that does not
// wait out a long declared budget, and an effective review-pending wake cooldown.
//
// A worker is only "operational" (supervised) with a MANAGED session, so these
// tests attach one — otherwise idleWorkers()/processInFlightTools skip it.

let dir = "";
let db: Database;
let rt: MockRuntime;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-bgtool-"));
  process.env.RELAY_WAKE_COOLDOWN_MS = "0";
  delete process.env.RELAY_TOOL_HARD_CAP_MS;
  delete process.env.RELAY_TOOL_NO_OUTPUT_MS;
  db = openDb(join(dir, "state.db"));
  rt = new MockRuntime();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function managed(id: string, role = "worker"): void {
  registerWorker(db, id, { role, runtimeId: `${id}-agent` });
  attachSession(db, `ses_${id}`, {
    role, workerId: id,
    identity: { agent: `${id}-agent`, tabId: `tab-${id}`, paneId: `pane-${id}`, workspaceId: "w", agentKind: "opencode" },
  });
  setWorkerState(db, id, "idle");
  rt.setAlive(id, true);
}

/** Put a live tool marker on a worker, `ageMs` in the past, with an optional budget. */
function holdTool(id: string, ageMs: number, toolTimeoutMs?: number): void {
  db.query(`UPDATE workers SET tool_name='bash', tool_command='sleep', tool_started_at=?, tool_timeout_ms=?, state='working' WHERE id=?`)
    .run(Date.now() - ageMs, toolTimeoutMs ?? null, id);
}

const toolMarker = (id: string) =>
  (db.query(`SELECT tool_started_at FROM workers WHERE id=?`).get(id) as { tool_started_at: number | null });

describe("overdue signal does not wait out a long declared budget (T345b)", () => {
  test("a long-budget tool past the no-output window is surfaced as tool_overdue", async () => {
    managed("w1");
    // 40-minute budget, ~12 minutes in, no output: overdue, but NOT backgrounded
    // yet (within the declared budget) — it must at least be VISIBLE.
    holdTool("w1", 700_000, 2_400_000);
    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("tool-overdue:w1");
    expect(listEvents(db, { limit: 50 }).some((e) => e.type === "worker.tool_overdue")).toBe(true);
    expect(actions).not.toContain("tool-backgrounded:w1");
  });

  test("a wedged long-budget tool IS backgrounded once it passes the HARD CAP", async () => {
    managed("w1");
    process.env.RELAY_TOOL_HARD_CAP_MS = "1000"; // tiny cap for the test
    holdTool("w1", 60_000, 2_400_000); // 1 min in, 40-min budget, past the 1s cap
    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("tool-backgrounded:w1");
  });

  test("a short-budget tool is backgrounded past its own budget (unchanged)", async () => {
    managed("w1");
    // Declared 1s, grace 60s => bg once age > 61s; stale only past 121s.
    holdTool("w1", 90_000, 1_000);
    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("tool-backgrounded:w1");
  });
});

describe("background makes state and the tool marker AGREE (T345a)", () => {
  test("after Ctrl-B the tool marker is cleared (not left set forever)", async () => {
    managed("w1");
    process.env.RELAY_TOOL_HARD_CAP_MS = "1000";
    holdTool("w1", 60_000, 2_400_000);
    await reconcile(db, rt);
    expect(toolMarker("w1").tool_started_at).toBeNull();
  });

  test("a backgrounded worker becomes idleWorkers-eligible again", async () => {
    managed("w1");
    db.query(`UPDATE workers SET current_task_id=NULL, state='working' WHERE id='w1'`).run();
    process.env.RELAY_TOOL_HARD_CAP_MS = "1000";
    holdTool("w1", 60_000, 2_400_000);
    await reconcile(db, rt);
    // Marker cleared AND no stale "busy" signal: the worker is genuinely idle.
    expect(toolMarker("w1").tool_started_at).toBeNull();
    expect(getWorker(db, "w1")!.state).toBe("idle");
  });
});

describe("review-pending wake is cooldown/change limited (T345c)", () => {
  function seedReview(): void {
    managed("rev", "reviewer");
    managed("dev", "worker");
    const t = addTask(db, { title: "impl" });
    claimTask(db, t.id, "dev");
    submitTask(db, t.id, "dev", { evidence: "x" }); // -> review
  }

  test("an idle reviewer is woken ONCE for new review work, not every tick", async () => {
    seedReview();
    const first = await reconcile(db, rt);
    expect(first.actions.some((a) => a.startsWith("reviewer-woken"))).toBe(true);
    const after = rt.wakes.filter((w) => w.workerId === "rev").length;

    // Unchanged review work, many ticks: no more reviewer wakes.
    for (let i = 0; i < 5; i++) await reconcile(db, rt);
    expect(rt.wakes.filter((w) => w.workerId === "rev").length).toBe(after);
  });

  test("NEW review work after the last wake wakes the reviewer again", async () => {
    seedReview();
    await reconcile(db, rt);
    const after = rt.wakes.filter((w) => w.workerId === "rev").length;

    // A NEW review task (updated_at newer than the last review wake). Create it
    // directly in review to avoid depending on another worker's availability.
    const t2 = addTask(db, { title: "impl2" });
    db.query(`UPDATE tasks SET state='review', updated_at=? WHERE id=?`).run(Date.now() + 1000, t2.id);
    await reconcile(db, rt);
    expect(rt.wakes.filter((w) => w.workerId === "rev").length).toBeGreaterThan(after);
  });
});
