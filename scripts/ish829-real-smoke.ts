#!/usr/bin/env bun
/**
 * ISH-829 — REAL Coding Sandbox VERIFY + Shared-Lab smoke (opt-in).
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
 * The throwaway repo ALWAYS carries the pieces the Shared-Lab half needs:
 *   - `labs/labctl/labctl.py`  (copied from `LABCTL_SRC`, or auto-discovered);
 *   - `labs/ish829-smoke/smoke.clab.yml` with `name:` == `labNameForTask(smokeTask)`
 *     == `netlab-<owner>` (the ISH-845 identity) for a FIXED smoke Task
 *     `{id, created_at}`, deployed with `--namespace = labNamespaceForTask(...)`.
 * Both are committed BEFORE `sbx create`, so the clone starts CLEAN.
 *
 * The Shared-Lab half (`labctl deploy/inspect --json/destroy`) runs only when
 * `LABCTL_API` is set. It installs+asserts `labctl` INSIDE the sandbox (the Coding
 * Kit does this too; the explicit install makes the smoke self-contained), forwards
 * credentials via `sbx exec -e` (`LABCTL_TOKEN`, or `LABCTL_USER`+`LABCTL_PASSWORD`,
 * never logged), and the cleanup is FAIL-CLOSED: a *partial* deploy is recorded and
 * destroyed, a failed `destroy`/`sbx rm` sets a non-zero exit and SUPPRESSES PASS.
 * The NOS image cache is never touched (`destroy`, never `purge`/image verbs).
 *
 * Environment:
 *   RELAY_SANDBOX_AGENT   sandbox agent/kit (default `shell`; set to
 *                         `$PWD/sandbox/coding-kit` for the full Coding Kit)
 *   LABCTL_API            enable the Shared-Lab half (e.g. https://host.docker.internal:49170)
 *   LABCTL_SRC            host path to `labctl.py` copied into the clone
 *   LABCTL_INSECURE=1     PoC self-signed TLS opt-in
 *   LABCTL_TOKEN | (LABCTL_USER + LABCTL_PASSWORD)   Lab credentials (in-sandbox)
 *   LABCTL_IMAGE          NOS image (default ghcr.io/nokia/srlinux:latest)
 *   LABCTL_GNMI_HOST_PORT Lab-host gNMI port published for srl1 (default 18002)
 *
 * Nothing is invented: every assertion reads a real process result.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bashLc, realSbxCli, sbxCreateArgv, sbxExecArgv } from "../src/sandbox";
import { realSandboxExec, evidenceSandboxRunner, sandboxCommandRunner, sandboxLabctl, jsonlEvidenceSink, type SandboxCheckEvidence } from "../src/sandbox-verify";
import { deployTaskLab, destroyTaskLab, inspectTaskLab, labNameForTask, labNamespaceForTask, labctlInspectArgv, type LabTask } from "../src/lab";

if (process.env.RELAY_SANDBOX_SMOKE !== "1") {
  console.error("refusing to run: set RELAY_SANDBOX_SMOKE=1 (this creates real Docker Sandboxes)");
  process.exit(2);
}

/** A FIXED smoke Task identity (id + created_at), so the ISH-845 owner id — and the checked-in topology `name:` — is stable. */
const SMOKE_TASK: LabTask = { id: "ish829-smoke", created_at: 1_700_000_000_000 };
const SMOKE_LAB = labNameForTask(SMOKE_TASK);
const SMOKE_NAMESPACE = labNamespaceForTask(SMOKE_TASK);

let steps = 0;
let cleanupFailed = false;
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

function findLabctlSrc(): string | null {
  if (process.env.LABCTL_SRC) return existsSync(process.env.LABCTL_SRC) ? process.env.LABCTL_SRC : null;
  const guesses = [
    join(homedir(), "ghq/github.com/81ueman/ishiul/labs/labctl/labctl.py"),
    join(process.cwd(), "labs/labctl/labctl.py"),
  ];
  return guesses.find((p) => existsSync(p)) ?? null;
}

/**
 * Install `labctl` (idempotent) and assert it is RUNNABLE inside the sandbox, with
 * PyYAML available (`deploy` fails closed without it). Throws on any failure — the
 * smoke must never proceed to deploy with a missing/broken labctl.
 */
function ensureLabctl(name: string, workspace: string): void {
  const script = [
    "set -e",
    "if ! command -v labctl >/dev/null 2>&1; then",
    "  if [ -f labs/labctl/labctl.py ]; then",
    "    sudo install -m 0755 labs/labctl/labctl.py /usr/local/bin/labctl",
    "  else",
    '    echo "labctl.py missing in the clone; set LABCTL_SRC and re-run" >&2; exit 3',
    "  fi",
    "fi",
    "command -v labctl >/dev/null",
    "if ! python3 -c 'import yaml' >/dev/null 2>&1; then",
    "  sudo apt-get update -qq >/dev/null 2>&1 || true",
    "  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-yaml >/dev/null 2>&1 || python3 -m pip install --quiet pyyaml >/dev/null 2>&1 || true",
    "fi",
    "python3 -c 'import yaml' >/dev/null 2>&1",
    "labctl --help >/dev/null",
  ].join("\n");
  const r = realSbxCli.run(sbxExecArgv(name, bashLc(script), { workdir: workspace }));
  if (!r.ok) throw new Error(`labctl is not runnable in the sandbox: ${(r.err || r.out).slice(0, 400)}`);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "relay-ish829-real-"));
  const repo = join(dir, "repo");
  const name = `relay-ish829-real-${Date.now().toString(36)}`;
  const evidencePath = join(dir, "sandbox-verify.jsonl");
  const sentinelBase = `ISH829_HOST_SENTINEL_${process.pid}`;
  const hostSentinel = join(homedir(), sentinelBase);
  const api = process.env.LABCTL_API;
  rmSync(hostSentinel, { force: true });

  // --- throwaway main checkout, with the Shared-Lab pieces committed ---------
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "relay@test");
  git(repo, "config", "user.name", "relay-test");
  writeFileSync(join(repo, "README.md"), "base\n");

  const labctlSrc = findLabctlSrc();
  if (labctlSrc) {
    mkdirSync(join(repo, "labs", "labctl"), { recursive: true });
    writeFileSync(join(repo, "labs", "labctl", "labctl.py"), readFileSync(labctlSrc));
  }
  const topoDir = join(repo, "labs", "ish829-smoke");
  mkdirSync(topoDir, { recursive: true });
  const image = process.env.LABCTL_IMAGE ?? "ghcr.io/nokia/srlinux:latest";
  const gnmiPort = process.env.LABCTL_GNMI_HOST_PORT ?? "18002";
  writeFileSync(
    join(topoDir, "smoke.clab.yml"),
    [
      `name: ${SMOKE_LAB}`,
      "topology:",
      "  nodes:",
      "    srl1:",
      "      kind: nokia_srlinux",
      "      type: ixrd3",
      `      image: ${image}`,
      "      ports:",
      `        - "${gnmiPort}:57400"`,
      "",
    ].join("\n")
  );
  git(repo, "add", "README.md", "labs");
  git(repo, "commit", "-q", "-m", "smoke: labctl + a Task-named SR Linux topology");
  const head = git(repo, "rev-parse", "HEAD");
  console.log(`ISH-829 real sandbox smoke — repo ${repo}\n  head ${head}\n  smoke lab: ${SMOKE_LAB}`);

  if (api && !labctlSrc) {
    throw new Error("LABCTL_API is set but no labctl.py was found; set LABCTL_SRC to a labs/labctl/labctl.py");
  }

  const agent = process.env.RELAY_SANDBOX_AGENT ?? "shell";
  const created = realSbxCli.run(sbxCreateArgv({ name, agent, source: repo }));
  if (!created.ok) throw new Error(`sbx create failed: ${created.err || created.out}`);
  ok(`created clone-mode sandbox ${name} (agent ${agent})`);

  let deployedLab: { lab: string } | null = null;
  try {
    // The clone mirrors the host path (ISH-822/828): the workspace is `repo`.
    const workspace = repo;
    const inVmHead = realSbxCli.run(sbxExecArgv(name, ["git", "rev-parse", "HEAD"], { workdir: workspace }));
    assert(inVmHead.ok && inVmHead.out.trim() === head, `clone HEAD matches the host HEAD (${inVmHead.out.trim().slice(0, 12)})`);
    const cloneClean = realSbxCli.run(sbxExecArgv(name, bashLc("test -z \"$(git status --porcelain --untracked-files=all)\""), { workdir: workspace }));
    assert(cloneClean.ok, `clone starts CLEAN (the topology + labctl are committed)`);

    // --- Coding Sandbox VERIFY ------------------------------------------------
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
    const inSbx = realSbxCli.run(sbxExecArgv(name, bashLc(`test -f "$HOME/${sentinelBase}"`), { workdir: workspace }));
    assert(inSbx.ok, `the sentinel file IS inside the sandbox's home`);

    const bad = await runner.run(checks[1], { cwd: workspace });
    assert(bad.outcome === "fail" && bad.exitCode === 3, `a non-zero exit is a FAIL (exit 3)`);

    const slow = await runner.run(checks[2], { cwd: workspace });
    assert(slow.outcome === "not_run" && slow.timedOut === true, `a timeout is NOT_RUN (never a PASS)`);

    const dirtied = await runner.run(checks[3], { cwd: workspace });
    assert(dirtied.outcome === "inconclusive", `a check that DIRTIES the tree is INCONCLUSIVE (never a PASS)`);
    const afterDirty = await runner.run({ name: "after-dirty", command: "true", required: true }, { cwd: workspace });
    assert(afterDirty.outcome === "not_run" && afterDirty.output.includes("dirty"), `a DIRTY clone is NOT_RUN (never a PASS)`);
    realSbxCli.run(sbxExecArgv(name, bashLc("git clean -fdq"), { workdir: workspace }));

    const wrong = sandboxCommandRunner({ sandbox: name, workspace, head: "0".repeat(40), exec: realSandboxExec });
    const mismatch = await wrong.run({ name: "mismatch", command: "true", required: true }, { cwd: workspace });
    assert(mismatch.outcome === "not_run" && mismatch.output.includes("!= bound head"), `a HEAD mismatch is NOT_RUN (never a PASS)`);

    const lines = readFileSync(evidencePath, "utf-8").trim().split("\n").filter(Boolean);
    assert(lines.length === evidence.length && evidence.length === 5, `evidence JSONL has one line per check (${evidence.length})`);
    const first = evidence[0];
    assert(first.requiredCount === 4 && first.boundHead === head && first.headBefore === head, `evidence carries HEAD + required check count`);

    // --- Shared-Lab half (opt-in) ---------------------------------------------
    if (api) {
      // The sandbox may only reach the Lab host's PUBLISHED ports; allow exactly
      // the API port and the node gNMI port (never a bare host wildcard). For the
      // Coding Kit the equivalent allowlist is already in its spec.
      const u = new URL(api);
      const apiPort = u.port || (u.protocol === "https:" ? "443" : "80");
      const gnmi = process.env.LABCTL_GNMI_HOST_PORT ?? "18002";
      const targets = ["host.docker.internal", "localhost"].flatMap((h) => [`${h}:${apiPort}`, `${h}:${gnmi}`]).join(",");
      const policy = realSbxCli.run(["policy", "allow", "network", "--sandbox", name, targets]);
      if (policy.ok) ok(`allowed the sandbox to reach the Lab (${targets})`);
      else console.error(`  warn: sbx policy allow network failed: ${(policy.err || policy.out).slice(0, 200)}`);

      ensureLabctl(name, workspace);
      ok(`labctl is installed and runnable inside the sandbox`);

      const insecure = process.env.LABCTL_INSECURE === "1";
      const labctl = sandboxLabctl({ sandbox: name, workspace, exec: realSandboxExec }, labEnv());
      const topology = "labs/ish829-smoke/smoke.clab.yml"; // clone-relative
      // (d) The lab name is DETERMINISTIC (`netlab-<owner>`), so record it BEFORE
      // deploying: whatever happens (partial create, timeout, a live lab from an
      // earlier run at exit 6, a Bun-side spawn error) `finally` always destroys
      // it. Never leak a labctl-reported-or-created lab.
      deployedLab = { lab: SMOKE_LAB };
      const dep = await deployTaskLab(labctl, SMOKE_TASK, {
        topology,
        namespace: SMOKE_NAMESPACE,
        api,
        insecure,
      });
      if (dep.lab) deployedLab = { lab: dep.lab };
      if (!dep.ok) throw new Error(`labctl deploy failed: ${dep.error}`);
      ok(`labctl deploy (in-sandbox) brought the lab up: ${dep.lab} (nodes running)`);

      const ins = await inspectTaskLab(labctl, SMOKE_TASK, { lab: dep.lab!, api, insecure, reachHost: process.env.LABCTL_REACH_HOST });
      if (!ins.ok) throw new Error(`labctl inspect failed: ${ins.error}`);
      const endpoints = ins.inspect.nodes.flatMap((n) => n.endpoints).filter((e) => e.reachableAt);
      ok(`labctl inspect --json reported running nodes + ${endpoints.length} reachable management endpoint(s)`);

      // A REAL SR Linux read-back: run the on-node CLI from the Coding Sandbox
      // (through the Lab API). This is the NOS read-back the ticket asks for.
      const rb = await labctl.run(
        ["exec", "--json", "--api", api, ...(insecure ? ["--insecure"] : []), `${dep.lab}/srl1`, "--", "sr_cli", "-c", "show version"],
        { timeoutMs: 60_000 }
      );
      const versionLine = rb.out.split("\n").find((l) => /SRLinux|Version/i.test(l))?.trim() ?? rb.out.trim().slice(0, 80);
      if (!rb.ok || !/SRLinux|Version|v2\d/i.test(rb.out)) throw new Error(`SR Linux read-back failed (exit ${rb.code}): ${(rb.err || rb.out).slice(0, 200)}`);
      ok(`real SR Linux read-back from the sandbox: ${versionLine}`);
    } else {
      console.log("  ... Shared-Lab half SKIPPED (set LABCTL_API; see the header for credentials)");
    }
  } finally {
    // FAIL-CLOSED cleanup: any failure here is a non-PASS, and a deterministic
    // lab is always destroyed first (never leaked), then the sandbox.
    if (deployedLab) {
      try {
        const cleanupLabctl = sandboxLabctl({ sandbox: name, workspace: repo, exec: realSandboxExec }, labEnv());
        const insecure = process.env.LABCTL_INSECURE === "1";
        const del = await destroyTaskLab(cleanupLabctl, SMOKE_TASK, { lab: deployedLab.lab, api: api!, insecure });
        if (del.ok) {
          ok(`labctl destroy removed the lab (NOS image retained)`);
        } else if (del.code === 6) {
          // EXIT_NOTFOUND: the lab (or its workspace dir) is already gone. Confirm
          // with a raw inspect — only a conclusive "no such lab" is a clean cleanup.
          const ins = await cleanupLabctl.run(labctlInspectArgv({ lab: deployedLab.lab, api: api!, insecure }));
          if (ins.code === 6) {
            ok(`lab ${deployedLab.lab} was already absent (nothing to destroy)`);
          } else {
            cleanupFailed = true;
            console.error(`  CLEANUP FAILURE: destroy said not-found but inspect did not confirm absence (exit ${ins.code})`);
          }
        } else {
          cleanupFailed = true;
          console.error(`  CLEANUP FAILURE: labctl destroy failed: ${del.error}`);
        }
      } catch (e) {
        cleanupFailed = true;
        console.error(`  CLEANUP FAILURE: labctl destroy threw: ${String(e)}`);
      }
    }
    realSbxCli.run(["stop", name]);
    const rm = realSbxCli.run(["rm", "--force", name]);
    if (!rm.ok) {
      cleanupFailed = true;
      console.error(`  CLEANUP FAILURE: sbx rm failed: ${(rm.err || rm.out).slice(0, 200)}`);
    }
    rmSync(hostSentinel, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  await main();
  if (cleanupFailed) {
    console.error("\nFAIL — cleanup did not succeed (never a PASS)");
    process.exitCode = 1;
  } else {
    console.log(`\nPASS — ${steps} checks`);
  }
} catch (e) {
  console.error(`  FAIL: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
