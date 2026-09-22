import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { listEvents } from "../src/events";
import { inboxFor, sendMessage } from "../src/messages";
import { addTask, approveTask, claimTask, getNotes, getTask, releaseTask, submitTask, blockTask, setTaskParent, taskChildren } from "../src/tasks";
import { registerWorker } from "../src/workers";

// One-hop completion bubbling: a done child tells its IMMEDIATE parent via a
// durable note (+ message to the parent's assignee). No recursion, no automatic
// parent completion, no agent hierarchy.

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

function complete(id: string, worker = "w1"): void {
  claimTask(db, id, worker);
  submitTask(db, id, worker, { evidence: "x" });
  approveTask(db, id, "reviewer");
}
function bubblingNotes(taskId: string): string[] {
  return getNotes(db, taskId)
    .filter((n) => n.kind === "child_done" || n.kind === "children_done")
    .map((n) => n.kind);
}

describe("one-hop completion bubbling", () => {
  test("1+2. a done child records child_done on the parent AND messages its assignee", () => {
    registerWorker(db, "p", { role: "worker" });
    const parent = addTask(db, { title: "parent" });
    claimTask(db, parent.id, "p");
    const c1 = addTask(db, { title: "child one", parentTaskId: parent.id });
    complete(c1.id);

    expect(getNotes(db, parent.id).some((n) => n.kind === "child_done" && n.body.includes(`${c1.id} done`))).toBe(true);
    // Relay-originated text is tagged so it is never mistaken for a human/peer.
    expect(getNotes(db, parent.id).find((n) => n.kind === "child_done")!.body.startsWith("relay: ")).toBe(true);
    expect(inboxFor(db, "p").map((m) => m.kind)).toEqual(["child_done", "children_done"]);
    expect(inboxFor(db, "p")[0].payload.startsWith("relay: ")).toBe(true);
    expect(getTask(db, parent.id)!.state).toBe("running"); // never auto-done
  });

  test("3. children_done appears only after ALL direct children are done", () => {
    const parent = addTask(db, { title: "parent" });
    const c1 = addTask(db, { title: "c1", parentTaskId: parent.id });
    const c2 = addTask(db, { title: "c2", parentTaskId: parent.id });

    complete(c1.id);
    expect(bubblingNotes(parent.id)).toEqual(["child_done"]);
    complete(c2.id);
    expect(bubblingNotes(parent.id).sort()).toEqual(["child_done", "child_done", "children_done"]);
  });

  test("4. NO recursion: a grandchild does not touch the grandparent", () => {
    registerWorker(db, "p", { role: "worker" });
    const P = addTask(db, { title: "P" });
    const C1 = addTask(db, { title: "C1", parentTaskId: P.id });
    const G11 = addTask(db, { title: "G11", parentTaskId: C1.id });
    claimTask(db, P.id, "p"); // P assigned to p

    complete(G11.id);
    expect(bubblingNotes(C1.id)).toEqual(["child_done", "children_done"]);
    expect(bubblingNotes(P.id)).toEqual([]); // grandparent untouched
    expect(inboxFor(db, "p")).toHaveLength(0); // and not messaged
  });

  test("5. the parent, once itself done, bubbles exactly one hop further", () => {
    registerWorker(db, "p", { role: "worker" });
    const P = addTask(db, { title: "P" });
    const C1 = addTask(db, { title: "C1", parentTaskId: P.id });
    const G11 = addTask(db, { title: "G11", parentTaskId: C1.id });
    claimTask(db, P.id, "p");
    complete(G11.id);
    complete(C1.id, "p"); // C1 approved by the same worker

    expect(getNotes(db, P.id).some((n) => n.kind === "child_done" && n.body.includes(`${C1.id} done`))).toBe(true);
    expect(inboxFor(db, "p").some((m) => m.kind === "child_done" && m.task_id === P.id)).toBe(true);
    expect(getTask(db, P.id)!.state).toBe("running");
  });

  test("6. an unassigned parent gets a durable note but NO message; the submitter is told", () => {
    const parent = addTask(db, { title: "parent" });
    const child = addTask(db, { title: "child", parentTaskId: parent.id });
    complete(child.id);

    expect(bubblingNotes(parent.id)).toEqual(["child_done", "children_done"]);
    // The parent has no assignee, so nobody receives the parent bubble...
    expect(inboxFor(db, "w1").some((m) => m.kind === "child_done")).toBe(false);
    // ...but the submitter still learns their own task's outcome.
    expect(inboxFor(db, "w1").map((m) => m.kind)).toEqual(["review_done"]);
  });

  test("7. a later claimer can observe the prior child_done notes", () => {
    const parent = addTask(db, { title: "parent" });
    const child = addTask(db, { title: "child", parentTaskId: parent.id });
    complete(child.id);

    registerWorker(db, "p2", { role: "worker" });
    claimTask(db, parent.id, "p2");
    expect(getNotes(db, parent.id).some((n) => n.kind === "child_done")).toBe(true);
    expect(getNotes(db, parent.id).some((n) => n.kind === "children_done")).toBe(true);
  });

  test("8. a reassigned parent sends future child completion to the NEW assignee only", () => {
    registerWorker(db, "pa", { role: "worker" });
    registerWorker(db, "pb", { role: "worker" });
    const parent = addTask(db, { title: "parent" });
    claimTask(db, parent.id, "pa");
    releaseTask(db, parent.id, "pa"); // give it up
    claimTask(db, parent.id, "pb");

    const child = addTask(db, { title: "child", parentTaskId: parent.id });
    complete(child.id);
    expect(inboxFor(db, "pa")).toHaveLength(0);
    expect(inboxFor(db, "pb").some((m) => m.kind === "child_done")).toBe(true);
  });

  test("9. an unrelated peer gets no completion broadcast", () => {
    registerWorker(db, "peer", { role: "worker" });
    const parent = addTask(db, { title: "parent" });
    const child = addTask(db, { title: "child", parentTaskId: parent.id });
    complete(child.id);
    expect(inboxFor(db, "peer")).toHaveLength(0);
  });

  test("10. direct peer-to-peer durable messages still work", () => {
    registerWorker(db, "peer-b", { role: "worker" });
    sendMessage(db, "worker-a", "peer-b", "here is the benchmark result", { taskId: "T9" });
    const items = inboxFor(db, "peer-b");
    expect(items).toHaveLength(1);
    expect(items[0].payload).toContain("benchmark result");
  });

  test("11. a root task completion has no parent bubble, but the submitter is told", () => {
    const root = addTask(db, { title: "root" });
    complete(root.id);
    expect(bubblingNotes(root.id)).toEqual([]); // nothing to bubble to
    // The author still learns the verdict (regression: T188/T190/T197 were silent).
    expect(inboxFor(db, "w1").map((m) => m.kind)).toEqual(["review_done"]);
    expect(getTask(db, root.id)!.state).toBe("done");
  });

  test("12. a dangling parent is a no-op (approval still succeeds)", () => {
    const parent = addTask(db, { title: "p" });
    const c = addTask(db, { title: "c", parentTaskId: parent.id });
    db.query(`DELETE FROM tasks WHERE id = ?`).run(parent.id);
    claimTask(db, c.id, "w1");
    submitTask(db, c.id, "w1", { evidence: "x" });
    expect(() => approveTask(db, c.id, "reviewer")).not.toThrow();
    expect(getTask(db, c.id)!.state).toBe("done");
  });

  test("13. `human` is not a special recipient (no operator routing)", () => {
    sendMessage(db, "worker-a", "human", "no special routing");
    expect(inboxFor(db, "human")).toHaveLength(1); // an ordinary mailbox
    expect(inboxFor(db, "worker-a")).toHaveLength(0);
  });

  test("14. a task's role does not route completion anywhere", () => {
    registerWorker(db, "wperf", { role: "perf-x" });
    const t = addTask(db, { title: "perf work", role: "perf-x" });
    complete(t.id, "wperf");
    const msgs = db.query(`SELECT recipient, kind FROM messages`).all() as { recipient: string; kind: string }[];
    // The only message is the submitter's OWN outcome — no role fan-out, no
    // operator notice.
    expect(msgs).toEqual([{ recipient: "wperf", kind: "review_done" }]);
  });

  test("15. a blocked child notifies the immediate parent assignee", () => {
    registerWorker(db, "p", { role: "worker" });
    const parent = addTask(db, { title: "parent" });
    claimTask(db, parent.id, "p");
    const child = addTask(db, { title: "child", parentTaskId: parent.id });
    claimTask(db, child.id, "w1");
    blockTask(db, child.id, "w1", "need API semantics", true);

    expect(getNotes(db, parent.id).some(
      (n) => n.kind === "child_blocked" && n.body.includes(`${child.id} blocked_human`))).toBe(true);
    const inbox = inboxFor(db, "p");
    expect(inbox.some((m) => m.kind === "child_blocked")).toBe(true);
    expect(inbox.find((m) => m.kind === "child_blocked")!.payload).toContain("need API semantics");
    // The parent is not auto-changed.
    expect(getTask(db, parent.id)!.state).toBe("running");
  });

  test("16. children_blocked when ALL direct children are blocked", () => {
    const parent = addTask(db, { title: "parent" });
    const c1 = addTask(db, { title: "c1", parentTaskId: parent.id });
    const c2 = addTask(db, { title: "c2", parentTaskId: parent.id });
    claimTask(db, c1.id, "w1");
    blockTask(db, c1.id, "w1", "a", false);
    expect(getNotes(db, parent.id).filter((n) => n.kind === "children_blocked")).toHaveLength(0);
    claimTask(db, c2.id, "w1");
    blockTask(db, c2.id, "w1", "b", false);
    expect(getNotes(db, parent.id).filter((n) => n.kind === "children_blocked")).toHaveLength(1);
  });

  test("17. an unassigned parent still gets the note, no message", () => {
    const parent = addTask(db, { title: "parent" });
    const child = addTask(db, { title: "child", parentTaskId: parent.id });
    claimTask(db, child.id, "w1");
    blockTask(db, child.id, "w1", "x", false);
    expect(getNotes(db, parent.id).some((n) => n.kind === "child_blocked")).toBe(true);
    const n = (db.query(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n;
    expect(n).toBe(0);
  });
});

// T337: a blocked_human task must reach the human interface, never park silently.
describe("blocked_human human notification (T337)", () => {
  const savedHuman = process.env.RELAY_HUMAN;
  afterEach(() => {
    if (savedHuman === undefined) delete process.env.RELAY_HUMAN;
    else process.env.RELAY_HUMAN = savedHuman;
  });

  test("RELAY_HUMAN receives an immediate blocked_human message with id + reason", () => {
    process.env.RELAY_HUMAN = "operator-inbox";
    const t = addTask(db, { title: "needs a decision" });
    blockTask(db, t.id, "w1", "which NOS first?", true);
    const msgs = inboxFor(db, "operator-inbox");
    const m = msgs.find((x) => x.kind === "blocked_human")!;
    expect(m).toBeTruthy();
    expect(m.task_id).toBe(t.id);
    expect(m.payload).toContain(t.id);
    expect(m.payload).toContain("which NOS first?");
  });

  test("with no RELAY_HUMAN, the nearest ASSIGNED ancestor is the human interface", () => {
    delete process.env.RELAY_HUMAN;
    registerWorker(db, "coord", { role: "worker" });
    const root = addTask(db, { title: "program root" });
    db.query(`UPDATE tasks SET assignee='coord' WHERE id=?`).run(root.id);
    const mid = addTask(db, { title: "mid", parentTaskId: root.id }); // unassigned
    const leaf = addTask(db, { title: "leaf", parentTaskId: mid.id });
    blockTask(db, leaf.id, "w1", "need a person", true);
    expect(inboxFor(db, "coord").some((m) => m.kind === "blocked_human" && m.task_id === leaf.id)).toBe(true);
  });

  test("when NO ancestor is assigned, a prominent attention note + event is recorded", () => {
    delete process.env.RELAY_HUMAN;
    const orphan = addTask(db, { title: "orphan" }); // no parent, no assignee
    blockTask(db, orphan.id, "w1", "stuck", true);
    expect(getNotes(db, orphan.id).some((n) => n.kind === "blocked_human_unrouted")).toBe(true);
    const ev = listEvents(db, { limit: 50 }).find((e) => e.type === "task.blocked_human_unrouted");
    expect(ev).toBeTruthy();
  });

  test("blocked_internal never pings the human interface", () => {
    process.env.RELAY_HUMAN = "operator-inbox";
    const t = addTask(db, { title: "internal" });
    blockTask(db, t.id, "w1", "engine bug", false);
    expect(inboxFor(db, "operator-inbox").some((m) => m.kind === "blocked_human")).toBe(false);
    expect(getNotes(db, t.id).some((n) => n.kind === "blocked_human_unrouted")).toBe(false);
  });

  test("the one-hop parent roll-up still fires for blocked_human (b)", () => {
    delete process.env.RELAY_HUMAN;
    registerWorker(db, "p", { role: "worker" });
    const parent = addTask(db, { title: "parent" });
    db.query(`UPDATE tasks SET assignee='p' WHERE id=?`).run(parent.id);
    const child = addTask(db, { title: "child", parentTaskId: parent.id });
    blockTask(db, child.id, "w1", "blocked", true);
    expect(getNotes(db, parent.id).some((n) => n.kind === "child_blocked")).toBe(true);
    expect(inboxFor(db, "p").some((m) => m.kind === "child_blocked")).toBe(true);
  });
});
// T324: parent_task_id was creation-only, so a subtree created without --parent
// was orphaned (no bubbling, wrong tree). `setTaskParent` is the supported fix.
describe("task reparenting (T324)", () => {
  test("reparenting restores one-hop bubbling to the new parent", () => {
    const P = addTask(db, { title: "orphaned-subtree-root" });
    const C = addTask(db, { title: "orphan child" }); // created with NO parent
    expect(getTask(db, C.id)!.parent_task_id).toBeNull();
    expect(bubblingNotes(P.id)).toEqual([]);

    const updated = setTaskParent(db, C.id, P.id);
    expect(updated.parent_task_id).toBe(P.id);
    expect(taskChildren(db, P.id).map((t) => t.id)).toEqual([C.id]);

    complete(C.id); // the child now bubbles to the new parent
    expect(bubblingNotes(P.id)).toEqual(["child_done", "children_done"]);
  });

  test("reparenting a subtree root re-attaches the WHOLE subtree", () => {
    const P = addTask(db, { title: "new root" });
    const R = addTask(db, { title: "subtree root" }); // orphan
    const G = addTask(db, { title: "grandchild", parentTaskId: R.id });
    setTaskParent(db, R.id, P.id);
    // The grandchild still points at R: one hop from P reaches R, then G.
    expect(taskChildren(db, P.id).map((t) => t.id)).toEqual([R.id]);
    expect(taskChildren(db, R.id).map((t) => t.id)).toEqual([G.id]);
  });

  test("reparent validates: unknown parent, self-parent and cycles are refused", () => {
    const P = addTask(db, { title: "P" });
    const C = addTask(db, { title: "C", parentTaskId: P.id });
    const G = addTask(db, { title: "G", parentTaskId: C.id });

    expect(() => setTaskParent(db, C.id, "T999")).toThrow(/unknown parent task/);
    expect(() => setTaskParent(db, C.id, C.id)).toThrow(/own parent/);
    // P is an ancestor of G: making P a child of G would close a cycle.
    expect(() => setTaskParent(db, P.id, G.id)).toThrow(/parent cycle/);
    // A refused reparent must not have mutated anything.
    expect(getTask(db, P.id)!.parent_task_id).toBeNull();
  });

  test("reparent to null (clear) detaches, and is always allowed", () => {
    const P = addTask(db, { title: "P" });
    const C = addTask(db, { title: "C", parentTaskId: P.id });
    expect(setTaskParent(db, C.id, null).parent_task_id).toBeNull();
    expect(taskChildren(db, P.id)).toHaveLength(0);
    // Detached, the child no longer bubbles.
    complete(C.id);
    expect(bubblingNotes(P.id)).toEqual([]);
  });
});
