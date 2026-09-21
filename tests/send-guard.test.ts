import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { registerWorker } from "../src/workers";

// Regression: `relay send <recipient> --worker <id> "body"` used to persist a
// durable message whose payload was the literal string "--worker", while the
// real body was silently dropped. The recipient is positional (argv[1]) and the
// body is argv[2], so a flag in the body slot became the message.
//
// Four such rows were created by the cli itself in nv-papers and each one woke
// a worker for an empty body, so the guard must reject the call BEFORE a row is
// written.

let dir = "";
let dbPath = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-send-"));
  dbPath = join(dir, "state.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function runSend(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "src/cli.ts", "send", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, RELAY_DB: dbPath, RELAY_WORKER: "cli" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stdout, stderr };
}

function messageRows(): { recipient: string; payload: string }[] {
  const db = openDb(dbPath);
  try {
    return db.query("SELECT recipient, payload FROM messages ORDER BY id").all() as never;
  } finally {
    db.close();
  }
}

describe("relay send guard", () => {
  test("a flag-like body is rejected and no message row is created", async () => {
    const db = openDb(dbPath);
    registerWorker(db, "wtest", { role: "worker" });
    db.close();

    const r = await runSend(["wtest", "--worker", "wtest", "REAL MESSAGE"]);

    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("flag-like body");
    expect(messageRows()).toEqual([]);
  });

  test("an empty body is rejected and no message row is created", async () => {
    const db = openDb(dbPath);
    registerWorker(db, "wtest", { role: "worker" });
    db.close();

    const r = await runSend(["wtest", ""]);

    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("empty message");
    expect(messageRows()).toEqual([]);
  });

  test("a whitespace-only body is rejected too", async () => {
    const db = openDb(dbPath);
    registerWorker(db, "wtest", { role: "worker" });
    db.close();

    const r = await runSend(["wtest", "   "]);

    expect(r.code).not.toBe(0);
    expect(messageRows()).toEqual([]);
  });

  test("a flag in the recipient slot is named in the error", async () => {
    const r = await runSend(["--worker", "wtest", "hello"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("RECIPIENT first");
    expect(messageRows()).toEqual([]);
  });

  test("the documented form still works: message then options", async () => {
    const db = openDb(dbPath);
    registerWorker(db, "wtest", { role: "worker" });
    db.close();

    const r = await runSend(["wtest", "T1 is ready for review", "--task", "T1", "--kind", "note"]);

    expect(r.code).toBe(0);
    const rows = messageRows();
    expect(rows.length).toBe(1);
    expect(rows[0].payload).toBe("T1 is ready for review");
  });

  test("a body that merely contains a dash is allowed", async () => {
    const db = openDb(dbPath);
    registerWorker(db, "wtest", { role: "worker" });
    db.close();

    const r = await runSend(["wtest", "T1 - done, see -- notes"]);

    expect(r.code).toBe(0);
    expect(messageRows()[0].payload).toBe("T1 - done, see -- notes");
  });
});
