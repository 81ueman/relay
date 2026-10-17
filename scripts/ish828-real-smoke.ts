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
 *   produced commit -> structured submit -> safe cleanup (`sbx stop` + `sbx rm`).
 *
 * It refuses to run unless RELAY_SANDBOX_SMOKE=1. It requires a logged-in `sbx`
 * (`sbx ls`) and a sandbox agent/kit that already carries dsh (default
 * `ishiul-coding`, the relocated ISH-827/849 kit; override with
 * RELAY_SANDBOX_AGENT). It never touches the relay repo, never pushes to GitHub
 * and never merges.
 *
 * Provider route (the ticket does not put an LLM key in the kit): set
 *   RELAY_SANDBOX_KEY_CMD=/abs/get-ollama-key.sh
 * to have the smoke install the Ollama-Cloud overlay + the `sbx secret set-custom`
 * credential proxy (as in the ISH-822/827 PoCs), so the real dsh Run commits and
 * Relay fetches the commit back. Without it the model call fails for a missing
 * key and the smoke records that (and only then does it not hard-assert `exited`).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { getTask } from "../src/tasks";
import { intakeTask } from "../src/workflow";
import {
  acceptSandboxSubmission,
  applySandboxCleanup,
  ensureTaskSandbox,
  fetchSandboxHead,
  launchTaskSandboxRun,
  planSandboxCleanup,
  sandboxDshVersion,
} from "../src/sandbox-lifecycle";
import { getSandbox, realSbxCli, sbxList } from "../src/sandbox";

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
const keyCmd = process.env.RELAY_SANDBOX_KEY_CMD ?? null;
const overlay =
  process.env.RELAY_DSH_OVERLAY ?? join(process.cwd(), "docs", "ish-822-sandbox-poc", "scripts", "dsh-overlay.yml");
const patchPath = process.env.RELAY_DSH_PATCH ?? "/home/agent/dsh-overlay.yml";
console.log(`ISH-828 real sandbox smoke — agent/kit: ${agent}`);
console.log(`sbx version: ${execFileSync("sbx", ["version"], { encoding: "utf8" }).trim()}`);
console.log(`provider route: ${keyCmd ? `ollama-cloud overlay + secret proxy (${keyCmd})` : "none (expect a credential failure)"}`);

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

/**
 * Install the provider overlay + credential proxy into the sandbox (the exact
 * ISH-822/827 recipe). The real key stays on the host; the sandbox only sees a
 * `sbx-secret` placeholder substituted at the network layer.
 */
function installProvider(name: string, workspace: string): string {
  if (!existsSync(overlay)) throw new Error(`overlay not found: ${overlay}`);
  realSbxCli.run(["exec", "-w", workspace, name, "bash", "-lc", "mkdir -p /home/agent"]);
  const cp = realSbxCli.run(["cp", overlay, `${name}:${patchPath}`]);
  if (!cp.ok) throw new Error(`sbx cp overlay failed: ${cp.err || cp.out}`);
  const set = realSbxCli.run([
    "secret",
    "set-custom",
    "--sandbox",
    name,
    "--host",
    "ollama.com",
    "--env",
    "OLLAMA_CLOUD_V41_API_KEY",
    "--command",
    keyCmd!,
  ]);
  if (!set.ok) throw new Error(`sbx secret set-custom failed: ${set.err || set.out}`);
  const m = (set.out + set.err).match(/sbx-cs-[A-Za-z0-9]+/);
  if (!m) throw new Error(`could not parse the secret placeholder from: ${set.out}`);
  return m[0];
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

  // Finding 7: check 1 must be a REAL oracle, not `length >= 0`.
  assert(sbxList(realSbxCli).ok, "`sbx ls --json` succeeded (sbx is reachable and logged in)");
  const outputRoot = join(dir, "runs");

  // 0. Create the real clone-mode sandbox first, so the provider can be set up.
  const binding = ensureTaskSandbox(db, task.id, { source: repo, agent });
  sandboxName = binding.name;
  console.log(`  ... sandbox ${binding.name} (workspace ${binding.workspace})`);
  const version = sandboxDshVersion(realSbxCli, binding.name, { workdir: binding.workspace });
  assert(version !== null, `dsh is present inside the sandbox (${version})`);

  let placeholder: string | null = null;
  if (keyCmd) {
    placeholder = installProvider(binding.name, binding.workspace);
    assert(placeholder.startsWith("sbx-cs-"), `provider credential proxy installed (${placeholder})`);
  }

  // 1. Run a real dsh inside the sandbox.
  const launched = await launchTaskSandboxRun(db, task.id, {
    source: repo,
    agent,
    outputRoot,
    timeoutMs: 10 * 60_000,
    ...(placeholder ? { dshArgs: ["--patch", patchPath], env: { OLLAMA_CLOUD_V41_API_KEY: placeholder } } : {}),
  });
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

  if (run.state === "exited") {
    // 2. The produced commit reached the host, is a real commit, and is submittable.
    const fetched = fetchSandboxHead(launched.sandbox.source, sandboxName, launched.sandbox.branch);
    assert(fetched.ok && fetched.sha === run.head_sha, `produced commit fetched to the host (${fetched.sha?.slice(0, 12)})`);
    const kind = execFileSync("git", ["-C", repo, "cat-file", "-t", run.head_sha!], { encoding: "utf8" }).trim();
    assert(kind === "commit", "the fetched head is a real commit object");
    acceptSandboxSubmission(db, { runId: run.id });
    assert(getTask(db, task.id)!.phase !== "implement", "the structured submission advanced the Task");
  } else if (keyCmd) {
    // A configured provider must produce a commit; a failure is a real defect.
    fail(`a provider was configured but the real dsh Run did not exit 0: ${run.error ?? "?"}`);
  } else {
    console.log(`  ... no provider configured; the model call failed as expected (${run.error ?? "?"})`);
    console.log("  ... set RELAY_SANDBOX_KEY_CMD to assert the exited -> fetch -> submit path");
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
