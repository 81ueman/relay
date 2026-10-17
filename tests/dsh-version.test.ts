import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPinnedDsh, PINNED_DSH_VERSION, readDshVersion } from "../src/dsh-version";

// ISH-869: the ONE shared dsh pin, and the host `dsh --version` reader the host
// Coding Worker guard depends on. Pure/deterministic; no real dsh.

let dir = "";

function bin(name: string, script: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${script}`);
  chmodSync(p, 0o755);
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-dsh-version-"));
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("isPinnedDsh / PINNED_DSH_VERSION", () => {
  test("the pin is exactly 0.2.1-rc.2", () => {
    expect(PINNED_DSH_VERSION).toBe("0.2.1-rc.2");
  });

  test("matches only the exact pinned token", () => {
    expect(isPinnedDsh("0.2.1-rc.2")).toBe(true);
    expect(isPinnedDsh("dsh 0.2.1-rc.2")).toBe(true); // a `dsh ` prefix is fine
    expect(isPinnedDsh("0.2.0-rc.2")).toBe(false); // the previous baseline
    expect(isPinnedDsh("0.2.1-rc.1")).toBe(false);
    expect(isPinnedDsh("0.2.1-rc.20")).toBe(false); // not a loose substring
    expect(isPinnedDsh("latest")).toBe(false);
    expect(isPinnedDsh(null)).toBe(false);
    expect(isPinnedDsh("")).toBe(false);
  });
});

describe("readDshVersion", () => {
  test("reads the first line of `dsh --version`", () => {
    expect(readDshVersion(bin("pinned", "echo 0.2.1-rc.2\n"))).toBe("0.2.1-rc.2");
  });

  test("reads a `dsh <version>` line (still pinned)", () => {
    expect(readDshVersion(bin("prefixed", "echo 'dsh 0.2.1-rc.2'\n"))).toBe("dsh 0.2.1-rc.2");
  });

  test("returns the old build's string (the caller decides it is not the pin)", () => {
    const v = readDshVersion(bin("old", "echo 0.2.0-rc.2\n"));
    expect(v).toBe("0.2.0-rc.2");
    expect(isPinnedDsh(v)).toBe(false);
  });

  test("a non-zero exit yields null", () => {
    expect(readDshVersion(bin("boom", "exit 3\n"))).toBeNull();
  });

  test("a missing binary yields null (fail closed)", () => {
    expect(readDshVersion(join(dir, "does-not-exist"))).toBeNull();
  });
});
