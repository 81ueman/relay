import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { inboxFor } from "../src/messages";
import { notifyGridDrained, notifyOn, notifyRecipients, notifyRoutes } from "../src/notify";
import { reconcile } from "../src/reconciler";
import { MockRuntime } from "../src/runtime/runtime";
import { addTask, approveTask, claimNext, submitTask } from "../src/tasks";
import { registerWorker } from "../src/workers";

// The integrator is a worker with no task, so no existing nudge targets it.
// These durable notices let it wake on completion / grid drain instead of polling.

let dir = "";
let db: Database;
const savedOperator = process.env.RELAY_OPERATOR;
const savedNotify = process.env.RELAY_NOTIFY_ON;
const savedRoutes = process.env.RELAY_NOTIFY_ROUTES;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-notify-"));
  db = openDb(join(dir, "state.db"));
  registerWorker(db, "integrator", { role: "worker" });
  process.env.RELAY_OPERATOR = "integrator";
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  if (savedOperator === undefined) delete process.env.RELAY_OPERATOR;
  else process.env.RELAY_OPERATOR = savedOperator;
  if (savedNotify === undefined) delete process.env.RELAY_NOTIFY_ON;
  else process.env.RELAY_NOTIFY_ON = savedNotify;
  if (savedRoutes === undefined) delete process.env.RELAY_NOTIFY_ROUTES;
  else process.env.RELAY_NOTIFY_ROUTES = savedRoutes;
});

function completeOneTask(): string {
  registerWorker(db, "w1", { role: "worker" });
  const t = addTask(db, { title: "finish me" });
  claimNext(db, "w1");
  submitTask(db, t.id, "w1", { evidence: "green" });
  approveTask(db, t.id, "reviewer");
  return t.id;
}

describe("operator notifications", () => {
  test("notifyOn parses off|task|drain|both (default off)", () => {
    process.env.RELAY_NOTIFY_ON = "task";
    expect(notifyOn()).toBe("task");
    process.env.RELAY_NOTIFY_ON = "drain";
    expect(notifyOn()).toBe("drain");
    process.env.RELAY_NOTIFY_ON = "both";
    expect(notifyOn()).toBe("both");
    process.env.RELAY_NOTIFY_ON = "nonsense";
    expect(notifyOn()).toBe("off");
    delete process.env.RELAY_NOTIFY_ON;
    expect(notifyOn()).toBe("off");
  });

  test("approving a task notifies the operator when RELAY_NOTIFY_ON=task", () => {
    process.env.RELAY_NOTIFY_ON = "task";
    const id = completeOneTask();
    const msgs = inboxFor(db, "integrator");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].kind).toBe("notify");
    expect(msgs[0].payload).toContain(`${id} done`);
    expect(msgs[0].sender).toBe("relay");
  });

  test("no task notice when disabled, and none without an operator", () => {
    process.env.RELAY_NOTIFY_ON = "off";
    completeOneTask();
    expect(inboxFor(db, "integrator")).toHaveLength(0);

    process.env.RELAY_NOTIFY_ON = "task";
    delete process.env.RELAY_OPERATOR;
    const t2 = addTask(db, { title: "second" });
    claimNext(db, "w1");
    submitTask(db, t2.id, "w1", { evidence: "x" });
    approveTask(db, t2.id, "reviewer");
    expect(inboxFor(db, "integrator")).toHaveLength(0);
  });

  test("grid-drain notice fires once and re-arms after new work", () => {
    process.env.RELAY_NOTIFY_ON = "drain";
    registerWorker(db, "w1", { role: "worker" });
    addTask(db, { title: "work" }); // task.created => work has happened

    expect(notifyGridDrained(db)).toEqual(["integrator"]); // first drain notice
    expect(notifyGridDrained(db)).toEqual([]); // debounced: no repeat

    // New work re-arms it (any task.* activity after the drain).
    addTask(db, { title: "more" });
    expect(notifyGridDrained(db)).toEqual(["integrator"]);
  });

  test("reconcile notifies the operator once when the grid drains", async () => {
    process.env.RELAY_NOTIFY_ON = "drain";
    const rt = new MockRuntime();
    completeOneTask(); // unfinished returns to 0, with task activity in the log

    const r1 = await reconcile(db, rt);
    expect(r1.actions).toContain("grid-drained-notified");
    expect(rt.wakes.some((w) => w.workerId === "integrator")).toBe(true);

    const r2 = await reconcile(db, rt);
    expect(r2.actions).not.toContain("grid-drained-notified");
  });
});

describe("hierarchical notify routing", () => {
  test("default always receives; first matching role route (glob/exact) adds recipients; deduped", () => {
    const routes = {
      default: ["top"],
      routes: [
        { role: "perf-*", to: ["dp", "top"] },
        { role: "control-*", to: ["cp"] },
      ],
    };
    expect(notifyRecipients("perf-lupe", routes, [])).toEqual(["top", "dp"]); // top deduped
    expect(notifyRecipients("control-go", routes, [])).toEqual(["top", "cp"]);
    expect(notifyRecipients("other", routes, [])).toEqual(["top"]); // default only
    expect(notifyRecipients(null, routes, [])).toEqual(["top"]);
    // first match wins
    expect(notifyRecipients("perf-lupe", {
      default: [], routes: [{ role: "perf-*", to: ["x"] }, { role: "perf-lupe", to: ["y"] }],
    }, [])).toEqual(["x"]);
    // exact
    expect(notifyRecipients("perf-lupe", { default: [], routes: [{ role: "perf-lupe", to: ["z"] }] }, []))
      .toEqual(["z"]);
    // no routing configured => legacy operator fallback
    expect(notifyRecipients("perf-lupe", { default: [], routes: [] }, ["legacy"])).toEqual(["legacy"]);
  });

  test("notifyRoutes parses env JSON; junk => empty", () => {
    process.env.RELAY_NOTIFY_ROUTES = JSON.stringify({ default: ["a"], routes: [{ role: "r", to: ["b"] }] });
    expect(notifyRoutes()).toEqual({ default: ["a"], routes: [{ role: "r", to: ["b"] }] });
    process.env.RELAY_NOTIFY_ROUTES = "{not json";
    expect(notifyRoutes()).toEqual({ default: [], routes: [] });
    delete process.env.RELAY_NOTIFY_ROUTES;
  });

  test("notifyTaskDone sends ONE message per routed recipient (by task role)", () => {
    process.env.RELAY_NOTIFY_ON = "task";
    process.env.RELAY_NOTIFY_ROUTES = JSON.stringify({
      default: ["top"],
      routes: [{ role: "perf-*", to: ["dp", "top"] }],
    });
    for (const id of ["top", "dp", "uninvolved"]) registerWorker(db, id, { role: "worker" });
    registerWorker(db, "w1", { role: "perf-cpp" });
    const t = addTask(db, { title: "perf work", role: "perf-cpp" });
    claimNext(db, "w1");
    submitTask(db, t.id, "w1", { evidence: "x" });
    approveTask(db, t.id, "reviewer");

    expect(inboxFor(db, "top")).toHaveLength(1); // default
    expect(inboxFor(db, "dp")).toHaveLength(1); // role route
    expect(inboxFor(db, "uninvolved")).toHaveLength(0);
    expect(inboxFor(db, "top")[0].payload).toContain(`${t.id} done`);
    delete process.env.RELAY_NOTIFY_ROUTES;
  });
});
