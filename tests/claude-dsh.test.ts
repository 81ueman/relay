import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { pollWorker } from "../src/reconciler";
import { MockRuntime, type HerdrIdentity } from "../src/runtime/runtime";
import { handleSocketMessage, type SocketContext } from "../src/socket";
import { attachSession, getSession } from "../src/sessions";
import { getWorker, registerWorker } from "../src/workers";

// T-HARNESS: claude and dsh are the two harnesses added on top of the registry.
// Claude Code is POLLED via Herdr (like codex); dsh is EVENT-driven and is
// recognized by its `session-<uuid>` id shape without a declared kind.

const CLAUDE_UUID = "9030b285-ce54-4dbb-9b71-1719916a80d3";
const DSH_SESSION = "session-23274032-a2fc-4be5-9803-07cfeea34058";

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
const dshIdentity: HerdrIdentity = {
  agent: "dsh", tabId: "w6D:t9", paneId: "w6D:p9", workspaceId: "w6D", agentKind: "dsh",
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

describe("dsh is an event-driven harness recognized by id shape", () => {
  test("socket attach: a `session-<uuid>` id is accepted without a declared kind", async () => {
    rt.setIdentity(DSH_SESSION, dshIdentity);
    const res = await handleSocketMessage(
      { type: "session.attach", session_id: DSH_SESSION, worker_id: "dsh-1", role: "worker" },
      ctx
    );
    expect(res).toMatchObject({ ok: true, worker_id: "dsh-1", managed: true });
    const w = getWorker(db, "dsh-1")!;
    expect(w.agent_kind).toBe("dsh");
    expect(w.opencode_session_id).toBe(DSH_SESSION);
    expect(getSession(db, DSH_SESSION)!.managed).toBe(1);
  });

  test("a dsh worker is never polled (event stream drives it)", async () => {
    registerWorker(db, "dsh-1", { role: "worker", agentKind: "dsh", runtimeId: "w6D:p9" });
    attachSession(db, DSH_SESSION, { role: "worker", workerId: "dsh-1", agentKind: "dsh", identity: dshIdentity });
    rt.setAgentStatus("dsh-1", "working");
    expect(await pollWorker(db, rt, "dsh-1")).toBe("not-polled");
  });
});
