import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { addTask, claimNext, submitTask } from "../src/tasks";
import { registerWorker } from "../src/workers";

// Regression: `relay block T152 --reason "the real explanation" --worker w` used
// to read `argv[2]`, which is the literal string "--reason", and persist THAT as
// the block reason while silently discarding the explanation. The sibling
// `relay worker retire <id> --reason <text>` takes the reason as a FLAG, so
// agents naturally mirror it and get their text thrown away. The parent-notify
// `child_blocked` then carried garbage.
//
// Same class of bug in `relay reject` and `relay note`: both read a free-text
// body from `argv[2]`, so `relay note T --worker w "real text"` stored
// "--worker". Every one of these must accept the text positionally OR via
// `--reason <text>`, in any flag order, and fail closed rather than persist a
// bare flag token.

let dir = "";
let dbPath = "";
const root = join(import.meta.dir, "..");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-block-reason-"));
  dbPath = join(dir, "state.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: root,
    env: { ...process.env, RELAY_DB: dbPath, RELAY_WORKER: "wtest" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stdout, stderr };
}

function withDb<T>(fn: (db: Database) => T): T {
  const db = openDb(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Create a task and, when asked, move it to `review` through the real path. */
function makeTask(state: "queued" | "review" = "queued"): string {
  return withDb((db) => {
    registerWorker(db, "wtest", { role: "worker" });
    const t = addTask(db, { title: "subject" });
    if (state === "review") {
      claimNext(db, "wtest");
      submitTask(db, t.id, "wtest", { evidence: "done" });
    }
    return t.id;
  });
}

function notes(taskId: string): { kind: string; body: string; worker_id: string | null }[] {
  return withDb((db) =>
    db
      .query(`SELECT kind, body, worker_id FROM task_notes WHERE task_id = ? ORDER BY id ASC`)
      .all(taskId) as never
  );
}

function taskRow(taskId: string): { state: string } {
  return withDb((db) => db.query(`SELECT state FROM tasks WHERE id = ?`).get(taskId) as { state: string });
}

describe("relay block: the reason is never a flag token", () => {
  test("--reason <text> stores the text, not the literal '--reason'", async () => {
    const id = makeTask();
    const r = await runCli(["block", id, "--reason", "the real explanation", "--worker", "wtest"]);

    expect(r.code).toBe(0);
    expect(taskRow(id).state).toBe("blocked_internal");
    const last = notes(id).at(-1)!;
    expect(last.body).toBe("the real explanation");
    expect(last.body).not.toBe("--reason");
  });

  test("a positional reason still works", async () => {
    const id = makeTask();
    const r = await runCli(["block", id, "positional reason", "--worker", "wtest"]);

    expect(r.code).toBe(0);
    expect(notes(id).at(-1)!.body).toBe("positional reason");
  });

  test("flags in any order, including --human, keep the reason intact", async () => {
    const id = makeTask();
    const r = await runCli(["block", id, "--worker", "wtest", "--human", "--reason", "needs a person"]);

    expect(r.code).toBe(0);
    expect(taskRow(id).state).toBe("blocked_human");
    expect(notes(id).at(-1)!.body).toBe("needs a person");
  });

  test("a missing reason fails closed and writes no block note", async () => {
    const id = makeTask();
    const r = await runCli(["block", id, "--reason"]);

    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("usage: relay block");
    expect(taskRow(id).state).toBe("queued");
    expect(notes(id)).toEqual([]);
  });

  test("a flag in the reason position is refused, not persisted", async () => {
    const id = makeTask();
    const r = await runCli(["block", id, "--reason", "--worker", "wtest"]);

    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/flag-like/i);
    expect(taskRow(id).state).toBe("queued");
    expect(notes(id)).toEqual([]);
  });
});

describe("relay reject: same flag/positional contract", () => {
  test("--reason <text> stores the text, not the literal '--reason'", async () => {
    const id = makeTask("review");
    const r = await runCli(["reject", id, "--reason", "review found a bug", "--worker", "wtest"]);

    expect(r.code).toBe(0);
    expect(taskRow(id).state).toBe("queued");
    expect(notes(id).at(-1)!.body).toBe("review found a bug");
  });

  test("a missing reason fails closed and writes no reject note", async () => {
    const id = makeTask("review");
    const r = await runCli(["reject", id, "--worker", "wtest"]);

    expect(r.code).not.toBe(0);
    expect(taskRow(id).state).toBe("review");
    expect(notes(id).map((n) => n.kind)).not.toContain("reject");
  });
});

describe("relay note: the body is never a flag token", () => {
  test("a flag before the body does not become the note", async () => {
    const id = makeTask();
    const r = await runCli(["note", id, "--worker", "wtest", "actual progress"]);

    expect(r.code).toBe(0);
    expect(notes(id).at(-1)!.body).toBe("actual progress");
    expect(notes(id).at(-1)!.body).not.toBe("--worker");
  });

  test("the documented form still works", async () => {
    const id = makeTask();
    const r = await runCli(["note", id, "plain progress", "--worker", "wtest"]);

    expect(r.code).toBe(0);
    expect(notes(id).at(-1)!.body).toBe("plain progress");
  });
});

describe("relay task add: the description is positional, not a flag", () => {
  test("--title before the description does not become the description", async () => {
    const r = await runCli(["task", "add", "--title", "the title", "the description"]);

    expect(r.code).toBe(0);
    const row = withDb(
      (db) => db.query(`SELECT title, description FROM tasks ORDER BY created_at DESC LIMIT 1`).get() as { title: string; description: string }
    );
    expect(row.description).toBe("the description");
    expect(row.title).toBe("the title");
    expect(row.description).not.toBe("--title");
  });
});
