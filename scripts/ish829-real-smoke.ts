#!/usr/bin/env bun
/**
 * ISH-829 — REAL Coding Sandbox VERIFY smoke (opt-in, requires a logged-in `sbx`).
 *
 *   RELAY_SANDBOX_SMOKE=1 bun scripts/ish829-real-smoke.ts
 *
 * Creates a throwaway main checkout, has `sbx create --clone` make a REAL clone-
 * mode sandbox, and drives the ISH-829 VERIFY boundary (`evidenceSandboxRunner` +
 * `realSandboxExec`) against it:
 *
 *   - a check runs INSIDE the clone (a home-dir sentinel it writes exists in the
 *     sandbox and NOT on the host);
 *   - a HEAD that is not the bound head is `not_run` (never a PASS);
 *   - a DIRTY clone is `not_run`; a check that dirties the tree is `inconclusive`;
 *   - a non-zero exit is `fail`; a timeout is `not_run`;
 *   - the per-check evidence (stdout/stderr/exit/HEAD/required count) is written.
 *
 * The Shared-Lab half (`labctl deploy/inspect --json/destroy`) runs only when
 * `LABCTL_API` is set. Lab credentials are forwarded EXPLICITLY into the sandbox
 * via `sandboxLabctl(..., env)` (`LABCTL_TOKEN`, or `LABCTL_USER`+`LABCTL_PASSWORD`)
 * and are never logged. A deployed lab is ALWAYS destroyed (a failure throws, so
 * the `finally` blocks run). The NOS image cache is never touched (`destroy`,
 * never `purge`/image verbs).
 *
 * Exits non-zero on the first failed assertion. Nothing is invented: every
 * assertion reads a real process result.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { realSbxCli, sbxCreateArgv, sbxExecArgv } from "../src/sandbox";
import { realSandboxExec, evidenceSandboxRunner, sandboxCommandRunner, sandboxLabctl, jsonlEvidenceSink, type SandboxCheckEvidence } from "../src/sandbox-verify";
import { deployTaskLab, destroyTaskLab, inspectTaskLab, type LabTask } from "../src/lab";

if (process.env.RELAY_SANDBOX_SMOKE !== "1") {
  console.error("refusing to run: set RELAY_SANDBOX_SMOKE=1 (this creates real Docker Sandboxes)");
  process.exit(2);
}

let steps = 0;
function ok(msg: string): void {
  steps++;
  console.log(`  ok ${steps}. ${msg}`);
}
function assert(cond: unknown, msg: string): void {
  if (cond) ok(msg);
  else throw new Error(msg);
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

/** The Lab credential env forwarded into the sandbox (never logged). */
function labEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.LABCTL_TOKEN) env.LABCTL_TOKEN = process.env.LABCTL_TOKEN;
  if (process.env.LABCTL_USER) env.LABCTL_USER = process.env.LABCTL_USER;
  if (process.env.LABCTL_PASSWORD) env.LABCTL_PASSWORD = process.env.LABCTL_PASSWORD;
  return env;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "relay-ish829-real-"));
  const repo = join(dir, "repo");
  const name = `relay-ish829-real-${Date.now().toString(36)}`;
  const evidencePath = join(dir, "sandbox-verify.jsonl");
  // A sentinel a HOST `bash -lc` would create at `$HOME/<base>`; a sandbox-only
  // run must leave the HOST one absent (the sandbox's own `$HOME` is different).
  const sentinelBase = `ISH829_HOST_SENTINEL_${process.pid}`;
  const hostSentinel = join(homedir(), sentinelBase);
  rmSync(hostSentinel, { force: true });
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
  if (!created.ok) throw new Error(`sbx create failed: ${created.err || created.out}`);
  ok(`created clone-mode sandbox ${name}`);

  let deployedLab: { labctl: ReturnType<typeof sandboxLabctl>; lab: string; api: string; insecure: boolean } | null = null;
  try {
    // The clone mirrors the host path (ISH-822/828): the workspace is `repo`.
    const workspace = repo;
    const inVmHead = realSbxCli.run(sbxExecArgv(name, ["git", "rev-parse", "HEAD"], { workdir: workspace }));
    assert(inVmHead.ok && inVmHead.out.trim() === head, `clone HEAD matches the host HEAD (${inVmHead.out.trim().slice(0, 12)})`);

    const evidence: SandboxCheckEvidence[] = [];
    const checks = [
      { name: "in-sbx", command: `echo INSIDE && touch "$HOME/${sentinelBase}"`, required: true },
      { name: "exit3", command: "exit 3", required: true },
      { name: "timeout", command: "sleep 20", required: true, timeoutMs: 800 },
      { name: "dirty", command: `echo x > dirty.txt`, required: true },
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
    assert(!existsSync(hostSentinel), `the command did NOT escape to the host (host-home sentinel absent)`);
    const inSbx = realSbxCli.run(sbxExecArgv(name, ["bash", "-lc", `test -f "$HOME/${sentinelBase}"`], { workdir: workspace }));
    assert(inSbx.ok, `the sentinel file IS inside the sandbox's home`);

    const bad = await runner.run(checks[1], { cwd: workspace });
    assert(bad.outcome === "fail" && bad.exitCode === 3, `a non-zero exit is a FAIL (exit 3)`);

    const slow = await runner.run(checks[2], { cwd: workspace });
    assert(slow.outcome === "not_run" && slow.timedOut === true, `a timeout is NOT_RUN (never a PASS)`);

    // A check that leaves the clone dirty is INCONCLUSIVE (never a PASS), and a
    // following check on the now-dirty clone is NOT_RUN.
    const dirtied = await runner.run(checks[3], { cwd: workspace });
    assert(dirtied.outcome === "inconclusive", `a check that DIRTIES the tree is INCONCLUSIVE (never a PASS)`);
    const afterDirty = await runner.run({ name: "after-dirty", command: "true", required: true }, { cwd: workspace });
    assert(afterDirty.outcome === "not_run" && afterDirty.output.includes("dirty"), `a DIRTY clone is NOT_RUN (never a PASS)`);
    realSbxCli.run(sbxExecArgv(name, ["bash", "-lc", "git clean -fdq"], { workdir: workspace }));

    // A runner bound to a WRONG head must refuse before running anything.
    const wrong = sandboxCommandRunner({ sandbox: name, workspace, head: "0".repeat(40), exec: realSandboxExec });
    const mismatch = await wrong.run({ name: "mismatch", command: "true", required: true }, { cwd: workspace });
    assert(mismatch.outcome === "not_run" && mismatch.output.includes("!= bound head"), `a HEAD mismatch is NOT_RUN (never a PASS)`);

    const lines = readFileSync(evidencePath, "utf-8").trim().split("\n").filter(Boolean);
    assert(lines.length === evidence.length && evidence.length === 5, `evidence JSONL has one line per check (${evidence.length})`);
    const first = evidence[0];
    assert(first.requiredCount === 4 && first.boundHead === head && first.headBefore === head, `evidence carries HEAD + required check count`);

    // Optional Shared-Lab half (skipped when no Lab API is configured).
    const api = process.env.LABCTL_API;
    if (api) {
      const topo = process.env.LABCTL_TOPOLOGY;
      if (!topo) throw new Error("LABCTL_API is set but LABCTL_TOPOLOGY (path inside the clone) is not");
      const insecure = process.env.LABCTL_INSECURE === "1";
      const labctl = sandboxLabctl({ sandbox: name, workspace, exec: realSandboxExec }, labEnv());
      // The smoke itself is a Task for the ownership fence.
      const smokeTask: LabTask = { id: `smoke-${process.pid}`, issue_id: "ISH-829" };
      const dep = await deployTaskLab(labctl, smokeTask, { topology: topo, namespace: process.env.LABCTL_NAMESPACE, api, insecure });
      if (!dep.ok || !dep.lab) throw new Error(`labctl deploy failed: ${dep.error}`);
      // Remember the lab so the `finally` below ALWAYS destroys it (a later
      // failure must never leak a running lab).
      deployedLab = { labctl, lab: dep.lab, api, insecure };
      ok(`labctl deploy (in-sandbox) brought the lab up: ${dep.lab}`);
      const ins = await inspectTaskLab(labctl, smokeTask, { lab: dep.lab, api, reachHost: process.env.LABCTL_REACH_HOST });
      assert(ins.ok, `labctl inspect --json reported running nodes + a reachable endpoint`);
    } else {
      console.log("  ... Shared-Lab half SKIPPED (set LABCTL_API + LABCTL_TOPOLOGY to run it)");
    }
  } finally {
    // Always tear the lab down first (never leak it), then the sandbox.
    if (deployedLab) {
      try {
        const del = await destroyTaskLab(deployedLab.labctl, { id: `smoke-${process.pid}`, issue_id: "ISH-829" }, { lab: deployedLab.lab, api: deployedLab.api, insecure: deployedLab.insecure, allowForeign: true });
        if (del.ok) ok(`labctl destroy removed the lab (NOS image retained)`);
        else console.error(`  warn: labctl destroy failed: ${del.error}`);
      } catch (e) {
        console.error(`  warn: labctl destroy threw: ${String(e)}`);
      }
    }
    realSbxCli.run(["stop", name]);
    const rm = realSbxCli.run(["rm", "--force", name]);
    rmSync(hostSentinel, { force: true });
    rmSync(dir, { recursive: true, force: true });
    if (!rm.ok) console.error(`  warn: sbx rm failed: ${(rm.err || rm.out).slice(0, 200)}`);
  }

  console.log(`\nPASS — ${steps} checks`);
}

try {
  await main();
} catch (e) {
  console.error(`  FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
