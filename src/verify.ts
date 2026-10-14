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

/** Runs ONE check. Read-only w.r.t. the repo: it only observes the exit code. */
export interface CommandRunner {
  run(spec: CheckSpec, opts: { cwd: string }): Promise<ExecutedCheck>;
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

/** Spawn one command and map its exit result to an `ExecutedCheck`. */
export const defaultRunner: CommandRunner = {
  async run(spec, { cwd }) {
    const timeoutMs = spec.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    const started = Date.now();
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(["bash", "-lc", spec.command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (e) {
      return {
        name: spec.name,
        required: spec.required !== false,
        outcome: "not_run",
        exitCode: null,
        output: `spawn failed: ${String(e)}`.slice(-OUTPUT_TAIL),
        durationMs: Date.now() - started,
      };
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch { /* already gone */ }
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    try {
      [stdout, stderr] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
      ]);
      await proc.exited;
    } catch (e) {
      stderr += `\n${String(e)}`;
    } finally {
      clearTimeout(timer);
    }
    const tail = `${stdout}\n${stderr}`.trim().slice(-OUTPUT_TAIL);
    const required = spec.required !== false;
    const outcome: CheckOutcome = timedOut ? "not_run" : proc.exitCode === 0 ? "pass" : "fail";
    return {
      name: spec.name,
      required,
      outcome,
      exitCode: proc.exitCode ?? null,
      output: timedOut ? `timed out after ${timeoutMs}ms\n${tail}` : tail,
      durationMs: Date.now() - started,
    };
  },
};

/** Run every check with an injected runner and return the per-check + aggregate. */
export async function runChecks(
  checks: CheckSpec[],
  runner: CommandRunner,
  cwd: string
): Promise<{ outcome: CheckOutcome; checks: ExecutedCheck[] }> {
  const executed: ExecutedCheck[] = [];
  for (const spec of checks) {
    const r = await runner.run(spec, { cwd }).catch(
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
