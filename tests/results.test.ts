import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb, SQLITE_BUSY_TIMEOUT_MS } from "../src/db";
import { getTask } from "../src/tasks";
import { intakeTask } from "../src/workflow";
import {
  findTaskResult,
  insertTaskResult,
  isResultWriteError,
  RESULT_WRITE_ERROR,
  RESULT_WRITE_MAX_ATTEMPTS,
  RESULT_WRITE_RETRY_BACKOFF_MS,
} from "../src/results";

// ISH-904: result writes are IDEMPOTENT for the same (task, phase, attempt,
// kind), a deliberate `supersedes` replaces the row in place, and any real write
// failure parks the Task `blocked_internal` instead of leaving a half-applied
// phase (the overnight factory crash: UNIQUE constraint on task_results).

let dir = "";
let db: Database;
let seq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-results-"));
  process.env.RELAY_DB = join(dir, "state.db");
  db = openDb(process.env.RELAY_DB);
  seq = 0;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.RELAY_DB;
});

function codeTask() {
  return intakeTask(db, {
    provider: "test",
    issueId: `ISH-904-${seq++}`,
    codeChange: true,
    title: "result write",
  });
}

function countRows(taskId: string): number {
  return (
    db
      .query(`SELECT COUNT(*) AS n FROM task_results WHERE task_id = ?`)
      .get(taskId) as { n: number }
  ).n;
}

interface LockHolder {
  done: Promise<number>;
}

/**
 * Hold the control-plane WRITER LOCK from a second process/connection until
 * `holdMs` elapses. Resolves only after that process has actually acquired
 * `BEGIN IMMEDIATE` and printed LOCKED.
 */
async function holdWriteLock(dbPath: string, holdMs: number): Promise<LockHolder> {
  const proc = Bun.spawn({
    cmd: ["bun", join(import.meta.dir, "fixtures", "hold-write-lock.ts")],
    env: { ...process.env, HOLD_DB: dbPath, HOLD_MS: String(holdMs) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout as ReadableStream<Uint8Array>;
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (!out.includes("LOCKED")) {
    const { value, done } = await reader.read();
    if (done) {
      proc.kill();
      throw new Error(
        `write-lock fixture exited before acquiring the lock: ${await new Response(proc.stderr).text()}`
      );
    }
    out += decoder.decode(value, { stream: true });
  }
  return { done: proc.exited };
}

describe("ISH-904: structured result writes", () => {
  test("a repeated write for the same identity is idempotent (no UNIQUE crash)", () => {
    const t = codeTask();
    const first = insertTaskResult(db, {
      taskId: t.id,
      phase: "implement",
      attempt: 0,
      kind: "TaskSubmitted",
      workerId: "impl",
      headSha: "a".repeat(40),
    });
    const replay = insertTaskResult(db, {
      taskId: t.id,
      phase: "implement",
      attempt: 0,
      kind: "TaskSubmitted",
      workerId: "impl",
      headSha: "a".repeat(40),
      reason: "a resumed factory replaying the stage",
    });
    expect(replay.id).toBe(first.id);
    expect(replay.reason).toBeNull(); // the existing row is authoritative
    expect(countRows(t.id)).toBe(1);
  });

  test("a deliberate supersedes replaces the SAME row at the same attempt", () => {
    const t = codeTask();
    const ng = insertTaskResult(db, {
      taskId: t.id,
      phase: "review",
      attempt: 0,
      kind: "ReviewResult",
      workerId: "rev",
      passed: false,
      headSha: "b".repeat(40),
      profile: "default",
      reason: "NG: broken",
    });
    const replaced = insertTaskResult(db, {
      taskId: t.id,
      phase: "review",
      attempt: 0,
      kind: "ReviewResult",
      workerId: "rev",
      passed: true,
      headSha: "b".repeat(40),
      profile: "default",
      reason: "OK after the fix",
      supersedes: ng.id,
    });
    expect(replaced.id).toBe(ng.id);
    expect(replaced.passed).toBe(1);
    expect(replaced.reason).toBe("OK after the fix");
    expect(countRows(t.id)).toBe(1);
    expect(findTaskResult(db, t.id, "review", 0, "ReviewResult")!.id).toBe(ng.id);
    // The SQLite row keeps the REPLACED verdict too (not only the event log).
    const payload = JSON.parse(replaced.payload_json) as {
      superseded?: { id: number; passed: number | null; reason: string | null; worker_id: string | null };
    };
    expect(payload.superseded).toMatchObject({
      id: ng.id,
      passed: 0,
      reason: "NG: broken",
      worker_id: "rev",
    });
  });

  test("a supersedes that names a different result is refused without overwriting it", () => {
    const t = codeTask();
    const current = insertTaskResult(db, {
      taskId: t.id,
      phase: "review",
      attempt: 0,
      kind: "ReviewResult",
      workerId: "rev",
      passed: false,
      headSha: "d".repeat(40),
      profile: "default",
      reason: "the row at this identity",
    });
    const named = insertTaskResult(db, {
      taskId: t.id,
      phase: "implement",
      attempt: 0,
      kind: "TaskSubmitted",
      workerId: "impl",
      headSha: "d".repeat(40),
    });
    expect(() =>
      insertTaskResult(db, {
        taskId: t.id,
        phase: "review",
        attempt: 0,
        kind: "ReviewResult",
        workerId: "rev",
        passed: true,
        headSha: "d".repeat(40),
        profile: "default",
        reason: "should not land",
        supersedes: named.id,
      })
    ).toThrow(/refusing to replace result/);
    // The unnamed identity row is untouched, and the refusal is not a durable
    // write-failure park.
    expect(findTaskResult(db, t.id, "review", 0, "ReviewResult")!.id).toBe(current.id);
    expect(findTaskResult(db, t.id, "review", 0, "ReviewResult")!.reason).toBe("the row at this identity");
    expect(countRows(t.id)).toBe(2);
    expect(getTask(db, t.id)!.state).toBe("queued");
  });

  test("a real write failure parks the task blocked_internal with the error", () => {
    const t = codeTask();
    db.exec(
      `CREATE TRIGGER ish904_fail_result BEFORE INSERT ON task_results BEGIN SELECT RAISE(ABORT, 'task_results write boom'); END;`
    );
    let error: unknown = null;
    try {
      insertTaskResult(db, {
        taskId: t.id,
        phase: "implement",
        attempt: 0,
        kind: "TaskSubmitted",
        workerId: "impl",
        headSha: "c".repeat(40),
      });
    } catch (e) {
      error = e;
    }
    expect(isResultWriteError(error)).toBe(true);
    expect((error as Error).message).toContain(RESULT_WRITE_ERROR);
    expect((error as Error).message).toContain("task_results write boom");
    const task = getTask(db, t.id)!;
    expect(task.state).toBe("blocked_internal");
    // The phase was never half-applied.
    expect(task.phase).toBe("implement");
    expect(task.head_sha).toBeNull();
  });
});

// ISH-995: a competing writer can hold the SQLite write lock for a moment. The
// structured-result write must RETRY that transient contention (bounded) instead
// of parking the Task. Genuine write failures keep the ISH-904 fail-closed park.
describe("ISH-995: transient busy result writes", () => {
  test("control-plane connections use a bounded busy_timeout and retry budget", () => {
    const row = db.query("PRAGMA busy_timeout").get() as { timeout: number };
    expect(SQLITE_BUSY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(row.timeout).toBe(SQLITE_BUSY_TIMEOUT_MS);
    expect(RESULT_WRITE_MAX_ATTEMPTS).toBe(3);
    expect(RESULT_WRITE_RETRY_BACKOFF_MS).toBeGreaterThan(0);
  });

  test("retries a write that hits a lock held by a second connection", async () => {
    const t = codeTask();
    const path = process.env.RELAY_DB!;
    const holder = await holdWriteLock(path, 200);
    // Force the first attempt to OBSERVE SQLITE_BUSY rather than silently
    // waiting it out inside busy_timeout, so success proves a retry occurred.
    db.exec("PRAGMA busy_timeout = 0;");
    try {
      const started = Date.now();
      const row = insertTaskResult(db, {
        taskId: t.id,
        phase: "implement",
        attempt: 0,
        kind: "TaskSubmitted",
        workerId: "impl",
        headSha: "e".repeat(40),
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(RESULT_WRITE_RETRY_BACKOFF_MS);
      expect(row.id).toBeGreaterThan(0);
      expect(countRows(t.id)).toBe(1);
      expect(getTask(db, t.id)!.state).toBe("queued"); // never parked
    } finally {
      db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
      await holder.done;
    }
  });

  test("retries inside the caller's deferred transaction (no BUSY_SNAPSHOT dead end)", async () => {
    const t = codeTask();
    const path = process.env.RELAY_DB!;
    const holder = await holdWriteLock(path, 200);
    // The workflow writes results inside `db.transaction()`, which Bun starts
    // DEFERRED. The result write must be the FIRST statement so the failed
    // attempt does not pin a read snapshot; otherwise every retry would fail
    // immediately with SQLITE_BUSY_SNAPSHOT.
    db.exec("PRAGMA busy_timeout = 0;");
    try {
      const started = Date.now();
      const row = db.transaction(() =>
        insertTaskResult(db, {
          taskId: t.id,
          phase: "implement",
          attempt: 0,
          kind: "TaskSubmitted",
          workerId: "impl",
          headSha: "f".repeat(40),
        })
      )();
      expect(Date.now() - started).toBeGreaterThanOrEqual(RESULT_WRITE_RETRY_BACKOFF_MS);
      expect(row.id).toBeGreaterThan(0);
      expect(countRows(t.id)).toBe(1);
      expect(getTask(db, t.id)!.state).toBe("queued");
    } finally {
      db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
      await holder.done;
    }
  });
});
