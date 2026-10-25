import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { getTask } from "../src/tasks";
import { registerWorker } from "../src/workers";
import { intakeTask } from "../src/workflow";
import { getRun, type DshProcess, type DshSpawner } from "../src/dsh-runner";
import { PINNED_DSH_VERSION } from "../src/dsh-version";
import { applyWorkspaceCleanup, planWorkspaceCleanup } from "../src/run-lifecycle";
import type { GitHubReadOnly, PrView } from "../src/providers";
import type { RunContainer, RunResourceDocker, RunVolume } from "../src/run-resources";
import { controlPlaneId, realRunResourceDocker } from "../src/run-resources";
import { scanRunLeaks } from "../src/run-leaks";
import { reviewScratchTaskRoot } from "../src/scratch";

/**
 * ISH-1221: run-scoped resource reclamation. A real throwaway repo + a fake dsh
 * process keep the worktree/scratch lifecycle deterministic; Docker is an
 * in-memory seam so the test can prove labelled resources are removed while
 * unlabelled resources and every image stay untouched.
 */

class FakeProcess implements DshProcess {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number | null>;
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
  finish(code: number | null): void {
    if (this.finished) return;
    this.finished = true;
    try { this.outC.close(); } catch { /* noop */ }
    try { this.errC.close(); } catch { /* noop */ }
    this.resolveExit(code);
  }
  kill(): void {
    this.finish(143);
  }
}

class FakeSpawner implements DshSpawner {
  procs: FakeProcess[] = [];
  envs: Record<string, string>[] = [];
  spawn(_argv: string[], opts: { cwd: string; env: Record<string, string> }): DshProcess {
    const p = new FakeProcess(40_000 + this.procs.length);
    this.procs.push(p);
    this.envs.push(opts.env);
    return p;
  }
}

class FakeDocker implements RunResourceDocker {
  containers: RunContainer[] = [];
  volumes: RunVolume[] = [];
  removedContainers: string[] = [];
  removedVolumes: string[] = [];
  /** Images are hand-imported; the seam has no path to touch them. */
  images = ["ceos:4.31.2f", "frr:9.1"];
  containerError: string | null = null;
  volumeError: string | null = null;

  snapshot() {
    return {
      containers: [...this.containers],
      volumes: [...this.volumes],
      containerError: this.containerError,
      volumeError: this.volumeError,
    };
  }
  removeContainer(id: string) {
    if (!this.containers.some((c) => c.id === id)) return { ok: false, error: "no such container" };
    this.removedContainers.push(id);
    this.containers = this.containers.filter((c) => c.id !== id);
    return { ok: true, error: "" };
  }
  removeVolume(name: string) {
    if (!this.volumes.some((v) => v.name === name)) return { ok: false, error: "no such volume" };
    this.removedVolumes.push(name);
    this.volumes = this.volumes.filter((v) => v.name !== name);
    return { ok: true, error: "" };
  }
}

let dir = "";
let repo = "";
let db: Database;
let issueSeq = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

function pinnedDshBin(): string {
  const p = join(dir, "bin", "dsh-pinned");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(p, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${PINNED_DSH_VERSION}; exit 0; fi\nexit 0\n`);
  chmodSync(p, 0o755);
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-ish1221-"));
  repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "relay@test");
  git(repo, "config", "user.name", "relay-test");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "base");
  process.env.RELAY_DB = join(dir, "state.db");
  process.env.RELAY_DSH_BIN = pinnedDshBin();
  process.env.RELAY_MIN_FREE_DISK_BYTES = "0";
  db = openDb(process.env.RELAY_DB);
  registerWorker(db, "impl", { role: "worker" });
  issueSeq = 0;
});

afterEach(() => {
  db.close();
  delete process.env.RELAY_DSH_BIN;
  delete process.env.RELAY_MIN_FREE_DISK_BYTES;
  rmSync(dir, { recursive: true, force: true });
});

function newTask(extra: { prUrl?: string } = {}): string {
  return intakeTask(db, {
    provider: "test",
    issueId: `ISH-1221-${issueSeq++}`,
    codeChange: true,
    title: "reclaim my scratch",
    prUrl: extra.prUrl,
  }).id;
}

const outputRoot = () => join(dir, "runs");
const worktreesRoot = () => join(dir, "worktrees");

async function launchedRun(taskId: string): Promise<{ runId: string; outputDir: string; scratch: string }> {
  const spawner = new FakeSpawner();
  // `launchTaskRun` is imported lazily to keep the top imports focused.
  const { launchTaskRun } = await import("../src/run-lifecycle");
  const launched = await launchTaskRun(db, taskId, {
    repo,
    worktreesRoot: worktreesRoot(),
    outputRoot: outputRoot(),
    spawner,
    fastExitMs: 0,
  });
  spawner.procs[0].finish(0);
  const run = await launched.handle.wait();
  const scratch = join(run.output_dir, "scratch");
  writeFileSync(join(scratch, "tmp", "focused-check.txt"), "scratch\n");
  return { runId: run.id, outputDir: run.output_dir, scratch };
}

function prView(state: PrView["state"]): PrView {
  return {
    ref: { repo: "o/r", number: 1 },
    url: "https://github.com/o/r/pull/1",
    state,
    isDraft: false,
    headRefName: "relay/ish-1221",
    headSha: "a".repeat(40),
    baseRef: "main",
    baseSha: "b".repeat(40),
    mergeable: "mergeable",
    labels: [],
    updatedAt: "2026-10-25T00:00:00Z",
  };
}

function githubWith(state: PrView["state"]): GitHubReadOnly {
  return {
    name: "fake",
    readOnly: true,
    getPullRequest: () => prView(state),
    findPullRequestForBranch: () => null,
    listComments: () => [],
    rateLimit: () => null,
  };
}

function thisPlane(): string {
  return controlPlaneId(process.env.RELAY_DB!);
}

function labelledDocker(taskId: string, runId: string, otherTask = "T999"): FakeDocker {
  const plane = thisPlane();
  const docker = new FakeDocker();
  docker.containers = [
    { id: "c-task", name: "relay-task", plane, taskId, runId, state: "exited", sizeBytes: 1024 },
    { id: "c-other", name: "relay-other", plane, taskId: otherTask, runId: "run-other", state: "exited", sizeBytes: 2048 },
    // Same Task id as THIS plane, but a different control plane: T55 exists in
    // every checkout, so this must never be removed or reported as ours.
    { id: "c-cross-plane", name: "relay-foreign", plane: "0123456789ab", taskId, runId: "run-foreign", state: "exited", sizeBytes: 3072 },
    { id: "c-unlabelled", name: "human", plane: null, taskId: null, runId: null, state: "running", sizeBytes: 4096 },
  ];
  docker.volumes = [
    { name: "v-task", plane, taskId, runId, sizeBytes: null },
    { name: "v-other", plane, taskId: otherTask, runId: "run-other", sizeBytes: null },
    { name: "v-cross-plane", plane: "0123456789ab", taskId, runId: "run-foreign", sizeBytes: null },
    { name: "v-unlabelled", plane: null, taskId: null, runId: null, sizeBytes: null },
  ];
  return docker;
}

describe("ISH-1221: run scratch + labelled resource reclamation", () => {
  test("a worker Run gets a per-Run TMPDIR/CARGO_TARGET_DIR under its output dir", async () => {
    const id = newTask();
    const { scratch } = await launchedRun(id);
    const { launchTaskRun } = await import("../src/run-lifecycle");
    const spawner = new FakeSpawner();
    // A second Task/Run proves the root is per-Run, not a shared constant.
    const other = newTask();
    const launched = await launchTaskRun(db, other, {
      repo,
      worktreesRoot: worktreesRoot(),
      outputRoot: outputRoot(),
      spawner,
      fastExitMs: 0,
    });
    spawner.procs[0].finish(0);
    const run = await launched.handle.wait();
    const env = spawner.envs[0];
    expect(env.TMPDIR).toBe(join(run.output_dir, "scratch", "tmp"));
    expect(env.TMP).toBe(env.TMPDIR);
    expect(env.TEMP).toBe(env.TMPDIR);
    expect(env.CARGO_TARGET_DIR).toBe(join(run.output_dir, "scratch", "cargo-target"));
    expect(env.RELAY_SCRATCH_DIR).toBe(join(run.output_dir, "scratch"));
    expect(env.RELAY_DOCKER_LABEL_PLANE).toBe(`relay.plane=${thisPlane()}`);
    expect(env.RELAY_DOCKER_LABEL_TASK).toBe(`relay.task=${other}`);
    expect(env.RELAY_DOCKER_LABEL_RUN).toBe(`relay.run=${run.id}`);
    expect(env.TMPDIR).not.toBe(scratch);
  });

  test("merged cleanup removes the worktree, scratch and only this Task's labelled resources", async () => {
    const id = newTask();
    const { runId, outputDir, scratch } = await launchedRun(id);
    const worktree = getTask(db, id)!.worktree!;
    expect(existsSync(worktree)).toBe(true);
    db.query(`UPDATE tasks SET state='done', accepted_at=?, merged_at=? WHERE id=?`).run(Date.now(), Date.now(), id);
    const docker = labelledDocker(id, runId);

    const plan = await applyWorkspaceCleanup(db, id, {
      apply: true,
      repo,
      worktreesRoot: worktreesRoot(),
      outputRoot: outputRoot(),
      docker,
    });
    expect(plan.remove).toBe(true);
    expect(plan.removed).toBe(true);
    expect(getTask(db, id)!.worktree).toBeNull();
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(scratch)).toBe(false);
    // Run logs are retained as evidence.
    expect(getRun(db, runId)).not.toBeNull();
    expect(existsSync(outputDir)).toBe(true);
    expect(existsSync(join(outputDir, "stdout.log"))).toBe(true);
    // Only the matching labels were removed.
    expect(docker.removedContainers).toEqual(["c-task"]);
    expect(docker.removedVolumes).toEqual(["v-task"]);
    expect(docker.containers.map((c) => c.id)).toEqual(["c-other", "c-cross-plane", "c-unlabelled"]);
    expect(docker.volumes.map((v) => v.name)).toEqual(["v-other", "v-cross-plane", "v-unlabelled"]);
    // Images are untouched: the seam has no image path at all.
    expect(docker.images).toEqual(["ceos:4.31.2f", "frr:9.1"]);
  });

  test("a CANCELLED Task whose PR is CLOSED is reclaimed, not refused as open PR", async () => {
    const id = newTask({ prUrl: "https://github.com/o/r/pull/1" });
    const { runId, scratch } = await launchedRun(id);
    const worktree = getTask(db, id)!.worktree!;
    db.query(`UPDATE tasks SET state='cancelled', pr_repo='o/r' WHERE id=?`).run(id);
    const docker = labelledDocker(id, runId);

    const plan = await applyWorkspaceCleanup(db, id, {
      apply: true,
      repo,
      worktreesRoot: worktreesRoot(),
      outputRoot: outputRoot(),
      github: githubWith("closed"),
      docker,
    });
    expect(plan.reasons.join(" ")).not.toMatch(/open PR/);
    expect(plan.remove).toBe(true);
    expect(plan.removed).toBe(true);
    expect(getTask(db, id)!.worktree).toBeNull();
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(scratch)).toBe(false);
    expect(docker.removedContainers).toEqual(["c-task"]);
    expect(docker.removedVolumes).toEqual(["v-task"]);
  });

  test("a live-OPEN PR still refuses cleanup and says why", async () => {
    const id = newTask({ prUrl: "https://github.com/o/r/pull/1" });
    await launchedRun(id);
    db.query(`UPDATE tasks SET state='cancelled', pr_repo='o/r' WHERE id=?`).run(id);
    const plan = await planWorkspaceCleanup(db, id, {
      repo,
      worktreesRoot: worktreesRoot(),
      outputRoot: outputRoot(),
      github: githubWith("open"),
      docker: new FakeDocker(),
    });
    expect(plan.remove).toBe(false);
    expect(plan.reasons.join(" ")).toMatch(/open PR/);
  });

  test("a dirty tracked worktree refuses, saves a patch, then --force discards", async () => {
    const id = newTask();
    const { scratch } = await launchedRun(id);
    const task = getTask(db, id)!;
    writeFileSync(join(task.worktree!, "README.md"), "changed but not committed\n");
    db.query(`UPDATE tasks SET state='cancelled' WHERE id=?`).run(id);

    const blocked = await applyWorkspaceCleanup(db, id, {
      apply: true,
      repo,
      worktreesRoot: worktreesRoot(),
      outputRoot: outputRoot(),
      docker: new FakeDocker(),
    });
    expect(blocked.removed).toBe(false);
    expect(blocked.reasons.join(" ")).toMatch(/uncommitted/);
    expect(blocked.savedPatch).toBeTruthy();
    expect(readFileSync(blocked.savedPatch!, "utf-8")).toContain("changed but not committed");
    expect(existsSync(task.worktree!)).toBe(true);
    expect(existsSync(scratch)).toBe(true);

    const forced = await applyWorkspaceCleanup(db, id, {
      apply: true,
      force: true,
      repo,
      worktreesRoot: worktreesRoot(),
      outputRoot: outputRoot(),
      docker: new FakeDocker(),
    });
    expect(forced.removed).toBe(true);
    expect(existsSync(scratch)).toBe(false);
  });

  test("the leak report lists scratch/containers/volumes/worktrees with sizes and skips unlabelled", async () => {
    const id = newTask();
    const { runId } = await launchedRun(id);
    db.query(`UPDATE tasks SET state='cancelled' WHERE id=?`).run(id);
    // A review scratch root for the same Task.
    const reviewScratch = reviewScratchTaskRoot(outputRoot(), id);
    mkdirSync(join(reviewScratch, "scratch", "tmp"), { recursive: true });
    writeFileSync(join(reviewScratch, "scratch", "tmp", "review.txt"), "review\n");
    const docker = labelledDocker(id, runId);

    const report = scanRunLeaks(db, {
      repo,
      outputRoot: outputRoot(),
      worktreesRoot: worktreesRoot(),
      docker,
    });
    const kinds = new Set(report.entries.map((e) => e.kind));
    expect(kinds.has("scratch")).toBe(true);
    expect(kinds.has("review-scratch")).toBe(true);
    expect(kinds.has("worktree")).toBe(true);
    expect(kinds.has("container")).toBe(true);
    expect(kinds.has("volume")).toBe(true);
    for (const e of report.entries) {
      expect(e.sizeBytes === null || e.sizeBytes > 0).toBe(true);
    }
    expect(report.entries.map((e) => e.id)).not.toContain("c-unlabelled");
    expect(report.entries.map((e) => e.id)).not.toContain("v-unlabelled");
    // Another control plane's relay.task=<same T> is not this plane's orphan.
    expect(report.entries.map((e) => e.id)).not.toContain("c-cross-plane");
    expect(report.entries.map((e) => e.id)).not.toContain("v-cross-plane");
    expect(report.dockerErrors).toEqual([]);
  });

  test("a leak scan with no docker seam reports the disabled inventory instead of reading host Docker", () => {
    const report = scanRunLeaks(db, { repo, outputRoot: outputRoot(), worktreesRoot: worktreesRoot() });
    expect(report.dockerErrors.join(" ")).toMatch(/docker inventory disabled/);
    expect(report.entries.filter((e) => e.kind === "container" || e.kind === "volume")).toEqual([]);
  });

  test("the CLI `relay run cleanup <task> --apply` removes the worktree and scratch", async () => {
    const id = newTask();
    const { runId, scratch } = await launchedRun(id);
    db.query(`UPDATE tasks SET state='done', accepted_at=?, merged_at=? WHERE id=?`).run(Date.now(), Date.now(), id);
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const out = execFileSync(process.execPath, [cli, "run", "cleanup", id, "--apply", "--repo", repo, "--json"], {
      encoding: "utf8",
      env: {
        ...process.env,
        RELAY_DB: process.env.RELAY_DB!,
        RELAY_MIN_FREE_DISK_BYTES: "0",
        // Never let the CLI subprocess read/remove real host Docker resources.
        RELAY_DOCKER_RESOURCES: "off",
      },
    });
    const plan = JSON.parse(out);
    expect(plan.removed).toBe(true);
    expect(existsSync(scratch)).toBe(false);
    expect(getRun(db, runId)).not.toBeNull();
  });

  test("the real Docker seam never has an image-removal path", () => {
    const argv: string[][] = [];
    const docker = realRunResourceDocker((args) => {
      argv.push(args);
      if (args[0] === "ps") return { ok: true, stdout: "", stderr: "" };
      if (args[0] === "volume" && args[1] === "ls") return { ok: true, stdout: "", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    });
    docker.snapshot();
    docker.removeContainer("abc");
    docker.removeVolume("vol");
    const flat = argv.map((a) => a.join(" ")).join("\n");
    expect(flat).not.toMatch(/\brmi\b|image\s+prune|system\s+prune/);
    expect(flat).toContain("label=relay.task");
    expect(flat).toContain("label=relay.run");
    // `-v` reclaims the labelled container's anonymous dind volumes too.
    expect(flat).toContain("rm -f -v abc");
  });

  test("the control-plane namespace differs per DB path", () => {
    expect(controlPlaneId("/a/.relay/state.db")).not.toBe(controlPlaneId("/b/.relay/state.db"));
    expect(controlPlaneId("/a/.relay/state.db")).toBe(controlPlaneId("/a/.relay/state.db"));
  });

  test("the inventory includes run-only labels and the plane label", () => {
    const plane = thisPlane();
    const docker = realRunResourceDocker((args) => {
      if (args[0] === "ps") {
        const filter = args[args.indexOf("--filter") + 1];
        const row =
          filter === "label=relay.run"
            ? { ID: "run-only", Names: "r", Labels: `relay.plane=${plane},relay.run=run-1`, State: "exited", Size: "1MB" }
            : { ID: "task-only", Names: "t", Labels: `relay.plane=${plane},relay.task=T1`, State: "exited", Size: "2MB" };
        return { ok: true, stdout: JSON.stringify(row), stderr: "" };
      }
      if (args[0] === "volume" && args[1] === "ls") {
        const filter = args[args.indexOf("--filter") + 1];
        return { ok: true, stdout: filter === "label=relay.run" ? "v-run\n" : "v-task\n", stderr: "" };
      }
      if (args[0] === "volume" && args[1] === "inspect") {
        const name = args[args.length - 1];
        return {
          ok: true,
          stdout: JSON.stringify({
            Labels: { "relay.plane": plane, "relay.task": "T1", "relay.run": name === "v-run" ? "run-1" : "run-2" },
          }),
          stderr: "",
        };
      }
      return { ok: true, stdout: "", stderr: "" };
    });
    const snapshot = docker.snapshot();
    expect(snapshot.containers.map((c) => c.id).sort()).toEqual(["run-only", "task-only"]);
    expect(snapshot.containers.every((c) => c.plane === plane)).toBe(true);
    expect(snapshot.volumes.map((v) => v.name).sort()).toEqual(["v-run", "v-task"]);
    expect(snapshot.volumes.every((v) => v.plane === plane)).toBe(true);
  });

  test("--abort still refuses a live-OPEN PR, and the default seam never touches Docker", async () => {
    const id = newTask({ prUrl: "https://github.com/o/r/pull/1" });
    const { scratch } = await launchedRun(id);
    db.query(`UPDATE tasks SET state='cancelled', pr_repo='o/r' WHERE id=?`).run(id);
    const plan = await applyWorkspaceCleanup(db, id, {
      apply: true,
      abort: "superseded",
      repo,
      worktreesRoot: worktreesRoot(),
      outputRoot: outputRoot(),
      github: githubWith("open"),
    });
    expect(plan.remove).toBe(false);
    expect(plan.reasons.join(" ")).toMatch(/open PR/);
    expect(existsSync(scratch)).toBe(true);
    // No docker seam was passed: the disabled default is what ran, and it says so.
    expect(plan.containers).toEqual([]);
    expect(plan.volumes).toEqual([]);
    expect(plan.warnings.join(" ")).toMatch(/docker inventory disabled/);
  });
});
