import { describe, expect, test } from "bun:test";
import { buildCommit, relayVersion, repoHead, staleBuildWarning, versionLine } from "../src/version";

// T338: the installed CLI is a BUILD artifact, so it must be able to report
// which revision it is and warn when it is behind repo HEAD. These tests run
// from SOURCE (no --define), so the BUILD_* globals are absent and the fallbacks
// apply.

describe("version/build identity (T338)", () => {
  test("running from source falls back to live git HEAD for the build commit", () => {
    // The test process is in the relay repo, so git resolves.
    const c = buildCommit();
    expect(c === null || /^[0-9a-f]{7,}$/.test(c)).toBe(true);
    expect(repoHead()).toBe(c); // both read the same live HEAD
  });

  test("versionLine includes the version and the build revision", () => {
    const line = versionLine();
    expect(line.startsWith("relay ")).toBe(true);
    expect(line).toContain("(build");
  });

  test("relayVersion is a non-empty string from source", () => {
    expect(relayVersion().length).toBeGreaterThan(0);
  });

  test("no staleness warning when the build IS the repo HEAD", () => {
    // From source, buildCommit() === repoHead(), so there is nothing to warn about.
    expect(staleBuildWarning()).toBeNull();
  });

  test("a versionLine with an explicit version renders it", () => {
    expect(versionLine("9.9.9")).toStartWith("relay 9.9.9");
  });
});
