/**
 * ISH-1174 — the bounded RECOVERY side of the transient failure class.
 *
 * `transient-failure.ts` decides WHETHER a failure is a provider/network
 * outage. This module supplies the policy, the bounded wait (probe with
 * exponential backoff), the resume prompts, and the stale-head fence. It never
 * launches a process and never advances the Task: the Factory owns sequencing
 * and reuses its ordinary `startDshRun` / `finishImplement` path.
 */

import type { Database } from "bun:sqlite";
import type { Run, Task } from "./schema";
import { buildTaskPrompt } from "./dsh-runner";
import { gitCurrentBranch, gitHeadOf, gitRun } from "./run-lifecycle";
import { readEvidenceTail } from "./implement-recovery";
import { taskHeadOvertakenByOtherWriter, runHeadFenceRepos } from "./run-owner";
import { runObservedOwnHeads } from "./run-heads";
import { readRunProviderEvidence } from "./transient-failure";

/** ISH-1174 defaults: 3 resumes per attempt, 60 min total wait, 30 s -> 5 min. */
export const DEFAULT_TRANSIENT_MAX_RESUMES = 3;
export const DEFAULT_TRANSIENT_WAIT_MS = 60 * 60_000;
export const DEFAULT_TRANSIENT_BACKOFF_MS = 30_000;
export const DEFAULT_TRANSIENT_MAX_BACKOFF_MS = 5 * 60_000;
export const DEFAULT_PROVIDER_PROBE_TIMEOUT_MS = 10_000;
/**
 * The provider reachability probe. Any HTTP answer below 500 (and not 429)
 * means the network path is back; the SPECIFIC provider request is still made by
 * dsh, and a repeated failure simply stays in the bounded wait/resume loop.
 * `RELAY_PROVIDER_PROBE_URL` overrides it for a different provider/gateway.
 */
export const DEFAULT_PROVIDER_PROBE_URL = "https://api.deepseek.com/";

export interface TransientPolicy {
  /** Resume launches allowed per Task/phase/attempt (default 3). */
  maxResumes: number;
  /** Total wait budget for one attempt's transient recovery (default 60 min). */
  waitMs: number;
  /** First probe wait; doubles each failure (default 30 s). */
  backoffMs: number;
  /** Backoff ceiling (default 5 min). */
  maxBackoffMs: number;
  /** One reachability probe's own timeout (default 10 s). */
  probeTimeoutMs: number;
  /** Provider/gateway reachability URL. */
  probeUrl: string;
}

export interface TransientPolicyOverrides {
  maxResumes?: number;
  waitMs?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  probeTimeoutMs?: number;
  probeUrl?: string;
  env?: NodeJS.ProcessEnv;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function explicitInt(value: number | undefined, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  return Number.isFinite(value) ? Math.max(min, Math.floor(value)) : fallback;
}

/**
 * Resolve the policy: explicit Factory/CLI values win, then the documented env
 * vars, then the ISH-1174 defaults. Invalid values keep the safe default (never
 * an unbounded wait or an infinite resume loop).
 */
export function resolveTransientPolicy(overrides: TransientPolicyOverrides = {}): TransientPolicy {
  const env = overrides.env ?? process.env;
  const maxResumes = explicitInt(
    overrides.maxResumes,
    positiveInt(env.RELAY_TRANSIENT_MAX_RESUMES, DEFAULT_TRANSIENT_MAX_RESUMES),
    0
  );
  const waitMs = explicitInt(
    overrides.waitMs,
    positiveInt(env.RELAY_TRANSIENT_WAIT_MS, DEFAULT_TRANSIENT_WAIT_MS),
    0
  );
  const backoffMs = explicitInt(
    overrides.backoffMs,
    positiveInt(env.RELAY_TRANSIENT_BACKOFF_MS, DEFAULT_TRANSIENT_BACKOFF_MS),
    1
  );
  const maxBackoffMs = Math.max(
    backoffMs,
    explicitInt(
      overrides.maxBackoffMs,
      positiveInt(env.RELAY_TRANSIENT_MAX_BACKOFF_MS, DEFAULT_TRANSIENT_MAX_BACKOFF_MS),
      1
    )
  );
  const probeTimeoutMs = explicitInt(
    overrides.probeTimeoutMs,
    positiveInt(env.RELAY_PROVIDER_PROBE_TIMEOUT_MS, DEFAULT_PROVIDER_PROBE_TIMEOUT_MS),
    1
  );
  const probeUrl = (overrides.probeUrl ?? env.RELAY_PROVIDER_PROBE_URL ?? DEFAULT_PROVIDER_PROBE_URL).trim() || DEFAULT_PROVIDER_PROBE_URL;
  return { maxResumes, waitMs, backoffMs, maxBackoffMs, probeTimeoutMs, probeUrl };
}

/** The real reachability probe: an HTTP answer below 500 that is not 429. */
export async function defaultProviderProbe(url = DEFAULT_PROVIDER_PROBE_URL, timeoutMs = DEFAULT_PROVIDER_PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "relay-transient-probe" },
    });
    return res.status !== 429 && res.status < 500;
  } catch {
    return false;
  }
}

export interface TransientWaitContext {
  taskId: string;
  runId: string | null;
  phase: string;
  attempt: number;
  cause: string | null;
  resumeCount: number;
}

export interface TransientWaitEvent extends TransientWaitContext {
  /** 1-based probe number that just failed. */
  probe: number;
  /** How long the Factory will now wait before the next probe. */
  delayMs: number;
  /** Time since the transient episode began. */
  elapsedMs: number;
  /** The total wait cap for this episode. */
  capMs: number;
}

export interface WaitForProviderRecoveryOptions {
  probe: () => Promise<boolean>;
  /** Called BEFORE each sleep so a durable event is written while waiting. */
  onWait: (event: TransientWaitEvent) => void;
  capMs: number;
  backoffMs: number;
  maxBackoffMs: number;
  context: TransientWaitContext;
  /** Test seams; the defaults are real time/`setTimeout`. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WaitForProviderRecoveryResult {
  recovered: boolean;
  probes: number;
  elapsedMs: number;
}

/**
 * Probe the provider with exponential backoff until it is reachable or the
 * TOTAL `capMs` budget expires. One probe is made immediately: a Run that
 * failed with a 5xx a moment ago may already be fine, and the resume itself is
 * still HEAD-fenced and bounded.
 */
export async function waitForProviderRecovery(opts: WaitForProviderRecoveryOptions): Promise<WaitForProviderRecoveryResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  let delay = Math.max(1, opts.backoffMs);
  let probes = 0;
  for (;;) {
    probes++;
    if (await opts.probe()) {
      return { recovered: true, probes, elapsedMs: now() - started };
    }
    const elapsed = now() - started;
    if (elapsed >= opts.capMs) {
      return { recovered: false, probes, elapsedMs: elapsed };
    }
    const sleepMs = Math.max(1, Math.min(delay, opts.capMs - elapsed));
    opts.onWait({ ...opts.context, probe: probes, delayMs: sleepMs, elapsedMs: elapsed, capMs: opts.capMs });
    await sleep(sleepMs);
    delay = Math.min(Math.max(1, delay * 2), Math.max(1, opts.maxBackoffMs));
  }
}

/* -------------------------------------------------------------------------- */
/* Resume prompts                                                              */
/* -------------------------------------------------------------------------- */

function clipBlock(value: string | null | undefined, max = 4000): string {
  const text = (value ?? "").trim();
  if (!text) return "(none)";
  return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated)`;
}

function fenceText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The SHORT continue prompt for a same-session resume. The dsh Session already
 * holds the task brief, so this only names the interruption and asks dsh to
 * carry on — never a re-statement that could make it restart the work.
 */
export function buildSessionResumePrompt(task: Task, failed: Pick<Run, "id" | "attempt">, cause: string): string {
  return [
    `# Continue — Task ${task.id} (attempt ${failed.attempt})`,
    "",
    `The previous Run (${failed.id}) was interrupted by a TRANSIENT provider/network failure:`,
    cause,
    "",
    "Continue the SAME task from where you left off. Do not restart from scratch:",
    "inspect `git status` and `git diff`, finish the remaining work, run the relevant",
    "checks, commit on the current branch, and report what you changed. Do not merge.",
  ].join("\n");
}

/** The bounded carry-over context for a FRESH session in the same worktree. */
export interface FreshSessionContext {
  finalText: string | null;
  status: string | null;
  diffSummary: string | null;
  /** The commit range's diff summary (the work already committed). */
  committedSummary: string | null;
}

/** Read `git status` + a diff summary from the failed Run's worktree. */
export function readFreshSessionContext(cwd: string, failed: Pick<Run, "base_head_sha" | "head_sha">): FreshSessionContext {
  const status = fenceText(gitRun(cwd, ["status", "--short"]).out);
  const unstaged = gitRun(cwd, ["diff", "--stat"]).out;
  const staged = gitRun(cwd, ["diff", "--cached", "--stat"]).out;
  const diff = [unstaged, staged].map((s) => s.trim()).filter(Boolean).join("\n");
  let committed: string | null = null;
  if (failed.base_head_sha && failed.head_sha && failed.base_head_sha !== failed.head_sha) {
    const r = gitRun(cwd, ["diff", "--stat", `${failed.base_head_sha}..${failed.head_sha}`]);
    committed = fenceText(r.out);
  }
  return {
    finalText: null,
    status,
    diffSummary: fenceText(diff),
    committedSummary: committed,
  };
}

/**
 * The FRESH-session fallback brief. It carries the previous Run's final text,
 * `git status` and a diff summary so the worktree's uncommitted/partial work is
 * not silently discarded when the persisted Session cannot be adopted. The
 * original Task spec is included too: a fresh dsh has never seen it.
 */
export function buildFreshSessionResumePrompt(
  task: Task,
  failed: Pick<Run, "id" | "attempt" | "base_head_sha" | "head_sha" | "dsh_events_path">,
  cause: string,
  opts: {
    cwd: string;
    /**
     * The last non-empty final text seen in the resume chain. The IMMEDIATE
     * failed Run may be the failed session-adoption attempt (no output), so the
     * original interruption's final text is carried forward explicitly.
     */
    finalText?: string | null;
    readProvider?: typeof readRunProviderEvidence;
    readTail?: typeof readEvidenceTail;
  } = { cwd: "" }
): string {
  const readProvider = opts.readProvider ?? readRunProviderEvidence;
  const ev = readProvider(failed.dsh_events_path);
  const ctx = readFreshSessionContext(opts.cwd, failed);
  const carried = opts.finalText?.trim() ? opts.finalText : null;
  const finalText = carried ?? ev.finalText ?? ctx.finalText;
  return [
    buildTaskPrompt(task),
    "",
    "## Previous Run — resume context",
    "",
    `The previous Run (${failed.id}, attempt ${failed.attempt}) could not be continued in its`,
    "persisted dsh Session. This is a FRESH session in the SAME worktree: the work below",
    "is already present, so do NOT start over and do NOT discard it.",
    "",
    `Interruption cause: ${cause}`,
    "",
    "### Previous final text",
    "",
    "```",
    clipBlock(finalText),
    "```",
    "",
    "### git status --short",
    "",
    "```",
    clipBlock(ctx.status),
    "```",
    "",
    "### Diff summary (uncommitted)",
    "",
    "```",
    clipBlock(ctx.diffSummary),
    "```",
    "",
    "### Diff summary (commits already produced by the previous Run)",
    "",
    "```",
    clipBlock(ctx.committedSummary),
    "```",
    "",
    "Finish the remaining work in this worktree, run the relevant checks, commit on the",
    "current branch, and report what you changed. Do not merge.",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Stale-head fence                                                            */
/* -------------------------------------------------------------------------- */

export interface ResumeFenceDecision {
  ok: boolean;
  reason: string | null;
}

/**
 * ISH-1174 safety: before ANY resume, prove the worktree/branch the failed Run
 * wrote is still the one at the recorded HEAD. If another writer moved either,
 * the resume is refused and the Factory stops exactly as it does today.
 *
 * This deliberately also runs the existing Task-head fence: a provider poll or
 * a human may have bound the Task to a foreign revision while the Run was down.
 */
export function checkResumeFence(db: Database, task: Task, run: Run): ResumeFenceDecision {
  const cwd = run.cwd;
  if (!cwd) return { ok: false, reason: "STALE_HEAD: the failed Run has no worktree to resume" };
  const expectedBranch = run.branch ?? task.branch;
  const liveBranch = gitCurrentBranch(cwd);
  if (expectedBranch && liveBranch !== expectedBranch) {
    return {
      ok: false,
      reason: `STALE_HEAD: worktree branch ${liveBranch ?? "none"} != recorded branch ${expectedBranch}; another writer moved it`,
    };
  }
  const expectedHead = run.head_sha ?? run.base_head_sha;
  const liveHead = gitHeadOf(cwd);
  if (expectedHead && liveHead !== expectedHead) {
    return {
      ok: false,
      reason: `STALE_HEAD: worktree HEAD ${liveHead ?? "none"} != recorded head ${expectedHead}; another writer moved it`,
    };
  }
  if (
    taskHeadOvertakenByOtherWriter(
      task.head_sha,
      run,
      runHeadFenceRepos(run),
      runObservedOwnHeads(db, run.id)
    )
  ) {
    return {
      ok: false,
      reason: `STALE_HEAD: task head ${task.head_sha ?? "none"} was overtaken by another writer (run started at ${run.base_head_sha ?? "none"}, produced ${run.head_sha ?? "none"})`,
    };
  }
  return { ok: true, reason: null };
}
