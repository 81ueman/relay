import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { listEvents } from "../src/events";
import { idleWorkers, isOperationalWorker } from "../src/scheduler";
import { attachSession } from "../src/sessions";
import { addTask, claimTask, unclaimableRunnableTasks } from "../src/tasks";
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
