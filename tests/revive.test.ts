import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { listEvents, logEvent } from "../src/events";
import { reconcile } from "../src/reconciler";
import { MockRuntime, type HerdrIdentity } from "../src/runtime/runtime";
import { recordRuntime } from "../src/runtimes";
import { attachSession } from "../src/sessions";
import { handleSocketMessage, type SocketContext } from "../src/socket";
import { addTask } from "../src/tasks";
import { getWorker, registerWorker, setWorkerTool } from "../src/workers";

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

// T393: a worker that emits a managed session event is LIVE. A failed liveness
// probe must never leave it `dead` (its session keeps running unsupervised and
// the supervisor can spawn a DUPLICATE generation for the same worker).

/** Register a worker with a RELAY-OWNED active runtime + managed session. */
function seedRelayOwned(id: string, role = "worker", generation = 1): void {
  registerWorker(db, id, { role });
  const token = `seed-${id}-g${generation}`;
  recordRuntime(db, {
    workerId: id,
    generation,
    runtimeId: `${id}-agent`,
    tabId: `tab-${id}-g${generation}`,
    state: "starting",
    relayOwned: 1,
    attachToken: token,
  });
  attachSession(db, `ses_${id}`, { workerId: id, role, generation, attachToken: token });
  rt.setAlive(id, true);
}

function socketCtx(): SocketContext {
  return { db, runtime: rt, wakeReconcile: { value: false } };
}

describe("T393: an emitting session is never dead", () => {
  test("a managed event revives a worker left dead by a failed probe", async () => {
    attachExternal("rev-1", "worker");
    db.query(`UPDATE workers SET state = 'dead' WHERE id = 'rev-1'`).run();

    const res = await handleSocketMessage(
      { type: "tool.started", session_id: "ses_rev-1", payload: { tool: "shell", command: "sleep 5" } },
      socketCtx()
    );

    expect(res.ok).toBe(true);
    expect(getWorker(db, "rev-1")!.state).not.toBe("dead");
    const revived = listEvents(db, { limit: 50 }).filter((e) => e.type === "worker.revived");
    expect(revived.some((e) => e.worker_id === "rev-1")).toBe(true);
  });

  test("reconcile does not mark dead while the session emits events (no duplicate spawn)", async () => {
    attachExternal("rev-2", "worker");
    db.query(`UPDATE workers SET state = 'working' WHERE id = 'rev-2'`).run();
    // Emit a fresh session event, then fail the transport probe.
    await handleSocketMessage(
      { type: "tool.started", session_id: "ses_rev-2", payload: { tool: "shell", command: "sleep 5" } },
      socketCtx()
    );
    rt.setAlive("rev-2", false);

    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("alive-by-event:rev-2");
    expect(actions).not.toContain("dead:rev-2");
    expect(getWorker(db, "rev-2")!.state).not.toBe("dead");
    expect(rt.starts).toHaveLength(0); // no duplicate generation
  });

  test("a dead worker whose session is still emitting is revived, not restarted", async () => {
    seedRelayOwned("rev-3");
    db.query(`UPDATE workers SET state = 'dead' WHERE id = 'rev-3'`).run();
    // A session event exists, but do NOT go through the socket: exercise the
    // reconciler backstop directly (the event stream is the source of truth).
    logEvent(db, { source: "opencode", workerId: "rev-3", type: "tool.started", payload: { tool: "shell" } });
    rt.setAlive("rev-3", false); // stale target: the probe lies

    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("revived-by-event:rev-3");
    expect(getWorker(db, "rev-3")!.state).not.toBe("dead");
    expect(getWorker(db, "rev-3")!.generation).toBe(1); // no duplicate spawn
    expect(rt.starts).toHaveLength(0);
  });

  test("a probe failure with NO session output is still a real crash", async () => {
    attachExternal("rev-4", "worker");
    db.query(`UPDATE workers SET state = 'working' WHERE id = 'rev-4'`).run();
    rt.setAlive("rev-4", false);
    // No session event ever logged for rev-4.
    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("dead:rev-4");
    expect(getWorker(db, "rev-4")!.state).toBe("dead");
  });
});

// T396: liveness evidence beyond the raw event window.
const CODEX_ID = "01a0c405-70ba-7bf0-8522-98eba9dd5299";
const codexIdentity: HerdrIdentity = {
  agent: "codex-x", tabId: "t", paneId: "p", workspaceId: "w", agentKind: "codex",
};

describe("T396: liveness evidence beyond the event window", () => {
  test("an in-flight tool keeps a worker alive past the session-liveness window", async () => {
    attachExternal("rev-5", "worker");
    db.query(`UPDATE workers SET state = 'working' WHERE id = 'rev-5'`).run();
    setWorkerTool(db, "rev-5", { name: "shell", command: "cargo test" });
    rt.setAlive("rev-5", false); // stale probe: a long benchmark emits no events

    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("alive-by-event:rev-5");
    expect(actions).not.toContain("dead:rev-5");
    expect(getWorker(db, "rev-5")!.state).not.toBe("dead");
    expect(rt.starts).toHaveLength(0);
  });

  test("session.created counts as a session-liveness event", async () => {
    attachExternal("rev-6", "worker");
    db.query(`UPDATE workers SET state = 'working' WHERE id = 'rev-6'`).run();
    logEvent(db, { source: "opencode", workerId: "rev-6", type: "session.created", payload: {} });
    rt.setAlive("rev-6", false);

    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("alive-by-event:rev-6");
    expect(getWorker(db, "rev-6")!.state).not.toBe("dead");
  });

  test("a recent successful codex poll keeps a codex worker alive", async () => {
    registerWorker(db, "rev-codex", { role: "worker", agentKind: "codex", runtimeId: "w6D:p8" });
    attachSession(db, CODEX_ID, {
      role: "worker", workerId: "rev-codex", agentKind: "codex", identity: codexIdentity,
    });
    rt.setAgentStatus("rev-codex", "working");
    rt.setAlive("rev-codex", false); // the direct probe lies; the poll was healthy

    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("alive-by-event:rev-codex");
    expect(getWorker(db, "rev-codex")!.state).not.toBe("dead");
  });

  test("a latest dead codex poll is never overridden by an older successful poll", async () => {
    registerWorker(db, "rev-codex2", { role: "worker", agentKind: "codex", runtimeId: "w6D:p8" });
    attachSession(db, CODEX_ID, {
      role: "worker", workerId: "rev-codex2", agentKind: "codex", identity: codexIdentity,
    });
    rt.setAgentStatus("rev-codex2", "working");
    await reconcile(db, rt); // records a reachable poll

    rt.setAgentStatus("rev-codex2", "dead"); // the LATEST poll says dead
    rt.setAlive("rev-codex2", false);
    const { actions } = await reconcile(db, rt);

    expect(actions).not.toContain("alive-by-event:rev-codex2");
    expect(actions).not.toContain("revived-by-event:rev-codex2");
    expect(getWorker(db, "rev-codex2")!.state).toBe("dead");
  });
});
