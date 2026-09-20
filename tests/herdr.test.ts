import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { listEvents } from "../src/events";
import { handleSocketMessage, type SocketContext } from "../src/socket";
import { MockRuntime, type HerdrIdentity } from "../src/runtime/runtime";
import { buildRuntime, pickIdentityByDirectory, resolveHerdrTarget, type HerdrAgentEntry } from "../src/runtime/herdr";
import { reconcile } from "../src/reconciler";
import { attachSession, getSession } from "../src/sessions";
import {
  cleanupCandidates,
  findRuntime,
  listRuntimes,
  recordRuntime,
} from "../src/runtimes";
import { getWorker, listWorkers, registerWorker } from "../src/workers";

// Relay is a Herdr-ONLY control plane. These tests pin the Herdr contract:
// every managed session has a verified Herdr identity, relay-owned and adopted
// (manual) runtimes are distinguished, and an adopted tab is NEVER closed.

const IDENTITY: HerdrIdentity = {
  agent: "herdr-agent",
  tabId: "w9:t2",
  paneId: "w9:p3",
  workspaceId: "w9",
  agentKind: "opencode",
};

let dir = "";
let db: Database;
let rt: MockRuntime;
let ctx: SocketContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-herdr-"));
  process.env.RELAY_DB = join(dir, "state.db");
  process.env.RELAY_LEASE_MS = "120000";
  process.env.RELAY_STALL_MS = "60000";
  process.env.RELAY_WAKE_COOLDOWN_MS = "0";
  process.env.RELAY_RESTART_COOLDOWN_MS = "0";
  process.env.RELAY_ATTACH_TIMEOUT_MS = "30000";
  process.env.RELAY_RUNTIME_CLEANUP_GRACE_MS = "300000";
  delete process.env.RELAY_AUTO_APPROVE;
  db = openDb(process.env.RELAY_DB);
  rt = new MockRuntime();
  ctx = { db, runtime: rt, wakeReconcile: { value: false } };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function eventCount(): number {
  return listEvents(db, { limit: 10000 }).length;
}

describe("A. manual attach of an existing Herdr session", () => {
  test("registers the existing runtime active with relay_owned=false", async () => {
    rt.setIdentity("ses_manual", IDENTITY);
    const res = await handleSocketMessage(
      {
        type: "session.attach",
        session_id: "ses_manual",
        role: "worker",
        pane_id: IDENTITY.paneId,
        tab_id: IDENTITY.tabId,
        workspace_id: IDENTITY.workspaceId ?? undefined,
        directory: "/tmp",
      },
      ctx
    );
    expect(res.ok).toBe(true);
    expect(res.generation).toBe(1);
    // The plugin's hints are forwarded to the resolver (verified in production).
    expect(rt.resolves[0]).toMatchObject({
      sessionId: "ses_manual",
      hint: { paneId: IDENTITY.paneId, tabId: IDENTITY.tabId, workspaceId: IDENTITY.workspaceId },
    });

    const s = getSession(db, "ses_manual")!;
    expect(s.managed).toBe(1);
    const w = getWorker(db, s.worker_id!)!;
    expect(w.state).toBe("idle");
    expect(w.runtime_id).toBe(IDENTITY.agent);
    expect(w.opencode_session_id).toBe("ses_manual");
    expect(w.generation).toBe(1);

    const rows = listRuntimes(db, { workerId: w.id, generation: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("active");
    expect(rows[0].relay_owned).toBe(0);
    expect(rows[0].tab_id).toBe(IDENTITY.tabId);
    expect(rows[0].pane_id).toBe(IDENTITY.paneId);
    expect(rows[0].workspace_id).toBe(IDENTITY.workspaceId);
  });
});

describe("B. non-Herdr attach is rejected", () => {
  test("an unverifiable identity creates no session, worker or runtime", async () => {
    const before = eventCount();
    const res = await handleSocketMessage(
      { type: "session.attach", session_id: "ses_outside", role: "worker" },
      ctx
    );
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toMatch(/Herdr/);
    expect(getSession(db, "ses_outside")).toBeNull();
    expect(listWorkers(db)).toHaveLength(0);
    expect(listRuntimes(db)).toHaveLength(0);
    expect(eventCount()).toBe(before);
  });
});

describe("C+D. an adopted runtime is replaced but never cleaned", () => {
  test("manual g1 -> stale (never closed) while a fresh relay-owned g2 spawns", async () => {
    rt.setIdentity("ses_man", IDENTITY);
    const res = await handleSocketMessage(
      { type: "session.attach", session_id: "ses_man", role: "worker", pane_id: IDENTITY.paneId },
      ctx
    );
    const workerId = String(res.worker_id);

    rt.setAlive(workerId, false);
    await reconcile(db, rt);

    const g1 = findRuntime(db, workerId, 1)!;
    const g2 = findRuntime(db, workerId, 2)!;
    expect(g1.state).toBe("stale");
    expect(g1.relay_owned).toBe(0);
    expect(g2.state).toBe("starting");
    expect(g2.relay_owned).toBe(1);
    expect(getWorker(db, workerId)!.runtime_id).toBe(g2.runtime_id);
    expect(getWorker(db, workerId)!.generation).toBe(2);

    // Pretend g1's grace period elapsed: it is still NOT a cleanup candidate.
    db.query(`UPDATE worker_runtimes SET cleanup_after = ? WHERE id = ?`).run(Date.now() - 1000, g1.id);
    const { actions } = await reconcile(db, rt);
    expect(cleanupCandidates(db, Date.now()).some((c) => c.id === g1.id)).toBe(false);
    expect(rt.cleanups).toHaveLength(0);
    expect(findRuntime(db, workerId, 1)!.state).toBe("stale"); // tab remains
    expect(actions.some((a) => a.startsWith("cleaned:"))).toBe(false);

    // Defense in depth: the adapter refuses to clean it outright.
    await expect(
      rt.cleanup({
        worker_id: workerId,
        generation: 1,
        runtime_id: g1.runtime_id,
        tab_id: g1.tab_id,
        pane_id: g1.pane_id,
        relay_owned: 0,
      })
    ).rejects.toThrow();

    // The fresh relay-owned generation completes attach and becomes active.
    const fresh = await handleSocketMessage(
      { type: "session.attach", session_id: "ses_man2", worker_id: workerId, generation: 2, token: g2.attach_token! },
      ctx
    );
    expect(fresh.ok).toBe(true);
    await reconcile(db, rt);
    expect(findRuntime(db, workerId, 2)!.state).toBe("active");
    expect(getWorker(db, workerId)!.opencode_session_id).toBe("ses_man2");
    expect(findRuntime(db, workerId, 1)!.relay_owned).toBe(0);
  });
});

describe("E. a relay-owned runtime is cleaned after the grace period", () => {
  test("relay-owned stale + newer generation => close + cleaned", async () => {
    registerWorker(db, "w1", { role: "worker" });
    db.query(`UPDATE workers SET state = 'idle', generation = 2, runtime_id = 'rt-w1-g2' WHERE id = 'w1'`).run();
    recordRuntime(db, {
      workerId: "w1",
      generation: 1,
      runtimeId: "rt-w1-g1",
      tabId: "tab-w1-g1",
      relayOwned: 1,
      state: "stale",
      cleanupAfter: Date.now() - 1000,
    });

    await reconcile(db, rt);

    expect(rt.cleanups).toContain("rt-w1-g1");
    expect(findRuntime(db, "w1", 1)!.state).toBe("cleaned");
  });
});

describe("F. the current generation/runtime is never cleaned", () => {
  test("an active or same-generation relay runtime is protected", async () => {
    registerWorker(db, "w1", { role: "worker" });
    db.query(`UPDATE workers SET state = 'idle', generation = 2, runtime_id = 'rt-w1-g2' WHERE id = 'w1'`).run();
    recordRuntime(db, { workerId: "w1", generation: 2, runtimeId: "rt-w1-g2", relayOwned: 1, state: "active" });
    recordRuntime(db, {
      workerId: "w1",
      generation: 2,
      runtimeId: "rt-w1-g2-dup",
      relayOwned: 1,
      state: "stale",
      cleanupAfter: Date.now() - 1000,
    });

    await reconcile(db, rt);

    expect(rt.cleanups).toHaveLength(0);
    expect(listRuntimes(db, { workerId: "w1", generation: 2 }).find((r) => r.runtime_id === "rt-w1-g2-dup")!.state).toBe("stale");
  });
});

describe("G. Herdr is required to build the production runtime", () => {
  test("unavailable Herdr => buildRuntime throws; MockRuntime is never selected", () => {
    const savedEnv = process.env.HERDR_ENV;
    const savedSock = process.env.HERDR_SOCKET_PATH;
    const savedRuntime = process.env.RELAY_RUNTIME;
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.RELAY_RUNTIME;
    try {
      expect(() => buildRuntime()).toThrow(/requires Herdr/);
    } finally {
      if (savedEnv !== undefined) process.env.HERDR_ENV = savedEnv;
      if (savedSock !== undefined) process.env.HERDR_SOCKET_PATH = savedSock;
      if (savedRuntime !== undefined) process.env.RELAY_RUNTIME = savedRuntime;
    }
  });
});

describe("H. manual attach requires an exact Herdr identity", () => {
  test("an ambiguous/unverifiable mapping is rejected with no half-state", async () => {
    rt.resolveError = "ambiguous Herdr identity for ses_x";
    const res = await handleSocketMessage(
      { type: "session.attach", session_id: "ses_x", role: "worker" },
      ctx
    );
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toMatch(/ambiguous/);
    expect(getSession(db, "ses_x")).toBeNull();
    expect(listWorkers(db)).toHaveLength(0);
    expect(listRuntimes(db)).toHaveLength(0);
  });
});

describe("I. spawned attach requires a matching relay-owned runtime row", () => {
  test("an explicit generation without a runtime row is rejected", async () => {
    const res = await handleSocketMessage(
      { type: "session.attach", session_id: "ses_ghost", worker_id: "w1", generation: 5, token: "x" },
      ctx
    );
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toMatch(/no runtime row/);
    expect(getSession(db, "ses_ghost")).toBeNull();
  });

  test("a non-relay-owned runtime rejects a relay-generation attach", async () => {
    registerWorker(db, "w1", { role: "worker" });
    recordRuntime(db, {
      workerId: "w1",
      generation: 1,
      runtimeId: "rt-ext",
      relayOwned: 0,
      state: "starting",
    });
    const res = await handleSocketMessage(
      { type: "session.attach", session_id: "ses_ext", worker_id: "w1", generation: 1 },
      ctx
    );
    expect(res.ok).toBe(false);
    expect(String(res.reason)).toMatch(/not relay-owned/);
    expect(getSession(db, "ses_ext")).toBeNull();
  });
});

describe("J. old session/generation events are fenced out", () => {
  test("events from a superseded session never touch the current worker", async () => {
    const s1 = attachSession(db, "ses_old", { role: "worker", identity: IDENTITY });
    const workerId = s1.worker_id!;
    // Fresh relay-owned generation supersedes the manual session.
    recordRuntime(db, {
      workerId, generation: 2, runtimeId: "rt-g2", relayOwned: 1, state: "starting", attachToken: "tok-g2",
    });
    attachSession(db, "ses_new", { workerId, generation: 2, attachToken: "tok-g2" });

    expect(getSession(db, "ses_old")!.managed).toBe(0); // superseded
    expect(getWorker(db, workerId)!.opencode_session_id).toBe("ses_new");

    const before = eventCount();
    const old = await handleSocketMessage({ type: "session.idle", session_id: "ses_old", generation: 1 }, ctx);
    expect(old).toMatchObject({ ignored: "unmanaged" });
    const staleGen = await handleSocketMessage({ type: "session.idle", session_id: "ses_new", generation: 1 }, ctx);
    expect(staleGen).toMatchObject({ ignored: "stale-generation" });
    expect(eventCount()).toBe(before);
    expect(rt.wakes).toHaveLength(0);
  });
});

describe("K. directory identification for a shared OpenCode server", () => {
  const agent = (over: Partial<HerdrAgentEntry>): HerdrAgentEntry => ({
    name: "a1",
    agent: "opencode",
    pane_id: "w1:p1",
    tab_id: "w1:t1",
    workspace_id: "w1",
    foreground_cwd: "/proj/one",
    ...over,
  });

  test("a unique opencode agent in the directory resolves", () => {
    const id = pickIdentityByDirectory(
      [agent({ name: "a1", pane_id: "w1:p1", foreground_cwd: "/proj/one" })],
      "ses_x",
      "/proj/one"
    );
    expect(id).toMatchObject({ agent: "a1", paneId: "w1:p1", tabId: "w1:t1", agentKind: "opencode" });
  });

  test("no matching agent (or only non-opencode) is rejected", () => {
    expect(() =>
      pickIdentityByDirectory([agent({ agent: "bash" })], "ses_x", "/proj/one")
    ).toThrow(/not running inside Herdr/);
    expect(() =>
      pickIdentityByDirectory([agent({ foreground_cwd: "/proj/two" })], "ses_x", "/proj/one")
    ).toThrow(/not running inside Herdr/);
  });

  test("two opencode agents in the directory is ambiguous and rejected", () => {
    expect(() =>
      pickIdentityByDirectory(
        [agent({ pane_id: "w1:p1" }), agent({ name: "a2", pane_id: "w1:p2" })],
        "ses_x",
        "/proj/one"
      )
    ).toThrow(/ambiguous/);
  });

  test("a pane with no cwd never matches (no manufactured ambiguity)", () => {
    const id = pickIdentityByDirectory(
      [agent({ name: "a1", foreground_cwd: null, cwd: null }), agent({ name: "a2", foreground_cwd: "/proj/one" })],
      "ses_x",
      "/proj/one"
    );
    expect(id.agent).toBe("a2");
  });

  test("a subdirectory session matches its project pane", () => {
    const id = pickIdentityByDirectory(
      [agent({ name: "a1", foreground_cwd: "/proj/one" })],
      "ses_x",
      "/proj/one/pkg/sub"
    );
    expect(id.agent).toBe("a1");
  });

  test("directory-only manual attach resolves through the socket (no pane env)", async () => {
    rt.setIdentity("ses_dir", { ...IDENTITY, agent: "dir-agent", paneId: "w1:p9", tabId: "w1:t9" });
    const res = await handleSocketMessage(
      { type: "session.attach", session_id: "ses_dir", role: "worker", directory: "/proj/one" },
      ctx
    );
    expect(res.ok).toBe(true);
    // No pane hints were sent: the daemon must have resolved from the directory.
    expect(rt.resolves[0]?.hint).toMatchObject({ directory: "/proj/one", paneId: undefined });
    expect(getWorker(db, String(res.worker_id))!.runtime_id).toBe("dir-agent");
  });
});

// ---------------------------------------------------------------------------
describe("L. wake target resolution", () => {
  const live = (pane_id: string, name?: string): HerdrAgentEntry => ({
    pane_id,
    name: name ?? null,
    tab_id: "w1:t1",
    agent: "opencode",
  });

  test("a recorded runtime that is a live pane is used as-is", () => {
    expect(resolveHerdrTarget({ id: "frontend-eos", runtime_id: "w67:p4" }, [live("w67:p4", "u2_frontend_eos")]))
      .toBe("w67:p4");
  });

  test("a null runtime_id falls back to the sanitized agent name, not the bare id", () => {
    // Worker ids use '-', Herdr agent names use '_': addressing by the id would
    // be agent_not_found, so the live pane must win.
    expect(resolveHerdrTarget({ id: "u2-corpus", runtime_id: null }, [live("w66:p6", "u2_corpus")]))
      .toBe("w66:p6");
  });

  test("a recorded runtime that is an agent NAME resolves to its pane", () => {
    expect(resolveHerdrTarget(
      { id: "control-ospf-research", runtime_id: "u2_ospf_research" },
      [live("w66:p4", "u2_ospf_research")]
    )).toBe("w66:p4");
  });

  test("an exact worker-id match resolves too", () => {
    expect(resolveHerdrTarget({ id: "worker-1", runtime_id: null }, [live("w50:p9", "worker-1")]))
      .toBe("w50:p9");
  });

  test("no live match falls back to the recorded target (honest error)", () => {
    expect(resolveHerdrTarget({ id: "ghost", runtime_id: null }, [])).toBe("ghost");
    expect(resolveHerdrTarget({ id: "ghost", runtime_id: "stale-runtime" }, [])).toBe("stale-runtime");
  });
});
