#!/usr/bin/env bun
/**
 * ISH-829 — REAL Coding Sandbox VERIFY smoke (opt-in, requires a logged-in `sbx`).
 *
 *   RELAY_SANDBOX_SMOKE=1 bun scripts/ish829-real-smoke.ts
 *
 * Creates a throwaway main checkout, has `sbx create --clone` make a REAL clone-
 * mode sandbox, and drives the ISH-829 VERIFY boundary (`sandboxCommandRunner` +
 * `realSandboxExec`) against it:
 *
 *   - a check runs INSIDE the clone (a file it writes is in the clone, NOT on the
 *     host — the host sentinel stays absent);
 *   - a HEAD that is not the bound head is `not_run` (never a PASS);
 *   - a non-zero exit is `fail`; a timeout is `not_run`;
 *   - the per-check evidence (stdout/stderr/exit/HEAD/required count) is written.
 *
 * The Shared-Lab half (`labctl deploy/inspect --json/destroy`) runs only when
 * `LABCTL_API` is set, so this smoke is useful without a live Lab. The NOS image
 * cache is never touched (`destroy`, never `purge`/image verbs).
 *
 * Exits non-zero on the first failed assertion. Nothing is invented: every
 * assertion reads a real process result.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realSbxCli, sbxCreateArgv, sbxExecArgv } from "../src/sandbox";
import { realSandboxExec, evidenceSandboxRunner, sandboxCommandRunner, sandboxLabctl, jsonlEvidenceSink, type SandboxCheckEvidence } from "../src/sandbox-verify";
import { deployTaskLab, destroyTaskLab, inspectTaskLab } from "../src/lab";

if (process.env.RELAY_SANDBOX_SMOKE !== "1") {
  console.error("refusing to run: set RELAY_SANDBOX_SMOKE=1 (this creates real Docker Sandboxes)");
  process.exit(2);
}

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

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "relay-ish829-real-"));
  const repo = join(dir, "repo");
  const name = `relay-ish829-real-${Date.now().toString(36)}`;
  const evidencePath = join(dir, "sandbox-verify.jsonl");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "relay@test");
  git(repo, "config", "user.name", "relay-test");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "base");
  const head = git(repo, "rev-parse", "HEAD");
  console.log(`ISH-829 real sandbox smoke — repo ${repo}\n  head ${head}`);

  const created = realSbxCli.run(sbxCreateArgv({ name, agent: "shell", source: repo }));
  if (!created.ok) fail(`sbx create failed: ${created.err || created.out}`);
  ok(`created clone-mode sandbox ${name}`);

  try {
    // The clone mirrors the host path (ISH-822/828): the workspace is `repo`.
    const workspace = repo;
    const inVmHead = realSbxCli.run(sbxExecArgv(name, ["git", "rev-parse", "HEAD"], { workdir: workspace }));
    assert(inVmHead.ok && inVmHead.out.trim() === head, `clone HEAD matches the host HEAD (${inVmHead.out.trim().slice(0, 12)})`);

    // A host sentinel that a HOST `bash -lc` would create; a sandbox-only run
    // must leave it absent.
    const hostSentinel = join(repo, "HOST_SENTINEL");
    const evidence: SandboxCheckEvidence[] = [];
    const checks = [
      { name: "in-sbx", command: `echo INSIDE > in-sbx.txt && cat in-sbx.txt && touch ${hostSentinel} || true`, required: true },
      { name: "exit3", command: "exit 3", required: true },
      { name: "timeout", command: "sleep 20", required: true, timeoutMs: 800 },
    ];
    const runner = evidenceSandboxRunner(
      { sandbox: name, workspace, head, exec: realSandboxExec },
      checks,
      (e) => {
        evidence.push(e);
        jsonlEvidenceSink(evidencePath)(e);
      }
    );

    const pass = await runner.run(checks[0], { cwd: workspace });
    assert(pass.outcome === "pass" && pass.exitCode === 0, `a check runs inside the clone (exit 0)`);
    assert(pass.sandbox === name && pass.head === head, `the check is labelled with its sandbox + bound HEAD`);
    assert(!existsSync(hostSentinel), `the command did NOT escape to the host (host sentinel absent)`);

    const inClone = realSbxCli.run(sbxExecArgv(name, ["cat", "in-sbx.txt"], { workdir: workspace }));
    assert(inClone.ok && inClone.out.includes("INSIDE"), `the file it wrote is IN the clone`);
    assert(!existsSync(join(repo, "in-sbx.txt")), `the file is NOT on the host`);

    const bad = await runner.run(checks[1], { cwd: workspace });
    assert(bad.outcome === "fail" && bad.exitCode === 3, `a non-zero exit is a FAIL (exit 3)`);

    const slow = await runner.run(checks[2], { cwd: workspace });
    assert(slow.outcome === "not_run" && slow.timedOut === true, `a timeout is NOT_RUN (never a PASS)`);

    // A runner bound to a WRONG head must refuse before running anything.
    const wrong = sandboxCommandRunner({ sandbox: name, workspace, head: "0".repeat(40), exec: realSandboxExec });
    const mismatch = await wrong.run({ name: "mismatch", command: "true", required: true }, { cwd: workspace });
    assert(mismatch.outcome === "not_run" && mismatch.output.includes("!= bound head"), `a HEAD mismatch is NOT_RUN (never a PASS)`);

    const lines = readFileSync(evidencePath, "utf-8").trim().split("\n").filter(Boolean);
    assert(lines.length === evidence.length && evidence.length === 3, `evidence JSONL has one line per check (${evidence.length})`);
    const first = evidence[0];
    assert(first.requiredCount === 3 && first.boundHead === head && first.headBefore === head, `evidence carries HEAD + required check count`);

    // Optional Shared-Lab half (skipped when no Lab API is configured).
    const api = process.env.LABCTL_API;
    if (api) {
      const labctl = sandboxLabctl({ sandbox: name, workspace, exec: realSandboxExec });
      const topo = process.env.LABCTL_TOPOLOGY;
      if (!topo) fail("LABCTL_API is set but LABCTL_TOPOLOGY (path inside the clone) is not");
      const dep = await deployTaskLab(labctl, { topology: topo, namespace: process.env.LABCTL_NAMESPACE, api, insecure: process.env.LABCTL_INSECURE === "1" });
      assert(dep.ok, `labctl deploy (in-sandbox) brought the lab up: ${dep.lab ?? dep.error}`);
      const ins = await inspectTaskLab(labctl, { lab: dep.lab!, api, reachHost: process.env.LABCTL_REACH_HOST });
      assert(ins.ok, `labctl inspect --json reported running nodes + a reachable endpoint`);
      const del = await destroyTaskLab(labctl, { lab: dep.lab!, api, insecure: process.env.LABCTL_INSECURE === "1" });
      assert(del.ok, `labctl destroy removed the lab (NOS image retained)`);
    } else {
      console.log("  ... Shared-Lab half SKIPPED (set LABCTL_API + LABCTL_TOPOLOGY to run it)");
    }
  } finally {
    realSbxCli.run(["stop", name]);
    const rm = realSbxCli.run(["rm", "--force", name]);
    rmSync(dir, { recursive: true, force: true });
    if (!rm.ok) console.error(`  warn: sbx rm failed: ${(rm.err || rm.out).slice(0, 200)}`);
  }

  console.log(`\nPASS — ${steps} checks`);
}

await main();
