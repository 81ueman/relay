import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { getTask } from "../src/tasks";
import { registerWorker } from "../src/workers";
import { intakeTask } from "../src/workflow";
import { getRun, listRuns, startDshRun, type DshProcess, type DshSpawner } from "../src/dsh-runner";
import { childEnv } from "../src/child-env";
import { latestLaunchRefusal } from "../src/disk-guard";
import {
  acceptSandboxSubmission,
  applySandboxCleanup,
  DSH_PROC_PATTERN,
  ensureTaskSandbox,
  fetchSandboxHead,
  findActiveSandboxWriter,
  isPinnedDsh,
  launchTaskSandboxRun,
  PINNED_DSH_VERSION,
  planSandboxCleanup,
  sandboxDshAlive,
  sandboxDshState,
  sandboxSubmitterError,
  sweepOrphanedSandboxRuns,
} from "../src/sandbox-lifecycle";
import {
  DUPLICATE_SANDBOX_WRITER,
  SANDBOX_ERROR,
  getSandbox,
  listSandboxes,
  parseSandboxList,
  resolveMainCheckout,
  sandboxNameForTask,
  sandboxRemote,
  sbxCreateArgv,
  sbxExecArgv,
  updateSandboxState,
  type SbxCli,
  type SbxResult,
} from "../src/sandbox";
// ISH-828: Task-scoped Coding Sandbox lifecycle. A REAL temp git repo + a FAKE
// `sbx` CLI and a FAKE `sbx exec` process keep the whole lifecycle deterministic
// (no Docker, no sandbox, no network). The produced commit is simulated with a
// real local git remote named `sandbox-<name>` so the host fetch is exercised.

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
  onSpawn?: (p: FakeProcess, argv: string[]) => void;
  spawn(argv: string[], opts: { cwd: string; env: Record<string, string> }): DshProcess {
    const p = new FakeProcess(30_000 + this.procs.length);
    this.procs.push(p);
    this.argv.push(argv);
    this.cwds.push(opts.cwd);
    this.envs.push(opts.env);
    this.onSpawn?.(p, argv);
    return p;
  }
}

/** A configurable fake `sbx` CLI. */
class FakeSbx implements SbxCli {
  created: string[] = [];
  calls: string[][] = [];
  headSha = "a".repeat(40);
  dshVersion = "0.2.1-rc.2";
  dshAlive = false;
  /** The branch the fake clone is on (set by a `git checkout` exec). */
  currentBranch: string | null = "main";
  /** When true, `pkill` does NOT stop the in-VM dsh (a stubborn orphan). */
  stubbornDsh = false;
  /** When true, the pgrep/pkill probe exec itself fails (transport down). */
  failProbe = false;
  failCreate = false;
  failLs = false;
  failDshVersion = false;
  handler?: (args: string[]) => SbxResult | null;

  run(args: string[]): SbxResult {
    this.calls.push(args);
    const custom = this.handler?.(args);
    if (custom) return custom;
    const ok = (out = ""): SbxResult => ({ ok: true, code: 0, out, err: "" });
    if (args[0] === "ls") {
      if (this.failLs) return { ok: false, code: 1, out: "", err: "ls boom" };
      return ok(JSON.stringify(this.created.map((name) => ({ name, agent: "shell", status: "running" }))));
    }
    if (args[0] === "create") {
      if (this.failCreate) return { ok: false, code: 1, out: "", err: "create boom" };
      const i = args.indexOf("--name");
      const name = i >= 0 ? args[i + 1] : "?";
      if (!this.created.includes(name)) this.created.push(name);
      return ok("Created sandbox " + name);
    }
    if (args[0] === "exec") {
      const joined = args.join(" ");
      // ISH-1009: the in-sandbox DinD disk probe (8 GiB in KiB, above the 2 GiB floor).
      if (joined.includes("df -Pk /var/lib/docker")) return ok(String(8 * 1024 * 1024));
      if (this.failProbe && (joined.includes("pgrep") || joined.includes("pkill"))) {
        return { ok: false, code: 1, out: "", err: "probe boom" };
      }
      // The in-VM dsh is stopped by pkill (unless it is stubborn).
      if (joined.includes("pkill")) {
        if (!this.stubbornDsh) this.dshAlive = false;
        return ok("");
      }
      if (joined.includes("git checkout")) {
        const m = joined.match(/git checkout (?:-b )?([^\s;&|]+)/);
        if (m) this.currentBranch = m[1];
        return ok("");
      }
      if (joined.includes("rev-parse HEAD")) return ok(this.headSha);
      if (joined.includes("rev-parse --abbrev-ref HEAD")) return ok(this.currentBranch ?? "");
      if (joined.includes("pgrep")) return ok(this.dshAlive ? "ALIVE" : "GONE");
      if (joined.includes("--version")) {
        return this.failDshVersion ? { ok: false, code: 1, out: "", err: "not found" } : ok(this.dshVersion);
      }
      return ok("");
    }
    if (args[0] === "stop") return ok("stopped");
    if (args[0] === "rm") {
      this.created = this.created.filter((n) => n !== args[args.length - 1]);
      return ok("removed");
    }
    if (args[0] === "cp") return ok("");
    return ok("");
  }
}

let dir = "";
let repo = "";
let db: Database;
let seq = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

let prevMinFreeDisk: string | undefined;
let prevMinFreeDind: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-ish828-"));
  repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "relay@test");
  git(repo, "config", "user.name", "relay-test");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "base");
  process.env.RELAY_DB = join(dir, "state.db");
  // ISH-1009: these tests exercise the sandbox lifecycle, not the host/DinD
  // volumes of the machine running the suite.
  prevMinFreeDisk = process.env.RELAY_MIN_FREE_DISK_BYTES;
  prevMinFreeDind = process.env.RELAY_MIN_FREE_DIND_BYTES;
  process.env.RELAY_MIN_FREE_DISK_BYTES = "0";
  process.env.RELAY_MIN_FREE_DIND_BYTES = "0";
  db = openDb(process.env.RELAY_DB);
  registerWorker(db, "impl", { role: "worker" });
  registerWorker(db, "rev", { role: "reviewer" });
  seq = 0;
  // ISH-869: the host `startDshRun` probes `<dshBin> --version`; point it at a
  // pinned fake so the one host-runner test here passes the guard.
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const dshBin = join(binDir, "dsh-pinned");
  writeFileSync(dshBin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${PINNED_DSH_VERSION}; exit 0; fi\nexit 0\n`);
  chmodSync(dshBin, 0o755);
  process.env.RELAY_DSH_BIN = dshBin;
});

afterEach(() => {
  db.close();
  delete process.env.RELAY_DSH_BIN;
  if (prevMinFreeDisk === undefined) delete process.env.RELAY_MIN_FREE_DISK_BYTES;
  else process.env.RELAY_MIN_FREE_DISK_BYTES = prevMinFreeDisk;
  if (prevMinFreeDind === undefined) delete process.env.RELAY_MIN_FREE_DIND_BYTES;
  else process.env.RELAY_MIN_FREE_DIND_BYTES = prevMinFreeDind;
  rmSync(dir, { recursive: true, force: true });
});

function newTask() {
  return intakeTask(db, {
    provider: "test",
    issueId: `ISH-828-${seq++}`,
    codeChange: true,
    title: "implement the thing",
  }).id;
}

const outputRoot = () => join(dir, "runs");

/**
 * Simulate the sandbox's in-container commit reaching the host: create a
 * commit on `branch`, push it to a real bare repo, and register it as the
 * host remote `sandbox-<name>` that `git fetch` will read.
 */
function publishFakeSandboxCommit(name: string, branch: string): string {
  const producer = join(dir, `producer-${name}`);
  mkdirSync(producer, { recursive: true });
  git(producer, "init", "-q", "-b", branch);
  git(producer, "config", "user.email", "sbx@test");
  git(producer, "config", "user.name", "sbx");
  writeFileSync(join(producer, "change.txt"), `from ${name}\n`);
  git(producer, "add", "change.txt");
  git(producer, "commit", "-q", "-m", "sandbox commit");
  const sha = git(producer, "rev-parse", "HEAD");
  const bare = join(dir, `bare-${name}.git`);
  git(producer, "init", "-q", "--bare", bare);
  git(producer, "remote", "add", "origin", bare);
  git(producer, "push", "-q", "origin", `${branch}:refs/heads/${branch}`);
  git(repo, "remote", "add", sandboxRemote(name), bare);
  return sha;
}

function dshStream(p: FakeProcess, sid = "session-abc"): void {
  p.writeOut(JSON.stringify({ type: "session", sessionId: sid, cwd: "/workspace" }) + "\n");
  p.writeOut(JSON.stringify({ type: "status", phase: "turn_start", turn: 1 }) + "\n");
  p.writeOut(JSON.stringify({ type: "tool_call", callId: "c1", tool: "bash" }) + "\n");
  p.writeOut(JSON.stringify({ type: "tool_result", callId: "c1", status: "completed", result: "ok" }) + "\n");
  p.writeOut(JSON.stringify({ type: "final", text: "done" }) + "\n");
}

describe("sbx boundary (arg builders + parsing)", () => {
  test("sbxCreateArgv runs --clone from the main checkout", () => {
    expect(sbxCreateArgv({ name: "relay-x", agent: "ishiul-coding", source: "/repo" })).toEqual([
      "create",
      "--clone",
      "--name",
      "relay-x",
      "ishiul-coding",
      "/repo",
    ]);
  });

  test("sbxExecArgv carries workdir and env before the sandbox name", () => {
    expect(sbxExecArgv("relay-x", ["git", "rev-parse", "HEAD"], { workdir: "/w", env: { A: "1" } })).toEqual([
      "exec",
      "-w",
      "/w",
      "-e",
      "A=1",
      "relay-x",
      "git",
      "rev-parse",
      "HEAD",
    ]);
  });

  test("sandboxNameForTask is deterministic, sbx-safe, slice-qualified and unique per Task", () => {
    const a = sandboxNameForTask({ id: "T1", issue_id: "ISH-828", slice: "" } as never);
    const b = sandboxNameForTask({ id: "T1", issue_id: "ISH-828", slice: "" } as never);
    expect(a).toBe(b);
    expect(a.startsWith("relay-ish-828")).toBe(true);
    expect(a.length).toBeLessThanOrEqual(60);
    expect(/^[a-z0-9][a-z0-9.-]*$/.test(a)).toBe(true);
    // Finding 5: the stable Task-id hash distinguishes same-slug Tasks.
    const t2 = sandboxNameForTask({ id: "T2", issue_id: "ISH-828", slice: "" } as never);
    expect(t2).not.toBe(a);
    // Two providers, same issue id + slice, still differ (task identity includes provider).
    const p1 = sandboxNameForTask({ id: "T10", issue_id: "ISH-828", slice: "api/part one" } as never);
    const p2 = sandboxNameForTask({ id: "T11", issue_id: "ISH-828", slice: "api/part one" } as never);
    expect(p1).not.toBe(p2);
    expect(p1.startsWith("relay-ish-828-api-part-one")).toBe(true);
  });

  test("parseSandboxList tolerates malformed output and keeps only named rows", () => {
    expect(parseSandboxList("not json")).toEqual([]);
    expect(parseSandboxList(JSON.stringify([{ name: "a", status: "running" }, { nope: 1 }]))).toEqual([
      { name: "a", agent: undefined, status: "running", workspaces: undefined },
    ]);
  });
});

describe("main-checkout guard", () => {
  test("resolveMainCheckout reports isMain for the main checkout", () => {
    const mc = resolveMainCheckout(repo)!;
    expect(mc.isMain).toBe(true);
    expect(realpathSync(mc.root)).toBe(realpathSync(repo));
  });

  test("a linked worktree is measured as not-main and refused as a --clone source", () => {
    const wt = join(dir, "linked");
    git(repo, "worktree", "add", "-b", "linked-branch", wt);
    const mc = resolveMainCheckout(wt)!;
    expect(mc.isMain).toBe(false);
    const id = newTask();
    expect(() => ensureTaskSandbox(db, id, { source: wt })).toThrow(/linked git worktree/);
  });
});

describe("Task -> sandbox mapping", () => {
  test("creates a clone-mode sandbox from the main checkout and records it", () => {
    const id = newTask();
    const sbx = new FakeSbx();
    const b = ensureTaskSandbox(db, id, { source: repo, agent: "ishiul-coding", cli: sbx });
    expect(b.created).toBe(true);
    expect(realpathSync(b.source)).toBe(realpathSync(repo));
    expect(b.branch.startsWith("relay/")).toBe(true);
    const create = sbx.calls.find((c) => c[0] === "create")!;
    expect(create).toContain("--clone");
    expect(create).toContain("ishiul-coding");
    expect(realpathSync(create[create.length - 1])).toBe(realpathSync(repo));

    const row = getSandbox(db, id)!;
    expect(row.name).toBe(b.name);
    expect(row.state).toBe("running");
    expect(row.branch).toBe(b.branch);
    expect(listSandboxes(db).map((s) => s.name)).toEqual([b.name]);
  });

  test("is idempotent: a second ensure SELECTS the same sandbox (FIX reuses it)", () => {
    const id = newTask();
    const sbx = new FakeSbx();
    const b1 = ensureTaskSandbox(db, id, { source: repo, cli: sbx });
    const b2 = ensureTaskSandbox(db, id, { source: repo, cli: sbx });
    expect(b2.created).toBe(false);
    expect(b2.name).toBe(b1.name);
    expect(sbx.calls.filter((c) => c[0] === "create").length).toBe(1);
  });

  test("a create failure is recorded as failed and surfaced as SANDBOX_ERROR", () => {
    const id = newTask();
    const sbx = new FakeSbx();
    sbx.failCreate = true;
    expect(() => ensureTaskSandbox(db, id, { source: repo, cli: sbx })).toThrow(SANDBOX_ERROR);
    expect(getSandbox(db, id)!.state).toBe("failed");
  });

  test("refuses a non-code-change task", () => {
    const t = intakeTask(db, { provider: "test", issueId: `ISH-828-plain-${seq++}`, title: "plain" });
    expect(() => ensureTaskSandbox(db, t.id, { source: repo, cli: new FakeSbx() })).toThrow(/not a code-change task/);
  });
});

describe("sandbox Run: one disposable dsh per attempt", () => {
  test("launches dsh inside the sandbox, records JSONL evidence, fetches the produced HEAD", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    const spawner = new FakeSpawner();
    let produced = "";
    spawner.onSpawn = (p, argv) => {
      // The sbx exec must target the sandbox and run the pinned dsh CLI.
      expect(argv[0]).toBe("sbx");
      expect(argv[1]).toBe("exec");
      expect(argv.slice(argv.indexOf("dsh"))).toEqual([
        "dsh",
        "--profile",
        "headless",
        "--json",
        expect.any(String),
      ]);
      dshStream(p);
      p.finish(0);
    };
    const launched = await launchTaskSandboxRun(db, id, {
      source: repo,
      cli: sbx,
      spawner,
      outputRoot: outputRoot(),
      fastExitMs: 0,
    });
    produced = publishFakeSandboxCommit(launched.sandbox.name, launched.sandbox.branch);
    const run = await launched.handle.wait();

    expect(run.state).toBe("exited");
    expect(run.exit_code).toBe(0);
    expect(run.sandbox_name).toBe(launched.sandbox.name);
    expect(run.session_id).toBe("session-abc");
    expect(run.head_sha).toBe(produced);
    expect(spawner.cwds[0]).toBe(launched.sandbox.source); // sbx client runs on the host
    // Evidence files exist and are distinct.
    expect(existsSync(run.stdout_path!)).toBe(true);
    expect(existsSync(run.dsh_events_path!)).toBe(true);
    expect(existsSync(run.events_path!)).toBe(true);
    // The brief was pinned into the clone after creating `.relay` there.
    expect(sbx.calls.some((c) => c.join(" ").includes("mkdir -p .relay"))).toBe(true);
    expect(sbx.calls.some((c) => c[0] === "cp")).toBe(true);
    const dshJsonl = readFileSync(run.dsh_events_path!, "utf8");
    expect(dshJsonl).toContain('"type":"tool_call"');
    // The mapping reflects the produced head.
    expect(getSandbox(db, id)!.head_sha).toBe(produced);
  });

  // ISH-869: a single pinned dsh build, fail-closed on any other version.
  test("isPinnedDsh matches ONLY the exact pinned build (never a 0.2.x fallback)", () => {
    expect(PINNED_DSH_VERSION).toBe("0.2.1-rc.2");
    expect(isPinnedDsh("0.2.1-rc.2")).toBe(true);
    expect(isPinnedDsh("dsh 0.2.1-rc.2")).toBe(true); // tolerant of a `dsh ` prefix
    expect(isPinnedDsh("0.2.0-rc.2")).toBe(false); // the previous baseline
    expect(isPinnedDsh("0.2.1-rc.1")).toBe(false);
    expect(isPinnedDsh("0.2.1-rc.20")).toBe(false); // no loose substring match
    expect(isPinnedDsh("latest")).toBe(false);
    expect(isPinnedDsh(null)).toBe(false);
    expect(isPinnedDsh("")).toBe(false);
  });

  test("ISH-869: an OLD dsh in the sandbox fails the launch closed (no silent pass)", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    sbx.dshVersion = "0.2.0-rc.2"; // the pre-ISH-869 baseline is still installed
    const spawner = new FakeSpawner();
    // installDsh:false keeps the stale build in place, so the guard (not a reinstall) must refuse.
    await expect(
      launchTaskSandboxRun(db, id, { source: repo, cli: sbx, spawner, outputRoot: outputRoot(), installDsh: false })
    ).rejects.toThrow(new RegExp(`${SANDBOX_ERROR}.*0\\.2\\.0-rc\\.2.*${PINNED_DSH_VERSION}`));
    expect(spawner.procs.length).toBe(0); // no dsh process was ever started
    expect(listRuns(db, { taskId: id }).length).toBe(0); // and no Run row was recorded
  });

  test("ISH-869: a MISSING dsh (install disabled) also fails the launch closed", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    sbx.failDshVersion = true; // `dsh --version` cannot resolve
    const spawner = new FakeSpawner();
    await expect(
      launchTaskSandboxRun(db, id, { source: repo, cli: sbx, spawner, outputRoot: outputRoot(), installDsh: false })
    ).rejects.toThrow(new RegExp(`${SANDBOX_ERROR}.*dsh none`));
    expect(spawner.procs.length).toBe(0);
  });

  // ISH-869 finding 2: the guard must probe the SAME binary the Run spawns.
  test("ISH-869: the sandbox guard probes the configured dshBin, not the default `dsh`", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    // The default `dsh` reports the pin, but the configured alt binary is absent.
    sbx.handler = (args) => {
      if (args[0] !== "exec") return null;
      const joined = args.join(" ");
      if (!joined.includes("--version")) return null;
      return joined.includes("dsh-alt")
        ? { ok: true, code: 0, out: "", err: "" }
        : { ok: true, code: 0, out: PINNED_DSH_VERSION, err: "" };
    };
    const spawner = new FakeSpawner();
    await expect(
      launchTaskSandboxRun(db, id, {
        source: repo,
        cli: sbx,
        spawner,
        outputRoot: outputRoot(),
        dshBin: "dsh-alt",
        installDsh: false,
      })
    ).rejects.toThrow(new RegExp(`${SANDBOX_ERROR}.*dsh none`));
    expect(spawner.procs.length).toBe(0);
  });

  test("ISH-869: the Run spawns the configured dshBin the guard blessed", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    sbx.handler = (args) => {
      if (args[0] === "exec" && args.join(" ").includes("--version")) {
        return args.join(" ").includes("dsh-alt")
          ? { ok: true, code: 0, out: PINNED_DSH_VERSION, err: "" }
          : { ok: true, code: 0, out: "0.2.0-rc.2", err: "" }; // default is stale
      }
      return null;
    };
    const spawner = new FakeSpawner();
    let runArgv: string[] = [];
    spawner.onSpawn = (p, argv) => {
      runArgv = argv;
      dshStream(p);
      p.finish(0);
    };
    const launched = await launchTaskSandboxRun(db, id, {
      source: repo,
      cli: sbx,
      spawner,
      outputRoot: outputRoot(),
      dshBin: "dsh-alt",
      fastExitMs: 0,
    });
    publishFakeSandboxCommit(launched.sandbox.name, launched.sandbox.branch);
    await launched.handle.wait();
    expect(runArgv).toContain("dsh-alt");
    expect(runArgv).not.toContain("dsh"); // never the default binary
  });

  test("refuses a second writer while a Run holds the sandbox", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => dshStream(p); // never finishes
    const first = await launchTaskSandboxRun(db, id, { source: repo, cli: sbx, spawner, outputRoot: outputRoot() });
    await expect(
      launchTaskSandboxRun(db, id, { source: repo, cli: sbx, spawner, outputRoot: outputRoot() })
    ).rejects.toThrow(DUPLICATE_SANDBOX_WRITER);
    expect(findActiveSandboxWriter(db, { sandboxName: first.sandbox.name })?.id).toBe(first.handle.id);
    first.handle.cancel("done");
    await first.handle.wait();
  });

  test("a non-zero dsh exit fails the Run (exit 0 alone is required to submit)", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => {
      p.writeOut(JSON.stringify({ type: "error", message: "boom" }) + "\n");
      p.finish(1);
    };
    const launched = await launchTaskSandboxRun(db, id, { source: repo, cli: sbx, spawner, outputRoot: outputRoot(), fastExitMs: 0 });
    const run = await launched.handle.wait();
    expect(run.state).toBe("failed");
    expect(() => acceptSandboxSubmission(db, { runId: run.id })).toThrow(/RUN_SUBMISSION_REJECTED/);
  });

  test("an exit 0 with a failed host fetch fails closed (no unverifiable head)", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => {
      dshStream(p);
      p.finish(0);
    };
    // No `sandbox-<name>` remote exists -> the fetch fails.
    const launched = await launchTaskSandboxRun(db, id, { source: repo, cli: sbx, spawner, outputRoot: outputRoot(), fastExitMs: 0 });
    const run = await launched.handle.wait();
    expect(run.state).toBe("failed");
    expect(run.head_sha).toBeNull();
    expect(run.error ?? "").toMatch(/fetch|ref/);
  });

  test("cancel marks the Run cancelled and records an orphan when the in-VM dsh survives", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    sbx.dshAlive = true;
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => dshStream(p); // never finishes
    const launched = await launchTaskSandboxRun(db, id, { source: repo, cli: sbx, spawner, outputRoot: outputRoot() });
    launched.handle.cancel("operator");
    const run = await launched.handle.wait();
    expect(run.state).toBe("cancelled");
    expect(run.signal).toBe("operator");
    expect(run.error ?? "").toContain("orphaned");
    // The in-VM dsh was explicitly stopped.
    expect(sbx.calls.some((c) => c.join(" ").includes("pkill"))).toBe(true);
  });

  test("a restart sweep fails a running Run whose host client died and stops the in-VM dsh", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    sbx.dshAlive = true;
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => dshStream(p); // never finishes -> row stays running
    const launched = await launchTaskSandboxRun(db, id, { source: repo, cli: sbx, spawner, outputRoot: outputRoot() });
    // Simulate a Relay/host restart: the recorded client is gone.
    db.query(`UPDATE runs SET pid = NULL, spawn_lstart = NULL WHERE id = ?`).run(launched.handle.id);

    const dry = sweepOrphanedSandboxRuns(db, { cli: sbx });
    expect(dry.inspected).toBe(1);
    expect(dry.orphaned[0].inVmAlive).toBe(true);
    expect(getRun(db, launched.handle.id)!.state).toBe("running"); // dry-run leaves it

    const applied = sweepOrphanedSandboxRuns(db, { apply: true, cli: sbx });
    expect(applied.orphaned[0].stopped).toBe(true);
    const run = getRun(db, launched.handle.id)!;
    expect(run.state).toBe("failed");
    expect(run.error ?? "").toContain("orphaned");
  });

  test("timeout kills the Run and never fetches or submits", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => dshStream(p); // never finishes
    const launched = await launchTaskSandboxRun(db, id, {
      source: repo,
      cli: sbx,
      spawner,
      outputRoot: outputRoot(),
      timeoutMs: 20,
    });
    const run = await launched.handle.wait();
    expect(run.state).toBe("timeout");
    expect(run.head_sha).toBeNull();
  });
});

describe("ISH-1009: sandbox disk guard", () => {
  const hostPaths = () => [join(dir, "worktrees"), join(dir, "state.db")];

  test("a low host volume refuses BEFORE the sandbox is created", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    const spawner = new FakeSpawner();
    await expect(
      launchTaskSandboxRun(db, id, {
        source: repo,
        cli: sbx,
        spawner,
        outputRoot: outputRoot(),
        diskGuard: { minFreeBytes: 1_000, paths: hostPaths(), probe: () => 100 },
      })
    ).rejects.toThrow(/LOW_DISK/);

    expect(spawner.procs).toHaveLength(0);
    expect(listRuns(db, { taskId: id })).toHaveLength(0);
    expect(getSandbox(db, id)).toBeNull();
    expect(getTask(db, id)!.state).toBe("queued");
    const latest = latestLaunchRefusal(db)!;
    expect(latest.reason).toBe("low_disk");
    expect(latest.target).toBe("sandbox");
    expect(latest.scope).toBe("host");
    expect(latest.freeBytes).toBe(100);
  });

  test("a low in-sandbox DinD volume refuses after the host check, before dsh starts", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    const spawner = new FakeSpawner();
    await expect(
      launchTaskSandboxRun(db, id, {
        source: repo,
        cli: sbx,
        spawner,
        outputRoot: outputRoot(),
        diskGuard: {
          minFreeBytes: 1_000,
          paths: hostPaths(),
          probe: () => 10_000,
          dindMinFreeBytes: 1_000,
          dindProbe: () => 100,
        },
      })
    ).rejects.toThrow(/LOW_DISK/);

    expect(spawner.procs).toHaveLength(0);
    expect(listRuns(db, { taskId: id })).toHaveLength(0);
    const latest = latestLaunchRefusal(db)!;
    expect(latest.reason).toBe("low_disk");
    expect(latest.scope).toBe("dind");
    expect(latest.freeBytes).toBe(100);
    expect(latest.minFreeBytes).toBe(1_000);
    // The sandbox row is durable and may remain; no Run was started.
    expect(getTask(db, id)!.state).toBe("queued");
  });

  test("a failed DinD probe refuses and surfaces the probe error", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    const spawner = new FakeSpawner();
    await expect(
      launchTaskSandboxRun(db, id, {
        source: repo,
        cli: sbx,
        spawner,
        outputRoot: outputRoot(),
        diskGuard: {
          minFreeBytes: 1_000,
          paths: hostPaths(),
          probe: () => 10_000,
          dindMinFreeBytes: 1_000,
          dindProbe: () => {
            throw new Error("df transport down");
          },
        },
      })
    ).rejects.toThrow(/DISK_PROBE_FAILED.*df transport down/);

    expect(spawner.procs).toHaveLength(0);
    expect(listRuns(db, { taskId: id })).toHaveLength(0);
    const latest = latestLaunchRefusal(db)!;
    expect(latest.reason).toBe("probe_failed");
    expect(latest.scope).toBe("dind");
    expect(latest.error).toContain("df transport down");
  });

  test("the default sbx df probe parses the DinD volume and applies its own floor", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    const spawner = new FakeSpawner();
    // The fake reports 8 GiB free in the VM; a 20 GiB DinD floor must refuse.
    await expect(
      launchTaskSandboxRun(db, id, {
        source: repo,
        cli: sbx,
        spawner,
        outputRoot: outputRoot(),
        diskGuard: {
          minFreeBytes: 1_000,
          paths: hostPaths(),
          probe: () => 10_000,
          dindMinFreeBytes: 20 * 1024 ** 3,
        },
      })
    ).rejects.toThrow(/LOW_DISK/);

    expect(spawner.procs).toHaveLength(0);
    expect(listRuns(db, { taskId: id })).toHaveLength(0);
    const latest = latestLaunchRefusal(db)!;
    expect(latest.reason).toBe("low_disk");
    expect(latest.scope).toBe("dind");
    expect(latest.freeBytes).toBe(8 * 1024 ** 3);
    expect(latest.sandbox).toBe(sbx.created[0]);
  });
});

describe("sandbox submission", () => {
  async function runOnce(id: string, sbx: FakeSbx, spawner: FakeSpawner) {
    spawner.onSpawn = (p) => {
      dshStream(p);
      p.finish(0);
    };
    const launched = await launchTaskSandboxRun(db, id, { source: repo, cli: sbx, spawner, outputRoot: outputRoot(), fastExitMs: 0 });
    publishFakeSandboxCommit(launched.sandbox.name, launched.sandbox.branch);
    const run = await launched.handle.wait();
    return { launched, run };
  }

  test("accepts a sandbox Run bound to the live Task and advances the phase", async () => {
    const id = newTask();
    const { run } = await runOnce(id, new FakeSbx(), new FakeSpawner());
    const accepted = acceptSandboxSubmission(db, { runId: run.id, evidence: "sandbox:e2e" });
    expect(accepted.state).toBe("submitted");
    const task = getTask(db, id)!;
    expect(task.head_sha).toBe(run.head_sha);
    expect(task.phase).not.toBe("implement");
  });

  test("refuses a Run whose sandbox no longer matches the Task mapping", async () => {
    const id = newTask();
    const { run } = await runOnce(id, new FakeSbx(), new FakeSpawner());
    const task = getTask(db, id)!;
    const sandbox = getSandbox(db, id)!;
    expect(sandboxSubmitterError(run, task, { ...sandbox, name: "other" })).toMatch(/bound to/);
    // The live mapping moved to a different sandbox -> the late Run is refused.
    db.query(`UPDATE sandboxes SET name = 'other' WHERE task_id = ?`).run(id);
    expect(() => acceptSandboxSubmission(db, { runId: run.id })).toThrow(/RUN_SUBMISSION_REJECTED/);
  });

  test("a FIX reuses the same sandbox and inherits the previous findings", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    const spawner = new FakeSpawner();
    const { launched, run } = await runOnce(id, sbx, spawner);
    const oldAttempt = run.attempt;
    acceptSandboxSubmission(db, { runId: run.id });
    // Drive the Task back to implement at attempt+1 (a review FIX), and record
    // the failed review whose reason must be pinned into the next Run's brief.
    db.query(`UPDATE tasks SET phase='implement', attempt=attempt+1, head_sha=NULL WHERE id=?`).run(id);
    const t = getTask(db, id)!;
    db.query(
      `INSERT INTO task_results (task_id, phase, attempt, kind, worker_id, passed, reason, payload_json, created_at)
       VALUES (?, 'review', ?, 'ReviewResult', 'rev', 0, 'fix the thing', '{}', ?)`
    ).run(id, oldAttempt, Date.now());

    const second = await launchTaskSandboxRun(db, id, { source: repo, cli: sbx, spawner, outputRoot: outputRoot(), fastExitMs: 0 });
    const run2 = await second.handle.wait();
    expect(second.sandbox.name).toBe(launched.sandbox.name);
    expect(second.sandbox.created).toBe(false);
    expect(sbx.calls.filter((c) => c[0] === "create").length).toBe(1);
    // The prior finding is pinned into the brief and the Run produced a fresh head.
    const brief = readFileSync(second.run.spec_path!, "utf8");
    expect(brief).toContain("fix the thing");
    expect(run2.state).toBe("exited");
    expect(run2.id).not.toBe(run.id);
    void t;
  });
});

describe("safe sandbox cleanup (evidence-retaining)", () => {
  async function launched(id: string, sbx: FakeSbx, spawner: FakeSpawner) {
    spawner.onSpawn = (p) => {
      dshStream(p);
      p.finish(0);
    };
    const l = await launchTaskSandboxRun(db, id, { source: repo, cli: sbx, spawner, outputRoot: outputRoot(), fastExitMs: 0 });
    publishFakeSandboxCommit(l.sandbox.name, l.sandbox.branch);
    const run = await l.handle.wait();
    return { l, run };
  }

  test("dry-run refuses without a merge/abort, then applies after --abort and retains evidence", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    const spawner = new FakeSpawner();
    const { run } = await launched(id, sbx, spawner);

    const dry = planSandboxCleanup(db, id, { cli: sbx });
    expect(dry.remove).toBe(false);
    expect(dry.reasons.join(";")).toMatch(/not terminal|not merged|--abort/);

    const plan = planSandboxCleanup(db, id, { abort: "operator", cli: sbx });
    expect(plan.remove).toBe(true);
    expect(plan.savedHead).toBe(run.head_sha);
    expect(plan.retainedRuns).toBe(1);

    const applied = applySandboxCleanup(db, id, { apply: true, abort: "operator", cli: sbx });
    expect(applied.removed).toBe(true);
    expect(getSandbox(db, id)!.state).toBe("removed");
    // Evidence (Run row + output dir) is retained.
    expect(getRun(db, run.id)).not.toBeNull();
    expect(existsSync(run.output_dir)).toBe(true);
    expect(listRuns(db, { taskId: id }).length).toBe(1);
  });

  test("finding 4: a commit from a failed Run is fetched and saved before the VM is removed", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    const spawner = new FakeSpawner();
    // A Run that COMMITS and then exits non-zero (e.g. a provider error after the
    // commit). Its exit code is 1, so no head_sha is recorded by the Run itself.
    spawner.onSpawn = (p) => {
      dshStream(p);
      p.finish(1);
    };
    const l = await launchTaskSandboxRun(db, id, { source: repo, cli: sbx, spawner, outputRoot: outputRoot(), fastExitMs: 0 });
    const produced = publishFakeSandboxCommit(l.sandbox.name, l.sandbox.branch);
    const run = await l.handle.wait();
    expect(run.state).toBe("failed");
    expect(run.head_sha).toBeNull();
    expect(getSandbox(db, id)!.head_sha).toBeNull();

    const plan = planSandboxCleanup(db, id, { abort: "operator", cli: sbx });
    expect(plan.remove).toBe(true); // the dry run cannot know; apply must fetch

    const applied = applySandboxCleanup(db, id, { apply: true, abort: "operator", cli: sbx });
    expect(applied.removed).toBe(true);
    // The commit was pinned under a durable host ref and recorded, then removed.
    expect(getSandbox(db, id)!.head_sha).toBe(produced);
    const ref = git(repo, "rev-parse", `refs/relay-sandbox/${l.sandbox.name}`);
    expect(ref).toBe(produced);
  });

  test("finding 4: a failed pre-removal fetch refuses to remove the VM", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => {
      dshStream(p);
      p.finish(1);
    };
    const l = await launchTaskSandboxRun(db, id, { source: repo, cli: sbx, spawner, outputRoot: outputRoot(), fastExitMs: 0 });
    await l.handle.wait();
    // No `sandbox-<name>` host remote exists, so the pre-removal fetch must fail.
    const applied = applySandboxCleanup(db, id, { apply: true, abort: "operator", cli: sbx });
    expect(applied.removed).toBe(false);
    expect(applied.reasons.join(";")).toMatch(/could not confirm the sandbox commit is saved/);
    expect(getSandbox(db, id)!.state).not.toBe("removed");
  });

  test("finding 6: a failed `sbx ls` refuses to assume the sandbox is gone", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    const spawner = new FakeSpawner();
    const { run } = await launched(id, sbx, spawner);
    sbx.failLs = true;
    const applied = applySandboxCleanup(db, id, { apply: true, abort: "operator", cli: sbx });
    expect(applied.removed).toBe(false);
    expect(getSandbox(db, id)!.state).not.toBe("removed");
    expect(applied.reasons.join(";")).toMatch(/sbx ls failed/);
    // The Run evidence is untouched.
    expect(existsSync(run.output_dir)).toBe(true);
  });

  test("refuses when a Run's evidence directory is missing", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    const spawner = new FakeSpawner();
    const { run } = await launched(id, sbx, spawner);
    rmSync(run.output_dir, { recursive: true, force: true });
    const plan = planSandboxCleanup(db, id, { abort: "operator", cli: sbx });
    expect(plan.remove).toBe(false);
    expect(plan.reasons.join(";")).toMatch(/evidence dir is missing/);
  });

  test("refuses while a Run still holds the sandbox", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => dshStream(p); // never finishes
    const l = await launchTaskSandboxRun(db, id, { source: repo, cli: sbx, spawner, outputRoot: outputRoot() });
    const plan = planSandboxCleanup(db, id, { abort: "operator", cli: sbx });
    expect(plan.remove).toBe(false);
    expect(plan.reasons.join(";")).toMatch(/active run/);
    l.handle.cancel("done");
    await l.handle.wait();
  });
});

describe("round-2 findings", () => {
  test("finding 1: opens a DB whose runs table predates ISH-828 (no sandbox_name)", () => {
    const p = join(dir, "old.db");
    const old = new Database(p, { create: true });
    old.exec(`CREATE TABLE runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, phase TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
      generation INTEGER NOT NULL DEFAULT 0, cwd TEXT NOT NULL, branch TEXT, head_sha TEXT, base_head_sha TEXT,
      prompt TEXT NOT NULL DEFAULT '', spec_path TEXT, output_dir TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'starting',
      pid INTEGER, exit_code INTEGER, signal TEXT, session_id TEXT, stdout_path TEXT, stderr_path TEXT, events_path TEXT,
      dsh_events_path TEXT, spawn_lstart TEXT, error TEXT, fast_exit INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL,
      ended_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
    old.close();
    const reopened = openDb(p);
    const cols = reopened.query("PRAGMA table_info(runs)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "sandbox_name")).toBe(true);
    const idx = reopened.query("PRAGMA index_list(runs)").all() as { name: string }[];
    expect(idx.some((i) => i.name === "idx_runs_sandbox")).toBe(true);
    reopened.close();
  });

  test("finding 8: childEnv is an allowlist, not all of process.env", () => {
    const env = childEnv({ PATH: "/bin", HOME: "/home/x", SECRET_X: "leak", DEEPSEEK_API_KEY: "k" }, { EXPLICIT: "ok" });
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/home/x");
    expect(env.SECRET_X).toBeUndefined();
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.EXPLICIT).toBe("ok");
  });

  test("finding 8: an unrelated host var does not reach the sandbox child spawn", async () => {
    process.env.SECRET_X = "leak-me";
    try {
      const id = newTask();
      const sbx = new FakeSbx();
      const spawner = new FakeSpawner();
      spawner.onSpawn = (p) => {
        dshStream(p);
        p.finish(0);
      };
      await launchTaskSandboxRun(db, id, { source: repo, cli: sbx, spawner, outputRoot: outputRoot(), fastExitMs: 0 });
      expect(spawner.envs[0].SECRET_X).toBeUndefined();
      expect(spawner.envs[0].PATH).toBe(process.env.PATH ?? "");
    } finally {
      delete process.env.SECRET_X;
    }
  });

  test("finding 8: an unrelated host var does not reach the dsh child spawn", async () => {
    process.env.SECRET_X = "leak-me";
    try {
      const id = newTask();
      const spawner = new FakeSpawner();
      spawner.onSpawn = (p) => {
        dshStream(p);
        p.finish(0);
      };
      const handle = await startDshRun(db, { taskId: id, cwd: repo, spawner, outputRoot: outputRoot() });
      await handle.wait();
      expect(spawner.envs[0].SECRET_X).toBeUndefined();
      expect(spawner.envs[0].PATH).toBe(process.env.PATH ?? "");
    } finally {
      delete process.env.SECRET_X;
    }
  });

  test("finding 3: fetchSandboxHead refuses an absent branch instead of using FETCH_HEAD", () => {
    const producer = join(dir, "prod3");
    mkdirSync(producer, { recursive: true });
    git(producer, "init", "-q", "-b", "other");
    git(producer, "config", "user.email", "x@y.z");
    git(producer, "config", "user.name", "x");
    writeFileSync(join(producer, "f.txt"), "x\n");
    git(producer, "add", "f.txt");
    git(producer, "commit", "-q", "-m", "other commit");
    const bare = join(dir, "bare3.git");
    git(producer, "init", "-q", "--bare", bare);
    git(producer, "remote", "add", "origin", bare);
    git(producer, "push", "-q", "origin", "other:refs/heads/other");
    git(repo, "remote", "add", sandboxRemote("relay-x"), bare);
    const f = fetchSandboxHead(repo, "relay-x", "relay/absent-branch");
    expect(f.ok).toBe(false);
    expect(f.sha).toBeNull();
  });

  test("finding 5: two Tasks with the same issue/slice get distinct sandboxes", () => {
    const a = intakeTask(db, { provider: "p1", issueId: "ISH-900", slice: "s", codeChange: true, title: "a" });
    const b = intakeTask(db, { provider: "p2", issueId: "ISH-900", slice: "s", codeChange: true, title: "b" });
    const sbx = new FakeSbx();
    const na = ensureTaskSandbox(db, a.id, { source: repo, cli: sbx }).name;
    const nb = ensureTaskSandbox(db, b.id, { source: repo, cli: sbx }).name;
    expect(na).not.toBe(nb);
  });

  test("finding 6: a failed `sbx ls` during ensure does not mark the mapping lost", () => {
    const id = newTask();
    const sbx = new FakeSbx();
    ensureTaskSandbox(db, id, { source: repo, cli: sbx });
    sbx.failLs = true;
    expect(() => ensureTaskSandbox(db, id, { source: repo, cli: sbx })).toThrow(/could not list sandboxes/);
    expect(getSandbox(db, id)!.state).toBe("running");
  });

  test("finding 2: a non-zero client exit with a live in-VM dsh is orphaned, stopped, and frees the writer", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    sbx.dshAlive = true;
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => {
      dshStream(p);
      p.finish(1);
    };
    const l = await launchTaskSandboxRun(db, id, { source: repo, cli: sbx, spawner, outputRoot: outputRoot(), fastExitMs: 0 });
    const run = await l.handle.wait();
    expect(run.state).toBe("failed");
    expect(run.error ?? "").toContain("orphaned");
    expect(sbx.calls.some((c) => c.join(" ").includes("pkill"))).toBe(true);
    expect(findActiveSandboxWriter(db, { sandboxName: l.sandbox.name })).toBeNull();
  });

  test("finding 2: a stubborn in-VM dsh leaves the Run non-terminal to block a second writer", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    sbx.dshAlive = true;
    sbx.stubbornDsh = true;
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => {
      dshStream(p);
      p.finish(1);
    };
    const l = await launchTaskSandboxRun(db, id, { source: repo, cli: sbx, spawner, outputRoot: outputRoot(), fastExitMs: 0 });
    const run = await l.handle.wait();
    expect(run.state).toBe("running");
    expect(run.error ?? "").toContain("non-terminal");
    expect(findActiveSandboxWriter(db, { sandboxName: l.sandbox.name })?.id).toBe(run.id);
  });
});

describe("round-3 findings (in-VM liveness probe)", () => {
  test("finding 1: the probe/pkill pattern does not match its own command line", () => {
    const re = new RegExp(DSH_PROC_PATTERN);
    // It matches a real dsh process line...
    expect(re.test("dsh --profile headless")).toBe(true);
    // ...but NOT the shell that runs the probe/pkill (the classic [d] trick).
    expect(re.test(`pgrep -f '${DSH_PROC_PATTERN}' >/dev/null && echo ALIVE || echo GONE`)).toBe(false);
    expect(re.test(`pkill -f '${DSH_PROC_PATTERN}' || true`)).toBe(false);
  });

  test("finding 2: a failed probe is 'unknown' and treated as alive (Run left non-terminal)", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    sbx.dshAlive = true;
    sbx.failProbe = true; // the transport that killed the client also fails the probe
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => {
      dshStream(p);
      p.finish(1);
    };
    const l = await launchTaskSandboxRun(db, id, { source: repo, cli: sbx, spawner, outputRoot: outputRoot(), fastExitMs: 0 });
    const run = await l.handle.wait();
    expect(sandboxDshState(sbx, l.sandbox.name)).toBe("unknown");
    expect(run.state).toBe("running");
    expect(run.error ?? "").toMatch(/unknown|non-terminal/);
    expect(findActiveSandboxWriter(db, { sandboxName: l.sandbox.name })?.id).toBe(run.id);
  });

  test("finding 3: the sweep re-probes and keeps a stubborn orphan non-terminal", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    sbx.dshAlive = true;
    sbx.stubbornDsh = true;
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => {
      dshStream(p);
      p.finish(1);
    };
    const l = await launchTaskSandboxRun(db, id, { source: repo, cli: sbx, spawner, outputRoot: outputRoot(), fastExitMs: 0 });
    await l.handle.wait();
    // The host client is gone after the launch path returned.
    db.query(`UPDATE runs SET pid = NULL, spawn_lstart = NULL WHERE id = ?`).run(l.handle.id);

    const res = sweepOrphanedSandboxRuns(db, { apply: true, cli: sbx });
    const o = res.orphaned.find((x) => x.runId === l.handle.id)!;
    expect(o.inVmAlive).toBe(true);
    expect(o.stopped).toBe(false);
    expect(o.resolved).toBe(false);
    const run = getRun(db, l.handle.id)!;
    expect(run.state).toBe("running"); // NOT marked terminal
    expect(run.error ?? "").toContain("non-terminal");
    expect(findActiveSandboxWriter(db, { sandboxName: l.sandbox.name })?.id).toBe(run.id);
  });

  test("finding 3: the sweep confirms 'gone' after pkill and marks the Run terminal", async () => {
    const id = newTask();
    const sbx = new FakeSbx();
    sbx.dshAlive = true; // non-stubborn: pkill will stop it
    const spawner = new FakeSpawner();
    spawner.onSpawn = (p) => dshStream(p); // never finishes -> row stays running
    const l = await launchTaskSandboxRun(db, id, { source: repo, cli: sbx, spawner, outputRoot: outputRoot() });
    db.query(`UPDATE runs SET pid = NULL, spawn_lstart = NULL WHERE id = ?`).run(l.handle.id);

    const res = sweepOrphanedSandboxRuns(db, { apply: true, cli: sbx });
    const o = res.orphaned.find((x) => x.runId === l.handle.id)!;
    expect(o.stopped).toBe(true);
    expect(o.resolved).toBe(true);
    const run = getRun(db, l.handle.id)!;
    expect(run.state).toBe("failed");
    expect(run.error ?? "").toContain("orphaned");
    expect(findActiveSandboxWriter(db, { sandboxName: l.sandbox.name })).toBeNull();
  });
});

describe("helpers", () => {
  test("fetchSandboxHead reports a missing remote instead of a fake sha", () => {
    const f = fetchSandboxHead(repo, "nope", "main");
    expect(f.ok).toBe(false);
    expect(f.sha).toBeNull();
  });

  test("sandboxDshAlive reads the in-VM probe", () => {
    const sbx = new FakeSbx();
    sbx.dshAlive = true;
    expect(sandboxDshAlive(sbx, "x")).toBe(true);
    sbx.dshAlive = false;
    expect(sandboxDshAlive(sbx, "x")).toBe(false);
  });
});
