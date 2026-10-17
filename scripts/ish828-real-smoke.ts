#!/usr/bin/env bun
/**
 * ISH-828 REAL Docker Sandboxes smoke (opt-in).
 *
 *   RELAY_SANDBOX_SMOKE=1 bun run smoke:sandbox:real
 *
 * Unlike `scripts/ish828-smoke.ts` (fake `sbx`), this drives the REAL `sbx` CLI
 * against a throwaway MAIN-checkout git repo:
 *
 *   sbx create --clone -> real dsh Run inside the microVM -> host fetch of the
 *   produced commit -> safe cleanup (`sbx stop` + `sbx rm`).
 *
 * It refuses to run unless RELAY_SANDBOX_SMOKE=1. It requires a logged-in `sbx`
 * (`sbx ls`) and a sandbox agent/kit that already carries dsh (default
 * `ishiul-coding`, the ISH-827 kit; override with RELAY_SANDBOX_AGENT). It never
 * touches the relay repo, never pushes to GitHub and never merges.
 *
 * The dsh model call depends on the sandbox's provider/credential setup; the
 * smoke records whatever the real run did (exit code + JSONL) and only HARD
 * asserts the plumbing Relay owns: clone creation, dsh presence, sbx exec
 * streaming, JSONL evidence and the host fetch/cleanup.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";import { openDb } from "../src/db";
import { getTask } from "../src/tasks";
import { intakeTask } from "../src/workflow";
import { launchTaskSandboxRun } from "../src/sandbox-lifecycle";
import { getSandbox, realSbxCli, sbxList } from "../src/sandbox";
import { applySandboxCleanup, fetchSandboxHead, planSandboxCleanup, sandboxDshVersion } from "../src/sandbox-lifecycle";

let steps = 0;
function ok(msg: string): void {
  steps++;
  console.log(`  ok ${steps}. ${msg}`);
}
function fail(msg: string): never {
  console.error(`  FAIL: ${msg}`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): void {
  if (cond) ok(msg);
  else fail(msg);
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

if (process.env.RELAY_SANDBOX_SMOKE !== "1") {
  console.error("refusing to run: set RELAY_SANDBOX_SMOKE=1 (creates a REAL Docker Sandbox)");
  process.exit(2);
}

const agent = process.env.RELAY_SANDBOX_AGENT ?? "ishiul-coding";
console.log(`ISH-828 real sandbox smoke — agent/kit: ${agent}`);
console.log(`sbx version: ${execFileSync("sbx", ["version"], { encoding: "utf8" }).trim()}`);

const dir = mkdtempSync(join(tmpdir(), "relay-ish828-real-"));
const keep = process.env.RELAY_SANDBOX_KEEP === "1";
const evidenceDir = process.env.RELAY_SANDBOX_EVIDENCE_DIR ?? null;
let sandboxName: string | null = null;
process.on("exit", () => {
  if (keep) {
    console.error(`kept temp dir: ${dir}`);
    return;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** Copy the per-Run evidence to a stable dir (never the host repo) for review. */
function saveEvidence(runDir: string): void {
  if (!evidenceDir) return;
  try {
    mkdirSync(evidenceDir, { recursive: true });
    for (const f of ["spec.md", "stdout.log", "stderr.log", "dsh.jsonl", "events.jsonl"]) {
      const src = join(runDir, f);
      if (existsSync(src)) writeFileSync(join(evidenceDir, f), readFileSync(src));
    }
    console.error(`evidence saved to ${evidenceDir}`);
  } catch (e) {
    console.error(`could not save evidence: ${String(e)}`);
  }
}

try {
  // A throwaway MAIN checkout (never the relay repo, never a linked worktree).
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "smoke@test");
  git(repo, "config", "user.name", "relay-smoke");
  writeFileSync(join(repo, "README.md"), "ISH-828 real smoke fixture\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "fixture: base");

  process.env.RELAY_DB = join(dir, "state.db");
  const db = openDb(process.env.RELAY_DB);
  const task = intakeTask(db, {
    provider: "smoke",
    issueId: `ISH-828-REAL-${Date.now()}`,
    codeChange: true,
    title: "write a note and commit it",
    description: "Create SMOKE.md containing the line ISH-828-OK and commit it on the current branch.",
  });

  assert(sbxList(realSbxCli).length >= 0, "sbx is reachable and logged in");
  const outputRoot = join(dir, "runs");

  // 1. Create the real clone-mode sandbox and run one real dsh inside it.
  const launched = await launchTaskSandboxRun(db, task.id, { source: repo, agent, outputRoot, timeoutMs: 10 * 60_000 });
  sandboxName = launched.sandbox.name;
  console.log(`  ... sandbox ${sandboxName} (workspace ${launched.sandbox.workspace})`);
  const version = sandboxDshVersion(realSbxCli, sandboxName, { workdir: launched.sandbox.workspace });
  assert(version !== null, `dsh is present inside the sandbox (${version})`);

  const run = await launched.handle.wait();
  const raw = run.dsh_events_path && existsSync(run.dsh_events_path) ? readFileSync(run.dsh_events_path, "utf8") : "";
  console.log(`  ... real dsh Run ${run.id}: state=${run.state} exit=${run.exit_code} session=${run.session_id ?? "-"}`);
  if (raw) console.log(`  ... dsh JSONL (first line): ${raw.split("\n")[0].slice(0, 200)}`);
  if (run.stderr_path && existsSync(run.stderr_path)) {
    const err = readFileSync(run.stderr_path, "utf8").trim();
    if (err) console.log(`  ... dsh stderr tail:\n${err.split("\n").slice(-8).join("\n")}`);
  }
  saveEvidence(run.output_dir);
  assert(existsSync(run.output_dir), `Run evidence dir exists (${run.output_dir})`);
  assert(raw.length > 0 || run.error !== null, "a real dsh stream or a real error was recorded (no silent no-op)");

  // 2. Fetch the produced commit back to the host (when the run committed).
  const fetched = fetchSandboxHead(launched.sandbox.source, sandboxName, launched.sandbox.branch);
  if (run.state === "exited") {
    assert(fetched.ok && fetched.sha === run.head_sha, `produced commit fetched to the host (${fetched.sha?.slice(0, 12)})`);
  } else {
    console.log(`  ... run did not exit 0 (${run.error ?? "?"}); skipping the commit assertion`);
  }

  // 3. Safe teardown: the commit + logs are saved first, then the VM is removed.
  const dry = planSandboxCleanup(db, task.id, { abort: "smoke done" });
  assert(dry.removed === false && dry.name === sandboxName, "cleanup plans without acting; sandbox named");
  const cleanup = applySandboxCleanup(db, task.id, { apply: true, abort: "smoke done" });
  assert(cleanup.removed, `the sandbox was stopped and removed (${sandboxName})`);
  sandboxName = null;
  assert(getSandbox(db, task.id)!.state === "removed", "the mapping records the removal");
  assert(existsSync(run.output_dir), "the Run evidence survived teardown");

  db.close();
  console.log(`\nPASS — ${steps} checks`);
} catch (e) {
  console.error(`\nFAIL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  if (sandboxName) {
    console.error(`cleaning up leftover sandbox ${sandboxName}`);
    try {
      execFileSync("sbx", ["rm", "--force", sandboxName], { stdio: "ignore" });
    } catch {
      /* best effort */
    }
  }
}
