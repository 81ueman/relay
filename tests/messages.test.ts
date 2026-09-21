import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import * as messages from "../src/messages";
import { ackMessage, claimInbox, inboxFor, sendMessage, unreadCounts } from "../src/messages";

// Durable peer-to-peer messaging. There is NO human/operator special mailbox:
// every message is addressed to an ordinary worker id.

let dir = "";
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-msg-"));
  db = openDb(join(dir, "state.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("peer-to-peer durable messages", () => {
  test("send -> inbox -> ack round trip", () => {
    const id = sendMessage(db, "worker-a", "worker-b", "benchmark results", { taskId: "T1", kind: "note" });
    const items = inboxFor(db, "worker-b");
    expect(items).toHaveLength(1);
    expect(items[0].payload).toBe("benchmark results");
    expect(items[0].task_id).toBe("T1");
    expect(items[0].state).toBe("delivered"); // reading marks delivered
    const ack = ackMessage(db, id, "worker-b");
    expect(ack.state).toBe("acked");
    expect(inboxFor(db, "worker-b")).toHaveLength(0);
  });

  test("a message is private to its recipient", () => {
    sendMessage(db, "a", "b", "hi");
    expect(inboxFor(db, "c")).toHaveLength(0);
    const id = inboxFor(db, "b")[0].id;
    expect(() => ackMessage(db, id, "c")).toThrow(/belongs to b/);
  });

  test("claimInbox drains the recipient's pending mail", () => {
    sendMessage(db, "a", "b", "one");
    sendMessage(db, "a", "b", "two");
    expect(claimInbox(db, "b")).toBe(2);
    expect(inboxFor(db, "b")).toHaveLength(0);
  });

  test("unreadCounts reports queued vs delivered per recipient", () => {
    sendMessage(db, "a", "b", "one");
    sendMessage(db, "a", "b", "two");
    sendMessage(db, "a", "c", "three");
    inboxFor(db, "b"); // delivered
    const counts = unreadCounts(db);
    expect(counts.find((x) => x.recipient === "b")!.delivered).toBe(2);
    expect(counts.find((x) => x.recipient === "c")!.queued).toBe(1);
  });

  test("no human/operator special mailbox exists", () => {
    expect("HUMAN_RECIPIENT" in messages).toBe(false);
    expect("operators" in messages).toBe(false);
    expect("operatorId" in messages).toBe(false);
    expect("mailboxesFor" in messages).toBe(false);
  });
});
