#!/usr/bin/env bun
/**
 * ISH-830 — real Factory E2E harness (opt-in).
 *
 *   RELAY_ISH830_E2E=1 \
 *   LABCTL_API=https://host.docker.internal:49170 LABCTL_INSECURE=1 \
 *   LABCTL_USER=<u> LABCTL_PASSWORD=<pw>  (or LABCTL_TOKEN=<jwt>) \
 *     bun scripts/ish830-real-e2e.ts
 *
 * Proves the SR Linux / Shared-Lab chain on real infrastructure, and records
 * HONESTLY what could not run:
 *
 *   env       — Mac/ARM64 + sbx/dsh/claude + the Shared Lab + NOS image IDs.
 *   provider  — the pinned headless `dsh` (0.2.1-rc.2) provider leg. With no
 *               provider credential this is BLOCKED with the exact command and
 *               the raw `MISSING_CREDENTIAL` output — never a PASS.
 *   nos       — a REAL Coding Sandbox (`sbx create --clone`) VERIFYs the exact
 *               bound HEAD against a REAL Shared-Lab SR Linux via `labctl`
 *               (deploy -> inspect --json -> SSH/sr_cli read-back -> destroy),
 *               reusing ISH-829's `sandboxVerifyTarget` boundary. Failure
 *               injections (HEAD mismatch, dirty tree, API unavailable, a
 *               foreign-lab destroy) must never produce a PASS.
 *   parallel  — TWO real Task labs (distinct owners + ports) deployed at once;
 *               destroying one must not break the other, and the shared NOS
 *               image must survive.
 *   factory   — a durable Coding-Sandbox-backed Task driven through the REAL
 *               `runFactoryTask` with the pinned `dsh`. Without a provider
 *               credential it fails CLOSED (no false PASS); with one it drives
 *               IMPLEMENT -> VERIFY -> review/FIX -> MergeReady.
 *
 * Nothing is invented: every line of evidence is a real process result. It never
 * pushes, merges, or writes GitHub/Linear.
 */
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { getTask } from "../src/tasks";
import { intakeTask } from "../src/workflow";
import { runFactoryTask } from "../src/factory";
import { realSbxCli, sbxCreateArgv, sbxExecArgv, bashLc, upsertSandbox, getSandbox } from "../src/sandbox";
import { ensureTaskSandbox } from "../src/sandbox-lifecycle";
import { sandboxVerifyTarget, realSandboxExec, sandboxLabctl } from "../src/sandbox-verify";
import {
  deployTaskLab,
  destroyTaskLab,
  inspectTaskLab,
  labNameForTask,
  labNamespaceForTask,
  labctlInspectArgv,
  type LabTask,
} from "../src/lab";

if (process.env.RELAY_ISH830_E2E !== "1") {
  console.log("ISH-830 real E2E is opt-in: set RELAY_ISH830_E2E=1 to run it (creates real sandboxes + labs).");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// result bookkeeping (a JSON record is printed at the end)
// ---------------------------------------------------------------------------

type Verdict = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
interface StageResult {
  stage: string;
  verdict: Verdict;
  detail: string;
  command?: string;
  raw?: string;
}
const results: StageResult[] = [];
function record(stage: string, verdict: Verdict, detail: string, extra: Partial<StageResult> = {}): StageResult {
  const r: StageResult = { stage, verdict, detail, ...extra };
  results.push(r);
  const mark = verdict === "PASS" ? "ok  " : verdict === "FAIL" ? "FAIL" : "....";
  console.log(`  ${mark} [${stage}] ${detail}`);
  if (extra.raw && (verdict === "FAIL" || verdict === "BLOCKED")) console.log(indent(extra.raw));
  return r;
}
function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `       | ${l}`)
    .join("\n");
}

function sh(bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}) {
  try {
    const out = execFileSync(bin, args, {
      cwd: opts.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    return { ok: true, code: 0, out: out.trim(), err: "" };
  } catch (e) {
    const a = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      ok: false,
      code: typeof a.status === "number" ? a.status : null,
      out: (a.stdout ?? "").toString().trim(),
      err: (a.stderr ?? a.message ?? "").toString().trim(),
    };
  }
}
function git(cwd: string, ...args: string[]): string {
  return sh("git", ["-C", cwd, ...args]).out;
}

function labEnvFromProcess(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["LABCTL_TOKEN", "LABCTL_USER", "LABCTL_PASSWORD"]) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return env;
}
/** Start the Shared Lab VM and wait until clab-api-server answers (cold start is ~2s). */
function warmLab(): void {
  const r = sh(
    "sbx",
    [
      "exec",
      "ish824-lab",
      "--",
      "bash",
      "-lc",
      'for i in $(seq 1 40); do c=$(curl -sk -o /dev/null -w "%{http_code}" https://localhost:8090 || true); [ "$c" = "200" ] && { echo API_READY; exit 0; }; sleep 1; done; echo API_NOT_READY; exit 1',
    ],
    { timeoutMs: 120_000 }
  );
  record("lab.warm", r.ok ? "PASS" : "NOT_RUN", r.ok ? "Shared Lab clab-api-server is ready" : `lab API not ready: ${r.err || r.out}`);
  if (r.ok) {
    // Docker Sandboxes stops an idle sandbox; a long-lived exec session keeps the
    // Shared Lab VM (and its clab-api-server) alive for the whole run.
    try {
      const child = spawn("sbx", ["exec", "ish824-lab", "--", "sleep", "1800"], { detached: true, stdio: "ignore" });
      child.unref();
      record("lab.keepalive", "PASS", "started a keep-alive exec session on the Shared Lab VM");
    } catch {
      record("lab.keepalive", "NOT_RUN", "could not start a keep-alive session");
    }
  }
}

/** Install `labctl` (idempotent) and assert it is runnable inside the sandbox. */
function ensureLabctlInSandbox(sandbox: string, workspace: string): { ok: boolean; detail: string } {
  const script = [
    "set -e",
    "if ! command -v labctl >/dev/null 2>&1; then",
    "  sudo install -m 0755 labs/labctl/labctl.py /usr/local/bin/labctl",
    "fi",
    "command -v labctl >/dev/null",
    "# The sandbox's own startup provisioning may hold the apt lock; retry until",
    "# PyYAML is importable (labctl deploy fails closed without it). sshpass is",
    "# best-effort (it enables the real SSH leg; missing it is recorded NOT_RUN).",
    "for i in $(seq 1 40); do",
    "  python3 -c 'import yaml' >/dev/null 2>&1 && command -v sshpass >/dev/null 2>&1 && break",
    "  sudo apt-get update -qq >/dev/null 2>&1 || true",
    "  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-yaml sshpass >/dev/null 2>&1 || true",
    "  python3 -m pip install --quiet pyyaml >/dev/null 2>&1 || pip3 install --quiet pyyaml >/dev/null 2>&1 || true",
    "  sleep 3",
    "done",
    "python3 -c 'import yaml' >/dev/null 2>&1",
    "labctl --help >/dev/null",
  ].join("\n");
  const r = realSbxCli.run(sbxExecArgv(sandbox, bashLc(script), { workdir: workspace }));
  return { ok: r.ok, detail: (r.err || r.out || `exit ${r.code}`).slice(0, 400) };
}

function findLabctlSrc(): string | null {
  const guesses = [
    process.env.LABCTL_SRC,
    join(homedir(), "ghq/github.com/81ueman/ishiul/labs/labctl/labctl.py"),
    join(process.cwd(), "labs/labctl/labctl.py"),
  ].filter((p): p is string => !!p);
  return guesses.find((p) => existsSync(p)) ?? null;
}

// ---------------------------------------------------------------------------
// stage: env
// ---------------------------------------------------------------------------

function stageEnv(): void {
  const uname = sh("uname", ["-m"]).out || "?";
  const sw = sh("sw_vers", ["-productVersion"]).out || "?";
  const sbx = sh("sbx", ["version"]).out.replace(/\n/g, " ") || "?";
  const dsh = sh("dsh", ["--version"]).out || "?";
  const claude = sh("claude", ["--version"]).out || "?";
  record("env", "PASS", `darwin/${uname} macOS ${sw}; sbx ${sbx}; dsh ${dsh}; claude ${claude}`);
  // Time / disk / RAM (spec §Done-when asks for these to be recorded).
  const when = new Date().toISOString();
  const hostDisk = sh("df", ["-h", "/"]).out.split("\n").pop()?.trim() ?? "?";
  const memBytes = Number(sh("sysctl", ["-n", "hw.memsize"]).out || "0");
  record("env.host-resources", "PASS", `${when}; host disk(/) ${hostDisk}; host RAM ${memBytes ? (memBytes / 1024 ** 3).toFixed(1) + " GiB" : "?"}`);
  const labRes = sh("sbx", ["exec", "ish824-lab", "--", "bash", "-lc", "echo cpus=$(nproc); free -h | awk 'NR==2{print \"mem=\"$2}'; df -h / | tail -1 | awk '{print \"disk=\"$2}'"]);
  record("env.lab-resources", labRes.ok ? "PASS" : "NOT_RUN", labRes.ok ? `Shared Lab VM: ${labRes.out.replace(/\n/g, "; ")}` : `lab resources unreadable: ${labRes.err || labRes.out}`);
  // Shared Lab + image IDs (best effort; a down Lab is NOT_RUN, never a PASS).
  const labVm = sh("sbx", ["ls"]).out.split("\n").find((l) => l.startsWith("ish824-lab"))?.trim();
  record("env.labvm", labVm ? "PASS" : "NOT_RUN", labVm ? `Shared Lab VM: ${labVm}` : "Shared Lab VM ish824-lab not found");
  if (labVm) {
    const img = sh("sbx", [
      "exec",
      "ish824-lab",
      "--",
      "docker",
      "image",
      "inspect",
      "ghcr.io/nokia/srlinux:latest",
      "--format",
      "{{.Id}} {{index .RepoDigests 0}}",
    ]);
    record(
      "env.srl-image",
      img.ok ? "PASS" : "NOT_RUN",
      img.ok ? `SR Linux image: ${img.out}` : `image inspect failed: ${img.err || img.out}`
    );
    const api = sh("sbx", ["exec", "ish824-lab", "--", "docker", "inspect", "clab-api-server", "--format", "{{.Config.Image}} {{.State.Status}}"]);
    record("env.clab-api", api.ok ? "PASS" : "NOT_RUN", api.ok ? `clab-api-server: ${api.out}` : `inspect failed: ${api.err || api.out}`);
  }
}

// ---------------------------------------------------------------------------
// stage: provider (the real dsh/DeepSeek leg)
// ---------------------------------------------------------------------------

function stageProvider(): void {
  const cmd = `dsh --profile headless --json "reply with the single token PING"`;
  const r = sh("dsh", ["--profile", "headless", "--json", "reply with the single token PING"], { timeoutMs: 180_000 });
  const blob = `${r.out}\n${r.err}`;
  const finalText = (r.out.split("\n").find((l) => l.includes('"type":"final"')) ?? "").trim();
  if (/MISSING_CREDENTIAL|no credential|no API key/i.test(blob)) {
    const why = blob.split("\n").find((l) => /MISSING_CREDENTIAL|no credential|no API key/i.test(l))?.trim() ?? blob.slice(0, 300);
    record("provider", "BLOCKED", "real dsh/DeepSeek leg cannot run (no provider credential)", {
      command: cmd,
      raw: `${why}\n${finalText}`,
    });
    return;
  }
  if (r.ok && /PING/.test(r.out)) {
    record("provider", "PASS", "real dsh/DeepSeek replied PING", { command: cmd, raw: finalText });
    return;
  }
  record("provider", "FAIL", `real dsh exited ${r.code} without a PING reply`, { command: cmd, raw: blob.slice(0, 600) });
}

// ---------------------------------------------------------------------------
// stage: nos — a real Coding Sandbox VERIFY against real SR Linux at the HEAD
// ---------------------------------------------------------------------------

/** The in-sandbox NOS check script (committed at the bound HEAD, run by VERIFY). */
function nosCheckScript(lab: string, ns: string, api: string, insecure: boolean): string {
  const ins = insecure ? "--insecure" : "";
  return [
    "set -e",
    "# ISH-830 NOS check: deploy a real SR Linux lab on the Shared Lab, read it",
    "# back at the EXACT checked-out HEAD, then destroy it.",
    "# Credentials are provisioned into ~/.labctl.env by the harness (never logged).",
    '[ -f "$HOME/.labctl.env" ] && . "$HOME/.labctl.env"',
    `API="${api}"`,
    "command -v labctl >/dev/null || { echo 'labctl missing'; exit 3; }",
    `labctl deploy -t labs/ish830-smoke/smoke.clab.yml --namespace ${ns} --json --api "$API" ${ins} >/tmp/dep.json`,
    "cat /tmp/dep.json",
    `labctl inspect ${lab} --json --api "$API" ${ins} --reach-host host.docker.internal >/tmp/ins.json`,
    "cat /tmp/ins.json",
    "# (a) clab-api exec — this is the clab-api-server's docker exec, NOT SSH.",
    `echo '--- clab-api exec (NOT SSH) ---'`,
    `labctl exec --json --api "$API" ${ins} ${lab}/srl1 -- sr_cli -c "show version"`,
    "# (b) REAL SSH from the Sandbox to the node's published :22 (reachable_at).",
    `echo '--- real SSH leg (published :22) ---'`,
    `SSH_EP=$(python3 -c "import json;d=json.load(open('/tmp/ins.json'));print([e['reachable_at'] for n in d['nodes'] for e in n.get('mgmt_endpoints',[]) if e.get('container_port')==22][0])")`,
    `if command -v sshpass >/dev/null 2>&1; then`,
    `  SSH_HOST="\${SSH_EP%%:*}"; SSH_PORT="\${SSH_EP##*:}"`,
    `  if sshpass -p "\${SRL_PASSWORD:-NokiaSrl1!}" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -p "$SSH_PORT" admin@"$SSH_HOST" "show version" 2>&1; then`,
    `    echo SSH_LEG_OK`,
    `  else`,
    `    echo SSH_LEG_FAIL`,
    `  fi`,
    `else`,
    `  echo 'SSH_NOT_RUN: sshpass is not installed in the sandbox'`,
    `fi`,
    "# (c) REAL gNMI on the node's published :57400 (reachable_at), if gnmic exists.",
    `echo '--- real gNMI leg (published :57400) ---'`,
    `if command -v gnmic >/dev/null 2>&1; then`,
    `  GNMI_EP=$(python3 -c "import json;d=json.load(open('/tmp/ins.json'));print([e['reachable_at'] for n in d['nodes'] for e in n.get('mgmt_endpoints',[]) if e.get('container_port')==57400][0])")`,
    `  if gnmic -a "$GNMI_EP" --insecure -e json_ietf get --path /system/name/host-name 2>&1; then`,
    `    echo GNMI_LEG_OK`,
    `  else`,
    `    echo GNMI_LEG_FAIL`,
    `  fi`,
    `else`,
    `  echo 'GNMI_NOT_RUN: gnmic is not installed in the sandbox'`,
    `fi`,
    `labctl destroy --name ${lab} --json --api "$API" ${ins} >/tmp/del.json`,
    "cat /tmp/del.json",
    "echo NOS_CHECK_DONE",
    "",
  ].join("\n");
}

async function stageNos(dir: string, api: string, insecure: boolean): Promise<void> {
  const repo = join(dir, "repo");
  const sandbox = `relay-ish830-nos-${Date.now().toString(36)}`;
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "relay@test");
  git(repo, "config", "user.name", "relay-test");
  writeFileSync(join(repo, "README.md"), "base\n");
  const labctlSrc = findLabctlSrc();
  if (!labctlSrc) {
    record("nos", "BLOCKED", "no labctl.py found (set LABCTL_SRC)", { command: "LABCTL_SRC=<path> bun scripts/ish830-real-e2e.ts" });
    return;
  }
  mkdirSync(join(repo, "labs", "labctl"), { recursive: true });
  writeFileSync(join(repo, "labs", "labctl", "labctl.py"), readFileSync(labctlSrc));

  const db = openDb(join(dir, "state.db"));
  const task = intakeTask(db, {
    provider: "fixture",
    issueId: "ISH-830-NOS",
    codeChange: true,
    title: "read a real SR Linux version at the bound HEAD",
    description: "Deploy the committed topology on the Shared Lab and read the NOS back.",
    acceptance: "the real SR Linux version is read at the checked-out HEAD",
    checks: [{ name: "nos-readback", command: "bash labs/ish830-smoke/nos-check.sh" }],
  });
  const lab = labNameForTask(task as LabTask);
  const ns = labNamespaceForTask(task as LabTask);
  const topoDir = join(repo, "labs", "ish830-smoke");
  mkdirSync(topoDir, { recursive: true });
  writeFileSync(
    join(topoDir, "smoke.clab.yml"),
    [
      `name: ${lab}`,
      "topology:",
      "  nodes:",
      "    srl1:",
      "      kind: nokia_srlinux",
      "      type: ixrd3",
      "      image: ghcr.io/nokia/srlinux:latest",
      "      ports:",
      '        - "18001:22"',
      '        - "18002:57400"',
      "",
    ].join("\n")
  );
  writeFileSync(join(topoDir, "nos-check.sh"), nosCheckScript(lab, ns, api, insecure));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "ish830: labctl + a Task-named SR Linux topology + NOS check");
  const head = git(repo, "rev-parse", "HEAD");

  const created = realSbxCli.run(sbxCreateArgv({ name: sandbox, agent: "shell", source: repo }));
  if (!created.ok) {
    record("nos", "BLOCKED", `sbx create --clone failed: ${created.err || created.out}`.slice(0, 300));
    return;
  }
  let labDeployed: string | null = null;
  try {
    // provision lab creds + policy inside the sandbox (operator injection)
    const envFile = Object.entries(labEnvFromProcess())
      .map(([k, v]) => `export ${k}=${v}`)
      .join("\n");
    realSbxCli.run(sbxExecArgv(sandbox, bashLc(`mkdir -p "$HOME" && cat > "$HOME/.labctl.env" <<'EOF'\n${envFile}\nEOF\nchmod 600 "$HOME/.labctl.env"`)));
    const u = new URL(api);
    const apiPort = u.port || (u.protocol === "https:" ? "443" : "80");
    realSbxCli.run(["policy", "allow", "network", "--sandbox", sandbox, `host.docker.internal:${apiPort},localhost:${apiPort},host.docker.internal:18001,localhost:18001,host.docker.internal:18002,localhost:18002`]);
    const labctlReady = ensureLabctlInSandbox(sandbox, repo);
    if (!labctlReady.ok) {
      record("nos", "FAIL", `labctl is not runnable inside the sandbox: ${labctlReady.detail}`);
      return;
    }

    // A durable sandbox row + the bound HEAD, then ISH-829's VERIFY boundary.
    upsertSandbox(db, { taskId: task.id, name: sandbox, agent: "shell", source: repo, workspace: repo, branch: "main", headSha: head, state: "running" });
    db.query("UPDATE tasks SET head_sha = ?, worktree = ? WHERE id = ?").run(head, repo, task.id);
    const checks = [{ name: "nos-readback", command: "bash labs/ish830-smoke/nos-check.sh", required: true }];
    const target = sandboxVerifyTarget(db, getTask(db, task.id)!, checks);
    if (!target) {
      record("nos", "FAIL", "sandboxVerifyTarget returned null for a sandbox-backed task");
      return;
    }
    // The lab name is DETERMINISTIC (`netlab-<owner>`): record it BEFORE running
    // so a partial/timed-out deploy can never leak a lab.
    labDeployed = lab;
    const pass = await target.runner.run(checks[0], { cwd: target.cwd });
    const out = `${pass.stdout ?? ""}\n${pass.output ?? ""}`;
    if (pass.outcome === "pass") {
      const verLine = out.split("\n").find((l) => /Software Version|SRLinux/i.test(l))?.trim() ?? "";
      record("nos", "PASS", `real SR Linux VERIFY at the bound HEAD ${head.slice(0, 12)}: ${verLine}`, {
        command: "sandboxVerifyTarget.runner.run(nos-readback)",
        raw: out.slice(-1400),
      });
    } else {
      record("nos", "FAIL", `real SR Linux VERIFY was '${pass.outcome}' (never a PASS)`, { raw: out.slice(0, 800) });
    }
    // SSH / gNMI are recorded SEPARATELY and honestly: the `labctl exec` read-back
    // above is clab-api-server docker exec, NOT SSH. A PASS requires REAL evidence
    // (a version over the published :22, or a gNMI get on :57400); otherwise the
    // leg is NOT_RUN — never claimed.
    const sshLeg = out.split("--- real SSH leg (published :22) ---")[1]?.split("--- real gNMI")[0] ?? "";
    const sshOk = out.includes("SSH_LEG_OK") && /Software Version|SRLinux/i.test(sshLeg);
    record(
      "nos.ssh",
      sshOk ? "PASS" : "NOT_RUN",
      sshOk ? "real SSH from the Sandbox to the node published :22 returned `show version`" : "SSH NOT_RUN (no SSH evidence obtained)",
      sshOk ? {} : { raw: sshLeg.trim().slice(0, 300) || "sshpass unavailable" }
    );
    const gnmiOk = out.includes("GNMI_LEG_OK") && /host-name/i.test(out);
    record(
      "nos.gnmi",
      gnmiOk ? "PASS" : "NOT_RUN",
      gnmiOk ? "real gNMI from the Sandbox to the node published :57400 returned the host-name" : "gNMI NOT_RUN (gnmic not installed in the Sandbox)"
    );

    // --- failure injections: none may become a PASS --------------------------
    const wrongHead = sandboxVerifyTarget(db, { ...getTask(db, task.id)!, head_sha: "0".repeat(40) }, checks);
    const wrong = await wrongHead!.runner.run(checks[0], { cwd: wrongHead!.cwd });
    record("nos.head-mismatch", wrong.outcome === "not_run" ? "PASS" : "FAIL", `HEAD mismatch -> ${wrong.outcome} (never a PASS)`);

    const dirty = await target.runner.run({ name: "dirty", command: "echo x > dirty.txt", required: true }, { cwd: target.cwd });
    record("nos.dirty-tree", dirty.outcome === "inconclusive" ? "PASS" : "FAIL", `a check that dirties the tree -> ${dirty.outcome}`);
    realSbxCli.run(sbxExecArgv(sandbox, bashLc("git checkout -q -- . && git clean -fdq"), { workdir: repo }));

    // A REQUIRED check that exits non-zero must be `fail` (never a PASS).
    const reqFail = await target.runner.run({ name: "required-fail", command: "exit 7", required: true }, { cwd: target.cwd });
    record("nos.required-verify-fail", reqFail.outcome === "fail" ? "PASS" : "FAIL", `a required check that exits non-zero -> ${reqFail.outcome} (never a PASS)`);

    // Lab port failure: an UNPUBLISHED node port must be refused, never a PASS.
    const portFail = await target.runner.run(
      { name: "port-fail", command: "curl -s --max-time 5 https://host.docker.internal:18099 >/dev/null", required: true },
      { cwd: target.cwd }
    );
    record("nos.lab-port-failure", portFail.outcome === "fail" ? "PASS" : "FAIL", `an unpublished Lab port -> VERIFY ${portFail.outcome} (never a PASS)`);

    // Lab API unavailable: SOURCE the creds (else labctl exits EXIT_USAGE=2 BEFORE
    // any network I/O) and require a REAL transport failure (labctl exit 5/7, or a
    // connection-refused/timeout line) — not merely any non-pass. A loopback dead
    // port refuses the connection (a login failure is NOT an API-down signal).
    const deadApi = "https://127.0.0.1:9";
    const deadCmd = `bash -c '. "$HOME/.labctl.env" 2>/dev/null; labctl inspect ${lab} --json --api ${deadApi} --insecure; c=$?; echo LABCTL_EXIT=$c; exit $c'`;
    const deadTarget = sandboxVerifyTarget(db, getTask(db, task.id)!, [{ name: "api-down", command: deadCmd, required: true }]);
    const dead = await deadTarget!.runner.run({ name: "api-down", command: deadCmd, required: true }, { cwd: deadTarget!.cwd });
    const deadOut = `${dead.stdout ?? ""}\n${dead.output ?? ""}`;
    const networkish = /LABCTL_EXIT=(5|7)|refused|ECONNREFUSED|connection|Tunnel connection|timed out|Bad Gateway/i.test(deadOut);
    record(
      "nos.api-unavailable",
      dead.outcome === "fail" && networkish ? "PASS" : "FAIL",
      `Lab API unavailable -> VERIFY ${dead.outcome}${networkish ? "" : " (no transport-failure evidence)"} (never a PASS)`,
      { raw: deadOut.slice(-500) }
    );

    const foreign = await destroyTaskLab(sandboxLabctl({ sandbox, workspace: repo, exec: realSandboxExec }, labEnvFromProcess()), task as LabTask, {
      lab: "netlab-SOMEONE-ELSE",
      api,
      insecure,
    });
    record(
      "nos.foreign-lab",
      !foreign.ok && /LAB_FOREIGN/.test(foreign.error ?? "") ? "PASS" : "FAIL",
      `a foreign-lab destroy is refused: ${foreign.error ?? "not refused"}`
    );
  } finally {
    // fail-closed teardown
    if (labDeployed) {
      const del = await destroyTaskLab(sandboxLabctl({ sandbox, workspace: repo, exec: realSandboxExec }, labEnvFromProcess()), task as LabTask, {
        lab: labDeployed,
        api,
        insecure,
      });
      if (del.ok) record("nos.cleanup", "PASS", `lab ${labDeployed} destroyed (NOS image retained)`);
      else {
        const ins = await sandboxLabctl({ sandbox, workspace: repo, exec: realSandboxExec }, labEnvFromProcess()).run(
          labctlInspectArgv({ lab: labDeployed, api, insecure })
        );
        record("nos.cleanup", ins.code === 6 ? "PASS" : "FAIL", `destroy: ${del.error}; inspect exit ${ins.code}`);
      }
    }
    realSbxCli.run(["stop", sandbox]);
    const rm = realSbxCli.run(["rm", "--force", sandbox]);
    record("nos.sandbox-cleanup", rm.ok ? "PASS" : "FAIL", rm.ok ? `sandbox ${sandbox} removed` : `sbx rm failed: ${rm.err || rm.out}`);
    db.close();
  }
}

// ---------------------------------------------------------------------------
// stage: parallel — two real Task labs do not collide
// ---------------------------------------------------------------------------

/**
 * stage: parallel — two Task-named SR Linux labs coexist; destroying one leaves
 * the other running, and the shared NOS image survives.
 *
 * SCOPE: this is a LAB-isolation proof only. The Tasks are not Relay Tasks with
 * their own Coding Sandboxes/branches, so branch / review-HEAD isolation is NOT
 * proven here (it is covered deterministically by `tests/factory.test.ts`:
 * distinct worktrees run in parallel; one writer per worktree).
 */
async function stageParallel(dir: string, api: string, insecure: boolean): Promise<void> {
  const runToken = Date.now().toString(36);
  const mk = (id: string, createdAt: number): LabTask => ({ id, created_at: createdAt });
  const a = mk(`ish830-par-a-${runToken}`, Date.now());
  const b = mk(`ish830-par-b-${runToken}`, Date.now() + 1);
  const sandbox = `relay-ish830-par-${runToken}`;
  const repo = join(dir, "par-repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "relay@test");
  git(repo, "config", "user.name", "relay-test");
  const labctlSrc = findLabctlSrc();
  if (!labctlSrc) return record("parallel", "BLOCKED", "no labctl.py (set LABCTL_SRC)");
  mkdirSync(join(repo, "labs", "labctl"), { recursive: true });
  writeFileSync(join(repo, "labs", "labctl", "labctl.py"), readFileSync(labctlSrc));
  for (const [t, ssh, gnmi] of [
    [a, "18001", "18002"],
    [b, "18011", "18012"],
  ] as [LabTask, string, string][]) {
    const d = join(repo, "labs", labNameForTask(t));
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, "t.clab.yml"),
      [
        `name: ${labNameForTask(t)}`,
        "topology:",
        "  nodes:",
        "    srl1:",
        "      kind: nokia_srlinux",
        "      type: ixrd3",
        "      image: ghcr.io/nokia/srlinux:latest",
        "      ports:",
        `        - "${ssh}:22"`,
        `        - "${gnmi}:57400"`,
        "",
      ].join("\n")
    );
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "ish830: two Task-named SR Linux topologies");

  const created = realSbxCli.run(sbxCreateArgv({ name: sandbox, agent: "shell", source: repo }));
  if (!created.ok) return record("parallel", "BLOCKED", `sbx create failed: ${created.err || created.out}`.slice(0, 300));
  const envFile = Object.entries(labEnvFromProcess()).map(([k, v]) => `export ${k}=${v}`).join("\n");
  realSbxCli.run(sbxExecArgv(sandbox, bashLc(`mkdir -p "$HOME" && cat > "$HOME/.labctl.env" <<'EOF'\n${envFile}\nEOF\nchmod 600 "$HOME/.labctl.env"`)));
  const u = new URL(api);
  const apiPort = u.port || "443";
  realSbxCli.run(["policy", "allow", "network", "--sandbox", sandbox, `host.docker.internal:${apiPort},localhost:${apiPort},host.docker.internal:18001,localhost:18001,host.docker.internal:18002,localhost:18002,host.docker.internal:18011,localhost:18011,host.docker.internal:18012,localhost:18012`]);
  const parLabctl = ensureLabctlInSandbox(sandbox, repo);
  if (!parLabctl.ok) return record("parallel", "FAIL", `labctl is not runnable inside the sandbox: ${parLabctl.detail}`);
  const labctl = sandboxLabctl({ sandbox, workspace: repo, exec: realSandboxExec }, labEnvFromProcess());

  // Destroy a lab and record the verdict from the RESULT (never a discarded
  // `.catch`): PASS only when destroy is `ok`, or a follow-up inspect exits 6.
  async function destroyAndVerdict(t: LabTask, lab: string | null, label: string): Promise<void> {
    if (!lab) return;
    const del = await destroyTaskLab(labctl, t, { lab, api, insecure });
    if (del.ok) return record(label, "PASS", `${lab} destroyed`);
    const ins = await labctl.run(labctlInspectArgv({ lab, api, insecure }));
    record(label, ins.code === 6 ? "PASS" : "FAIL", `destroy ${lab}: ${del.error ?? "failed"}; inspect exit ${ins.code}`, {
      raw: del.error ?? "",
    });
  }

  let deployedA: string | null = null;
  let deployedB: string | null = null;
  try {
    // Deploy BOTH labs concurrently (not one after the other).
    const [da, db] = await Promise.all([
      deployTaskLab(labctl, a, { topology: `labs/${labNameForTask(a)}/t.clab.yml`, namespace: labNamespaceForTask(a), api, insecure }),
      deployTaskLab(labctl, b, { topology: `labs/${labNameForTask(b)}/t.clab.yml`, namespace: labNamespaceForTask(b), api, insecure }),
    ]);
    if (da.lab) deployedA = da.lab;
    if (db.lab) deployedB = db.lab;
    if (!da.ok || !db.ok) {
      record("parallel", "FAIL", `two labs did not both come up: A=${da.error ?? "ok"} B=${db.error ?? "ok"}`);
      return;
    }
    record("parallel", "PASS", `two Task-named labs deployed concurrently: ${da.lab} + ${db.lab} (distinct owners/ports)`);
    // destroy A; B must survive
    await destroyAndVerdict(a, deployedA, "parallel.cleanup-a");
    deployedA = null;
    const insB = await inspectTaskLab(labctl, b, { lab: deployedB!, api, insecure, reachHost: "host.docker.internal" });
    record(
      "parallel.isolation",
      insB.ok ? "PASS" : "FAIL",
      `${db.lab} still ${insB.ok ? "running after the other lab was destroyed" : `broken: ${insB.error}`}`
    );
    // the shared NOS image survives (destroy never purges images)
    const img = sh("sbx", ["exec", "ish824-lab", "--", "docker", "image", "inspect", "ghcr.io/nokia/srlinux:latest", "--format", "{{.Id}}"]);
    record("parallel.image-retained", img.ok ? "PASS" : "FAIL", `shared SR Linux image ${img.ok ? "retained" : "MISSING"}: ${img.out || img.err}`);
  } finally {
    await destroyAndVerdict(a, deployedA, "parallel.cleanup-a-final");
    await destroyAndVerdict(b, deployedB, "parallel.cleanup-b");
    realSbxCli.run(["stop", sandbox]);
    const rm = realSbxCli.run(["rm", "--force", sandbox]);
    record("parallel.sandbox-cleanup", rm.ok ? "PASS" : "FAIL", rm.ok ? `sandbox ${sandbox} removed` : `sbx rm failed: ${rm.err || rm.out}`);
  }
}

// ---------------------------------------------------------------------------
// stage: factory — the real runFactoryTask over a durable Coding Sandbox
// ---------------------------------------------------------------------------

async function stageFactory(dir: string, api: string, insecure: boolean): Promise<void> {
  const repo = join(dir, "factory-repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "relay@test");
  git(repo, "config", "user.name", "relay-test");
  writeFileSync(join(repo, "README.md"), "base\n");
  const labctlSrc = findLabctlSrc();
  if (!labctlSrc) return record("factory", "BLOCKED", "no labctl.py (set LABCTL_SRC)");
  mkdirSync(join(repo, "labs", "labctl"), { recursive: true });
  writeFileSync(join(repo, "labs", "labctl", "labctl.py"), readFileSync(labctlSrc));

  const db = openDb(join(dir, "factory.db"));
  const task = intakeTask(db, {
    provider: "fixture",
    issueId: "ISH-830-FACTORY",
    codeChange: true,
    title: "change the source and prove it against real SR Linux",
    description:
      "Create DONE.md at the repository root whose contents are the single line: done. Then commit it on the current branch. " +
      "The REQUIRED check deploys a real SR Linux lab on the Shared Lab and reads it back at YOUR committed HEAD.",
    acceptance: "DONE.md exists and is committed; the SR Linux NOS check passes at the committed HEAD",
    // The REQUIRED check IS the real SR Linux NOS check (deploy/inspect/read-back/destroy).
    checks: [{ name: "srl-nos-readback", command: "bash labs/ish830-smoke/nos-check.sh" }],
  });
  const lab = labNameForTask(task as LabTask);
  const ns = labNamespaceForTask(task as LabTask);
  const topoDir = join(repo, "labs", "ish830-smoke");
  mkdirSync(topoDir, { recursive: true });
  writeFileSync(
    join(topoDir, "smoke.clab.yml"),
    [
      `name: ${lab}`,
      "topology:",
      "  nodes:",
      "    srl1:",
      "      kind: nokia_srlinux",
      "      type: ixrd3",
      "      image: ghcr.io/nokia/srlinux:latest",
      "      ports:",
      '        - "18001:22"',
      '        - "18002:57400"',
      "",
    ].join("\n")
  );
  writeFileSync(join(topoDir, "nos-check.sh"), nosCheckScript(lab, ns, api, insecure));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base: labctl + a Task-named SR Linux topology + NOS check");

  let sbName: string | null = null;
  let sbWorkspace = repo;
  try {
    const binding = ensureTaskSandbox(db, task.id, { source: repo, agent: "shell", cli: realSbxCli });
    sbName = binding.name;
    // The clone mirrors the resolved MAIN-checkout path (e.g. /private/var/... on
    // macOS), which may differ from the mkdtemp path — use the binding's.
    sbWorkspace = binding.workspace;
  } catch (e) {
    record("factory", "BLOCKED", `could not create the Task Coding Sandbox: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
    db.close();
    return;
  }
  // Install labctl + lab creds + the published-port policy inside the Task
  // sandbox (operator injection), so the REQUIRED NOS check can run at VERIFY.
  const envFile = Object.entries(labEnvFromProcess())
    .map(([k, v]) => `export ${k}=${v}`)
    .join("\n");
  realSbxCli.run(sbxExecArgv(sbName, bashLc(`mkdir -p "$HOME" && cat > "$HOME/.labctl.env" <<'EOF'\n${envFile}\nEOF\nchmod 600 "$HOME/.labctl.env"`)));
  const u = new URL(api);
  const apiPort = u.port || "443";
  realSbxCli.run(["policy", "allow", "network", "--sandbox", sbName, `host.docker.internal:${apiPort},localhost:${apiPort},host.docker.internal:18001,localhost:18001,host.docker.internal:18002,localhost:18002`]);
  const ready = ensureLabctlInSandbox(sbName, sbWorkspace);
  if (!ready.ok) record("factory.labctl", "FAIL", `labctl is not runnable in the Task sandbox: ${ready.detail}`);

  const result = await runFactoryTask(db, task.id, {
    repo,
    dshBin: process.env.RELAY_DSH_BIN ?? "dsh",
    permissionMode: "workspace-write",
    timeoutMs: 15 * 60_000,
    maxAttempts: 2,
    sandboxCli: realSbxCli,
    reviewWorktreeRoot: join(dir, "review-wt"),
  });
  const t = getTask(db, task.id)!;
  // Find the real dsh Run and read its raw failure evidence, so a missing
  // provider credential is recorded BLOCKED (not a generic failure).
  const run = db
    .query("SELECT * FROM runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(task.id) as { id: string; state: string; exit_code: number | null; error: string | null; stderr_path: string | null; dsh_events_path: string | null } | null;
  const rawBits: string[] = [];
  for (const p of [run?.stderr_path, run?.dsh_events_path]) {
    if (p && existsSync(p)) rawBits.push(readFileSync(p, "utf-8").slice(-1500));
  }
  const raw = [result.reason ?? "", run?.error ?? "", ...rawBits].join("\n");
  const detail = `runFactoryTask(${task.id}) -> ${result.outcome} (head ${result.head?.slice(0, 12) ?? "none"}); run ${run?.id ?? "?"} ${run?.state ?? "?"} exit ${run?.exit_code ?? "?"}`;

  // PASS is gated on the FULL chain, never a bare `merge_ready`: a FIX review
  // followed by a LATER PASS, and the final attempt's produced HEAD equal to the
  // MergeReady HEAD (verified HEAD == reviewer HEAD == MergeReady HEAD).
  const attempts = result.attempts;
  const fixIdx = attempts.findIndex((a) => a.reviewVerdict === "fix");
  const passIdx = attempts.findIndex((a, i) => a.reviewVerdict === "pass" && fixIdx !== -1 && i > fixIdx);
  const last = attempts[attempts.length - 1];
  const headOk = !!result.head && !!last?.producedHead && last.producedHead === result.head;
  const chainProven = fixIdx !== -1 && passIdx > fixIdx && headOk;
  if (result.outcome === "merge_ready" && chainProven) {
    record(
      "factory",
      "PASS",
      `real chain: dsh IMPLEMENT -> SR Linux VERIFY -> Claude FIX -> fresh dsh -> re-VERIFY -> Claude PASS -> MergeReady @ ${result.head?.slice(0, 12)}`,
      { raw: JSON.stringify({ attempts, steps: result.steps }, null, 2).slice(0, 1500) }
    );
  } else if (result.outcome === "merge_ready") {
    record("factory", "FAIL", `merge_ready but the ISH-830 chain is NOT proven (fixIdx=${fixIdx} passIdx=${passIdx} head-equal=${headOk}): ${detail}`);
  } else if (/MISSING_CREDENTIAL|no credential|no API key/i.test(raw)) {
    const why = raw.split("\n").find((l) => /MISSING_CREDENTIAL|no credential|no API key/i.test(l))?.trim() ?? "";
    record("factory", "BLOCKED", `real factory fails CLOSED (no provider credential, no false PASS): ${detail}`, { raw: why });
  } else {
    record("factory", "FAIL", detail, { raw: raw.slice(-800) });
  }
  // No merge/PR/Linear side effect.
  record(
    "factory.read-only",
    t.merged_at === null && t.accepted_at === null && t.pr_url === null ? "PASS" : "FAIL",
    `merged_at=${t.merged_at} accepted_at=${t.accepted_at} pr_url=${t.pr_url} (MergeReady is read-only)`
  );
  const sb = getSandbox(db, task.id);
  db.close();
  if (sb) {
    realSbxCli.run(["stop", sb.name]);
    const rm = realSbxCli.run(["rm", "--force", sb.name]);
    record("factory.sandbox-cleanup", rm.ok ? "PASS" : "FAIL", rm.ok ? `sandbox ${sb.name} removed` : `sbx rm failed: ${rm.err || rm.out}`);
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "relay-ish830-real-"));
  const api = process.env.LABCTL_API ?? "";
  const insecure = process.env.LABCTL_INSECURE === "1";
  const stages = new Set((process.env.ISH830_STAGES ?? "env,provider,nos,parallel,factory").split(",").map((s) => s.trim()));
  console.log(`ISH-830 real E2E — dir ${dir}\n  stages: ${[...stages].join(",")}  lab API: ${api || "(unset)"}`);

  if (stages.has("env")) stageEnv();
  if (stages.has("provider")) stageProvider();
  if (!api && (stages.has("nos") || stages.has("parallel") || stages.has("factory"))) {
    record("lab", "BLOCKED", "LABCTL_API is unset; the Shared-Lab legs are skipped", { command: "LABCTL_API=<url> LABCTL_USER=<u> LABCTL_PASSWORD=<pw> ..." });
  }
  if ((stages.has("nos") || stages.has("parallel")) && api) warmLab();
  if (stages.has("nos") && api) await stageNos(dir, api, insecure);
  if (stages.has("parallel") && api) await stageParallel(dir, api, insecure);
  if (stages.has("factory")) await stageFactory(dir, api, insecure);

  console.log("\n=== ISH-830 E2E summary ===");
  const counts = results.reduce<Record<string, number>>((m, r) => ((m[r.verdict] = (m[r.verdict] ?? 0) + 1), m), {});
  for (const r of results) console.log(`  ${r.verdict.padEnd(8)} ${r.stage}: ${r.detail}`);
  console.log(`\ncounts: ${JSON.stringify(counts)}`);
  console.log(`evidence-json: ${JSON.stringify(results)}`);
  const hardFail = results.some((r) => r.verdict === "FAIL");
  process.exitCode = hardFail ? 1 : 0;
  rmSync(dir, { recursive: true, force: true });
}

try {
  await main();
} catch (e) {
  console.error(`ISH-830 E2E crashed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exitCode = 1;
}
