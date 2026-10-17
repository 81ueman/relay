import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ISH-845 (round 1 finding 3, round 3 findings 1-2): the trusted hook Relay runs
// (`RELAY_LAB_CLEANUP_CMD`) must ship in the repo, select STRICTLY by owner —
// never by name suffix — accept credentials from the environment (which Relay
// forwards only as a narrow LABCTL_* set), and FAIL CLOSED when the workspace
// purge fails.

const repo = join(import.meta.dir, "..");
const hook = join(repo, "scripts", "lab-cleanup.sh");

let dir: string;
let log: string;
let fake: string;

/** The fake `labctl`: records argv + the credential env it saw. */
function writeFake(purgeRc = 0): void {
  writeFileSync(
    fake,
    `#!/bin/sh
echo "$@" >> "$LABCTL_LOG"
echo "creds API=\${LABCTL_API:-} USER=\${LABCTL_USER:-} PW=\${LABCTL_PASSWORD:+set}" >> "$LABCTL_LOG"
case "$1" in
  inspect) echo '{"netlab-T1":[{},{"nodeName":"srl1"}],"bgp-T1":[{}],"netlab-T11":[{}]}' ;;
  destroy) echo '{"destroyed":true}' ;;
  purge) exit ${purgeRc} ;;
  *) echo '{}' ;;
esac
exit 0
`
  );
  chmodSync(fake, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-ish845-hook-"));
  log = join(dir, "calls.log");
  fake = join(dir, "labctl");
  writeFake(0);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runHook(owner: string, extraEnv: Record<string, string | undefined> = {}): { status: number; stdout: string } {
  const env: Record<string, string | undefined> = { ...process.env, LABCTL_BIN: fake, LABCTL_LOG: log, ...extraEnv };
  for (const k of ["LABCTL_API", "LABCTL_USER", "LABCTL_PASSWORD", "LABCTL_PASSWORD_FILE", "LABCTL_TOKEN", "LABCTL_CA_CERT"]) {
    if (!(k in extraEnv)) delete env[k];
  }
  env.HOME = dir; // deterministic: never source the operator's real credentials file
  try {
    const stdout = execFileSync("sh", [hook, owner], { encoding: "utf8", env });
    return { status: 0, stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { status: err.status ?? -1, stdout: String(err.stdout ?? "") };
  }
}

function calls(): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
}

describe("trusted lab cleanup hook: strict owner selection", () => {
  test("destroys only netlab-<owner> — never bgp-T1 (another owner) or netlab-T11", () => {
    const r = runHook("T1");
    expect(r.status).toBe(0);
    const c = calls();
    expect(c).toContain("destroy --name netlab-T1 --insecure --json");
    expect(c.some((x) => /destroy .*bgp-T1/.test(x))).toBe(false);
    expect(c.some((x) => /destroy .*netlab-T11/.test(x))).toBe(false);
    expect(c.filter((x) => x.startsWith("destroy "))).toEqual(["destroy --name netlab-T1 --insecure --json"]);
  });

  test("purges the owner's leftover workspace directory", () => {
    runHook("T1");
    expect(calls()).toContain("purge netlab-T1 --namespace T1 --insecure --json");
  });

  test("rejects an unsafe owner id without calling labctl", () => {
    const r = runHook("T1;rm -rf /");
    expect(r.status).toBe(2);
    expect(calls()).toHaveLength(0);
  });

  test("an owner with no matching lab gets no destroy, only its own purge", () => {
    const r = runHook("T7");
    expect(r.status).toBe(0);
    const c = calls();
    expect(c.some((x) => x.startsWith("destroy "))).toBe(false);
    expect(c).toContain("purge netlab-T7 --namespace T7 --insecure --json");
  });
});

describe("trusted lab cleanup hook: credentials and purge failures (round 3)", () => {
  test("a failed purge (API error 5) fails the hook — never a silent success", () => {
    writeFake(5);
    const r = runHook("T1");
    expect(r.status).toBe(5);
  });

  test("a purge timeout (7) fails the hook", () => {
    writeFake(7);
    expect(runHook("T1").status).toBe(7);
  });

  test("EXIT_NOTFOUND (6: nothing to purge) is a no-op success", () => {
    writeFake(6);
    expect(runHook("T1").status).toBe(0);
  });

  test("accepts the credentials Relay forwards in the environment", () => {
    const r = runHook("T1", { LABCTL_API: "https://lab.invalid", LABCTL_USER: "agent", LABCTL_PASSWORD: "s3cret" });
    expect(r.status).toBe(0);
    expect(calls()).toContain("creds API=https://lab.invalid USER=agent PW=set");
  });

  test("loads credentials from $HOME/.config/relay/labctl.env when the env has none", () => {
    mkdirSync(join(dir, ".config", "relay"), { recursive: true });
    writeFileSync(
      join(dir, ".config", "relay", "labctl.env"),
      'export LABCTL_API="https://from-file"\nexport LABCTL_USER="fileuser"\nexport LABCTL_PASSWORD="filepass"\n'
    );
    const r = runHook("T1");
    expect(r.status).toBe(0);
    expect(calls()).toContain("creds API=https://from-file USER=fileuser PW=set");
  });
});
