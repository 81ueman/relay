import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { claimTask, getTask } from "../src/tasks";
import { registerWorker } from "../src/workers";
import { intakeTask, recordVerification, submitPhase } from "../src/workflow";
import {
  buildReviewBrief,
  DEFAULT_REVIEW_RUBRIC,
  reviewRubricFor,
  rubricFileAtHead,
  runHeadlessReview,
  type ReviewerProcess,
  type ReviewerSpawnContext,
  type ReviewerSpawner,
} from "../src/reviewer-runner";

// ISH-1135: the Factory reviewer prompt must load the repo-owned rubric at the
// reviewed HEAD and must ASK for focused execution instead of telling the
// reviewer not to run anything.

let dir = "";
let repo = "";
let db: Database;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

const RUBRIC_PATH = DEFAULT_REVIEW_RUBRIC.rubric;
const CONTRACT_PATH = DEFAULT_REVIEW_RUBRIC.outputContract!;

function reviewTaskAt(head: string) {
  const t = intakeTask(db, {
    provider: "test",
    issueId: `ISH-1135-${head.slice(0, 7)}`,
    codeChange: true,
    title: "review prompt rubric",
    acceptance: "The reviewer reads the rubric.",
    headSha: head,
    worktree: repo,
  });
  return getTask(db, t.id)!;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-ish1135-review-"));
  repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "relay@test");
  git(repo, "config", "user.name", "relay-test");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "base");
  db = openDb(join(dir, "state.db"));
  registerWorker(db, "impl", { role: "worker" });
  registerWorker(db, "ver", { role: "worker" });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ISH-1135: the review prompt loads the repo rubric and expects focused execution", () => {
  test("asks for the rubric at the reviewed HEAD and no longer says 'do NOT re-run'", () => {
    mkdirSync(join(repo, ".agents/skills/independent-pr-review/references"), { recursive: true });
    writeFileSync(join(repo, RUBRIC_PATH), "# Rubric\n\nAct on / Consider / Noted / Dismissed.\n");
    writeFileSync(join(repo, CONTRACT_PATH), "# Contract\n");
    git(repo, "add", ".agents");
    git(repo, "commit", "-q", "-m", "add the review rubric");
    const head = git(repo, "rev-parse", "HEAD");

    const task = reviewTaskAt(head);
    const brief = buildReviewBrief(db, task, {
      head,
      worktree: repo,
      rubric: DEFAULT_REVIEW_RUBRIC,
      verify: { head, outcome: "pass", checks: [{ name: "noop", outcome: "pass", exitCode: 0, output: "" }] },
    });

    // The explicit "read this file first" instruction, pointing at the file at
    // the reviewed HEAD (checked from the COMMIT, not the working tree).
    expect(brief).toContain("## Repo review rubric — READ THIS FIRST");
    expect(brief).toContain(RUBRIC_PATH);
    expect(brief).toContain(CONTRACT_PATH);
    expect(brief).toContain("present at the reviewed HEAD");
    expect(brief).toContain("Read it NOW");
    expect(brief).toContain(`\`${head}\``);

    // The old blanket "do NOT re-run" prohibition is gone; the narrow rule and
    // the focused-execution expectation remain.
    expect(brief).not.toContain("do NOT re-run");
    expect(brief).toContain("The required checks below already passed; do not re-run them wholesale.");
    expect(brief).toContain("## Focused execution — expected, not optional");
    expect(brief).toContain("You are expected to execute the focused tests, commands or variants");
    // Normalize line wrapping so the quoted expectation is a phrase assertion.
    const flat = brief.replace(/\s+/g, " ");
    expect(flat).toContain("(other address family, sibling vendor, deleted path re-sweep), and to say which you ran");
    expect(brief).toContain("no execution needed because");

    // Relay's JSON stays the machine contract; rubric severities map onto it and
    // non-blocking findings are KEPT (ISH-1086).
    expect(brief).toContain("## Required output (STRICT)");
    expect(brief).toContain('"verdict":"pass|fix|blocked"');
    expect(brief).toContain("NON-BLOCKING `minor`");
    expect(brief).toContain("NON-BLOCKING `nit`");
    expect(brief).toContain("do NOT drop it");
  });

  test("a rubric missing at HEAD is stated in the prompt, never silently substituted", () => {
    // The file exists only UNCOMMITTED: it is not part of the reviewed HEAD.
    mkdirSync(join(repo, ".agents/skills/independent-pr-review/references"), { recursive: true });
    writeFileSync(join(repo, RUBRIC_PATH), "# local draft, not at HEAD\n");
    const head = git(repo, "rev-parse", "HEAD");
    expect(rubricFileAtHead(repo, head, RUBRIC_PATH)).toBe(false);

    const brief = buildReviewBrief(db, reviewTaskAt(head), {
      head,
      worktree: repo,
      rubric: DEFAULT_REVIEW_RUBRIC,
    });
    expect(brief).toContain("MISSING at the reviewed HEAD");
    expect(brief).toContain("Do NOT silently");
    expect(brief).toContain("the repo rubric was unavailable");
    expect(brief).not.toContain("present at the reviewed HEAD");
  });

  test("a dirty working tree cannot substitute for the committed rubric blob", () => {
    // ISH-1143: commit the rubric, then dirty the mutable-worktree fallback.
    // HEAD is unchanged, so `rubricFileAtHead` stays true: the brief must point
    // the reviewer at `git show <head>:<path>`, not the checkout file.
    mkdirSync(join(repo, ".agents/skills/independent-pr-review/references"), { recursive: true });
    writeFileSync(join(repo, RUBRIC_PATH), "# Rubric at HEAD\n\nAct on / Consider / Noted / Dismissed.\n");
    writeFileSync(join(repo, CONTRACT_PATH), "# Contract at HEAD\n");
    git(repo, "add", ".agents");
    git(repo, "commit", "-q", "-m", "add the review rubric");
    const head = git(repo, "rev-parse", "HEAD");

    writeFileSync(join(repo, RUBRIC_PATH), "# DIRTY local rubric (not committed)\n");
    writeFileSync(join(repo, CONTRACT_PATH), "# DIRTY local contract (not committed)\n");
    expect(git(repo, "status", "--porcelain")).toContain(RUBRIC_PATH);
    expect(rubricFileAtHead(repo, head, RUBRIC_PATH)).toBe(true);
    expect(git(repo, "show", `${head}:${RUBRIC_PATH}`)).toContain("Rubric at HEAD");

    const brief = buildReviewBrief(db, reviewTaskAt(head), {
      head,
      worktree: repo, // mutable-worktree fallback: no detached reviewWorktree
      rubric: DEFAULT_REVIEW_RUBRIC,
    });
    expect(brief).toContain("reviewed COMMIT");
    expect(brief).toContain(`git show ${head}:${RUBRIC_PATH}`);
    expect(brief).toContain(`git show ${head}:${CONTRACT_PATH}`);
    expect(brief).toContain("not the working-tree path");
    // The old file-tool instruction is gone, and the dirty content is not read.
    expect(brief).not.toContain("from THIS checkout");
    expect(brief).not.toContain("use your file-reading tool");
    expect(brief).not.toContain("DIRTY local rubric");
  });

  test("the factory reviewer process receives that brief (the actual prompt)", async () => {
    mkdirSync(join(repo, ".agents/skills/independent-pr-review/references"), { recursive: true });
    writeFileSync(join(repo, RUBRIC_PATH), "# Rubric\n");
    writeFileSync(join(repo, CONTRACT_PATH), "# Contract\n");
    git(repo, "add", ".agents");
    git(repo, "commit", "-q", "-m", "add the review rubric");
    const head = git(repo, "rev-parse", "HEAD");

    const t = reviewTaskAt(head);
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl");
    claimTask(db, t.id, "ver");
    recordVerification(db, t.id, "ver", { passed: true });
    expect(getTask(db, t.id)!.phase).toBe("review");

    const calls: ReviewerSpawnContext[] = [];
    const spawner: ReviewerSpawner = {
      async run(ctx): Promise<ReviewerProcess> {
        calls.push(ctx);
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({ verdict: "pass", head, findings: [], summary: "ok" }),
          stderr: "",
        };
      },
    };
    const r = await runHeadlessReview(db, t.id, { spawner, reviewRubric: DEFAULT_REVIEW_RUBRIC });
    expect(r.outcome).toBe("pass");
    expect(calls).toHaveLength(1);
    expect(calls[0].brief).toContain("## Repo review rubric — READ THIS FIRST");
    expect(calls[0].brief).toContain(RUBRIC_PATH);
    expect(calls[0].brief).toContain("## Focused execution — expected, not optional");
    expect(calls[0].brief).not.toContain("do NOT re-run");
  });
});

describe("ISH-1135: the rubric path is configurable per repository", () => {
  test("RELAY_REVIEW_RUBRICS resolves owner/name, bare name and default", () => {
    const env = {
      RELAY_REVIEW_RUBRICS: JSON.stringify({
        "81Ueman/Ishiul": { rubric: "docs/rubric.md", outputContract: "docs/contract.md" },
        relay: { rubric: "RELAY.md" },
        default: { rubric: "DEFAULT.md" },
      }),
    } as NodeJS.ProcessEnv;
    expect(reviewRubricFor("81ueman/ishiul", env)).toEqual({ rubric: "docs/rubric.md", outputContract: "docs/contract.md" });
    expect(reviewRubricFor("someone/relay", env)).toEqual({ rubric: "RELAY.md" });
    expect(reviewRubricFor("someone/other", env)).toEqual({ rubric: "DEFAULT.md" });
  });

  test("a flat RELAY_REVIEW_RUBRIC wins, and the ishiul layout is the fallback", () => {
    expect(
      reviewRubricFor("o/r", { RELAY_REVIEW_RUBRIC: "review.md", RELAY_REVIEW_OUTPUT_CONTRACT: "out.md" } as NodeJS.ProcessEnv)
    ).toEqual({ rubric: "review.md", outputContract: "out.md" });
    expect(reviewRubricFor("o/r", { RELAY_REVIEW_RUBRIC: "review.md" } as NodeJS.ProcessEnv)).toEqual({
      rubric: "review.md",
    });
    expect(reviewRubricFor("o/r", {} as NodeJS.ProcessEnv)).toEqual(DEFAULT_REVIEW_RUBRIC);
    // A malformed map never supplies a wrong path.
    expect(reviewRubricFor("o/r", { RELAY_REVIEW_RUBRICS: "{" } as NodeJS.ProcessEnv)).toEqual(DEFAULT_REVIEW_RUBRIC);
  });
});

describe("ISH-1143: --review-output-contract without --review-rubric is refused", () => {
  const cli = join(import.meta.dir, "..", "src", "cli.ts");

  test("the CLI fails loudly instead of silently ignoring the orphan flag", () => {
    const r = Bun.spawnSync(
      ["bun", cli, "run", "factory", "ISH-1143", "--review-output-contract", "docs/contract.md"],
      {
        env: { ...process.env, RELAY_DB: join(dir, "cli-state.db") },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("--review-output-contract requires --review-rubric");
  });

  test("the factory help documents the pairing", () => {
    const r = Bun.spawnSync(["bun", cli, "run", "factory", "--help"], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("--review-output-contract` without `--review-rubric` is REFUSED");
  });
});
