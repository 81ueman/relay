import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { buildDashboardView, type DashboardView } from "../src/dashboard/model";
import { dwidth, renderDashboard, renderDashboardJson, trim } from "../src/dashboard/render";
import type { PaneTelemetry } from "../src/dashboard/herdr";
import { recordRuntime } from "../src/runtimes";
import { addTask, blockTask, claimTask } from "../src/tasks";
import { registerWorker, setQuiet } from "../src/workers";

// Dashboard = read-only projection of Relay (task tree + workers with their
// current runtime) + Herdr execution telemetry. Worker and Runtime stay distinct
// in the model; the renderer overlays the current runtime on the worker row.

let dir = "";
let db: Database;
const at = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-dash-"));
  mkdirSync(join(dir, ".relay"), { recursive: true });
  db = openDb(join(dir, ".relay", "state.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const pane = (paneId: string, status = "idle"): PaneTelemetry =>
  ({ paneId, agent: "opencode", agentStatus: status, title: "", cwd: dir,
     workspaceId: "w1", tabId: "t1", focused: false });

function view(panes: Map<string, PaneTelemetry> | null = null): DashboardView {
  return buildDashboardView(db, { root: dir, panes, at });
}

function setState(id: string, state: string): void {
  db.query(`UPDATE tasks SET state=? WHERE id=?`).run(state, id);
}

describe("dashboard model", () => {
  test("task forest uses parent_task_id and orders active before done", () => {
    const p = addTask(db, { title: "parent" });
    const cDone = addTask(db, { title: "done child", parentTaskId: p.id });
    const cRun = addTask(db, { title: "running child", parentTaskId: p.id });
    setState(p.id, "running");
    setState(cDone.id, "done");
    setState(cRun.id, "running");
    const v = view();
    expect(v.taskForest.map((n) => n.id)).toEqual([p.id]);
    expect(v.taskForest[0].children.map((n) => n.id)).toEqual([cRun.id, cDone.id]);
    expect(v.tasksById[cRun.id].depth).toBe(1);
  });

  test("a fully-done subtree is marked allDone with its size", () => {
    const p = addTask(db, { title: "p" });
    const c = addTask(db, { title: "c1", parentTaskId: p.id });
    const g = addTask(db, { title: "c2", parentTaskId: c.id });
    for (const id of [p.id, c.id, g.id]) setState(id, "done");
    const n = view().tasksById[p.id];
    expect(n.allDone).toBe(true);
    expect(n.subtreeSize).toBe(3);
  });

  test("worker joins its CURRENT runtime (generation match), not a stale one", () => {
    registerWorker(db, "w", { role: "worker" });
    db.query(`UPDATE workers SET generation=2 WHERE id='w'`).run();
    recordRuntime(db, { workerId: "w", generation: 1, runtimeId: "old", paneId: "w1:pold", state: "stale", relayOwned: 0 });
    recordRuntime(db, { workerId: "w", generation: 2, runtimeId: "new", paneId: "w1:pnew", state: "active", relayOwned: 0 });
    const w = view().workers[0];
    expect(w.runtime.generation).toBe(2);
    expect(w.paneId).toBe("w1:pnew");
    expect(w.oldRuntimes.map((r) => r.generation)).toEqual([1]);
  });

  test("execution state is Herdr telemetry, separate from Relay state", () => {
    registerWorker(db, "w", { role: "worker" });
    const t = addTask(db, { title: "work" });
    claimTask(db, t.id, "w");
    recordRuntime(db, { workerId: "w", generation: 1, runtimeId: "x", paneId: "w1:p1", state: "active", relayOwned: 0 });
    db.query(`UPDATE workers SET generation=1 WHERE id='w'`).run();

    const busy = view(new Map([["w1:p1", pane("w1:p1", "working")]])).workers[0];
    expect(busy.state).toBe("working"); // Relay state
    expect(busy.exec).toBe("busy"); // Herdr telemetry

    const idle = view(new Map([["w1:p1", pane("w1:p1", "idle")]])).workers[0];
    expect(idle.exec).toBe("!idle");
    expect(view(new Map([["w1:p1", pane("w1:p1", "idle")]])).attention
      .some((a) => a.text.includes("runtime idle"))).toBe(true);
  });

  test("an active quiet lease renders as quiet and suppresses !idle", () => {
    registerWorker(db, "w", { role: "worker" });
    const t = addTask(db, { title: "work" });
    claimTask(db, t.id, "w");
    recordRuntime(db, { workerId: "w", generation: 1, runtimeId: "x", paneId: "w1:p1", state: "active", relayOwned: 0 });
    db.query(`UPDATE workers SET generation=1 WHERE id='w'`).run();
    setQuiet(db, "w", t.id, at + 60_000, "benchmark running");
    const w = view(new Map([["w1:p1", pane("w1:p1", "idle")]])).workers[0];
    expect(w.exec).toBe("quiet");
    expect(w.quietRemainingMs).toBe(60_000);
    expect(w.quietReason).toBe("benchmark running");
  });

  test("retired workers are excluded; a worker with no runtime stays visible", () => {
    registerWorker(db, "live", { role: "worker" });
    registerWorker(db, "gone", { role: "worker" });
    db.query(`UPDATE workers SET retired_at=1 WHERE id='gone'`).run();
    const v = view();
    expect(v.workers.map((w) => w.id)).toEqual(["live"]);
    expect(v.workers[0].paneId).toBeNull();
    expect(v.workers[0].exec).toBe("unavailable");
    expect(v.attention.some((a) => a.text.includes("no visible runtime pane"))).toBe(true);
  });

  test("attention: unclaimable + blocked reason; unread is status (WORKERS, not ATTENTION)", () => {
    registerWorker(db, "w", { role: "worker" });
    addTask(db, { title: "x", role: "ghost-role" }); // queued, no worker has this role
    const b = addTask(db, { title: "b" });
    claimTask(db, b.id, "w");
    blockTask(db, b.id, "w", "need API semantics", true);
    db.query(`INSERT INTO messages (recipient,state,created_at) VALUES ('w','queued',1)`).run();
    const texts = view().attention.map((a) => a.text).join(" | ");
    expect(texts).toContain("unclaimable role=ghost-role");
    expect(texts).toContain("blocked_human: need API semantics");
    // Unread is STATUS, not attention: it must not pad ATTENTION.
    expect(texts).not.toContain("unread messages");
    // ...it is shown on the WORKERS row instead.
    const out = renderDashboard(view(), { color: false, width: 120 });
    const workersSection = out.split("WORKERS")[1];
    expect(workersSection).toContain("mail:1");
  });
});

describe("dashboard renderer", () => {
  function sample(): DashboardView {
    registerWorker(db, "dp-1", { role: "worker" });
    const t = addTask(db, { title: "Storage engine" });
    claimTask(db, t.id, "dp-1");
    recordRuntime(db, { workerId: "dp-1", generation: 3, runtimeId: "dp_1", paneId: "w52:p8K", state: "active", relayOwned: 0 });
    db.query(`UPDATE workers SET generation=3 WHERE id='dp-1'`).run();
    return view(new Map([["w52:p8K", pane("w52:p8K", "working")]]));
  }

  test("standard width, no ANSI when color is off", () => {
    const out = renderDashboard(sample(), { color: false, links: false, width: 100 });
    expect(out).toContain("WORK");
    expect(out).toContain("WORKERS");
    expect(out).toContain("ATTENTION");
    expect(out).not.toContain("\x1b[");
    expect(out).toContain("dp-1");
    expect(out).toContain("g3");
    expect(out).toContain("w52:p8K");
  });

  test("ATTENTION renders FIRST, before WORK and WORKERS (T341)", () => {
    const out = renderDashboard(sample(), { color: false, links: false, width: 100 });
    const lines = out.split("\n");
    const iAtt = lines.findIndex((l) => l === "ATTENTION" || l.startsWith("ATTENTION ·"));
    const iWork = lines.findIndex((l) => l === "WORK");
    const iWorkers = lines.findIndex((l) => l === "WORKERS");
    expect(iAtt).toBeGreaterThan(-1);
    expect(iWork).toBeGreaterThan(-1);
    expect(iWorkers).toBeGreaterThan(-1);
    // The actionable section is above the (potentially long, clipped) tree.
    expect(iAtt).toBeLessThan(iWork);
    expect(iWork).toBeLessThan(iWorkers);
  });

  test("OSC8 pane link when links are on", () => {
    const out = renderDashboard(sample(), { color: true, links: true, width: 100 });
    expect(out).toContain("\x1b]8;;https://relay.local/pane/w52:p8K");
  });

  test("narrow widths never overflow", () => {
    const v = sample();
    for (const w of [36, 44, 50, 60, 72, 90, 120]) {
      for (const line of renderDashboard(v, { color: false, width: w }).split("\n")) {
        expect(dwidth(line)).toBeLessThanOrEqual(w);
      }
    }
  });

  test("CJK width counts as 2 and trims with an ellipsis", () => {
    expect(dwidth("高性能")).toBe(6);
    expect(dwidth(trim("高性能ソフトウェアの比較", 8))).toBeLessThanOrEqual(8);
  });

  test("json preserves the worker/runtime split", () => {
    const payload = JSON.parse(renderDashboardJson(sample()));
    expect(payload).toHaveProperty("summary");
    expect(payload).toHaveProperty("task_tree");
    expect(payload).toHaveProperty("workers");
    expect(payload.workers[0].runtime.generation).toBe(3);
    expect(payload.workers[0].execution.state).toBe("busy");
    expect(JSON.stringify(payload)).not.toContain("plan_id");
  });

  test("CLI: relay dashboard --json and --doctor", () => {
    registerWorker(db, "w", { role: "worker" });
    addTask(db, { title: "x" });
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    // Explicit db path + color off: the test must not depend on cwd resolution
    // or inherit a parent that redirects stdout.
    const env = { ...process.env, FORCE_COLOR: "0", RELAY_DB: join(dir, ".relay", "state.db") };
    const j = Bun.spawnSync(["bun", cli, "dashboard", "--json"], { cwd: dir, env });
    expect(j.exitCode).toBe(0);
    const payload = JSON.parse(j.stdout.toString());
    expect(payload).toHaveProperty("workers");
    const d = Bun.spawnSync(["bun", cli, "dashboard", "--doctor"], { cwd: dir, env });
    expect(d.exitCode).toBe(0);
    expect(d.stdout.toString()).toContain("relay db");
    expect(d.stdout.toString()).toContain("current runtimes");
  });
});
