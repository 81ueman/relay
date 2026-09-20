import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { listEvents } from "../src/events";
import { handleSocketMessage, type SocketContext } from "../src/socket";
import { MockRuntime, type HerdrIdentity } from "../src/runtime/runtime";
import { reconcile } from "../src/reconciler";
import { isRecoverableWorker, isSupervisedWorker } from "../src/scheduler";
import { attachSession, detachSession, getSession } from "../src/sessions";
import { findRuntime, listRuntimes, recordRuntime } from "../src/runtimes";
import { getWorker, registerWorker } from "../src/workers";

// Fresh-generation lifecycle correctness:
//   - the runtime row is durable BEFORE the bootstrap prompt (durable-before-wake)
//   - an attach that races the bootstrap still succeeds
//   - a failed bootstrap wake keeps the generation and retries
//   - an attach timeout leaves the worker RECOVERABLE (fresh generation, not a
//     permanent dead end) and the timed-out runtime is reaped after grace
//   - an explicitly detached worker is NEVER recovered
//   - generation is monotonic across manual attaches, spawns and runtime history

const IDENTITY: HerdrIdentity = {
  agent: "herdr-a",
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
  dir = mkdtempSync(join(tmpdir(), "agentctl-freshgen-"));
  process.env.AGENTCTL_DB = join(dir, "state.db");
  process.env.AGENTCTL_LEASE_MS = "120000";
  process.env.AGENTCTL_STALL_MS = "60000";
  process.env.AGENTCTL_WAKE_COOLDOWN_MS = "0";
  process.env.AGENTCTL_RESTART_COOLDOWN_MS = "0";
  process.env.AGENTCTL_ATTACH_TIMEOUT_MS = "30000";
  process.env.AGENTCTL_RUNTIME_CLEANUP_GRACE_MS = "300000";
  delete process.env.AGENTCTL_BOOTSTRAP_RETRY_MS;
  delete process.env.AGENTCTL_AUTO_APPROVE;
  db = openDb(process.env.AGENTCTL_DB);
  rt = new MockRuntime();
  ctx = { db, runtime: rt, wakeReconcile: { value: false } };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function eventTypes(): string[] {
  return listEvents(db, { limit: 10000 }).map((e) => e.type);
}

/** Register a worker and bind a MANAGED relay-spawned session at `generation`. */
function seedSpawned(id: string, generation: number, state = "idle"): void {
  registerWorker(db, id, { role: "worker" });
  const token = `seed-${id}-g${generation}`;
  recordRuntime(db, {
    workerId: id,
    generation,
    runtimeId: `rt-${id}-g${generation}`,
    tabId: `tab-${id}-g${generation}`,
    state: "starting",
    relayOwned: 1,
    attachToken: token,
  });
  attachSession(db, `ses_${id}`, { workerId: id, role: "worker", generation, attachToken: token });
  db.query(`UPDATE workers SET state = ? WHERE id = ?`).run(state, id);
  rt.setAlive(id, true);
}

describe("fresh generation ordering", () => {
  test("runtime row is committed BEFORE the bootstrap; an attach racing it succeeds", async () => {
    seedSpawned("w1", 1);
    rt.setAlive("w1", false);

    let sawRowBeforeBootstrap = false;
    let attachRes: Record<string, unknown> | null = null;
    const origWake = rt.wake.bind(rt);
    rt.wake = async (w: any, text: string) => {
      await origWake(w, text);
      const m = /RELAY-ATTACH worker=(\S+) gen=(\d+) token=(\S+)/.exec(text);
      if (!m) return;
      // The daemon must already have recorded the generation durably.
      const rr = findRuntime(db, m[1], Number(m[2]));
      expect(rr).not.toBeNull();
      expect(rr!.state).toBe("starting");
      expect(rr!.relay_owned).toBe(1);
      expect(rr!.attach_token).toBe(m[3]);
      expect(getWorker(db, m[1])!.generation).toBe(Number(m[2]));
      sawRowBeforeBootstrap = true;
      // Simulate the freshly spawned session attaching the instant it is prompted.
      attachRes = await handleSocketMessage(
        { type: "session.attach", session_id: "ses_racing", worker_id: m[1], generation: Number(m[2]), token: m[3] },
        ctx
      );
    };

    await reconcile(db, rt);

    expect(sawRowBeforeBootstrap).toBe(true);
    expect(attachRes).toMatchObject({ ok: true, managed: true, generation: 2 });
    const rr = findRuntime(db, "w1", 2)!;
    expect(rr.state).toBe("active");
    expect(getSession(db, "ses_racing")!.managed).toBe(1);
    expect(getWorker(db, "w1")!.opencode_session_id).toBe("ses_racing");
  });

  test("a failed bootstrap wake keeps the generation and retries after the cooldown", async () => {
    process.env.AGENTCTL_BOOTSTRAP_RETRY_MS = "0";
    seedSpawned("w1", 1);
    rt.setAlive("w1", false);
    rt.failWake.add("w1");

    await reconcile(db, rt);

    // The generation survives: runtime still starting, worker still supervised.
    const rr = findRuntime(db, "w1", 2)!;
    expect(rr.state).toBe("starting");
    expect(rr.bootstrap_sent_at).toBeNull();
    expect(getWorker(db, "w1")!.generation).toBe(2);
    expect(getWorker(db, "w1")!.state).toBe("starting");
    expect(eventTypes()).toContain("worker.bootstrap_failed");

    // Recover the daemon: the next pass re-delivers and records the timestamp.
    rt.failWake.delete("w1");
    await reconcile(db, rt);
    const rr2 = findRuntime(db, "w1", 2)!;
    expect(rr2.state).toBe("starting"); // no attach yet
    expect(rr2.bootstrap_sent_at).not.toBeNull();
  });
});

describe("attach timeout recovery", () => {
  test("a never-attaching generation stays recoverable, then gets a fresh generation and the dead one is reaped", async () => {
    process.env.AGENTCTL_ATTACH_TIMEOUT_MS = "1";
    process.env.AGENTCTL_RESTART_COOLDOWN_MS = "60000";
    process.env.AGENTCTL_RUNTIME_CLEANUP_GRACE_MS = "0";
    seedSpawned("w1", 1);
    rt.setAlive("w1", false);

    const t0 = Date.now();
    await reconcile(db, rt, t0);
    expect(getWorker(db, "w1")!.generation).toBe(2);
    // The transport is alive (agent up) but the generation never attached; the
    // restart cooldown blocks an immediate respawn.
    rt.setAlive("w1", true);

    await reconcile(db, rt, t0 + 100);
    expect(findRuntime(db, "w1", 2)!.state).toBe("dead");
    expect(getWorker(db, "w1")!.state).toBe("dead");
    // Crucially: the worker is still recoverable, not permanently dropped.
    const dead = getWorker(db, "w1")!;
    expect(isRecoverableWorker(db, dead)).toBe(true);
    expect(isSupervisedWorker(db, dead)).toBe(true);

    // Still inside the restart cooldown: no respawn yet.
    await reconcile(db, rt, t0 + 200);
    expect(getWorker(db, "w1")!.generation).toBe(2);

    // After the cooldown a fresh generation is spawned, even though the old
    // transport process is still alive.
    await reconcile(db, rt, t0 + 70000);
    expect(getWorker(db, "w1")!.generation).toBe(3);
    expect(findRuntime(db, "w1", 3)!.state).toBe("starting");

    // The timed-out generation is cleaned through the normal grace path.
    await reconcile(db, rt, t0 + 70100);
    expect(findRuntime(db, "w1", 2)!.state).toBe("cleaned");
    expect(rt.cleanups).toContain("rt-w1-g1#g2");
  });
});

describe("detached workers are never recovered", () => {
  test("an explicitly detached relay worker with a dead transport stays unsupervised", async () => {
    seedSpawned("w1", 1);
    detachSession(db, "ses_w1");
    expect(getWorker(db, "w1")!.opencode_session_id).toBeNull();
    expect(getWorker(db, "w1")!.state).toBe("idle");

    rt.setAlive("w1", false);
    rt.starts.length = 0;
    const before = getWorker(db, "w1")!.generation;

    await reconcile(db, rt);

    expect(rt.starts).toHaveLength(0);
    expect(getWorker(db, "w1")!.generation).toBe(before);
    expect(getWorker(db, "w1")!.state).toBe("idle");
    expect(isSupervisedWorker(db, getWorker(db, "w1")!)).toBe(false);
  });
});

describe("generation monotonicity", () => {
  test("manual attach is bumped above the worker counter and the whole runtime history", () => {
    registerWorker(db, "w1", { role: "worker" });
    db.query(`UPDATE workers SET generation = 2 WHERE id = 'w1'`).run();
    // A legacy row already reached generation 5.
    recordRuntime(db, { workerId: "w1", generation: 5, runtimeId: "rt-w1-g5", relayOwned: 1, state: "stale" });

    rt.setIdentity("ses_new", IDENTITY);
    const s = attachSession(db, "ses_new", { workerId: "w1", identity: IDENTITY });
    expect(s.generation).toBe(6);
  });

  test("a manual attach on a worker at generation 4 yields >= 5", () => {
    registerWorker(db, "w1", { role: "worker" });
    db.query(`UPDATE workers SET generation = 4 WHERE id = 'w1'`).run();
    rt.setIdentity("ses_new", IDENTITY);
    const s = attachSession(db, "ses_new", { workerId: "w1", identity: IDENTITY });
    expect(s.generation).toBeGreaterThanOrEqual(5);
  });

  test("idempotent re-attach on the same binding does not bump the generation", () => {
    rt.setIdentity("ses_x", IDENTITY);
    const a = attachSession(db, "ses_x", { workerId: "w1", identity: IDENTITY });
    const b = attachSession(db, "ses_x", { workerId: "w1", identity: IDENTITY });
    expect(b.generation).toBe(a.generation);
    const active = listRuntimes(db, { workerId: "w1" }).filter((r) => r.state === "active");
    expect(active).toHaveLength(1);
  });

  test("a spawned attach may not replay an older generation", () => {
    seedSpawned("w1", 3);
    expect(() =>
      attachSession(db, "ses_old", { workerId: "w1", generation: 2, attachToken: "seed-w1-g3" })
    ).toThrow(/older than/);
  });

  test("a fresh spawn is bumped above the runtime history", async () => {
    // worker.generation lags its history (2) but the latest runtime is 5.
    seedSpawned("w1", 5);
    db.query(`UPDATE workers SET generation = 2 WHERE id = 'w1'`).run();
    rt.setAlive("w1", false);
    await reconcile(db, rt);
    expect(getWorker(db, "w1")!.generation).toBe(6);
    expect(findRuntime(db, "w1", 6)!.state).toBe("starting");
  });
});

describe("attach never clobbers the worker's role", () => {
  test("a relay-spawned attach keeps the registered role even if the plugin sends role=worker", () => {
    registerWorker(db, "rev1", { role: "reviewer" });
    const token = "tok-rev1";
    recordRuntime(db, {
      workerId: "rev1",
      generation: 1,
      runtimeId: "rt-rev1-g1",
      state: "starting",
      relayOwned: 1,
      attachToken: token,
    });
    // A legacy plugin still hard-codes role:"worker" on the relay-spawned attach.
    const s = attachSession(db, "ses_rev1", {
      workerId: "rev1",
      role: "worker",
      generation: 1,
      attachToken: token,
    });
    expect(getWorker(db, "rev1")!.role).toBe("reviewer");
    expect(s.role).toBe("reviewer");
    // ...so the review queue still has a reviewer to wake.
    expect(listRuntimes(db, { workerId: "rev1", state: "active" })).toHaveLength(1);
  });

  test("a manual attach without an explicit role preserves the registered role", () => {
    registerWorker(db, "rev2", { role: "reviewer" });
    rt.setIdentity("ses_manual", IDENTITY);
    const s = attachSession(db, "ses_manual", { workerId: "rev2", identity: IDENTITY });
    expect(getWorker(db, "rev2")!.role).toBe("reviewer");
    expect(s.role).toBe("reviewer");
  });

  test("a manual attach WITH an explicit role may still set it", () => {
    registerWorker(db, "w9", { role: "worker" });
    rt.setIdentity("ses_promote", IDENTITY);
    const s = attachSession(db, "ses_promote", { workerId: "w9", role: "reviewer", identity: IDENTITY });
    expect(getWorker(db, "w9")!.role).toBe("reviewer");
    expect(s.role).toBe("reviewer");
  });
});

describe("generation allocation is single-writer", () => {
  // `restartWorker` awaits `rt.start` between reading MAX(generation) and
  // committing, and the daemon loop can overlap with the immediate reconcile on
  // session.error / session.execution.failed. Two passes must never mint the same
  // generation (a plugin holding the losing token could never attach).
  test("concurrent reconcile never allocates the same generation twice", async () => {
    seedSpawned("w1", 1);
    rt.setAlive("w1", false);

    // Hold the first start so a second reconcile can interleave.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let starts = 0;
    rt.start = async (w: any, generation: number) => {
      starts++;
      await gate;
      return {
        runtimeId: `rt-${w.id}-g${generation}`,
        tabId: `tab-${w.id}-g${generation}`,
        paneId: `pane-${w.id}-g${generation}`,
        attachToken: `tok-${w.id}-g${generation}`,
      };
    };

    const p1 = reconcile(db, rt);
    await Bun.sleep(5);
    const p2 = reconcile(db, rt);
    await Bun.sleep(5);
    release();
    await Promise.all([p1, p2]);

    expect(starts).toBe(1);
    const g2 = listRuntimes(db, { workerId: "w1" }).filter((r) => r.generation === 2);
    expect(g2).toHaveLength(1);
    expect(getWorker(db, "w1")!.generation).toBe(2);
  });

  test("a generation taken by a concurrent writer is never re-created", async () => {
    seedSpawned("w1", 1);
    rt.setAlive("w1", false);

    rt.start = async (w: any, generation: number) => {
      // Simulate a second daemon committing this generation while we start.
      recordRuntime(db, {
        workerId: w.id,
        generation,
        runtimeId: `other-${generation}`,
        relayOwned: 1,
        state: "starting",
        attachToken: `other-tok-${generation}`,
      });
      db.query(
        `UPDATE workers SET generation = ?, runtime_id = ?, opencode_session_id = NULL, state = 'starting' WHERE id = ?`
      ).run(generation, `other-${generation}`, w.id);
      return {
        runtimeId: `rt-${w.id}-g${generation}`,
        tabId: `tab-${w.id}-g${generation}`,
        attachToken: `tok-${w.id}-g${generation}`,
      };
    };

    await reconcile(db, rt);

    const g2 = listRuntimes(db, { workerId: "w1" }).filter((r) => r.generation === 2);
    expect(g2).toHaveLength(1);
    expect(g2[0].runtime_id).toBe("other-2");
    // The duplicate transport this daemon started is reaped, not left untracked.
    expect(rt.cleanups).toContain("rt-w1-g2");
    expect(getWorker(db, "w1")!.generation).toBe(2);
    expect(getWorker(db, "w1")!.runtime_id).toBe("other-2");
  });
});
