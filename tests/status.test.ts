import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { MockRuntime } from "../src/runtime/runtime";
import { daemonIdentity } from "../src/singleton";
import { startSocketServer, type SocketContext } from "../src/socket";
import { addTask, claimNext, submitTask } from "../src/tasks";
import { registerWorker } from "../src/workers";

// `relay status` annotates each worker with the tasks it would pick up next.
// Presentation only: the list must match what `relay next --worker <id>` offers
// (the same policy), and must never imply a shared queue is waiting on one
// specific worker.

let dir = "";
let db: Database;
let cli = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-status-"));
  mkdirSync(join(dir, ".relay"), { recursive: true });
  db = openDb(join(dir, ".relay", "state.db"));
  cli = join(import.meta.dir, "..", "src", "cli.ts");
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function status(): string {
  const r = Bun.spawnSync(["bun", cli, "status"], {
    cwd: dir,
    env: { ...process.env, FORCE_COLOR: "0", RELAY_DB: join(dir, ".relay", "state.db") },
  });
  expect(r.exitCode).toBe(0);
  return r.stdout.toString();
}

function workerLine(out: string, id: string): string {
  return out.split("\n").find((l) => l.startsWith(`${id}  `)) ?? "";
}

describe("relay status: what each worker picks up next", () => {
  test("a busy worker shows the queued role-matched tasks behind it", () => {
    registerWorker(db, "perf-research", { role: "perf-research" });
    const running = addTask(db, { title: "current", role: "perf-research" });
    claimNext(db, "perf-research");
    addTask(db, { title: "queued a", role: "perf-research" });
    addTask(db, { title: "queued b", role: "perf-research" });
    // Not the same role: must never be offered here.
    addTask(db, { title: "other", role: "control-rust" });

    const line = workerLine(status(), "perf-research");
    expect(line).toContain("working");
    expect(line).toContain(String(running!.id));
    expect(line).toContain("next: T2,T3 (queued, role match)");
    expect(line).not.toContain("T4");
  });

  test("role-less queued work is claimable by anyone and is shown too", () => {
    registerWorker(db, "w", { role: "worker" });
    const running = addTask(db, { title: "current" });
    claimNext(db, "w");
    addTask(db, { title: "open" });

    const line = workerLine(status(), "w");
    expect(line).toContain(`next: T2 (queued, role match)`);
    expect(line).toContain(String(running!.id));
  });

  test("an idle worker with role-matched work is marked 'wake me'", () => {
    registerWorker(db, "free", { role: "rust" });
    addTask(db, { title: "waiting", role: "rust" });
    const line = workerLine(status(), "free");
    expect(line).toContain("next: T1 (runnable, role match — wake me)");
  });

  test("a worker with nothing to pick up says (none)", () => {
    registerWorker(db, "busy", { role: "rust" });
    const t = addTask(db, { title: "current", role: "rust" });
    claimNext(db, "busy");
    expect(workerLine(status(), "busy")).toContain("next: (none)");
    expect(workerLine(status(), "busy")).toContain(t!.id);
  });

  test("a reviewer lists review tasks, not queued ones, and not its own", () => {
    registerWorker(db, "author", { role: "worker" });
    registerWorker(db, "reviewer", { role: "reviewer" });
    // A fresh worker is `starting`; settle it to idle as a real deployment would.
    db.query(`UPDATE workers SET state='idle' WHERE id='reviewer'`).run();
    const t1 = addTask(db, { title: "one" });
    addTask(db, { title: "not yet" }); // stays queued
    claimNext(db, "author");
    submitTask(db, t1!.id, "author", { evidence: "done" }); // -> review

    expect(workerLine(status(), "reviewer")).toContain(`next: ${t1!.id} (runnable, role match — wake me)`);

    // The reviewer takes it: it is no longer "next", it is the current task.
    claimNext(db, "reviewer");
    const after = workerLine(status(), "reviewer");
    expect(after).toContain(`working  ${t1!.id}`);
    expect(after).toContain("next: (none)");
    expect(after).not.toContain(`next: ${t1!.id}`);
  });

  test("two workers of the same role share the queue and say so", () => {
    registerWorker(db, "r1", { role: "reviewer" });
    registerWorker(db, "r2", { role: "reviewer" });
    registerWorker(db, "author", { role: "worker" });
    const t1 = addTask(db, { title: "one" });
    claimNext(db, "author");
    submitTask(db, t1!.id, "author", { evidence: "done" });

    const out = status();
    for (const id of ["r1", "r2"]) {
      expect(workerLine(out, id)).toContain(`next: ${t1!.id} (queued, role match; any reviewer)`);
    }
  });

  test("a long queue is capped with a +N more marker", () => {
    registerWorker(db, "w", { role: "rust" });
    for (let i = 0; i < 8; i++) addTask(db, { title: `t${i}`, role: "rust" });
    const line = workerLine(status(), "w");
    expect(line).toContain("next: T1,T2,T3,T4,T5,+3 more (runnable, role match — wake me)");
  });

  test("a role no live worker has stays Unclaimable, not 'next'", () => {
    registerWorker(db, "w", { role: "worker" });
    addTask(db, { title: "stranded", role: "dataplane-rust" });
    const out = status();
    expect(workerLine(out, "w")).toContain("next: (none)");
    expect(out).toContain("Unclaimable");
    expect(out).toContain("role=dataplane-rust");
  });
});

// T493: the RUNNING daemon is a long-lived process, so a rebuilt+reinstalled
// CLI does not change what it serves. `relay status` must make a stale daemon
// build visible instead of implying the landed code is live.
describe("relay status: running-daemon build drift (T493)", () => {
  test("a daemon built from a different revision is reported with a restart hint", async () => {
    const dbPath = join(dir, ".relay", "state.db");
    const sockPath = join(dir, ".relay", "relay.sock");
    const ctx: SocketContext = {
      db,
      runtime: new MockRuntime(),
      wakeReconcile: { value: false },
      identity: daemonIdentity(dbPath, sockPath, "mock", "deadbee"),
    };
    const handle = startSocketServer(ctx, sockPath);
    try {
      // ASYNC spawn: the ping server lives in THIS process, and a synchronous
      // spawn would block the event loop so it could never accept the probe.
      const proc = Bun.spawn(["bun", cli, "status"], {
        cwd: dir,
        env: { ...process.env, FORCE_COLOR: "0", RELAY_DB: dbPath },
        stdout: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(out).toContain("daemon");
      expect(out).toContain("build deadbee");
      expect(out).toMatch(/STALE|stale/);
    } finally {
      handle.stop();
    }
  });
});
