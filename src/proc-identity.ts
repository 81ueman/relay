/**
 * ISH-762: low-level OS process identity, for proving that a recorded Run PID
 * STILL belongs to the dsh process before any orphan signal is sent.
 *
 * A `runs.pid` is only a number: after a crash/reboot the OS may reuse it for an
 * unrelated process. Signalling whatever currently holds that number (let alone
 * its process group) could kill an innocent host process. These helpers read a
 * stable identity token from the OS so the caller can refuse to signal a PID it
 * cannot prove is the Run's own dsh.
 *
 * dsh is spawned `detached` (`setsid`), so the Run's process is a process-GROUP
 * leader: its `pgid` equals its `pid`. That is one identity property; the process
 * START TIME (`ps -o lstart=`) is the second — captured at launch and compared on
 * adoption.
 */

export interface ProcessIdentity {
  pid: number;
  /** Process-group id, or null when it cannot be read (process gone / no ps). */
  pgid: number | null;
  /** The process start time (`ps -o lstart=`), a stable per-boot identity token. */
  lstart: string | null;
}

/**
 * A PINNED environment for `ps`: `LC_ALL=C` fixes the field format/locale and
 * `TZ=UTC` fixes the rendered timezone, so the same process yields the SAME
 * `lstart` string regardless of the caller's `LANG`/`LC_*`/`TZ`. Without this the
 * token is environment-dependent — a factory restarted under a different locale
 * would misread a genuine, still-running dsh as a reused PID.
 */
const PS_ENV: Record<string, string> = (() => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  env.LC_ALL = "C";
  env.LC_TIME = "C";
  env.LANG = "C";
  env.TZ = "UTC";
  return env;
})();

/** Read one `ps -o <field>=` value for `pid`; null when `ps` cannot report it. */
function psField(pid: number, field: string): string | null {
  try {
    const p = Bun.spawnSync(["ps", "-o", `${field}=`, "-p", String(pid)], {
      stdout: "pipe",
      stderr: "pipe",
      env: PS_ENV,
    });
    if (p.exitCode !== 0) return null;
    const s = p.stdout.toString().trim();
    return s.length > 0 ? s : null;
  } catch {
    return null;
  }
}

/** The process-group id of `pid` (number), or null when unreadable. */
export function processPgid(pid: number): number | null {
  const raw = psField(pid, "pgid");
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The process start time of `pid` (`ps -o lstart=`), rendered with the PINNED
 * `ps` environment (see `PS_ENV`). Null when the process is gone or unreadable.
 */
export function processStartToken(pid: number | null): string | null {
  if (!pid) return null;
  return psField(pid, "lstart");
}

/**
 * Version tag for the canonical spawn-identity token. Bumping it (or a token
 * without a tag) makes an OLD row's token non-comparable, so callers must treat
 * it as `undeterminable` (fence held, no signal) rather than `reused`.
 */
export const SPAWN_TOKEN_PREFIX = "lstart-v1:";

/**
 * The canonical, environment-independent spawn-identity token stored on the Run
 * row at launch and re-read before any orphan signal. Null when unreadable.
 */
export function spawnIdentityToken(pid: number | null): string | null {
  const lstart = processStartToken(pid);
  return lstart === null ? null : `${SPAWN_TOKEN_PREFIX}${lstart}`;
}

/** True when a stored token is a canonical (comparable) token this build wrote. */
export function isCanonicalToken(token: string | null | undefined): boolean {
  return typeof token === "string" && token.startsWith(SPAWN_TOKEN_PREFIX);
}

/** Read the full identity of `pid` in one place. */
export function readProcessIdentity(pid: number): ProcessIdentity {
  return { pid, pgid: processPgid(pid), lstart: processStartToken(pid) };
}
