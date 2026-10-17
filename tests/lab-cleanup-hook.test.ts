import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ISH-845 finding 3: the trusted hook Relay runs (`RELAY_LAB_CLEANUP_CMD`) must
// ship in the repo and select STRICTLY by owner — never by name suffix. This
// exercises the committed `scripts/lab-cleanup.sh` against a fake `labctl` with
// three labs, one of which (`bgp-T1` in another owner's namespace, and a longer
// `netlab-T11`) would be caught by a suffix match.

const repo = join(import.meta.dir, "..");
const hook = join(repo, "scripts", "lab-cleanup.sh");

let dir: string;
let log: string;
let fake: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-ish845-hook-"));
  log = join(dir, "calls.log");
  fake = join(dir, "labctl");
  writeFileSync(
    fake,
    `#!/bin/sh
echo "$@" >> "$LABCTL_LOG"
case "$1" in
  inspect) echo '{"netlab-T1":[{},{"nodeName":"srl1"}],"bgp-T1":[{}],"netlab-T11":[{}]}' ;;
  destroy) echo '{"destroyed":true}' ;;
  purge) echo '{"purged":true}' ;;
  *) echo '{}' ;;
esac
exit 0
`
  );
  chmodSync(fake, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runHook(owner: string): { status: number; stdout: string } {
  const env: Record<string, string | undefined> = { ...process.env, LABCTL_BIN: fake, LABCTL_LOG: log };
  delete env.LABCTL_API;
  delete env.LABCTL_USER;
  delete env.LABCTL_PASSWORD;
  delete env.LABCTL_PASSWORD_FILE;
  delete env.LABCTL_CA_CERT;
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
