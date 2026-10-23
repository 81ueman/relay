import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { recordRunOwnPolledHead, runObservedOwnHeads } from "../src/run-heads";
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

  // ISH-1128: the reported T253 case. A worker pushes H1, the provider poll binds
  // it, then the worker AMENDS to H2 and force-pushes. H1 is not an ancestor of
  // H2, so only the poll's own-head observation can prove it is not foreign.
  test("accepts an own head the worker amended away; a foreign head is still refused", () => {
    const cwd = mkdtempSync(join(tmpdir(), "relay-run-owner-amend-"));
    try {
      git(cwd, "init", "-q");
      git(cwd, "config", "user.email", "relay@test");
      git(cwd, "config", "user.name", "relay-test");
      const base = commit(cwd, "base.txt", "base");
      const pushed = commit(cwd, "pushed.txt", "first push");
      // Amend the SAME change: the produced head is a sibling of `pushed`, not a
      // descendant of it (the 2026-10-23 shape).
      git(cwd, "commit", "--amend", "-q", "-m", "first push (amended)");
      const produced = git(cwd, "rev-parse", "HEAD");
      const foreign = commitOnTop(cwd, base, "foreign sibling");
      const run = { base_head_sha: base, head_sha: produced } as Pick<Run, "base_head_sha" | "head_sha">;

      expect(pushed).not.toBe(produced);
      expect(isAncestorCommit(cwd, pushed, produced)).toBe(false);
      expect(isAncestorCommit(cwd, base, pushed)).toBe(true);

      // Without the poll observation the amended-away head looks foreign.
      expect(taskHeadOvertakenByOtherWriter(pushed, run, [cwd])).toBe(true);
      // The poll watched the Run's own worktree hold it, so it is accepted.
      expect(taskHeadOvertakenByOtherWriter(pushed, run, [cwd], [pushed])).toBe(false);
      // An observation for a DIFFERENT head never launders a foreign one.
      expect(taskHeadOvertakenByOtherWriter(foreign, run, [cwd], [pushed])).toBe(true);
      expect(taskHeadOvertakenByOtherWriter(produced, run, [cwd], [pushed])).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("recordRunOwnPolledHead attributes only a live same-branch Run's own commit and is idempotent", () => {
    const cwd = mkdtempSync(join(tmpdir(), "relay-run-owner-record-"));
    const db = openDb(join(cwd, "state.db"));
    try {
      git(cwd, "init", "-q");
      git(cwd, "config", "user.email", "relay@test");
      git(cwd, "config", "user.name", "relay-test");
      commit(cwd, "base.txt", "base");
      const pushed = commit(cwd, "pushed.txt", "own push");
      git(cwd, "commit", "--amend", "-q", "-m", "own push (amended)");
      const produced = git(cwd, "rev-parse", "HEAD");
      const base = git(cwd, "rev-parse", "HEAD^");
      const at = Date.now();
      db.query(
        `INSERT INTO runs
           (id, task_id, phase, attempt, generation, cwd, branch, base_head_sha, output_dir,
            state, started_at, created_at, updated_at)
         VALUES ('run-1', 'T1', 'implement', 0, 0, ?, 'relay/amended', ?, 'out', 'running', ?, ?, ?)`
      ).run(cwd, base, at, at, at);

      // The Run's own pushed-then-amended-away commit is attributed once.
      expect(recordRunOwnPolledHead(db, "T1", pushed, "relay/amended")).toEqual(["run-1"]);
      expect(recordRunOwnPolledHead(db, "T1", pushed, "relay/amended")).toEqual(["run-1"]);
      expect(runObservedOwnHeads(db, "run-1")).toEqual([pushed]);

      // A different branch, the pre-run base, and a foreign commit are never
      // attributed to this Run.
      expect(recordRunOwnPolledHead(db, "T1", pushed, "relay/other")).toEqual([]);
      expect(recordRunOwnPolledHead(db, "T1", base, "relay/amended")).toEqual([]);
      const foreign = commitOnTop(cwd, base, "foreign sibling");
      expect(recordRunOwnPolledHead(db, "T1", foreign, "relay/amended")).toEqual([]);
      expect(runObservedOwnHeads(db, "run-1")).toEqual([pushed]);
      expect(produced).not.toBe(pushed);

      // The worktree is REUSED across FIX attempts: a reflog entry written before
      // THIS Run started is not its own observation.
      db.query(
        `INSERT INTO runs
           (id, task_id, phase, attempt, generation, cwd, branch, base_head_sha, output_dir,
            state, started_at, created_at, updated_at)
         VALUES ('run-future', 'T1', 'implement', 1, 1, ?, 'relay/amended', ?, 'out', 'running', ?, ?, ?)`
      ).run(cwd, base, at + 60_000, at + 60_000, at + 60_000);
      expect(recordRunOwnPolledHead(db, "T1", pushed, "relay/amended")).toEqual(["run-1"]);
      expect(runObservedOwnHeads(db, "run-future")).toEqual([]);
    } finally {
      db.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
