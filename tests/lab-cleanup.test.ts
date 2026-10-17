import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb, now } from "../src/db";
import { logEvent } from "../src/events";
import { registerWorker } from "../src/workers";
import { intakeTask } from "../src/workflow";
import { getTask } from "../src/tasks";
import {
  applyLabCleanup,
  labOwnerId,
  LAB_OWNER_ASSIGNED_EVENT,
  planLabCleanup,
  realLabCleanupRunner,
  type LabCleanupRunner,
  type LabCleanupResult,
} from "../src/lab-cleanup";

// ISH-845: Relay's Task-owned external Network Lab cleanup. No Docker, no lab,
// no network: the single trusted hook is a FAKE runner (and, for the integration
// cases, a real executable shell script) whose argv is inspected to prove that
// only the Task's own owner id is ever handed out.

let dir: string;
let db: Database;
let seq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-ish845-"));
  process.env.RELAY_DB = join(dir, "state.db");
  db = openDb(process.env.RELAY_DB);
  registerWorker(db, "impl", { role: "worker" });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function newTask(): string {
  return intakeTask(db, {
    provider: "test",
    issueId: `ISH-845-${seq++}`,
    codeChange: true,
    title: "network lab task",
  }).id;
}

/** Record that Relay handed this Task's owner id to the sandbox (as launch does). */
function assignOwner(id: string): string {
  const owner = labOwnerId(getTask(db, id)!);
  logEvent(db, { source: "lab-cleanup", taskId: id, type: LAB_OWNER_ASSIGNED_EVENT, payload: { ownerId: owner } });
  return owner;
}

function markMerged(id: string): void {
  db.query(`UPDATE tasks SET state = 'done', phase = 'merge_ready', merged_at = ? WHERE id = ?`).run(now(), id);
}

function markCancelled(id: string): void {
  db.query(`UPDATE tasks SET state = 'cancelled' WHERE id = ?`).run(id);
}

function activeRun(id: string, state = "running"): void {
  const t = now();
  db.query(
    `INSERT INTO runs (id, task_id, phase, attempt, generation, cwd, prompt, output_dir, state, started_at, created_at, updated_at)
     VALUES ('R1', ?, 'implement', 0, 0, '/tmp/w', '', '/tmp/out', ?, ?, ?, ?)`
  ).run(id, state, t, t, t);
}

/** A fake hook: records every invocation's argv, and can fail/timeout on demand. */
class FakeHook implements LabCleanupRunner {
  calls: string[][] = [];
  constructor(private readonly result: Partial<LabCleanupResult> = {}) {}
  run(argv: string[]): LabCleanupResult {
    this.calls.push(argv);
    return { ok: true, code: 0, out: "", err: "", timedOut: false, ...this.result };
  }
}

function events(taskId: string, type: string): { payload_json: string }[] {
  return db.query(`SELECT payload_json FROM events WHERE task_id = ? AND type = ?`).all(taskId, type) as {
    payload_json: string;
  }[];
}

describe("lab cleanup hook: guard (only an ended, Lab-using Task is cleaned)", () => {
  test("no hook configured is a pure no-op — no process, no external call", () => {
    const id = newTask();
    assignOwner(id);
    markMerged(id);
    const hook = new FakeHook();
    const plan = planLabCleanup(db, id, {});
    expect(plan.cmd).toBeNull();
    expect(plan.remove).toBe(false);
    expect(plan.status).toBe("skipped");
    expect(plan.reasons.join(" ")).toContain("RELAY_LAB_CLEANUP_CMD");
    const applied = applyLabCleanup(db, id, { apply: true, runner: hook });
    expect(applied.status).toBe("skipped");
    expect(hook.calls).toHaveLength(0);
  });

  test("a Task that never had a lab owner assigned is skipped (no external call)", () => {
    const id = newTask();
    markMerged(id);
    const hook = new FakeHook();
    const plan = planLabCleanup(db, id, { cmd: "/bin/true" });
    expect(plan.remove).toBe(false);
    expect(plan.reasons.join(" ")).toContain("no lab owner assigned");
    const applied = applyLabCleanup(db, id, { apply: true, cmd: "/bin/true", runner: hook });
    expect(applied.cleaned).toBe(false);
    expect(hook.calls).toHaveLength(0);
    expect(events(id, "lab.cleaned")).toHaveLength(0);
  });

  test("owner id embeds created_at, so it is never reused across a gc/id reuse", () => {
    const a = getTask(db, newTask())!;
    expect(labOwnerId(a)).toBe(`${a.id}-${a.created_at}`);
    // Same Task id, different creation time ⇒ different owner id.
    expect(labOwnerId({ id: "T4", created_at: 100 })).not.toBe(labOwnerId({ id: "T4", created_at: 200 }));
  });

  test("reaching merge_ready alone does NOT clean the Lab", () => {
    const id = newTask();
    assignOwner(id);
    db.query(`UPDATE tasks SET phase = 'merge_ready' WHERE id = ?`).run(id); // not merged, not terminal
    const hook = new FakeHook();
    const plan = planLabCleanup(db, id, { cmd: "/bin/true" });
    expect(plan.remove).toBe(false);
    expect(plan.reasons.join(" ")).toContain("has not ended");
    const applied = applyLabCleanup(db, id, { apply: true, cmd: "/bin/true", runner: hook });
    expect(applied.cleaned).toBe(false);
    expect(applied.status).toBe("skipped");
    expect(hook.calls).toHaveLength(0);
    expect(events(id, "lab.cleaned")).toHaveLength(0);
  });

  test("an active Run refuses the cleanup even with --abort (finding 1)", () => {
    const id = newTask();
    assignOwner(id);
    markMerged(id);
    activeRun(id, "running");
    const hook = new FakeHook();
    const plan = planLabCleanup(db, id, { cmd: "/bin/true", abort: "operator" });
    expect(plan.remove).toBe(false);
    expect(plan.reasons.join(" ")).toContain("active run R1 (running)");
    const applied = applyLabCleanup(db, id, { apply: true, cmd: "/bin/true", abort: "operator", runner: hook });
    expect(applied.status).toBe("skipped");
    expect(hook.calls).toHaveLength(0);
    expect(events(id, "lab.cleaned")).toHaveLength(0);
  });

  test("a terminal-but-unmerged Task needs --abort (an open PR is refused)", () => {
    const id = newTask();
    assignOwner(id);
    markCancelled(id);
    db.query(`UPDATE tasks SET pr_url = 'https://example.invalid/pr/1' WHERE id = ?`).run(id);
    const noAbort = planLabCleanup(db, id, { cmd: "/bin/true" });
    expect(noAbort.remove).toBe(false);
    expect(noAbort.reasons.join(" ")).toContain("open PR");
    const withAbort = planLabCleanup(db, id, { cmd: "/bin/true", abort: "operator cancelled" });
    expect(withAbort.remove).toBe(true);
  });
});

describe("lab cleanup hook: trusted invocation (owner id is the only argument)", () => {
  test("merged Task runs [cmd, ownerId] exactly once and records lab.cleaned", () => {
    const id = newTask();
    const owner = assignOwner(id);
    markMerged(id);
    const hook = new FakeHook();
    const plan = applyLabCleanup(db, id, { apply: true, cmd: "/opt/relay/lab-cleanup.sh", runner: hook });
    expect(plan.status).toBe("ok");
    expect(plan.cleaned).toBe(true);
    expect(plan.ownerId).toBe(owner);
    expect(hook.calls).toEqual([["/opt/relay/lab-cleanup.sh", owner]]);
    const ev = events(id, "lab.cleaned");
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]!.payload_json)).toMatchObject({ ownerId: owner, status: "ok", exitCode: 0 });
  });

  test("an aborted cancelled Task is cleaned; the hook receives only its owner id", () => {
    const id = newTask();
    const owner = assignOwner(id);
    markCancelled(id);
    const hook = new FakeHook();
    const plan = applyLabCleanup(db, id, { apply: true, abort: "cancelled", cmd: "lab-cleanup", runner: hook });
    expect(plan.cleaned).toBe(true);
    expect(hook.calls).toEqual([["lab-cleanup", owner]]);
  });

  test("dry-run plans but never invokes the hook", () => {
    const id = newTask();
    assignOwner(id);
    markMerged(id);
    const hook = new FakeHook();
    const plan = applyLabCleanup(db, id, { cmd: "/bin/true", runner: hook });
    expect(plan.apply).toBe(false);
    expect(plan.status).toBe("dry-run");
    expect(hook.calls).toHaveLength(0);
  });
});

describe("lab cleanup hook: two-task isolation", () => {
  test("cleaning one Task never names — or touches — another Task's Lab", () => {
    const t1 = newTask();
    const t2 = newTask();
    const o1 = assignOwner(t1);
    const o2 = assignOwner(t2);
    markMerged(t1);
    markMerged(t2);
    expect(o1).not.toBe(o2);

    // A tiny model of the Lab: each owner id owns a lab, destroyed on demand.
    const labs = new Map<string, string>([
      [o1, `netlab-${o1}`],
      [o2, `netlab-${o2}`],
    ]);
    const hook: LabCleanupRunner = {
      run(argv) {
        const owner = argv[1]!;
        expect(argv).toHaveLength(2); // Relay never passes a broad/global selector
        labs.delete(owner);
        return { ok: true, code: 0, out: "", err: "", timedOut: false };
      },
    };

    const plan = applyLabCleanup(db, t1, { apply: true, cmd: "lab-cleanup", runner: hook });
    expect(plan.cleaned).toBe(true);
    expect(labs.has(o1)).toBe(false); // t1's lab gone
    expect(labs.has(o2)).toBe(true); // t2's lab intact
    expect(labs.get(o2)).toBe(`netlab-${o2}`);
  });
});

describe("lab cleanup hook: failure injection (recorded and re-runnable)", () => {
  test("a non-zero hook (auth error) is recorded as failed, never thrown, and is retryable", () => {
    const id = newTask();
    assignOwner(id);
    markMerged(id);
    const failing = new FakeHook({ ok: false, code: 4, err: "labctl: authentication failed" });
    const plan = applyLabCleanup(db, id, { apply: true, cmd: "/bin/false", runner: failing });
    expect(plan.status).toBe("failed");
    expect(plan.cleaned).toBe(false);
    expect(plan.exitCode).toBe(4);
    expect(plan.error).toContain("authentication failed");
    const ev = events(id, "lab.cleanup_failed");
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]!.payload_json)).toMatchObject({ status: "failed", exitCode: 4 });

    // Retry: the same cleanup with a working hook succeeds.
    const ok = new FakeHook();
    const retry = applyLabCleanup(db, id, { apply: true, cmd: "/bin/true", runner: ok });
    expect(retry.status).toBe("ok");
    expect(events(id, "lab.cleaned")).toHaveLength(1);
  });

  test("a timeout (cleanup interruption) is recorded as timeout", () => {
    const id = newTask();
    assignOwner(id);
    markMerged(id);
    const plan = applyLabCleanup(db, id, {
      apply: true,
      cmd: "lab-cleanup",
      timeoutMs: 300,
      runner: new FakeHook({ ok: false, code: null, err: "killed", timedOut: true }),
    });
    expect(plan.status).toBe("timeout");
    expect(plan.error).toContain("timed out");
    const ev = events(id, "lab.cleanup_failed");
    expect(JSON.parse(ev[0]!.payload_json)).toMatchObject({ status: "timeout" });
  });

  test("a missing hook executable fails closed (spawn error recorded)", () => {
    const id = newTask();
    assignOwner(id);
    markMerged(id);
    const plan = applyLabCleanup(db, id, {
      apply: true,
      cmd: join(dir, "does-not-exist.sh"),
      runner: realLabCleanupRunner,
    });
    expect(plan.status).toBe("failed");
    expect(plan.error).toBeTruthy();
    expect(events(id, "lab.cleanup_failed")).toHaveLength(1);
  });
});

describe("lab cleanup hook: real hook process", () => {
  function script(name: string, body: string): string {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  }

  test("the real runner invokes the hook with the owner id and captures a real exit code", () => {
    const id = newTask();
    const owner = assignOwner(id);
    markMerged(id);
    const record = join(dir, "argv.txt");
    const cmd = script("cleanup.sh", `printf '%s\\n' "$@" > ${record}\nexit 0`);
    const plan = applyLabCleanup(db, id, { apply: true, cmd, runner: realLabCleanupRunner });
    expect(plan.status).toBe("ok");
    expect(readFileSync(record, "utf8").trim()).toBe(owner);
  });

  test("a real hook exiting non-zero is a recorded failure, not a Relay crash", () => {
    const id = newTask();
    assignOwner(id);
    markMerged(id);
    const cmd = script("boom.sh", `echo 'labctl: API error' >&2\nexit 5`);
    const plan = applyLabCleanup(db, id, { apply: true, cmd, runner: realLabCleanupRunner });
    expect(plan.status).toBe("failed");
    expect(plan.exitCode).toBe(5);
    expect(plan.error).toContain("API error");
  });

  test("a real hook that hangs is killed at the timeout", () => {
    const id = newTask();
    assignOwner(id);
    markMerged(id);
    const cmd = script("hang.sh", `sleep 30`);
    const plan = applyLabCleanup(db, id, { apply: true, cmd, timeoutMs: 400, runner: realLabCleanupRunner });
    expect(plan.status).toBe("timeout");
  });
});
