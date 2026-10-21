import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { getTask } from "../src/tasks";
import { intakeTask } from "../src/workflow";
import { listRuns, startDshRun, type DshProcess, type DshSpawner } from "../src/dsh-runner";
import { PINNED_DSH_VERSION } from "../src/dsh-version";
import { launchTaskRun } from "../src/run-lifecycle";
import { listEvents } from "../src/events";
import {
  assertLaunchDiskSpace,
  DISK_PROBE_FAILED,
  evaluateDiskSpace,
  formatBytes,
  LaunchDiskError,
  latestLaunchRefusal,
  LOW_DISK,
} from "../src/disk-guard";

// ISH-1009: the pre-launch disk guard. A Run must not start when the worktree /
// DB volume is below the configured floor, and a probe failure is NEVER a pass.
// These tests use an injected probe, so they do not depend on the free space of
// the machine running the suite. The retry test proves the queued Task launches
// normally once the next attempt sees enough room again.

class FakeProcess implements DshProcess {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number | null>;
  private outC!: ReadableStreamDefaultController<Uint8Array>;
  private errC!: ReadableStreamDefaultController<Uint8Array>;
  private resolveExit!: (code: number | null) => void;
  private finished = false;

  constructor(pid: number) {
    this.pid = pid;
    this.stdout = new ReadableStream({ start: (c) => (this.outC = c) });
    this.stderr = new ReadableStream({ start: (c) => (this.errC = c) });
    this.exited = new Promise((resolve) => (this.resolveExit = resolve));
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

  kill(): void {
    this.finish(143);
  }
}

class FakeSpawner implements DshSpawner {
  calls = 0;
  spawn(): DshProcess {
    const p = new FakeProcess(40_000 + this.calls++);
    queueMicrotask(() => {
      p.writeOut(JSON.stringify({ type: "session", sessionId: "session-disk-guard", cwd: "/tmp" }) + "\n");
      p.writeOut(JSON.stringify({ type: "final", text: "done" }) + "\n");
      p.finish(0);
    });
    return p;
  }
}

let dir = "";
let repo = "";
let db: Database;
let seq = 0;
let prevMinFreeDisk: string | undefined;

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

function newTask(): string {
  return intakeTask(db, {
    provider: "test",
    issueId: `ISH-1009-${seq++}`,
    codeChange: true,
    title: "implement the thing",
  }).id;
}

function launch(id: string, freeBytes: number | (() => number), spawner = new FakeSpawner()) {
  return launchTaskRun(db, id, {
    repo,
    worktreesRoot: join(dir, "worktrees"),
    outputRoot: join(dir, "runs"),
    dshBin: pinnedDshBin(),
    fastExitMs: 0,
    spawner,
    diskGuard: {
      minFreeBytes: 1_000,
      paths: [join(dir, "worktrees"), join(dir, "state.db")],
      probe: typeof freeBytes === "function" ? freeBytes : () => freeBytes,
    },
  });
}

function onlyEvent(): Record<string, unknown> {
  const events = listEvents(db, { limit: 1 });
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe("run.launch_refused");
  return JSON.parse(events[0].payload_json) as Record<string, unknown>;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-disk-guard-"));
  repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "relay@test");
  git(repo, "config", "user.name", "relay-test");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "base");
  process.env.RELAY_DB = join(dir, "state.db");
  prevMinFreeDisk = process.env.RELAY_MIN_FREE_DISK_BYTES;
  process.env.RELAY_MIN_FREE_DISK_BYTES = "0";
  db = openDb(process.env.RELAY_DB);
  seq = 0;
});

afterEach(() => {
  db.close();
  if (prevMinFreeDisk === undefined) delete process.env.RELAY_MIN_FREE_DISK_BYTES;
  else process.env.RELAY_MIN_FREE_DISK_BYTES = prevMinFreeDisk;
  rmSync(dir, { recursive: true, force: true });
});

describe("disk guard threshold", () => {
  test("below the floor is low_disk; at or above it passes", () => {
    const below = evaluateDiskSpace({ paths: ["/volume"], minFreeBytes: 1_000, probe: () => 999 });
    expect(below.ok).toBe(false);
    expect(below.reason).toBe("low_disk");
    expect(below.freeBytes).toBe(999);

    const equal = evaluateDiskSpace({ paths: ["/volume"], minFreeBytes: 1_000, probe: () => 1_000 });
    expect(equal.ok).toBe(true);

    const above = evaluateDiskSpace({ paths: ["/volume"], minFreeBytes: 1_000, probe: () => 1_001 });
    expect(above.ok).toBe(true);
    expect(above.freeBytes).toBe(1_001);
  });

  test("the SMALLEST measured volume decides", () => {
    const status = evaluateDiskSpace({
      paths: ["/big", "/small"],
      minFreeBytes: 1_000,
      probe: (p) => (p === "/small" ? 100 : 10_000),
    });
    expect(status.ok).toBe(false);
    expect(status.freeBytes).toBe(100);
    expect(status.probes.map((p) => p.path)).toEqual(["/big", "/small"]);
  });

  test("a probe error is probe_failed, never a pass", () => {
    const status = evaluateDiskSpace({
      paths: ["/bad", "/good"],
      minFreeBytes: 1_000,
      probe: (p) => {
        if (p === "/bad") throw new Error("df unavailable");
        return 10_000;
      },
    });
    expect(status.ok).toBe(false);
    expect(status.reason).toBe("probe_failed");
    expect(status.error).toContain("df unavailable");
    expect(status.freeBytes).toBe(10_000);
  });

  test("a zero floor disables refusal but still measures", () => {
    const status = evaluateDiskSpace({ paths: ["/volume"], minFreeBytes: 0, probe: () => 1 });
    expect(status.ok).toBe(true);
    expect(status.freeBytes).toBe(1);
  });

  test("a zero floor still fails closed when the probe itself fails", () => {
    expect(() =>
      assertLaunchDiskSpace(db, {
        taskId: "T30",
        target: "host",
        minFreeBytes: 0,
        paths: ["/volume"],
        probe: () => {
          throw new Error("statfs denied");
        },
      })
    ).toThrow(/DISK_PROBE_FAILED/);
  });

  test("formatBytes reports the threshold in GiB", () => {
    expect(formatBytes(20 * 1024 ** 3)).toBe("20.0 GiB");
  });
});

describe("refusal event + error", () => {
  test("low_disk logs run.launch_refused with the measured free space and throws", () => {
    expect(() =>
      assertLaunchDiskSpace(db, {
        taskId: "T30",
        phase: "implement",
        target: "host",
        minFreeBytes: 1_000,
        paths: ["/volume"],
        probe: () => 100,
      })
    ).toThrow(LaunchDiskError);

    const event = onlyEvent();
    expect(event.reason).toBe("low_disk");
    expect(event.freeBytes).toBe(100);
    expect(event.minFreeBytes).toBe(1_000);
    expect(event.taskId).toBe("T30");
    expect((event.message as string).startsWith(LOW_DISK)).toBe(true);

    const row = db.query(`SELECT task_id FROM events WHERE type = 'run.launch_refused'`).get() as { task_id: string };
    expect(row.task_id).toBe("T30");

    const latest = latestLaunchRefusal(db)!;
    expect(latest.taskId).toBe("T30");
    expect(latest.reason).toBe("low_disk");
    expect(latest.freeBytes).toBe(100);
  });

  test("a failed probe logs probe_failed with the error", () => {
    expect(() =>
      assertLaunchDiskSpace(db, {
        taskId: "T31",
        target: "sandbox",
        minFreeBytes: 1_000,
        paths: ["sandbox:relay-x:/var/lib/docker"],
        probe: () => {
          throw new Error("sbx exec df failed");
        },
      })
    ).toThrow(LaunchDiskError);

    const event = onlyEvent();
    expect(event.reason).toBe("probe_failed");
    expect(event.freeBytes).toBeNull();
    expect(event.error).toContain("sbx exec df failed");
    expect((event.message as string).startsWith(DISK_PROBE_FAILED)).toBe(true);
  });
});

describe("launchTaskRun", () => {
  test("below the threshold no Run/worktree is created and the Task stays queued", async () => {
    const id = newTask();
    const spawner = new FakeSpawner();
    await expect(launch(id, 100, spawner)).rejects.toBeInstanceOf(LaunchDiskError);

    expect(spawner.calls).toBe(0);
    expect(listRuns(db, { taskId: id })).toHaveLength(0);
    const task = getTask(db, id)!;
    expect(task.state).toBe("queued");
    expect(task.worktree).toBeNull();

    const latest = latestLaunchRefusal(db)!;
    expect(latest.reason).toBe("low_disk");
    expect(latest.freeBytes).toBe(100);
    expect(latest.minFreeBytes).toBe(1_000);
  });

  test("a failing probe refuses the launch and surfaces the error", async () => {
    const id = newTask();
    const spawner = new FakeSpawner();
    await expect(
      launch(id, () => {
        throw new Error("statfs: permission denied");
      }, spawner)
    ).rejects.toThrow(/DISK_PROBE_FAILED.*permission denied/);

    expect(spawner.calls).toBe(0);
    expect(listRuns(db, { taskId: id })).toHaveLength(0);
    expect(getTask(db, id)!.state).toBe("queued");
    expect(latestLaunchRefusal(db)!.reason).toBe("probe_failed");
    expect(latestLaunchRefusal(db)!.error).toContain("permission denied");
  });

  test("after space is freed the SAME queued Task launches on the next attempt", async () => {
    const id = newTask();
    const spawner = new FakeSpawner();
    let free = 100;
    const probe = () => free;

    await expect(launch(id, probe, spawner)).rejects.toBeInstanceOf(LaunchDiskError);
    expect(getTask(db, id)!.state).toBe("queued");
    expect(listRuns(db, { taskId: id })).toHaveLength(0);

    // Freed — no manual state change, no new Task: just the next launch tick.
    free = 5_000;
    const launched = await launch(id, probe, spawner);
    const run = await launched.handle.wait();

    expect(run.state).toBe("exited");
    expect(spawner.calls).toBe(1);
    expect(listRuns(db, { taskId: id })).toHaveLength(1);
    // Launching is still not a submission: the Task remains queued.
    expect(getTask(db, id)!.state).toBe("queued");
  });

  test("the RAW startDshRun entrypoint runs the same guard before a Run row exists", async () => {
    const id = newTask();
    const spawner = new FakeSpawner();
    await expect(
      startDshRun(db, {
        taskId: id,
        cwd: repo,
        outputRoot: join(dir, "runs"),
        dshBin: pinnedDshBin(),
        fastExitMs: 0,
        spawner,
        diskGuard: { minFreeBytes: 1_000, paths: [join(dir, "worktrees")], probe: () => 100 },
      })
    ).rejects.toBeInstanceOf(LaunchDiskError);

    expect(spawner.calls).toBe(0);
    expect(listRuns(db, { taskId: id })).toHaveLength(0);
    expect(getTask(db, id)!.state).toBe("queued");
    expect(latestLaunchRefusal(db)!.reason).toBe("low_disk");
  });
});
