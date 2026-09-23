import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import {
  addTask, approveTask, blockTask, claimTask, getTask, releaseTask, submitTask, waitTask,
} from "../src/tasks";
import { getWorker, registerWorker } from "../src/workers";

// T495: a worker that owns a RUNNING parent and claims a child has its
// `current_task_id` overwritten by the child; releasing the child must RESTORE
// the parent, not leave the pointer NULL. A NULL pointer while the worker still
// owns a running task made the parent unholdable: `relay wait` refused, and
// `relay next` never re-offers a running task.

let dir = "";
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-parent-ptr-"));
  db = openDb(join(dir, "state.db"));
  registerWorker(db, "w", { role: "worker" });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A running parent claimed by `w`, plus a running child of it, also claimed by `w`. */
function parentWithClaimedChild(): { parent: string; child: string } {
  const parent = addTask(db, { title: "parent" });
  claimTask(db, parent.id, "w");
  const child = addTask(db, { title: "child", parentTaskId: parent.id });
  claimTask(db, child.id, "w");
  return { parent: parent.id, child: child.id };
}

describe("releasing a child restores the running parent pointer (T495)", () => {
  test("submitting the child restores the parent, and the parent can be waited on again", () => {
    const { parent, child } = parentWithClaimedChild();
    expect(getWorker(db, "w")!.current_task_id).toBe(child);

    submitTask(db, child, "w", { evidence: "done" });

    expect(getTask(db, child)!.state).toBe("review");
    expect(getWorker(db, "w")!.current_task_id).toBe(parent);
    expect(getWorker(db, "w")!.state).toBe("working");
    // The original symptom: `relay wait <parent>` used to fail with
    // "does not hold it" because the pointer was NULL.
    expect(() => waitTask(db, parent, "w", 60_000, "awaiting a child review")).not.toThrow();
  });

  test("releasing the child restores the parent too", () => {
    const { parent, child } = parentWithClaimedChild();
    releaseTask(db, child, "w", "handing back");
    expect(getWorker(db, "w")!.current_task_id).toBe(parent);
  });

  test("blocking the child restores the parent", () => {
    const { parent, child } = parentWithClaimedChild();
    blockTask(db, child, "w", "stuck on a dep", false);
    expect(getWorker(db, "w")!.current_task_id).toBe(parent);
  });

  test("a reviewer approving the child does NOT clobber the submitter's restored parent pointer", () => {
    registerWorker(db, "reviewer-1", { role: "reviewer" });
    const { parent, child } = parentWithClaimedChild();
    submitTask(db, child, "w", { evidence: "done" });
    expect(getWorker(db, "w")!.current_task_id).toBe(parent);

    approveTask(db, child, "reviewer-1");

    expect(getTask(db, child)!.state).toBe("done");
    expect(getWorker(db, "w")!.current_task_id).toBe(parent);
  });

  test("no parent: submit still leaves the worker idle with no pointer", () => {
    const t = addTask(db, { title: "solo" });
    claimTask(db, t.id, "w");
    submitTask(db, t.id, "w", { evidence: "done" });
    const w = getWorker(db, "w")!;
    expect(w.current_task_id).toBeNull();
    expect(w.state).toBe("idle");
  });

  test("releasing the parent itself (no other running task) clears the pointer", () => {
    const parent = addTask(db, { title: "parent" });
    claimTask(db, parent.id, "w");
    releaseTask(db, parent.id, "w");
    const w = getWorker(db, "w")!;
    expect(w.current_task_id).toBeNull();
    expect(w.state).toBe("idle");
  });
});
