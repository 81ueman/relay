// Single-supervisor enforcement.
//
// Relay's production invariant is:
//
//     one physical control-plane SQLite DB  =  one active relay supervisor
//
// A second daemon reconciling the same physical SQLite file would break
// generation allocation and cleanup (each daemon owns a per-worker fencing
// number and the Herdr workspace). Relay does NOT implement distributed locking
// / leader election: the control plane is local, and the boundary is enforced at
// startup with two small, local mechanisms, in priority order:
//
//   1. the SUPERVISOR LOCK: an OS-backed SQLite writer lock held for the daemon
//      lifetime. For the canonical control-plane DB `<state.db>` we use a
//      dedicated lock DB `<state.db>.relay-lock.db`, open it, and hold
//      `BEGIN IMMEDIATE` until shutdown. This is NOT a lockfile protocol: there
//      is no pid, token, mtime, grace, or stale-reclaim step. SQLite grants the
//      writer lock to exactly one connection, so a second supervisor gets
//      SQLITE_BUSY and is rejected; when the owner exits or is SIGKILLed the OS
//      releases the lock automatically. `file exists != lock held` — the lock DB
//      is just a reusable container. The canonical `state.db` itself is NEVER
//      held under a long-lived transaction (that would block normal CLI/daemon
//      writes).
//   2. a unix-socket ownership probe: a live listener is never unlinked; only a
//      provably stale socket (file exists, nobody answers) is reclaimed.
//
// Ownership is keyed to the CANONICAL physical DB path (`realpath`), so a
// symlink alias or a *different* RELAY_SOCK cannot smuggle a second supervisor
// onto the same state.
//
// Both mechanisms are best-effort for locality only; neither is a distributed
// protocol.

import { Database } from "bun:sqlite";
import { existsSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { basename, dirname, join, resolve } from "node:path";

/** Daemon identity echoed by the socket `ping` reply (DB/socket ownership proof). */
export interface DaemonIdentity {
  pid: number;
  db_path: string;
  runtime: string;
  sock_path: string;
  /**
   * The source commit the RUNNING daemon was built from, or null.
   *
   * A daemon is a long-lived in-memory process: rebuilding + reinstalling the
   * CLI does NOT change it. Echoing the build lets a client detect that the
   * live supervisor is serving a stale revision (code landed, daemon not
   * restarted) instead of silently assuming the new build is active.
   */
  build: string | null;
}

export function daemonIdentity(
  dbPath: string,
  sockPath: string,
  runtime: string,
  build: string | null = null
): DaemonIdentity {
  return { pid: process.pid, db_path: dbPath, runtime, sock_path: sockPath, build };
}

/**
 * Resolve the physical identity of the control-plane SQLite file.
 *
 * Two spellings of the same file (symlink aliases, `/var` vs `/private/var`,
 * copied-but-linked dirs) must converge on ONE supervisor, so ownership is keyed
 * to the realpath, never the requested path. The daemon checks DB existence
 * first, so `realpathSync` succeeds in production; the fallback keeps lock-path
 * derivation usable for a not-yet-created file.
 */
export function canonicalizeDbPath(dbPath: string): string {
  try {
    return realpathSync(dbPath);
  } catch {
    try {
      // Canonicalize the containing directory so directory aliases converge too.
      return join(realpathSync(dirname(dbPath)), basename(dbPath));
    } catch {
      return resolve(dbPath);
    }
  }
}

/**
 * Dedicated singleton lock DB for one canonical control-plane DB. The lock
 * belongs to the physical SQLite FILE, not to a directory: `/tmp/control/a.db`
 * and `/tmp/control/b.db` are different control planes and must not collide.
 */
export function lockDbPathFor(canonicalDbPath: string): string {
  return `${canonicalDbPath}.relay-lock.db`;
}

export interface SupervisorLock {
  /** Canonical control-plane DB this lock protects. */
  dbPath: string;
  /** Dedicated lock DB holding the long-lived writer transaction. */
  lockDbPath: string;
  /** Roll back the writer transaction and close the lock DB. Idempotent. */
  release(): void;
}

/** True only for writer-lock contention: SQLITE_BUSY / SQLITE_LOCKED and friends. */
function isLockContention(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string") {
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
    if (code.startsWith("SQLITE_BUSY_") || code.startsWith("SQLITE_LOCKED_")) return true;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(msg);
}

/**
 * Acquire the exclusive supervisor lock for one canonical control-plane DB.
 *
 * The lock is a long-lived `BEGIN IMMEDIATE` transaction on the dedicated lock
 * DB. The transaction is intentionally never committed until shutdown; the open
 * connection + writer lock IS the lease. Contention (SQLITE_BUSY / SQLITE_LOCKED)
 * means another supervisor owns the control plane and is reported as such. Any
 * other failure (permissions, read-only dir, I/O, corruption) fails closed and is
 * NOT mislabelled as contention.
 */
export function acquireSupervisorLock(canonicalDbPath: string): SupervisorLock {
  const lockDbPath = lockDbPathFor(canonicalDbPath);
  let db: Database;
  try {
    db = new Database(lockDbPath, { create: true });
  } catch (e) {
    throw new Error(`relay could not open the supervisor lock DB at ${lockDbPath}: ${String(e)}`);
  }
  try {
    db.exec("PRAGMA busy_timeout = 0;");
    db.exec("BEGIN IMMEDIATE;");
  } catch (e) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    if (isLockContention(e)) {
      throw new Error(
        `relay control plane already has an active supervisor for ${canonicalDbPath}; refusing a second supervisor`
      );
    }
    throw new Error(`relay could not acquire the supervisor lock at ${lockDbPath}: ${String(e)}`);
  }
  let released = false;
  return {
    dbPath: canonicalDbPath,
    lockDbPath,
    release(): void {
      if (released) return;
      released = true;
      try {
        db.exec("ROLLBACK;");
      } catch {
        /* ignore */
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/** Best-effort: does the daemon at this socket path still answer? */
export type SocketProbe =
  | { status: "absent" }
  | { status: "not-socket" }
  | { status: "stale" }
  | { status: "live"; identity: DaemonIdentity | null };

function parseIdentity(buf: string): DaemonIdentity | null {
  const idx = buf.indexOf("\n");
  if (idx < 0) return null;
  try {
    const msg = JSON.parse(buf.slice(0, idx)) as { identity?: Partial<DaemonIdentity> };
    const id = msg?.identity;
    if (id && typeof id.pid === "number" && typeof id.db_path === "string") {
      return {
        pid: id.pid,
        db_path: id.db_path,
        runtime: String(id.runtime ?? ""),
        sock_path: String(id.sock_path ?? ""),
        // Older daemons predate the field: an absent build is unknown, not
        // implicitly equal to the client's.
        build: typeof id.build === "string" && id.build ? id.build : null,
      };
    }
  } catch {
    /* not our protocol */
  }
  return null;
}

function pingSocket(
  path: string,
  timeoutMs: number
): Promise<{ responded: boolean; identity: DaemonIdentity | null }> {
  return new Promise((resolve) => {
    let done = false;
    let buf = "";
    const sock = connect({ path });
    const finish = (responded: boolean) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve({ responded, identity: parseIdentity(buf) });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.on("connect", () => {
      try {
        sock.write(JSON.stringify({ type: "ping" }) + "\n");
      } catch {
        finish(false);
      }
    });
    sock.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) {
        clearTimeout(timer);
        finish(true);
      }
    });
    sock.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    sock.on("close", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

export async function probeSocket(path: string, timeoutMs = 800): Promise<SocketProbe> {
  if (!existsSync(path)) return { status: "absent" };
  let isSock = false;
  try {
    isSock = statSync(path).isSocket();
  } catch {
    return { status: "absent" };
  }
  if (!isSock) return { status: "not-socket" };
  const { responded, identity } = await pingSocket(path, timeoutMs);
  return responded ? { status: "live", identity } : { status: "stale" };
}

/**
 * Ensure `sockPath` is free for THIS daemon to bind.
 *
 *   absent     -> ok
 *   not-socket -> fail closed (never delete a user file that merely shares the path)
 *   stale      -> reclaim (unlink) and continue
 *   live       -> fail closed; never unlink a live daemon's socket
 *
 * A live daemon serving a DIFFERENT canonical control-plane DB on the same socket
 * path is a configuration error and is rejected too (the singleton is DB-identity
 * based, not socket based).
 */
export async function assertSocketFree(sockPath: string, dbPath: string): Promise<void> {
  const probe = await probeSocket(sockPath);
  if (probe.status === "absent") return;
  if (probe.status === "not-socket") {
    throw new Error(
      `relay socket path ${sockPath} exists and is not a unix socket; refusing to remove it`
    );
  }
  if (probe.status === "stale") {
    // The file may have vanished between the probe and here; ignore that race.
    try {
      unlinkSync(sockPath);
    } catch {
      /* already gone */
    }
    return;
  }
  const id = probe.identity;
  if (id && id.db_path && id.db_path !== dbPath) {
    throw new Error(
      `relay socket ${sockPath} is owned by a daemon for a different control-plane DB (${id.db_path}); refusing`
    );
  }
  throw new Error(
    `relay control plane already has an active supervisor for ${dbPath}${
      id ? ` (pid ${id.pid})` : ""
    }; refusing a second supervisor`
  );
}
