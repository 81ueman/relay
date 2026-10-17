import type { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { childEnv } from "./child-env";
import { getSandbox, realSbxCli, sbxExecArgv } from "./sandbox";
import type { Task } from "./schema";
import type { CheckOutcome, CheckSpec, CommandRunner, ExecutedCheck } from "./verify";
import { DEFAULT_CHECK_TIMEOUT_MS } from "./verify";
import type { Labctl, LabctlResult, LabctlRunOptions } from "./lab";

/**
 * ISH-829 — the Coding Sandbox VERIFY execution boundary.
 *
 * `defaultRunner` (`src/verify.ts`) runs a check with host `bash -lc`. A
 * Task-Sandbox task must NOT do that: the generated code and the test scripts
 * run INSIDE the Task's durable Docker Sandboxes clone, at the EXACT HEAD Relay
 * bound the task to. This module is that boundary. It composes the existing
 * pieces — `src/verify.ts`'s `CommandRunner` contract and outcome aggregation,
 * `src/sandbox.ts`'s `sbx exec` argv/HEAD probe, and ISH-828's durable
 * Task->Sandbox mapping — and adds nothing else. There is no new FSM.
 *
 * Fail-closed rules (a required check that did not really run never PASSes):
 *   - the clone's HEAD is read BEFORE the command and re-read AFTER it; a HEAD
 *     that is unreadable or not the bound head is `not_run`/`inconclusive`;
 *   - a `sbx exec` transport error, a timeout, or output we cannot trust is
 *     `not_run` (never a pass);
 *   - every check's stdout/stderr/exit/timeout/HEAD/sandbox and the required
 *     check count are handed to the evidence sink.
 *
 * `labctl` runs through the SAME sandbox boundary (`sandboxLabctl`), so borrowing
 * a Shared Lab NOS is an in-sandbox TCP connection, not a host escape.
 */

const STREAM_TAIL = 4000;

// ---------------------------------------------------------------------------
// The `sbx exec` async seam (injectable so tests drive a fake, no Docker)
// ---------------------------------------------------------------------------

export interface SandboxExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The command hit its hard timeout (the process group was killed). */
  timedOut: boolean;
  /** A spawn/transport error: the command never ran to a decision. */
  error?: string;
}

export interface SandboxExecOptions {
  /** In-VM working directory (`sbx exec -w`). */
  workdir?: string;
  /** Explicit `sbx exec -e` env (never the whole host env). */
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** Run one `sbx exec <name> <argv...>` to a decision. */
export interface SandboxExec {
  exec(name: string, argv: string[], opts?: SandboxExecOptions): Promise<SandboxExecResult>;
}

/**
 * The real boundary: `sbx exec …` as a host subprocess (no shell), in a NEW
 * process group so a timeout kills the whole tree. The `sbx` client gets the
 * small child allowlist, not all of `process.env`.
 */
export const realSandboxExec: SandboxExec = {
  async exec(name, argv, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(["sbx", ...sbxExecArgv(name, argv, { workdir: opts.workdir, env: opts.env })], {
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
        env: childEnv(),
      });
    } catch (e) {
      return { code: null, stdout: "", stderr: "", timedOut: false, error: `sbx exec spawn failed: ${String(e)}` };
    }
    const collector = (async () => {
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
    if (winner === "timeout") {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      void collector.catch(() => {});
      return { code: null, stdout: "", stderr: `timed out after ${timeoutMs}ms (sbx exec group killed)`, timedOut: true };
    }
    return { code: winner.code, stdout: winner.stdout, stderr: winner.stderr, timedOut: false };
  },
};

// ---------------------------------------------------------------------------
// Sandbox HEAD (the fence)
// ---------------------------------------------------------------------------

/**
 * The clone's HEAD read THROUGH the injected exec seam: `git -C <workspace>
 * rev-parse HEAD` inside the sandbox. `null` on any transport error or if the
 * output is not a SHA — an unreadable HEAD is never treated as a match.
 */
export async function sandboxExecHead(
  exec: SandboxExec,
  sandbox: string,
  workspace: string,
  timeoutMs = 30_000
): Promise<string | null> {
  const r = await exec.exec(sandbox, ["git", "-C", workspace, "rev-parse", "HEAD"], { workdir: workspace, timeoutMs });
  if (r.error || r.timedOut || r.code !== 0) return null;
  const sha = r.stdout.trim().split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

/**
 * The synchronous HEAD probe Relay's pre-run head-binding check uses. It is the
 * SAME `sbx exec … git rev-parse HEAD` boundary via `realSbxCli` (which is
 * synchronous); an unreadable/mismatched clone returns null and BLOCKS.
 */
export function sandboxHeadProbeSync(sandbox: string, workspace: string): string | null {
  const r = realSbxCli.run(sbxExecArgv(sandbox, ["git", "rev-parse", "HEAD"], { workdir: workspace }));
  if (!r.ok) return null;
  const sha = r.out.trim().split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

/**
 * The clone's working-tree cleanliness, read THROUGH the exec seam:
 * `git -C <workspace> status --porcelain --untracked-files=all`. `clean` = empty
 * output; `dirty` = any modified/untracked (non-ignored) path; `unknown` = the
 * probe itself failed (a transport error is never treated as clean).
 *
 * The HEAD fence alone is not enough: a writer's uncommitted edit, or a check
 * that rewrites the source, would still be judged as the bound HEAD. A non-clean
 * tree therefore never yields a PASS.
 */
export type SandboxTreeState = "clean" | "dirty" | "unknown";

export async function sandboxTreeState(
  exec: SandboxExec,
  sandbox: string,
  workspace: string,
  timeoutMs = 30_000
): Promise<SandboxTreeState> {
  const r = await exec.exec(sandbox, ["git", "-C", workspace, "status", "--porcelain", "--untracked-files=all"], {
    workdir: workspace,
    timeoutMs,
  });
  if (r.error || r.timedOut || r.code !== 0) return "unknown";
  return r.stdout.trim().length === 0 ? "clean" : "dirty";
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export interface SandboxCheckEvidence {
  sandbox: string;
  workspace: string;
  /** The HEAD the check was bound to (Relay's recorded head). */
  boundHead: string;
  /** The HEAD observed just before the command (null = unreadable). */
  headBefore: string | null;
  /** The HEAD observed just after the command (null = unreadable). */
  headAfter: string | null;
  name: string;
  command: string;
  required: boolean;
  outcome: CheckOutcome;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** 1-based position of this check among the Task's checks. */
  index: number;
  /** How many checks are required for the Task. */
  requiredCount: number;
}

export type EvidenceSink = (e: SandboxCheckEvidence) => void;

/**
 * A JSONL evidence sink: each check is appended as one line so a partial run is
 * still readable. Best-effort (evidence writing never turns a FAIL into a PASS).
 */
export function jsonlEvidenceSink(path: string): EvidenceSink {
  return (e) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(e)}\n`);
    } catch {
      /* best effort */
    }
  };
}

// ---------------------------------------------------------------------------
// The sandbox-bound CommandRunner
// ---------------------------------------------------------------------------

export interface SandboxVerifyBinding {
  /** The Coding Sandbox name (`sbx exec <name>`). */
  sandbox: string;
  /** The in-VM clone path. */
  workspace: string;
  /** The exact HEAD this verification is bound to. */
  head: string;
  exec: SandboxExec;
}

function tail(s: string): string {
  return s.length > STREAM_TAIL ? s.slice(-STREAM_TAIL) : s;
}

/**
 * A `CommandRunner` that runs each check INSIDE the sandbox at the bound HEAD.
 *
 * Every check is fenced on BOTH the HEAD and the working tree, before and after:
 *   - unreadable/different HEAD before      -> `not_run` (the command never runs);
 *   - a dirty/unknown tree before           -> `not_run`;
 *   - a non-zero exit                       -> `fail`;
 *   - a HEAD that moved while it ran        -> `inconclusive`;
 *   - a tree the check made dirty/unknowable -> `inconclusive`.
 * A PASS is therefore only credited to a clean checkout at the exact bound HEAD.
 */
export function sandboxCommandRunner(binding: SandboxVerifyBinding): CommandRunner {
  return {
    async run(spec: CheckSpec, _opts: { cwd: string }): Promise<ExecutedCheck> {
      const required = spec.required !== false;
      const timeoutMs = spec.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
      const started = Date.now();
      void _opts;

      const before = await sandboxExecHead(binding.exec, binding.sandbox, binding.workspace);
      const treeBefore = before === null ? "unknown" : await sandboxTreeState(binding.exec, binding.sandbox, binding.workspace);

      const finish = (r: {
        outcome: CheckOutcome;
        exitCode: number | null;
        stdout: string;
        stderr: string;
        timedOut: boolean;
        headAfter?: string | null;
      }): ExecutedCheck => {
        const stdout = tail(r.stdout);
        const stderr = tail(r.stderr);
        return {
          name: spec.name,
          required,
          outcome: r.outcome,
          exitCode: r.exitCode,
          output: `${stdout}\n${stderr}`.trim().slice(-STREAM_TAIL),
          durationMs: Date.now() - started,
          sandbox: binding.sandbox,
          head: binding.head,
          timedOut: r.timedOut,
          headBefore: before,
          headAfter: r.headAfter ?? null,
          stdout,
          stderr,
        };
      };

      // FENCE 1 (pre): the clone must be at the bound head AND clean.
      if (before === null) {
        return finish({ outcome: "not_run", exitCode: null, stdout: "", stderr: `could not read the sandbox HEAD in ${binding.workspace}`, timedOut: false });
      }
      if (before !== binding.head) {
        return finish({
          outcome: "not_run",
          exitCode: null,
          stdout: "",
          stderr: `sandbox HEAD ${before} != bound head ${binding.head}`,
          timedOut: false,
        });
      }
      if (treeBefore !== "clean") {
        return finish({
          outcome: "not_run",
          exitCode: null,
          stdout: "",
          stderr: `sandbox working tree is ${treeBefore} before the check (a dirty checkout is never verified)`,
          timedOut: false,
        });
      }

      const res = await binding.exec.exec(binding.sandbox, ["bash", "-lc", spec.command], {
        workdir: binding.workspace,
        timeoutMs,
      });

      // FENCE 2 (post): re-read the HEAD and the tree so a command that moved the
      // HEAD or dirtied the checkout (or a concurrent writer) cannot yield a PASS.
      const after = await sandboxExecHead(binding.exec, binding.sandbox, binding.workspace);
      const treeAfter = after === null ? "unknown" : await sandboxTreeState(binding.exec, binding.sandbox, binding.workspace);

      let outcome: CheckOutcome;
      if (res.error || res.timedOut) outcome = "not_run";
      else if (res.code !== 0) outcome = "fail";
      else if (after === null || after !== binding.head) outcome = "inconclusive";
      else if (treeAfter !== "clean") outcome = "inconclusive";
      else outcome = "pass";

      return finish({
        outcome,
        exitCode: res.code,
        stdout: res.stdout,
        stderr: res.error ? `${res.stderr}\n${res.error}` : res.stderr,
        timedOut: res.timedOut,
        headAfter: after,
      });
    },
  };
}

/**
 * A `CommandRunner` that records evidence and tracks the required-check count.
 * It wraps `sandboxCommandRunner` so the evidence carries the check index and
 * the Task's required check count (spec: "required check count を Evidence へ").
 */
export function evidenceSandboxRunner(
  binding: SandboxVerifyBinding,
  checks: CheckSpec[],
  onEvidence?: EvidenceSink
): CommandRunner {
  const inner = sandboxCommandRunner(binding);
  const requiredCount = checks.filter((c) => c.required !== false).length;
  let index = 0;
  return {
    async run(spec, opts): Promise<ExecutedCheck> {
      index += 1;
      const executed = await inner.run(spec, opts);
      if (onEvidence) {
        onEvidence({
          sandbox: binding.sandbox,
          workspace: binding.workspace,
          boundHead: binding.head,
          headBefore: executed.headBefore ?? null,
          headAfter: executed.headAfter ?? null,
          name: spec.name,
          command: spec.command,
          required: spec.required !== false,
          outcome: executed.outcome,
          exitCode: executed.exitCode,
          timedOut: executed.timedOut === true,
          durationMs: executed.durationMs,
          stdout: executed.stdout ?? "",
          stderr: executed.stderr ?? "",
          index,
          requiredCount,
        });
      }
      return executed;
    },
  };
}

// ---------------------------------------------------------------------------
// labctl inside the sandbox (borrow Shared Lab NOS without a host escape)
// ---------------------------------------------------------------------------

/**
 * A `Labctl` that runs `labctl` INSIDE the Coding Sandbox (`sbx exec … labctl`).
 * The sandbox→Lab connection is then an ordinary sandbox-policy TCP management
 * connection, never a host `bash -lc`.
 *
 * `env` is forwarded explicitly as `sbx exec -e K=V` (the sandbox never inherits
 * the host environment). Lab credentials (`LABCTL_TOKEN`, or `LABCTL_USER` +
 * `LABCTL_PASSWORD`) belong here — they are NOT read from the host implicitly and
 * are never logged. Prefer `LABCTL_TOKEN`, since a value on argv is visible in
 * the host process table.
 */
export function sandboxLabctl(
  binding: Pick<SandboxVerifyBinding, "sandbox" | "workspace" | "exec">,
  env: Record<string, string> = {}
): Labctl {
  return {
    async run(args: string[], opts: LabctlRunOptions = {}): Promise<LabctlResult> {
      const r = await binding.exec.exec(binding.sandbox, ["labctl", ...args], {
        workdir: binding.workspace,
        timeoutMs: opts.timeoutMs,
        env,
      });
      return {
        ok: r.code === 0 && !r.error && !r.timedOut,
        code: r.code,
        out: r.stdout,
        err: r.error ? `${r.stderr}\n${r.error}`.trim() : r.stderr,
        timedOut: r.timedOut,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The workflow-driver VERIFY target
// ---------------------------------------------------------------------------

/** What a mechanical verification runs, and where. */
export interface VerifyTarget {
  runner: CommandRunner;
  /** The working directory recorded on the run (in-VM clone path for a sandbox). */
  cwd: string;
  /** The exact head the run is judged against. */
  headSha?: string;
  /** The synchronous pre-run HEAD probe (defaults to host `git rev-parse HEAD`). */
  headProbe?: (cwd: string) => string | null;
  /** The Coding Sandbox name, for evidence/labels. */
  sandbox?: string;
}

/** A `CommandRunner` that refuses every check with a fail-closed reason. */
export function notRunRunner(reason: string, sandbox?: string): CommandRunner {
  return {
    async run(spec): Promise<ExecutedCheck> {
      return {
        name: spec.name,
        required: spec.required !== false,
        outcome: "not_run",
        exitCode: null,
        output: reason,
        durationMs: 0,
        sandbox,
        head: null,
        timedOut: false,
        stdout: "",
        stderr: reason,
      };
    },
  };
}

/**
 * A Task's durable Coding Sandbox suitability for VERIFY:
 *   - no sandbox row at all      -> `null`  (the host runner is the fallback);
 *   - a row that cannot be used  -> `{ ok:false, reason }` (fail closed: the
 *     caller must NOT fall back to host `bash -lc` on generated code);
 *   - a usable row               -> `{ ok:true, sandbox, workspace }`.
 */
export type SandboxForVerify =
  | { ok: true; sandbox: NonNullable<ReturnType<typeof getSandbox>>; workspace: string }
  | { ok: false; reason: string };

export function sandboxForVerify(db: Database, task: Task): SandboxForVerify | null {
  const sandbox = getSandbox(db, task.id);
  if (!sandbox) return null;
  if (sandbox.state === "removed") {
    return { ok: false, reason: `task ${task.id} Coding Sandbox ${sandbox.name} was removed; refusing to fall back to host bash -lc` };
  }
  if (sandbox.state === "failed") {
    return { ok: false, reason: `task ${task.id} Coding Sandbox ${sandbox.name} is failed; refusing to fall back to host bash -lc` };
  }
  const workspace = sandbox.workspace ?? task.worktree ?? null;
  if (!workspace) {
    return { ok: false, reason: `task ${task.id} Coding Sandbox ${sandbox.name} has no workspace; refusing to fall back to host bash -lc` };
  }
  return { ok: true, sandbox, workspace };
}

export interface SandboxVerifyDeps {
  exec?: SandboxExec;
  /** Evidence sink for each check (default: none). */
  onEvidence?: EvidenceSink;
  /** HEAD probe override (test seam); defaults to the real `sbx exec` probe. */
  headProbe?: (sandbox: string, workspace: string) => string | null;
}

/**
 * Resolve the VERIFY target for a Task. A Task with a durable Coding Sandbox
 * verifies INSIDE it at the recorded HEAD. A Task with NO sandbox row returns
 * null (the caller falls back to the host runner); a Task whose sandbox row
 * exists but is unusable returns a fail-closed `not_run` target — never null, so
 * generated code is never run on the host. This is the ONE place the
 * sandbox/host choice is made, so it is easy to test.
 */
export function sandboxVerifyTarget(
  db: Database,
  task: Task,
  checks: CheckSpec[],
  deps: SandboxVerifyDeps = {}
): VerifyTarget | null {
  const found = sandboxForVerify(db, task);
  if (!found) return null;
  const head = task.head_sha;
  if (!found.ok) {
    // A sandbox row exists but cannot be used: fail closed. The pre-run head
    // binding is satisfied (`() => head`) so the RUNNER's `not_run` is what
    // blocks — never the host runner.
    return {
      runner: notRunRunner(found.reason, undefined),
      cwd: task.worktree ?? "",
      headSha: head ?? undefined,
      headProbe: () => head ?? null,
      sandbox: undefined,
    };
  }
  const exec = deps.exec ?? realSandboxExec;
  // Default evidence: a JSONL line per check under the sandbox's evidence dir.
  const onEvidence =
    deps.onEvidence ??
    (found.sandbox.evidence_dir ? jsonlEvidenceSink(join(found.sandbox.evidence_dir, "sandbox-verify.jsonl")) : undefined);
  // No recorded head: still run in the sandbox, but bind to "" so the runner's
  // own fence returns `not_run` — never a PASS (see runMechanicalVerification,
  // which also fails closed on a missing head).
  const binding: SandboxVerifyBinding = {
    sandbox: found.sandbox.name,
    workspace: found.workspace,
    head: head ?? "",
    exec,
  };
  // The pre-run head binding is a REAL synchronous `sbx exec … rev-parse HEAD`
  // (the runner's own async fence is the per-check authority). A missing head is
  // left to `runMechanicalVerification`, which already BLOCKS on it.
  const probe = deps.headProbe
    ? () => deps.headProbe!(found.sandbox.name, found.workspace)
    : () => sandboxHeadProbeSync(found.sandbox.name, found.workspace);
  return {
    runner: evidenceSandboxRunner(binding, checks, onEvidence),
    cwd: found.workspace,
    headSha: head ?? undefined,
    headProbe: probe,
    sandbox: found.sandbox.name,
  };
}

/**
 * The default resolver the daemon wires into `WorkflowDeps.verifyTarget`: verify
 * a Task inside its Coding Sandbox when it has one, else return null (the caller
 * falls back to the host runner). No DB or env coupling beyond the Task's own
 * durable sandbox row.
 */
export function defaultVerifyTarget(db: Database, task: Task, checks: CheckSpec[]): VerifyTarget | null {
  return sandboxVerifyTarget(db, task, checks);
}
