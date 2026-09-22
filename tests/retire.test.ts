import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { listEvents } from "../src/events";
import { idleWorkers, isOperationalWorker } from "../src/scheduler";
import { handleSocketMessage, type SocketContext } from "../src/socket";
import { MockRuntime, type HerdrIdentity } from "../src/runtime/runtime";
import { recordRuntime } from "../src/runtimes";
import { attachSession } from "../src/sessions";
import { addTask, claimNext, claimTask, unclaimableRunnableTasks } from "../src/tasks";
import {
  getWorker,
  isRetired,
  listWorkers,
  registerWorker,
  retireWorker,
  unretireWorker,
} from "../src/workers";

// `relay worker retire` — take a duplicate/obsolete registration out of every
// operational surface WITHOUT deleting its history, so stale references stay
// resolvable and no durable work is silently stranded.

let dir = "";
let db: Database;

/**
 * Register + managed-attach so the worker becomes operational (an idle plain
 * registration has neither a managed session nor a relay-owned starting runtime,
 * so it is not schedulable in the first place).
 */
function bindManaged(id: string, role = "worker"): void {
  registerWorker(db, id, { role });
  attachSession(db, `ses_${id}`, {
    role,
    workerId: id,
    identity: {
      agent: `${id}-agent`, tabId: `tab-${id}`, paneId: `pane-${id}`,
      workspaceId: "w-test", agentKind: "opencode",
    },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-retire-"));
  db = openDb(join(dir, "state.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("worker retirement", () => {
  test("a retired worker leaves every listing but its row survives", () => {
    registerWorker(db, "u2-dsl-go", { role: "dsl-go" });
    registerWorker(db, "dsl-go", { role: "dsl-go" });

    expect(listWorkers(db).map((w) => w.id).sort()).toEqual(["dsl-go", "u2-dsl-go"]);

    const retired = retireWorker(db, "u2-dsl-go", "superseded by dsl-go");
    expect(isRetired(retired)).toBe(true);
    expect(retired.retired_reason).toBe("superseded by dsl-go");

    // Hidden from the default listing, addressable by id, visible with --all.
    expect(listWorkers(db).map((w) => w.id)).toEqual(["dsl-go"]);
    expect(getWorker(db, "u2-dsl-go")!.id).toBe("u2-dsl-go");
    expect(listWorkers(db, { includeRetired: true }).map((w) => w.id).sort()).toEqual([
      "dsl-go", "u2-dsl-go",
    ]);
  });

  test("a retired worker is never operational, idle or a valid role owner", () => {
    // isOperationalWorker requires a live managed binding, so mirror what the
    // attach path leaves behind: state idle + a managed session row.
    bindManaged("u2-corpus", "corpus");

    expect(idleWorkers(db).map((w) => w.id)).toContain("u2-corpus");
    expect(isOperationalWorker(db, getWorker(db, "u2-corpus")!)).toBe(true);

    retireWorker(db, "u2-corpus");

    expect(idleWorkers(db).map((w) => w.id)).not.toContain("u2-corpus");
    expect(isOperationalWorker(db, getWorker(db, "u2-corpus")!)).toBe(false);

    // A role whose ONLY registrations are retired no longer counts as owned, so
    // the task is surfaced as unclaimable instead of silently stranded.
    addTask(db, { title: "corpus work", role: "corpus" });
    expect(unclaimableRunnableTasks(db).map((t) => t.title)).toEqual(["corpus work"]);
  });

  test("retiring refuses while the worker still owns a task", () => {
    registerWorker(db, "w1", { role: "worker" });
    const t = addTask(db, { title: "busy" });
    claimTask(db, t.id, "w1");

    expect(() => retireWorker(db, "w1")).toThrow(/still owns/);
    expect(isRetired(getWorker(db, "w1")!)).toBe(false);
  });

  test("retire is idempotent and unretire restores schedulability", () => {
    bindManaged("w1");
    const first = retireWorker(db, "w1", "dup");
    const again = retireWorker(db, "w1", "dup");
    expect(again.retired_at).toBe(first.retired_at);

    unretireWorker(db, "w1");
    expect(isRetired(getWorker(db, "w1")!)).toBe(false);
    expect(idleWorkers(db).map((w) => w.id)).toContain("w1");
  });

  test("re-registering a retired id revives it", () => {
    registerWorker(db, "w1", { role: "worker" });
    retireWorker(db, "w1");
    expect(isRetired(getWorker(db, "w1")!)).toBe(true);

    registerWorker(db, "w1", { role: "worker" });
    expect(isRetired(getWorker(db, "w1")!)).toBe(false);
  });

  test("retire/unretire are recorded in the event log", () => {
    registerWorker(db, "w1", { role: "worker" });
    retireWorker(db, "w1", "duplicate");
    unretireWorker(db, "w1");

    const types = listEvents(db, { limit: 50 }).map((e) => e.type);
    expect(types).toContain("worker.retired");
    expect(types).toContain("worker.unretired");
  });

  test("an unknown worker cannot be retired", () => {
    expect(() => retireWorker(db, "ghost")).toThrow(/unknown worker/);
  });
});

// T224: attaching a LIVE session to a worker id that exists but is RETIRED used
// to silently keep it retired, so the worker stayed hidden (listWorkers filters
// retired_at) and its role tasks became unclaimable. A live attach is the same
// intent as re-registering, so it must revive the tombstone.

function identityFor(id: string, suffix = ""): HerdrIdentity {
  return {
    agent: `${id}-agent${suffix}`,
    tabId: `tab-${id}${suffix}`,
    paneId: `pane-${id}${suffix}`,
    workspaceId: "w-test",
    agentKind: "opencode",
  };
}

describe("attach revives a retired worker (T224)", () => {
  test("manual attachSession to a retired id revives it and its role work is claimable", () => {
    registerWorker(db, "rev", { role: "bugfix" });
    retireWorker(db, "rev", "superseded");
    expect(isRetired(getWorker(db, "rev")!)).toBe(true);
    // While retired, the role's task is surfaced as unclaimable.
    addTask(db, { title: "fix it", role: "bugfix" });
    expect(unclaimableRunnableTasks(db).map((t) => t.title)).toEqual(["fix it"]);

    const s = attachSession(db, "ses_rev", { role: "bugfix", workerId: "rev", identity: identityFor("rev") });

    expect(s.worker_id).toBe("rev");
    expect(isRetired(getWorker(db, "rev")!)).toBe(false);
    expect(listWorkers(db).map((w) => w.id)).toContain("rev");
    expect(idleWorkers(db).map((w) => w.id)).toContain("rev");
    expect(isOperationalWorker(db, getWorker(db, "rev")!)).toBe(true);
    expect(unclaimableRunnableTasks(db)).toHaveLength(0);
    // And it can actually claim its role's work again.
    expect(claimNext(db, "rev")?.title).toBe("fix it");
    // The revival is recorded.
    expect(listEvents(db, { limit: 50 }).map((e) => e.type)).toContain("worker.unretired");
  });

  test("idempotent re-attach of the SAME session also revives the tombstone", () => {
    registerWorker(db, "rev2", { role: "worker" });
    attachSession(db, "ses_rev2", { role: "worker", workerId: "rev2", identity: identityFor("rev2") });
    retireWorker(db, "rev2", "dup");
    expect(isRetired(getWorker(db, "rev2")!)).toBe(true);

    const again = attachSession(db, "ses_rev2", { role: "worker", workerId: "rev2", identity: identityFor("rev2") });

    expect(again.worker_id).toBe("rev2");
    expect(isRetired(getWorker(db, "rev2")!)).toBe(false);
  });

  test("socket/plugin session.attach path revives a retired worker", async () => {
    const rt = new MockRuntime();
    const ctx: SocketContext = { db, runtime: rt, wakeReconcile: { value: false } };
    registerWorker(db, "rev3", { role: "worker" });
    retireWorker(db, "rev3", "old");

    rt.setIdentity("ses_rev3", identityFor("rev3"));
    const res = await handleSocketMessage(
      { type: "session.attach", session_id: "ses_rev3", worker_id: "rev3", role: "worker" },
      ctx
    );

    expect(res).toMatchObject({ ok: true, worker_id: "rev3", managed: true });
    expect(isRetired(getWorker(db, "rev3")!)).toBe(false);
    expect(idleWorkers(db).map((w) => w.id)).toContain("rev3");
  });

  test("relay-spawned attach (generation + token) also revives a retired id", () => {
    registerWorker(db, "rev4", { role: "worker" });
    recordRuntime(db, {
      workerId: "rev4",
      generation: 1,
      runtimeId: "rev4-agent",
      sessionId: null,
      attachToken: "tok-1",
      relayOwned: 1,
      state: "starting",
    });
    retireWorker(db, "rev4", "old");

    const s = attachSession(db, "ses_rev4", { workerId: "rev4", generation: 1, attachToken: "tok-1" });

    expect(s.worker_id).toBe("rev4");
    expect(s.generation).toBe(1);
    expect(isRetired(getWorker(db, "rev4")!)).toBe(false);
  });

  test("a REJECTED attach leaves the retired tombstone untouched", () => {
    registerWorker(db, "rev5", { role: "worker" });
    retireWorker(db, "rev5", "old");

    // Manual attach with no verifiable Herdr identity is refused.
    expect(() => attachSession(db, "ses_rev5", { workerId: "rev5" })).toThrow(/not running inside Herdr/);
    expect(isRetired(getWorker(db, "rev5")!)).toBe(true);
    expect(listWorkers(db).map((w) => w.id)).not.toContain("rev5");
  });
});
