import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { addNote, addTask, blockTask, claimNext, submitTask, unblockTask } from "../src/tasks";
import { registerWorker } from "../src/workers";

// Regression: on T151 a reviewer wrote a free-form `task_notes` row whose body
// was an explicit "APPROVE" verdict but never issued a state transition. The
// task stayed `queued` with no owner, so it looked unclaimed/unreviewed in
// `relay status`. The task was effectively stuck and nothing surfaced the
// mismatch.
//
// Chosen fix (minimal, safe, read-only): `relay status` warns when a note
// claims APPROVE while the task is not terminal. We deliberately do NOT widen
// `relay approve` to accept queued/running tasks: approving an unowned queued
// task would let a single call mark unreviewed work done, bypassing review.
//
// The second half covers the follow-on: `unblock` clears the owner/lease (a
// queued task must be unowned), so a later `submit` gets STALE_LEASE. The error
// now says what to do (re-claim) instead of just naming the absent owner.

let dir = "";
let dbPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-approve-"));
  dbPath = join(dir, "state.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function withDb<T>(fn: (db: Database) => T): T {
  const db = openDb(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function status(): string {
  const r = Bun.spawnSync(["bun", "src/cli.ts", "status"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, FORCE_COLOR: "0", RELAY_DB: dbPath, RELAY_WORKER: "wtest" },
  });
  expect(r.exitCode).toBe(0);
  return r.stdout.toString();
}

describe("relay status: an approve written as a note is surfaced", () => {
  test("a queued task with an APPROVE note warns that it was never transitioned", () => {
    const id = withDb((db) => {
      registerWorker(db, "wtest", { role: "worker" });
      const t = addTask(db, { title: "looks approved" });
      addNote(db, t.id, "reviewer", "APPROVE", "note");
      return t.id;
    });

    const out = status();
    expect(out).toContain("Attention");
    expect(out).toContain(`${id}`);
    expect(out).toContain("note claims APPROVE");
  });

  test("a done task with the same note is not warned", () => {
    withDb((db) => {
      registerWorker(db, "wtest", { role: "worker" });
      registerWorker(db, "reviewer", { role: "reviewer" });
      const t = addTask(db, { title: "really approved" });
      claimNext(db, "wtest");
      submitTask(db, t.id, "wtest", { evidence: "done" });
      addNote(db, t.id, "reviewer", "APPROVE", "note");
      db.query(`UPDATE tasks SET state = 'done' WHERE id = ?`).run(t.id);
      return t.id;
    });

    const out = status();
    expect(out).not.toContain("note claims APPROVE");
  });

  test("a note that merely mentions the word approve is not a verdict", () => {
    withDb((db) => {
      registerWorker(db, "wtest", { role: "worker" });
      const t = addTask(db, { title: "prose, not a verdict" });
      addNote(db, t.id, "wtest", "I cannot approve this until the tests pass", "note");
    });

    expect(status()).not.toContain("note claims APPROVE");
  });
});

describe("STALE_LEASE after unblock tells the caller to re-claim", () => {
  test("submitting an unowned queued task names the recovery step", () => {
    const id = withDb((db) => {
      registerWorker(db, "wtest", { role: "worker" });
      const t = addTask(db, { title: "back in the queue" });
      claimNext(db, "wtest");
      blockTask(db, t.id, "wtest", "temporarily stuck", false);
      unblockTask(db, t.id, "wtest"); // clears assignee/lease -> queued, unowned
      return t.id;
    });

    let message = "";
    try {
      withDb((db) => submitTask(db, id, "wtest"));
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("STALE_LEASE");
    expect(message).toContain(id);
    expect(message).toMatch(/claim/i);
  });
});
