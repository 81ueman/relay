import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { pollWorker } from "../src/reconciler";
import { MockRuntime, type HerdrIdentity } from "../src/runtime/runtime";
import { handleSocketMessage, type SocketContext } from "../src/socket";
import { attachSession } from "../src/sessions";
import { getWorker, registerWorker } from "../src/workers";

// T-HARNESS: Claude Code is POLLED via Herdr (like codex) and its session id is
// a bare UUID, so it must be attached with an explicit `--kind claude`.

const CLAUDE_UUID = "9030b285-ce54-4dbb-9b71-1719916a80d3";

let dir = "";
let db: Database;
let rt: MockRuntime;
let ctx: SocketContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-kinds-"));
  process.env.RELAY_LEASE_MS = "120000";
  process.env.RELAY_STALL_MS = "60000";
  process.env.RELAY_WAKE_COOLDOWN_MS = "0";
  delete process.env.RELAY_AUTO_APPROVE;
  db = openDb(join(dir, "state.db"));
  rt = new MockRuntime();
  ctx = { db, runtime: rt, wakeReconcile: { value: false } };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const claudeIdentity: HerdrIdentity = {
  agent: "claude-1", tabId: "w6D:t5", paneId: "w6D:p8", workspaceId: "w6D", agentKind: "claude",
};

describe("claude is a polled harness", () => {
  test("socket attach: a claude UUID needs an explicit kind; it records agent_kind=claude", async () => {
    rt.setIdentity(CLAUDE_UUID, claudeIdentity);
    // Undeclared UUID: refused (ambiguous with codex).
    let res = await handleSocketMessage({ type: "session.attach", session_id: CLAUDE_UUID }, ctx);
    expect(res).toMatchObject({ ok: false, reason: "not-a-session-id" });
    // Declared claude: accepted.
    res = await handleSocketMessage(
      { type: "session.attach", session_id: CLAUDE_UUID, kind: "claude", worker_id: "claude-1", role: "worker" },
      ctx
    );
    expect(res).toMatchObject({ ok: true, worker_id: "claude-1", managed: true });
    expect(getWorker(db, "claude-1")!.agent_kind).toBe("claude");
  });

  test("claude liveness/idle is polled exactly like codex", async () => {
    registerWorker(db, "claude-1", { role: "worker", agentKind: "claude", runtimeId: "w6D:p8" });
    attachSession(db, CLAUDE_UUID, { role: "worker", workerId: "claude-1", agentKind: "claude", identity: claudeIdentity });
    rt.setAgentStatus("claude-1", "working");
    expect(await pollWorker(db, rt, "claude-1")).toBe("working");
    rt.setAgentStatus("claude-1", "blocked");
    expect(await pollWorker(db, rt, "claude-1")).toBe("blocked");
    expect(getWorker(db, "claude-1")!.state).toBe("waiting_input");
    rt.setAgentStatus("claude-1", "dead");
    expect(await pollWorker(db, rt, "claude-1")).toBe("dead");
    expect(getWorker(db, "claude-1")!.state).toBe("dead");
  });
});
