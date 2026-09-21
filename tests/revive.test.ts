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
import { addTask } from "../src/tasks";
import { getWorker, registerWorker } from "../src/workers";

// External (manually attached, relay_owned=0) workers have NO restart path: a
// worker misclassified `dead` (transient isAlive failure, or a stale binding at
// daemon start) used to stay dead forever and never receive a NEXT_NUDGE. A live
// transport must revive it instead.

let dir = "";
let db: Database;
let rt: MockRuntime;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-revive-"));
  db = openDb(join(dir, "state.db"));
  rt = new MockRuntime();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function attachExternal(id: string, role: string): void {
  registerWorker(db, id, { role });
  attachSession(db, `ses_${id}`, {
    workerId: id,
    role,
    identity: { agent: `${id}-agent`, tabId: `tab-${id}`, paneId: `pane-${id}`,
                workspaceId: "w-ext", agentKind: "opencode" },
  });
}

describe("revival of an externally-owned worker", () => {
  test("a dead-but-alive external worker is revived and woken for runnable work", async () => {
    attachExternal("control-rust", "control-rust");
    addTask(db, { title: "rust work", role: "control-rust" }); // queued, claimable by it
    db.query(`UPDATE workers SET state = 'dead' WHERE id = 'control-rust'`).run();
    rt.setAlive("control-rust", true); // transport is actually alive

    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("revived:control-rust");
    expect(actions).toContain("woken:control-rust");
    expect(actions).not.toContain("restart-skipped:control-rust");
    expect(getWorker(db, "control-rust")!.state).toBe("idle");
    expect(rt.wakes.some((w) => w.workerId === "control-rust")).toBe(true);
    expect(listEvents(db, { limit: 20 }).some((e) => e.type === "worker.revived")).toBe(true);
  });

  test("a genuinely dead external worker is not revived (restart is refused)", async () => {
    attachExternal("control-go", "control-go");
    addTask(db, { title: "go work", role: "control-go" });
    db.query(`UPDATE workers SET state = 'dead' WHERE id = 'control-go'`).run();
    rt.setAlive("control-go", false); // transport gone

    const { actions } = await reconcile(db, rt);
    expect(actions).not.toContain("revived:control-go");
    expect(actions).toContain("restart-skipped:control-go");
    expect(rt.wakes).toHaveLength(0);
  });

  test("no wake when the revived worker has nothing it can claim", async () => {
    attachExternal("control-rust", "control-rust");
    db.query(`UPDATE workers SET state = 'dead' WHERE id = 'control-rust'`).run();
    rt.setAlive("control-rust", true);
    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("revived:control-rust");
    expect(actions).not.toContain("woken:control-rust");
  });
});
