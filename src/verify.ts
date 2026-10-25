/**
 * ISH-759 mechanical verification.
 *
 * Verification is NOT an LLM turn: Relay runs the SPECIFIED standard commands and
 * reads the process exit result. This module owns the (small) process-execution
 * boundary so the workflow can be driven with an injected READ-ONLY runner in
 * tests — no real subprocess, no network — while production uses the real one.
 *
 * Outcomes are deliberately four-valued:
 *   pass         — the command exited 0
 *   fail         — the command exited non-zero (real breakage)
 *   not_run      — a REQUIRED command could not be executed at all
 *   inconclusive — a command ran but its result cannot be trusted
 *
 * `not_run`/`inconclusive` for a required check BLOCKS; it never becomes PASS, so
 * a required test that did not run can never satisfy the gate.
 */

export type CheckOutcome = "pass" | "fail" | "not_run" | "inconclusive";

export interface CheckSpec {
  /** Human label (e.g. "typecheck"). */
  name: string;
  /** The standard command line, run through the shell. */
  command: string;
  /** A required check that does not PASS blocks the task (default true). */
  required?: boolean;
  /** Hard budget; a command past it is `not_run` (default 600000ms). */
  timeoutMs?: number;
}

export interface ExecutedCheck {
  name: string;
  required: boolean;
  outcome: CheckOutcome;
  exitCode: number | null;
  /** Tail of stdout+stderr (bounded), for evidence. */
  output: string;
  durationMs: number;
}

/** Options for one check. `env` is merged over the inherited environment. */
export interface CommandRunOptions {
  cwd: string;
  /**
   * ISH-1225: Relay-owned environment for the command. VERIFY passes the Task's
   * shared `CARGO_TARGET_DIR` here so it reuses the worker's build cache instead
   * of falling back to an inherited host value.
   */
  env?: Record<string, string>;
}

/** Runs ONE check. Read-only w.r.t. the repo: it only observes the exit code. */
export interface CommandRunner {
  run(spec: CheckSpec, opts: CommandRunOptions): Promise<ExecutedCheck>;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 600000;
const OUTPUT_TAIL = 4000;

/** Parse/validate the JSON stored on `tasks.checks_json`. */
export function parseChecks(json: string | null | undefined): CheckSpec[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: CheckSpec[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.name !== "string" || typeof o.command !== "string") continue;
    out.push({
      name: o.name,
      command: o.command,
      required: o.required === undefined ? true : o.required === true,
      timeoutMs: typeof o.timeoutMs === "number" && o.timeoutMs > 0 ? o.timeoutMs : undefined,
    });
  }
  return out;
}

export function serializeChecks(checks: CheckSpec[]): string {
  return JSON.stringify(
    checks.map((c) => ({ name: c.name, command: c.command, required: c.required !== false, timeoutMs: c.timeoutMs }))
  );
}

/**
 * Aggregate per-check outcomes into the task-level verdict. A FAIL always fails
 * (never masked by a not_run); a required not_run/inconclusive blocks; an
 * optional not_run/inconclusive does not. PASS requires every required check to
 * have PASSed.
 */
export function aggregateOutcome(checks: ExecutedCheck[]): CheckOutcome {
  if (checks.some((c) => c.outcome === "fail")) return "fail";
  if (checks.some((c) => c.required && c.outcome === "not_run")) return "not_run";
  if (checks.some((c) => c.required && c.outcome === "inconclusive")) return "inconclusive";
  // An optional check that failed is still a real failure.
  if (checks.some((c) => c.outcome !== "pass" && !c.required && c.outcome === "fail")) return "fail";
  return "pass";
}

/** True when the aggregate outcome satisfies the code-change gate. */
export function isPassingOutcome(outcome: CheckOutcome): boolean {
  return outcome === "pass";
}

/** True when the aggregate outcome must BLOCK (never PASS). */
export function isBlockingOutcome(outcome: CheckOutcome): boolean {
  return outcome === "not_run" || outcome === "inconclusive";
}

/**
 * The head of the checkout at `cwd` (`git rev-parse HEAD`), or null when it is
 * not a readable git checkout. Used to bind mechanical verify to the revision it
 * actually runs against.
 */
export function gitHead(cwd: string): string | null {
  try {
    const p = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) return null;
    const sha = p.stdout.toString().trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/** A synthetic ExecutedCheck representing a check that could not run. */
function notRunCheck(name: string, output: string): ExecutedCheck {
  return { name, required: true, outcome: "not_run", exitCode: null, output, durationMs: 0 };
}

/**
 * The real runner. Spawns the command in a NEW PROCESS GROUP (`detached`) so a
 * timeout can kill the whole tree (a grandchild holding the pipe open cannot
 * keep verify — and the daemon's reconcile pass — alive), and STOPS awaiting the
 * output pipes once the timeout fires.
 */
export const defaultRunner: CommandRunner = {
  async run(spec, { cwd, env }) {
    const timeoutMs = spec.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    const started = Date.now();
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(["bash", "-lc", spec.command], {
        cwd,
        // ISH-1225: an explicit Relay env overrides a host default. When no env
        // is supplied Bun inherits process.env, preserving the old behaviour.
        ...(env ? { env: { ...process.env, ...env } } : {}),
        stdout: "pipe",
        stderr: "pipe",
        // New session/process group: the shell and its descendants share a pgid
        // we can kill as a unit.
        detached: true,
      });
    } catch (e) {
      const r = notRunCheck(spec.name, `spawn failed: ${String(e)}`);
      r.required = spec.required !== false;
      return r;
    }
    const collector = (async (): Promise<{ stdout: string; stderr: string; code: number | null }> => {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
      ]);
      const code = await proc.exited;
      return { stdout, stderr, code };
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const winner = await Promise.race([collector, timeout]);
    if (timer) clearTimeout(timer);

    const required = spec.required !== false;
    if (winner === "timeout") {
      // Kill the GROUP (negative pid); fall back to the leader if the group is gone.
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      }
      // Do NOT await the pipes: a stuck read must not block the daemon.
      void collector.catch(() => {});
      return {
        name: spec.name,
        required,
        outcome: "not_run",
        exitCode: null,
        output: `timed out after ${timeoutMs}ms (process group killed)`,
        durationMs: Date.now() - started,
      };
    }

    const { stdout, stderr, code } = winner;
    const tail = `${stdout}\n${stderr}`.trim().slice(-OUTPUT_TAIL);
    return {
      name: spec.name,
      required,
      outcome: code === 0 ? "pass" : "fail",
      exitCode: code ?? null,
      output: tail,
      durationMs: Date.now() - started,
    };
  },
};

/** Run every check with an injected runner and return the per-check + aggregate. */
export async function runChecks(
  checks: CheckSpec[],
  runner: CommandRunner,
  cwd: string,
  opts: { env?: Record<string, string> } = {}
): Promise<{ outcome: CheckOutcome; checks: ExecutedCheck[] }> {
  const executed: ExecutedCheck[] = [];
  for (const spec of checks) {
    const runOpts: CommandRunOptions = { cwd, ...(opts.env ? { env: opts.env } : {}) };
    const r = await runner.run(spec, runOpts).catch(
      (e): ExecutedCheck => ({
        name: spec.name,
        required: spec.required !== false,
        outcome: "not_run",
        exitCode: null,
        output: `runner threw: ${String(e)}`.slice(-OUTPUT_TAIL),
        durationMs: 0,
      })
    );
    executed.push(r);
  }
  return { outcome: aggregateOutcome(executed), checks: executed };
}
