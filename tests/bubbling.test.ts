import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { inboxFor } from "../src/messages";
import { addTask, approveTask, claimNext, claimTask, getNotes, getTask, submitTask } from "../src/tasks";
import { registerWorker } from "../src/workers";

// One-hop completion bubbling: a done child tells its IMMEDIATE parent via a
// durable note (+ message to the parent's assignee). No recursion, no automatic
// parent completion.

let dir = "";
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-bubble-"));
  db = openDb(join(dir, "state.db"));
  registerWorker(db, "w1", { role: "worker" });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function completeChild(id: string): void {
  // Claim the SPECIFIC child (claimNext could take a sibling/parent).
  claimTask(db, id, "w1");
  submitTask(db, id, "w1", { evidence: "x" });
  approveTask(db, id, "reviewer");
}

describe("one-hop completion bubbling", () => {
  test("a done child records child_done on the immediate parent", () => {
    registerWorker(db, "p", { role: "worker" });
    const parent = addTask(db, { title: "parent" });
    claimNext(db, "p"); // parent is assigned to p
    const c1 = addTask(db, { title: "child one", parentTaskId: parent.id });
    completeChild(c1.id);

    const notes = getNotes(db, parent.id);
    expect(notes.some((n) => n.kind === "child_done" && n.body.includes(`${c1.id} done`))).toBe(true);
    // The only child is done => children_done too.
    expect(notes.some((n) => n.kind === "children_done")).toBe(true);

    // The parent's assignee gets the durable delivery.
    const inbox = inboxFor(db, "p").map((m) => m.kind).sort();
    expect(inbox).toEqual(["child_done", "children_done"]);

    // Parent is NOT auto-completed.
    expect(getTask(db, parent.id)!.state).toBe("running");
  });

  test("children_done appears only after ALL direct children are done", () => {
    const parent = addTask(db, { title: "parent" });
    const c1 = addTask(db, { title: "c1", parentTaskId: parent.id });
    const c2 = addTask(db, { title: "c2", parentTaskId: parent.id });

    completeChild(c1.id);
    let notes = getNotes(db, parent.id);
    expect(notes.filter((n) => n.kind === "child_done")).toHaveLength(1);
    expect(notes.filter((n) => n.kind === "children_done")).toHaveLength(0);

    completeChild(c2.id);
    notes = getNotes(db, parent.id);
    expect(notes.filter((n) => n.kind === "child_done")).toHaveLength(2);
    expect(notes.filter((n) => n.kind === "children_done")).toHaveLength(1);
  });

  test("no parent => nothing is recorded or sent", () => {
    const root = addTask(db, { title: "root" });
    completeChild(root.id);
    // `submit` leaves its own note; only bubbling notes must be absent.
    expect(getNotes(db, root.id).some((n) => n.kind === "child_done" || n.kind === "children_done")).toBe(false);
    expect(inboxFor(db, "w1")).toHaveLength(0);
  });

  test("a dangling parent does not crash the approval", () => {
    const parent = addTask(db, { title: "p" });
    const c = addTask(db, { title: "c", parentTaskId: parent.id });
    db.query(`DELETE FROM tasks WHERE id = ?`).run(parent.id);
    claimTask(db, c.id, "w1");
    submitTask(db, c.id, "w1", { evidence: "x" });
    expect(() => approveTask(db, c.id, "reviewer")).not.toThrow();
    expect(getTask(db, c.id)!.state).toBe("done");
  });
});
