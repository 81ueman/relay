import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDbPath, defaultSockPath, STATE_DIR } from "../src/db";
import { gitRepoRoot, socketPathFor } from "../.opencode/plugins/relay";

// T242: a git worktree (`~/.herdr/worktrees/<repo>/<lane>`) has no ancestor
// `.relay`, so the plugin dropped every event and the CLI could not find the
// control plane. Both now resolve the MAIN checkout through the git common dir
// (same repository), and still fail closed across projects.

let root = "";
const savedDb = process.env.RELAY_DB;
const savedSock = process.env.RELAY_SOCK;

beforeEach(() => {
  // realpath: git resolves symlinks (/var -> /private/var on macOS), so compare
  // against the real path everywhere.
  root = realpathSync(mkdtempSync(join(tmpdir(), "relay-worktree-")));
  delete process.env.RELAY_DB;
  delete process.env.RELAY_SOCK;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedDb === undefined) delete process.env.RELAY_DB;
  else process.env.RELAY_DB = savedDb;
  if (savedSock === undefined) delete process.env.RELAY_SOCK;
  else process.env.RELAY_SOCK = savedSock;
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "ignore"] });
}

/** A real git repo with one commit, so `git worktree add` can run. */
function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  writeFileSync(join(dir, "f.txt"), "x");
  git(dir, "add", "f.txt");
  git(dir, "commit", "-q", "-m", "init");
}

function addWorktree(main: string, lane: string): void {
  git(main, "worktree", "add", "--detach", "-q", lane);
}

describe("git worktree control-plane resolution (T242)", () => {
  test("plugin socketPathFor resolves a linked worktree to the MAIN checkout's .relay", () => {
    const main = join(root, "main");
    makeRepo(main);
    addWorktree(main, join(root, "lane"));

    // Before the main control plane exists: still fail closed (no invented path).
    expect(socketPathFor(join(root, "lane"))).toBeNull();

    mkdirSync(join(main, STATE_DIR), { recursive: true });
    writeFileSync(join(main, STATE_DIR, "relay.sock"), "");

    expect(socketPathFor(join(root, "lane"))).toBe(join(main, STATE_DIR, "relay.sock"));
    // From a subdirectory of the worktree too.
    const sub = join(root, "lane", "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(socketPathFor(sub)).toBe(join(main, STATE_DIR, "relay.sock"));
  });

  test("CLI defaultDbPath/defaultSockPath resolve a worktree to the main control plane", () => {
    const main = join(root, "main");
    makeRepo(main);
    addWorktree(main, join(root, "lane"));
    mkdirSync(join(main, STATE_DIR), { recursive: true });
    writeFileSync(join(main, STATE_DIR, "state.db"), "");

    expect(defaultDbPath(join(root, "lane"))).toBe(join(main, STATE_DIR, "state.db"));
    expect(defaultSockPath(join(root, "lane"))).toBe(join(main, STATE_DIR, "relay.sock"));
  });

  test("a worktree never borrows ANOTHER project's control plane", () => {
    const repoA = join(root, "repo-A");
    const repoB = join(root, "repo-B");
    makeRepo(repoA);
    makeRepo(repoB);
    mkdirSync(join(repoA, STATE_DIR), { recursive: true });
    writeFileSync(join(repoA, STATE_DIR, "relay.sock"), "");
    mkdirSync(join(repoB, STATE_DIR), { recursive: true });
    writeFileSync(join(repoB, STATE_DIR, "relay.sock"), "");
    addWorktree(repoB, join(root, "lane-B"));

    // The worktree belongs to B, so it resolves B — never A.
    expect(socketPathFor(join(root, "lane-B"))).toBe(join(repoB, STATE_DIR, "relay.sock"));
    expect(gitRepoRoot(join(root, "lane-B"))).toBe(repoB);
  });

  test("a non-git directory still falls back to its own cwd and drops the socket", () => {
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });
    expect(socketPathFor(plain)).toBeNull();
    expect(gitRepoRoot(plain)).toBeNull();
    expect(defaultDbPath(plain)).toBe(join(plain, STATE_DIR, "state.db"));
  });
});
