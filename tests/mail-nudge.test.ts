import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { listEvents } from "../src/events";
import { sendMessage } from "../src/messages";
import { reconcile } from "../src/reconciler";
import { MockRuntime } from "../src/runtime/runtime";
import { addTask, approveTask, blockTask, claimTask, submitTask, waitTask } from "../src/tasks";
import { registerWorker } from "../src/workers";

// The send-time wake is best-effort, so the daemon nudges durable unread mail —
// but T329 changed the policy: ONLY actionable kinds (child_done/…/urgent) are
// nudged, and even those never interrupt a worker that is mid-turn.

let dir = "";
let db: Database;
let rt: MockRuntime;
const savedWindow = process.env.RELAY_MAIL_NUDGE_MS;
const savedCap = process.env.RELAY_MAIL_STARVATION_MS;
const savedOrd = process.env.RELAY_MAIL_ORDINARY_STARVATION_MS;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-mail-"));
  db = openDb(join(dir, "state.db"));
  rt = new MockRuntime();
  process.env.RELAY_MAIL_NUDGE_MS = "1"; // window passes immediately
  delete process.env.RELAY_MAIL_STARVATION_MS;
  delete process.env.RELAY_MAIL_ORDINARY_STARVATION_MS;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  if (savedWindow === undefined) delete process.env.RELAY_MAIL_NUDGE_MS;
  else process.env.RELAY_MAIL_NUDGE_MS = savedWindow;
  if (savedCap === undefined) delete process.env.RELAY_MAIL_STARVATION_MS;
  else process.env.RELAY_MAIL_STARVATION_MS = savedCap;
  if (savedOrd === undefined) delete process.env.RELAY_MAIL_ORDINARY_STARVATION_MS;
  else process.env.RELAY_MAIL_ORDINARY_STARVATION_MS = savedOrd;
});

/** Send a message and backdate it so the nudge window has elapsed. */
function staleMessage(recipient: string, body = "hello", kind?: string): number {
  const id = sendMessage(db, "worker-a", recipient, body, { kind });
  db.query(`UPDATE messages SET created_at = ? WHERE id = ?`).run(Date.now() - 60_000, id);
  return id;
}

describe("periodic unread-mail nudge", () => {
  test("ordinary peer mail is DEFERRED while busy and delivered at idle (T339)", async () => {
    registerWorker(db, "worker-b", { role: "worker" });
    staleMessage("worker-b"); // kind defaults to "note"
    // Busy: an ordinary message must NOT interrupt.
    db.query(`UPDATE workers SET state='working' WHERE id='worker-b'`).run();
    process.env.RELAY_MAIL_STARVATION_MS = "600000";
    process.env.RELAY_MAIL_ORDINARY_STARVATION_MS = "600000";
    let r = await reconcile(db, rt);
    expect(r.actions).not.toContain("mail-nudged:worker-b");
    expect(listEvents(db, { limit: 50 }).some((e) => e.type === "worker.mail_nudge_deferred")).toBe(true);

    // Idle: the SAME ordinary message is delivered at the turn boundary.
    db.query(`UPDATE workers SET state='idle' WHERE id='worker-b'`).run();
    r = await reconcile(db, rt);
    expect(r.actions).toContain("mail-nudged:worker-b");
    // Still durable until read (reading it marks it delivered).
    expect(db.query(`SELECT COUNT(*) AS n FROM messages WHERE recipient='worker-b' AND state='queued'`).get()).toMatchObject({ n: 1 });
  });

  test("an ordinary (non-urgent) nudge uses the 'not urgent' text", async () => {
    registerWorker(db, "worker-b", { role: "worker" }); // idle
    staleMessage("worker-b", "an assignment");
    await reconcile(db, rt);
    const text = rt.wakes.find((w) => w.workerId === "worker-b")!.text;
    expect(text).toContain("Not urgent");
    expect(text).not.toContain("URGENT:");
  });

  test("an URGENT message (immediate kind) does nudge", async () => {
    registerWorker(db, "worker-b", { role: "worker" });
    staleMessage("worker-b", "interrupt!", "urgent");
    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("mail-nudged:worker-b");
    // Tagged as relay-originated, not a human/peer message.
    expect(rt.wakes.find((w) => w.workerId === "worker-b")!.text.startsWith("relay: ")).toBe(true);
  });

  test("a fresh URGENT message nudges immediately (immediate kind, no initial delay)", async () => {
    process.env.RELAY_MAIL_NUDGE_MS = "600000"; // large window
    registerWorker(db, "worker-b", { role: "worker" }); // idle
    sendMessage(db, "worker-a", "worker-b", "just sent", { kind: "urgent" }); // fresh
    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("mail-nudged:worker-b");
  });

  test("a completion notice to a BUSY parent owner is DEFERRED (never interrupts) (T329)", async () => {
    process.env.RELAY_MAIL_NUDGE_MS = "600000"; // large window
    registerWorker(db, "worker-b", { role: "worker" }); // parent owner (becomes working)
    registerWorker(db, "worker-c", { role: "worker" }); // child owner
    const parent = addTask(db, { title: "parent" });
    claimTask(db, parent.id, "worker-b");
    const child = addTask(db, { title: "child", parentTaskId: parent.id });
    claimTask(db, child.id, "worker-c");
    submitTask(db, child.id, "worker-c", { evidence: "x" });
    approveTask(db, child.id, "reviewer"); // fresh child_done message to worker-b

    const { actions } = await reconcile(db, rt);
    expect(actions).not.toContain("mail-nudged:worker-b");
    expect(listEvents(db, { limit: 50 }).some((e) => e.type === "worker.mail_nudge_deferred")).toBe(true);
  });

  test("a completion notice to an IDLE parent owner nudges immediately (no initial delay)", async () => {
    process.env.RELAY_MAIL_NUDGE_MS = "600000"; // large window
    registerWorker(db, "worker-b", { role: "worker" }); // parent owner
    registerWorker(db, "worker-c", { role: "worker" }); // child owner
    const parent = addTask(db, { title: "parent" });
    const child = addTask(db, { title: "child", parentTaskId: parent.id });
    // Parent is ASSIGNED to worker-b but worker-b is IDLE (not mid-turn).
    db.query(`UPDATE tasks SET assignee='worker-b' WHERE id=?`).run(parent.id);
    db.query(`UPDATE workers SET state='idle', current_task_id=? WHERE id='worker-b'`).run(parent.id);
    claimTask(db, child.id, "worker-c");
    submitTask(db, child.id, "worker-c", { evidence: "x" });
    approveTask(db, child.id, "reviewer"); // child_done message to worker-b

    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("mail-nudged:worker-b");
  });

  test("a blocked notice to an IDLE parent owner nudges immediately (no initial delay)", async () => {
    process.env.RELAY_MAIL_NUDGE_MS = "600000"; // large window
    registerWorker(db, "worker-b", { role: "worker" }); // parent owner
    registerWorker(db, "worker-c", { role: "worker" }); // child owner
    const parent = addTask(db, { title: "parent" });
    const child = addTask(db, { title: "child", parentTaskId: parent.id });
    db.query(`UPDATE tasks SET assignee='worker-b' WHERE id=?`).run(parent.id);
    db.query(`UPDATE workers SET state='idle' WHERE id='worker-b'`).run();
    claimTask(db, child.id, "worker-c");
    blockTask(db, child.id, "worker-c", "stuck", false);

    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("mail-nudged:worker-b");
  });
});

// T329: the nudge must NOT interrupt a worker that is mid-turn.
describe("mid-work deferral (T329)", () => {
  test("a WORKING worker is not nudged; the nudge is DEFERRED and logged", async () => {
    process.env.RELAY_MAIL_STARVATION_MS = "600000"; // keep the cap out of the way
    registerWorker(db, "worker-b", { role: "worker" });
    db.query(`UPDATE workers SET state='working' WHERE id='worker-b'`).run();
    staleMessage("worker-b", "interrupt!", "urgent");
    const { actions } = await reconcile(db, rt);
    expect(actions).not.toContain("mail-nudged:worker-b");
    expect(rt.wakes.map((w) => w.workerId)).not.toContain("worker-b");
    const deferred = listEvents(db, { limit: 50 }).find((e) => e.type === "worker.mail_nudge_deferred");
    expect(deferred).toBeTruthy();
    expect(JSON.parse(deferred!.payload_json ?? "{}").reason).toBe("working");
  });

  test("a worker running a live TOOL is not nudged", async () => {
    process.env.RELAY_MAIL_STARVATION_MS = "600000"; // keep the cap out of the way
    registerWorker(db, "worker-b", { role: "worker" });
    db.query(`UPDATE workers SET state='idle', tool_name='bash', tool_started_at=? WHERE id='worker-b'`).run(Date.now());
    staleMessage("worker-b", "interrupt!", "urgent");
    const { actions } = await reconcile(db, rt);
    expect(actions).not.toContain("mail-nudged:worker-b");
    const deferred = listEvents(db, { limit: 50 }).find((e) => e.type === "worker.mail_nudge_deferred");
    expect(JSON.parse(deferred!.payload_json ?? "{}").reason).toBe("tool");
  });

  test("the transport saying isWorking() also defers (Hermes-busy worker row untouched)", async () => {
    process.env.RELAY_MAIL_STARVATION_MS = "600000"; // keep the cap out of the way
    registerWorker(db, "worker-b", { role: "worker" }); // state='idle', no tool
    rt.setWorking("worker-b", true);
    staleMessage("worker-b", "interrupt!", "urgent");
    const { actions } = await reconcile(db, rt);
    expect(actions).not.toContain("mail-nudged:worker-b");
    const deferred = listEvents(db, { limit: 50 }).find((e) => e.type === "worker.mail_nudge_deferred");
    expect(JSON.parse(deferred!.payload_json ?? "{}").reason).toBe("busy");
  });

  test("STARVATION CAP: a continuously busy worker is nudged once past the cap", async () => {
    process.env.RELAY_MAIL_NUDGE_MS = "600000";  // long window
    process.env.RELAY_MAIL_STARVATION_MS = "1000"; // short cap
    registerWorker(db, "worker-b", { role: "worker" });
    db.query(`UPDATE workers SET state='working' WHERE id='worker-b'`).run();
    const id = sendMessage(db, "worker-a", "worker-b", "interrupt!", { kind: "urgent" });
    db.query(`UPDATE messages SET created_at = ? WHERE id = ?`).run(Date.now() - 5000, id); // past the cap

    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("mail-nudged:worker-b");
    const nudged = listEvents(db, { limit: 50 }).find((e) => e.type === "worker.mail_nudged");
    expect(JSON.parse(nudged!.payload_json ?? "{}").starvation).toBe(true);
  });

  test("the deferred nudge fires once the worker goes idle", async () => {
    process.env.RELAY_MAIL_STARVATION_MS = "600000"; // keep the cap out of the way
    registerWorker(db, "worker-b", { role: "worker" });
    db.query(`UPDATE workers SET state='working' WHERE id='worker-b'`).run();
    staleMessage("worker-b", "interrupt!", "urgent");
    expect((await reconcile(db, rt)).actions).not.toContain("mail-nudged:worker-b");

    // The worker ends its turn.
    db.query(`UPDATE workers SET state='idle', tool_started_at=NULL WHERE id='worker-b'`).run();
    expect((await reconcile(db, rt)).actions).toContain("mail-nudged:worker-b");
  });

  test("a QUIET worker is NOT deferred: quiet is the explicit 'resume me' signal", async () => {
    process.env.RELAY_MAIL_STARVATION_MS = "600000"; // keep the cap out of the way
    registerWorker(db, "worker-b", { role: "worker" });
    // working + a bounded quiet lease on its current task = deliberately paused.
    const held = addTask(db, { title: "held" });
    claimTask(db, held.id, "worker-b");
    waitTask(db, held.id, "worker-b", 3_600_000, "await children");
    db.query(`UPDATE workers SET state='working' WHERE id='worker-b'`).run();
    staleMessage("worker-b", "interrupt!", "urgent");
    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("mail-nudged:worker-b");
  });
});

// T329 follow-up (reviewer-4): three defects in the first cut.
describe("starvation clock, deferred-log cooldown, urgent text (T329 follow-up)", () => {
  test("a stale ORDINARY message does NOT set the IMMEDIATE starvation clock", async () => {
    process.env.RELAY_MAIL_NUDGE_MS = "600000";
    process.env.RELAY_MAIL_STARVATION_MS = "600000";       // immediate cap
    process.env.RELAY_MAIL_ORDINARY_STARVATION_MS = "7200000"; // ordinary cap (2h)
    registerWorker(db, "worker-b", { role: "worker" });
    db.query(`UPDATE workers SET state='working' WHERE id='worker-b'`).run();
    // Ordinary message OLDER than the immediate cap but YOUNGER than its own cap:
    // it must NOT make the immediate clock stale and nudge a mid-turn worker.
    const old = sendMessage(db, "worker-a", "worker-b", "ancient fyi", { kind: "note" });
    db.query(`UPDATE messages SET created_at=? WHERE id=?`).run(Date.now() - 3_600_000, old);
    staleMessage("worker-b", "interrupt!", "urgent");

    const { actions } = await reconcile(db, rt);
    expect(actions).not.toContain("mail-nudged:worker-b"); // stays deferred
  });

  test("a stale ORDINARY message eventually nudges on its own (longer) cap", async () => {
    process.env.RELAY_MAIL_NUDGE_MS = "600000";
    process.env.RELAY_MAIL_STARVATION_MS = "600000";
    process.env.RELAY_MAIL_ORDINARY_STARVATION_MS = "600000";
    registerWorker(db, "worker-b", { role: "worker" });
    db.query(`UPDATE workers SET state='working' WHERE id='worker-b'`).run();
    const old = sendMessage(db, "worker-a", "worker-b", "very old fyi", { kind: "note" });
    db.query(`UPDATE messages SET created_at=? WHERE id=?`).run(Date.now() - 3_600_000, old);

    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("mail-nudged:worker-b"); // starvation, not poisoning
  });

  test("a stale IMMEDIATE message past the cap DOES nudge (starvation still works)", async () => {
    process.env.RELAY_MAIL_NUDGE_MS = "600000";
    process.env.RELAY_MAIL_STARVATION_MS = "1000"; // short cap
    registerWorker(db, "worker-b", { role: "worker" });
    db.query(`UPDATE workers SET state='working' WHERE id='worker-b'`).run();
    const id = sendMessage(db, "worker-a", "worker-b", "old urgent", { kind: "urgent" });
    db.query(`UPDATE messages SET created_at=? WHERE id=?`).run(Date.now() - 5000, id);

    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("mail-nudged:worker-b");
    const nudged = listEvents(db, { limit: 50 }).find((e) => e.type === "worker.mail_nudged");
    expect(JSON.parse(nudged!.payload_json).starvation).toBe(true);
  });

  test("worker.mail_nudge_deferred is cooldown-limited (no per-tick spam)", async () => {
    process.env.RELAY_MAIL_NUDGE_MS = "600000";
    process.env.RELAY_MAIL_STARVATION_MS = "600000";
    registerWorker(db, "worker-b", { role: "worker" });
    db.query(`UPDATE workers SET state='working' WHERE id='worker-b'`).run();
    staleMessage("worker-b", "interrupt!", "urgent");
    for (let i = 0; i < 20; i++) await reconcile(db, rt);
    const deferred = listEvents(db, { limit: 500 }).filter((e) => e.type === "worker.mail_nudge_deferred");
    expect(deferred.length).toBeLessThanOrEqual(1);
  });

  test("an URGENT nudge says URGENT, not 'not urgent'", async () => {
    registerWorker(db, "worker-b", { role: "worker" }); // idle
    staleMessage("worker-b", "interrupt!", "urgent");
    await reconcile(db, rt);
    expect(rt.wakes.find((w) => w.workerId === "worker-b")!.text).toContain("URGENT");
  });

  test("a completion notice keeps the 'not urgent' text", async () => {
    registerWorker(db, "worker-b", { role: "worker" }); // idle parent owner
    const parent = addTask(db, { title: "parent" });
    registerWorker(db, "worker-c", { role: "worker" });
    const child = addTask(db, { title: "child", parentTaskId: parent.id });
    db.query(`UPDATE tasks SET assignee='worker-b' WHERE id=?`).run(parent.id);
    claimTask(db, child.id, "worker-c");
    submitTask(db, child.id, "worker-c", { evidence: "x" });
    approveTask(db, child.id, "reviewer");
    await reconcile(db, rt);
    const text = rt.wakes.find((w) => w.workerId === "worker-b")!.text;
    expect(text).toContain("Not urgent");
    expect(text).not.toContain("URGENT:");
  });
});
