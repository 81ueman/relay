import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import {
  ackMessage,
  claimInbox,
  HUMAN_RECIPIENT,
  inboxFor,
  mailboxesFor,
  operatorId,
  sendMessage,
  unreadCounts,
} from "../src/messages";

// `human` is the operator's mailbox, not a Herdr agent. It must be routable to a
// configured operator instead of a wake that can never succeed.

let dir = "";
let db: Database;
const savedOperator = process.env.RELAY_OPERATOR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-msg-"));
  db = openDb(join(dir, "state.db"));
  delete process.env.RELAY_OPERATOR;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  if (savedOperator === undefined) delete process.env.RELAY_OPERATOR;
  else process.env.RELAY_OPERATOR = savedOperator;
});

describe("operator alias for `human` mail", () => {
  test("operatorId prefers RELAY_OPERATOR, then .relay/operator", () => {
    expect(operatorId(dir)).toBeNull();
    mkdirSync(join(dir, ".relay"), { recursive: true });
    writeFileSync(join(dir, ".relay", "operator"), "integrator\n");
    expect(operatorId(dir)).toBe("integrator");
    process.env.RELAY_OPERATOR = "from-env";
    expect(operatorId(dir)).toBe("from-env");
  });

  test("only the operator fields `human` mail", () => {
    expect(mailboxesFor("integrator", "integrator")).toEqual(["integrator", HUMAN_RECIPIENT]);
    expect(mailboxesFor("dsl-go", "integrator")).toEqual(["dsl-go"]);
    expect(mailboxesFor("integrator", null)).toEqual(["integrator"]);
  });

  test("the operator sees and acks `human`-addressed mail", () => {
    sendMessage(db, "control-coord", HUMAN_RECIPIENT, "DECISION NEEDED: X");
    const items = inboxFor(db, "integrator", false, [HUMAN_RECIPIENT]);
    expect(items.map((m) => m.recipient)).toEqual([HUMAN_RECIPIENT]);
    const ack = ackMessage(db, items[0].id, "integrator", "integrator");
    expect(ack.state).toBe("acked");
  });

  test("a non-operator cannot ack `human` mail", () => {
    const id = sendMessage(db, "control-coord", HUMAN_RECIPIENT, "DECISION NEEDED: X");
    expect(() => ackMessage(db, id, "dsl-go", "integrator")).toThrow(/belongs to human/);
  });

  test("claimInbox drains the operator's extra mailbox", () => {
    sendMessage(db, "a", HUMAN_RECIPIENT, "one");
    sendMessage(db, "b", "integrator", "two");
    expect(claimInbox(db, "integrator", [HUMAN_RECIPIENT])).toBe(2);
    expect(inboxFor(db, "integrator", false, [HUMAN_RECIPIENT])).toEqual([]);
  });

  test("unreadCounts reports queued vs delivered per recipient", () => {
    sendMessage(db, "a", HUMAN_RECIPIENT, "one");
    sendMessage(db, "a", HUMAN_RECIPIENT, "two");
    sendMessage(db, "b", "dsl-go", "three");
    inboxFor(db, "integrator", false, [HUMAN_RECIPIENT]); // marks human mail delivered
    const counts = unreadCounts(db);
    const human = counts.find((c) => c.recipient === HUMAN_RECIPIENT)!;
    expect(human.queued).toBe(0);
    expect(human.delivered).toBe(2);
    const dsl = counts.find((c) => c.recipient === "dsl-go")!;
    expect(dsl.queued).toBe(1);
  });
});
