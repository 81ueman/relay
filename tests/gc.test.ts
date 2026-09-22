import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { applyGc, planGc, runGc } from "../src/gc";
import { listEvents } from "../src/events";
import { sendMessage } from "../src/messages";
import { recordRuntime } from "../src/runtimes";
import {
  addNote,
  addTask,
  approveTask,
  claimTask,
  setTaskDependencies,
  submitTask,
  taskDependencies,
} from "../src/tasks";
import { getWorker, registerWorker, retireWorker } from "../src/workers";

// T226: there was no supported purge — fleet cleanup needed raw SQL. `relay gc`
// is dry-run by default, refuses non-retired workers / non-terminal tasks, and
// leaves events/messages/task_notes alone unless --with-history.

let dir = "";
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-gc-"));
  db = openDb(join(dir, "state.db"));
  registerWorker(db, "w", { role: "worker" });
  registerWorker(db, "rev", { role: "reviewer" });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function n(table: string): number {
  return (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Drive a task queued -> running -> review -> done. */
function finish(id: string): void {
  claimTask(db, id, "w");
  submitTask(db, id, "w");
  approveTask(db, id, "rev");
}

describe("planGc is dry-run and only targets history", () => {
  test("planning deletes NOTHING and excludes live workers / queued tasks", () => {
    const done = addTask(db, { title: "finished" });
    finish(done.id);
    const open = addTask(db, { title: "still open" });
    registerWorker(db, "live", { role: "worker" });
    registerWorker(db, "dead", { role: "worker" });
    retireWorker(db, "dead", "dup");

    const before = { workers: n("workers"), tasks: n("tasks") };
    const plan = planGc(db);
    expect(plan.workers).toContain("dead");
    expect(plan.workers).not.toContain("live");
    expect(plan.tasks).toContain(done.id);
    expect(plan.tasks).not.toContain(open.id);
    expect(plan.applied).toBe(false);
    // Dry-run wrote nothing.
    expect(n("workers")).toBe(before.workers);
    expect(n("tasks")).toBe(before.tasks);
  });

  test("a non-terminal task is never eligible, even with a hand-built plan", () => {
    const open = addTask(db, { title: "open" });
    const plan = { ...planGc(db), tasks: [open.id] };
    applyGc(db, plan);
    // The DELETE guard refuses a non-terminal task.
    expect(n("tasks")).toBe(1);
  });
});

describe("applyGc purges only safe history", () => {
  test("retired worker + done task + terminal runtime + unmanaged session go; live stay", () => {
    registerWorker(db, "gone", { role: "worker" });
    retireWorker(db, "gone", "old");
    const done = addTask(db, { title: "done" });
    finish(done.id);
    const open = addTask(db, { title: "open" });

    // A terminal runtime and an unmanaged session (history).
    recordRuntime(db, { workerId: "gone", generation: 1, runtimeId: "gone-1", state: "stale" });
    db.query(
      `INSERT INTO sessions (session_id, managed, worker_id, role, generation, updated_at)
       VALUES ('ses_hist', 0, 'gone', 'worker', 1, 1)`
    ).run();

    const beforeWorkers = n("workers");
    const plan = runGc(db, { apply: true });

    expect(plan.applied).toBe(true);
    expect(plan.workers).toContain("gone");
    expect(plan.tasks).toContain(done.id);
    expect(plan.sessions).toContain("ses_hist");
    expect(plan.runtimes).toHaveLength(1);
    expect(getWorker(db, "gone")).toBeNull();
    expect(n("tasks")).toBe(1); // only `open` survives
    expect(n("workers")).toBe(beforeWorkers - 1);
    expect(n("sessions")).toBe(0);
    expect(n("worker_runtimes")).toBe(0);
    expect(listEvents(db, { limit: 100 }).some((e) => e.type === "gc.applied")).toBe(true);
  });

  test("a done task a queued task still depends on is SKIPPED (never stranded)", () => {
    const input = addTask(db, { title: "input" });
    finish(input.id);
    const gated = addTask(db, { title: "gated", dependsOn: [input.id] });

    const plan = planGc(db);
    expect(plan.tasks).not.toContain(input.id);
    expect(plan.skipped.some((s) => s.id === input.id && /required by/.test(s.reason))).toBe(true);

    runGc(db, { apply: true });
    // The prerequisite survives and the gate still resolves.
    expect(taskDependencies(db, gated.id)).toEqual([input.id]);
  });

  test("a done task with a non-terminal child is SKIPPED", () => {
    const parent = addTask(db, { title: "parent" });
    finish(parent.id);
    addTask(db, { title: "child", parentTaskId: parent.id });

    const plan = planGc(db);
    expect(plan.tasks).not.toContain(parent.id);
    expect(plan.skipped.some((s) => s.id === parent.id && /non-terminal child/.test(s.reason))).toBe(true);
  });

  test("--older-than skips rows inside the grace window", () => {
    registerWorker(db, "gone", { role: "worker" });
    retireWorker(db, "gone", "old");
    const plan = planGc(db, { olderThanMs: 60_000 });
    expect(plan.workers).toHaveLength(0);
    expect(plan.skipped.some((s) => s.id === "gone" && /grace/.test(s.reason))).toBe(true);
  });
});

describe("history is opt-in", () => {
  test("without --with-history events/messages/task_notes survive the purge", () => {
    registerWorker(db, "gone", { role: "worker" });
    const t = addTask(db, { title: "done" });
    finish(t.id);
    addNote(db, t.id, "w", "a note");
    const msg = sendMessage(db, "gone", "w", "hi", { taskId: t.id });
    retireWorker(db, "gone", "old");

    const eventsBefore = listEvents(db, { limit: 1000 }).length;
    expect(eventsBefore).toBeGreaterThan(0);
    const notesBefore = n("task_notes");
    const msgsBefore = n("messages");

    runGc(db, { apply: true });

    // tasks/workers gone, but their history is untouched.
    expect(n("task_notes")).toBe(notesBefore);
    expect(n("messages")).toBe(msgsBefore);
    expect(listEvents(db, { limit: 1000 }).length).toBeGreaterThanOrEqual(eventsBefore);
    expect(msg).toBeDefined();
  });

  test("with --with-history the purged rows' history is removed (targeted)", () => {
    registerWorker(db, "gone", { role: "worker" });
    registerWorker(db, "keep", { role: "worker" });
    const t = addTask(db, { title: "done" });
    finish(t.id);
    addNote(db, t.id, "w", "a note");
    sendMessage(db, "gone", "keep", "bye", { taskId: t.id });
    const keepTask = addTask(db, { title: "keep me" });
    addNote(db, keepTask.id, "keep", "keep note");
    retireWorker(db, "gone", "old");

    const plan = planGc(db, { withHistory: true });
    expect(plan.history.task_notes).toBeGreaterThan(0);
    runGc(db, { apply: true, withHistory: true });

    // Purged task's note is gone; the surviving task's note stays.
    const notes = db.query(`SELECT task_id FROM task_notes`).all() as { task_id: string }[];
    expect(notes.some((x) => x.task_id === t.id)).toBe(false);
    expect(notes.some((x) => x.task_id === keepTask.id)).toBe(true);
    // Messages touching the purged worker are gone.
    const msgs = db.query(`SELECT sender, recipient FROM messages`).all() as { sender: string; recipient: string }[];
    expect(msgs.some((m) => m.sender === "gone" || m.recipient === "gone")).toBe(false);
    // Events for the purged worker/task are gone.
    expect(listEvents(db, { limit: 1000 }).some((e) => e.worker_id === "gone" || e.task_id === t.id)).toBe(false);
    expect(listEvents(db, { limit: 1000 }).some((e) => e.type === "gc.applied")).toBe(true);
  });
});
