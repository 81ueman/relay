import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAncestorCommit, taskHeadOvertakenByOtherWriter } from "../src/run-owner";
import type { Run } from "../src/schema";

// ISH-1125: the submit-time HEAD fence must distinguish the Run's OWN pushes
// (including an intermediate commit the provider poll bound between two pushes)
// from a foreign writer. The lineage is proved in a real git repo, so these are
// real commits, not synthetic SHAs.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

function commit(cwd: string, file: string, message: string): string {
  writeFileSync(join(cwd, file), `${message}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/** A commit object descending from `parent` WITHOUT moving the worktree HEAD. */
function commitOnTop(cwd: string, parent: string, message: string): string {
  const tree = git(cwd, "rev-parse", `${parent}^{tree}`);
  return git(cwd, "commit-tree", tree, "-p", parent, "-m", message);
}

describe("ISH-1125: taskHeadOvertakenByOtherWriter provenance fence", () => {
  test("accepts base, produced, and an intermediate own push; refuses a foreign head on either side", () => {
    const cwd = mkdtempSync(join(tmpdir(), "relay-run-owner-"));
    try {
      git(cwd, "init", "-q");
      git(cwd, "config", "user.email", "relay@test");
      git(cwd, "config", "user.name", "relay-test");
      const base = commit(cwd, "base.txt", "base");
      const first = commit(cwd, "first.txt", "first push");
      const produced = commit(cwd, "final.txt", "final push");
      const run = { base_head_sha: base, head_sha: produced } as Pick<Run, "base_head_sha" | "head_sha">;

      expect(isAncestorCommit(cwd, base, first)).toBe(true);
      expect(isAncestorCommit(cwd, first, produced)).toBe(true);
      expect(isAncestorCommit(cwd, produced, base)).toBe(false);

      // The Run's own history: base -> first (polled) -> produced.
      expect(taskHeadOvertakenByOtherWriter(base, run, [cwd])).toBe(false);
      expect(taskHeadOvertakenByOtherWriter(first, run, [cwd])).toBe(false);
      expect(taskHeadOvertakenByOtherWriter(produced, run, [cwd])).toBe(false);

      // Without a repo the intermediate head cannot be PROVED, so it is refused;
      // the exact heads are still accepted (fail closed, no false stale).
      expect(taskHeadOvertakenByOtherWriter(first, run)).toBe(true);
      expect(taskHeadOvertakenByOtherWriter(base, run)).toBe(false);
      expect(taskHeadOvertakenByOtherWriter(produced, run)).toBe(false);

      // A foreign sibling from the base is not on the Run's history.
      const foreign = commitOnTop(cwd, base, "foreign sibling");
      expect(taskHeadOvertakenByOtherWriter(foreign, run, [cwd])).toBe(true);

      // A foreign commit AHEAD of the produced head must not be rewound.
      const ahead = commitOnTop(cwd, produced, "foreign ahead");
      expect(taskHeadOvertakenByOtherWriter(ahead, run, [cwd])).toBe(true);

      // A non-repo path (or unknown object) fails closed.
      expect(taskHeadOvertakenByOtherWriter(first, run, [join(cwd, "missing")])).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
