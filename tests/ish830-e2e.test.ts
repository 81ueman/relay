import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selectSshAttempt } from "../scripts/ish830-real-e2e";

// ISH-830 follow-up: the opt-in real E2E harness must run a REAL SSH leg and a
// REAL gNMI leg (PRE-20 ran a `labctl exec` read-back and claimed neither), and
// the Coding Kit must provision the same gNMI client so a real Coding Sandbox can
// run the gNMI get. The pins below keep the kit and the harness on one gnmic
// version and guard the two defects that made the legs fake:
//
//   - `gnmic --insecure` means *plaintext* gRPC; SR Linux serves `:57400` over
//     TLS, so the get must use `--skip-verify`;
//   - a published node port is only reachable from a Sandbox when the Shared Lab
//     publishes it 1:1 on `0.0.0.0` and the Sandbox is allowed that exact
//     `host:port` (never a bare `host.docker.internal` / `localhost`).

const repo = join(import.meta.dir, "..");
const kit = readFileSync(join(repo, "sandbox", "coding-kit", "spec.yaml"), "utf8");
const harness = readFileSync(join(repo, "scripts", "ish830-real-e2e.ts"), "utf8");

const GNMIC_VERSION = "0.49.0";
const GNMIC_URL = `https://github.com/openconfig/gnmic/releases/download/v${GNMIC_VERSION}/gnmic_${GNMIC_VERSION}_Linux_aarch64.tar.gz`;

describe("ISH-830 real E2E — gnmic pin", () => {
  test("the Coding Kit installs the pinned gnmic release into /usr/local/bin", () => {
    expect(kit).toContain(GNMIC_URL);
    expect(kit).toContain("/usr/local/bin/gnmic");
  });

  test("the harness installs the same pinned gnmic release", () => {
    expect(harness).toContain(`const GNMIC_VERSION = "${GNMIC_VERSION}"`);
    expect(harness).toContain("/releases/download/v${GNMIC_VERSION}/gnmic_${GNMIC_VERSION}_Linux_aarch64.tar.gz");
  });
});

describe("ISH-830 real E2E — the legs are real", () => {
  test("the gNMI leg is a real gnmic get over TLS (--skip-verify, never --insecure)", () => {
    expect(harness).toContain("--skip-verify");
    expect(harness).toContain("GNMI_LEG_OK");
    // `gnmic --insecure` would speak plaintext gRPC to SR Linux's TLS port.
    expect(harness).not.toMatch(/\bgnmic\b[^\n]*--insecure/);
  });

  test("the SSH leg is a real ssh to the published :22 with a CONNECT ProxyCommand fallback", () => {
    expect(harness).toContain("sshpass");
    expect(harness).toContain("SSH_LEG_OK");
    expect(harness).toContain("ProxyCommand='socat - PROXY:gateway.docker.internal:%h:%p,proxyport=3128'");
  });

  test("the SSH leg records its whole output (the show-version body is never cut off)", () => {
    // Round-2 finding 1: a 600-char cap consumed by the command + banner cut the
    // `Software Version` body out of the recorded evidence.
    expect(harness).not.toContain("sshLeg.trim().slice(0, 600)");
    expect(harness).toMatch(/const LEG_RAW_CAP = \d{4,}/);
    expect(harness).toContain("raw: (sshLeg.trim()");
  });

  test("a failed gnmic get is reported as a failed get with its output, not a missing tool", () => {
    // Round-2 finding 2: every non-PASS gNMI case used a fixed "gnmic not
    // installed" detail with no raw, so a real TLS failure looked like an absent tool.
    expect(harness).toContain('out.includes("GNMI_NOT_RUN:")');
    expect(harness).toContain('gnmiSection.includes("GNMI_LEG_FAIL")');
    expect(harness).toContain("raw: (gnmiSection");
    // The host-name conjunct must be scoped to gnmic's own output, not all of `out`.
    expect(harness).not.toContain("/host-name/i.test(out)");
    expect(harness).toContain('gnmiOutput.includes("host-name")');
  });

  test("the Sandbox allow list is only exact host:port entries (both pinned aliases)", () => {
    // The one place the allow list is built maps each port to both aliases.
    expect(harness).toMatch(/host\.docker\.internal:\$\{p\}/);
    expect(harness).toMatch(/localhost:\$\{p\}/);
    // The published node ports are the ones the legs dial.
    expect(harness).toContain("const SRL_SSH_HOST_PORT = 18021");
    expect(harness).toContain("const SRL_GNMI_HOST_PORT = 18002");
  });
});

// Round-3 finding: on the CONNECT-proxy fallback path the FIRST `SSH_EXIT=` line
// is the FAILED direct attempt, so a PASS must report the fallback's exit code
// and command. This is a BEHAVIOURAL test of the real selector the harness uses.
describe("ISH-830 real E2E — SSH attempt selection (round-3)", () => {
  const directOk = [
    "SSH command: sshpass -p <redacted> ssh -p 18021 admin@host.docker.internal 'show version'",
    "Software Version     : v26.7.2",
    "SSH_EXIT=0",
    "SSH_LEG_OK",
  ].join("\n");

  const fallbackOk = [
    "SSH command: sshpass -p <redacted> ssh -p 18021 admin@host.docker.internal 'show version'",
    "Connection closed by 169.254.1.1 port 18021",
    "SSH_EXIT=255",
    "SSH_LEG_RAW_FAIL",
    "--- SSH CONNECT-proxy fallback ---",
    "SSH fallback command: sshpass -p <redacted> ssh -o ProxyCommand='socat - PROXY:gateway.docker.internal:%h:%p,proxyport=3128' -p 18021 admin@host.docker.internal 'show version'",
    "ProxyCommand: socat - PROXY:gateway.docker.internal:%h:%p,proxyport=3128",
    "Software Version     : v26.7.2",
    "SSH_FALLBACK_EXIT=0",
    "SSH_LEG_OK",
  ].join("\n");

  test("the direct path reports SSH_EXIT and the direct command", () => {
    const a = selectSshAttempt(directOk);
    expect(a.exit).toBe("SSH_EXIT=0");
    expect(a.viaFallback).toBe(false);
    expect(a.command.startsWith("SSH command:")).toBe(true);
  });

  test("the fallback path reports the successful fallback, not the failed direct attempt", () => {
    const a = selectSshAttempt(fallbackOk);
    expect(a.exit).toBe("SSH_FALLBACK_EXIT=0");
    expect(a.exit).not.toBe("SSH_EXIT=255");
    expect(a.viaFallback).toBe(true);
    expect(a.command.startsWith("SSH fallback command:")).toBe(true);
    expect(a.command).toContain("ProxyCommand=");
  });

  test("a leg where every attempt failed reports the last attempt's exit", () => {
    const failed = ["SSH_EXIT=255", "SSH_LEG_RAW_FAIL", "--- SSH CONNECT-proxy fallback ---", "SSH_FALLBACK_EXIT=1"].join("\n");
    expect(selectSshAttempt(failed).exit).toBe("SSH_FALLBACK_EXIT=1");
  });

  test("the harness reports the fallback in the PASS detail", () => {
    expect(harness).toContain("via the CONNECT-proxy fallback");
    expect(harness).toContain("selectSshAttempt(sshLeg)");
  });
});
