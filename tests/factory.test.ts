import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { blockTask, claimNext, claimTask, addTask, getTask } from "../src/tasks";
import { getWorker, registerWorker } from "../src/workers";
import { inboxFor } from "../src/messages";
import {
  findPassingReview,
  intakeTask,
  linkTask,
  recordReview,
  runMechanicalVerification,
  submitPhase,
  taskChecks,
} from "../src/workflow";
import { getTaskResult, insertTaskResult, RESULT_WRITE_ERROR } from "../src/results";
import { acceptRunSubmission, DUPLICATE_WRITER, listRuns, type DshProcess, type DshSpawner } from "../src/dsh-runner";
import { PINNED_DSH_VERSION } from "../src/dsh-version";
import { inheritFindings, launchTaskRun, taskBranchName } from "../src/run-lifecycle";
import { buildDashboardView } from "../src/dashboard/model";
import { defaultRunner, gitHead, type CommandRunner } from "../src/verify";
import { sandboxNameForTask, upsertSandbox, type SbxCli, type SbxResult } from "../src/sandbox";
import { ensureTaskSandbox, launchTaskSandboxRun, ensureSandboxRelayExcluded } from "../src/sandbox-lifecycle";
import { sandboxVerifyTarget, type SandboxExec } from "../src/sandbox-verify";
import { processPgid, spawnIdentityToken } from "../src/proc-identity";
import { DEFAULT_INTEGRATOR_WORKER, pidAlive, reviewBlockedReason, runFactoryTask, verifyChecksReason } from "../src/factory";
import type { GitHubReadOnly } from "../src/providers";
import {
  DEFAULT_REVIEWER_WORKER as REVIEWER_WORKER,
  REVIEW_NOT_INDEPENDENT,
  REVIEW_NO_STRUCTURED_RESULT,
  REVIEW_PROCESS_FAILED,
  buildReviewBrief,
  buildReviewerArgs,
  runHeadlessReview,
  extractReviewerVerdict,
  extractReviewerVerdictDetailed,
  type ReviewerProcess,
  type ReviewerSpawnContext,
  type ReviewerSpawner,
} from "../src/reviewer-runner";

// ISH-762: the Factory E2E. A REAL temp git repo + a FAKE headless dsh process
// (a shell script that commits, no network) + a FAKE reviewer spawner keep the
// whole implement -> VERIFY -> review(FIX) -> fresh Run -> VERIFY -> review(PASS)
// -> integration -> MergeReady loop deterministic.

let dir = "";
let repo = "";
let binDir = "";
let db: Database;
let issueSeq = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

function fakeDsh(name: string, body: string): string {
  const p = join(binDir, name);
  // ISH-869: the host runner probes `<dshBin> --version` before spawning; answer
  // with the pin so the factory tests exercise the Run loop, not the guard.
  writeFileSync(p, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${PINNED_DSH_VERSION}; exit 0; fi\n${body}`);
  chmodSync(p, 0o755);
  return p;
}

/** A coding Run that writes a NEW file per run id and commits it (a real change). */
const COMMITTING_DSH = `set -e
echo "[$RELAY_RUN_ID] implementing"
echo "$RELAY_RUN_ID" > "change-$RELAY_RUN_ID.txt"
git add -A
git -c user.email=relay@test -c user.name=relay commit -qm "change $RELAY_RUN_ID"
echo DONE
`;

/** A coding Run that exits 0 but commits NOTHING (no implementation). */
const NOOP_DSH = `echo DONE
`;

// ---------------------------------------------------------------------------
// ISH-878: fakes for the Sandbox IMPLEMENT/FIX path (no Docker, no sandbox).
// A fake `sbx` CLI + a fake `sbx exec … dsh` process + a real local git remote
// named `sandbox-<name>` so the host commit fetch and submit fence are exercised.
// ---------------------------------------------------------------------------

class FakeDshProcess implements DshProcess {
  private static seq = 0;
  readonly pid = 80_000 + FakeDshProcess.seq++;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number | null>;
  private outC!: ReadableStreamDefaultController<Uint8Array>;
  private errC!: ReadableStreamDefaultController<Uint8Array>;
  private resolveExit!: (c: number | null) => void;
  private settled = false;
  constructor() {
    this.stdout = new ReadableStream({ start: (c) => (this.outC = c) });
    this.stderr = new ReadableStream({ start: (c) => (this.errC = c) });
    this.exited = new Promise((res) => (this.resolveExit = res));
  }
  writeOut(s: string): void {
    this.outC.enqueue(new TextEncoder().encode(s));
  }
  finish(code: number | null): void {
    if (this.settled) return;
    this.settled = true;
    try { this.outC.close(); } catch { /* noop */ }
    try { this.errC.close(); } catch { /* noop */ }
    this.resolveExit(code);
  }
  kill(): void {
    this.finish(143);
  }
}

class FakeSandboxSpawner implements DshSpawner {
  procs: FakeDshProcess[] = [];
  onSpawn?: (p: FakeDshProcess) => void;
  spawn(): DshProcess {
    const p = new FakeDshProcess();
    this.procs.push(p);
    this.onSpawn?.(p);
    return p;
  }
}

/** A fake `sbx`: `exec` answers HEAD from `head()`, plus branch/probe/version. */
class FakeSbxCli implements SbxCli {
  created: string[] = [];
  currentBranch: string | null = "main";
  dshVersion = PINNED_DSH_VERSION;
  /** When true, `pgrep` reports the in-VM dsh ALIVE (and `pkill` does not stop it). */
  inVmDshAlive = false;
  constructor(private readonly head: () => string) {}
  run(args: string[]): SbxResult {
    const ok = (out = ""): SbxResult => ({ ok: true, code: 0, out, err: "" });
    if (args[0] === "ls") {
      return ok(JSON.stringify(this.created.map((name) => ({ name, agent: "shell", status: "running" }))));
    }
    if (args[0] === "create") {
      const i = args.indexOf("--name");
      const name = i >= 0 ? args[i + 1] : "?";
      if (!this.created.includes(name)) this.created.push(name);
      return ok("created");
    }
    if (args[0] === "exec") {
      const joined = args.join(" ");
      if (joined.includes("git checkout")) {
        const m = joined.match(/git checkout (?:-b )?([^\s;&|]+)/);
        if (m) this.currentBranch = m[1];
        return ok("");
      }
      if (joined.includes("rev-parse HEAD")) return ok(this.head());
      if (joined.includes("rev-parse --abbrev-ref HEAD")) return ok(this.currentBranch ?? "");
      if (joined.includes("--version")) return ok(this.dshVersion);
      if (joined.includes("pkill")) return ok("");
      if (joined.includes("pgrep")) return ok(this.inVmDshAlive ? "ALIVE" : "GONE");
      return ok("");
    }
    return ok("");
  }
}

/**
 * Simulate the sandbox clone's commit reaching the host: create a commit on
 * `branch`, push it (force) to a real bare repo, and register it as the host
 * remote `sandbox-<name>` that `git fetch` reads. Idempotent across attempts.
 */
function publishSandboxCommit(name: string, branch: string, marker: string): string {
  const producer = join(dir, `producer-${name}-${marker}`);
  mkdirSync(producer, { recursive: true });
  git(producer, "init", "-q", "-b", branch);
  git(producer, "config", "user.email", "sbx@test");
  git(producer, "config", "user.name", "sbx");
  writeFileSync(join(producer, "change.txt"), `${marker}\n`);
  git(producer, "add", "change.txt");
  git(producer, "commit", "-q", "-m", marker);
  const sha = git(producer, "rev-parse", "HEAD");
  const bare = join(dir, `bare-${name}.git`);
  if (!existsSync(bare)) git(producer, "init", "-q", "--bare", bare);
  git(producer, "remote", "add", "origin", bare);
  git(producer, "push", "-q", "--force", "origin", `${branch}:refs/heads/${branch}`);
  const remote = `sandbox-${name}`;
  if (git(repo, "remote").split("\n").includes(remote)) git(repo, "remote", "set-url", remote, bare);
  else git(repo, "remote", "add", remote, bare);
  return sha;
}

/** A fake `sbx exec` seam for VERIFY: HEAD tracks the task's recorded head. */
function sandboxVerifyExec(headOf: () => string | null): SandboxExec {
  return {
    async exec(_name, argv) {
      const j = argv.join(" ");
      if (j.includes("rev-parse HEAD")) return { code: 0, stdout: `${headOf()}\n`, stderr: "", timedOut: false };
      if (j.includes("--porcelain")) return { code: 0, stdout: "", stderr: "", timedOut: false };
      return { code: 0, stdout: "sbx-ran", stderr: "", timedOut: false };
    },
  };
}

type ReviewPlan =
  | "pass"
  | "fix"
  | "blocked"
  | "blockedempty"
  | "garbage"
  | "wronghead"
  | "envelope"
  | "exitfail"
  | "signal"
  | "mutatehead";

interface ReviewerHarness {
  spawner: ReviewerSpawner;
  calls: { cwd: string; head: string | null; plan: ReviewPlan; brief: string }[];
}

/** A deterministic fake reviewer; reads the live worktree HEAD itself. */
function reviewerHarness(plan: ReviewPlan[]): ReviewerHarness {
  const calls: ReviewerHarness["calls"] = [];
  const spawner: ReviewerSpawner = {
    async run(ctx: ReviewerSpawnContext): Promise<ReviewerProcess> {
      const head = gitHead(ctx.cwd);
      const p = plan[Math.min(calls.length, plan.length - 1)] ?? "pass";
      calls.push({ cwd: ctx.cwd, head, plan: p, brief: ctx.brief });
      let stdout: string;
      switch (p) {
        case "fix":
          stdout = JSON.stringify({
            verdict: "fix",
            head,
            findings: [{ severity: "blocker", file: "a.txt", line: 1, message: "needs the B marker" }],
            summary: "incomplete",
          });
          break;
        case "blocked":
          stdout = JSON.stringify({ verdict: "blocked", head, summary: "cannot judge" });
          break;
        case "blockedempty":
          // ISH-830e: the real reviewer can exit 0 with a structured `blocked`
          // verdict and an EMPTY summary (the observed ISH-830 symptom).
          stdout = JSON.stringify({ verdict: "blocked", head, findings: [], summary: "" });
          break;
        case "wronghead":
          stdout = JSON.stringify({ verdict: "pass", head: "0".repeat(40), summary: "x" });
          break;
        case "garbage":
          stdout = "I read it and it looks fine to me, no JSON.";
          break;
        case "envelope":
          stdout = JSON.stringify({
            type: "result",
            session_id: "fake-session-1",
            result: JSON.stringify({ verdict: "pass", head, summary: "ok via envelope" }),
          });
          break;
        case "exitfail":
          // A WELL-FORMED pass on stdout, but the reviewer process failed.
          stdout = JSON.stringify({ verdict: "pass", head, summary: "looks fine" });
          break;
        case "signal":
          stdout = JSON.stringify({ verdict: "pass", head, summary: "looks fine" });
          break;
        case "mutatehead": {
          // Commit to the worktree WHILE the reviewer runs, then name the OLD head.
          writeFileSync(join(ctx.cwd, "mutated-by-reviewer.txt"), "mutated\n");
          git(ctx.cwd, "add", "mutated-by-reviewer.txt");
          git(ctx.cwd, "commit", "-q", "-m", "reviewer moved the head");
          stdout = JSON.stringify({ verdict: "pass", head, summary: "ok for the head it saw" });
          break;
        }
        default:
          stdout = JSON.stringify({ verdict: "pass", head, summary: "looks correct" });
      }
      if (p === "exitfail") return { exitCode: 1, signal: null, stdout, stderr: "reviewer crashed" };
      if (p === "signal") return { exitCode: null, signal: "SIGKILL", stdout, stderr: "" };
      return { exitCode: 0, signal: null, stdout, stderr: "" };
    },
  };
  return { spawner, calls };
}

function newTask(
  extra: { checks?: { name: string; command: string; required?: boolean; timeoutMs?: number }[]; title?: string } = {}
) {
  return intakeTask(db, {
    provider: "test",
    issueId: `ISH-762-${issueSeq++}`,
    codeChange: true,
    title: extra.title ?? "implement the marker file",
    checks: extra.checks ?? [{ name: "noop", command: "true" }],
  }).id;
}

/** Drive a task to the REVIEW phase by hand (launch -> submit -> mechanical verify). */
async function driveToReview(id: string, dshBin: string): Promise<string> {
  const launched = await launchTaskRun(db, id, {
    repo,
    worktreesRoot: join(dir, "worktrees"),
    outputRoot: join(dir, "runs"),
    dshBin,
    fastExitMs: 0,
  });
  const run = await launched.handle.wait();
  acceptRunSubmission(db, { runId: run.id });
  const v = await runMechanicalVerification(db, id, {
    checks: taskChecks(getTask(db, id)!),
    runner: defaultRunner,
    cwd: launched.worktree,
  });
  expect(v.outcome).toBe("pass");
  return getTask(db, id)!.head_sha!;
}

const factoryDeps = (dshBin: string, reviewer?: ReviewerSpawner) => ({
  repo,
  worktreesRoot: join(dir, "worktrees"),
  outputRoot: join(dir, "runs"),
  dshBin,
  fastExitMs: 0,
  reviewerSpawner: reviewer,
  mergeGateDeps: {},
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-ish762-"));
  repo = join(dir, "repo");
  binDir = join(dir, "bin");
  mkdirSync(repo, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "relay@test");
  git(repo, "config", "user.name", "relay-test");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "base");
  process.env.RELAY_DB = join(dir, "state.db");
  db = openDb(process.env.RELAY_DB);
  issueSeq = 0;
  delete process.env.RELAY_HUMAN;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.RELAY_HUMAN;
});

describe("ISH-830e: the reviewer runs under `auto`, never bypass/all-tools", () => {
  test("the default reviewer args use --permission-mode auto and no allowlist", () => {
    const args = buildReviewerArgs({});
    expect(args).toEqual(["-p", "--output-format", "json", "--permission-mode", "auto"]);
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("bypassPermissions");
    expect(buildReviewerArgs({ model: "opus" })).toContain("opus");
  });

  test("an explicit allowlist (the ISH-883 native path) is preserved and needs no permission mode", () => {
    const args = buildReviewerArgs({ allowedTools: "Read Grep Glob Bash" });
    expect(args).toContain("--allowedTools");
    expect(args).toContain("Read Grep Glob Bash");
    expect(args).not.toContain("--permission-mode");
  });

  test("bypassPermissions can NEVER be emitted, even if a caller smuggles the removed field", () => {
    // The field is gone from `ReviewerSpawnContext`; cast past the type to prove
    // the ceiling is structural, not just documented.
    const smuggle = { permissionMode: "bypassPermissions" } as unknown as Parameters<typeof buildReviewerArgs>[0];
    expect(buildReviewerArgs(smuggle)).toEqual(["-p", "--output-format", "json", "--permission-mode", "auto"]);
    expect(buildReviewerArgs(smuggle).join(" ")).not.toContain("bypassPermissions");
    const withAllowlist = {
      allowedTools: "Read Grep Glob Bash",
      permissionMode: "bypassPermissions",
    } as unknown as Parameters<typeof buildReviewerArgs>[0];
    expect(buildReviewerArgs(withAllowlist).join(" ")).not.toContain("bypassPermissions");
    expect(buildReviewerArgs(withAllowlist)).not.toContain("--permission-mode");
  });
});

describe("reviewBlockedReason (ISH-830e: a blocked review is never an empty reason)", () => {
  test("prefers the reviewer summary, then findings, then a precise description", () => {
    expect(
      reviewBlockedReason({ verdict: { verdict: "blocked", head: null, findings: [], summary: "cannot judge" }, evidenceRef: null })
    ).toBe("cannot judge");
    expect(
      reviewBlockedReason({
        verdict: {
          verdict: "blocked",
          head: null,
          findings: [{ severity: "blocker", file: "a.ts", line: 3, message: "unresolved" }],
          summary: "",
        },
        evidenceRef: null,
      })
    ).toContain("[blocker] a.ts:3: unresolved");
    const empty = reviewBlockedReason({
      verdict: { verdict: "blocked", head: null, findings: [], summary: "" },
      evidenceRef: "/tmp/T1/review/attempt-1-abc.json",
    });
    expect(empty.length).toBeGreaterThan(0);
    expect(empty).toContain("review blocked");
    expect(empty).toContain("no summary or findings");
    expect(empty).toContain("/tmp/T1/review/attempt-1-abc.json");
    expect(reviewBlockedReason({ verdict: null, evidenceRef: null })).toContain("no structured verdict");
  });
});

describe("buildReviewBrief (ISH-830e: sandbox VERIFY evidence is in the brief)", () => {
  test("renders the ALREADY-RUN verify result with the check output tail, and says not to re-run", () => {
    const id = newTask();
    const task = getTask(db, id)!;
    const brief = buildReviewBrief(db, task, {
      head: "a".repeat(40),
      worktree: "/tmp/review-wt",
      verify: {
        head: "a".repeat(40),
        outcome: "pass",
        checks: [
          {
            name: "noop",
            outcome: "pass",
            exitCode: 0,
            output: "line one\nNOS_CHECK_DONE\n",
          },
        ],
      },
    });
    expect(brief).toContain("## Mechanical VERIFY — ALREADY RUN");
    expect(brief).toContain("Outcome: `pass`");
    expect(brief).toContain("- noop (`true`): pass (exit 0)");
    expect(brief).toContain("NOS_CHECK_DONE");
    expect(brief).toContain("do NOT re-run");
    // No verify evidence -> no VERIFY section (backward compatible).
    expect(buildReviewBrief(db, task, { head: "a".repeat(40), worktree: "/tmp/review-wt" })).not.toContain(
      "## Mechanical VERIFY"
    );
  });
});

describe("ISH-830e: VERIFY block reason + sandbox .relay exclusion", () => {
  test("verifyChecksReason names the check, its outcome, and an output tail", () => {
    const s = verifyChecksReason([
      { name: "srl-nos-readback", outcome: "not_run", exitCode: null, output: "sandbox working tree is dirty before the check" },
    ]);
    expect(s).toContain("srl-nos-readback=not_run");
    expect(s).toContain("dirty");
    expect(verifyChecksReason([])).toBe("no checks executed");
  });

  test("ensureSandboxRelayExcluded adds .relay/ to the clone's git info/exclude", () => {
    const calls: string[][] = [];
    const cli = {
      run: (args: string[]) => {
        calls.push(args);
        return { ok: true, code: 0, out: "", err: "" };
      },
    } as unknown as SbxCli;
    ensureSandboxRelayExcluded(cli, "sbx-1", "/in-vm/repo");
    const joined = calls.map((a) => a.join(" ")).join("\n");
    expect(joined).toContain("git rev-parse --path-format=absolute --git-common-dir");
    expect(joined).toContain("info/exclude");
    expect(joined).toContain(".relay/");
    expect(joined).toContain("sbx-1");
  });
});

describe("extractReviewerVerdict (fail-closed parsing)", () => {
  test("parses a bare verdict object", () => {
    expect(extractReviewerVerdict('{"verdict":"pass","head":"abc","summary":"ok"}')).toEqual({
      verdict: "pass",
      head: "abc",
      findings: [],
      summary: "ok",
    });
  });
  test("parses the claude --output-format json envelope", () => {
    const envelope = JSON.stringify({ type: "result", result: '{"verdict":"fix","head":"h","findings":["x"]}' });
    expect(extractReviewerVerdict(envelope)?.verdict).toBe("fix");
    expect(extractReviewerVerdict(envelope)?.findings[0].message).toBe("x");
  });
  test("parses a JSONL stream and a fenced block", () => {
    expect(extractReviewerVerdict('{"type":"status"}\n{"verdict":"blocked","summary":"s"}')?.verdict).toBe("blocked");
    expect(extractReviewerVerdict('prose\n```json\n{"verdict":"pass","head":"h"}\n```')?.verdict).toBe("pass");
  });
  test("returns null when there is no structured verdict", () => {
    expect(extractReviewerVerdict("looks fine to me")).toBeNull();
    expect(extractReviewerVerdict("")).toBeNull();
    expect(extractReviewerVerdict('{"nope":1}')).toBeNull();
  });
  test("ISH-904: parses the FIRST balanced verdict object even when wrapped in prose", () => {
    // The real Opus output that was discarded: prose, then a well-formed verdict,
    // then more prose. Braces inside a finding string must not truncate it.
    const raw =
      "Still reviewing: the diff is small, one finding.\n\n" +
      '{"verdict":"fix","head":"abc","findings":[{"severity":"major","file":"a.ts","message":"a } brace in text"}],"summary":"needs work"}' +
      "\n\nThanks for the context.";
    const v = extractReviewerVerdict(raw);
    expect(v?.verdict).toBe("fix");
    expect(v?.head).toBe("abc");
    expect(v?.findings[0].message).toBe("a } brace in text");

    // An envelope whose result carries prose + a verdict is parsed too.
    const envelope = JSON.stringify({
      type: "result",
      result: 'Still reviewing...\n{"verdict":"pass","head":"h","summary":"ok"}',
    });
    expect(extractReviewerVerdict(envelope)?.verdict).toBe("pass");
    // The FIRST balanced verdict object wins, in document order.
    expect(extractReviewerVerdict('{"verdict":"fix"}\n{"verdict":"pass"}')?.verdict).toBe("fix");
  });
  test("ISH-904: 'no JSON' and 'wrong JSON' are distinguishable in the extraction error", () => {
    const none = extractReviewerVerdictDetailed("looks fine to me, no JSON here");
    expect(none.verdict).toBeNull();
    expect(none.error).toContain("no JSON object");

    const wrong = extractReviewerVerdictDetailed('Still reviewing\n{"verdict":"fix",,}');
    expect(wrong.verdict).toBeNull();
    expect(wrong.error).toContain("JSON parse error");

    const noVerdict = extractReviewerVerdictDetailed('{"type":"status","message":"working"}');
    expect(noVerdict.verdict).toBeNull();
    expect(noVerdict.error).toContain("no 'verdict' key");
  });
});

describe("Factory E2E: real worktree, fake headless dsh + independent reviewer", () => {
  test("implement -> VERIFY -> review FIX -> fresh dsh FIX -> VERIFY -> review PASS -> MergeReady", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const rev = reviewerHarness(["fix", "pass"]);
    const res = await runFactoryTask(db, id, factoryDeps(dsh, rev.spawner));

    expect(res.outcome).toBe("merge_ready");
    const task = getTask(db, id)!;
    expect(task.phase).toBe("merge_ready");
    expect(task.state).toBe("queued");
    expect(task.merged_at).toBeNull(); // MergeReady is READ-ONLY: NOT merged
    expect(task.accepted_at).toBeNull(); // NOT Linear Done / accepted

    // Two coding attempts, two reviews, same worktree.
    expect(res.attempts.map((a) => a.reviewVerdict)).toEqual(["fix", "pass"]);
    expect(res.attempts.map((a) => a.verifyOutcome)).toEqual(["pass", "pass"]);
    // ISH-830e: the host reviewer is handed the mechanical VERIFY result as
    // context (it never sees the sandbox where the checks ran).
    expect(rev.calls[0].brief).toContain("## Mechanical VERIFY — ALREADY RUN");
    expect(rev.calls[0].brief).toContain("Outcome: `pass`");
    const runs = listRuns(db, { taskId: id });
    expect(runs).toHaveLength(2);
    expect(runs[0].state).toBe("submitted");
    expect(runs[1].state).toBe("submitted");
    expect(runs[0].id).not.toBe(runs[1].id);

    // The FIX reused the SAME worktree + inherited the prior finding.
    expect(rev.calls).toHaveLength(2);
    expect(rev.calls[0].cwd).toBe(rev.calls[1].cwd);
    expect(readFileSync(join(rev.calls[1].cwd, ".relay", "run-brief.md"), "utf-8")).toContain("needs the B marker");

    // A read-only merge gate was evaluated (never merged).
    expect(res.gate).not.toBeNull();
  });

  test("ISH-830e: a resumed Factory (Task already in review) still carries the durable VERIFY evidence", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    // Drive the Task to `review` in a PRIOR process: launch -> submit -> verify.
    // The VERIFY result is durable (a VerificationResult row); this new
    // `runFactoryTask` call has NO in-process memory of the verify step.
    const head = await driveToReview(id, dsh);
    const rev = reviewerHarness(["pass"]);
    const res = await runFactoryTask(db, id, factoryDeps(dsh, rev.spawner));
    expect(res.outcome).toBe("merge_ready");
    expect(rev.calls).toHaveLength(1);
    expect(rev.calls[0].head).toBe(head);
    // The brief still has the Mechanical VERIFY section, read from the row.
    expect(rev.calls[0].brief).toContain("## Mechanical VERIFY — ALREADY RUN");
    expect(rev.calls[0].brief).toContain("Outcome: `pass`");
  });

  test("ISH-878: a Sandbox-backed Task IMPLEMENTs + FIXes INSIDE the Sandbox (never the host)", async () => {
    const dsh = fakeDsh("dsh-sbx", COMMITTING_DSH);
    const id = newTask();
    const task0 = getTask(db, id)!;
    const sbxName = sandboxNameForTask(task0);
    const branch = taskBranchName(task0);
    const baseSha = git(repo, "rev-parse", "HEAD");
    // The clone HEAD tracks the Task's recorded head; attempt 0 has none yet.
    const sbx = new FakeSbxCli(() => getTask(db, id)!.head_sha ?? baseSha);
    const spawner = new FakeSandboxSpawner();
    let published = 0;
    spawner.onSpawn = (p) => {
      // The in-VM dsh committed a NEW revision: publish it so `git fetch` finds it.
      publishSandboxCommit(sbxName, branch, `sbx-change-${++published}`);
      p.writeOut(JSON.stringify({ type: "session", sessionId: `sbx-${published}` }) + "\n");
      p.writeOut(JSON.stringify({ type: "final", text: "done" }) + "\n");
      p.finish(0);
    };
    // The Task must already have a DURABLE Coding Sandbox binding (as created by
    // `relay run sandbox create`); that binding is what selects the Sandbox path.
    await ensureTaskSandbox(db, id, { source: repo, cli: sbx });
    const rev = reviewerHarness(["fix", "pass"]);
    let hostCalls = 0;
    const hostSpy: CommandRunner = {
      async run(s) {
        hostCalls++;
        return { name: s.name, required: true, outcome: "pass", exitCode: 0, output: "host", durationMs: 0 };
      },
    };
    const res = await runFactoryTask(db, id, {
      ...factoryDeps(dsh, rev.spawner),
      reviewWorktreeRoot: join(dir, "review-wt"),
      sandboxCli: sbx,
      sandboxSpawner: spawner,
      verifyRunner: hostSpy,
      verifyTarget: (d, t, checks) =>
        sandboxVerifyTarget(d, t, checks, { exec: sandboxVerifyExec(() => getTask(db, id)!.head_sha), headProbe: () => getTask(db, id)!.head_sha }),
    });

    expect(res.outcome).toBe("merge_ready");
    expect(res.attempts.map((a) => a.reviewVerdict)).toEqual(["fix", "pass"]);
    expect(res.attempts.map((a) => a.verifyOutcome)).toEqual(["pass", "pass"]);
    // VERIFY ran INSIDE the sandbox: the host runner was NEVER reached.
    expect(hostCalls).toBe(0);

    // Two Runs, BOTH inside the SAME durable Sandbox — and NO host-worktree Run.
    const runs = listRuns(db, { taskId: id });
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.sandbox_name)).toEqual([sbxName, sbxName]);
    const run0 = runs.find((r) => r.attempt === 0)!;
    const run1 = runs.find((r) => r.attempt === 1)!;
    expect(run0).toBeTruthy();
    expect(run1).toBeTruthy();
    expect(run0.id).not.toBe(run1.id);
    expect(run0.base_head_sha).toBe(baseSha);
    expect(sbx.created.filter((n) => n === sbxName)).toHaveLength(1); // created ONCE; FIX reused it
    expect(getTask(db, id)!.worktree).toBeNull(); // never a host worktree

    // The FIX is a fresh Run on the SAME sandbox with the prior finding inherited.
    const brief = readFileSync(run1.spec_path!, "utf-8");
    expect(brief).toContain("needs the B marker");

    // The reviewer's raw evidence is DURABLE (not inside the removed review worktree).
    const row = db
      .query(`SELECT evidence_ref FROM task_results WHERE task_id = ? AND kind = 'ReviewResult' ORDER BY id DESC LIMIT 1`)
      .get(id) as { evidence_ref: string | null } | null;
    expect(row?.evidence_ref).toBeTruthy();
    expect(existsSync(row!.evidence_ref!)).toBe(true);
  });

  test("ISH-878: a removed/failed Coding Sandbox FAILS CLOSED (never a host fallback)", async () => {
    const dsh = fakeDsh("dsh-refuse", COMMITTING_DSH);
    for (const state of ["failed", "removed"] as const) {
      const id = newTask();
      upsertSandbox(db, {
        taskId: id,
        name: `relay-ish878-${state}`,
        agent: "shell",
        source: repo,
        workspace: "/in-vm/repo",
        branch: "relay/ish-878",
        headSha: null,
        state,
      });
      const res = await runFactoryTask(db, id, factoryDeps(dsh, reviewerHarness(["pass"]).spawner));
      expect(res.outcome).toBe("coding_failed");
      expect(res.reason).toContain("SANDBOX_ERROR");
      expect(res.reason).toContain("refusing to fall back to the host worktree");
      // NOTHING was launched — no host Run, no sandbox Run, no worktree.
      expect(listRuns(db, { taskId: id })).toHaveLength(0);
      expect(getTask(db, id)!.worktree).toBeNull();
      expect(getTask(db, id)!.phase).toBe("implement");
    }
  });

  test("ISH-878: re-entry ADOPTS the live Sandbox Run and resolves the orphan (no duplicate writer)", async () => {
    const id = newTask();
    const sbx = new FakeSbxCli(() => git(repo, "rev-parse", "HEAD"));
    const spawner = new FakeSandboxSpawner();
    // A live in-VM Run whose process never finishes (the host owner then dies).
    spawner.onSpawn = (p) => p.writeOut(JSON.stringify({ type: "session", sessionId: "live" }) + "\n");
    const live = await launchTaskSandboxRun(db, id, {
      source: repo,
      cli: sbx,
      spawner,
      outputRoot: join(dir, "runs"),
      fastExitMs: 0,
    });
    expect(live.run.sandbox_name).toBe(sandboxNameForTask(getTask(db, id)!));
    expect(spawner.procs).toHaveLength(1);
    // Prove the recorded host client is GONE, deterministically (a dead pid, so
    // the fake pid can never collide with a real live host process).
    const dead = Bun.spawnSync(["true"]);
    db.query(`UPDATE runs SET pid = ?, spawn_lstart = NULL WHERE id = ?`).run(dead.pid ?? 999999, live.handle.id);

    const res = await runFactoryTask(db, id, {
      ...factoryDeps(fakeDsh("dsh-x", COMMITTING_DSH), reviewerHarness(["pass"]).spawner),
      sandboxCli: sbx,
      sandboxSpawner: spawner,
    });
    // Adoption (NOT a fresh launch) resolved the orphan: the host `sbx exec`
    // client is gone and the in-VM dsh is confirmed GONE, so the Run is terminal
    // `failed` — and a SECOND dsh was NEVER spawned into the same sandbox.
    expect(res.outcome).toBe("coding_failed");
    expect(res.reason).toContain("orphaned sandbox run");
    const runs = listRuns(db, { taskId: id });
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(live.handle.id);
    expect(runs[0].state).toBe("failed");
    expect(spawner.procs).toHaveLength(1);
  });

  test("ISH-878: an adopted Run whose in-VM dsh SURVIVES keeps the single-writer fence", async () => {
    const id = newTask();
    const sbx = new FakeSbxCli(() => git(repo, "rev-parse", "HEAD"));
    sbx.inVmDshAlive = true; // `pgrep` says ALIVE before AND after `pkill`
    const spawner = new FakeSandboxSpawner();
    spawner.onSpawn = (p) => p.writeOut(JSON.stringify({ type: "session", sessionId: "stubborn" }) + "\n");
    const live = await launchTaskSandboxRun(db, id, {
      source: repo,
      cli: sbx,
      spawner,
      outputRoot: join(dir, "runs"),
      fastExitMs: 0,
    });
    // A dead client pid (deterministic) with the in-VM dsh still ALIVE.
    const dead = Bun.spawnSync(["true"]);
    db.query(`UPDATE runs SET pid = ?, spawn_lstart = NULL WHERE id = ?`).run(dead.pid ?? 999999, live.handle.id);

    const res = await runFactoryTask(db, id, {
      ...factoryDeps(fakeDsh("dsh-x", COMMITTING_DSH), reviewerHarness(["pass"]).spawner),
      sandboxCli: sbx,
      sandboxSpawner: spawner,
    });
    // The sweep could NOT confirm the in-VM dsh gone: the Run must stay
    // NON-TERMINAL so the fence keeps holding, and no second writer is admitted.
    expect(res.outcome).toBe("coding_failed");
    expect(res.reason).toContain("still holds the single-writer fence");
    const runs = listRuns(db, { taskId: id });
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(live.handle.id);
    expect(runs[0].state).toBe("running");
    expect(spawner.procs).toHaveLength(1);
  });

  test("ISH-878: an adopted Run with a LIVE client is bounded by its budget (fence held)", async () => {
    const id = newTask();
    const sbx = new FakeSbxCli(() => git(repo, "rev-parse", "HEAD"));
    const spawner = new FakeSandboxSpawner();
    spawner.onSpawn = (p) => p.writeOut(JSON.stringify({ type: "session", sessionId: "alive" }) + "\n");
    const live = await launchTaskSandboxRun(db, id, {
      source: repo,
      cli: sbx,
      spawner,
      outputRoot: join(dir, "runs"),
      fastExitMs: 0,
    });
    // Make the recorded client pid provably ALIVE: this very process, with its
    // own canonical start token, so `hostSandboxClientAlive` returns true.
    db.query(`UPDATE runs SET pid = ?, spawn_lstart = ? WHERE id = ?`).run(
      process.pid,
      spawnIdentityToken(process.pid),
      live.handle.id
    );

    const res = await runFactoryTask(db, id, {
      ...factoryDeps(fakeDsh("dsh-x", COMMITTING_DSH), reviewerHarness(["pass"]).spawner),
      sandboxCli: sbx,
      sandboxSpawner: spawner,
      timeoutMs: 300,
    });
    // The live client never finished: the bounded wait times out and the fence
    // is held (the Run is left for the operator `relay run sandbox sweep`).
    expect(res.outcome).toBe("coding_failed");
    expect(res.reason).toContain("exceeded its 300ms budget");
    const runs = listRuns(db, { taskId: id });
    expect(runs).toHaveLength(1);
    expect(runs[0].state).toBe("running");
    expect(spawner.procs).toHaveLength(1);
  });

  test("ISH-878: a Task with NO sandbox row still uses the host worktree path", async () => {
    const dsh = fakeDsh("dsh-legacy", COMMITTING_DSH);
    const id = newTask();
    const res = await runFactoryTask(db, id, factoryDeps(dsh, reviewerHarness(["pass"]).spawner));
    expect(res.outcome).toBe("merge_ready");
    const runs = listRuns(db, { taskId: id });
    expect(runs).toHaveLength(1);
    expect(runs[0].sandbox_name).toBeNull();
    expect(getTask(db, id)!.worktree).not.toBeNull();
  });

  test("ISH-829: the independent reviewer reads a detached read-only worktree at the fixed head", async () => {
    const dsh = fakeDsh("dsh-ro", COMMITTING_DSH);
    const id = newTask();
    const rev = reviewerHarness(["pass"]);
    const roRoot = join(dir, "review-wt");
    const res = await runFactoryTask(db, id, { ...factoryDeps(dsh, rev.spawner), reviewWorktreeRoot: roRoot });
    expect(res.outcome).toBe("merge_ready");
    expect(rev.calls).toHaveLength(1);
    const cwd = rev.calls[0].cwd;
    // The reviewer read a DETACHED worktree under the review root, not the writer's.
    expect(cwd.startsWith(roRoot)).toBe(true);
    const task = getTask(db, id)!;
    expect(rev.calls[0].head).toBe(task.head_sha);
    // The read-only worktree is torn down after the review.
    expect(existsSync(cwd)).toBe(false);
    // ISH-829 finding 5: the recorded evidence_ref is DURABLE — it does NOT live
    // in the removed review worktree, so it still exists.
    const row = db
      .query(`SELECT evidence_ref FROM task_results WHERE task_id = ? AND kind = 'ReviewResult' ORDER BY id DESC LIMIT 1`)
      .get(id) as { evidence_ref: string | null } | null;
    expect(row?.evidence_ref).toBeTruthy();
    expect(existsSync(row!.evidence_ref!)).toBe(true);
    expect(row!.evidence_ref!.startsWith(cwd)).toBe(false);
  });

  test("a coding Run that exits nonzero canNOT advance (exit 0/final is not a submission)", async () => {
    const dsh = fakeDsh("dsh-fail", "exit 1\n");
    const id = newTask();
    const rev = reviewerHarness(["pass"]);
    const res = await runFactoryTask(db, id, factoryDeps(dsh, rev.spawner));
    expect(res.outcome).toBe("coding_failed");
    const task = getTask(db, id)!;
    expect(task.phase).toBe("implement");
    expect(task.head_sha).toBeNull();
    expect(rev.calls).toHaveLength(0);
  });

  test("a coding Run that exits 0 but commits nothing is NO_IMPLEMENTATION", async () => {
    const dsh = fakeDsh("dsh-noop", NOOP_DSH);
    const id = newTask();
    const rev = reviewerHarness(["pass"]);
    const res = await runFactoryTask(db, id, factoryDeps(dsh, rev.spawner));
    expect(res.outcome).toBe("no_implementation");
    expect(getTask(db, id)!.phase).toBe("implement");
  });

  test("a REQUIRED check that cannot run BLOCKS (never PASS)", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask({ checks: [{ name: "hang", command: "sleep 5", timeoutMs: 80 }] });
    const rev = reviewerHarness(["pass"]);
    const res = await runFactoryTask(db, id, factoryDeps(dsh, rev.spawner));
    expect(res.outcome).toBe("blocked");
    expect(res.reason).toContain("not_run");
    // ISH-830e: the reason now NAMES the fence/check (not a bare "verify not_run").
    expect(res.reason).toContain("hang=not_run");
    expect(getTask(db, id)!.state).toBe("blocked_human");
    expect(rev.calls).toHaveLength(0);
  });

  test("a reviewer with NO structured result is REFUSED (no advance)", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const rev = reviewerHarness(["garbage"]);
    const res = await runFactoryTask(db, id, factoryDeps(dsh, rev.spawner));
    expect(res.outcome).toBe("review_refused");
    expect(res.reason).toContain(REVIEW_NO_STRUCTURED_RESULT);
    // ISH-904: the refusal carries the parse diagnostic ("no JSON" vs "wrong JSON").
    expect(res.reason).toContain("no JSON object");
    expect(getTask(db, id)!.phase).toBe("review");
  });

  test("an old/foreign HEAD verdict is REFUSED (old HEAD cannot advance)", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const rev = reviewerHarness(["wronghead"]);
    const res = await runFactoryTask(db, id, factoryDeps(dsh, rev.spawner));
    expect(res.outcome).toBe("review_refused");
    expect(res.reason).toContain("HEAD_MISMATCH");
    expect(getTask(db, id)!.phase).toBe("review");
  });

  test("the envelope form (claude --output-format json) is accepted", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const rev = reviewerHarness(["envelope"]);
    const res = await runFactoryTask(db, id, factoryDeps(dsh, rev.spawner));
    expect(res.outcome).toBe("merge_ready");
  });

  test("re-entry adopts an already-live implement Run (no duplicate running work)", async () => {
    const slow = fakeDsh("dsh-slow", "sleep 1\nexit 0\n");
    const id = newTask();
    const live = await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: slow });
    // A second factory invocation must NOT start a second writer for the same worktree.
    const rev = reviewerHarness(["pass"]);
    const res = await runFactoryTask(db, id, factoryDeps(fakeDsh("dsh-commit", COMMITTING_DSH), rev.spawner));
    // The live Run exited 0 but produced no commit -> NO_IMPLEMENTATION, and only ONE run exists.
    expect(res.outcome).toBe("no_implementation");
    const runs = listRuns(db, { taskId: id });
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(live.handle.id);
  });

  test("the same-worktree single-writer exclusion refuses a parallel launch", async () => {
    const slow = fakeDsh("dsh-slow", "sleep 1\nexit 0\n");
    const fast = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const live = await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: slow });
    let refused = false;
    try {
      await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: fast });
    } catch (e) {
      refused = new RegExp(DUPLICATE_WRITER).test(String(e));
    }
    expect(refused).toBe(true);
    await live.handle.wait();
  });

  test("distinct worktrees run in parallel", async () => {
    const slow = fakeDsh("dsh-slow", "sleep 1\nexit 0\n");
    const a = newTask();
    const b = newTask();
    const ra = await launchTaskRun(db, a, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: slow });
    const rb = await launchTaskRun(db, b, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: slow });
    expect(ra.worktree).not.toBe(rb.worktree);
    await ra.handle.wait();
    await rb.handle.wait();
  });

  test("an integration submission at an UNREVIEWED new head is sent BACK to review", async () => {
    // The Factory reaches merge_ready ONLY at the reviewed head; a moved head at
    // integration invalidates the review and re-enters review (never merge_ready).
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const rev = reviewerHarness(["pass"]);
    await runFactoryTask(db, id, { ...factoryDeps(dsh, rev.spawner), maxAttempts: 1 });
    const task = getTask(db, id)!;
    expect(task.phase).toBe("merge_ready");
    const reviewedHead = task.head_sha!;
    // A PASS naming any head other than the current one is refused (old HEAD).
    const bogus = "1".repeat(40);
    registerWorker(db, REVIEWER_WORKER, { role: "reviewer" });
    db.query(`UPDATE tasks SET phase='review', state='review', claim_role='reviewer', attempt=attempt+1, assignee=? WHERE id=?`).run(
      REVIEWER_WORKER,
      id
    );
    expect(() => recordReview(db, id, REVIEWER_WORKER, { verdict: "pass", headSha: bogus })).toThrow();
    expect(getTask(db, id)!.head_sha).toBe(reviewedHead);
  });
});

describe("ISH-904: factory defects (phase-null, worker state, merge_ready rework, result writes)", () => {
  test("a plain `relay task add` task is refused UP FRONT with the re-intake instruction and NO worktree", async () => {
    const rev = reviewerHarness(["pass"]);
    const plain = addTask(db, { title: "plain task" });
    const res = await runFactoryTask(db, plain.id, factoryDeps(fakeDsh("dsh-commit", COMMITTING_DSH), rev.spawner));
    expect(res.outcome).toBe("blocked");
    expect(res.reason).toContain("not a code-change task");
    expect(res.reason).toContain("relay task intake --code-change");
    expect(res.attempts).toHaveLength(0);
    const row = getTask(db, plain.id)!;
    expect(row.worktree).toBeNull();
    expect(listRuns(db, { taskId: plain.id })).toHaveLength(0);
    expect(rev.calls).toHaveLength(0);
  });

  test("headless reviewer/integrator workers are idle (never starting) and raise no pane ATTENTION", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    // Simulate rows left `starting` (and default kind) by an older factory run:
    // the headless path must repair them, not leave a permanent attach-stuck
    // ATTENTION or a false "no visible runtime pane".
    registerWorker(db, REVIEWER_WORKER, { role: "reviewer" });
    registerWorker(db, DEFAULT_INTEGRATOR_WORKER, { role: "integrator" });
    expect(getWorker(db, REVIEWER_WORKER)!.state).toBe("starting");
    expect(getWorker(db, REVIEWER_WORKER)!.agent_kind).toBe("opencode");
    const res = await runFactoryTask(db, id, factoryDeps(dsh, reviewerHarness(["pass"]).spawner));
    expect(res.outcome).toBe("merge_ready");
    for (const wid of [REVIEWER_WORKER, DEFAULT_INTEGRATOR_WORKER]) {
      expect(getWorker(db, wid)!.state).toBe("idle");
    }
    expect(getWorker(db, REVIEWER_WORKER)!.agent_kind).toBe("claude");
    expect(getWorker(db, DEFAULT_INTEGRATOR_WORKER)!.agent_kind).toBe("relay");
    const view = buildDashboardView(db, { root: dir, panes: new Map(), at: Date.now() });
    const attention = view.attention.filter((a) => a.id === REVIEWER_WORKER || a.id === DEFAULT_INTEGRATOR_WORKER);
    expect(attention).toHaveLength(0);
    // The other surface (`relay status`) must agree: no headless stuck-attach row.
    const status = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "status"], {
      env: { ...process.env, RELAY_DB: process.env.RELAY_DB! },
    });
    expect(status.exitCode).toBe(0);
    const statusText = status.stdout.toString();
    const statusAttention = statusText.split("Attention\n---------\n")[1]?.split("\nUnattached")[0] ?? "";
    expect(statusAttention).toContain("(none)");
    expect(statusText).not.toContain("starting for a while");
    // A normal (pane-supervised) worker with no runtime is still actionable.
    registerWorker(db, "pane-worker", { role: "worker" });
    const view2 = buildDashboardView(db, { root: dir, panes: new Map(), at: Date.now() });
    expect(
      view2.attention.some((a) => a.id === "pane-worker" && a.text.includes("no visible runtime pane"))
    ).toBe(true);
  });

  test("a merge_ready task returns to implement at attempt+1 via a superseding --fail review", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const res = await runFactoryTask(db, id, factoryDeps(dsh, reviewerHarness(["pass"]).spawner));
    expect(res.outcome).toBe("merge_ready");
    const before = getTask(db, id)!;
    const pass = findPassingReview(db, id, before.attempt)!;
    const reason = "origin/main moved: rebase and re-run";
    const updated = recordReview(db, id, REVIEWER_WORKER, {
      verdict: "fail",
      headSha: before.head_sha!,
      reason,
      supersedesResultId: pass.id,
    });
    expect(updated.phase).toBe("implement");
    expect(updated.state).toBe("queued");
    expect(updated.attempt).toBe(before.attempt + 1);
    expect(updated.head_sha).toBeNull();
    // The replacement verdict is the SAME row (same attempt identity), now an NG.
    const replaced = getTaskResult(db, pass.id)!;
    expect(replaced.passed).toBe(0);
    expect(replaced.reason).toBe(reason);
    const rowCount = db
      .query(
        `SELECT COUNT(*) AS n FROM task_results WHERE task_id=? AND phase='review' AND attempt=? AND kind='ReviewResult'`
      )
      .get(id, before.attempt) as { n: number };
    expect(rowCount.n).toBe(1);
    // The reason is the FIX brief the next implement Run inherits.
    expect(inheritFindings(db, updated).map((f) => f.reason).join("\n")).toContain(reason);
  });

  test("the same merge_ready route works without --supersedes (the current PASS is replaced)", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    await runFactoryTask(db, id, factoryDeps(dsh, reviewerHarness(["pass"]).spawner));
    const before = getTask(db, id)!;
    const updated = recordReview(db, id, REVIEWER_WORKER, {
      verdict: "fail",
      reason: "PR has conflicts, route back to implement",
    });
    expect(updated.phase).toBe("implement");
    expect(updated.attempt).toBe(before.attempt + 1);
    expect(updated.head_sha).toBeNull();
  });

  test("the supported CLI command `relay result review --fail --supersedes` routes merge_ready back", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    await runFactoryTask(db, id, factoryDeps(dsh, reviewerHarness(["pass"]).spawner));
    const before = getTask(db, id)!;
    const pass = findPassingReview(db, id, before.attempt)!;
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const r = Bun.spawnSync(
      [
        "bun",
        cli,
        "result",
        "review",
        id,
        "--fail",
        "--head",
        before.head_sha!,
        "--reason",
        "rebase needed after the trunk moved",
        "--supersedes",
        String(pass.id),
        "--worker",
        REVIEWER_WORKER,
      ],
      { env: { ...process.env, RELAY_DB: process.env.RELAY_DB! } }
    );
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
    const after = getTask(db, id)!;
    expect(after.phase).toBe("implement");
    expect(after.state).toBe("queued");
    expect(after.attempt).toBe(before.attempt + 1);
    expect(after.head_sha).toBeNull();
  });

  test("a result-write failure parks the task blocked_internal instead of a half-applied phase", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    db.exec(
      `CREATE TRIGGER ish904_fail_results BEFORE INSERT ON task_results BEGIN SELECT RAISE(ABORT, 'task_results write boom'); END;`
    );
    try {
      const res = await runFactoryTask(db, id, factoryDeps(dsh, reviewerHarness(["pass"]).spawner));
      expect(res.outcome).toBe("blocked");
      expect(res.reason).toContain(RESULT_WRITE_ERROR);
      expect(res.reason).toContain("task_results write boom");
      const task = getTask(db, id)!;
      expect(task.state).toBe("blocked_internal");
      // The implement phase never advanced (no half-applied phase/head).
      expect(task.phase).toBe("implement");
      expect(task.head_sha).toBeNull();
    } finally {
      db.exec(`DROP TRIGGER IF EXISTS ish904_fail_results`);
    }
  });
});

describe("independent reviewer identity + submission authority", () => {
  test("a non-reviewer principal cannot review (fake reviewer identity refused)", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    await driveToReview(id, dsh);
    // Register an impostor worker with a non-reviewer role and try to review.
    registerWorker(db, "impostor", { role: "worker" });
    const rev = reviewerHarness(["pass"]);
    const r = await runHeadlessReview(db, id, { spawner: rev.spawner, reviewerWorker: "impostor" });
    expect(r.outcome).toBe("refused");
    expect(r.error).toContain(REVIEW_NOT_INDEPENDENT);
    expect(getTask(db, id)!.phase).toBe("review");
  });

  test("an unauthenticated code->review submission is refused", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const head = await driveToReview(id, dsh);
    // A submission must be attributable: a nonexistent principal cannot review.
    expect(() => recordReview(db, id, "dsh-run:whatever", { verdict: "pass", headSha: head })).toThrow();
    expect(getTask(db, id)!.phase).toBe("review");
  });

  test("a PASS at a head with an unresolved NG is refused (unreconciled NG)", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const head = await driveToReview(id, dsh);
    // An NG already recorded at this head (a prior non-passing review).
    insertTaskResult(db, {
      taskId: id,
      phase: "review",
      attempt: 0,
      kind: "ReviewResult",
      workerId: REVIEWER_WORKER,
      passed: false,
      headSha: head,
      profile: "prior",
      reason: "NG: still broken",
    });
    const rev2 = reviewerHarness(["pass"]);
    const r = await runHeadlessReview(db, id, { spawner: rev2.spawner, reviewerWorker: REVIEWER_WORKER, profile: "second" });
    expect(r.outcome).toBe("refused");
    expect(r.error).toContain("UNRESOLVED_NG");
  });
});

describe("Gateway is told only for judgment", () => {
  test("an ordinary FIX never messages the Gateway; a BLOCKED review does, once", async () => {
    process.env.RELAY_HUMAN = "gateway";
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const fixId = newTask();
    await runFactoryTask(db, fixId, { ...factoryDeps(dsh, reviewerHarness(["fix"]).spawner), maxAttempts: 1 });
    expect(inboxFor(db, "gateway")).toHaveLength(0);

    const blockId = newTask();
    const res = await runFactoryTask(db, blockId, { ...factoryDeps(dsh, reviewerHarness(["blocked"]).spawner), maxAttempts: 1 });
    expect(res.outcome).toBe("blocked");
    expect(getTask(db, blockId)!.state).toBe("blocked_human");
    const msgs = inboxFor(db, "gateway");
    expect(msgs.length).toBe(1);
    expect(msgs[0].task_id).toBe(blockId);
  });

  test("a blocked review with an EMPTY summary still yields a precise non-empty reason", async () => {
    process.env.RELAY_HUMAN = "gateway";
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const res = await runFactoryTask(db, id, {
      ...factoryDeps(dsh, reviewerHarness(["blockedempty"]).spawner),
      maxAttempts: 1,
    });
    expect(res.outcome).toBe("blocked");
    expect(res.reason).toBeTruthy();
    expect(res.reason).toContain("review blocked");
    expect(res.reason).not.toBe("");
  });
});

describe("blocked / terminal tasks never advance", () => {
  test("a blocked_human task is returned as terminal with no Run launched", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    db.query(`UPDATE tasks SET state='blocked_human' WHERE id=?`).run(id);
    const res = await runFactoryTask(db, id, factoryDeps(dsh, reviewerHarness(["pass"]).spawner));
    expect(res.outcome).toBe("terminal");
    expect(listRuns(db, { taskId: id })).toHaveLength(0);
  });

  // Regression (PR #10 finding 1): `blockTask(..., human=false)` sets
  // `blocked_internal` while LEAVING `phase` unchanged, so a guard that lists
  // only `blocked_human` carried the task to MergeReady and erased the block.
  test("a blocked_internal task is terminal (the durable block is never erased)", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    registerWorker(db, "impl-worker", { role: "worker" });
    const id = newTask();
    blockTask(db, id, "impl-worker", "needs a human decision", false);
    expect(getTask(db, id)!.state).toBe("blocked_internal");
    const phaseBefore = getTask(db, id)!.phase;
    const res = await runFactoryTask(db, id, factoryDeps(dsh, reviewerHarness(["pass"]).spawner));
    expect(res.outcome).toBe("terminal");
    expect(res.reason).toBe("state blocked_internal");
    expect(getTask(db, id)!.state).toBe("blocked_internal");
    expect(getTask(db, id)!.phase).toBe(phaseBefore);
    expect(listRuns(db, { taskId: id })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PR #10 round-1 findings — regression tests (each reproduced the bug on the
// pre-fix HEAD; none of these was caught by the existing suite).
// ---------------------------------------------------------------------------

describe("PR #10 finding 2: a failed reviewer process is never a verdict", () => {
  test("a non-zero reviewer exit with a well-formed pass on stdout is REFUSED", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const res = await runFactoryTask(db, id, factoryDeps(dsh, reviewerHarness(["exitfail"]).spawner));
    expect(res.outcome).toBe("review_refused");
    expect(res.reason).toContain(REVIEW_PROCESS_FAILED);
    expect(getTask(db, id)!.phase).toBe("review");
  });

  test("a signalled reviewer with a valid pass on stdout is REFUSED", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const res = await runFactoryTask(db, id, factoryDeps(dsh, reviewerHarness(["signal"]).spawner));
    expect(res.outcome).toBe("review_refused");
    expect(res.reason).toContain(REVIEW_PROCESS_FAILED);
    expect(getTask(db, id)!.phase).toBe("review");
  });
});

describe("PR #10 finding 3: a worktree HEAD that moved during review is REFUSED", () => {
  test("a reviewer that commits to the worktree while running cannot advance", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const headBefore = await driveToReview(id, dsh);
    const rev = reviewerHarness(["mutatehead"]);
    const res = await runFactoryTask(db, id, { ...factoryDeps(dsh, rev.spawner), maxAttempts: 1 });
    expect(res.outcome).toBe("review_refused");
    expect(res.reason).toContain("HEAD_MISMATCH");
    // The task is NOT advanced, and its recorded head still names the reviewed rev.
    const task = getTask(db, id)!;
    expect(task.phase).toBe("review");
    expect(task.head_sha).toBe(headBefore);
  });
});

describe("PR #10 finding 4: an orphaned running Run never hangs the factory", () => {
  test("a dead-pid orphan is marked failed and the factory fails closed", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const launched = await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: dsh, fastExitMs: 0 });
    await launched.handle.wait();
    // Simulate the owner process dying: the row stays `running` with a dead pid.
    const dead = Bun.spawnSync(["true"]);
    const deadPid = dead.pid ?? 999999;
    db.query(`UPDATE runs SET state='running', pid=?, exit_code=NULL, ended_at=NULL WHERE id=?`).run(deadPid, launched.handle.id);
    const res = await runFactoryTask(db, id, { ...factoryDeps(dsh, reviewerHarness(["pass"]).spawner), timeoutMs: 2000 });
    expect(res.outcome).toBe("coding_failed");
    expect(res.reason).toContain("orphaned");
    const runs = listRuns(db, { taskId: id });
    expect(runs).toHaveLength(1);
    expect(runs[0].state).toBe("failed");
    expect(getTask(db, id)!.phase).toBe("implement");
  });

  test("an EXPIRED but still-live orphan is KILLED before the fence is released", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const launched = await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: dsh, fastExitMs: 0 });
    await launched.handle.wait();
    // A REAL detached child in its own process group — the orphan a crashed factory
    // leaves behind. Store its OWN start token so the identity check proves it is
    // this Run's process (a genuine orphan), not a reused PID.
    const child = Bun.spawn(["sleep", "30"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const childPid = child.pid;
    db.query(
      `UPDATE runs SET state='running', pid=?, spawn_lstart=?, exit_code=NULL, ended_at=NULL WHERE id=?`
    ).run(childPid, spawnIdentityToken(childPid), launched.handle.id);

    const res = await runFactoryTask(db, id, { ...factoryDeps(dsh, reviewerHarness(["pass"]).spawner), timeoutMs: 300 });
    expect(res.outcome).toBe("coding_failed");
    expect(res.reason).toContain("expired");
    // KILL BEFORE RELEASE: proven ours and now dead, so the Run is terminal `failed`.
    expect(pidAlive(childPid)).toBe(false);
    expect(listRuns(db, { taskId: id })[0].state).toBe("failed");
    // With the writer truly gone, the worktree is free again — a following launch
    // is admitted (no stale DUPLICATE_WRITER, no second live writer).
    const next = await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: dsh, fastExitMs: 0 });
    expect(next.handle.id).not.toBe(launched.handle.id);
    await next.handle.wait();
  });

  test("an orphan that CANNOT be killed leaves the Run running (DUPLICATE_WRITER keeps fencing)", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const launched = await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: dsh, fastExitMs: 0 });
    await launched.handle.wait();
    // A genuine detached orphan (identity MATCHES), but the terminate seam fails.
    const child = Bun.spawn(["sleep", "30"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const childPid = child.pid;
    db.query(
      `UPDATE runs SET state='running', pid=?, spawn_lstart=?, exit_code=NULL, ended_at=NULL WHERE id=?`
    ).run(childPid, spawnIdentityToken(childPid), launched.handle.id);
    const res = await runFactoryTask(db, id, {
      ...factoryDeps(dsh, reviewerHarness(["pass"]).spawner),
      timeoutMs: 300,
      terminateOrphan: async () => false,
    });
    expect(res.outcome).toBe("coding_failed");
    expect(res.reason).toContain("could not be terminated");
    // The seam never signalled: the orphan is still alive.
    expect(pidAlive(childPid)).toBe(true);
    // The Run stays `running`, so the single-writer fence is intact.
    expect(listRuns(db, { taskId: id })[0].state).toBe("running");
    let refused = false;
    try {
      await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: dsh });
    } catch (e) {
      refused = new RegExp(DUPLICATE_WRITER).test(String(e));
    }
    expect(refused).toBe(true);
    try { child.kill("SIGKILL"); } catch { /* done */ }
  });

  // Round-3 finding: the orphan-kill path must NEVER signal a PID that is not
  // provably the Run's dsh. A reused PID (an unrelated host process) must survive.
  test("a reused PID (unrelated NON-leader process) is NEVER signalled", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const launched = await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: dsh, fastExitMs: 0 });
    await launched.handle.wait();
    // A NON-detached child: it shares this process's group, so it is NOT a group
    // leader — exactly the shape the old kill(pid) fallback would have hit.
    const victim = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const victimPid = victim.pid;
    expect(processPgid(victimPid)).not.toBe(victimPid); // not a leader
    db.query(
      `UPDATE runs SET state='running', pid=?, spawn_lstart='lstart-v1:not-the-real-token', exit_code=NULL, ended_at=NULL WHERE id=?`
    ).run(victimPid, launched.handle.id);

    const res = await runFactoryTask(db, id, { ...factoryDeps(dsh, reviewerHarness(["pass"]).spawner), timeoutMs: 300 });
    expect(res.outcome).toBe("coding_failed");
    expect(res.reason).toContain("reused");
    // The unrelated process is UNTOUCHED and still alive.
    expect(pidAlive(victimPid)).toBe(true);
    // The original dsh is gone, so the Row is terminal `failed` (no signal was sent).
    expect(listRuns(db, { taskId: id })[0].state).toBe("failed");
    try { victim.kill("SIGKILL"); } catch { /* done */ }
  });

  test("a group leader with a DIFFERENT spawn start time (reused PID) is NEVER signalled", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const launched = await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: dsh, fastExitMs: 0 });
    await launched.handle.wait();
    // A detached (group-leader) process, but the stored token is a DIFFERENT start
    // time: the PID was reused. Identity mismatches on the token -> no signal.
    const victim = Bun.spawn(["sleep", "30"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const victimPid = victim.pid;
    expect(processPgid(victimPid)).toBe(victimPid); // is a leader
    db.query(
      `UPDATE runs SET state='running', pid=?, spawn_lstart='lstart-v1:Tue Jan  1 00:00:00 1980', exit_code=NULL, ended_at=NULL WHERE id=?`
    ).run(victimPid, launched.handle.id);

    const res = await runFactoryTask(db, id, { ...factoryDeps(dsh, reviewerHarness(["pass"]).spawner), timeoutMs: 300 });
    expect(res.outcome).toBe("coding_failed");
    expect(res.reason).toContain("reused");
    expect(pidAlive(victimPid)).toBe(true);
    expect(listRuns(db, { taskId: id })[0].state).toBe("failed");
    try { victim.kill("SIGKILL"); } catch { /* done */ }
  });
});

describe("PR #10 finding 5: an all-optional check list is not a gate", () => {
  test("a task with only OPTIONAL checks is no_checks (an unrun check can never PASS)", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask({ checks: [{ name: "slow", command: "sleep 5", required: false, timeoutMs: 80 }] });
    const res = await runFactoryTask(db, id, factoryDeps(dsh, reviewerHarness(["pass"]).spawner));
    expect(res.outcome).toBe("no_checks");
    expect(getTask(db, id)!.phase).toBe("verify");
  });

  test("a task with at least one REQUIRED check still runs", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask({
      checks: [
        { name: "required-noop", command: "true", required: true },
        { name: "optional-noop", command: "true", required: false },
      ],
    });
    const res = await runFactoryTask(db, id, factoryDeps(dsh, reviewerHarness(["pass"]).spawner));
    expect(res.outcome).toBe("merge_ready");
  });
});

// ---------------------------------------------------------------------------
// PR #10 round-4 findings.
// ---------------------------------------------------------------------------

describe("PR #10 finding 1: the spawn token is canonical (env-independent)", () => {
  test("spawnIdentityToken is identical across caller LC_ALL/TZ", () => {
    const before = spawnIdentityToken(process.pid);
    const saved = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG, TZ: process.env.TZ };
    try {
      process.env.LC_ALL = "ja_JP.UTF-8";
      process.env.LANG = "ja_JP.UTF-8";
      process.env.TZ = "Asia/Tokyo";
      const after = spawnIdentityToken(process.pid);
      expect(after).toBe(before);
      expect(before?.startsWith("lstart-v1:")).toBe(true);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("a genuine orphan stored under one LC_ALL/TZ is still MATCHED after a restart under another", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const launched = await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: dsh, fastExitMs: 0 });
    await launched.handle.wait();
    const child = Bun.spawn(["sleep", "30"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const childPid = child.pid;
    db.query(
      `UPDATE runs SET state='running', pid=?, spawn_lstart=?, exit_code=NULL, ended_at=NULL WHERE id=?`
    ).run(childPid, spawnIdentityToken(childPid), launched.handle.id);

    // Adopt from a process with a DIFFERENT locale/timezone than the spawn.
    const saved = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG, TZ: process.env.TZ };
    let res: Awaited<ReturnType<typeof runFactoryTask>>;
    try {
      process.env.LC_ALL = "ja_JP.UTF-8";
      process.env.LANG = "ja_JP.UTF-8";
      process.env.TZ = "Asia/Tokyo";
      res = await runFactoryTask(db, id, { ...factoryDeps(dsh, reviewerHarness(["pass"]).spawner), timeoutMs: 300 });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(res.outcome).toBe("coding_failed");
    // Canonical token => identity MATCHED => the genuine orphan was killed, not
    // misread as "reused" (which would release the fence while it lived).
    expect(pidAlive(childPid)).toBe(false);
    expect(listRuns(db, { taskId: id })[0].state).toBe("failed");
  });

  test("a LEGACY non-canonical token is undeterminable: fence held, no signal", async () => {
    const dsh = fakeDsh("dsh-commit", COMMITTING_DSH);
    const id = newTask();
    const launched = await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: dsh, fastExitMs: 0 });
    await launched.handle.wait();
    const child = Bun.spawn(["sleep", "30"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const childPid = child.pid;
    // An OLD-format token (no version tag) cannot be compared across environments.
    db.query(
      `UPDATE runs SET state='running', pid=?, spawn_lstart='Sat Oct 17 01:24:35 2026', exit_code=NULL, ended_at=NULL WHERE id=?`
    ).run(childPid, launched.handle.id);

    const res = await runFactoryTask(db, id, { ...factoryDeps(dsh, reviewerHarness(["pass"]).spawner), timeoutMs: 300 });
    expect(res.outcome).toBe("coding_failed");
    expect(res.reason).toContain("could not be proven");
    // Never signalled; the Run is left running so the fence keeps holding.
    expect(pidAlive(childPid)).toBe(true);
    expect(listRuns(db, { taskId: id })[0].state).toBe("running");
    let refused = false;
    try {
      await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: dsh });
    } catch (e) {
      refused = new RegExp(DUPLICATE_WRITER).test(String(e));
    }
    expect(refused).toBe(true);
    try { child.kill("SIGKILL"); } catch { /* done */ }
  });
});

describe("PR #10 finding 2: the live Run is the only control-plane writer", () => {
  test("claimTask, claimNext and submitPhase refuse while a Run owns the phase/attempt", async () => {
    const slow = fakeDsh("dsh-slow", "sleep 2\nexit 0\n");
    const id = newTask();
    const live = await launchTaskRun(db, id, { repo, worktreesRoot: join(dir, "worktrees"), outputRoot: join(dir, "runs"), dshBin: slow });
    registerWorker(db, "thief", { role: "worker" });
    expect(() => claimTask(db, id, "thief")).toThrow(/RUN_OWNED/);
    expect(() => submitPhase(db, id, "thief", { evidence: "x" })).toThrow(/RUN_OWNED/);
    // The generic claim machine must not offer the Run-owned task either.
    expect(claimNext(db, "thief")).toBeNull();
    await live.handle.wait();
  });

  test("a coding Run that runs `relay claim` + `relay submit` cannot advance the Task", async () => {
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const thiefDsh = `#!/bin/sh
set -e
echo "$RELAY_RUN_ID" > "change-$RELAY_RUN_ID.txt"
git add -A
git -c user.email=relay@test -c user.name=relay commit -qm "change $RELAY_RUN_ID"
bun "$RELAY_CLI" worker register w-dsh --role worker >> .relay/attempt.log 2>&1 || true
bun "$RELAY_CLI" claim "$RELAY_TASK_ID" --worker w-dsh >> .relay/attempt.log 2>&1 || true
bun "$RELAY_CLI" submit "$RELAY_TASK_ID" --worker w-dsh --evidence done >> .relay/attempt.log 2>&1 || true
echo DONE
`;
    const dsh = fakeDsh("dsh-thief", thiefDsh);
    const id = newTask();
    const res = await runFactoryTask(db, id, {
      ...factoryDeps(dsh, reviewerHarness(["pass"]).spawner),
      dshEnv: { RELAY_CLI: cli },
    });
    // The Run's own generic mutations were refused, so the factory's structured
    // acceptRunSubmission is the ONLY advance and the whole loop still completes.
    expect(res.outcome).toBe("merge_ready");
    const log = readFileSync(join(dir, "worktrees", id, ".relay", "attempt.log"), "utf-8");
    expect(log).toContain("RUN_OWNED");
  });
});

// ---------------------------------------------------------------------------
// ISH-880: bind a produced commit to a real PR before the review stage.
// ---------------------------------------------------------------------------

/** A read-only GitHub whose PR head is read LAZILY from the task (H_0 = produced). */
function dynamicGithub(head: () => string | null): GitHubReadOnly {
  return {
    name: "dynamic-github",
    readOnly: true as const,
    getPullRequest(ref) {
      const sha = head();
      if (!sha) return null;
      return {
        ref,
        url: `https://github.com/81ueman/relay/pull/7`,
        state: "open",
        isDraft: false,
        headRefName: "relay/ish-880",
        headSha: sha,
        baseRef: "main",
        baseSha: "0".repeat(40),
        mergeable: "mergeable",
        labels: [],
        updatedAt: "2026-01-01T00:00:00Z",
        isCrossRepository: false,
        headRepo: "81ueman/relay",
      };
    },
    findPullRequestForBranch: () => null,
    listComments: () => [],
  };
}

describe("ISH-880: the produced commit is bound to its PR before review", () => {
  test("a matching PR head is bound and the Task reaches MergeReady", async () => {
    const dsh = fakeDsh("dsh-pr", COMMITTING_DSH);
    const id = newTask();
    linkTask(db, id, { prUrl: "81ueman/relay#7", prRepo: "81ueman/relay" });
    const rev = reviewerHarness(["pass"]);
    const res = await runFactoryTask(db, id, {
      ...factoryDeps(dsh, rev.spawner),
      prBinding: { github: dynamicGithub(() => getTask(db, id)!.head_sha) },
    });

    expect(res.outcome).toBe("merge_ready");
    expect(rev.calls).toHaveLength(1);
    const t = getTask(db, id)!;
    expect(t.pr_repo).toBe("81ueman/relay");
    expect(t.head_sha).toBe(res.head);
    expect(res.steps.some((s) => s.startsWith("review:pr-bound"))).toBe(true);
  });

  test("a PR whose head != the produced commit BLOCKS before the reviewer runs", async () => {
    const dsh = fakeDsh("dsh-pr2", COMMITTING_DSH);
    const id = newTask();
    linkTask(db, id, { prUrl: "81ueman/relay#7", prRepo: "81ueman/relay" });
    const rev = reviewerHarness(["pass"]);
    const res = await runFactoryTask(db, id, {
      ...factoryDeps(dsh, rev.spawner),
      prBinding: { github: dynamicGithub(() => "0".repeat(40)) },
    });

    expect(res.outcome).toBe("blocked");
    expect(res.reason).toContain("HEAD_MOVED");
    expect(rev.calls).toHaveLength(0); // never a fake review_pass
  });
});

// Silence the unused-import linters while keeping the named exports referenced.
void DEFAULT_INTEGRATOR_WORKER;
void submitPhase;
void existsSync;