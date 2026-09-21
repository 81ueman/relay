import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { sendMessage } from "../src/messages";
import { reconcile } from "../src/reconciler";
import { MockRuntime } from "../src/runtime/runtime";
import { addTask, approveTask, claimTask, submitTask } from "../src/tasks";
import { registerWorker } from "../src/workers";

// The send-time wake is best-effort, so the daemon nudges any durable unread
// backlog. Ordinary peer mail keeps the send-time/retry semantics; completion
// notices (child_done/children_done) are nudged without the initial delay.

let dir = "";
let db: Database;
let rt: MockRuntime;
const savedWindow = process.env.RELAY_MAIL_NUDGE_MS;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-mail-"));
  db = openDb(join(dir, "state.db"));
  rt = new MockRuntime();
  process.env.RELAY_MAIL_NUDGE_MS = "1"; // window passes immediately
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  if (savedWindow === undefined) delete process.env.RELAY_MAIL_NUDGE_MS;
  else process.env.RELAY_MAIL_NUDGE_MS = savedWindow;
});

/** Send a message and backdate it so the nudge window has elapsed. */
function staleMessage(recipient: string, body = "hello"): number {
  const id = sendMessage(db, "worker-a", recipient, body);
  db.query(`UPDATE messages SET created_at = ? WHERE id = ?`).run(Date.now() - 60_000, id);
  return id;
}

describe("periodic unread-mail nudge", () => {
  test("a stale peer backlog nudges the recipient", async () => {
    registerWorker(db, "worker-b", { role: "worker" });
    staleMessage("worker-b");
    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("mail-nudged:worker-b");
    expect(rt.wakes.some((w) => w.workerId === "worker-b")).toBe(true);
    // Tagged as relay-originated, not a human/peer message.
    expect(rt.wakes.find((w) => w.workerId === "worker-b")!.text.startsWith("relay: ")).toBe(true);
  });

  test("a fresh peer message is left to the send-time wake (no early nudge)", async () => {
    process.env.RELAY_MAIL_NUDGE_MS = "600000"; // large window
    registerWorker(db, "worker-b", { role: "worker" });
    sendMessage(db, "worker-a", "worker-b", "just sent"); // fresh
    const { actions } = await reconcile(db, rt);
    expect(actions).not.toContain("mail-nudged:worker-b");
  });

  test("completion notices (child_done) skip the initial delay", async () => {
    process.env.RELAY_MAIL_NUDGE_MS = "600000"; // large window
    registerWorker(db, "worker-b", { role: "worker" }); // parent owner
    registerWorker(db, "worker-c", { role: "worker" }); // child owner
    const parent = addTask(db, { title: "parent" });
    claimTask(db, parent.id, "worker-b");
    const child = addTask(db, { title: "child", parentTaskId: parent.id });
    claimTask(db, child.id, "worker-c");
    submitTask(db, child.id, "worker-c", { evidence: "x" });
    approveTask(db, child.id, "reviewer"); // fresh child_done message to worker-b

    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("mail-nudged:worker-b");
  });
});
