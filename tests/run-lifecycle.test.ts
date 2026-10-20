import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { getTask, claimTask, claimNext } from "../src/tasks";
import { registerWorker } from "../src/workers";
import { intakeTask, recordReview, recordVerification } from "../src/workflow";
import { getRun, listRuns, type DshProcess, type DshSpawner } from "../src/dsh-runner";
import { PINNED_DSH_VERSION } from "../src/dsh-version";
import {
  applyWorkspaceCleanup,
  buildRunBrief,
  DUPLICATE_WRITER,
  ensureTaskWorktree,
  findActiveWriter,
  gitOriginUrl,
  inheritFindings,
  isSelfContainedWorkspace,
  launchTaskRun,
  planWorkspaceCleanup,
  runSubmitterError,
  taskBranchName,
} from "../src/run-lifecycle";

// ISH-760: the Task worktree + disposable dsh Run lifecycle, single-writer.
// A REAL temp git repo + a FAKE dsh process keep the whole lifecycle
// deterministic; remotes are local bare repos (the one unreachable-remote test
// asserts the fetched-or-warn fallback, not a live network path).

class FakeProcess implements DshProcess {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number | null>;
  signals: string[] = [];
  private outC!: ReadableStreamDefaultController<Uint8Array>;
  private errC!: ReadableStreamDefaultController<Uint8Array>;
  private resolveExit!: (c: number | null) => void;
  private finished = false;

  constructor(pid: number) {
    this.pid = pid;
    this.stdout = new ReadableStream({ start: (c) => (this.outC = c) });
    this.stderr = new ReadableStream({ start: (c) => (this.errC = c) });
    this.exited = new Promise<number | null>((res) => (this.resolveExit = res));
  }
  writeOut(s: string): void {
    this.outC.enqueue(new TextEncoder().encode(s));
  }
  finish(code: number | null): void {
    if (this.finished) return;
    this.finished = true;
    try {
      this.outC.close();
    } catch { /* noop */ }
    try {
      this.errC.close();
    } catch { /* noop */ }
    this.resolveExit(code);
  }
  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    this.signals.push(signal);
    this.finish(143);
  }
}

class FakeSpawner implements DshSpawner {
  procs: FakeProcess[] = [];
  argv: string[][] = [];
  cwds: string[] = [];
  envs: Record<string, string>[] = [];
  onSpawn?: (p: FakeProcess, opts: { cwd: string; env: Record<string, string> }) => void;

  spawn(argv: string[], opts: { cwd: string; env: Record<string, string> }): DshProcess {
    const p = new FakeProcess(20_000 + this.procs.length);
    this.procs.push(p);
    this.argv.push(argv);
    this.cwds.push(opts.cwd);
    this.envs.push(opts.env);
    this.onSpawn?.(p, opts);
    return p;
  }
}

let dir = "";
let repo = "";
let db: Database;
let issueSeq = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

/**
 * ISH-869: the host runner probes `<dshBin> --version`; the fake-process tests
 * below point `RELAY_DSH_BIN` at a fake that reports the pin.
 */
function pinnedDshBin(): string {
  const p = join(dir, "bin", "dsh-pinned");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(p, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${PINNED_DSH_VERSION}; exit 0; fi\nexit 0\n`);
  chmodSync(p, 0o755);
  return p;
}

let prevMinFreeDisk: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-ish760-"));
  repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "relay@test");
  git(repo, "config", "user.name", "relay-test");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "base");
  process.env.RELAY_DB = join(dir, "state.db");
  // ISH-1009: these tests exercise the lifecycle, not the host's real free space.
  prevMinFreeDisk = process.env.RELAY_MIN_FREE_DISK_BYTES;
  process.env.RELAY_MIN_FREE_DISK_BYTES = "0";
  db = openDb(process.env.RELAY_DB);
  registerWorker(db, "impl", { role: "worker" });
  registerWorker(db, "rev", { role: "reviewer" });
  issueSeq = 0;
  // ISH-869: launchTaskRun -> startDshRun probes `<dshBin> --version`.
  process.env.RELAY_DSH_BIN = pinnedDshBin();
});

afterEach(() => {
  db.close();
  delete process.env.RELAY_DSH_BIN;
  if (prevMinFreeDisk === undefined) delete process.env.RELAY_MIN_FREE_DISK_BYTES;
  else process.env.RELAY_MIN_FREE_DISK_BYTES = prevMinFreeDisk;
  rmSync(dir, { recursive: true, force: true });
});

/** A code-change task with NO linked worktree/branch (a fresh manual injection). */
function newTask(extra: { prUrl?: string; prRepo?: string; checks?: { name: string; command: string }[] } = {}) {
  const t = intakeTask(db, {
    provider: "test",
    issueId: `ISH-760-${issueSeq++}`,
    codeChange: true,
    title: "implement the thing",
    prUrl: extra.prUrl,
    prRepo: extra.prRepo,
    checks: extra.checks,
  });
  return t.id;
}

const outputRoot = () => join(dir, "runs");

/** True when `cwd`'s repo has the commit object (no throw on absence). */
function hasCommit(cwd: string, sha: string): boolean {
  try {
    execFileSync("git", ["-C", cwd, "cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("Task worktree: create / select / own (one branch+worktree per Task)", () => {
  test("creates a worktree on a deterministic branch and records it on the Task", () => {
    const id = newTask();
    const b = ensureTaskWorktree(db, id, { repo });
    expect(b.created).toBe(true);
    expect(existsSync(b.worktree)).toBe(true);
    expect(b.branch.startsWith("relay/")).toBe(true);
    expect(git(b.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(b.branch);
    // The Task durably owns the worktree/branch.
    const task = getTask(db, id)!;
    expect(task.worktree).toBe(b.worktree);
    expect(task.branch).toBe(b.branch);
  });

  test("is idempotent: a second call SELECTS the same worktree (no new branch)", () => {
    const id = newTask();
    const b1 = ensureTaskWorktree(db, id, { repo });
    const b2 = ensureTaskWorktree(db, id, { repo });
    expect(b2.created).toBe(false);
    expect(b2.worktree).toBe(b1.worktree);
    expect(b2.branch).toBe(b1.branch);
    // The SOURCE repo was never enlisted as a worktree owner (ISH-904).
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(b1.worktree);
  });

  test("refuses a non-code-change task", () => {
    const t = intakeTask(db, { provider: "test", issueId: `ISH-760-plain-${issueSeq++}`, title: "plain" });
    expect(() => ensureTaskWorktree(db, t.id, { repo })).toThrow(/not a code-change task/);
  });

  test("taskBranchName is deterministic and honours an explicit branch", () => {
    const id = newTask();
    const t = getTask(db, id)!;
    expect(taskBranchName(t)).toContain("ish-760-");
    expect(taskBranchName({ ...t, branch: "feature/x" })).toBe("feature/x");
  });
});

// ISH-904: the Task workspace must be SELF-CONTAINED — every git dir it needs
// lives INSIDE it, so a `workspace-write` Run (writable set = the cwd) can
// commit/push. A linked `git worktree add` checkout keeps its git dir at
// `<source>/.git/worktrees/<T>` and its common dir at `<source>/.git`: both
// outside, so every git mutation (index.lock, ORIG_HEAD, refs) was denied.
describe("ISH-904: the workspace is self-contained (git dir + common dir inside)", () => {
  const gitDirOf = (wt: string) => execFileSync("git", ["-C", wt, "rev-parse", "--path-format=absolute", "--git-dir"], { encoding: "utf8" }).trim();
  const commonDirOf = (wt: string) =>
    execFileSync("git", ["-C", wt, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();

  test("git-dir AND git-common-dir resolve INSIDE the workspace (no <source>/.git)", () => {
    const id = newTask();
    const b = ensureTaskWorktree(db, id, { repo });
    const gd = realpathSync(gitDirOf(b.worktree));
    const cd = realpathSync(commonDirOf(b.worktree));
    const wtr = realpathSync(b.worktree);
    expect(gd.startsWith(wtr + "/")).toBe(true);
    expect(cd.startsWith(wtr + "/")).toBe(true);
    expect(gd).toBe(join(wtr, ".git"));
    expect(cd).toBe(gd);
    // Nothing in the workspace points back at the source repo's git dir.
    expect(gd).not.toContain(realpathSync(join(repo, ".git")));
    expect(cd).not.toContain(realpathSync(join(repo, ".git")));
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(wtr);
    expect(isSelfContainedWorkspace(b.worktree)).toBe(true);
  });

  test("a legacy linked worktree is NOT self-contained (the ISH-904 regression)", () => {
    const legacy = join(dir, "legacy-linked");
    git(repo, "worktree", "add", "-q", "-b", "legacy/branch", legacy, "HEAD");
    expect(isSelfContainedWorkspace(legacy)).toBe(false);
    expect(realpathSync(gitDirOf(legacy)).startsWith(realpathSync(legacy) + "/")).toBe(false);
  });

  test("with the source repo's .git unwritable, the workspace still commits (workspace-write shape)", () => {
    const id = newTask();
    const b = ensureTaskWorktree(db, id, { repo });
    const sourceGit = join(repo, ".git");
    chmodSync(sourceGit, 0o500); // no writes under the SOURCE .git at all
    try {
      writeFileSync(join(b.worktree, "work.txt"), "implemented\n");
      git(b.worktree, "add", "work.txt");
      git(b.worktree, "-c", "user.email=relay@test", "-c", "user.name=relay-test", "commit", "-q", "-m", "ish-904");
      expect(git(b.worktree, "rev-parse", "HEAD")).not.toBe(git(repo, "rev-parse", "HEAD"));
      expect(git(b.worktree, "log", "-1", "--format=%s")).toBe("ish-904");
    } finally {
      chmodSync(sourceGit, 0o755);
    }
  });

  test("origin points at the SOURCE repo's origin URL (never the local source path) and pushes", () => {
    // A stand-in "GitHub": a bare repo OUTSIDE both the source and the workspace.
    const remote = join(dir, "remote.git");
    execFileSync("git", ["clone", "-q", "--bare", repo, remote]);
    git(repo, "remote", "add", "origin", remote);
    const id = newTask();
    const b = ensureTaskWorktree(db, id, { repo });
    expect(gitOriginUrl(repo)).toBe(remote);
    expect(git(b.worktree, "remote", "get-url", "origin")).toBe(remote);
    expect(git(b.worktree, "remote", "get-url", "--push", "origin")).toBe(remote);
    expect(git(b.worktree, "remote", "get-url", "origin")).not.toBe(realpathSync(repo));

    // The pinned brief's push command works as written.
    execFileSync("git", ["-C", b.worktree, "push", "origin", `HEAD:refs/heads/${b.branch}`], { stdio: ["ignore", "pipe", "pipe"] });
    expect(git(remote, "rev-parse", `refs/heads/${b.branch}`)).toBe(git(b.worktree, "rev-parse", "HEAD"));
    expect(buildRunBrief(db, { ...getTask(db, id)!, pr_url: "81ueman/relay#9" }, { worktree: b.worktree, branch: b.branch }).text).toContain(
      `git push origin HEAD:refs/heads/${b.branch}`
    );
  });

  test("a source checkout that itself has alternates yields a clone with NO alternates escape", () => {
    // The real shape: relay's source checkout may be a clone/worktree sharing
    // `<main>/.git/objects`. A local clone of THAT would record an alternates
    // path back outside the workspace.
    const shared = join(dir, "shared-clone");
    execFileSync("git", ["clone", "-q", "--shared", repo, shared], { stdio: ["ignore", "pipe", "pipe"] });
    expect(existsSync(join(shared, ".git", "objects", "info", "alternates"))).toBe(true);
    const id = newTask();
    const b = ensureTaskWorktree(db, id, { repo: shared, base: "HEAD" });
    expect(existsSync(join(b.worktree, ".git", "objects", "info", "alternates"))).toBe(false);
    expect(isSelfContainedWorkspace(b.worktree)).toBe(true);
    // And the workspace still has every object (it can check out + commit).
    writeFileSync(join(b.worktree, "x.txt"), "x\n");
    git(b.worktree, "add", "x.txt");
    git(b.worktree, "-c", "user.email=relay@test", "-c", "user.name=relay-test", "commit", "-q", "-m", "x");
    expect(git(b.worktree, "log", "-1", "--format=%s")).toBe("x");
  });

  test("a repo WITHOUT an origin gets NO remote (never the local source path)", () => {
    const id = newTask();
    const b = ensureTaskWorktree(db, id, { repo });
    expect(gitOriginUrl(repo)).toBeNull();
    // The local clone's origin was the source PATH; it is dropped, so nothing can
    // push into the source checkout by accident.
    expect(git(b.worktree, "remote")).toBe("");
  });

  test("the DEFAULT base is the SOURCE's origin/main, even when the source's local main is behind", () => {
    const remote = join(dir, "remote.git");
    execFileSync("git", ["clone", "-q", "--bare", repo, remote]);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "fetch", "-q", "origin");
    // The remote moves ahead of the source's local main.
    const scratch = join(dir, "scratch");
    execFileSync("git", ["clone", "-q", remote, scratch]);
    execFileSync("git", ["-C", scratch, "config", "user.email", "r@test"]);
    execFileSync("git", ["-C", scratch, "config", "user.name", "r-test"]);
    writeFileSync(join(scratch, "remote-only.txt"), "remote\n");
    execFileSync("git", ["-C", scratch, "add", "remote-only.txt"]);
    execFileSync("git", ["-C", scratch, "commit", "-q", "-m", "remote ahead"]);
    execFileSync("git", ["-C", scratch, "push", "-q", "origin", "HEAD:refs/heads/main"]);
    git(repo, "fetch", "-q", "origin");
    const remoteMain = git(repo, "rev-parse", "refs/remotes/origin/main");
    const localMain = git(repo, "rev-parse", "refs/heads/main");
    expect(remoteMain).not.toBe(localMain);

    const id = newTask();
    const b = ensureTaskWorktree(db, id, { repo });
    // The clone's own origin/main would be the SOURCE's local main: the base must
    // come from the source's remote-tracking ref instead.
    expect(git(b.worktree, "rev-parse", "HEAD")).toBe(remoteMain);
    expect(git(b.worktree, "rev-parse", "HEAD")).not.toBe(localMain);
    expect(existsSync(join(b.worktree, "remote-only.txt"))).toBe(true);
  });

  test("ISH-904: a STALE source origin/main is FETCHED before the Task branch is cut", () => {
    const remote = join(dir, "remote.git");
    execFileSync("git", ["clone", "-q", "--bare", repo, remote]);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "fetch", "-q", "origin");
    const stale = git(repo, "rev-parse", "refs/remotes/origin/main");
    // The remote advances; the source does NOT fetch (the overnight factory shape).
    const scratch = join(dir, "scratch-fetch");
    execFileSync("git", ["clone", "-q", remote, scratch]);
    execFileSync("git", ["-C", scratch, "config", "user.email", "r@test"]);
    execFileSync("git", ["-C", scratch, "config", "user.name", "r-test"]);
    writeFileSync(join(scratch, "fresh.txt"), "fresh\n");
    execFileSync("git", ["-C", scratch, "add", "fresh.txt"]);
    execFileSync("git", ["-C", scratch, "commit", "-q", "-m", "remote moved"]);
    execFileSync("git", ["-C", scratch, "push", "-q", "origin", "HEAD:refs/heads/main"]);
    const fresh = git(scratch, "rev-parse", "HEAD");
    expect(git(repo, "rev-parse", "refs/remotes/origin/main")).toBe(stale);

    const id = newTask();
    const warnings: string[] = [];
    const b = ensureTaskWorktree(db, id, { repo, onWarning: (m) => warnings.push(m) });
    expect(git(b.worktree, "rev-parse", "HEAD")).toBe(fresh);
    expect(git(b.worktree, "rev-parse", "HEAD")).not.toBe(stale);
    expect(b.base).toBe("origin/main");
    expect(b.baseSha).toBe(fresh);
    expect(b.warnings ?? []).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("ISH-904: a recorded pr_base resolves to origin/<base>, never the stale local branch", () => {
    const remote = join(dir, "remote.git");
    execFileSync("git", ["clone", "-q", "--bare", repo, remote]);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "fetch", "-q", "origin");
    // The remote moves ahead; source local `main` stays behind.
    const scratch = join(dir, "scratch-prbase");
    execFileSync("git", ["clone", "-q", remote, scratch]);
    execFileSync("git", ["-C", scratch, "config", "user.email", "r@test"]);
    execFileSync("git", ["-C", scratch, "config", "user.name", "r-test"]);
    writeFileSync(join(scratch, "prbase.txt"), "prbase\n");
    execFileSync("git", ["-C", scratch, "add", "prbase.txt"]);
    execFileSync("git", ["-C", scratch, "commit", "-q", "-m", "remote moved"]);
    execFileSync("git", ["-C", scratch, "push", "-q", "origin", "HEAD:refs/heads/main"]);
    const fresh = git(scratch, "rev-parse", "HEAD");
    const localMain = git(repo, "rev-parse", "refs/heads/main");
    expect(fresh).not.toBe(localMain);

    const t = intakeTask(db, {
      provider: "test",
      issueId: `ISH-904-pr-base-${issueSeq++}`,
      codeChange: true,
      title: "pr base",
      prBase: "main",
    });
    const b = ensureTaskWorktree(db, t.id, { repo });
    expect(b.base).toBe("origin/main");
    expect(git(b.worktree, "rev-parse", "HEAD")).toBe(fresh);
    expect(existsSync(join(b.worktree, "prbase.txt"))).toBe(true);
  });

  test("ISH-904: an explicit base behind origin/main WARNS (never silent)", () => {
    const remote = join(dir, "remote.git");
    execFileSync("git", ["clone", "-q", "--bare", repo, remote]);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "fetch", "-q", "origin");
    const staleMain = git(repo, "rev-parse", "refs/heads/main");
    const scratch = join(dir, "scratch-warn");
    execFileSync("git", ["clone", "-q", remote, scratch]);
    execFileSync("git", ["-C", scratch, "config", "user.email", "r@test"]);
    execFileSync("git", ["-C", scratch, "config", "user.name", "r-test"]);
    writeFileSync(join(scratch, "ahead.txt"), "ahead\n");
    execFileSync("git", ["-C", scratch, "add", "ahead.txt"]);
    execFileSync("git", ["-C", scratch, "commit", "-q", "-m", "ahead"]);
    execFileSync("git", ["-C", scratch, "push", "-q", "origin", "HEAD:refs/heads/main"]);
    const fresh = git(scratch, "rev-parse", "HEAD");

    const id = newTask();
    const seen: string[] = [];
    const b = ensureTaskWorktree(db, id, { repo, base: "main", onWarning: (m) => seen.push(m) });
    // The explicit base is still honoured (the operator named it)...
    expect(git(b.worktree, "rev-parse", "HEAD")).toBe(staleMain);
    // ...but it is NEVER silent about being behind the freshly fetched trunk.
    const warning = (b.warnings ?? []).join("\n");
    expect(warning).toContain("behind origin/main");
    expect(warning).toContain(staleMain.slice(0, 10));
    expect(warning).toContain(fresh.slice(0, 10));
    expect(seen.join("\n")).toContain("behind origin/main");
  });

  test("the default base works when the source has no LOCAL main (origin/main is the only main)", () => {
    const remote = join(dir, "remote.git");
    execFileSync("git", ["clone", "-q", "--bare", repo, remote]);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "fetch", "-q", "origin");
    const remoteMain = git(repo, "rev-parse", "refs/remotes/origin/main");
    git(repo, "update-ref", "-d", "refs/heads/main"); // orphan the source's local main
    git(repo, "symbolic-ref", "HEAD", "refs/heads/main");
    const id = newTask();
    const b = ensureTaskWorktree(db, id, { repo });
    expect(git(b.worktree, "rev-parse", "HEAD")).toBe(remoteMain);
  });

  test("a branch that exists ONLY on origin is checked out (re-running a pushed Task)", () => {
    const remote = join(dir, "remote.git");
    execFileSync("git", ["clone", "-q", "--bare", repo, remote]);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "fetch", "-q", "origin");
    git(repo, "checkout", "-q", "-b", "relay/ish-904");
    writeFileSync(join(repo, "pushed.txt"), "pushed\n");
    git(repo, "add", "pushed.txt");
    git(repo, "commit", "-q", "-m", "pushed work");
    const pushedSha = git(repo, "rev-parse", "HEAD");
    git(repo, "push", "-q", "origin", "relay/ish-904");
    // The source has neither the local branch nor a local fetch of the push: only
    // the remote-tracking side of a fresh fetch exists — drop that too.
    git(repo, "checkout", "-q", "main");
    git(repo, "branch", "-q", "-D", "relay/ish-904");
    git(repo, "update-ref", "-d", "refs/remotes/origin/relay/ish-904");
    git(repo, "fetch", "-q", "origin"); // the branch now exists ONLY on origin

    const t = intakeTask(db, { provider: "test", issueId: "ISH-904", codeChange: true, title: "x" });
    const b = ensureTaskWorktree(db, t.id, { repo, branch: "relay/ish-904" });
    expect(b.branch).toBe("relay/ish-904");
    expect(git(b.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("relay/ish-904");
    expect(git(b.worktree, "rev-parse", "HEAD")).toBe(pushedSha);
    expect(existsSync(join(b.worktree, "pushed.txt"))).toBe(true);
  });

  test("a failed origin refresh WARNS but still creates the workspace from local refs", () => {
    git(repo, "remote", "add", "origin", "https://unreachable.invalid/never.git");
    const id = newTask();
    const b = ensureTaskWorktree(db, id, { repo });
    expect(b.created).toBe(true);
    expect((b.warnings ?? []).join("\n")).toContain("could not refresh origin");
    expect(git(b.worktree, "remote", "get-url", "origin")).toBe("https://unreachable.invalid/never.git");
    expect(git(b.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(b.branch);
  });

  test("reuses an existing Task branch (local source branch) and checks it out", () => {
    git(repo, "branch", "relay/ish-904", "HEAD");
    const t = intakeTask(db, { provider: "test", issueId: "ISH-904", codeChange: true, title: "x" });
    const b = ensureTaskWorktree(db, t.id, { repo, branch: "relay/ish-904" });
    expect(b.branch).toBe("relay/ish-904");
    expect(git(b.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("relay/ish-904");
    expect(isSelfContainedWorkspace(b.worktree)).toBe(true);
  });

  test("an explicit base that only exists in the SOURCE local refs is honoured", () => {
    git(repo, "checkout", "-q", "-b", "base/local-only");
    writeFileSync(join(repo, "base-only.txt"), "local base\n");
    git(repo, "add", "base-only.txt");
    git(repo, "commit", "-q", "-m", "local-only base");
    const baseSha = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "-");
    const id = newTask();
    const b = ensureTaskWorktree(db, id, { repo, base: "base/local-only" });
    expect(git(b.worktree, "rev-parse", "HEAD")).toBe(baseSha);
    expect(existsSync(join(b.worktree, "base-only.txt"))).toBe(true);
  });

  test("an existing NON self-contained directory at the path is refused", () => {
    const id = newTask();
    const target = join(dir, "worktrees", getTask(db, id)!.id);
    mkdirSync(join(dir, "worktrees"), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", "linked/at-path", target, "HEAD");
    expect(() => ensureTaskWorktree(db, id, { repo, worktreesRoot: join(dir, "worktrees") })).toThrow(/not a self-contained git clone/);
  });

  test("a failed checkout leaves NO half-made workspace behind (fail closed)", () => {
    const id = newTask();
    const target = join(dir, "worktrees", getTask(db, id)!.id);
    expect(() => ensureTaskWorktree(db, id, { repo, path: target, base: "does/not/exist" })).toThrow(/WORKTREE_ERROR/);
    expect(existsSync(target)).toBe(false);
    expect(getTask(db, id)!.worktree).toBeNull();
  });
});

describe("single-writer: one disposable Run per phase/attempt", () => {
  test("launch ensures the worktree, pins the brief, and runs in it", async () => {
    const id = newTask();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => {
      p.writeOut("done\n");
      p.finish(0);
    };
    const launched = await launchTaskRun(db, id, { repo, spawner, outputRoot: outputRoot(), fastExitMs: 0 });
    const run = await launched.handle.wait();

    expect(run.state).toBe("exited");
    expect(run.exit_code).toBe(0);
    expect(run.cwd).toBe(launched.worktree);
    expect(spawner.cwds[0]).toBe(launched.worktree);
    // ISH-810: the pinned headless CLI now carries `--json` before the task.
    expect(spawner.argv[0][0]).toBe(process.env.RELAY_DSH_BIN!);
    expect(spawner.argv[0].slice(1, 5)).toEqual(["--profile", "headless", "--json", expect.any(String)]);
    expect(spawner.argv[0][4]).toContain(`# Task ${id}`);
    expect(run.generation).toBe(run.attempt);
    // The brief is pinned IN the worktree before launch.
    expect(existsSync(launched.briefPath)).toBe(true);
    expect(readFileSync(launched.briefPath, "utf-8")).toContain(`branch: ${launched.branch}`);
  });

  test("a duplicate writer on the same worktree/branch is refused while the Run is live", async () => {
    const id = newTask();
    const slow = new FakeSpawner(); // never finishes
    const launched = await launchTaskRun(db, id, { repo, spawner: slow, outputRoot: outputRoot() });
    expect(getRun(db, launched.handle.id)!.state).toBe("running");

    await expect(launchTaskRun(db, id, { repo, spawner: new FakeSpawner(), outputRoot: outputRoot() })).rejects.toThrow(
      new RegExp(DUPLICATE_WRITER)
    );

    // Different worktree (a different Task) may run in parallel — even on the
    // same files — so a second Task's launch is allowed.
    const other = newTask();
    const otherSpawner = new FakeSpawner();
    const otherLaunched = await launchTaskRun(db, other, { repo, spawner: otherSpawner, outputRoot: outputRoot() });
    expect(getRun(db, otherLaunched.handle.id)!.state).toBe("running");
    expect(otherLaunched.worktree).not.toBe(launched.worktree);

    // Once the first Run ENDS, the writer is released.
    slow.procs[0].finish(0);
    await launched.handle.wait();
    const again = await launchTaskRun(db, id, { repo, spawner: new FakeSpawner(), outputRoot: outputRoot() });
    expect(getRun(db, again.handle.id)!.state).toBe("running");
    again.handle.cancel();
  });

  test("findActiveWriter keys on worktree OR branch, never on unrelated Runs", async () => {
    const a = newTask();
    const b = newTask();
    const la = await launchTaskRun(db, a, { repo, spawner: new FakeSpawner(), outputRoot: outputRoot() });
    expect(findActiveWriter(db, { cwd: la.worktree })!.id).toBe(la.handle.id);
    expect(findActiveWriter(db, { cwd: la.worktree, branch: la.branch })!.id).toBe(la.handle.id);
    // A different worktree/branch has no active writer.
    const lb = ensureTaskWorktree(db, b, { repo });
    expect(findActiveWriter(db, { cwd: lb.worktree, branch: lb.branch })).toBeNull();
    la.handle.cancel();
  });

  test("a refused launch does NOT overwrite the live writer's pinned brief (finding 2)", async () => {
    const id = newTask();
    const slow = new FakeSpawner(); // never finishes: the first Run stays live
    const first = await launchTaskRun(db, id, { repo, spawner: slow, outputRoot: outputRoot() });
    const briefBefore = readFileSync(first.briefPath, "utf-8");
    expect(briefBefore).toContain("implement the thing");

    // A would-be second launcher changes the Task so a FRESH brief WOULD differ.
    db.query(`UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?`).run("CHANGED title", Date.now(), id);

    await expect(
      launchTaskRun(db, id, { repo, spawner: new FakeSpawner(), outputRoot: outputRoot() })
    ).rejects.toThrow(new RegExp(DUPLICATE_WRITER));

    // The brief the LIVE Run was launched with is byte-for-byte unchanged.
    const briefAfter = readFileSync(first.briefPath, "utf-8");
    expect(briefAfter).toBe(briefBefore);
    expect(briefAfter).not.toContain("CHANGED title");

    slow.procs[0].finish(0);
    await first.handle.wait();
  });
});

describe("single-writer is atomic ACROSS PROCESSES (finding 1)", () => {
  test("two concurrent launch processes admit exactly one writer", async () => {
    const id = newTask();
    const binding = ensureTaskWorktree(db, id, { repo });

    // A fake dsh that HOLDS the worktree, so the loser observes the live row.
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    const dsh = join(binDir, "dsh-race");
    writeFileSync(dsh, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.2.1-rc.2; exit 0; fi\nsleep 1.5\nexit 0\n');
    chmodSync(dsh, 0o755);

    const fixture = join(import.meta.dir, "fixtures", "ish760-race.ts");
    const repoRoot = join(import.meta.dir, "..");
    const env = {
      ...process.env,
      RELAY_DB: process.env.RELAY_DB!,
      TASK_ID: id,
      WORKTREE: binding.worktree,
      OUTPUT_ROOT: outputRoot(),
      DSH_BIN: dsh,
      // A start barrier: both processes hit the guard at ~the same instant.
      GO_AT: String(Date.now() + 1200),
    };
    const spawn = () => Bun.spawn(["bun", fixture], { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" });
    const p1 = spawn();
    const p2 = spawn();
    const outs = await Promise.all([new Response(p1.stdout).text(), new Response(p2.stdout).text()]);
    const codes = await Promise.all([p1.exited, p2.exited]);

    const admitted = outs.filter((o) => /^ADMITTED /m.test(o));
    const refused = outs.filter((o) => /DUPLICATE_WRITER/.test(o));
    expect(codes).toEqual([0, 0]);
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(listRuns(db, { taskId: id })).toHaveLength(1);
  }, 20000);
});

describe("FIX: same worktree + previous findings + a new Run (no session continuation)", () => {
  test("a review FIX reuses the worktree and pins the previous findings", async () => {
    const id = newTask();
    // implement (Run) -> adopt head -> verify -> review FIX -> implement attempt 1.
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => p.finish(0);
    const impl = await launchTaskRun(db, id, { repo, spawner, outputRoot: outputRoot(), fastExitMs: 0 });
    await impl.handle.wait();
    const { acceptRunSubmission } = await import("../src/dsh-runner");
    acceptRunSubmission(db, { runId: impl.handle.id });
    expect(getTask(db, id)!.phase).toBe("verify");

    const head = getTask(db, id)!.head_sha;
    claimTask(db, id, "impl");
    recordVerification(db, id, "impl", { passed: true });
    expect(getTask(db, id)!.phase).toBe("review");
    claimNext(db, "rev");
    recordReview(db, id, "rev", { verdict: "fix", headSha: head ?? undefined, reason: "null deref in parser" });
    const afterFix = getTask(db, id)!;
    expect(afterFix.phase).toBe("implement");
    expect(afterFix.attempt).toBe(1);

    // The findings are inherited from attempt 0's review.
    const findings = inheritFindings(db, afterFix);
    expect(findings.length).toBe(1);
    expect(findings[0].reason).toBe("null deref in parser");

    const fixSpawner = new FakeSpawner();
    fixSpawner.onSpawn = (p) => p.finish(0);
    const fix = await launchTaskRun(db, id, { repo, spawner: fixSpawner, outputRoot: outputRoot(), fastExitMs: 0 });
    expect(fix.worktree).toBe(impl.worktree); // SAME worktree
    expect(fix.handle.id).not.toBe(impl.handle.id); // a NEW disposable Run
    expect(fix.findings.length).toBe(1);
    const brief = readFileSync(fix.briefPath, "utf-8");
    expect(brief).toContain("Prior findings");
    expect(brief).toContain("null deref in parser");
    await fix.handle.wait();
  });

  test("buildRunBrief includes the verification steps recorded at intake", () => {
    const id = newTask({ checks: [{ name: "typecheck", command: "bun run typecheck" }] });
    const b = ensureTaskWorktree(db, id, { repo });
    const brief = buildRunBrief(db, getTask(db, id)!, { worktree: b.worktree, branch: b.branch });
    expect(brief.text).toContain("## Verification steps");
    expect(brief.text).toContain("bun run typecheck");
    expect(brief.findings).toEqual([]);
  });

  // ISH-885: the Factory's read-only Task<->PR gate requires the Coding Agent to
  // have pushed/created the PR, so a PR-bound brief MUST say so.
  test("buildRunBrief tells a PR-bound Task to push/open the PR (never default branch / merge / review)", () => {
    const id = newTask({ prUrl: "81ueman/relay#7", prRepo: "81ueman/relay" });
    const b = ensureTaskWorktree(db, id, { repo });
    const brief = buildRunBrief(db, getTask(db, id)!, { worktree: b.worktree, branch: b.branch });
    expect(brief.text).toContain("## Publish the Task branch as a GitHub PR");
    expect(brief.text).toContain(`git push origin HEAD:refs/heads/${b.branch}`);
    expect(brief.text).toContain("gh pr create --repo 81ueman/relay");
    expect(brief.text).toContain("NEVER the default branch");
    expect(brief.text).toContain("SAME PR");
    expect(brief.text).toContain("NEVER merge");
  });

  test("buildRunBrief omits the PR instruction for a local-only Task", () => {
    const id = newTask();
    const b = ensureTaskWorktree(db, id, { repo });
    const brief = buildRunBrief(db, getTask(db, id)!, { worktree: b.worktree, branch: b.branch });
    expect(brief.text).not.toContain("Publish the Task branch as a GitHub PR");
    expect(brief.text).not.toContain("gh pr create");
    expect(brief.text).not.toContain("git push origin HEAD");
  });
});

describe("submitter binding: a stale/late/failed Run never advances the Task", () => {
  async function cleanRun(id: string) {
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => p.finish(0);
    const launched = await launchTaskRun(db, id, { repo, spawner, outputRoot: outputRoot(), fastExitMs: 0 });
    const run = await launched.handle.wait();
    return { run, launched };
  }

  test("a correctly-bound Run advances implement -> verify", async () => {
    const id = newTask();
    const { run } = await cleanRun(id);
    expect(runSubmitterError(run, getTask(db, id)!)).toBeNull();
    const { acceptRunSubmission } = await import("../src/dsh-runner");
    const accepted = acceptRunSubmission(db, { runId: run.id });
    expect(accepted.state).toBe("submitted");
    expect(getTask(db, id)!.phase).toBe("verify");
  });

  test("a moved task head refuses the submission", async () => {
    const id = newTask();
    const { run } = await cleanRun(id);
    const { acceptRunSubmission } = await import("../src/dsh-runner");
    const { linkTask } = await import("../src/workflow");
    linkTask(db, id, { headSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });
    expect(() => acceptRunSubmission(db, { runId: run.id })).toThrow(/RUN_SUBMISSION_REJECTED/);
    expect(getTask(db, id)!.phase).toBe("implement");
  });

  test("a superseded (late) Run is refused even if it exited 0", async () => {
    const id = newTask();
    const { run } = await cleanRun(id);
    // A NEWER Run row for the same task/phase/attempt supersedes it.
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => p.finish(0);
    const newer = await launchTaskRun(db, id, { repo, spawner, outputRoot: outputRoot(), fastExitMs: 0 });
    await newer.handle.wait();
    const { acceptRunSubmission } = await import("../src/dsh-runner");
    expect(() => acceptRunSubmission(db, { runId: run.id })).toThrow(/superseded/);
  });

  test("runSubmitterError reports a phase/attempt/generation mismatch", () => {
    const t = getTask(db, newTask())!;
    const fake = (over: Partial<Parameters<typeof runSubmitterError>[0]>) =>
      ({ id: "run-x", task_id: t.id, phase: t.phase, attempt: t.attempt, generation: t.attempt, branch: null, base_head_sha: null, ...over }) as never;
    expect(runSubmitterError(fake({}), t)).toBeNull();
    expect(runSubmitterError(fake({ phase: "review" }), t)).toMatch(/phase/);
    expect(runSubmitterError(fake({ attempt: 9 }), t)).toMatch(/attempt/);
    expect(runSubmitterError(fake({ generation: 9 }), t)).toMatch(/generation/);
    expect(runSubmitterError(fake({ task_id: "T999" }), t)).toMatch(/belongs to task/);
  });
});

describe("safe cleanup: permissions, evidence, PR lifecycle", () => {
  test("a live Run blocks cleanup; an open PR blocks cleanup", async () => {
    const id = newTask({ prUrl: "https://example.test/pr/1" });
    const launched = await launchTaskRun(db, id, { repo, spawner: new FakeSpawner(), outputRoot: outputRoot() });
    const plan = planWorkspaceCleanup(db, id, { repo, worktreesRoot: join(dir, "worktrees") });
    expect(plan.remove).toBe(false);
    expect(plan.reasons.join(" ")).toMatch(/active run/);
    launched.handle.cancel();
    await launched.handle.wait();
    const plan2 = planWorkspaceCleanup(db, id, { repo, worktreesRoot: join(dir, "worktrees") });
    expect(plan2.reasons.join(" ")).toMatch(/open PR/);
  });

  test("an explicit abort allows reclaiming the worktree", async () => {
    const id = newTask();
    const b = ensureTaskWorktree(db, id, { repo });
    const plan = applyWorkspaceCleanup(db, id, { apply: true, abort: "Gateway abandoned the lane", repo, worktreesRoot: join(dir, "worktrees") });
    expect(plan.removed).toBe(true);
    expect(existsSync(b.worktree)).toBe(false);
    expect(getTask(db, id)!.worktree).toBeNull();
  });

  test("reclaiming a clone workspace is idempotent and never touches the SOURCE .git", async () => {
    const id = newTask();
    const b = ensureTaskWorktree(db, id, { repo });
    const sourceHead = git(repo, "rev-parse", "HEAD");
    const opts = { apply: true, abort: "abort", repo, worktreesRoot: join(dir, "worktrees") };
    expect(applyWorkspaceCleanup(db, id, opts).removed).toBe(true);
    expect(existsSync(b.worktree)).toBe(false);
    // Second apply: the ledger binding is gone -> a plain no-op, never a throw.
    const again = applyWorkspaceCleanup(db, id, opts);
    expect(again.removed).toBe(false);
    expect(again.reasons.join(" ")).toMatch(/no recorded worktree/);
    // The source repo is unchanged: same HEAD, no worktree enlisted, still clean.
    expect(git(repo, "rev-parse", "HEAD")).toBe(sourceHead);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(b.worktree);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  test("an UNPUSHED commit on the workspace is copied into the SOURCE repo before removal", () => {
    const remote = join(dir, "remote.git");
    execFileSync("git", ["clone", "-q", "--bare", repo, remote]);
    git(repo, "remote", "add", "origin", remote);
    const id = newTask();
    const b = ensureTaskWorktree(db, id, { repo });
    writeFileSync(join(b.worktree, "wip.txt"), "wip\n");
    git(b.worktree, "add", "wip.txt");
    git(b.worktree, "-c", "user.email=relay@test", "-c", "user.name=relay-test", "commit", "-q", "-m", "unpushed work");
    const unpushed = git(b.worktree, "rev-parse", "HEAD");
    expect(hasCommit(repo, unpushed)).toBe(false); // not in the source yet

    const opts = { apply: true, abort: "abandoned", repo, worktreesRoot: join(dir, "worktrees") };
    const plan = applyWorkspaceCleanup(db, id, opts);
    expect(plan.removed).toBe(true);
    expect(existsSync(b.worktree)).toBe(false);
    // The commit survived in the source repo (what a linked worktree used to give).
    expect(hasCommit(repo, unpushed)).toBe(true);
    expect(git(repo, "log", "-1", "--format=%s", "refs/relay-kept/HEAD")).toBe("unpushed work");
  });

  test("a PUSHED commit needs no rescue (cleanup is a plain removal)", () => {
    const remote = join(dir, "remote.git");
    execFileSync("git", ["clone", "-q", "--bare", repo, remote]);
    git(repo, "remote", "add", "origin", remote);
    const id = newTask();
    const b = ensureTaskWorktree(db, id, { repo });
    writeFileSync(join(b.worktree, "pushed.txt"), "pushed\n");
    git(b.worktree, "add", "pushed.txt");
    git(b.worktree, "-c", "user.email=relay@test", "-c", "user.name=relay-test", "commit", "-q", "-m", "pushed work");
    git(b.worktree, "push", "-q", "origin", `HEAD:refs/heads/${b.branch}`);
    const plan = applyWorkspaceCleanup(db, id, { apply: true, abort: "aborted", repo, worktreesRoot: join(dir, "worktrees") });
    expect(plan.removed).toBe(true);
  });

  test("--force really discards unpushed commits (no rescue ref is written)", () => {
    git(repo, "remote", "add", "origin", join(dir, "no-remote.git"));
    const id = newTask();
    const b = ensureTaskWorktree(db, id, { repo });
    writeFileSync(join(b.worktree, "wip.txt"), "wip\n");
    git(b.worktree, "add", "wip.txt");
    git(b.worktree, "-c", "user.email=relay@test", "-c", "user.name=relay-test", "commit", "-q", "-m", "discarded");
    const plan = applyWorkspaceCleanup(db, id, { apply: true, force: true, abort: "discard", repo, worktreesRoot: join(dir, "worktrees") });
    expect(plan.removed).toBe(true);
    expect(git(repo, "for-each-ref", "--format=%(refname)", "refs/relay-kept/")).toBe("");
  });

  test("a real merge allows cleanup and the run evidence is retained", async () => {
    const id = newTask();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => p.finish(0);
    const launched = await launchTaskRun(db, id, { repo, spawner, outputRoot: outputRoot(), fastExitMs: 0 });
    const run = await launched.handle.wait();
    // Simulate a real merge observed on the provider.
    db.query(`UPDATE tasks SET state='done', accepted_at=?, merged_at=? WHERE id=?`).run(Date.now(), Date.now(), id);

    const plan = applyWorkspaceCleanup(db, id, { apply: true, repo, worktreesRoot: join(dir, "worktrees") });
    expect(plan.removed).toBe(true);
    expect(plan.retainedRuns).toBeGreaterThanOrEqual(1);
    // Evidence survives: the run row + its output dir are untouched.
    expect(getRun(db, run.id)).not.toBeNull();
    expect(existsSync(run.output_dir)).toBe(true);
  });

  test("uncommitted changes block cleanup unless forced", async () => {
    const id = newTask();
    const b = ensureTaskWorktree(db, id, { repo });
    writeFileSync(join(b.worktree, "wip.txt"), "uncommitted\n");
    const blocked = applyWorkspaceCleanup(db, id, { apply: true, abort: "abort", repo, worktreesRoot: join(dir, "worktrees") });
    expect(blocked.removed).toBe(false);
    expect(blocked.reasons.join(" ")).toMatch(/uncommitted/);
    const forced = applyWorkspaceCleanup(db, id, { apply: true, force: true, abort: "abort", repo, worktreesRoot: join(dir, "worktrees") });
    expect(forced.removed).toBe(true);
  });

  test("a human (non relay-owned) worktree is never removed", async () => {
    const id = newTask();
    // A human checkout OUTSIDE the relay worktrees root.
    const human = join(dir, "human-checkout");
    git(repo, "worktree", "add", "-b", "human/branch", human, "HEAD");
    db.query(`UPDATE tasks SET worktree = ?, branch = 'human/branch', merged_at = ?, state='done' WHERE id = ?`).run(
      human,
      Date.now(),
      id
    );
    const plan = applyWorkspaceCleanup(db, id, { apply: true, repo, worktreesRoot: join(dir, "worktrees") });
    expect(plan.removed).toBe(false);
    expect(plan.reasons.join(" ")).toMatch(/not relay-owned/);
    expect(existsSync(human)).toBe(true);
  });
});
