import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
  canonicalizeDbPath,
  daemonIdentity,
  lockPathFor,
  probeSocket,
} from "../src/singleton";

// Single-supervisor boundary: one PHYSICAL control-plane SQLite DB == one active
// relay daemon. The guard is (1) a DB-specific lock keyed to the canonical
// (realpath) DB and released only with the exact (pid, token) and (2) a socket
// ownership probe that never unlinks a live listener and reclaims only a
// provably stale one.

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

function deadPid(): number {
  return Bun.spawnSync({ cmd: ["true"] }).pid;
}

function readLock(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
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
        /already has an active supervisor|second supervisor/
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

describe("canonical DB identity", () => {
  test("a physical DB yields a DB-specific lock path (not a directory-wide one)", () => {
    const dir = tempDir();
    const a = lockPathFor(canonicalizeDbPath(join(dir, "a.db")));
    const b = lockPathFor(canonicalizeDbPath(join(dir, "b.db")));
    expect(a).not.toBe(b);
    expect(a.endsWith("a.db.relay.lock")).toBe(true);
    expect(b.endsWith("b.db.relay.lock")).toBe(true);
  });

  test("symlink aliases converge on one canonical DB and one lock", () => {
    const realDir = tempDir();
    const aliasDir = tempDir();
    const realDb = join(realDir, "state.db");
    openDb(realDb).close();
    const aliasDb = join(aliasDir, "state.db");
    symlinkSync(realDb, aliasDb);

    expect(canonicalizeDbPath(aliasDb)).toBe(canonicalizeDbPath(realDb));
    expect(lockPathFor(canonicalizeDbPath(aliasDb))).toBe(lockPathFor(canonicalizeDbPath(realDb)));
  });
});

describe("control-plane lock", () => {
  test("a live holder rejects a second acquisition", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    openDb(dbPath).close();
    const lock = lockPathFor(canonicalizeDbPath(dbPath));
    const held = await acquireLock(lock, { dbPath: canonicalizeDbPath(dbPath) });
    try {
      await expect(
        acquireLock(lock, { dbPath: canonicalizeDbPath(dbPath) })
      ).rejects.toThrow(/active supervisor|second supervisor/);
    } finally {
      held.release();
    }
    expect(existsSync(lock)).toBe(false);
  });

  test("a valid lock left by a dead process is reclaimed", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    openDb(dbPath).close();
    const canonical = canonicalizeDbPath(dbPath);
    const lock = lockPathFor(canonical);
    writeFileSync(
      lock,
      JSON.stringify({ pid: deadPid(), token: "dead-token", db_path: canonical, created_at: Date.now() })
    );

    const held = await acquireLock(lock, { dbPath: canonical });
    expect(readLock(lock).token).toBe(held.token);
    held.release();
    expect(existsSync(lock)).toBe(false);
  });

  test("release requires the exact ownership token (same pid, different token stays)", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    openDb(dbPath).close();
    const canonical = canonicalizeDbPath(dbPath);
    const lock = lockPathFor(canonical);
    const held = await acquireLock(lock, { dbPath: canonical });

    // A replacement lock with the same PID but a different incarnation.
    writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, token: "someone-else", db_path: canonical, created_at: Date.now() })
    );
    held.release();
    expect(existsSync(lock)).toBe(true);
    expect(readLock(lock).token).toBe("someone-else");
  });

  test("a fresh empty lock is never reclaimed immediately", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    openDb(dbPath).close();
    const canonical = canonicalizeDbPath(dbPath);
    const lock = lockPathFor(canonical);
    writeFileSync(lock, "");

    const pending = acquireLock(lock, { dbPath: canonical, initGraceMs: 250 });
    await Bun.sleep(80);
    // Still protected while fresh: not unlinked.
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(lock, "utf-8")).toBe("");

    const held = await pending; // reclaimed only once it aged past the grace
    expect(readLock(lock).token).toBe(held.token);
    held.release();
  });

  test("a fresh partial-JSON lock is never reclaimed immediately", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    openDb(dbPath).close();
    const canonical = canonicalizeDbPath(dbPath);
    const lock = lockPathFor(canonical);
    writeFileSync(lock, `{"pid":`);

    const pending = acquireLock(lock, { dbPath: canonical, initGraceMs: 250 });
    await Bun.sleep(80);
    expect(readFileSync(lock, "utf-8")).toBe(`{"pid":`);

    const held = await pending;
    expect(readLock(lock).token).toBe(held.token);
    held.release();
  });

  test("an old corrupt lock is reclaimed", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    openDb(dbPath).close();
    const canonical = canonicalizeDbPath(dbPath);
    const lock = lockPathFor(canonical);
    writeFileSync(lock, `{"pid":`);
    const old = new Date(Date.now() - 10_000);
    utimesSync(lock, old, old);

    const held = await acquireLock(lock, { dbPath: canonical });
    expect(readLock(lock).token).toBe(held.token);
    held.release();
    expect(existsSync(lock)).toBe(false);
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

function spawnFixture(file: string, env: Record<string, string | undefined>): Bun.Subprocess {
  const p = Bun.spawn({
    cmd: ["bun", `tests/fixtures/${file}`],
    cwd: REPO,
    env,
    stdout: "pipe",
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

async function streamOf(s: ReadableStream | number | undefined): Promise<string> {
  return new Response(s as ReadableStream).text();
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
    const err = await streamOf(second.stderr);
    expect(code).not.toBe(0);
    expect(err).toMatch(/active supervisor|second supervisor|active daemon/);

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
    const err = await streamOf(proc.stderr);
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
    const err = await streamOf(once.stderr);
    expect(code).not.toBe(0);
    expect(err).toMatch(/active supervisor|second supervisor|active daemon/);
  }, 20000);

  test("F: MockRuntime + noSocket bypasses the singleton for tests", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    openDb(dbPath).close();
    const canonical = canonicalizeDbPath(dbPath);

    await runDaemon({ once: true, noSocket: true, runtime: new MockRuntime(), dbPath, intervalMs: 0 });

    expect(existsSync(lockPathFor(canonical))).toBe(false);
    expect(existsSync(join(dir, "relay.sock"))).toBe(false);
  }, 20000);

  test("G: simultaneous lock acquisitions have exactly one winner", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    openDb(dbPath).close();
    const canonical = canonicalizeDbPath(dbPath);
    const lock = lockPathFor(canonical);
    const startAt = Date.now() + 1200;

    const env = (): Record<string, string | undefined> => ({
      ...process.env,
      LOCK_PATH: lock,
      LOCK_DB: canonical,
      START_AT: String(startAt),
      HOLD_MS: "1000",
    });
    const a = spawnFixture("lock-acquire.ts", env());
    const b = spawnFixture("lock-acquire.ts", env());
    await Promise.all([a.exited, b.exited]);
    const [outA, outB] = await Promise.all([streamOf(a.stdout), streamOf(b.stdout)]);

    const outputs = [outA, outB];
    expect(outputs.filter((o) => o.includes("ACQUIRED")).length).toBe(1);
    expect(outputs.filter((o) => o.includes("REJECTED")).length).toBe(1);
  }, 20000);

  test("H: simultaneous `daemon --once` runs exactly one supervisor pass", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    const sockPath = join(dir, "relay.sock");
    openDb(dbPath).close();
    const startAt = Date.now() + 1200;

    const env = (): Record<string, string | undefined> => ({
      ...daemonEnv(dbPath, sockPath),
      START_AT: String(startAt),
    });
    const a = spawnFixture("daemon-once.ts", env());
    const b = spawnFixture("daemon-once.ts", env());
    const [codeA, codeB] = await Promise.all([a.exited, b.exited]);
    const [errA, errB] = await Promise.all([streamOf(a.stderr), streamOf(b.stderr)]);

    expect([codeA, codeB].filter((c) => c === 0).length).toBe(1);
    // Only one process ever reached the post-acquisition startup line.
    expect((errA + errB).match(/daemon starting/g)?.length ?? 0).toBe(1);
  }, 20000);

  test("I: different DBs in the same directory run concurrently", async () => {
    const dir = tempDir();
    const dbA = join(dir, "a.db");
    const dbB = join(dir, "b.db");
    openDb(dbA).close();
    openDb(dbB).close();
    const sockA = join(dir, "a.sock");
    const sockB = join(dir, "b.sock");

    spawnDaemon(daemonEnv(dbA, sockA));
    spawnDaemon(daemonEnv(dbB, sockB));
    await waitFor(async () => (await probeSocket(sockA, 200)).status === "live");
    await waitFor(async () => (await probeSocket(sockB, 200)).status === "live");

    expect((await probeSocket(sockA)).status).toBe("live");
    expect((await probeSocket(sockB)).status).toBe("live");
  }, 20000);

  test("J: a symlink alias of the same DB is rejected (different socket)", async () => {
    const realDir = tempDir();
    const aliasDir = tempDir();
    const realDb = join(realDir, "state.db");
    openDb(realDb).close();
    const aliasDb = join(aliasDir, "state.db");
    symlinkSync(realDb, aliasDb);
    const realSock = join(realDir, "relay.sock");
    const aliasSock = join(aliasDir, "relay.sock");

    spawnDaemon(daemonEnv(realDb, realSock));
    await waitFor(async () => (await probeSocket(realSock, 200)).status === "live");

    const second = spawnDaemon(daemonEnv(aliasDb, aliasSock));
    const code = await exitWithin(second);
    const err = await streamOf(second.stderr);
    expect(code).not.toBe(0);
    expect(err).toMatch(/active supervisor|second supervisor/);
    expect((await probeSocket(realSock)).status).toBe("live");
  }, 20000);

  test("K: a different RELAY_SOCK cannot bypass the same-DB singleton", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    openDb(dbPath).close();
    const sockA = join(dir, "a.sock");
    const sockB = join(dir, "b.sock");

    spawnDaemon(daemonEnv(dbPath, sockA));
    await waitFor(async () => (await probeSocket(sockA, 200)).status === "live");

    const second = spawnDaemon(daemonEnv(dbPath, sockB));
    const code = await exitWithin(second);
    const err = await streamOf(second.stderr);
    expect(code).not.toBe(0);
    expect(err).toMatch(/active supervisor|second supervisor/);
    expect((await probeSocket(sockA)).status).toBe("live");
  }, 20000);

  test("L: ping reports the canonical physical DB path", async () => {
    const realDir = tempDir();
    const aliasDir = tempDir();
    const realDb = join(realDir, "state.db");
    openDb(realDb).close();
    const aliasDb = join(aliasDir, "state.db");
    symlinkSync(realDb, aliasDb);
    const sock = join(aliasDir, "relay.sock");

    spawnDaemon(daemonEnv(aliasDb, sock));
    await waitFor(async () => (await probeSocket(sock, 200)).status === "live");

    const probe = await probeSocket(sock);
    expect(probe.status).toBe("live");
    if (probe.status === "live") {
      expect(probe.identity?.db_path).toBe(canonicalizeDbPath(realDb));
      expect(probe.identity?.db_path).not.toBe(aliasDb);
    }
  }, 20000);
});
