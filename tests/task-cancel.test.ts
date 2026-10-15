import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { listEvents } from "../src/events";
import { inboxFor } from "../src/messages";
import {
  addNote,
  addTask,
  approveTask,
  blockTask,
  cancelTask,
  claimTask,
  getNotes,
  getTask,
  notesClaimingApproval,
  runnableTasks,
  submitTask,
  taskCounts,
  unfinishedCount,
} from "../src/tasks";
import { getWorker, registerWorker } from "../src/workers";

// ISH-808: `relay task cancel` — the explicit terminal state `cancelled`,
// distinct from `done` (approved) and from the reversible `blocked_*` parks.
//
// These tests pin the acceptance criteria: the transition from every
// non-terminal source state, idempotency, the audited reason, exclusion from
// the runnable/wake/Attention surface, and one-hop roll-up that never pretends a
// cancelled child was `done`.

let dir = "";
let dbPath = "";
let db: Database;
const root = join(import.meta.dir, "..");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-cancel-"));
  dbPath = join(dir, "state.db");
  db = openDb(dbPath);
  registerWorker(db, "w1", { role: "worker" });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The `cancel` note bodies on a task (the durable audit trail). */
function cancelNotes(taskId: string): string[] {
  return getNotes(db, taskId)
    .filter((n) => n.kind === "cancel")
    .map((n) => n.body);
}

describe("cancelTask: the transition from each source state", () => {
  test("queued -> cancelled records the reason and leaves the runnable surface", () => {
    const t = addTask(db, { title: "superseded by T99" });
    expect(runnableTasks(db).map((x) => x.id)).toContain(t.id);

    cancelTask(db, t.id, "w1", "superseded by T99");

    const after = getTask(db, t.id)!;
    expect(after.state).toBe("cancelled");
    expect(after.assignee).toBeNull();
    expect(after.lease_until).toBeNull();
    // Reason durable in BOTH a note and an event.
    expect(cancelNotes(t.id)).toEqual(["superseded by T99"]);
    expect(
      listEvents(db).some((e) => e.type === "task.cancelled" && e.task_id === t.id)
    ).toBe(true);
    // Gone from the runnable/wake surface and the unfinished count.
    expect(runnableTasks(db).map((x) => x.id)).not.toContain(t.id);
    expect(unfinishedCount(db)).toBe(0);
    expect(taskCounts(db)["cancelled"]).toBe(1);
  });

  test("running -> cancelled releases the owner's pointer and lease", () => {
    const t = addTask(db, { title: "in flight" });
    claimTask(db, t.id, "w1");
    expect(getTask(db, t.id)!.state).toBe("running");
    expect(getWorker(db, "w1")!.current_task_id).toBe(t.id);

    cancelTask(db, t.id, "w1", "policy changed");

    expect(getTask(db, t.id)!.state).toBe("cancelled");
    expect(getWorker(db, "w1")!.current_task_id).toBeNull();
  });

  test("review -> cancelled", () => {
    const t = addTask(db, { title: "awaiting review" });
    claimTask(db, t.id, "w1");
    submitTask(db, t.id, "w1", { evidence: "x" });
    expect(getTask(db, t.id)!.state).toBe("review");

    cancelTask(db, t.id, "w1", "duplicate of T2");
    expect(getTask(db, t.id)!.state).toBe("cancelled");
  });

  test("blocked_internal and blocked_human -> cancelled", () => {
    const bi = addTask(db, { title: "parked internal" });
    blockTask(db, bi.id, "w1", "engine bug", false);
    expect(getTask(db, bi.id)!.state).toBe("blocked_internal");
    cancelTask(db, bi.id, "w1", "obsolete");
    expect(getTask(db, bi.id)!.state).toBe("cancelled");

    const bh = addTask(db, { title: "parked human" });
    blockTask(db, bh.id, "w1", "program closed", true);
    expect(getTask(db, bh.id)!.state).toBe("blocked_human");
    cancelTask(db, bh.id, "w1", "program closed");
    expect(getTask(db, bh.id)!.state).toBe("cancelled");
  });
});

describe("cancelTask: idempotence and terminal refusal", () => {
  test("re-cancelling is an audited no-op, never a second transition or note", () => {
    const t = addTask(db, { title: "once" });
    cancelTask(db, t.id, "w1", "first");
    const token = getTask(db, t.id)!.lease_token;

    const again = cancelTask(db, t.id, "w1", "second");
    expect(again.state).toBe("cancelled");
    expect(getTask(db, t.id)!.lease_token).toBe(token); // no lease bump on the retry
    expect(cancelNotes(t.id)).toEqual(["first"]); // no second note
    expect(listEvents(db).some((e) => e.type === "task.cancel_ignored")).toBe(true);
  });

  test("done and failed are refused (no mis-transition to/from done/failed)", () => {
    const done = addTask(db, { title: "approved" });
    claimTask(db, done.id, "w1");
    submitTask(db, done.id, "w1", { evidence: "x" });
    approveTask(db, done.id, "reviewer");
    expect(getTask(db, done.id)!.state).toBe("done");
    expect(() => cancelTask(db, done.id, "w1", "nope")).toThrow(/terminal state done/);
    expect(getTask(db, done.id)!.state).toBe("done"); // unchanged

    const failed = addTask(db, { title: "failed" });
    db.query(`UPDATE tasks SET state = 'failed' WHERE id = ?`).run(failed.id);
    expect(() => cancelTask(db, failed.id, "w1", "nope")).toThrow(/terminal state failed/);
    expect(getTask(db, failed.id)!.state).toBe("failed"); // unchanged
  });
});

describe("cancelTask: roll-up and Attention", () => {
  test("a cancelled child bubbles one-hop; the parent is never auto-done", () => {
    registerWorker(db, "p", { role: "worker" });
    const parent = addTask(db, { title: "parent" });
    claimTask(db, parent.id, "p");
    const child = addTask(db, { title: "child", parentTaskId: parent.id });

    cancelTask(db, child.id, "w1", "superseded");

    const notes = getNotes(db, parent.id);
    const bubbled = notes.find((n) => n.kind === "child_cancelled");
    expect(bubbled?.body).toContain(`${child.id} cancelled: superseded`);
    expect(bubbled?.body.startsWith("relay: ")).toBe(true);
    expect(inboxFor(db, "p").map((m) => m.kind)).toContain("child_cancelled");
    // The parent is told, never completed: no child_done/children_done.
    expect(getTask(db, parent.id)!.state).toBe("running");
    expect(notes.some((n) => n.kind === "children_done")).toBe(false);
  });

  test("a cancelled task is not surfaced as an APPROVE mismatch (Attention)", () => {
    const t = addTask(db, { title: "reviewed" });
    claimTask(db, t.id, "w1");
    submitTask(db, t.id, "w1", { evidence: "x" });
    addNote(db, t.id, "reviewer", "APPROVE");
    // While non-terminal the mismatch IS surfaced…
    expect(notesClaimingApproval(db).some((x) => x.task.id === t.id)).toBe(true);

    cancelTask(db, t.id, "w1", "superseded");

    // …and once cancelled it is terminal, so it must drop out of Attention.
    expect(notesClaimingApproval(db).some((x) => x.task.id === t.id)).toBe(false);
  });
});

// --- CLI surface -----------------------------------------------------------

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: "0", RELAY_DB: dbPath, RELAY_WORKER: "wtest" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stdout, stderr };
}

function withDb<T>(fn: (db: Database) => T): T {
  const d = openDb(dbPath);
  try {
    return fn(d);
  } finally {
    d.close();
  }
}

describe("relay task cancel (CLI)", () => {
  test("cancels the task, records the reason, and never lists it as runnable", async () => {
    const id = withDb((d) => {
      registerWorker(d, "wtest", { role: "worker" });
      return addTask(d, { title: "stale lane" }).id;
    });

    const res = await runCli(["task", "cancel", id, "--reason", "superseded by T999"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`${id} -> cancelled`);

    const after = withDb((d) => getTask(d, id)!);
    expect(after.state).toBe("cancelled");
    expect(withDb((d) => getNotes(d, id).find((n) => n.kind === "cancel")!.body)).toBe("superseded by T999");

    // status shows the cancelled bucket and keeps it out of Unclaimable/Attention.
    const status = await runCli(["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/cancelled\s+1/);
    expect(status.stdout).not.toContain(`${id}  role=`);
  });

  test("a missing reason fails closed (never persisted as the flag token)", async () => {
    const id = withDb((d) => {
      registerWorker(d, "wtest", { role: "worker" });
      return addTask(d, { title: "no reason" }).id;
    });
    const res = await runCli(["task", "cancel", id]);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/reason/i);
    expect(withDb((d) => getTask(d, id)!.state)).toBe("queued"); // unchanged
  });
});
