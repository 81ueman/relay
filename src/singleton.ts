// Single-supervisor enforcement.
//
// Relay's production invariant is:
//
//     one control-plane DB  =  one active relay supervisor daemon
//
// A second daemon reconciling the same SQLite DB would break generation
// allocation and cleanup (each daemon owns a per-worker fencing number and the
// Herdr workspace). Relay does NOT implement distributed locking / leader
// election: the control plane is local, and the boundary is enforced at startup
// with two small, local mechanisms, in priority order:
//
//   1. a control-plane lock, keyed to the DB path (so a *different* RELAY_SOCK
//      cannot smuggle a second supervisor onto the same state);
//   2. a unix-socket ownership probe: a live listener is never unlinked; only a
//      provably stale socket (file exists, nobody answers) is reclaimed.
//
// Both are best-effort for locality only; neither is a distributed protocol.

import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";

/** Daemon identity echoed by the socket `ping` reply (DB/socket ownership proof). */
export interface DaemonIdentity {
  pid: number;
  db_path: string;
  runtime: string;
  sock_path: string;
}

export function daemonIdentity(dbPath: string, sockPath: string, runtime: string): DaemonIdentity {
  return { pid: process.pid, db_path: dbPath, runtime, sock_path: sockPath };
}

/** The control-plane lock lives next to the DB it protects. */
export function defaultLockPath(dbPath: string): string {
  return join(dirname(dbPath), "relay.lock");
}

export interface LockHandle {
  path: string;
  release(): void;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we may not signal it: still alive.
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function readLockPid(path: string): number {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { pid?: unknown };
    return Number(raw?.pid) || 0;
  } catch {
    return 0;
  }
}

function releaseLock(path: string): void {
  try {
    // Only remove the lock if it is still OURS: a stale-holder reclaim by another
    // process must never be deleted by our late shutdown.
    if (readLockPid(path) !== process.pid) return;
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

/**
 * Acquire the exclusive control-plane lock. `wx` (exclusive create) is the
 * atomic primitive: only one process can create the file. A pre-existing lock is
 * either held by a live process (reject) or stale (holder crashed → reclaim).
 */
export function acquireLock(path: string): LockHandle {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      return { path, release: () => releaseLock(path) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
      const pid = readLockPid(path);
      if (pidAlive(pid)) {
        throw new Error(
          `relay control plane already has an active daemon (pid ${pid}); refusing a second supervisor`
        );
      }
      // Stale lock (holder is gone): reclaim it and retry.
      try {
        unlinkSync(path);
      } catch {
        /* raced with another starter */
      }
    }
  }
  throw new Error(`could not acquire relay control-plane lock at ${path}`);
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
 * A live daemon serving a DIFFERENT control-plane DB on the same socket path is a
 * configuration error and is rejected too (the singleton must be DB-identified).
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
    `relay daemon already running for this control plane${
      id ? ` (pid ${id.pid}, db ${id.db_path})` : ""
    }; refusing a second supervisor`
  );
}
