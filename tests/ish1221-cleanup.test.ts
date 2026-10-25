import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { getTask, unbindTaskPr } from "../src/tasks";
import { registerWorker } from "../src/workers";
import { intakeTask } from "../src/workflow";
import { getRun, type DshProcess, type DshSpawner } from "../src/dsh-runner";
import { PINNED_DSH_VERSION } from "../src/dsh-version";
import { applyWorkspaceCleanup, planWorkspaceCleanup } from "../src/run-lifecycle";
import type { GitHubReadOnly, PrView } from "../src/providers";
import type { RunContainer, RunResourceDocker, RunVolume, SnapshotOptions } from "../src/run-resources";
import { controlPlaneId, realRunResourceDocker } from "../src/run-resources";
import { scanRunLeaks } from "../src/run-leaks";
import { devcontainerId, dindVolumeName, dindVolumeNamesForWorkspace } from "../src/devcontainer-id";
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
  /** Relay-labelled containers/volumes. */
  containers: RunContainer[] = [];
  volumes: RunVolume[] = [];
  /** ISH-1222: unlabelled dind volumes, attributed only by the exact derived name. */
  dindVolumes: RunVolume[] = [];
  removedContainers: string[] = [];
  removedVolumes: string[] = [];
  /** Images are hand-imported; the seam has no path to touch them. */
  images = ["ceos:4.31.2f", "frr:9.1"];
  containerError: string | null = null;
  volumeError: string | null = null;
  sizeError: string | null = null;

  snapshot(opts: SnapshotOptions = {}) {
    const wanted = new Set(opts.dindVolumeNames ?? []);
    return {
      containers: [...this.containers],
      volumes: [...this.volumes],
      dindVolumes: this.dindVolumes.filter((v) => wanted.has(v.name)).map((v) => ({ ...v })),
      containerError: this.containerError,
      volumeError: this.volumeError,
      sizeError: this.sizeError,
    };
  }
  removeContainer(id: string) {
    if (!this.containers.some((c) => c.id === id)) return { ok: false, error: "no such container" };
    this.removedContainers.push(id);
    this.containers = this.containers.filter((c) => c.id !== id);
    return { ok: true, error: "" };
  }
  removeVolume(name: string) {
    const known =
      this.volumes.some((v) => v.name === name) || this.dindVolumes.some((v) => v.name === name);
    if (!known) return { ok: false, error: "no such volume" };
    this.removedVolumes.push(name);
    this.volumes = this.volumes.filter((v) => v.name !== name);
    this.dindVolumes = this.dindVolumes.filter((v) => v.name !== name);
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
    { name: "v-task", plane, taskId, runId, sizeBytes: null, inUse: false },
    { name: "v-other", plane, taskId: otherTask, runId: "run-other", sizeBytes: null, inUse: false },
    { name: "v-cross-plane", plane: "0123456789ab", taskId, runId: "run-foreign", sizeBytes: null, inUse: false },
    { name: "v-unlabelled", plane: null, taskId: null, runId: null, sizeBytes: null, inUse: true },
  ];
  return docker;
}

/** Commit a devcontainer config so Relay can derive the exact dind volume id. */
function commitDevcontainerConfig(): void {
  mkdirSync(join(repo, ".devcontainer"), { recursive: true });
  writeFileSync(join(repo, ".devcontainer", "devcontainer.json"), '{"image":"mcr.microsoft.com/devcontainers/base:ubuntu"}\n');
  git(repo, "add", ".devcontainer/devcontainer.json");
  git(repo, "commit", "-q", "-m", "add devcontainer config");
}

/** The exact dind volume this worktree's devcontainer creates, unlabelled. */
function dindVolumeFor(worktree: string, opts: { sizeBytes?: number; inUse?: boolean } = {}): RunVolume {
  const names = dindVolumeNamesForWorkspace(worktree);
  expect(names.length).toBeGreaterThan(0);
  return {
    name: names[0],
    plane: null,
    taskId: null,
    runId: null,
    sizeBytes: opts.sizeBytes ?? Math.round(2.7 * 1024 ** 3),
    inUse: opts.inUse ?? false,
  };
}

/**
 * A real `docker` CLI shim on PATH: Relay's production seam (`realDockerExec`)
 * runs it, so the test exercises `relay run cleanup`/`run list --leaks` end to
 * end without touching host Docker. It knows exactly two dind volumes (this
 * Task's + an unrelated one) and logs every mutating command.
 */
function writeDockerShim(taskDind: string, unrelatedDind: string): { bin: string; log: string; env: Record<string, string> } {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, "docker-mutations.log");
  const env = {
    RELAY_TEST_TASK_DIND: taskDind,
    RELAY_TEST_UNRELATED_DIND: unrelatedDind,
    RELAY_TEST_DOCKER_LOG: log,
  };
  const script = `#!/bin/sh
set -eu
cmd="\${1:-}"
if [ $# -gt 0 ]; then shift; fi
log="\${RELAY_TEST_DOCKER_LOG:?}"
case "$cmd" in
  ps) exit 0 ;;
  volume)
    sub="\${1:-}"
    if [ $# -gt 0 ]; then shift; fi
    case "$sub" in
      ls) exit 0 ;;
      inspect)
        # args: --format '{{json .}}' <name>
        name="\${3:-}"
        if [ "$name" = "\${RELAY_TEST_TASK_DIND:?}" ] || [ "$name" = "\${RELAY_TEST_UNRELATED_DIND:?}" ]; then
          printf '{"Name":"%s","Labels":null,"Mountpoint":"/tmp/dind"}\\n' "$name"
          exit 0
        fi
        printf 'Error response from daemon: no such volume: %s\\n' "$name" >&2
        exit 1
        ;;
      rm)
        printf 'volume rm %s\\n' "\${1:-}" >> "$log"
        exit 0
        ;;
    esac
    exit 0
    ;;
  system)
    printf '{"Volumes":[{"Name":"%s","Size":"2.7GB","Links":"0"},{"Name":"%s","Size":"1.1GB","Links":"0"}]}\\n' \\
      "\${RELAY_TEST_TASK_DIND:?}" "\${RELAY_TEST_UNRELATED_DIND:?}"
    exit 0
    ;;
  rm)
    printf 'rm %s\\n' "$*" >> "$log"
    exit 0
    ;;
  rmi|image|prune)
    printf 'FORBIDDEN %s %s\\n' "$cmd" "$*" >> "$log"
    exit 1
    ;;
esac
exit 0
`;
  writeFileSync(join(bin, "docker"), script);
  chmodSync(join(bin, "docker"), 0o755);
  return { bin, log, env };
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
    // `-v` reclaims only ANONYMOUS volumes; the named dind volume is derived
    // and removed explicitly (ISH-1222), never by this flag.
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

  // --- ISH-1222: devcontainer dind named volumes ---

  test("the devcontainer id and dind name match @devcontainers/cli", () => {
    // Independent fixture: sha256(JSON.stringify({config_file, local_folder}))
    // -> base32(0-9a-v), left-padded to 52 chars.
    const id = devcontainerId("/workspaces/demo", "/workspaces/demo/.devcontainer/devcontainer.json");
    expect(id).toBe("0vhg70gun28ie7ilcg66ls827mfr9belol5p1b61mq4bj2o6n67d");
    expect(dindVolumeName(id)).toBe(
      "dind-var-lib-docker-0vhg70gun28ie7ilcg66ls827mfr9belol5p1b61mq4bj2o6n67d"
    );
    // Only configs that actually exist are candidates.
    expect(dindVolumeNamesForWorkspace("/workspaces/demo")).toEqual([]);
  });

  test("the real Docker seam resolves only the exact derived dind name, with its size", () => {
    const argv: string[][] = [];
    const dind = dindVolumeName("a".repeat(52));
    const unrelated = dindVolumeName("b".repeat(52));
    const docker = realRunResourceDocker((args) => {
      argv.push(args);
      if (args[0] === "ps") return { ok: true, stdout: "", stderr: "" };
      if (args[0] === "volume" && args[1] === "ls") return { ok: true, stdout: "", stderr: "" };
      if (args[0] === "system") {
        return {
          ok: true,
          stdout: JSON.stringify({
            Volumes: [
              { Name: dind, Size: "2.7GB", Links: "0" },
              { Name: unrelated, Size: "1.1GB", Links: "0" },
            ],
          }),
          stderr: "",
        };
      }
      if (args[0] === "volume" && args[1] === "inspect") {
        const name = args[args.length - 1];
        if (name === dind) return { ok: true, stdout: JSON.stringify({ Labels: null }), stderr: "" };
        return { ok: false, stdout: "", stderr: "no such volume" };
      }
      return { ok: true, stdout: "", stderr: "" };
    });
    const snapshot = docker.snapshot({ dindVolumeNames: [dind] });
    expect(snapshot.dindVolumes.map((v) => v.name)).toEqual([dind]);
    expect(snapshot.dindVolumes[0].sizeBytes).toBe(Math.round(2.7 * 1024 ** 3));
    expect(snapshot.dindVolumes[0].inUse).toBe(false);
    expect(snapshot.volumes).toEqual([]);
    // The unrelated dind volume is never even inspected.
    const inspected = argv
      .filter((a) => a[0] === "volume" && a[1] === "inspect")
      .map((a) => a[a.length - 1]);
    expect(inspected).toEqual([dind]);
    const flat = argv.map((a) => a.join(" ")).join("\n");
    expect(flat).not.toMatch(/\brmi\b|image\s+prune/);
  });

  test("merged cleanup removes this Run's derived dind named volume and no other", async () => {
    commitDevcontainerConfig();
    const id = newTask();
    const { runId } = await launchedRun(id);
    const worktree = getTask(db, id)!.worktree!;
    const dind = dindVolumeFor(worktree);
    const unrelated: RunVolume = {
      name: dindVolumeName("z".repeat(52)),
      plane: null,
      taskId: null,
      runId: null,
      sizeBytes: 123,
      inUse: false,
    };
    db.query(`UPDATE tasks SET state='done', accepted_at=?, merged_at=? WHERE id=?`).run(Date.now(), Date.now(), id);
    const docker = labelledDocker(id, runId);
    docker.dindVolumes = [dind, unrelated];

    const plan = await applyWorkspaceCleanup(db, id, {
      apply: true,
      repo,
      worktreesRoot: worktreesRoot(),
      outputRoot: outputRoot(),
      docker,
    });
    expect(plan.remove).toBe(true);
    expect(plan.removed).toBe(true);
    expect(plan.volumes).toContainEqual({ name: dind.name, dind: true, inUse: false });
    expect(docker.removedVolumes).toContain(dind.name);
    expect(docker.removedVolumes).not.toContain(unrelated.name);
    expect(docker.dindVolumes.map((v) => v.name)).toEqual([unrelated.name]);
    expect(docker.images).toEqual(["ceos:4.31.2f", "frr:9.1"]);
  });

  test("cancelled cleanup removes this Run's derived dind named volume and no other", async () => {
    commitDevcontainerConfig();
    const id = newTask();
    const { runId } = await launchedRun(id);
    const worktree = getTask(db, id)!.worktree!;
    const dind = dindVolumeFor(worktree);
    const unrelated: RunVolume = {
      name: dindVolumeName("y".repeat(52)),
      plane: null,
      taskId: null,
      runId: null,
      sizeBytes: 456,
      inUse: false,
    };
    db.query(`UPDATE tasks SET state='cancelled' WHERE id=?`).run(id);
    const docker = labelledDocker(id, runId);
    docker.dindVolumes = [dind, unrelated];

    const plan = await applyWorkspaceCleanup(db, id, {
      apply: true,
      repo,
      worktreesRoot: worktreesRoot(),
      outputRoot: outputRoot(),
      docker,
    });
    expect(plan.remove).toBe(true);
    expect(docker.removedVolumes).toContain(dind.name);
    expect(docker.removedVolumes).not.toContain(unrelated.name);
    expect(docker.images).toEqual(["ceos:4.31.2f", "frr:9.1"]);
  });

  test("a recorded Run cwd still reclaims/leaks the dind volume after the worktree is gone", async () => {
    commitDevcontainerConfig();
    const id = newTask();
    const { runId } = await launchedRun(id);
    const worktree = getTask(db, id)!.worktree!;
    const dind = dindVolumeFor(worktree);
    // An earlier (pre-fix) cleanup removed the worktree but left the named volume.
    rmSync(worktree, { recursive: true, force: true });
    db.query(`UPDATE tasks SET worktree=NULL, state='done', accepted_at=?, merged_at=? WHERE id=?`).run(
      Date.now(),
      Date.now(),
      id
    );
    const docker = new FakeDocker();
    docker.dindVolumes = [dind];

    // The leak patrol derives the exact volume from runs.cwd even though the
    // workspace/config no longer exists.
    const report = scanRunLeaks(db, {
      repo,
      outputRoot: outputRoot(),
      worktreesRoot: worktreesRoot(),
      docker,
    });
    const entry = report.entries.find((e) => e.kind === "dind-volume");
    expect(entry).toBeDefined();
    expect(entry!.id).toBe(dind.name);
    expect(entry!.runId).toBe(runId);

    const plan = await applyWorkspaceCleanup(db, id, {
      apply: true,
      repo,
      worktreesRoot: worktreesRoot(),
      outputRoot: outputRoot(),
      docker,
    });
    expect(plan.remove).toBe(true);
    expect(plan.removedResources).toContain(`volume ${dind.name} (dind)`);
    expect(docker.removedVolumes).toEqual([dind.name]);
  });

  test("a Run records a NAMED devcontainer's exact dind volume and reclaims it after the worktree is gone", async () => {
    commitDevcontainerConfig();
    mkdirSync(join(repo, ".devcontainer", "ci"), { recursive: true });
    writeFileSync(join(repo, ".devcontainer", "ci", "devcontainer.json"), '{"image":"ubuntu:24.04"}\n');
    git(repo, "add", ".devcontainer/ci/devcontainer.json");
    git(repo, "commit", "-q", "-m", "add named devcontainer config");

    const id = newTask();
    const { runId } = await launchedRun(id);
    const worktree = getTask(db, id)!.worktree!;
    const namedConfig = join(worktree, ".devcontainer", "ci", "devcontainer.json");
    const namedDind = dindVolumeName(devcontainerId(worktree, namedConfig));

    // The Run row records the exact name at launch, while the config exists.
    const run = getRun(db, runId)!;
    const recorded = JSON.parse(run.devcontainer_volumes ?? "[]") as string[];
    expect(recorded).toContain(namedDind);

    // A later cleanup cannot re-derive a NAMED config from a deleted worktree
    // (only the two default paths are guessed); the record is what saves it.
    rmSync(worktree, { recursive: true, force: true });
    db.query(`UPDATE tasks SET worktree=NULL, state='done', accepted_at=?, merged_at=? WHERE id=?`).run(
      Date.now(),
      Date.now(),
      id
    );
    const docker = new FakeDocker();
    docker.dindVolumes = [
      { name: namedDind, plane: null, taskId: null, runId: null, sizeBytes: 777, inUse: false },
    ];
    const plan = await applyWorkspaceCleanup(db, id, {
      apply: true,
      repo,
      worktreesRoot: worktreesRoot(),
      outputRoot: outputRoot(),
      docker,
    });
    expect(plan.remove).toBe(true);
    expect(plan.removedResources).toContain(`volume ${namedDind} (dind)`);
    expect(docker.removedVolumes).toEqual([namedDind]);
  });

  test("an in-use derived dind volume is left alone with a next-step warning", async () => {
    commitDevcontainerConfig();
    const id = newTask();
    const { runId } = await launchedRun(id);
    const worktree = getTask(db, id)!.worktree!;
    const dind = dindVolumeFor(worktree, { inUse: true });
    db.query(`UPDATE tasks SET state='cancelled' WHERE id=?`).run(id);
    const docker = new FakeDocker();
    docker.dindVolumes = [dind];

    const plan = await applyWorkspaceCleanup(db, id, {
      apply: true,
      repo,
      worktreesRoot: worktreesRoot(),
      outputRoot: outputRoot(),
      docker,
    });
    expect(docker.removedVolumes).toEqual([]);
    expect(plan.warnings.join(" ")).toMatch(/still referenced by a container/);
    expect(plan.warnings.join(" ")).toMatch(/docker rm -v <devcontainer>/);
  });

  test("the leak report lists an orphaned dind volume with Docker's size", async () => {
    commitDevcontainerConfig();
    const id = newTask();
    const { runId } = await launchedRun(id);
    const worktree = getTask(db, id)!.worktree!;
    const dind = dindVolumeFor(worktree);
    const unrelated: RunVolume = {
      name: dindVolumeName("x".repeat(52)),
      plane: null,
      taskId: null,
      runId: null,
      sizeBytes: 999,
      inUse: false,
    };
    db.query(`UPDATE tasks SET state='cancelled' WHERE id=?`).run(id);
    const docker = new FakeDocker();
    docker.dindVolumes = [dind, unrelated];

    const report = scanRunLeaks(db, {
      repo,
      outputRoot: outputRoot(),
      worktreesRoot: worktreesRoot(),
      docker,
    });
    const entry = report.entries.find((e) => e.kind === "dind-volume");
    expect(entry).toBeDefined();
    expect(entry!.id).toBe(dind.name);
    expect(entry!.taskId).toBe(id);
    expect(entry!.runId).toBe(runId);
    expect(entry!.sizeBytes).toBe(dind.sizeBytes);
    expect(report.totalBytes).toBeGreaterThanOrEqual(dind.sizeBytes!);
    expect(report.entries.map((e) => e.id)).not.toContain(unrelated.name);
  });

  test("an unverifiable live PR refusal names the exact operator next step", async () => {
    const id = newTask({ prUrl: "https://github.com/o/r/pull/1" });
    await launchedRun(id);
    db.query(`UPDATE tasks SET state='cancelled', pr_repo='o/r' WHERE id=?`).run(id);
    // No github reader -> the live state is unknown: fail CLOSED, but explain.
    const plan = await planWorkspaceCleanup(db, id, {
      repo,
      worktreesRoot: worktreesRoot(),
      outputRoot: outputRoot(),
    });
    expect(plan.remove).toBe(false);
    const message = plan.reasons.join(" ");
    expect(message).toMatch(/live state could not be re-read/);
    expect(message).toContain("gh auth status");
    expect(message).toContain("RELAY_PROVIDER_GITHUB=gh");
    expect(message).toContain(`relay pr unbind ${id} --reason`);
    // It is advice, not a silent override: nothing was removed.
    expect(plan.removed).toBe(false);
  });

  test("relay pr unbind clears the PR binding and logs the explicit override", () => {
    const id = newTask({ prUrl: "https://github.com/o/r/pull/1" });
    db.query(`UPDATE tasks SET pr_repo='o/r', pr_base='main', pr_base_sha='b', pr_diff='d' WHERE id=?`).run(id);
    const t = unbindTaskPr(db, id, "PR closed by operator");
    expect(t.pr_url).toBeNull();
    expect(t.pr_repo).toBeNull();
    expect(t.pr_base).toBeNull();
    expect(t.pr_base_sha).toBeNull();
    expect(t.pr_diff).toBeNull();
    const ev = db
      .query(`SELECT payload_json FROM events WHERE task_id = ? AND type = 'task.pr_unbound' ORDER BY id DESC LIMIT 1`)
      .get(id) as { payload_json: string } | null;
    expect(ev).not.toBeNull();
    expect(JSON.parse(ev!.payload_json).reason).toBe("PR closed by operator");
    // A second unbind has nothing to clear and says so instead of silently succeeding.
    expect(() => unbindTaskPr(db, id)).toThrow(/no PR binding/);
  });

  test("the CLI `relay pr unbind` clears the binding through the operator command", () => {
    const id = newTask({ prUrl: "https://github.com/o/r/pull/1" });
    db.query(`UPDATE tasks SET pr_repo='o/r' WHERE id=?`).run(id);
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const out = execFileSync(process.execPath, [cli, "pr", "unbind", id, "--reason", "PR closed"], {
      encoding: "utf8",
      env: { ...process.env, RELAY_DB: process.env.RELAY_DB! },
    });
    expect(out).toContain("PR binding cleared");
    expect(getTask(db, id)!.pr_url).toBeNull();
    expect(getTask(db, id)!.pr_repo).toBeNull();
  });

  test("controlPlaneId is stable across symlinked DB paths", () => {
    const realDir = join(dir, "real-plane");
    mkdirSync(realDir, { recursive: true });
    const linkedDir = join(dir, "linked-plane");
    symlinkSync(realDir, linkedDir, "dir");
    const realDb = join(realDir, "state.db");
    writeFileSync(realDb, "");
    expect(controlPlaneId(join(linkedDir, "state.db"))).toBe(controlPlaneId(realDb));
    // A FILE symlink (the `/tmp` -> `/private/tmp` style) canonicalizes too.
    const linkedFile = join(dir, "linked-state.db");
    symlinkSync(realDb, linkedFile);
    expect(controlPlaneId(linkedFile)).toBe(controlPlaneId(realDb));
    // A not-yet-created DB canonicalizes its existing parent directory too.
    expect(controlPlaneId(join(linkedDir, "not-yet.db"))).toBe(controlPlaneId(join(realDir, "not-yet.db")));
    // Different physical DBs still differ.
    expect(controlPlaneId(realDb)).not.toBe(controlPlaneId(join(realDir, "other.db")));
  });

  for (const mode of ["merged", "cancelled"] as const) {
    test(`the CLI run cleanup --apply reclaims the dind volume on a ${mode} Task (docker shim)`, async () => {
      commitDevcontainerConfig();
      const id = newTask();
      const { runId } = await launchedRun(id);
      const worktree = getTask(db, id)!.worktree!;
      const taskDind = dindVolumeNamesForWorkspace(worktree)[0];
      const unrelated = dindVolumeName("q".repeat(52));
      if (mode === "merged") {
        db.query(`UPDATE tasks SET state='done', accepted_at=?, merged_at=? WHERE id=?`).run(Date.now(), Date.now(), id);
      } else {
        db.query(`UPDATE tasks SET state='cancelled' WHERE id=?`).run(id);
      }
      const shim = writeDockerShim(taskDind, unrelated);
      const cli = join(import.meta.dir, "..", "src", "cli.ts");
      const env = {
        ...process.env,
        RELAY_DB: process.env.RELAY_DB!,
        RELAY_MIN_FREE_DISK_BYTES: "0",
        RELAY_DOCKER_RESOURCES: "on",
        PATH: `${shim.bin}:${process.env.PATH}`,
        ...shim.env,
      };
      // The leak patrol (before cleanup) lists the exact dind volume with size,
      // and never the unrelated one.
      const leakOut = execFileSync(process.execPath, [cli, "run", "list", "--leaks", "--repo", repo, "--json"], {
        encoding: "utf8",
        env,
      });
      const report = JSON.parse(leakOut);
      const entry = report.entries.find((e: { kind: string; id: string }) => e.kind === "dind-volume" && e.id === taskDind);
      expect(entry).toBeTruthy();
      expect(entry.sizeBytes).toBe(Math.round(2.7 * 1024 ** 3));
      expect(report.entries.map((e: { id: string }) => e.id)).not.toContain(unrelated);

      const out = execFileSync(process.execPath, [cli, "run", "cleanup", id, "--apply", "--repo", repo, "--json"], {
        encoding: "utf8",
        env,
      });
      const plan = JSON.parse(out);
      expect(plan.removed).toBe(true);
      expect(plan.removedResources).toContain(`volume ${taskDind} (dind)`);
      const mutations = readFileSync(shim.log, "utf8");
      expect(mutations).toContain(`volume rm ${taskDind}`);
      expect(mutations).not.toContain(unrelated);
      expect(mutations).not.toMatch(/FORBIDDEN|\brmi\b|image/);
      // Evidence is retained.
      expect(getRun(db, runId)).not.toBeNull();
      expect(existsSync(join(outputRoot(), runId))).toBe(true);
    });
  }
});
