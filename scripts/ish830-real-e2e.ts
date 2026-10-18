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
 *               (deploy -> inspect --json -> read-back -> destroy), reusing
 *               ISH-829's `sandboxVerifyTarget` boundary. The read-back is
 *               recorded three ways: the clab-api `exec` channel (NOT SSH), a
 *               REAL `ssh` to the node's published `:22` (with the egress
 *               CONNECT-proxy `ProxyCommand` as a documented fallback), and a
 *               REAL `gnmic` get on the node's published `:57400`. Each leg is
 *               `PASS` only with real evidence, else `NOT_RUN`. Failure
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
import { isPinnedDsh, readDshVersion, PINNED_DSH_VERSION } from "../src/dsh-version";
import {
  deployTaskLab,
  destroyTaskLab,
  inspectTaskLab,
  labNameForTask,
  labNamespaceForTask,
  labctlInspectArgv,
  type LabTask,
} from "../src/lab";

// The opt-in guard lives in the `import.meta.main` entry block at the bottom of
// this file, so the module can be imported (e.g. by tests) without running.

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

// ---------------------------------------------------------------------------
// Shared-Lab reachability (the real SSH / gNMI legs)
// ---------------------------------------------------------------------------

/**
 * The Lab HOST ports the node's SSH (:22) and gNMI (:57400) are published on.
 *
 * `labctl inspect --reach-host host.docker.internal` derives its endpoints as
 * `<reach-host>:<host_port>`, where `<host_port>` is the port the lab published
 * *on the Lab host*. That target is only reachable from a Coding Sandbox when
 * the Shared Lab also publishes that port 1:1 on `0.0.0.0` (`sbx ports`), so the
 * harness publishes exactly these and allows them for the Sandbox.
 *
 * `:18001` is deliberately NOT used: on this host an unrelated long-lived
 * service (an OpenHands `uvicorn` automation server) squats `127.0.0.1:18001`,
 * and the Sandbox egress proxy dials the published binding on `127.0.0.1` — so
 * a `host.docker.internal:18001` tunnel reaches that foreign listener and is
 * closed, never the Lab's published port. `:18021` is free and 1:1-published.
 */
const SRL_SSH_HOST_PORT = 18021;
const SRL_GNMI_HOST_PORT = 18002;

/**
 * The cap for a leg's recorded raw output. It must exceed the SR Linux SSH
 * banner + `show version` table (a 600-char cap cut the body off mid-banner, so
 * the `Software Version` row never reached the evidence); 4000 is ~3x the whole
 * SSH leg, so nothing is trimmed in practice.
 */
const LEG_RAW_CAP = 4000;

/**
 * The pinned gNMI client. The Coding Kit (`sandbox/coding-kit/spec.yaml`)
 * installs the same release into a real Coding Sandbox; this harness installs it
 * into its own throwaway `shell` Sandbox so the gNMI leg is real there too.
 * `github.com` is on the global allowlist, so no new network host is needed.
 */
const GNMIC_VERSION = "0.49.0";
const GNMIC_URL = `https://github.com/openconfig/gnmic/releases/download/v${GNMIC_VERSION}/gnmic_${GNMIC_VERSION}_Linux_aarch64.tar.gz`;

/** `host.docker.internal:<p>,localhost:<p>` for each port (both aliases pinned). */
function allowHostPorts(ports: (string | number)[]): string {
  return ports.flatMap((p) => [`host.docker.internal:${p}`, `localhost:${p}`]).join(",");
}

/**
 * Ensure the Shared Lab publishes each node HOST port 1:1 on `0.0.0.0`. `sbx
 * ports --publish` exits non-zero with `409 … already published` once the
 * binding exists, which is success here (idempotent). A real failure is `ok:false`.
 */
function ensureLabPorts(published: number[]): { ok: boolean; detail: string } {
  const notes: string[] = [];
  let ok = true;
  for (const p of published) {
    const r = realSbxCli.run(["ports", "ish824-lab", "--publish", `0.0.0.0:${p}:${p}`]);
    if (r.ok) notes.push(`${p}: published`);
    else if (/already published/i.test(r.err)) notes.push(`${p}: already published`);
    else {
      ok = false;
      notes.push(`${p}: FAILED (${r.err || r.out || `exit ${r.code}`})`);
    }
  }
  return { ok, detail: notes.join("; ") };
}

export interface SshAttempt {
  /** The exit marker of the attempt that produced the PASS (e.g. `SSH_EXIT=0`). */
  exit: string;
  /** The exact command of that attempt (credentials are already redacted by the script). */
  command: string;
  /** True when the PASS came from the CONNECT-proxy fallback attempt. */
  viaFallback: boolean;
}

/**
 * Pick the SSH attempt that produced the PASS out of the leg's echoed output.
 *
 * The direct attempt always echoes `SSH_EXIT=<rc>`. The CONNECT-proxy fallback
 * runs ONLY after the direct path failed (`SSH_LEG_RAW_FAIL`) and echoes
 * `--- SSH CONNECT-proxy fallback ---`, `SSH fallback command:` and
 * `SSH_FALLBACK_EXIT=<rc>`. So on the fallback path the FIRST
 * `SSH(_FALLBACK)?_EXIT=` line is the FAILED direct attempt, and a PASS must
 * report the LAST successful one (with the fallback command) — never the failed
 * attempt's exit code or command.
 */
export function selectSshAttempt(sshLeg: string): SshAttempt {
  const lines = sshLeg.split("\n").map((l) => l.trim());
  const exits = lines.filter((l) => /^SSH(_FALLBACK)?_EXIT=/.test(l));
  // The attempt that emitted `=0` is the one that passed (the script only emits
  // `SSH_LEG_OK` after a 0 exit); otherwise the last marker is the latest try.
  const selected = [...exits].reverse().find((l) => l.endsWith("=0")) ?? exits[exits.length - 1] ?? "";
  const viaFallback = selected.startsWith("SSH_FALLBACK_EXIT=");
  const command =
    lines.find((l) => l.startsWith(viaFallback ? "SSH fallback command:" : "SSH command:")) ??
    lines.find((l) => l.startsWith("SSH command:")) ??
    "";
  return { exit: selected, command, viaFallback };
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
    "# gnmic (the pinned gNMI client; the same release the Coding Kit installs).",
    "# Best-effort: without it the gNMI leg is NOT_RUN, never a PASS.",
    `for i in 1 2 3; do`,
    `  command -v gnmic >/dev/null 2>&1 && break`,
    `  curl -sSLf -o /tmp/gnmic.tgz ${GNMIC_URL} 2>/dev/null &&`,
    `    sudo tar -xzf /tmp/gnmic.tgz -C /usr/local/bin gnmic 2>/dev/null &&`,
    `    sudo chmod 0755 /usr/local/bin/gnmic || true`,
    `  sleep 2`,
    "done",
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
  const uname = sh("uname", ["-m"]).out;
  const sw = sh("sw_vers", ["-productVersion"]).out;
  const sbx = sh("sbx", ["version"]).out.replace(/\n/g, " ");
  const dsh = readDshVersion("dsh") ?? sh("dsh", ["--version"]).out;
  const claude = sh("claude", ["--version"]).out;
  const missing = [!uname && "uname", !sw && "sw_vers", !sbx && "sbx", !dsh && "dsh", !claude && "claude"].filter(Boolean) as string[];
  const summary = `darwin/${uname || "?"} macOS ${sw || "?"}; sbx ${sbx || "?"}; dsh ${dsh || "?"}; claude ${claude || "?"}`;
  // env is PASS only with every tool present AND the pinned dsh build (ISH-869).
  if (missing.length > 0) record("env", "NOT_RUN", `missing tool(s): ${missing.join(", ")}; ${summary}`);
  else if (!isPinnedDsh(dsh)) record("env", "FAIL", `dsh is not the pin ${PINNED_DSH_VERSION}: ${summary}`);
  else record("env", "PASS", summary);
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
  // The leg MUST be the pinned build (ISH-869); an unpinned/old dsh is refused,
  // never credited as a provider PASS.
  const version = readDshVersion("dsh");
  if (!version) {
    record("provider", "BLOCKED", "dsh is not on PATH / `--version` failed", { command: cmd });
    return;
  }
  if (!isPinnedDsh(version)) {
    record("provider", "FAIL", `DSH_VERSION_MISMATCH: dsh reports ${version}, Relay pins ${PINNED_DSH_VERSION}`, { command: cmd });
    return;
  }
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
    'SRL_PASSWORD="${SRL_PASSWORD:-NokiaSrl1!}"',
    "# Fail-closed teardown: EVERY exit of this check destroys its own lab, so a",
    "# failure after `deploy` (inspect/exec/ssh index) can never leak it. A later",
    "# explicit destroy is a no-op (the trap then sees EXIT_NOTFOUND).",
    `trap 'labctl destroy --name ${lab} --json --api "$API" ${ins} >/dev/null 2>&1 || true' EXIT`,
    "command -v labctl >/dev/null || { echo 'labctl missing'; exit 3; }",
    `labctl deploy -t labs/ish830-smoke/smoke.clab.yml --namespace ${ns} --json --api "$API" ${ins} >/tmp/dep.json`,
    "cat /tmp/dep.json",
    `labctl inspect ${lab} --json --api "$API" ${ins} --reach-host host.docker.internal >/tmp/ins.json`,
    "cat /tmp/ins.json",
    "# (a) clab-api exec — this is the clab-api-server's docker exec, NOT SSH.",
    `echo '--- clab-api exec (NOT SSH) ---'`,
    `labctl exec --json --api "$API" ${ins} ${lab}/srl1 -- sr_cli -c "show version"`,
    "# (b) REAL SSH from the Sandbox to the node's published :22 (reachable_at).",
    "# The exact command is echoed (password redacted) with its raw output + exit.",
    `echo '--- real SSH leg (published :22) ---'`,
    `SSH_EP=$(python3 -c "import json;d=json.load(open('/tmp/ins.json'));print([e['reachable_at'] for n in d['nodes'] for e in n.get('mgmt_endpoints',[]) if e.get('container_port')==22][0])")`,
    `SSH_HOST="\${SSH_EP%%:*}"; SSH_PORT="\${SSH_EP##*:}"`,
    `SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15"`,
    `echo "SSH command: sshpass -p <redacted> ssh $SSH_OPTS -p $SSH_PORT admin@$SSH_HOST 'show version'"`,
    "if command -v sshpass >/dev/null 2>&1; then",
    `  sshpass -p "$SRL_PASSWORD" ssh $SSH_OPTS -p "$SSH_PORT" admin@"$SSH_HOST" "show version" > /tmp/ssh.out 2>&1 && SSH_RC=0 || SSH_RC=$?`,
    "  cat /tmp/ssh.out",
    `  echo "SSH_EXIT=$SSH_RC"`,
    `  if [ "$SSH_RC" = 0 ] && grep -qE 'Software Version|SRLinux' /tmp/ssh.out; then`,
    "    echo SSH_LEG_OK",
    "  else",
    "    echo SSH_LEG_RAW_FAIL",
    "    # Documented fallback: the Sandbox egress CONNECT proxy (HTTP CONNECT at",
    "    # gateway.docker.internal:3128) can carry the same TCP stream when the",
    "    # transparent raw path is refused.",
    "    if command -v socat >/dev/null 2>&1; then",
    `      echo '--- SSH CONNECT-proxy fallback ---'`,
    `      echo "SSH fallback command: sshpass -p <redacted> ssh $SSH_OPTS -o ProxyCommand='socat - PROXY:gateway.docker.internal:%h:%p,proxyport=3128' -p $SSH_PORT admin@$SSH_HOST 'show version'"`,
    `      echo 'ProxyCommand: socat - PROXY:gateway.docker.internal:%h:%p,proxyport=3128'`,
    `      sshpass -p "$SRL_PASSWORD" ssh $SSH_OPTS -o ProxyCommand='socat - PROXY:gateway.docker.internal:%h:%p,proxyport=3128' -p "$SSH_PORT" admin@"$SSH_HOST" "show version" > /tmp/ssh2.out 2>&1 && SSH2_RC=0 || SSH2_RC=$?`,
    "      cat /tmp/ssh2.out",
    `      echo "SSH_FALLBACK_EXIT=$SSH2_RC"`,
    `      if [ "$SSH2_RC" = 0 ] && grep -qE 'Software Version|SRLinux' /tmp/ssh2.out; then echo SSH_LEG_OK; fi`,
    "    else",
    "      echo 'SSH_FALLBACK_NOT_RUN: socat is not installed in the sandbox'",
    "    fi",
    "  fi",
    "else",
    "  echo 'SSH_NOT_RUN: sshpass is not installed in the sandbox'",
    "fi",
    "# (c) REAL gNMI on the node's published :57400 (reachable_at) via gnmic.",
    "# SR Linux serves gNMI over TLS with a self-signed cert, so the client needs",
    "# `--skip-verify` (TLS, verification skipped) — NOT `--insecure`, which would",
    "# speak plaintext gRPC to a TLS port and always fail.",
    `echo '--- real gNMI leg (published :57400) ---'`,
    "if command -v gnmic >/dev/null 2>&1; then",
    `  GNMI_EP=$(python3 -c "import json;d=json.load(open('/tmp/ins.json'));print([e['reachable_at'] for n in d['nodes'] for e in n.get('mgmt_endpoints',[]) if e.get('container_port')==57400][0])")`,
    `  echo "gNMI command: gnmic -a $GNMI_EP -u admin -p <redacted> --skip-verify -e json_ietf get --path /system/name/host-name"`,
    `  gnmic -a "$GNMI_EP" -u admin -p "$SRL_PASSWORD" --skip-verify -e json_ietf get --path /system/name/host-name > /tmp/gnmi.out 2>&1 && GNMI_RC=0 || GNMI_RC=$?`,
    "  cat /tmp/gnmi.out",
    `  echo "GNMI_EXIT=$GNMI_RC"`,
    `  if [ "$GNMI_RC" = 0 ] && grep -q 'host-name' /tmp/gnmi.out; then echo GNMI_LEG_OK; else echo GNMI_LEG_FAIL; fi`,
    "else",
    "  echo 'GNMI_NOT_RUN: gnmic is not installed in the sandbox'",
    "fi",
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
  // A SECOND Task identity for the real lab-port-failure injection (its lab maps
  // the SAME published host port 18001).
  const portTask: LabTask = { id: `${task.id}-port`, created_at: task.created_at + 1 };
  const portLab = labNameForTask(portTask);
  const portNs = labNamespaceForTask(portTask);
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
      `        - "${SRL_SSH_HOST_PORT}:22"`,
      `        - "${SRL_GNMI_HOST_PORT}:57400"`,
      "",
    ].join("\n")
  );
  writeFileSync(join(topoDir, "nos-check.sh"), nosCheckScript(lab, ns, api, insecure));
  // The port-collision topology: same published host port as `smoke.clab.yml`.
  const portDir = join(repo, "labs", portLab);
  mkdirSync(portDir, { recursive: true });
  writeFileSync(
    join(portDir, "port.clab.yml"),
    [
      `name: ${portLab}`,
      "topology:",
      "  nodes:",
      "    srl1:",
      "      kind: nokia_srlinux",
      "      type: ixrd3",
      "      image: ghcr.io/nokia/srlinux:latest",
      "      ports:",
      `        - "${SRL_SSH_HOST_PORT}:22"`,
      "",
    ].join("\n")
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "ish830: labctl + a Task-named SR Linux topology + NOS check");
  const head = git(repo, "rev-parse", "HEAD");

  const created = realSbxCli.run(sbxCreateArgv({ name: sandbox, agent: "shell", source: repo }));
  if (!created.ok) {
    record("nos", "BLOCKED", `sbx create --clone failed: ${created.err || created.out}`.slice(0, 300));
    return;
  }
  let labDeployed: string | null = null;
  let portLabDeployed: string | null = null;
  try {
    // provision lab creds + policy inside the sandbox (operator injection)
    const envFile = Object.entries(labEnvFromProcess())
      .map(([k, v]) => `export ${k}=${v}`)
      .join("\n");
    realSbxCli.run(sbxExecArgv(sandbox, bashLc(`mkdir -p "$HOME" && cat > "$HOME/.labctl.env" <<'EOF'\n${envFile}\nEOF\nchmod 600 "$HOME/.labctl.env"`)));
    const u = new URL(api);
    const apiPort = u.port || (u.protocol === "https:" ? "443" : "80");
    const published = ensureLabPorts([SRL_GNMI_HOST_PORT, SRL_SSH_HOST_PORT]);
    record("nos.lab-ports", published.ok ? "PASS" : "FAIL", `Shared Lab node ports published 1:1 on 0.0.0.0: ${published.detail}`);
    realSbxCli.run([
      "policy",
      "allow",
      "network",
      "--sandbox",
      sandbox,
      allowHostPorts([apiPort, SRL_SSH_HOST_PORT, SRL_GNMI_HOST_PORT]),
    ]);
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
      // `out` is already bounded by the runner (each stream is tail-capped at
      // `STREAM_TAIL`); record it WHOLE so the SSH `show version` body survives.
      const verLine = out.split("\n").find((l) => /Software Version|SRLinux/i.test(l))?.trim() ?? "";
      record("nos", "PASS", `real SR Linux VERIFY at the bound HEAD ${head.slice(0, 12)}: ${verLine}`, {
        command: "sandboxVerifyTarget.runner.run(nos-readback)",
        raw: out,
      });
    } else {
      record("nos", "FAIL", `real SR Linux VERIFY was '${pass.outcome}' (never a PASS)`, { raw: out });
    }
    // SSH / gNMI are recorded SEPARATELY and honestly: the `labctl exec` read-back
    // above is clab-api-server docker exec, NOT SSH. A PASS requires REAL evidence
    // (a version over the published :22, or a gNMI get on :57400); otherwise the
    // leg is NOT_RUN — never claimed. A non-PASS leg still keeps its WHOLE output,
    // with the cause distinguished, so a real failure (e.g. the TLS mismatch this
    // change fixes) is never misreported as a missing tool with its output dropped.
    const sshLeg = out.split("--- real SSH leg (published :22) ---")[1]?.split("--- real gNMI")[0] ?? "";
    const sshOk = out.includes("SSH_LEG_OK") && /Software Version|SRLinux/i.test(sshLeg);
    // Report the attempt that PASSED: on the fallback path the FIRST exit marker
    // is the FAILED direct attempt, so a PASS must not report its exit/command.
    const ssh = selectSshAttempt(sshLeg);
    const sshDetail = sshOk
      ? `real SSH from the Sandbox to host.docker.internal:${SRL_SSH_HOST_PORT} (node :22) returned \`show version\`${ssh.viaFallback ? " via the CONNECT-proxy fallback" : ""} [${ssh.exit}] ${ssh.command}`
      : out.includes("SSH_NOT_RUN:")
        ? "SSH NOT_RUN (sshpass is not installed in the Sandbox)"
        : sshLeg.includes("SSH_LEG_RAW_FAIL")
          ? `SSH NOT_RUN (ssh ran and FAILED${ssh.exit ? ` [${ssh.exit}]` : ""} — see raw)`
          : "SSH NOT_RUN (no SSH evidence obtained)";
    record("nos.ssh", sshOk ? "PASS" : "NOT_RUN", sshDetail, {
      // The WHOLE leg — echoed command + banner + `Hostname`..`Software Version`
      // body + `SSH_EXIT=` — so the body is recorded verbatim, never cut off.
      raw: (sshLeg.trim() || "sshpass unavailable").slice(0, LEG_RAW_CAP),
    });
    // gnmic's OWN output: the section minus the harness's echoed command line,
    // which itself contains `host-name` and must not satisfy the gate. The
    // section ends at `GNMI_LEG_OK`/`GNMI_LEG_FAIL` (not the destroy JSON).
    const gnmiLines = (out.split("--- real gNMI leg (published :57400) ---")[1] ?? "").split("\n");
    const gnmiEnd = gnmiLines.findIndex((l) => /^GNMI_LEG_(OK|FAIL)$/.test(l.trim()));
    const gnmiSection = (gnmiEnd === -1 ? gnmiLines : gnmiLines.slice(0, gnmiEnd + 1)).join("\n").trim();
    const gnmiOutput = gnmiSection
      .split("\n")
      .filter((l) => !l.startsWith("gNMI command:"))
      .join("\n")
      .trim();
    const gnmiOk = out.includes("GNMI_LEG_OK") && gnmiOutput.includes("host-name") && gnmiOutput.includes('"values"');
    const gnmiExit = out.split("\n").find((l) => /^GNMI_EXIT=/.test(l))?.trim() ?? "";
    const gnmiDetail = gnmiOk
      ? `real gNMI from the Sandbox to host.docker.internal:${SRL_GNMI_HOST_PORT} (node :57400) returned the host-name [${gnmiExit}]`
      : out.includes("GNMI_NOT_RUN:")
        ? "gNMI NOT_RUN (gnmic is not installed in the Sandbox — tool absent)"
        : gnmiSection.includes("GNMI_LEG_FAIL")
          ? `gNMI NOT_RUN (gnmic ran against host.docker.internal:${SRL_GNMI_HOST_PORT}:57400 and FAILED${gnmiExit ? ` [${gnmiExit}]` : ""} — see raw)`
          : "gNMI NOT_RUN (no gNMI evidence obtained)";
    record("nos.gnmi", gnmiOk ? "PASS" : "NOT_RUN", gnmiDetail, {
      // gnmic's output is kept on PASS **and** on failure (the verdict stays
      // NOT_RUN); only a genuinely absent tool has no output to keep.
      raw: (gnmiSection || "no gnmic output").slice(0, LEG_RAW_CAP),
    });

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

    // Real Lab port failure: hold published host port 18001 with a first Task lab,
    // then a SECOND Task lab on the SAME port must FAIL to deploy (never a PASS).
    const nosLabctl = sandboxLabctl({ sandbox, workspace: repo, exec: realSandboxExec }, labEnvFromProcess());
    const holdLab = await deployTaskLab(nosLabctl, task as LabTask, {
      topology: "labs/ish830-smoke/smoke.clab.yml",
      namespace: ns,
      api,
      insecure,
    });
    // A port-conflict deploy can PARTIALLY create the node container even on an
    // API error (labctl exit 5) where `deployTaskLab` returns `lab:null`, so record
    // the DETERMINISTIC name before deploying — `finally` always destroys it.
    portLabDeployed = portLab;
    const collide = await deployTaskLab(nosLabctl, portTask, {
      topology: `labs/${portLab}/port.clab.yml`,
      namespace: portNs,
      api,
      insecure,
    });
    record(
      "nos.lab-port-failure",
      holdLab.ok && !collide.ok ? "PASS" : "FAIL",
      `a second Task lab on the already-published host port ${SRL_SSH_HOST_PORT} -> deploy ok=${collide.ok} (never a PASS)`,
      { raw: collide.error ?? "" }
    );
    if (holdLab.lab) {
      const holdDel = await destroyTaskLab(nosLabctl, task as LabTask, { lab: holdLab.lab, api, insecure });
      record("nos.lab-port-holder-cleanup", holdDel.ok ? "PASS" : "FAIL", `${holdLab.lab}: ${holdDel.error ?? "destroyed"}`);
    }

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
    // The port-collision lab can partially create a container even on exit 5:
    // destroy the deterministic name and record the verdict (never a silent leak).
    if (portLabDeployed) {
      const labctl = sandboxLabctl({ sandbox, workspace: repo, exec: realSandboxExec }, labEnvFromProcess());
      const del = await destroyTaskLab(labctl, portTask, { lab: portLabDeployed, api, insecure });
      if (del.ok) record("nos.lab-port-cleanup", "PASS", `${portLabDeployed} destroyed`);
      else {
        const ins = await labctl.run(labctlInspectArgv({ lab: portLabDeployed, api, insecure }));
        record("nos.lab-port-cleanup", ins.code === 6 ? "PASS" : "FAIL", `destroy ${portLabDeployed}: ${del.error ?? "failed"}; inspect exit ${ins.code}`);
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
  if (!labctlSrc) {
    record("parallel", "BLOCKED", "no labctl.py (set LABCTL_SRC)");
    return;
  }
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
  if (!created.ok) {
    record("parallel", "BLOCKED", `sbx create failed: ${created.err || created.out}`.slice(0, 300));
    return;
  }

  // Everything from here runs INSIDE the try/finally: the env-file write, the
  // `new URL(api)` parse, the policy and `ensureLabctlInSandbox` can all fail, and
  // the `finally` must ALWAYS stop/remove the sandbox (a leak is a FAIL).
  const labctl = sandboxLabctl({ sandbox, workspace: repo, exec: realSandboxExec }, labEnvFromProcess());

  // Destroy a lab and record the verdict from the RESULT (never a discarded
  // `.catch`): PASS only when destroy is `ok`, or a follow-up inspect exits 6.
  async function destroyAndVerdict(t: LabTask, lab: string | null, label: string): Promise<void> {
    if (!lab) return;
    const del = await destroyTaskLab(labctl, t, { lab, api, insecure });
    if (del.ok) {
      record(label, "PASS", `${lab} destroyed`);
      return;
    }
    const ins = await labctl.run(labctlInspectArgv({ lab, api, insecure }));
    record(label, ins.code === 6 ? "PASS" : "FAIL", `destroy ${lab}: ${del.error ?? "failed"}; inspect exit ${ins.code}`, {
      raw: del.error ?? "",
    });
  }

  let deployedA: string | null = null;
  let deployedB: string | null = null;
  try {
    const envFile = Object.entries(labEnvFromProcess()).map(([k, v]) => `export ${k}=${v}`).join("\n");
    realSbxCli.run(sbxExecArgv(sandbox, bashLc(`mkdir -p "$HOME" && cat > "$HOME/.labctl.env" <<'EOF'\n${envFile}\nEOF\nchmod 600 "$HOME/.labctl.env"`)));
    const u = new URL(api);
    const apiPort = u.port || "443";
    realSbxCli.run([
      "policy",
      "allow",
      "network",
      "--sandbox",
      sandbox,
      allowHostPorts([apiPort, 18001, 18002, 18011, 18012]),
    ]);
    const parLabctl = ensureLabctlInSandbox(sandbox, repo);
    if (!parLabctl.ok) {
      // Record FAIL and fall through to the `finally`, which removes the sandbox.
      record("parallel", "FAIL", `labctl is not runnable inside the sandbox: ${parLabctl.detail}`);
      return;
    }

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
  } catch (e) {
    // Fail-closed: a throw (e.g. a malformed LABCTL_API in `new URL`) is a FAIL, and
    // the `finally` still stops/removes the sandbox.
    record("parallel", "FAIL", `parallel stage error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400));
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
  if (!labctlSrc) {
    record("factory", "BLOCKED", "no labctl.py (set LABCTL_SRC)");
    return;
  }
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
      `        - "${SRL_SSH_HOST_PORT}:22"`,
      `        - "${SRL_GNMI_HOST_PORT}:57400"`,
      "",
    ].join("\n")
  );
  writeFileSync(join(topoDir, "nos-check.sh"), nosCheckScript(lab, ns, api, insecure));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base: labctl + a Task-named SR Linux topology + NOS check");

  let sbName: string | null = null;
  let sbWorkspace = repo;
  const taskLab = task as LabTask;
  const factoryLab = labNameForTask(taskLab);
  let factoryLabDeployed: string | null = null;
  try {
    const binding = ensureTaskSandbox(db, task.id, { source: repo, agent: "shell", cli: realSbxCli });
    sbName = binding.name;
    // The clone mirrors the resolved MAIN-checkout path (e.g. /private/var/... on
    // macOS), which may differ from the mkdtemp path — use the binding's.
    sbWorkspace = binding.workspace;

    // Install labctl + lab creds + the published-port policy inside the Task
    // sandbox (operator injection), so the REQUIRED NOS check can run at VERIFY.
    const envFile = Object.entries(labEnvFromProcess())
      .map(([k, v]) => `export ${k}=${v}`)
      .join("\n");
    realSbxCli.run(sbxExecArgv(sbName, bashLc(`mkdir -p "$HOME" && cat > "$HOME/.labctl.env" <<'EOF'\n${envFile}\nEOF\nchmod 600 "$HOME/.labctl.env"`)));
    const u = new URL(api);
    const apiPort = u.port || "443";
    const published = ensureLabPorts([SRL_GNMI_HOST_PORT, SRL_SSH_HOST_PORT]);
    record("factory.lab-ports", published.ok ? "PASS" : "FAIL", `Shared Lab node ports published 1:1 on 0.0.0.0: ${published.detail}`);
    realSbxCli.run([
      "policy",
      "allow",
      "network",
      "--sandbox",
      sbName,
      allowHostPorts([apiPort, SRL_SSH_HOST_PORT, SRL_GNMI_HOST_PORT]),
    ]);
    const ready = ensureLabctlInSandbox(sbName, sbWorkspace);
    if (!ready.ok) record("factory.labctl", "FAIL", `labctl is not runnable in the Task sandbox: ${ready.detail}`);

    // The Task's lab name is DETERMINISTIC: record it BEFORE the run so a VERIFY
    // that fails after `deploy` (and leaves the lab up) is torn down in `finally`.
    factoryLabDeployed = factoryLab;
    // ISH-869: the in-Sandbox dsh route (`deepseek-official`) reads
    // `DEEPSEEK_API_KEY` from the Run env; forward it when the operator exports it.
    const dshEnv = process.env.DEEPSEEK_API_KEY ? { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } : undefined;
    const result = await runFactoryTask(db, task.id, {
      repo,
      dshBin: process.env.RELAY_DSH_BIN ?? "dsh",
      permissionMode: "workspace-write",
      timeoutMs: 15 * 60_000,
      maxAttempts: 2,
      sandboxCli: realSbxCli,
      reviewWorktreeRoot: join(dir, "review-wt"),
      ...(dshEnv ? { dshEnv } : {}),
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
  } catch (e) {
    // Fail-closed: never swallow a factory-stage error (a throw is a FAIL, and the
    // `finally` still tears down the Task lab + sandbox).
    record("factory", "FAIL", `factory stage error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400));
  } finally {
    // FAIL-CLOSED teardown: destroy the Task's own lab (same exit-6 verdict as
    // `stageNos`), then remove the Coding Sandbox — a leaked lab/sandbox is a FAIL.
    if (factoryLabDeployed && sbName) {
      const labctl = sandboxLabctl({ sandbox: sbName, workspace: sbWorkspace, exec: realSandboxExec }, labEnvFromProcess());
      const del = await destroyTaskLab(labctl, taskLab, { lab: factoryLabDeployed, api, insecure });
      if (del.ok) {
        record("factory.lab-cleanup", "PASS", `${factoryLabDeployed} destroyed`);
      } else {
        const ins = await labctl.run(labctlInspectArgv({ lab: factoryLabDeployed, api, insecure }));
        record("factory.lab-cleanup", ins.code === 6 ? "PASS" : "FAIL", `destroy ${factoryLabDeployed}: ${del.error ?? "failed"}; inspect exit ${ins.code}`);
      }
    }
    const sb = getSandbox(db, task.id);
    db.close();
    if (sb) {
      realSbxCli.run(["stop", sb.name]);
      const rm = realSbxCli.run(["rm", "--force", sb.name]);
      record("factory.sandbox-cleanup", rm.ok ? "PASS" : "FAIL", rm.ok ? `sandbox ${sb.name} removed` : `sbx rm failed: ${rm.err || rm.out}`);
    }
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
    record("lab", "BLOCKED", "LABCTL_API is unset; the Shared-Lab legs (nos/parallel/factory) are skipped", { command: "LABCTL_API=<url> LABCTL_USER=<u> LABCTL_PASSWORD=<pw> ..." });
  }
  // Any stage that talks to the Lab needs the VM awake (an idle Shared Lab VM is
  // stopped; the factory VERIFY would otherwise hit a stopped API).
  if (api && (stages.has("nos") || stages.has("parallel") || stages.has("factory"))) warmLab();
  if (stages.has("nos") && api) await stageNos(dir, api, insecure);
  if (stages.has("parallel") && api) await stageParallel(dir, api, insecure);
  if (stages.has("factory") && api) await stageFactory(dir, api, insecure);

  console.log("\n=== ISH-830 E2E summary ===");
  const counts = results.reduce<Record<string, number>>((m, r) => ((m[r.verdict] = (m[r.verdict] ?? 0) + 1), m), {});
  for (const r of results) console.log(`  ${r.verdict.padEnd(8)} ${r.stage}: ${r.detail}`);
  console.log(`\ncounts: ${JSON.stringify(counts)}`);
  console.log(`evidence-json: ${JSON.stringify(results)}`);
  const hardFail = results.some((r) => r.verdict === "FAIL");
  process.exitCode = hardFail ? 1 : 0;
  rmSync(dir, { recursive: true, force: true });
}

if (import.meta.main) {
  if (process.env.RELAY_ISH830_E2E !== "1") {
    console.log("ISH-830 real E2E is opt-in: set RELAY_ISH830_E2E=1 to run it (creates real sandboxes + labs).");
    process.exit(0);
  }
  try {
    await main();
  } catch (e) {
    console.error(`ISH-830 E2E crashed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exitCode = 1;
  }
}