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

/** Read one `ps -o <field>=` value for `pid`; null when `ps` cannot report it. */
function psField(pid: number, field: string): string | null {
  try {
    const p = Bun.spawnSync(["ps", "-o", `${field}=`, "-p", String(pid)], {
      stdout: "pipe",
      stderr: "pipe",
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
 * The process start time of `pid` (`ps -o lstart=`), the identity token stored on
 * the Run row at launch and re-read before any orphan signal. Null when the
 * process is gone or `ps` cannot report it.
 */
export function processStartToken(pid: number | null): string | null {
  if (!pid) return null;
  return psField(pid, "lstart");
}

/** Read the full identity of `pid` in one place. */
export function readProcessIdentity(pid: number): ProcessIdentity {
  return { pid, pgid: processPgid(pid), lstart: processStartToken(pid) };
}
