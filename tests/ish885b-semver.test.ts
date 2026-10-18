import { describe, expect, test } from "bun:test";
import { compareSemver } from "../src/ish885b/semver";

// Every precedence rule in SemVer 2.0.0 §11, plus the grammar rules that make
// an input malformed.
describe("compareSemver (SemVer 2.0.0 §11)", () => {
  test("trivial core cases", () => {
    expect(compareSemver("1.0.0", "1.0.1")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
  });

  test("orders MAJOR, MINOR, PATCH numerically (not lexically)", () => {
    expect(compareSemver("2.0.0", "10.0.0")).toBe(-1);
    expect(compareSemver("1.10.0", "1.9.0")).toBe(1);
    expect(compareSemver("1.0.10", "1.0.9")).toBe(1);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
    expect(compareSemver("1.2.4", "1.2.3")).toBe(1);
  });

  test("spec §11 example chain is strictly ordered", () => {
    const chain = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 0; i < chain.length; i += 1) {
      for (let j = 0; j < chain.length; j += 1) {
        const expected = i < j ? -1 : i > j ? 1 : 0;
        expect(compareSemver(chain[i], chain[j])).toBe(expected as -1 | 0 | 1);
      }
    }
  });

  test("a pre-release version has lower precedence than its release", () => {
    expect(compareSemver("1.0.0-alpha", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0-alpha")).toBe(1);
    expect(compareSemver("1.0.0-0", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0-zzz", "1.0.0")).toBe(-1);
  });

  test("numeric pre-release identifiers compare numerically", () => {
    expect(compareSemver("1.0.0-2", "1.0.0-10")).toBe(-1);
    expect(compareSemver("1.0.0-10", "1.0.0-2")).toBe(1);
    expect(compareSemver("1.0.0-0", "1.0.0-0")).toBe(0);
    expect(compareSemver("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe(-1);
    expect(compareSemver("1.0.0-alpha.10", "1.0.0-alpha.2")).toBe(1);
  });

  test("numeric identifiers have lower precedence than alphanumeric ones", () => {
    expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    expect(compareSemver("1.0.0-alpha", "1.0.0-1")).toBe(1);
    expect(compareSemver("1.0.0-999", "1.0.0-0A")).toBe(-1);
    expect(compareSemver("1.0.0-1.alpha", "1.0.0-alpha.1")).toBe(-1);
    // "0A" is alphanumeric despite starting with a digit.
    expect(compareSemver("1.0.0-9", "1.0.0-0A")).toBe(-1);
  });

  test("alphanumeric identifiers compare lexically in ASCII order", () => {
    expect(compareSemver("1.0.0-a", "1.0.0-b")).toBe(-1);
    expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    expect(compareSemver("1.0.0-A", "1.0.0-a")).toBe(-1); // 65 < 97
    expect(compareSemver("1.0.0--", "1.0.0-A")).toBe(-1); // 45 < 65
    expect(compareSemver("1.0.0-a", "1.0.0-A")).toBe(1);
  });

  test("a larger set of pre-release fields has higher precedence", () => {
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.1.1")).toBe(-1);
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.0")).toBe(-1);
    expect(compareSemver("1.0.0-alpha.0.0", "1.0.0-alpha.0")).toBe(1);
  });

  test("build metadata is validated but ignored for precedence", () => {
    expect(compareSemver("1.0.0+build.1", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0", "1.0.0+build.1")).toBe(0);
    expect(compareSemver("1.0.0+build.1", "1.0.0+build.2")).toBe(0);
    expect(compareSemver("1.0.0-alpha+001", "1.0.0-alpha")).toBe(0);
    expect(compareSemver("1.0.0-0.3.7", "1.0.0-0.3.7+x.7")).toBe(0);
    expect(compareSemver("1.0.0+01", "1.0.0+1")).toBe(0);
    expect(compareSemver("1.0.0+2", "1.0.1")).toBe(-1);
    expect(compareSemver("1.0.1+2", "1.0.0")).toBe(1);
  });

  test("does not lose precision for large numeric components", () => {
    expect(compareSemver("999999999999999999999.0.0", "1000000000000000000000.0.0")).toBe(-1);
    expect(compareSemver("1000000000000000000000.0.0", "999999999999999999999.0.0")).toBe(1);
    expect(compareSemver("1.0.0-999999999999999999999", "1.0.0-1000000000000000000000")).toBe(-1);
    expect(compareSemver("1.0.0-1000000000000000000000", "1.0.0-999999999999999999999")).toBe(1);
    expect(
      compareSemver("1.0.0-1000000000000000000000", "1.0.0-1000000000000000000000"),
    ).toBe(0);
  });

  test("accepts the valid edge cases of the grammar", () => {
    expect(compareSemver("0.0.0", "0.0.0")).toBe(0);
    expect(compareSemver("1.0.0--", "1.0.0--")).toBe(0);
    expect(compareSemver("1.0.0-0A", "1.0.0-0A")).toBe(0);
    expect(compareSemver("1.0.0-0.0.0", "1.0.0-0.0.0")).toBe(0);
    expect(compareSemver("1.0.0+-", "1.0.0+-")).toBe(0);
    expect(compareSemver("1.0.0+001", "1.0.0+001")).toBe(0);
  });

  test("throws on malformed versions", () => {
    const malformed = [
      "",
      "1",
      "1.0",
      "1.0.0.0",
      "v1.0.0",
      " 1.0.0",
      "1.0.0 ",
      "1.0.0\n",
      "01.0.0",
      "1.00.0",
      "1.0.00",
      "1.0.0-",
      "1.0.0+",
      "1.0.0-01",
      "1.0.0-01.alpha",
      "1.0.0-alpha..1",
      "1.0.0-alpha.",
      "1.0.0+build..1",
      "1.0.0+build.",
      "1.0.0-alpha_beta",
      "1.0.0-alpha+",
      "1.0.0+meta_1",
      "1.0.0-α",
    ];
    for (const version of malformed) {
      expect(() => compareSemver(version, "1.0.0")).toThrow();
      expect(() => compareSemver("1.0.0", version)).toThrow();
    }
  });

  test("throws on non-string input at runtime", () => {
    expect(() => compareSemver(null as unknown as string, "1.0.0")).toThrow();
    expect(() => compareSemver("1.0.0", 42 as unknown as string)).toThrow();
  });
});
