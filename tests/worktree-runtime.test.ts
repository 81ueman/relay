import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { readPanes } from "../src/dashboard/herdr";
import { buildDashboardView } from "../src/dashboard/model";
import { findWorkerByPane } from "../src/identity";
import { herdrTarget } from "../src/runtime/herdr";
import { adoptRuntimeTarget, cleanupCandidates, getActiveRuntime, listRuntimes, parseHerdrTarget } from "../src/runtimes";
import { addTask, claimNext } from "../src/tasks";
import { getWorker, registerWorker } from "../src/workers";

// Regression: a supervised worker placed in a git WORKTREE is invisible and
// cannot be woken.
//
// BUG A: `relay worker register --runtime <pane>` set only workers.runtime_id (a
// DISPLAY column) and never inserted a worker_runtimes row, while every
// projection reads worker_runtimes. So the worker had no runtime at all and the
// dashboard said "supervised worker has no visible runtime pane".
//
// BUG B: buildDashboardView read panes with a global cwd-root filter
// (`isUnder(p.cwd, root)`). A Herdr worktree pane lives at
// ~/.herdr/worktrees/<repo>/<wt>, which is NOT under the repo root, so the pane
// was silently dropped even though its workspace WAS in relayWorkspaces.
//
// The fake `herdr` below reports one worktree pane in workspace w6G and one
// unrelated pane in wZZ, so the tests exercise the real readPanes filter.

let dir = "";
let root = "";
let dbPath = "";
let savedPath: string | undefined;
let savedEnv: string | undefined;

const WORKTREE_CWD = "/Users/81ueman/.herdr/worktrees/nv-papers/dp-w4";

const FAKE_HERDR = `#!/bin/sh
if [ "$1" = "pane" ] && [ "$2" = "list" ]; then
  cat <<'JSON'
{"result":{"panes":[
 {"pane_id":"w6G:p1","agent":"opencode","agent_status":"working","terminal_title_stripped":"dp-w4","cwd":"${WORKTREE_CWD}","workspace_id":"w6G","tab_id":"w6G:t1","focused":false},
 {"pane_id":"wZZ:p9","agent":"opencode","agent_status":"idle","cwd":"/somewhere/else","workspace_id":"wZZ","tab_id":"wZZ:t1","focused":false}
]}}
JSON
  exit 0
fi
exit 1
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-worktree-"));
  root = join(dir, "repo");
  mkdirSync(join(root, ".relay"), { recursive: true });
  dbPath = join(root, ".relay", "state.db");
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const herdr = join(binDir, "herdr");
  writeFileSync(herdr, FAKE_HERDR, "utf-8");
  chmodSync(herdr, 0o755);
  savedPath = process.env.PATH;
  savedEnv = process.env.HERDR_ENV;
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  process.env.HERDR_ENV = "1";
});

afterEach(() => {
  process.env.PATH = savedPath;
  if (savedEnv === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("readPanes: a runtime pane is resolved by its OWN runtime, not cwd prefix", () => {
  test("a worktree pane outside the repo root is kept when it is a known runtime pane", () => {
    const panes = readPanes({ workspaces: ["w6G"], knownPanes: ["w6G:p1"], cwdRoot: root })!;
    expect(panes.has("w6G:p1")).toBe(true);
    expect(panes.get("w6G:p1")!.cwd).toBe(WORKTREE_CWD);
    // An unrelated pane outside the root with no runtime row is still excluded.
    expect(panes.has("wZZ:p9")).toBe(false);
  });

  test("without a runtime record, the same pane is (still) filtered by cwdRoot", () => {
    const panes = readPanes({ workspaces: ["w6G"], cwdRoot: root })!;
    expect(panes.has("w6G:p1")).toBe(false);
  });
});

describe("dashboard: a worktree worker with a runtime row is visible", () => {
  test("resolves the pane, reads exec state, and emits no 'no visible runtime pane'", () => {
    const db = openDb(dbPath);
    try {
      registerWorker(db, "dataplane-w4", { role: "perf-go" });
      adoptRuntimeTarget(db, { workerId: "dataplane-w4", generation: 0, target: "w6G:p1" });
      addTask(db, { title: "T157", role: "perf-go" });
      claimNext(db, "dataplane-w4");

      const view = buildDashboardView(db, { root });
      const w = view.workers.find((x) => x.id === "dataplane-w4")!;
      expect(view.summary.herdr).toBe(true);
      expect(w.paneId).toBe("w6G:p1");
      expect(w.execution.agentStatus).toBe("working");
      expect(w.exec).toBe("busy");
      expect(view.attention.some((a) => a.text.includes("no visible runtime pane"))).toBe(false);
    } finally {
      db.close();
    }
  });
});

describe("relay worker register --runtime records a real adopted runtime", () => {
  test("the worker becomes visible and addressable (relay_owned=0, never reaped)", async () => {
    const proc = Bun.spawn(
      ["bun", "src/cli.ts", "worker", "register", "dataplane-w4", "--role", "perf-go", "--runtime", "w6G:p1", "--cwd", WORKTREE_CWD],
      { cwd: join(import.meta.dir, ".."), env: { ...process.env, RELAY_DB: dbPath }, stdout: "pipe", stderr: "pipe" }
    );
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited, stderr).toBe(0);

    const db = openDb(dbPath);
    try {
      const rt = getActiveRuntime(db, "dataplane-w4");
      expect(rt).not.toBeNull();
      expect(rt!.pane_id).toBe("w6G:p1");
      expect(rt!.workspace_id).toBe("w6G");
      expect(rt!.runtime_id).toBe("w6G:p1");
      expect(rt!.relay_owned).toBe(0);
      expect(rt!.state).toBe("active");

      // Visible to the pane-resolution / wake identity paths...
      expect(findWorkerByPane(db, "w6G:p1")).toBe("dataplane-w4");
      const w = getWorker(db, "dataplane-w4")!;
      expect(herdrTarget(w)).toBe("w6G:p1");
      // ...and NEVER reaped: cleanup candidates exclude relay_owned=0.
      const after = Date.now() + 24 * 60 * 60 * 1000;
      expect(cleanupCandidates(db, after).some((r) => r.id === rt!.id)).toBe(false);
    } finally {
      db.close();
    }
  });

  test("re-registering is idempotent: no duplicate active runtime", async () => {
    const run = () =>
      Bun.spawn(
        ["bun", "src/cli.ts", "worker", "register", "dataplane-w4", "--role", "perf-go", "--runtime", "w6G:p1", "--cwd", WORKTREE_CWD],
        { cwd: join(import.meta.dir, ".."), env: { ...process.env, RELAY_DB: dbPath }, stdout: "pipe", stderr: "pipe" }
      );
    expect(await (await run()).exited).toBe(0);
    expect(await (await run()).exited).toBe(0);

    const db = openDb(dbPath);
    try {
      expect(listRuntimes(db, { workerId: "dataplane-w4", state: "active" }).length).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("parseHerdrTarget", () => {
  test("splits pane / tab / workspace; an agent name yields nothing", () => {
    expect(parseHerdrTarget("w6G:p1")).toEqual({ paneId: "w6G:p1", tabId: null, workspaceId: "w6G" });
    expect(parseHerdrTarget("w6G:t2")).toEqual({ paneId: null, tabId: "w6G:t2", workspaceId: "w6G" });
    expect(parseHerdrTarget("dp-w4-agent")).toEqual({ paneId: null, tabId: null, workspaceId: null });
  });
});
