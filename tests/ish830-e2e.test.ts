import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

  test("the Sandbox allow list is only exact host:port entries (both pinned aliases)", () => {
    // The one place the allow list is built maps each port to both aliases.
    expect(harness).toMatch(/host\.docker\.internal:\$\{p\}/);
    expect(harness).toMatch(/localhost:\$\{p\}/);
    // The published node ports are the ones the legs dial.
    expect(harness).toContain("const SRL_SSH_HOST_PORT = 18021");
    expect(harness).toContain("const SRL_GNMI_HOST_PORT = 18002");
  });
});
