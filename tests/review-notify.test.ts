import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { inboxFor } from "../src/messages";
import { addTask, approveTask, claimTask, getTask, rejectTask, submitTask } from "../src/tasks";
import { registerWorker } from "../src/workers";

// Regression: a TOP-LEVEL task's approval/rejection produced NO notification.
// bubbleChildDone returns early when `parent_task_id` is null, so notifications
// only ever reached an immediate parent's assignee. A worker who submitted a
// task with no parent never learned its review outcome: T188/T190/T197 were
// approved/rejected silently and the coordinator only found out by polling.
//
// Policy (operator-approved, option A): the SUBMITTER is always notified of
// their own task's outcome, parent or not. The existing parent bubbling is kept
// and is a SEPARATE signal; when the submitter is also the immediate parent's
// assignee, the child_done message already carries the outcome, so we do not add
// a second notice to the same mailbox.

let dir = "";
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-review-notify-"));
  db = openDb(join(dir, "state.db"));
  registerWorker(db, "author", { role: "worker" });
  registerWorker(db, "reviewer", { role: "reviewer" });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function submit(id: string, by: string): void {
  claimTask(db, id, by);
  submitTask(db, id, by, { evidence: "done" });
}

describe("top-level review outcomes reach the submitter", () => {
  test("1. a top-level task approved notifies its submitter", () => {
    const t = addTask(db, { title: "top-level work" });
    submit(t.id, "author");

    approveTask(db, t.id, "reviewer");

    const inbox = inboxFor(db, "author");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].kind).toBe("review_done");
    expect(inbox[0].task_id).toBe(t.id);
    expect(inbox[0].payload).toContain(`${t.id} approved`);
  });

  test("2. a top-level task rejected notifies its submitter", () => {
    const t = addTask(db, { title: "top-level work" });
    submit(t.id, "author");

    const back = rejectTask(db, t.id, "reviewer", "tests are red");
    expect(back.state).toBe("queued");
    expect(back.assignee).toBeNull();

    const inbox = inboxFor(db, "author");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].kind).toBe("review_rejected");
    expect(inbox[0].task_id).toBe(t.id);
    expect(inbox[0].payload).toContain(`${t.id} rejected`);
    expect(inbox[0].payload).toContain("tests are red");
  });
});

describe("child review outcomes: parent bubble AND submitter, no duplicate", () => {
  test("3. a child approved notifies the parent's assignee and the submitter", () => {
    registerWorker(db, "parent-owner", { role: "worker" });
    const parent = addTask(db, { title: "parent" });
    claimTask(db, parent.id, "parent-owner");
    const child = addTask(db, { title: "child", parentTaskId: parent.id });
    submit(child.id, "author");

    approveTask(db, child.id, "reviewer");

    // Parent's assignee gets the one-hop child_done signal (one child => all done).
    expect(inboxFor(db, "parent-owner").map((m) => m.kind)).toEqual(["child_done", "children_done"]);
    // The submitter gets exactly one message: their own outcome.
    const submitterInbox = inboxFor(db, "author");
    expect(submitterInbox).toHaveLength(1);
    expect(submitterInbox[0].kind).toBe("review_done");
    expect(submitterInbox[0].task_id).toBe(child.id);
  });

  test("3b. submitter == parent assignee: one mailbox, no duplicate notice", () => {
    const parent = addTask(db, { title: "parent" });
    claimTask(db, parent.id, "author"); // author also owns the parent
    const child = addTask(db, { title: "child", parentTaskId: parent.id });
    submit(child.id, "author");

    approveTask(db, child.id, "reviewer");

    const inbox = inboxFor(db, "author");
    // The child_done signal already told them; no second review_done row.
    expect(inbox.map((m) => m.kind)).toEqual(["child_done", "children_done"]);
    expect(inbox.some((m) => m.kind === "review_done")).toBe(false);
  });

  test("3c. a rejected child still notifies the submitter (no parent bubble on reject)", () => {
    registerWorker(db, "parent-owner", { role: "worker" });
    const parent = addTask(db, { title: "parent" });
    claimTask(db, parent.id, "parent-owner");
    const child = addTask(db, { title: "child", parentTaskId: parent.id });
    submit(child.id, "author");

    rejectTask(db, child.id, "reviewer", "needs a rebase");

    expect(inboxFor(db, "author").map((m) => m.kind)).toEqual(["review_rejected"]);
    expect(inboxFor(db, "parent-owner")).toHaveLength(0);
    expect(getTask(db, child.id)!.state).toBe("queued");
  });
});
