import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { listEvents } from "../src/events";
import { HUMAN_RECIPIENT, sendMessage } from "../src/messages";
import { reconcile } from "../src/reconciler";
import { MockRuntime } from "../src/runtime/runtime";
import { registerWorker } from "../src/workers";

// The send-time wake cannot reach `human` (no such agent) and can be missed by
// any recipient, so the daemon must nudge on a durable unread backlog.

let dir = "";
let db: Database;
let rt: MockRuntime;
const savedOperator = process.env.RELAY_OPERATOR;
const savedWindow = process.env.RELAY_MAIL_NUDGE_MS;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-mail-"));
  db = openDb(join(dir, "state.db"));
  rt = new MockRuntime();
  process.env.RELAY_MAIL_NUDGE_MS = "1"; // window passes immediately
  delete process.env.RELAY_OPERATOR;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  if (savedOperator === undefined) delete process.env.RELAY_OPERATOR;
  else process.env.RELAY_OPERATOR = savedOperator;
  if (savedWindow === undefined) delete process.env.RELAY_MAIL_NUDGE_MS;
  else process.env.RELAY_MAIL_NUDGE_MS = savedWindow;
});

/** Send a message and backdate it so the nudge window has elapsed. */
function staleMessage(recipient: string, body = "hello"): number {
  const id = sendMessage(db, "control-coord", recipient, body);
  db.query(`UPDATE messages SET created_at = ? WHERE id = ?`).run(Date.now() - 60_000, id);
  return id;
}

describe("periodic unread-mail nudge", () => {
  test("`human` mail is nudged to the configured operator", async () => {
    registerWorker(db, "integrator", { role: "worker" });
    process.env.RELAY_OPERATOR = "integrator";
    staleMessage(HUMAN_RECIPIENT, "DECISION NEEDED: pick X");

    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("mail-nudged:integrator");
    expect(rt.wakes.some((w) => w.workerId === "integrator")).toBe(true);
    expect(listEvents(db, { limit: 50 }).some((e) => e.type === "worker.mail_nudged")).toBe(true);
  });

  test("no operator => `human` mail is not nudged anywhere", async () => {
    registerWorker(db, "integrator", { role: "worker" });
    staleMessage(HUMAN_RECIPIENT);
    const { actions } = await reconcile(db, rt);
    expect(actions).not.toContain("mail-nudged:integrator");
    expect(rt.wakes.some((w) => w.workerId === "integrator")).toBe(false);
  });

  test("a worker's own backlog is nudged to that worker", async () => {
    registerWorker(db, "dsl-go", { role: "dsl-go" });
    staleMessage("dsl-go");
    const { actions } = await reconcile(db, rt);
    expect(actions).toContain("mail-nudged:dsl-go");
  });

  test("the nudge is rate-limited (not repeated every tick)", async () => {
    registerWorker(db, "integrator", { role: "worker" });
    process.env.RELAY_OPERATOR = "integrator";
    staleMessage(HUMAN_RECIPIENT);

    const t0 = Date.now();
    const first = await reconcile(db, rt, t0);
    expect(first.actions).toContain("mail-nudged:integrator");
    // Same clock: the recorded nudge is inside the window, so no repeat.
    const second = await reconcile(db, rt, t0);
    expect(second.actions).not.toContain("mail-nudged:integrator");
  });
});
