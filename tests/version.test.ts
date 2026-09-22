import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(repoHead()).toBe(c); // both read the relay repo's live HEAD
  });

  test("repoHead() refuses to read a NON-relay git repo (T338 reject)", () => {
    // The reviewer's false-positive: run from an unrelated git repo and the
    // stale-build warning named the WRONG repo's HEAD. repoHead() must be null
    // there, so the warning can never fire.
    const other = mkdtempSync(join(tmpdir(), "not-relay-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: other });
      writeFileSync(join(other, "package.json"), JSON.stringify({ name: "not-relay" }));
      execFileSync("git", ["-C", other, "add", "package.json"]);
      execFileSync("git", ["-C", other, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"]);
      expect(repoHead(other)).toBeNull();
      // And a directory that is not a repo at all is also null (no throw).
      expect(repoHead(mkdtempSync(join(tmpdir(), "bare-")))).toBeNull();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
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
