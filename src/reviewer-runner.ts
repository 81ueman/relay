import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { now } from "./db";
import { logEvent } from "./events";
import { getTask, reviewHeldByLiveReviewer } from "./tasks";
import { inheritFindings } from "./run-lifecycle";
import { findSubmissionForAttempt } from "./results";
import { REVIEWER_ROLE } from "./schema";
import type { Task } from "./schema";
import { gitHead } from "./verify";
import { recordReview, taskChecks } from "./workflow";
import { getWorker, registerWorker } from "./workers";

/**
 * ISH-762: the independent HEADLESS reviewer.
 *
 * The Factory's reviewer is a SEPARATE principal from the coding worker: a real
 * Claude process (`claude -p --output-format json`) invoked with READ-ONLY
 * access, given a brief pinned to the Task's worktree, that prints ONE
 * structured verdict. Relay parses ONLY that structured verdict and records it
 * through the ordinary `recordReview` path — so the existing authority,
 * independence, HEAD-binding and duplicate/unresolved-NG rules all apply
 * unchanged. Nothing here is a second review state machine.
 *
 * Fail-closed rules (a reviewer can never manufacture an advance):
 *   - no structured result / malformed output / unknown verdict  -> REFUSED;
 *   - a verdict that does not name the CURRENT head              -> REFUSED;
 *   - the worktree HEAD moved since the Run was bound            -> REFUSED;
 *   - the reviewer is not an independent reviewer principal      -> REFUSED
 *     (`recordReview` AUTHORITY check: not the submitter, holds REVIEWER_ROLE).
 */

export const REVIEW_ERROR = "REVIEW_ERROR";
export const REVIEW_NO_STRUCTURED_RESULT = "REVIEW_NO_STRUCTURED_RESULT";
export const REVIEW_BAD_VERDICT = "REVIEW_BAD_VERDICT";
export const REVIEW_HEAD_MISMATCH = "REVIEW_HEAD_MISMATCH";
export const REVIEW_NOT_INDEPENDENT = "REVIEW_NOT_INDEPENDENT";
export const REVIEW_NOT_IN_REVIEW = "REVIEW_NOT_IN_REVIEW";

/** The worker row a headless Claude review is recorded under (role: reviewer). */
export const DEFAULT_REVIEWER_WORKER = "claude-review";

/** The default real reviewer command (`claude -p --output-format json`). */
export const DEFAULT_REVIEW_COMMAND = "claude";

/** A reviewer is a READ-ONLY principal: it may inspect, never write the work. */
export const REVIEW_READONLY_TOOLS = "Read Grep Glob";

export type ReviewSeverity = "blocker" | "major" | "minor" | "nit";

export interface ReviewFinding {
  severity: ReviewSeverity;
  file?: string;
  line?: number;
  message: string;
}

/** The ONLY shape Relay parses from a reviewer. */
export interface ReviewerVerdict {
  verdict: "pass" | "fix" | "blocked";
  /** The head the reviewer judged; MUST equal the task's recorded head. */
  head: string | null;
  findings: ReviewFinding[];
  summary: string;
}

export interface ReviewerSpawnContext {
  cwd: string;
  /** The full review brief (also pinned at `.relay/review-brief.md`). */
  brief: string;
  env: Record<string, string>;
  timeoutMs: number;
  model?: string;
}

export interface ReviewerProcess {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/** Test seam: how a reviewer process is launched (fake in tests). */
export interface ReviewerSpawner {
  run(ctx: ReviewerSpawnContext): Promise<ReviewerProcess>;
}

export interface HeadlessReviewDeps {
  spawner?: ReviewerSpawner;
  /** The real reviewer command (default `claude`). */
  command?: string;
  /** The reviewer worker id (default `claude-review`). */
  reviewerWorker?: string;
  model?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Review profile for duplicate-dispatch protection (default task/default). */
  profile?: string;
}

export interface HeadlessReviewResult {
  /** `pass`/`fix`/`blocked` advanced the Task; `refused` did NOT. */
  outcome: "pass" | "fix" | "blocked" | "refused";
  task: Task;
  verdict: ReviewerVerdict | null;
  sessionId: string | null;
  /** Non-null on a refusal (a fail-closed reason), for evidence/tests. */
  error: string | null;
  evidenceRef: string | null;
  raw: string;
}

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

/** Deterministic in-worktree path the review brief is pinned to (gitignored). */
export function reviewBriefPath(worktree: string): string {
  return join(worktree, ".relay", "review-brief.md");
}

/** Where the raw reviewer output for one review is retained as evidence. */
export function reviewEvidencePath(worktree: string, attempt: number, head: string | null): string {
  const h = head ? head.slice(0, 10) : "none";
  return join(worktree, ".relay", "reviews", `attempt-${attempt}-${h}.json`);
}

/**
 * The review brief: the durable Task spec + the exact head under review + the
 * required output contract. The reviewer is told explicitly that it is
 * independent and READ-ONLY, and that a pass naming a different head is refused.
 */
export function buildReviewBrief(db: Database, task: Task, opts: { head: string; worktree: string }): string {
  const checks = taskChecks(task);
  const findings = inheritFindingsForBrief(db, task);
  const lines: string[] = [
    `# Independent review — Task ${task.id} (attempt ${task.attempt})`,
    "",
    "You are an INDEPENDENT code reviewer. You did NOT write this change. You have",
    "READ-ONLY access: do not modify any file, do not commit, do not merge.",
    "",
    `Judge ONLY the revision at HEAD \`${opts.head}\` in \`${opts.worktree}\`.`,
    "",
    `Title: ${task.title}`,
  ];
  if (task.description) lines.push("", "## Description", "", task.description);
  if (task.acceptance) lines.push("", "## Acceptance", "", task.acceptance);
  if (checks.length > 0) {
    lines.push("", "## Mechanical checks Relay runs after the coding Run (`pass` requires these to pass)");
    for (const c of checks) lines.push(`- ${c.name}: \`${c.command}\`${c.required === false ? " (optional)" : ""}`);
  }
  if (findings.length > 0) {
    lines.push("", `## Prior findings @ attempt ${token(task)} (context — verify they are actually fixed)`);
    for (const f of findings) lines.push(`- ${f}`);
  }
  lines.push(
    "",
    "## Required output (STRICT)",
    "Respond with ONE JSON object and NOTHING else (no prose, no code fence):",
    '{"verdict":"pass|fix|blocked","head":"<sha you reviewed>","findings":[{"severity":"blocker|major|minor|nit","file":"<path>","line":<n>,"message":"<what>"}],"summary":"<one line>"}',
    "",
    "- `pass`: the change is correct and complete for the acceptance above.",
    "- `fix`: it needs changes — list concrete findings a coding agent can act on.",
    "- `blocked`: you cannot judge (missing/incoherent context); say why in `summary`.",
    `- \`head\` MUST be exactly \`${opts.head}\`. A pass naming any other head is refused.`,
    "- Do not approve a change you have not read; do not invent findings."
  );
  return lines.join("\n");
}

function token(task: Task): number {
  return Math.max(0, task.attempt - 1);
}

function inheritFindingsForBrief(db: Database, task: Task): string[] {
  // Reuse the same findings source a FIX Run sees (from run-lifecycle).
  return inheritFindings(db, task).map(
    (f) => `[${f.kind}] ${f.reason ?? "(no reason)"}${f.evidence ? ` — ${f.evidence}` : ""}`
  );
}

/** Write the pin into the worktree (gitignored) before the reviewer starts. */
export function pinReviewBrief(worktree: string, text: string): string {
  const p = reviewBriefPath(worktree);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${text}\n`);
  return p;
}

// ---------------------------------------------------------------------------
// Structured output parsing (fail-closed)
// ---------------------------------------------------------------------------

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function normalizeVerdict(raw: Record<string, unknown>): ReviewerVerdict | null {
  const v = String(raw.verdict ?? "").toLowerCase();
  const verdict = v === "pass" || v === "ok" ? "pass" : v === "fix" || v === "fail" || v === "ng" ? "fix" : v === "blocked" || v === "hold" ? "blocked" : null;
  if (!verdict) return null;
  const findingsRaw = Array.isArray(raw.findings) ? raw.findings : [];
  const findings: ReviewFinding[] = [];
  for (const f of findingsRaw) {
    if (typeof f === "string") {
      findings.push({ severity: "major", message: f });
      continue;
    }
    if (!isRecord(f)) continue;
    const sev = String(f.severity ?? "major").toLowerCase();
    const severity: ReviewSeverity =
      sev === "blocker" || sev === "major" || sev === "minor" || sev === "nit" ? sev : "major";
    const message = String(f.message ?? f.reason ?? f.body ?? "").trim();
    if (!message) continue;
    const finding: ReviewFinding = { severity, message };
    if (typeof f.file === "string") finding.file = f.file;
    if (typeof f.line === "number") finding.line = f.line;
    findings.push(finding);
  }
  const head = typeof raw.head === "string" && raw.head.trim() ? raw.head.trim() : null;
  const summary = String(raw.summary ?? raw.reason ?? "").trim();
  return { verdict, head, findings, summary };
}

/**
 * Extract the structured verdict from a reviewer's output, tolerating the
 * `claude --output-format json` envelope, a bare JSON object, a JSONL stream, a
 * fenced block, or JSON embedded in prose. Returns null when there is NO
 * structured verdict (which is always a refusal, never a pass).
 */
export function extractReviewerVerdict(raw: string): ReviewerVerdict | null {
  if (!raw || !raw.trim()) return null;
  const direct = tryJson(raw.trim());
  if (isRecord(direct)) {
    if (typeof direct.result === "string") {
      const inner = tryJson(direct.result.trim());
      if (isRecord(inner)) {
        const v = normalizeVerdict(inner);
        if (v) return v;
      }
    }
    const v = normalizeVerdict(direct);
    if (v) return v;
  }
  // JSONL: last line carrying a verdict wins.
  for (const line of raw.split("\n").reverse()) {
    const o = tryJson(line.trim());
    if (isRecord(o)) {
      const v = normalizeVerdict(o);
      if (v) return v;
    }
  }
  // A fenced json block.
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const o = tryJson(fence[1].trim());
    if (isRecord(o)) {
      const v = normalizeVerdict(o);
      if (v) return v;
    }
  }
  // The outermost {...} span.
  const b = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (b >= 0 && e > b) {
    const o = tryJson(raw.slice(b, e + 1));
    if (isRecord(o)) {
      const v = normalizeVerdict(o);
      if (v) return v;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The real spawner
// ---------------------------------------------------------------------------

/**
 * The real reviewer: `claude -p --output-format json --allowedTools "Read Grep
 * Glob"` with the brief on stdin. Spawned in a NEW process group so a timeout
 * can kill the whole tree (a reviewer cannot stall the Factory).
 */
export function bunReviewerSpawner(command = DEFAULT_REVIEW_COMMAND): ReviewerSpawner {
  return {
    async run(ctx) {
      const args = [
        "-p",
        "--output-format",
        "json",
        "--allowedTools",
        REVIEW_READONLY_TOOLS,
      ];
      if (ctx.model) args.push("--model", ctx.model);
      const proc = Bun.spawn([command, ...args], {
        cwd: ctx.cwd,
        env: { ...process.env, ...ctx.env },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
      proc.stdin.write(ctx.brief);
      proc.stdin.end();
      const collector = (async () => {
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout as ReadableStream).text(),
          new Response(proc.stderr as ReadableStream).text(),
        ]);
        const exitCode = await proc.exited;
        return { stdout, stderr, exitCode };
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ctx.timeoutMs);
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
            /* gone */
          }
        }
        void collector.catch(() => {});
        return { exitCode: null, signal: "SIGKILL", stdout: "", stderr: `reviewer timed out after ${ctx.timeoutMs}ms` };
      }
      return { exitCode: winner.exitCode, signal: null, stdout: winner.stdout, stderr: winner.stderr };
    },
  };
}

// ---------------------------------------------------------------------------
// Run one headless review
// ---------------------------------------------------------------------------

function refusal(
  error: string,
  task: Task,
  extra: Partial<HeadlessReviewResult> = {}
): HeadlessReviewResult {
  return { outcome: "refused", task, verdict: null, sessionId: null, error, evidenceRef: null, raw: "", ...extra };
}

/**
 * Run one independent headless review of the Task's CURRENT head and, when it is
 * a valid structured verdict, record it through `recordReview` (which enforces
 * authority + independence + HEAD binding). A malformed/missing result, a
 * mismatched head, a moved worktree HEAD, or a non-independent reviewer is
 * REFUSED — the Task never advances.
 */
export async function runHeadlessReview(
  db: Database,
  taskId: string,
  deps: HeadlessReviewDeps = {}
): Promise<HeadlessReviewResult> {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  if (task.code_change !== 1) throw new Error(`${REVIEW_ERROR}: ${taskId} is not a code-change task`);
  if (task.phase !== "review" || task.state !== "review") {
    return refusal(`${REVIEW_NOT_IN_REVIEW}: ${taskId} is state '${task.state}' phase '${task.phase ?? "none"}'`, task);
  }
  const head = task.head_sha;
  if (!head) return refusal(`${REVIEW_HEAD_MISMATCH}: task ${taskId} has no recorded head to review`, task);
  const worktree = task.worktree;
  if (!worktree || !existsSync(worktree)) {
    return refusal(`${REVIEW_ERROR}: task ${taskId} has no live worktree to review`, task);
  }
  const liveHead = gitHead(worktree);
  if (liveHead !== head) {
    return refusal(
      `${REVIEW_HEAD_MISMATCH}: worktree HEAD ${liveHead ?? "none"} != review head ${head} (stale review never advances)`,
      task
    );
  }

  const reviewerWorker = deps.reviewerWorker ?? DEFAULT_REVIEWER_WORKER;
  // Register ONLY when absent: an existing worker keeps its own role, so a
  // non-reviewer principal is refused by `recordReview` (never silently promoted).
  if (!getWorker(db, reviewerWorker)) {
    registerWorker(db, reviewerWorker, { role: REVIEWER_ROLE, agentKind: "claude" });
  }
  // Explicit independence precheck (recordReview re-enforces it as the authority
  // of record): a principal that neither holds REVIEWER_ROLE nor the review claim
  // can never review — a fake/foreign reviewer identity is refused up front.
  const reviewerRow = getWorker(db, reviewerWorker);
  if (reviewerRow && reviewerRow.role !== REVIEWER_ROLE && task.assignee !== reviewerWorker) {
    logEvent(db, {
      source: "factory",
      taskId,
      type: "factory.review_refused",
      payload: { reason: REVIEW_NOT_INDEPENDENT, reviewer: reviewerWorker, role: reviewerRow.role },
    });
    return refusal(`${REVIEW_NOT_INDEPENDENT}: ${reviewerWorker} (role '${reviewerRow.role}') may not review ${taskId}`, task);
  }

  const brief = buildReviewBrief(db, task, { head, worktree });
  pinReviewBrief(worktree, brief);
  logEvent(db, {
    source: "factory",
    taskId,
    type: "factory.review_started",
    payload: { head, attempt: task.attempt, reviewer: reviewerWorker, worktree },
  });

  const spawner = deps.spawner ?? bunReviewerSpawner(deps.command ?? DEFAULT_REVIEW_COMMAND);
  const proc = await spawner.run({
    cwd: worktree,
    brief,
    env: deps.env ?? {},
    timeoutMs: deps.timeoutMs ?? 20 * 60_000,
    model: deps.model,
  });
  const raw = `${proc.stdout}\n${proc.stderr}`;
  const verdict = extractReviewerVerdict(proc.stdout) ?? extractReviewerVerdict(proc.stderr);

  // Retain the RAW reviewer output as evidence (never masquerade it as a dsh event).
  const evidencePath = reviewEvidencePath(worktree, task.attempt, head);
  try {
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(
      evidencePath,
      `${JSON.stringify(
        {
          taskId,
          attempt: task.attempt,
          head,
          reviewer: reviewerWorker,
          command: deps.command ?? DEFAULT_REVIEW_COMMAND,
          exitCode: proc.exitCode,
          signal: proc.signal,
          structured: verdict,
          stdout: proc.stdout.slice(0, 32_768),
          stderr: proc.stderr.slice(0, 8_192),
        },
        null,
        2
      )}\n`
    );
  } catch {
    /* evidence write is best effort, never a verdict */
  }

  if (!verdict) {
    logEvent(db, {
      source: "factory",
      taskId,
      type: "factory.review_refused",
      payload: { reason: REVIEW_NO_STRUCTURED_RESULT, head, exitCode: proc.exitCode, evidence: evidencePath },
    });
    return refusal(REVIEW_NO_STRUCTURED_RESULT, task, { evidenceRef: evidencePath, raw });
  }
  if (verdict.verdict !== "blocked") {
    if (!verdict.head || verdict.head !== head) {
      logEvent(db, {
        source: "factory",
        taskId,
        type: "factory.review_refused",
        payload: { reason: REVIEW_HEAD_MISMATCH, named: verdict.head, head, evidence: evidencePath },
      });
      return refusal(
        `${REVIEW_HEAD_MISMATCH}: reviewer named head ${verdict.head ?? "none"}, task head is ${head}`,
        task,
        { verdict, evidenceRef: evidencePath, raw }
      );
    }
  }

  // Independence: the review is recorded as the reviewer worker, which holds
  // REVIEWER_ROLE and is never the Run submitter. Take the review claim for THIS
  // task (a review carries no lease; a live holder cannot be stolen).
  if (task.assignee !== reviewerWorker) {
    const live = getTask(db, taskId)!;
    if (live.state !== "review") {
      return refusal(`${REVIEW_NOT_IN_REVIEW}: ${taskId} left review before the reviewer claimed it`, task, {
        verdict,
        evidenceRef: evidencePath,
        raw,
      });
    }
    if (live.assignee && live.assignee !== reviewerWorker && reviewHeldByLiveReviewer(db, live)) {
      return refusal(`${REVIEW_ERROR}: review of ${taskId} is held by live reviewer ${live.assignee}`, task, {
        verdict,
        evidenceRef: evidencePath,
        raw,
      });
    }
    const t = now();
    db.transaction(() => {
      db.query(`UPDATE tasks SET assignee = ?, updated_at = ? WHERE id = ?`).run(reviewerWorker, t, taskId);
      db.query(
        `UPDATE workers SET current_task_id = ?, state = 'working', last_seen_at = ?, last_progress_at = ?, updated_at = ? WHERE id = ?`
      ).run(taskId, t, t, t, reviewerWorker);
    })();
    logEvent(db, { source: "factory", taskId, type: "task.review_assigned", payload: { reviewer: reviewerWorker } });
  }

  const reason = [
    verdict.summary,
    ...verdict.findings.map((f) => `[${f.severity}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""}: ` : ""}${f.message}`),
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const updated = recordReview(db, taskId, reviewerWorker, {
      verdict: verdict.verdict,
      headSha: verdict.head ?? head,
      reason: reason || undefined,
      evidence: evidencePath,
      source: "claude-headless",
      profile: deps.profile,
    });
    logEvent(db, {
      source: "factory",
      taskId,
      type: "factory.review_recorded",
      payload: { verdict: verdict.verdict, head, reviewer: reviewerWorker, evidence: evidencePath, phase: updated.phase },
    });
    return {
      outcome: verdict.verdict,
      task: updated,
      verdict,
      sessionId: extractSessionId(proc.stdout),
      error: null,
      evidenceRef: evidencePath,
      raw,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A reviewer that is not independent (the submitter, or lacks the role) is a
    // fail-closed refusal, not a crash.
    const refused = /AUTHORITY/.test(msg);
    logEvent(db, {
      source: "factory",
      taskId,
      type: "factory.review_refused",
      payload: { reason: refused ? REVIEW_NOT_INDEPENDENT : REVIEW_ERROR, message: msg, head, evidence: evidencePath },
    });
    return refusal(refused ? `${REVIEW_NOT_INDEPENDENT}: ${msg}` : `${REVIEW_ERROR}: ${msg}`, task, {
      verdict,
      evidenceRef: evidencePath,
      raw,
    });
  }
}

/** Best-effort session id from a `claude --output-format json` envelope. */
export function extractSessionId(raw: string): string | null {
  const o = tryJson(raw.trim());
  if (isRecord(o) && typeof o.session_id === "string") return o.session_id;
  return null;
}

/** True when this reviewer worker is an independent reviewer for the task. */
export function isIndependentReviewer(db: Database, taskId: string, reviewerId: string): boolean {
  const task = getTask(db, taskId);
  const w = getWorker(db, reviewerId);
  if (!task || !w) return false;
  if (w.role !== REVIEWER_ROLE) return false;
  const submission = findSubmissionForAttempt(db, taskId, task.attempt);
  return !submission || submission.worker_id !== reviewerId;
}
