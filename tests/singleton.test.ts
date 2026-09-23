import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { runDaemon } from "../src/daemon";
import { MockRuntime } from "../src/runtime/runtime";
import { startSocketServer, type SocketContext } from "../src/socket";
import {
  acquireSupervisorLock,
  assertSocketFree,
  canonicalizeDbPath,
  daemonIdentity,
  lockDbPathFor,
  probeSocket,
} from "../src/singleton";

// Single-supervisor boundary: one PHYSICAL control-plane SQLite DB == one active
// relay daemon. The guard is (1) a dedicated SQLite lock DB held under a
// long-lived BEGIN IMMEDIATE transaction (the OS releases it on process death,
// so there is no pid/token/mtime/stale-reclaim step) and (2) a socket ownership
// probe that never unlinks a live listener and reclaims only a provably stale
// one.

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

  test("the ping identity echoes the daemon's build commit (T493)", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    const sockPath = join(dir, "relay.sock");
    const ctx = ctxFor(dbPath, sockPath);
    ctx.identity = daemonIdentity(dbPath, sockPath, "mock", "deadbee");
    const handle = startSocketServer(ctx, sockPath);
    try {
      const probe = await probeSocket(sockPath);
      expect(probe.status).toBe("live");
      if (probe.status === "live") expect(probe.identity?.build).toBe("deadbee");
    } finally {
      handle.stop();
      ctx.db.close();
    }
  });

  test("a daemon that predates the build field reports an UNKNOWN build, not a match (T493)", async () => {
    const dir = tempDir();
    const sockPath = join(dir, "relay.sock");
    // A raw responder with the old identity shape: pid + db_path, no build.
    const server = createServer((socket) => {
      socket.on("data", () => {
        socket.write(
          JSON.stringify({ ok: true, pong: true, identity: { pid: 123, db_path: join(dir, "x.db"), runtime: "old", sock_path: sockPath } }) + "\n"
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    try {
      const probe = await probeSocket(sockPath);
      expect(probe.status).toBe("live");
      if (probe.status === "live") expect(probe.identity?.build).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
  test("a physical DB yields a DB-specific supervisor lock DB (not a directory-wide one)", () => {
    const dir = tempDir();
    const a = lockDbPathFor(canonicalizeDbPath(join(dir, "a.db")));
    const b = lockDbPathFor(canonicalizeDbPath(join(dir, "b.db")));
    expect(a).not.toBe(b);
    expect(a.endsWith("a.db.relay-lock.db")).toBe(true);
    expect(b.endsWith("b.db.relay-lock.db")).toBe(true);
  });

  test("symlink aliases share the same supervisor lock DB", () => {
    const realDir = tempDir();
    const aliasDir = tempDir();
    const realDb = join(realDir, "state.db");
    openDb(realDb).close();
    const aliasDb = join(aliasDir, "state.db");
    symlinkSync(realDb, aliasDb);

    expect(canonicalizeDbPath(aliasDb)).toBe(canonicalizeDbPath(realDb));
    expect(lockDbPathFor(canonicalizeDbPath(aliasDb))).toBe(lockDbPathFor(canonicalizeDbPath(realDb)));
  });
});

describe("SQLite supervisor lock", () => {
  test("acquire succeeds and a second holder is rejected", () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    openDb(dbPath).close();
    const canonical = canonicalizeDbPath(dbPath);

    const held = acquireSupervisorLock(canonical);
    try {
      expect(() => acquireSupervisorLock(canonical)).toThrow(
        /active supervisor|second supervisor/
      );
    } finally {
      held.release();
    }
  });

  test("release allows the next supervisor and is idempotent", () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    openDb(dbPath).close();
    const canonical = canonicalizeDbPath(dbPath);

    const a = acquireSupervisorLock(canonical);
    a.release();
    a.release(); // must not crash

    const b = acquireSupervisorLock(canonical);
    b.release();
  });

  test("the lock DB is a reusable container (file persists, ownership is transactional)", () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    openDb(dbPath).close();
    const canonical = canonicalizeDbPath(dbPath);
    const lockDb = lockDbPathFor(canonical);

    const a = acquireSupervisorLock(canonical);
    expect(existsSync(lockDb)).toBe(true);
    a.release();
    // The file is NOT deleted: `file exists != lock held`.
    expect(existsSync(lockDb)).toBe(true);

    const b = acquireSupervisorLock(canonical);
    b.release();
  });

  test("holding the supervisor lock does NOT block writes to the state DB", () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    const state = openDb(dbPath);
    const canonical = canonicalizeDbPath(dbPath);

    const lock = acquireSupervisorLock(canonical);
    try {
      // The main state DB must stay fully writable: the long-lived transaction
      // lives on the dedicated lock DB only.
      state.exec("CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER PRIMARY KEY);");
      state.exec("INSERT INTO lock_probe (id) VALUES (1);");
      const row = state.query("SELECT COUNT(*) AS n FROM lock_probe").get() as { n: number };
      expect(row.n).toBe(1);
    } finally {
      lock.release();
      state.close();
    }
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

  test("F: MockRuntime + bypassSingleton skips the guard for tests", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    openDb(dbPath).close();
    const canonical = canonicalizeDbPath(dbPath);

    await runDaemon({ once: true, bypassSingleton: true, runtime: new MockRuntime(), dbPath, intervalMs: 0 });

    expect(existsSync(lockDbPathFor(canonical))).toBe(false);
    expect(existsSync(join(dir, "relay.sock"))).toBe(false);
  }, 20000);

  test("G: simultaneous acquisitions have exactly one winner", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    openDb(dbPath).close();
    const canonical = canonicalizeDbPath(dbPath);
    const startAt = Date.now() + 1200;

    const env = (): Record<string, string | undefined> => ({
      ...process.env,
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

  test("SIGKILL releases the supervisor lock (no stale cleanup)", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "state.db");
    openDb(dbPath).close();
    const canonical = canonicalizeDbPath(dbPath);
    const readyFile = join(dir, "holding");

    const holder = spawnFixture("lock-hold.ts", {
      ...process.env,
      LOCK_DB: canonical,
      READY_FILE: readyFile,
    });
    await waitFor(async () => existsSync(readyFile));
    // While the child holds it, this process cannot acquire.
    expect(() => acquireSupervisorLock(canonical)).toThrow(/active supervisor|second supervisor/);

    holder.kill(9);
    await holder.exited;

    // The OS/SQLite released the writer lock automatically — no stale cleanup.
    const lock = acquireSupervisorLock(canonical);
    lock.release();
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

    expect(lockDbPathFor(canonicalizeDbPath(dbA))).not.toBe(lockDbPathFor(canonicalizeDbPath(dbB)));

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
