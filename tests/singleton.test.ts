import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { runDaemon } from "../src/daemon";
import { MockRuntime } from "../src/runtime/runtime";
import { startSocketServer, type SocketContext } from "../src/socket";
import {
  acquireLock,
  assertSocketFree,
  daemonIdentity,
  probeSocket,
} from "../src/singleton";

// Single-supervisor boundary: one control-plane DB == one active relay daemon.
// The guard is (1) a DB-keyed lock and (2) a socket ownership probe that never
// unlinks a live listener and reclaims only a provably stale one.

const REPO = join(import.meta.dir, "..");
const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "relay-singleton-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ctxFor(dbPath: string, sockPath: string): SocketContext {
  return {
    db: openDb(dbPath),
    runtime: new MockRuntime(),
    wakeReconcile: { value: false },
    identity: daemonIdentity(dbPath, sockPath, "mock"),
  };
}

/** Leave a real unix socket file behind with no listener (a crashed daemon). */
async function makeStaleSocket(path: string): Promise<void> {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(path, resolve));
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("socket ownership probe", () => {
  test("absent path is free", async () => {
    const sock = join(tempDir(), "relay.sock");
    expect((await probeSocket(sock)).status).toBe("absent");
    await expect(assertSocketFree(sock, join(tempDir(), "state.db"))).resolves.toBeUndefined();
  });

  test("a non-socket file is never unlinked (fail closed)", async () => {
    const dir = tempDir();
    const sock = join(dir, "relay.sock");
    writeFileSync(sock, "not a socket");

    expect((await probeSocket(sock)).status).toBe("not-socket");
    await expect(assertSocketFree(sock, join(dir, "state.db"))).rejects.toThrow(/not a unix socket/);
    expect(existsSync(sock)).toBe(true);
  });

  test("a live daemon is rejected and its socket is never unlinked", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    const sockPath = join(dir, "relay.sock");
    const ctx = ctxFor(dbPath, sockPath);
    const handle = startSocketServer(ctx, sockPath);
    try {
      const probe = await probeSocket(sockPath);
      expect(probe.status).toBe("live");
      if (probe.status === "live") {
        expect(probe.identity?.db_path).toBe(dbPath);
        expect(probe.identity?.runtime).toBe("mock");
      }

      await expect(assertSocketFree(sockPath, dbPath)).rejects.toThrow(
        /already running|second supervisor/
      );

      // A second starter must NOT have stolen the pathname: still reachable.
      expect((await probeSocket(sockPath)).status).toBe("live");
    } finally {
      handle.stop();
      ctx.db.close();
    }
    // Graceful stop removed the socket we owned.
    expect(existsSync(sockPath)).toBe(false);
  });

  test("a live daemon for a different DB on the same socket is a config error", async () => {
    const dir = tempDir();
    const sockPath = join(dir, "relay.sock");
    const ctx = ctxFor(join(dir, "state.db"), sockPath);
    const handle = startSocketServer(ctx, sockPath);
    try {
      await expect(assertSocketFree(sockPath, join(dir, "other.db"))).rejects.toThrow(
        /different control-plane DB/
      );
    } finally {
      handle.stop();
      ctx.db.close();
    }
  });

  test("a stale socket is reclaimed and rebound", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    const sockPath = join(dir, "relay.sock");
    await makeStaleSocket(sockPath);
    expect(existsSync(sockPath)).toBe(true);
    expect(statSync(sockPath).isSocket()).toBe(true);
    expect((await probeSocket(sockPath)).status).toBe("stale");

    await expect(assertSocketFree(sockPath, dbPath)).resolves.toBeUndefined();

    const ctx = ctxFor(dbPath, sockPath);
    const handle = startSocketServer(ctx, sockPath);
    try {
      expect((await probeSocket(sockPath)).status).toBe("live");
    } finally {
      handle.stop();
      ctx.db.close();
    }
  });
});

describe("control-plane lock", () => {
  test("a live holder rejects a second acquisition", () => {
    const lock = join(tempDir(), "relay.lock");
    const held = acquireLock(lock);
    try {
      expect(() => acquireLock(lock)).toThrow(/active daemon|second supervisor/);
    } finally {
      held.release();
    }
    expect(existsSync(lock)).toBe(false);
  });

  test("a lock left by a dead process is reclaimed", () => {
    const dir = tempDir();
    const lock = join(dir, "relay.lock");
    const dead = Bun.spawnSync({ cmd: ["true"] });
    writeFileSync(lock, JSON.stringify({ pid: dead.pid, at: Date.now() }));

    const held = acquireLock(lock);
    held.release();
    expect(existsSync(lock)).toBe(false);
  });

  test("release never deletes a lock that is no longer ours", () => {
    const dir = tempDir();
    const lock = join(dir, "relay.lock");
    const held = acquireLock(lock);
    // Simulate another process having reclaimed/overwritten the lock.
    writeFileSync(lock, JSON.stringify({ pid: process.pid + 1, at: Date.now() }));
    held.release();
    expect(existsSync(lock)).toBe(true);
  });
});

// --- subprocess-level daemon tests -----------------------------------------

const procs: Bun.Subprocess[] = [];

function spawnDaemon(env: Record<string, string | undefined>, extra: string[] = []): Bun.Subprocess {
  const p = Bun.spawn({
    cmd: ["bun", "src/cli.ts", "daemon", ...extra],
    cwd: REPO,
    env,
    stdout: "ignore",
    stderr: "pipe",
  });
  procs.push(p);
  return p;
}

afterEach(async () => {
  for (const p of procs.splice(0)) {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
    await Promise.race([p.exited, Bun.sleep(2000)]);
  }
});

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await Bun.sleep(50);
  }
  throw new Error("timed out waiting for condition");
}

async function exitWithin(p: Bun.Subprocess, ms = 8000): Promise<number> {
  const code = await Promise.race([p.exited, Bun.sleep(ms).then(() => null)]);
  if (code === null) {
    p.kill();
    throw new Error("daemon did not exit in time");
  }
  return code as number;
}

async function stderrOf(p: Bun.Subprocess): Promise<string> {
  return new Response(p.stderr as ReadableStream).text();
}

function daemonEnv(dbPath: string, sockPath: string): Record<string, string | undefined> {
  return {
    ...process.env,
    RELAY_DB: dbPath,
    RELAY_SOCK: sockPath,
    RELAY_RUNTIME: "mock",
    RELAY_INTERVAL_MS: "100000",
  };
}

describe("daemon single-supervisor enforcement (subprocess)", () => {
  test("A/B: a second daemon is rejected and never unlinks the live socket", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    const sockPath = join(dir, "relay.sock");
    openDb(dbPath).close();
    const env = daemonEnv(dbPath, sockPath);

    spawnDaemon(env);
    await waitFor(async () => (await probeSocket(sockPath, 200)).status === "live");
    expect((await probeSocket(sockPath)).status).toBe("live");

    const second = spawnDaemon(env);
    const code = await exitWithin(second);
    const err = await stderrOf(second);
    expect(code).not.toBe(0);
    expect(err).toMatch(/already running|second supervisor|active daemon/);

    // Daemon A is untouched: its socket is still reachable.
    expect((await probeSocket(sockPath)).status).toBe("live");
  }, 20000);

  test("C: a stale socket is reclaimed by a fresh daemon", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    const sockPath = join(dir, "relay.sock");
    openDb(dbPath).close();

    // A "crashed daemon": a bound listener killed with SIGKILL leaves the file.
    const binder = Bun.spawn({
      cmd: [
        "bun",
        "-e",
        `const s = Bun.listen({ unix: process.env.SOCK_PATH, socket: { data() {}, error() {} } }); await new Promise(() => {});`,
      ],
      cwd: REPO,
      env: { ...process.env, SOCK_PATH: sockPath },
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitFor(async () => existsSync(sockPath) && statSync(sockPath).isSocket());
    binder.kill(9);
    await binder.exited;
    expect(existsSync(sockPath)).toBe(true);
    expect((await probeSocket(sockPath)).status).toBe("stale");

    spawnDaemon(daemonEnv(dbPath, sockPath));
    await waitFor(async () => (await probeSocket(sockPath, 200)).status === "live");
    expect((await probeSocket(sockPath)).status).toBe("live");
  }, 20000);

  test("D: socket bind failure is fatal (no poll-only second supervisor)", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    openDb(dbPath).close();
    // Parent directory does not exist -> bind must fail.
    const env = daemonEnv(dbPath, join(dir, "missing", "relay.sock"));

    const proc = spawnDaemon(env);
    const code = await exitWithin(proc);
    const err = await stderrOf(proc);
    expect(code).not.toBe(0);
    expect(err).not.toMatch(/socket listening/);
  }, 20000);

  test("E: `daemon --once` refuses while a live daemon owns the control plane", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    const sockPath = join(dir, "relay.sock");
    openDb(dbPath).close();
    const env = daemonEnv(dbPath, sockPath);

    spawnDaemon(env);
    await waitFor(async () => (await probeSocket(sockPath, 200)).status === "live");

    const once = spawnDaemon(env, ["--once"]);
    const code = await exitWithin(once);
    const err = await stderrOf(once);
    expect(code).not.toBe(0);
    expect(err).toMatch(/already running|second supervisor|active daemon/);
  }, 20000);

  test("F: MockRuntime + noSocket bypasses the singleton for tests", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    openDb(dbPath).close();

    await runDaemon({ once: true, noSocket: true, runtime: new MockRuntime(), dbPath, intervalMs: 0 });

    expect(existsSync(join(dir, "relay.lock"))).toBe(false);
    expect(existsSync(join(dir, "relay.sock"))).toBe(false);
  }, 20000);
});
