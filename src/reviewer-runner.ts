import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { now } from "./db";
import { logEvent } from "./events";
import { getTask, reviewHeldByLiveReviewer } from "./tasks";
import { inheritFindings } from "./run-lifecycle";
import { findSubmissionForAttempt, isResultWriteError } from "./results";
import { REVIEWER_ROLE } from "./schema";
import type { Task } from "./schema";
import { gitHead } from "./verify";
import { recordReview, taskChecks } from "./workflow";
import { ensureHeadlessWorker, getWorker, HEADLESS_AGENT_KIND } from "./workers";
import {
  headsMatch,
  latestReviewInvalidationAt,
  markerAfterInvalidation,
  parsePrUrl,
  reviewBodyHasMarker,
  type GitHubReadOnly,
  type MarkerVerdict,
  type NativeReviewDeps,
  type PrRef,
  type ReviewMarker,
  type ReviewView,
} from "./providers";

/**
 * ISH-762: the independent HEADLESS reviewer.
 *
 * The Factory's reviewer is a SEPARATE principal from the coding worker: a real
 * Claude process (`claude -p --output-format json`) invoked with
 * `--permission-mode auto` (an approval mode, not an OS sandbox) and a brief that
 * instructs it to treat the checkout as READ-ONLY, given a brief pinned to the
 * Task's worktree, that prints ONE structured verdict. Relay parses ONLY that
 * structured verdict and records it through the ordinary `recordReview` path — so
 * the existing authority, independence, HEAD-binding and duplicate/unresolved-NG
 * rules all apply unchanged. Nothing here is a second review state machine.
 *
 * Fail-closed rules (a reviewer can never manufacture an advance):
 *   - no structured result / malformed output / unknown verdict  -> REFUSED;
 *   - a verdict that does not name the CURRENT head              -> REFUSED;
 *   - the worktree HEAD moved since the Run was bound            -> REFUSED;
 *   - the reviewer is not an independent reviewer principal      -> REFUSED
 *     (`recordReview` AUTHORITY check: not the submitter, holds REVIEWER_ROLE).
 *
 * ISH-883 adds an OPTIONAL native PR-review path: when configured, the reviewer
 * posts a native GitHub Pull Request Review and Relay accepts the verdict only
 * after reading the ACTUAL review back at the exact reviewed HEAD (see
 * `verifyNativeReview`). It is deny-by-default and never changes the authority,
 * HEAD-binding or duplicate rules above.
 */

export const REVIEW_ERROR = "REVIEW_ERROR";
export const REVIEW_NO_STRUCTURED_RESULT = "REVIEW_NO_STRUCTURED_RESULT";
export const REVIEW_BAD_VERDICT = "REVIEW_BAD_VERDICT";
export const REVIEW_HEAD_MISMATCH = "REVIEW_HEAD_MISMATCH";
export const REVIEW_NOT_INDEPENDENT = "REVIEW_NOT_INDEPENDENT";
export const REVIEW_NOT_IN_REVIEW = "REVIEW_NOT_IN_REVIEW";
/** The reviewer process itself failed (non-zero exit / a signal): never a verdict. */
export const REVIEW_PROCESS_FAILED = "REVIEW_PROCESS_FAILED";
/** ISH-883: no bound PR to post a native review to (fail closed). */
export const REVIEW_NATIVE_NO_PR = "REVIEW_NATIVE_NO_PR";
/** ISH-883: the reviewer posted no matching native review at the reviewed HEAD. */
export const REVIEW_NATIVE_MISSING = "REVIEW_NATIVE_MISSING";
/** ISH-883: the reviewer's NEWEST review at the HEAD contradicts the structured verdict. */
export const REVIEW_NATIVE_CONTRADICTED = "REVIEW_NATIVE_CONTRADICTED";
/** ISH-883: a native review could not be read back, or did not match the reviewed HEAD. */
export const REVIEW_NATIVE_UNVERIFIED = "REVIEW_NATIVE_UNVERIFIED";

/** The worker row a headless Claude review is recorded under (role: reviewer). */
export const DEFAULT_REVIEWER_WORKER = "claude-review";

/** The default real reviewer command (`claude -p --output-format json`). */
export const DEFAULT_REVIEW_COMMAND = "claude";

/** Default headless-review budget (20 min); `RELAY_REVIEW_TIMEOUT_MS` may raise it. */
export const DEFAULT_REVIEW_TIMEOUT_MS = 20 * 60_000;

/**
 * The headless-review budget. A very large but legitimate diff can exceed the
 * default; an explicit positive integer in `RELAY_REVIEW_TIMEOUT_MS` raises it
 * without changing the fixed 20-minute default. Invalid values keep the
 * default (fail-safe, never an unbounded review).
 */
export function reviewTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RELAY_REVIEW_TIMEOUT_MS;
  if (!raw) return DEFAULT_REVIEW_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_REVIEW_TIMEOUT_MS;
}

/** ISH-883: the default reviewer model (an Opus-class reviewer), configurable. */
export const DEFAULT_REVIEW_MODEL = "opus";

/**
 * ISH-830e: the reviewer's permission ceiling. `auto` lets the CLI's own
 * classifier approve SAFE actions — e.g. a read-only `git diff` to see what
 * changed — without pre-approving every tool. It is deliberately NOT
 * `bypassPermissions` and NOT an all-tools allowlist, and it is FIXED (there is
 * no knob). This is an APPROVAL mode, not an OS sandbox: Relay does NOT claim it
 * prevents an uncommitted write. What actually holds for the reviewer is
 * independence (`recordReview`), a HEAD-bound verdict, and a disposable detached
 * review checkout where one is configured (`reviewWorktreeRoot`). The ISH-883
 * native-PR path keeps its explicit `allowedTools` allowlist (it must run `gh`).
 */
export const DEFAULT_REVIEW_PERMISSION_MODE = "auto";

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

/**
 * ISH-830e: the mechanical VERIFY result Relay ALREADY produced for the reviewed
 * HEAD. It is passed to the host reviewer as CONTEXT (with the raw check output
 * tail) so the reviewer can judge the change WITHOUT re-running the lab, and
 * without having to take the check's own word for it.
 */
export interface ReviewVerifyEvidence {
  head: string | null;
  outcome: string;
  checks: {
    name: string;
    command?: string;
    required?: boolean;
    outcome: string;
    exitCode: number | null;
    /** The command output (the brief includes a bounded tail). */
    output?: string;
  }[];
}

export interface ReviewerSpawnContext {
  cwd: string;
  /** The full review brief (also pinned at `.relay/review-brief.md`). */
  brief: string;
  env: Record<string, string>;
  timeoutMs: number;
  model?: string;
  /** ISH-883: the reviewer's tool allowlist (native-PR path only; must run `gh`). */
  allowedTools?: string;
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
  /**
   * ISH-829: an INDEPENDENT read-only checkout at the task head, used instead of
   * `task.worktree`. The coding writer never sees it (it is a detached worktree
   * at the fixed HEAD), so a review can never be credited for the writer's live
   * edits. Omitted -> the existing `task.worktree` path (old Herdr Reviewer).
   */
  reviewWorktree?: string;
  /**
   * ISH-830e: the mechanical VERIFY result for this attempt's HEAD. Rendered into
   * the brief as context so the host reviewer can judge the change without
   * re-running the lab. Omitted -> no VERIFY section (the reviewer sees only the
   * declared checks).
   */
  verifyEvidence?: ReviewVerifyEvidence;
  /**
   * ISH-883: post a NATIVE GitHub Pull Request Review and read it back. When
   * omitted (the default), the reviewer keeps the local structured-verdict path
   * and Relay performs no external write. When present, a valid verdict is only
   * recorded AFTER the posted review is read back and bound to the reviewed HEAD;
   * a missing/mismatched/unauthorized/failed post is REFUSED (fail closed).
   */
  nativeReview?: NativeReviewDeps;
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
  /** ISH-883: the verified native GitHub review, when native posting is enabled. */
  nativeReview: ReviewView | null;
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
export function buildReviewBrief(
  db: Database,
  task: Task,
  opts: { head: string; worktree: string; native?: { ref: PrRef; author: string }; verify?: ReviewVerifyEvidence }
): string {
  const checks = taskChecks(task);
  const findings = inheritFindingsForBrief(db, task);
  const lines: string[] = [
    `# Independent review — Task ${task.id} (attempt ${task.attempt})`,
    "",
    "You are an INDEPENDENT code reviewer. You did NOT write this change. Treat this",
    "checkout as READ-ONLY: do not modify the code, do not commit, push or merge.",
    ...(opts.native
      ? [
          "You MAY run `git`/`gh` in this DISPOSABLE checkout (never in the coding",
          "writer's tree) to POST one native GitHub Pull Request Review.",
        ]
      : []),
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
  if (opts.verify) {
    const v = opts.verify;
    lines.push(
      "",
      `## Mechanical VERIFY — ALREADY RUN at \`${v.head ?? opts.head}\` (context; do NOT re-run)`,
      "",
      "Relay ran the REQUIRED checks above at this exact HEAD. This is the RESULT,",
      "recorded before the review:",
      "",
      `Outcome: \`${v.outcome}\``
    );
    for (const c of v.checks) {
      const cmd = checks.find((k) => k.name === c.name)?.command;
      lines.push(
        `- ${c.name}${cmd ? ` (\`${cmd}\`)` : ""}: ${c.outcome}${c.exitCode === null ? "" : ` (exit ${c.exitCode})`}`
      );
      const tail = tailLines(c.output ?? "", 20);
      if (tail) lines.push(...tail.split("\n").map((l) => `    ${l}`));
    }
    lines.push(
      "",
      "Use this as EVIDENCE that the mechanical check passed at the reviewed HEAD; you",
      "are NOT asked to (and should not) re-run the lab yourself. Judge the CODE and",
      "the acceptance against the diff."
    );
  }
  if (findings.length > 0) {
    lines.push("", `## Prior findings @ attempt ${token(task)} (context — verify they are actually fixed)`);
    for (const f of findings) lines.push(`- ${f}`);
  }
  if (opts.native) {
    const { ref, author } = opts.native;
    lines.push(
      "",
      "## Native GitHub review (REQUIRED)",
      `Post ONE Pull Request Review on \`${ref.repo}#${ref.number}\` for the EXACT commit`,
      `\`${opts.head}\`, as a COMMENT review (\`gh pr review --comment\`, or`,
      `\`gh api --method POST repos/${ref.repo}/pulls/${ref.number}/reviews\`). Include`,
      "actionable inline `path:line` comments where you have concrete findings. The",
      "review BODY MUST be self-contained and contain ALL of:",
      "",
      "1. EXACTLY this marker (OK for pass, NG for fix, HOLD for blocked):",
      `   <!-- ishiul-review head=${opts.head} verdict=OK|NG|HOLD reviewer=${author} -->`,
      `2. a \`## Findings — attempt ${task.attempt}\` section with the SAME findings you`,
      "   return in the structured verdict (plain text: severity, path:line, message).",
      "   If there are none, write `No findings.` — do NOT leave it out.",
      `3. the one-line summary (so the attempt-${task.attempt} verdict is readable on GitHub).`,
      "",
      "GitHub readers cannot open Relay's local `.relay/` evidence files. Do NOT point at a",
      "local path: put the finding text in the review body (or a public URL).",
      `Post ONE review for THIS review attempt (attempt=${task.attempt}). If a review by`,
      "the same reviewer at this EXACT HEAD was already posted for THIS attempt, do NOT",
      "post another (check with `gh api repos/" + ref.repo + "/pulls/" + ref.number + "/reviews`).",
      "After a base retarget the SAME HEAD is re-reviewed at a new attempt — then post a",
      "fresh review. Do NOT post at another commit; do NOT approve or request changes (a",
      "COMMENT review is enough). Relay reads the ACTUAL GitHub review back — a missing,",
      "stale (before a base change), or non-COMMENTED review is refused."
    );
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

/** The last `n` lines of a check output, bounded (for the review brief). */
function tailLines(s: string, n: number): string {
  const t = s.replace(/\r/g, "").trimEnd();
  if (!t) return "";
  const all = t.split("\n");
  return all.slice(Math.max(0, all.length - n)).join("\n").slice(-4_000);
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
 *
 * ISH-904: the FIRST balanced `{…}` object carrying a `verdict` key wins. The old
 * "outermost {...}" span failed on a real Opus review that began with prose
 * ("Still reviewing: …") and then emitted a well-formed verdict object: the span
 * swallowed the surrounding prose and the paid review was discarded.
 */
export function extractReviewerVerdict(raw: string): ReviewerVerdict | null {
  return extractReviewerVerdictDetailed(raw).verdict;
}

/** A verdict plus WHY it could not be extracted (`null` when one was found). */
export interface ReviewerVerdictExtraction {
  verdict: ReviewerVerdict | null;
  error: string | null;
}

/**
 * ISH-904: the detailed form of `extractReviewerVerdict`. The error is carried
 * into the `REVIEW_NO_STRUCTURED_RESULT` refusal so an unparseable candidate
 * ("wrong JSON") is distinguishable from no JSON at all.
 */
export function extractReviewerVerdictDetailed(raw: string): ReviewerVerdictExtraction {
  return extractVerdictDetailed(raw, 0);
}

function extractVerdictDetailed(raw: string, depth: number): ReviewerVerdictExtraction {
  if (!raw || !raw.trim()) return { verdict: null, error: "reviewer produced no output" };
  if (depth > 3) return { verdict: null, error: "nested reviewer result is too deep to parse safely" };
  const errors: string[] = [];
  const see = (value: unknown): ReviewerVerdict | null => {
    if (!isRecord(value)) {
      errors.push("JSON value is not an object");
      return null;
    }
    if (typeof value.result === "string") {
      const inner = extractVerdictDetailed(value.result, depth + 1);
      if (inner.verdict) return inner.verdict;
      if (inner.error) errors.push(inner.error);
    }
    const v = normalizeVerdict(value);
    if (v) return v;
    if (Object.prototype.hasOwnProperty.call(value, "verdict")) {
      errors.push(`unknown verdict ${JSON.stringify(value.verdict)}`);
    } else if (typeof value.result !== "string") {
      errors.push("JSON object has no 'verdict' key");
    }
    return null;
  };

  const direct = tryJson(raw.trim());
  if (isRecord(direct)) {
    const v = see(direct);
    if (v) return { verdict: v, error: null };
  }
  // JSONL: the FIRST line carrying a verdict wins (document order).
  for (const line of raw.split("\n")) {
    const o = tryJson(line.trim());
    if (!isRecord(o)) continue;
    const v = see(o);
    if (v) return { verdict: v, error: null };
  }
  for (const m of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const inner = extractVerdictDetailed(m[1] ?? "", depth + 1);
    if (inner.verdict) return inner;
    if (inner.error) errors.push(inner.error);
  }
  // The FIRST balanced {...} object carrying a verdict key. Balanced (string and
  // escape aware), so braces inside a finding message cannot truncate it.
  for (const obj of balancedJsonObjects(raw)) {
    if (obj.error) {
      errors.push(`JSON parse error: ${obj.error}`);
      continue;
    }
    const v = see(obj.value);
    if (v) return { verdict: v, error: null };
  }
  const unique = [...new Set(errors)];
  return {
    verdict: null,
    error:
      unique.length > 0
        ? unique.slice(0, 3).join("; ")
        : "no JSON object carrying a 'verdict' key in the reviewer output",
  };
}

interface BalancedJsonObject {
  text: string;
  value: unknown;
  error: string | null;
}

/** Every balanced `{…}` span, in document order, with its JSON parse outcome. */
function balancedJsonObjects(raw: string): BalancedJsonObject[] {
  const out: BalancedJsonObject[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let j = i; j < raw.length; j++) {
      const ch = raw[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) continue; // unbalanced: no candidate
    const text = raw.slice(i, end + 1);
    let value: unknown;
    let error: string | null = null;
    try {
      value = JSON.parse(text);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    out.push({ text, value, error });
    i = end;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The real spawner
// ---------------------------------------------------------------------------

/**
 * The real reviewer: `claude -p --output-format json` with the brief on stdin.
 * With no explicit `allowedTools` allowlist the reviewer runs under
 * `--permission-mode auto` (ISH-830e) — the CLI's own classifier approves safe,
 * read-mostly actions. `auto` is a FIXED ceiling: this function never emits
 * `bypassPermissions` (there is no knob). The ISH-883 native-PR path still passes
 * its explicit `allowedTools` allowlist (it must run `gh`). Spawned in a NEW
 * process group so a timeout can kill the whole tree (a reviewer cannot stall the
 * Factory).
 */
export function buildReviewerArgs(ctx: Pick<ReviewerSpawnContext, "allowedTools" | "model">): string[] {
  const args = ["-p", "--output-format", "json"];
  if (ctx.allowedTools) {
    args.push("--allowedTools", ctx.allowedTools);
  } else {
    args.push("--permission-mode", DEFAULT_REVIEW_PERMISSION_MODE);
  }
  if (ctx.model) args.push("--model", ctx.model);
  return args;
}

export function bunReviewerSpawner(command = DEFAULT_REVIEW_COMMAND): ReviewerSpawner {
  return {
    async run(ctx) {
      const args = buildReviewerArgs(ctx);
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
// ISH-883: native GitHub Pull Request Review (reviewer posts, Relay reads back)
// ---------------------------------------------------------------------------

/** The marker verdict a structured verdict maps onto (the existing contract). */
export function markerVerdictFor(verdict: ReviewerVerdict["verdict"]): MarkerVerdict {
  return verdict === "pass" ? "OK" : verdict === "fix" ? "NG" : "HOLD";
}

/** The bound PR ref for a task (url, then repo+branch), or null when none. */
async function resolveBoundPr(task: Task, github?: GitHubReadOnly): Promise<PrRef | null> {
  const ref = parsePrUrl(task.pr_url, task.pr_repo);
  if (ref) return ref;
  if (github && task.pr_repo && task.branch) {
    return (await github.findPullRequestForBranch(task.pr_repo, task.branch))?.ref ?? null;
  }
  return null;
}

export interface NativeReviewOutcome {
  ok: boolean;
  review: ReviewView | null;
  error: string | null;
}

/**
 * Read the reviewer's native PR review BACK from GitHub and accept it only when
 * the reviewer's CURRENT word at the HEAD — the newest fresh `COMMENTED` review
 * authored by the expected GitHub identity, pinned to the EXACT reviewed HEAD,
 * posted AFTER any base-changed invalidation — carries the marker matching the
 * structured verdict, and the PR's CURRENT head is still that commit. A
 * missing/foreign/PENDING/DISMISSED/stale/moved-HEAD review, a newer review whose
 * verdict contradicts the structured one, or a failed read is `ok:false` — the
 * caller records NOTHING. Relay never trusts the reviewer's own URL/JSON.
 */
export async function verifyNativeReview(
  db: Database,
  task: Task,
  verdict: ReviewerVerdict,
  head: string,
  native: NativeReviewDeps
): Promise<NativeReviewOutcome> {
  const fail = (error: string): NativeReviewOutcome => ({ ok: false, review: null, error });
  const ref = await resolveBoundPr(task, native.github);
  if (!ref) return fail(`${REVIEW_NATIVE_NO_PR}: ${task.id} has no bound PR to read a native review from`);

  const marker = markerVerdictFor(verdict.verdict);
  const reviews = await native.reader.listReviews(ref);
  if (reviews === null) {
    return fail(`${REVIEW_NATIVE_UNVERIFIED}: could not read reviews for ${ref.repo}#${ref.number} (failed read)`);
  }
  // A base-branch retarget re-opens the review at the SAME HEAD (attempt+1). A
  // review posted before that invalidation judged the OLD base's diff, so it must
  // not be re-accepted (the same rule the marker path uses).
  const invalidatedAt = latestReviewInvalidationAt(db, task.id, head);
  // The reviewer's CURRENT word at this HEAD: the NEWEST fresh `COMMENTED` review
  // by the expected author, whatever its verdict. Only then is its marker checked
  // against the structured verdict — so a newer contradicting review is never
  // shadowed by an older matching one. A PENDING (never submitted) or
  // DISMISSED/APPROVED/CHANGES_REQUESTED review is never a valid verdict; the
  // brief allows a COMMENT only.
  const candidates = reviews.filter(
    (r) =>
      (r.author ?? "").toLowerCase() === native.author.toLowerCase() &&
      (r.state ?? "").toUpperCase() === "COMMENTED" &&
      headsMatch(r.headSha, head) &&
      markerAfterInvalidation({ createdAt: r.createdAt } as ReviewMarker, invalidatedAt)
  );
  // Prefer the NEWEST review. Unparseable timestamps sort last.
  const timeOf = (r: ReviewView): number => {
    const t = Date.parse(r.createdAt);
    return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
  };
  candidates.sort((a, b) => timeOf(b) - timeOf(a));
  const newest = candidates[0] ?? null;
  if (!newest) {
    return fail(
      `${REVIEW_NATIVE_MISSING}: no fresh COMMENTED '${native.author}' review at HEAD ${head} on ${ref.repo}#${ref.number}` +
        (invalidatedAt > 0 ? ` (reviews before the base-changed invalidation do not count)` : "")
    );
  }
  // The newest review IS the reviewer's current verdict at this HEAD. If it does
  // not carry the marker matching the structured verdict (a different verdict, or
  // no marker at all), the run is contradicted — refuse, never fall back to an
  // older review that happens to agree.
  if (!reviewBodyHasMarker(newest.body, head, marker)) {
    return fail(
      `${REVIEW_NATIVE_CONTRADICTED}: the newest '${native.author}' review at HEAD ${head} (id ${newest.id}) does not carry a ${marker} marker on ${ref.repo}#${ref.number}; refusing to accept an older review`
    );
  }
  const found = newest;
  // A moved PR HEAD invalidates the review even when the read-back review is
  // pinned: GitHub's CURRENT head must still be the reviewed commit.
  if (native.github) {
    const pr = await native.github.getPullRequest(ref);
    if (!pr) {
      return fail(`${REVIEW_NATIVE_UNVERIFIED}: could not re-read ${ref.repo}#${ref.number} to confirm the current HEAD`);
    }
    if (!headsMatch(pr.headSha, head)) {
      return fail(
        `${REVIEW_NATIVE_UNVERIFIED}: PR ${ref.repo}#${ref.number} moved to ${pr.headSha || "none"}, not the reviewed HEAD ${head}`
      );
    }
  }
  return { ok: true, review: found, error: null };
}

// ---------------------------------------------------------------------------
// Run one headless review
// ---------------------------------------------------------------------------

function refusal(
  error: string,
  task: Task,
  extra: Partial<HeadlessReviewResult> = {}
): HeadlessReviewResult {
  return { outcome: "refused", task, verdict: null, sessionId: null, error, evidenceRef: null, nativeReview: null, raw: "", ...extra };
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
  const worktree = deps.reviewWorktree ?? task.worktree;
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
  // ISH-904: a headless reviewer is registered `idle`, never `starting` — there is
  // no pane to attach, so a `starting` row was a permanent stuck-attach ATTENTION.
  ensureHeadlessWorker(db, reviewerWorker, { role: REVIEWER_ROLE, agentKind: HEADLESS_AGENT_KIND });
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

  // ISH-883: when native posting is enabled, the reviewer is told which PR to
  // post to; Relay reads the ACTUAL GitHub review back afterwards.
  const native = deps.nativeReview;
  const nativeRef = native ? await resolveBoundPr(task, native.github) : null;
  const brief = buildReviewBrief(db, task, {
    head,
    worktree,
    ...(native && nativeRef ? { native: { ref: nativeRef, author: native.author } } : {}),
    ...(deps.verifyEvidence ? { verify: deps.verifyEvidence } : {}),
  });
  pinReviewBrief(worktree, brief);
  logEvent(db, {
    source: "factory",
    taskId,
    type: "factory.review_started",
    payload: { head, attempt: task.attempt, reviewer: reviewerWorker, worktree, nativeReview: !!native },
  });

  const spawner = deps.spawner ?? bunReviewerSpawner(deps.command ?? DEFAULT_REVIEW_COMMAND);
  const proc = await spawner.run({
    cwd: worktree,
    brief,
    env: { ...(deps.env ?? {}), ...(native?.spawnEnv ?? {}) },
    timeoutMs: deps.timeoutMs ?? reviewTimeoutMs(),
    model: deps.model,
    ...(native?.allowedTools ? { allowedTools: native.allowedTools } : {}),
  });
  const raw = `${proc.stdout}\n${proc.stderr}`;
  // ISH-904: parse the FIRST balanced verdict object even when the reviewer
  // wrapped it in prose; keep the concrete parse error for the refusal reason.
  const stdoutParse = extractReviewerVerdictDetailed(proc.stdout);
  const stderrParse = stdoutParse.verdict ? { verdict: null, error: null } : extractReviewerVerdictDetailed(proc.stderr);
  const verdict = stdoutParse.verdict ?? stderrParse.verdict;
  const parseError = stdoutParse.error ?? stderrParse.error ?? "reviewer returned no structured verdict";

  // Retain the RAW reviewer output as evidence. ISH-829: this is written to a
  // DURABLE base — the Task's own worktree — never inside a temporary
  // `reviewWorktree` that the caller removes, so a recorded `evidence_ref` never
  // dangles. ISH-883: the verified native review (id/url/head), when posted, is
  // recorded alongside the structured verdict.
  const evidenceBase = task.worktree ?? worktree;
  const evidencePath = reviewEvidencePath(evidenceBase, task.attempt, head);
  const writeEvidence = (native: ReviewView | null): void => {
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
            native,
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
  };
  writeEvidence(null);

  // A FAILED reviewer process is not a verdict, even when its stdout happens to
  // contain a well-formed pass: the exit code / signal is authoritative for
  // PROCESS success, so a crash can never be mistaken for a review decision.
  if (proc.exitCode !== 0 || proc.signal !== null) {
    logEvent(db, {
      source: "factory",
      taskId,
      type: "factory.review_refused",
      payload: {
        reason: REVIEW_PROCESS_FAILED,
        head,
        exitCode: proc.exitCode,
        signal: proc.signal,
        evidence: evidencePath,
      },
    });
    return refusal(
      `${REVIEW_PROCESS_FAILED}: reviewer process exit ${proc.exitCode ?? "none"} signal ${proc.signal ?? "none"}`,
      task,
      { verdict, evidenceRef: evidencePath, raw }
    );
  }
  if (!verdict) {
    logEvent(db, {
      source: "factory",
      taskId,
      type: "factory.review_refused",
      payload: { reason: REVIEW_NO_STRUCTURED_RESULT, detail: parseError, head, exitCode: proc.exitCode, evidence: evidencePath },
    });
    return refusal(`${REVIEW_NO_STRUCTURED_RESULT}: ${parseError}`, task, { evidenceRef: evidencePath, raw });
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

  // The worktree HEAD was checked BEFORE the reviewer ran. Re-check AFTER it
  // returns (and that the live task is still review@head): a reviewer — or a
  // concurrent writer — that moved the worktree HEAD must never have its verdict
  // credited, even though `recordReview` only compares the DB `head_sha`.
  const postHead = gitHead(worktree);
  const liveReview = getTask(db, taskId);
  if (
    postHead !== head ||
    !liveReview ||
    liveReview.phase !== "review" ||
    liveReview.state !== "review" ||
    (liveReview.head_sha ?? null) !== head
  ) {
    logEvent(db, {
      source: "factory",
      taskId,
      type: "factory.review_refused",
      payload: {
        reason: REVIEW_HEAD_MISMATCH,
        head,
        worktreeHead: postHead,
        livePhase: liveReview?.phase ?? null,
        liveState: liveReview?.state ?? null,
        evidence: evidencePath,
      },
    });
    return refusal(
      `${REVIEW_HEAD_MISMATCH}: after the reviewer ran, worktree HEAD ${postHead ?? "none"} / task ${liveReview?.phase ?? "none"}@${liveReview?.head_sha ?? "none"} != review head ${head}`,
      task,
      { verdict, evidenceRef: evidencePath, raw }
    );
  }

  // ISH-883: when native review is enabled, the verdict is only ACCEPTED after
  // the ACTUAL GitHub review the reviewer posted is read back and bound to the
  // reviewed HEAD. A missing/mismatched/moved-HEAD/failed read is a refusal — the
  // Task never advances on the reviewer's own URL/JSON alone.
  let nativeReview: ReviewView | null = null;
  if (deps.nativeReview) {
    const nr = await verifyNativeReview(db, task, verdict, head, deps.nativeReview);
    if (!nr.ok) {
      logEvent(db, {
        source: "factory",
        taskId,
        type: "factory.native_review_refused",
        payload: { reason: nr.error, head, evidence: evidencePath },
      });
      writeEvidence(null);
      return refusal(nr.error ?? `${REVIEW_NATIVE_UNVERIFIED}: native review not verified`, task, {
        verdict,
        evidenceRef: evidencePath,
        raw,
      });
    }
    nativeReview = nr.review;
    writeEvidence(nativeReview);
    logEvent(db, {
      source: "factory",
      taskId,
      type: "factory.native_review_verified",
      payload: {
        id: nativeReview!.id,
        url: nativeReview!.url,
        author: nativeReview!.author,
        head,
        prNumber: nativeReview!.prNumber,
      },
    });
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
      nativeReview,
      raw,
    };
  } catch (e) {
    // ISH-904: a failed RESULT WRITE is not a review refusal. Rethrow it so the
    // Factory can park the Task blocked_internal instead of leaving the review
    // phase half-applied; the write itself already recorded the concrete error.
    if (isResultWriteError(e)) throw e;
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
