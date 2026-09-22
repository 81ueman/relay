import { describe, expect, test } from "bun:test";
import { attachPrompt, createLane, reapLane, type HerdrResult, type HerdrRunner } from "../src/spawn";

// T328: one-command lane setup/teardown. These tests drive the orchestration
// with an INJECTED herdr runner, so they prove the exact argv sequence and the
// fail-closed / idempotent behaviour without touching a real Herdr or a
// worktree. The live side is verified separately (documented in the task).

interface Call {
  args: string[];
}

/** A fake runner: records argv and answers per-command, with optional failures. */
function fakeRunner(handlers: {
  worktreeCreate?: HerdrResult;
  paneList?: HerdrResult;
  agentStart?: HerdrResult;
  agentPrompt?: HerdrResult;
  tabClose?: HerdrResult;
  worktreeRemove?: HerdrResult;
}): { run: HerdrRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: HerdrRunner = (args) => {
    calls.push({ args });
    const [top, sub, ...rest] = args;
    const ok = (stdout: string): HerdrResult => ({ ok: true, stdout, stderr: "" });
    const bad = (stderr: string): HerdrResult => ({ ok: false, stdout: "", stderr });
    if (top === "worktree" && sub === "create") return handlers.worktreeCreate ?? ok(JSON.stringify({ result: { worktree: { path: "/wt/lane", open_workspace_id: "w99" } } }));
    if (top === "worktree" && sub === "remove") return handlers.worktreeRemove ?? ok("{}");
    if (top === "pane" && sub === "list") return handlers.paneList ?? ok(JSON.stringify({ result: { panes: [{ id: "w99:p1", workspace_id: "w99", is_root: true }] } }));
    if (top === "agent" && sub === "start") return handlers.agentStart ?? ok("{}");
    if (top === "agent" && sub === "prompt") return handlers.agentPrompt ?? ok("{}");
    if (top === "tab" && sub === "close") return handlers.tabClose ?? ok("{}");
    return bad(`unexpected: ${args.join(" ")} (${rest.join(" ")})`);
  };
  return { run, calls };
}

describe("worker spawn: createLane (T328)", () => {
  test("creates the worktree, finds the root pane and starts the agent", () => {
    const { run, calls } = fakeRunner({});
    const r = createLane({ id: "dsl-v4-w1", role: "dsl-v4", base: "dsl-v4", label: "DSL-V4-W1", run });

    expect(r.worktreePath).toBe("/wt/lane");
    expect(r.workspaceId).toBe("w99");
    expect(r.paneId).toBe("w99:p1");
    expect(r.createdWorktree).toBe(true);

    const argv = calls.map((c) => c.args);
    // The exact documented sequence, in order.
    expect(argv[0]).toEqual(["worktree", "create", "--branch", "dsl-v4-w1", "--base", "dsl-v4", "--label", "DSL-V4-W1", "--no-focus"]);
    expect(argv[1]).toEqual(["pane", "list", "--json"]);
    expect(argv[2]).toEqual(["agent", "start", "dsl-v4-w1", "--kind", "opencode", "--pane", "w99:p1", "--timeout", "90000"]);
  });

  test("--cwd reuses an existing directory: NO worktree create is run", () => {
    const { run, calls } = callLog();
    const r = createLane({ id: "reviewer-4", role: "reviewer", cwd: "/existing/dir", pane: "w75:p1", run });
    expect(r.createdWorktree).toBe(false);
    expect(r.worktreePath).toBe("/existing/dir");
    expect(calls.map((c) => c.args[0])).not.toContain("worktree");
    expect(calls.map((c) => c.args).some((a) => a[0] === "agent" && a[1] === "start")).toBe(true);
  });

  test("a failed worktree create fails closed with the herdr reason", () => {
    const { run } = fakeRunner({ worktreeCreate: { ok: false, stdout: "", stderr: "branch exists" } });
    expect(() => createLane({ id: "x", role: "worker", run })).toThrow(/worktree create failed: branch exists/);
  });

  test("a failed agent start fails closed (never reports a started lane)", () => {
    const { run } = fakeRunner({ agentStart: { ok: false, stdout: "", stderr: "pane busy" } });
    expect(() => createLane({ id: "x", role: "worker", run })).toThrow(/agent start failed: pane busy/);
  });

  test("a worktree create with no path is refused (cannot register blind)", () => {
    const { run } = fakeRunner({ worktreeCreate: { ok: true, stdout: "{}", stderr: "" } });
    expect(() => createLane({ id: "x", role: "worker", run })).toThrow(/returned no path/);
  });

  test("kind=codex is passed through to agent start", () => {
    const { run, calls } = callLog();
    createLane({ id: "codex-w", role: "worker", kind: "codex", cwd: "/d", pane: "w1:p1", run });
    const start = calls.map((c) => c.args).find((a) => a[0] === "agent" && a[1] === "start")!;
    expect(start).toContain("codex");
  });
});

describe("worker spawn: attach prompt (T328)", () => {
  test("names the worker and pane, and the pane is optional", () => {
    expect(attachPrompt("w1", "w1:p2")).toContain('worker_id="w1"');
    expect(attachPrompt("w1", "w1:p2")).toContain('pane_id="w1:p2"');
    expect(attachPrompt("w1", null)).toContain("your pane");
  });
});

describe("worker reap: idempotent teardown (T328)", () => {
  test("closes the pane then removes the worktree", () => {
    const { run, calls } = fakeRunner({});
    const steps = reapLane({ workerId: "w1", paneId: "w1:p2", worktreePath: "/wt/lane", run });
    expect(calls.map((c) => c.args)).toEqual([
      ["tab", "close", "w1:p2"],
      ["worktree", "remove", "--path", "/wt/lane"],
    ]);
    expect(steps.join("\n")).toContain("tab close w1:p2: ok");
    expect(steps.join("\n")).toContain("worktree remove /wt/lane: ok");
  });

  test("an already-gone pane/worktree is reported, not an error", () => {
    const { run } = fakeRunner({
      tabClose: { ok: false, stdout: "", stderr: "no such pane" },
      worktreeRemove: { ok: false, stdout: "", stderr: "not a worktree" },
    });
    const steps = reapLane({ workerId: "w1", paneId: "gone:p1", worktreePath: "/gone", run });
    expect(steps.join("\n")).toContain("tab close gone:p1: gone/failed");
    expect(steps.join("\n")).toContain("worktree remove /gone: gone/failed");
  });

  test("no pane/worktree given: nothing is run", () => {
    const { run, calls } = fakeRunner({});
    const steps = reapLane({ workerId: "w1", run });
    expect(steps).toEqual([]);
    expect(calls).toEqual([]);
  });
});

function callLog() {
  return fakeRunner({});
}
