import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { claimInbox, inboxFor, sendMessage } from "../src/messages";
import { registerWorker } from "../src/workers";
import { addReminder, disableReminder, dueReminders, listReminders, processReminders } from "../src/reminders";

// Standing reminders: the daemon-owned recurring nudge. These cover the four
// behaviours the feature promises — due vs not-due, interval arithmetic,
// anti-spam skip, and rm-disables.

const T0 = 1_700_000_000_000;
const MIN = 60_000;

let dir = "";
let dbPath = "";
let db: Database;

function messageRows(): { recipient: string; payload: string; state: string }[] {
  return db
    .query("SELECT recipient, payload, state FROM messages ORDER BY id")
    .all() as never;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-remind-"));
  dbPath = join(dir, "state.db");
  db = openDb(dbPath);
  registerWorker(db, "w", { role: "worker" });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, RELAY_DB: dbPath, RELAY_WORKER: "cli" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stdout, stderr };
}

describe("standing reminders — interval arithmetic (due vs not-due)", () => {
  test("add baselines last_sent_at so the first nudge is one full interval out", () => {
    const r = addReminder(db, "w", "check linear", 30 * MIN, "note", T0);
    expect(r.worker_id).toBe("w");
    expect(r.every_ms).toBe(1_800_000);
    expect(r.last_sent_at).toBe(T0);
    expect(r.enabled).toBe(1);
    expect(listReminders(db).map((x) => x.id)).toEqual([r.id]);
  });

  test("not due before the interval; due exactly at and after it", () => {
    const r = addReminder(db, "w", "check linear", 30 * MIN, "note", T0);
    expect(dueReminders(db, T0).length).toBe(0);
    expect(dueReminders(db, T0 + 1_800_000 - 1).length).toBe(0);
    expect(dueReminders(db, T0 + 1_800_000).map((x) => x.id)).toEqual([r.id]);
    expect(dueReminders(db, T0 + 1_800_000 + 5).map((x) => x.id)).toEqual([r.id]);
  });

  test("processReminders is a no-op before due and sends a durable message when due", () => {
    addReminder(db, "w", "check linear", MIN, "note", T0);
    const actions: string[] = [];
    expect(processReminders(db, actions, T0 + 1)).toBe(0);
    expect(messageRows()).toEqual([]);

    expect(processReminders(db, actions, T0 + MIN)).toBe(1);
    expect(actions).toEqual(["remind-sent:1:w"]);
    const rows = messageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient).toBe("w");
    expect(rows[0].payload).toBe("check linear");
    expect(rows[0].state).toBe("queued");
  });

  test("the interval advances from last_sent_at, not from creation", () => {
    const r = addReminder(db, "w", "nudge", MIN, "note", T0);
    expect(processReminders(db, [], T0 + MIN)).toBe(1); // last_sent_at -> T0+MIN
    expect(listReminders(db)[0].last_sent_at).toBe(T0 + MIN);
    // 30s later is inside the new interval -> not due
    expect(dueReminders(db, T0 + MIN + 30_000).length).toBe(0);
    // a full interval after the send -> due again (but blocked until acked)
    expect(listReminders(db)[0].id).toBe(r.id);
  });
});

describe("standing reminders — anti-spam", () => {
  test("unread mail blocks the next reminder and does NOT advance last_sent_at", () => {
    addReminder(db, "w", "nudge", MIN, "note", T0);
    expect(processReminders(db, [], T0 + MIN)).toBe(1); // first send
    // The recipient has NOT read the message: the next interval must not stack.
    expect(dueReminders(db, T0 + 2 * MIN).length).toBe(0);
    expect(processReminders(db, [], T0 + 2 * MIN)).toBe(0);
    expect(messageRows()).toHaveLength(1); // never a second copy
    expect(listReminders(db)[0].last_sent_at).toBe(T0 + MIN); // unchanged
  });

  test("an unread peer message also blocks a reminder (any unread mail counts)", () => {
    addReminder(db, "w", "nudge", MIN, "note", T0);
    sendMessage(db, "peer", "w", "hey");
    expect(processReminders(db, [], T0 + MIN)).toBe(0);
    expect(messageRows().map((m) => m.payload)).toEqual(["hey"]);
  });

  test("after the inbox is drained/acked the reminder re-arms", () => {
    addReminder(db, "w", "nudge", MIN, "note", T0);
    expect(processReminders(db, [], T0 + MIN)).toBe(1);
    expect(processReminders(db, [], T0 + 2 * MIN)).toBe(0); // blocked
    claimInbox(db, "w"); // recipient read + acked
    expect(processReminders(db, [], T0 + 2 * MIN)).toBe(1); // re-armed
    expect(messageRows()).toHaveLength(2);
    // still never more than one unread at a time
    expect(inboxFor(db, "w").length).toBe(1);
  });

  test("two due reminders for the SAME worker never stack in one pass", () => {
    addReminder(db, "w", "first", MIN, "note", T0);
    addReminder(db, "w", "second", MIN, "note", T0);
    expect(processReminders(db, [], T0 + MIN)).toBe(1);
    expect(messageRows()).toHaveLength(1);
  });
});

describe("standing reminders — rm disables", () => {
  test("rm sets enabled=0 (history kept), hides from list, and stops firing", () => {
    const r = addReminder(db, "w", "nudge", MIN, "note", T0);
    expect(listReminders(db).length).toBe(1);

    const disabled = disableReminder(db, r.id);
    expect(disabled.enabled).toBe(0);
    expect(listReminders(db).length).toBe(0); // hidden by default
    expect(listReminders(db, { includeDisabled: true }).length).toBe(1); // kept

    expect(dueReminders(db, T0 + 10 * MIN).length).toBe(0);
    expect(processReminders(db, [], T0 + 10 * MIN)).toBe(0);
    expect(inboxFor(db, "w")).toHaveLength(0);
  });

  test("rm of an unknown id fails closed", () => {
    expect(() => disableReminder(db, 999)).toThrow(/unknown reminder/);
  });
});

describe("relay remind CLI", () => {
  test("add -> list -> rm round trip (DB resolved from RELAY_DB, no hardcoded path)", async () => {
    const added = await runCli(["remind", "add", "w", "--every", "30m", "check linear"]);
    expect(added.code).toBe(0);
    const id = Number(/reminder #(\d+)/.exec(added.stdout)![1]);
    expect(added.stdout).toContain("every=30m");

    const listed = await runCli(["remind", "list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("check linear");
    expect(listed.stdout).toContain("every=30m");

    const rm = await runCli(["remind", "rm", String(id)]);
    expect(rm.code).toBe(0);
    expect((await runCli(["remind", "list"])).stdout).toContain("no reminders");
  });

  test("--json lists machine-readably", async () => {
    await runCli(["remind", "add", "w", "--every", "1h", "hourly"]);
    const r = await runCli(["remind", "list", "--json"]);
    const rows = JSON.parse(r.stdout) as { worker_id: string; every_ms: number; message: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ worker_id: "w", every_ms: 3_600_000, message: "hourly" });
  });

  test("a missing --every fails closed and writes no row", async () => {
    const r = await runCli(["remind", "add", "w", "no interval"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("--every is required");
    expect(listReminders(db).length).toBe(0);
  });

  test("an unknown worker fails closed", async () => {
    const r = await runCli(["remind", "add", "ghost", "--every", "30m", "hi"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("unknown worker: ghost");
  });

  test("an empty message is refused", async () => {
    const r = await runCli(["remind", "add", "w", "--every", "30m", ""]);
    expect(r.code).not.toBe(0);
    expect(listReminders(db).length).toBe(0);
  });
});
