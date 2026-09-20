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
//   1. a control-plane lock keyed to the CANONICAL physical DB path (`realpath`),
//      so a symlink alias or a *different* RELAY_SOCK cannot smuggle a second
//      supervisor onto the same state;
//   2. a unix-socket ownership probe: a live listener is never unlinked; only a
//      provably stale socket (file exists, nobody answers) is reclaimed.
//
// Ownership is proven by pid AND a per-acquisition random token, so PID reuse or
// a replacement lock can never be deleted by a late release. A lock is published
// ATOMICALLY: metadata is fully written to a private temp file and hard-linked
// into place, so the lock path is never observable empty/partial from our writer
// (there is no `create`-then-`write` window). A lock file that is nonetheless
// found empty/partial (a foreign/legacy writer) is NEVER reclaimed immediately:
// it is protected for LOCK_INIT_GRACE_MS and only reclaimed once it is old
// enough to be a crashed startup.
//
// Both mechanisms are best-effort for locality only; neither is a distributed
// protocol.

import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { basename, dirname, join, resolve } from "node:path";

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

/** How long a malformed, newly-created lock is treated as "still initializing". */
export const LOCK_INIT_GRACE_MS = 2000;
/** Retry cadence while a fresh malformed lock is protected. */
const LOCK_RETRY_MS = 50;
/** Extra budget beyond the grace before a fresh malformed lock fails the startup. */
const LOCK_BUDGET_MARGIN_MS = 500;

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
 * DB-specific lock path. The lock belongs to the physical SQLite FILE, not to a
 * directory: `/tmp/control/a.db` and `/tmp/control/b.db` are different control
 * planes and must not collide.
 */
export function lockPathFor(canonicalDbPath: string): string {
  return `${canonicalDbPath}.relay.lock`;
}

export interface LockHandle {
  path: string;
  /** Per-acquisition ownership proof; release requires an exact match. */
  token: string;
  release(): void;
}

interface LockMetadata {
  pid: number;
  token: string;
  db_path: string;
  created_at: number;
}

type LockRead = { ok: true; meta: LockMetadata } | { ok: false };

/**
 * Read lock metadata. Anything that is not a complete
 * `{ pid, token, ... }` record (empty, partial JSON, invalid JSON, missing pid,
 * missing token) is reported as unreadable — the caller MUST NOT treat that as
 * proof of staleness on its own.
 */
function readLockMetadata(path: string): LockRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { ok: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false };
  const m = parsed as Record<string, unknown>;
  const pid = Number(m.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false };
  if (typeof m.token !== "string" || m.token.length === 0) return { ok: false };
  return {
    ok: true,
    meta: {
      pid,
      token: m.token,
      db_path: typeof m.db_path === "string" ? m.db_path : "",
      created_at: Number(m.created_at) || 0,
    },
  };
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function reclaim(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone / raced with another starter */
  }
}

/**
 * Release only while the lock is still THIS exact incarnation: pid AND token
 * must match. A same-pid/different-token lock (PID reuse, or a lock replaced by
 * another acquisition) is not ours to remove.
 */
function releaseLock(path: string, token: string): void {
  const read = readLockMetadata(path);
  if (!read.ok) return;
  if (read.meta.pid !== process.pid || read.meta.token !== token) return;
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

export interface AcquireLockOptions {
  /** Canonical physical DB path recorded in the lock + used in error messages. */
  dbPath?: string;
  /** Override the fresh-malformed grace (tests use a short value). */
  initGraceMs?: number;
}

/**
 * Acquire the exclusive control-plane lock for one physical SQLite DB.
 *
 * An atomic hard-link of a fully-written metadata file is the only way to win.
 * A pre-existing lock is:
 *
 *   valid + live pid   -> reject (second supervisor)
 *   valid + dead pid   -> reclaim and retry
 *   malformed + fresh  -> PROTECT (another process may be initializing); retry
 *   malformed + old    -> reclaim and retry (crashed startup)
 *
 * Atomic publish removes the create-before-metadata window for our own writer;
 * the fresh-malformed rule additionally protects against a foreign/legacy
 * partial lock that must never be reclaimed while it may still be initializing.
 */
export async function acquireLock(
  path: string,
  opts: AcquireLockOptions = {}
): Promise<LockHandle> {
  const token = randomUUID();
  const dbPath = opts.dbPath ?? "";
  const graceMs = opts.initGraceMs ?? LOCK_INIT_GRACE_MS;
  const deadline = Date.now() + graceMs + LOCK_BUDGET_MARGIN_MS;

  for (;;) {
    // 1) Atomic exclusive create. Metadata is written to a unique temp file and
    //    hard-linked into place: `link` fails with EEXIST when the lock is held
    //    and exposes only a fully-written record otherwise.
    const meta: LockMetadata = {
      pid: process.pid,
      token,
      db_path: dbPath,
      created_at: Date.now(),
    };
    const tmp = `${path}.${token}.tmp`;
    let created = false;
    try {
      writeFileSync(tmp, JSON.stringify(meta), { flag: "wx" });
      try {
        linkSync(tmp, path);
        created = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
      }
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* already gone */
      }
    }
    if (created) return { path, token, release: () => releaseLock(path, token) };

    // 2) Someone else created the file: classify it.
    const read = readLockMetadata(path);
    if (read.ok) {
      if (pidAlive(read.meta.pid)) {
        throw new Error(
          `relay control plane already has an active supervisor for ${
            dbPath || path
          } (pid ${read.meta.pid}); refusing a second supervisor`
        );
      }
      // Dead holder: a stale lock from a crashed process -> reclaim.
      reclaim(path);
      continue;
    }

    // Malformed/empty/partial (a foreign/legacy writer mid-publish, or a crash
    // artifact): only age can justify a destructive reclaim.
    let ageMs: number;
    try {
      ageMs = Date.now() - statSync(path).mtimeMs;
    } catch {
      ageMs = Number.POSITIVE_INFINITY; // vanished: another starter moved on
    }
    if (ageMs < graceMs) {
      if (Date.now() >= deadline) {
        throw new Error(
          `relay control-plane lock ${path} is being initialized by another process; ` +
            `refusing to reclaim a fresh lock for ${dbPath || path}`
        );
      }
      await sleep(LOCK_RETRY_MS);
      continue;
    }
    // Old corrupt lock from a crashed/incomplete startup: reclaim and retry.
    reclaim(path);
  }
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
