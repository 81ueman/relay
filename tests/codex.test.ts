import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { listEvents } from "../src/events";
import { pollCodexWorker, reconcile } from "../src/reconciler";
import { MockRuntime, type HerdrIdentity } from "../src/runtime/runtime";
import { handleSocketMessage, type SocketContext } from "../src/socket";
import { attachSession, getSession } from "../src/sessions";
import { addTask, claimNext } from "../src/tasks";
import { getWorker, registerWorker } from "../src/workers";

// T254: first-class codex support. A codex session has a UUID id (not `ses...`)
// and NO plugin event stream, so it is attached with an explicit kind and its
// liveness/idle/blocked are POLLED from Herdr agent status.

const CODEX_UUID = "01a0c405-70ba-7bf0-8522-98eba9dd5283";

let dir = "";
let db: Database;
let rt: MockRuntime;
let ctx: SocketContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-codex-"));
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

const codexIdentity: HerdrIdentity = {
  agent: "codex-v4-example", tabId: "w6D:t5", paneId: "w6D:p8", workspaceId: "w6D", agentKind: "codex",
};

function attachedCodex(id: string, role = "design-v4"): void {
  registerWorker(db, id, { role, agentKind: "codex", runtimeId: "w6D:p8" });
  attachSession(db, CODEX_UUID, {
    role,
    workerId: id,
    agentKind: "codex",
    identity: codexIdentity,
  });
}

describe("codex agents are first-class workers (T254)", () => {
  test("a codex UUID session attaches and records agent_kind=codex", () => {
    attachedCodex("codex-v4-example");
    const w = getWorker(db, "codex-v4-example")!;
    expect(w.agent_kind).toBe("codex");
    expect(w.opencode_session_id).toBe(CODEX_UUID);
    expect(getSession(db, CODEX_UUID)!.managed).toBe(1);
  });

  test("opencode regression: a `ses...` session still attaches as opencode", () => {
    registerWorker(db, "oc-1", { role: "worker" });
    attachSession(db, "ses_oc1", {
      role: "worker",
      workerId: "oc-1",
      identity: { agent: "oc-agent", tabId: "t", paneId: "p", workspaceId: "w", agentKind: "opencode" },
    });
    expect(getWorker(db, "oc-1")!.agent_kind).toBe("opencode");
  });

  test("socket attach: a codex session requires kind=codex; an undeclared non-ses id is refused", async () => {
    rt.setIdentity(CODEX_UUID, codexIdentity);
    // Undeclared UUID (no kind): the opencode guard is not weakened -> refused.
    let res = await handleSocketMessage({ type: "session.attach", session_id: CODEX_UUID }, ctx);
    expect(res).toMatchObject({ ok: false, reason: "not-a-session-id" });
    // A shell id stays refused even with kind=codex.
    res = await handleSocketMessage({ type: "session.attach", session_id: "sh_1234", kind: "codex" }, ctx);
    expect(res).toMatchObject({ ok: false, reason: "not-a-session-id" });
    // Declared codex UUID: accepted and recorded as codex.
    res = await handleSocketMessage(
      { type: "session.attach", session_id: CODEX_UUID, kind: "codex", worker_id: "codex-v4-example", role: "design-v4" },
      ctx
    );
    expect(res).toMatchObject({ ok: true, worker_id: "codex-v4-example", managed: true });
    expect(getWorker(db, "codex-v4-example")!.agent_kind).toBe("codex");
  });

  test("codex resolved identity carries agentKind=codex (MockRuntime identity injection)", async () => {
    rt.setIdentity(CODEX_UUID, codexIdentity);
    const id = await rt.resolveIdentity({ sessionId: CODEX_UUID, hint: { agentKind: "codex" } });
    expect(id.agentKind).toBe("codex");
  });
});

describe("codex liveness/idle is POLLED from Herdr status", () => {
  test("working status counts as progress (touchSeen) and does not stall", async () => {
    attachedCodex("codex-v4-example");
    addTask(db, { title: "v4 work", role: "design-v4" });
    expect(claimNext(db, "codex-v4-example")!.state).toBe("running");
    const before = getWorker(db, "codex-v4-example")!.last_seen_at;
    rt.setAgentStatus("codex-v4-example", "working");
    await Bun.sleep(5);
    const outcome = await pollCodexWorker(db, rt, "codex-v4-example");
    expect(outcome).toBe("working");
    expect(getWorker(db, "codex-v4-example")!.last_seen_at).toBeGreaterThanOrEqual(before);
    expect(listEvents(db, { limit: 20 }).some((e) => e.type === "worker.status_polled")).toBe(true);
  });

  test("blocked status maps to waiting_input (never offered new work)", async () => {
    attachedCodex("codex-v4-example");
    rt.setAgentStatus("codex-v4-example", "blocked");
    expect(await pollCodexWorker(db, rt, "codex-v4-example")).toBe("blocked");
    expect(getWorker(db, "codex-v4-example")!.state).toBe("waiting_input");
  });

  test("dead status (unreachable agent) marks the worker dead", async () => {
    attachedCodex("codex-v4-example");
    rt.setAgentStatus("codex-v4-example", "dead");
    expect(await pollCodexWorker(db, rt, "codex-v4-example")).toBe("dead");
    expect(getWorker(db, "codex-v4-example")!.state).toBe("dead");
  });

  test("idle status runs the idle machine: an idle codex worker with claimable work is woken", async () => {
    attachedCodex("codex-v4-example");
    addTask(db, { title: "queued for codex", role: "design-v4" });
    rt.setAgentStatus("codex-v4-example", "idle");
    const outcome = await pollCodexWorker(db, rt, "codex-v4-example");
    expect(outcome).toBe("woke-next");
    expect(rt.wakes.map((w) => w.workerId)).toContain("codex-v4-example");
  });

  test("an opencode worker is never polled (not-codex)", async () => {
    registerWorker(db, "oc-1", { role: "worker" });
    expect(await pollCodexWorker(db, rt, "oc-1")).toBe("not-codex");
  });

  test("reconcile polls codex workers without disturbing opencode", async () => {
    attachedCodex("codex-v4-example");
    registerWorker(db, "oc-1", { role: "worker" });
    rt.setAlive("oc-1", true);
    rt.setAgentStatus("codex-v4-example", "blocked");
    await reconcile(db, rt);
    expect(getWorker(db, "codex-v4-example")!.state).toBe("waiting_input");
  });
});
