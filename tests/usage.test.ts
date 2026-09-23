import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { handleSocketMessage, type SocketContext } from "../src/socket";
import { MockRuntime } from "../src/runtime/runtime";
import { addTask, claimNext } from "../src/tasks";
import { attachSession, getSession } from "../src/sessions";
import { recordRuntime } from "../src/runtimes";
import { registerWorker } from "../src/workers";
import { usageReport, usageTotals } from "../src/usage";
import { compactionStatusOf, contextUsedTokens, sessionUsageOf } from "../.opencode/plugins/relay";

// Cost/token + compaction observability (T551 #8).
//
// Invariants:
//   - the FIRST cumulative reading for a session is a BASELINE (no sample): an
//     adopted mid-life session must not dump its history onto the current task;
//   - every later reading records the DELTA, attributed to the worker's CURRENT
//     task at that moment;
//   - compaction counts exactly once whether the host sends started+ended,
//     ended alone, or the durable session.compacted;
//   - usage events are telemetry: fenced-out sessions never write.

let dir = "";
let db: Database;
let rt: MockRuntime;
let ctx: SocketContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-usage-"));
  process.env.RELAY_DB = join(dir, "state.db");
  db = openDb(process.env.RELAY_DB);
  rt = new MockRuntime();
  ctx = { db, runtime: rt, wakeReconcile: { value: false } };
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.RELAY_DB;
});

function seedSpawned(id: string, generation: number): void {
  registerWorker(db, id, { role: "worker" });
  const token = `seed-${id}-g${generation}`;
  recordRuntime(db, {
    workerId: id,
    generation,
    runtimeId: `rt-${id}-g${generation}`,
    tabId: `tab-${id}-g${generation}`,
    state: "starting",
    relayOwned: 1,
    attachToken: token,
  });
  attachSession(db, `ses_${id}`, { workerId: id, role: "worker", generation, attachToken: token });
  rt.setAlive(id, true);
}

async function sendUsage(id: string, payload: unknown, generation?: number): Promise<Record<string, unknown>> {
  return handleSocketMessage(
    {
      type: "session.usage",
      session_id: `ses_${id}`,
      ...(generation !== undefined ? { generation } : {}),
      payload,
    },
    ctx
  );
}

async function sendCompaction(id: string, payload: unknown): Promise<Record<string, unknown>> {
  return handleSocketMessage({ type: "session.compaction", session_id: `ses_${id}`, payload }, ctx);
}

describe("session.usage is attributed as a delta", () => {
  test("the first reading is a baseline; the next records the delta on the current task", async () => {
    seedSpawned("w1", 1);
    addTask(db, { title: "cost work" });
    claimNext(db, "w1");

    const first = await sendUsage("w1", {
      cost: 1.0,
      input: 1000,
      output: 100,
      reasoning: 0,
      cache_read: 5000,
      cache_write: 0,
    });
    expect(first).toMatchObject({ ok: true, ignored: "baseline-or-empty" });
    expect(usageTotals(db).samples).toBe(0);
    // The cursor advanced even though no sample was recorded.
    expect(getSession(db, "ses_w1")!.usage_cost).toBeCloseTo(1.0, 6);

    const second = await sendUsage("w1", {
      cost: 1.5,
      input: 1600,
      output: 150,
      reasoning: 0,
      cache_read: 9000,
      cache_write: 0,
    });
    expect(second).toMatchObject({ ok: true, recorded: true });

    const totals = usageTotals(db);
    expect(totals.cost).toBeCloseTo(0.5, 6);
    expect(totals.input).toBe(600);
    expect(totals.output).toBe(50);
    expect(totals.cache_read).toBe(4000);

    const byTask = usageReport(db, "task");
    expect(byTask).toHaveLength(1);
    expect(byTask[0].key).toBe("T1");
    expect(byTask[0].cost).toBeCloseTo(0.5, 6);

    const byWorker = usageReport(db, "worker");
    expect(byWorker[0].key).toBe("w1");
    expect(byWorker[0].input).toBe(600);
  });

  test("a reading with no change records nothing", async () => {
    seedSpawned("w1", 1);
    const reading = { cost: 1, input: 10, output: 1, reasoning: 0, cache_read: 0, cache_write: 0 };
    await sendUsage("w1", reading); // baseline
    const same = await sendUsage("w1", reading);
    expect(same).toMatchObject({ ok: true, ignored: "baseline-or-empty" });
    expect(usageTotals(db).samples).toBe(0);
  });

  test("a stale-generation usage event is fenced out", async () => {
    seedSpawned("w1", 1);
    const res = await sendUsage("w1", { cost: 9, input: 9, output: 9, cache_read: 9 }, 0);
    expect(res).toMatchObject({ ok: true, ignored: "stale-generation" });
    expect(usageTotals(db).samples).toBe(0);
  });

  test("a bad payload is ignored", async () => {
    seedSpawned("w1", 1);
    const res = await sendUsage("w1", { cost: "nope" });
    expect(res).toMatchObject({ ok: true, ignored: "bad-usage" });
  });
});

describe("session.compaction counts once", () => {
  test("started+ended counts one; ended alone counts one; completed alone counts one", async () => {
    seedSpawned("w1", 1);

    expect(await sendCompaction("w1", { status: "started", reason: "auto" })).toMatchObject({
      ok: true,
      counted: true,
    });
    expect(getSession(db, "ses_w1")!.compactions).toBe(1);
    expect(await sendCompaction("w1", { status: "ended" })).toMatchObject({ ok: true, counted: false });
    expect(getSession(db, "ses_w1")!.compactions).toBe(1); // not double counted
    expect(getSession(db, "ses_w1")!.compaction_open).toBe(0);
    expect(getSession(db, "ses_w1")!.last_compacted_at).not.toBeNull();

    // A terminal status with no matching start still counts (missed start).
    expect(await sendCompaction("w1", { status: "completed" })).toMatchObject({ ok: true, counted: true });
    expect(getSession(db, "ses_w1")!.compactions).toBe(2);

    // An unknown status is refused.
    expect(await sendCompaction("w1", { status: "delta" })).toMatchObject({ ok: true, ignored: "bad-compaction" });
  });

  test("compactions surface in the usage report", async () => {
    seedSpawned("w1", 1);
    await sendCompaction("w1", { status: "started" });
    await sendCompaction("w1", { status: "ended" });
    const byWorker = usageReport(db, "worker");
    // No usage samples yet, so the worker row may be absent; session report shows it.
    const bySession = usageReport(db, "session");
    expect(bySession.find((r) => r.key === "ses_w1")?.compactions).toBe(1);
    void byWorker;
  });
});

describe("plugin usage/compaction extraction", () => {
  test("sessionUsageOf reads a Session's cumulative cost and token breakdown", () => {
    const session = {
      sessionID: "ses_x",
      info: {
        id: "ses_x",
        slug: "quiet-river",
        projectID: "prj_1",
        directory: "/proj/x",
        title: "long-lived",
        cost: 2.5,
        tokens: { input: 1000, output: 200, reasoning: 50, cache: { read: 5000, write: 10 } },
      },
    };
    expect(sessionUsageOf(session)).toEqual({
      cost: 2.5,
      input: 1000,
      output: 200,
      reasoning: 50,
      cacheRead: 5000,
      cacheWrite: 10,
    });
  });

  test("a streamed Session without projectID is still recognised by its ses_ id", () => {
    // The API Session carries projectID, but a streamed one may be reduced to
    // id/title/tokens/model. `id` is the reliable discriminator (ses_ vs msg_).
    const reduced = {
      sessionID: "ses_x",
      info: {
        id: "ses_x",
        title: "long-lived",
        cost: 1.0,
        tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 900, write: 0 } },
      },
    };
    expect(sessionUsageOf(reduced)).toEqual({
      cost: 1.0,
      input: 100,
      output: 10,
      reasoning: 0,
      cacheRead: 900,
      cacheWrite: 0,
    });
    // ...and it is classified as a Session (cumulative), never occupancy.
    expect(contextUsedTokens(reduced)).toEqual({ cumulative: 1000 });
  });

  test("session.usage.updated is cumulative; session.step.ended is occupancy (OpenCode 2.0.4)", () => {
    // The real cumulative event (NOT the SDK's `session.updated`).
    const cumulative = {
      sessionID: "ses_x",
      cost: 1.25,
      tokens: { input: 198_913, output: 100, reasoning: 0, cache: { read: 49_682_048, write: 0 } },
    };
    expect(sessionUsageOf(cumulative)).toEqual({
      cost: 1.25,
      input: 198_913,
      output: 100,
      reasoning: 0,
      cacheRead: 49_682_048,
      cacheWrite: 0,
    });
    expect(contextUsedTokens(cumulative)).toEqual({ cumulative: 49_880_961 });

    // A per-step event carries an assistant message id: occupancy, never cumulative.
    const step = {
      sessionID: "ses_x",
      assistantMessageID: "msg_1",
      cost: 0.01,
      tokens: { input: 300_000, output: 50, reasoning: 0, cache: { read: 50_000, write: 0 } },
    };
    expect(sessionUsageOf(step)).toBeUndefined();
    expect(contextUsedTokens(step)).toEqual({ used: 350_000 });
  });

  test("an assistant message is not a Session: no cumulative usage", () => {
    const message = {
      sessionID: "ses_x",
      info: { role: "assistant", tokens: { input: 1, output: 1, cache: { read: 2, write: 0 } } },
    };
    expect(sessionUsageOf(message)).toBeUndefined();
    expect(sessionUsageOf({})).toBeUndefined();
    expect(sessionUsageOf(null)).toBeUndefined();
  });

  test("compactionStatusOf normalizes the host's several event names", () => {
    expect(compactionStatusOf("session.next.compaction.started")).toBe("started");
    expect(compactionStatusOf("session.compaction.started")).toBe("started");
    expect(compactionStatusOf("session.next.compaction.ended")).toBe("ended");
    expect(compactionStatusOf("session.compaction.failed")).toBe("failed");
    expect(compactionStatusOf("session.compacted")).toBe("completed");
    // High-frequency deltas must not be forwarded as compactions.
    expect(compactionStatusOf("session.next.compaction.delta")).toBeUndefined();
    expect(compactionStatusOf("message.updated")).toBeUndefined();
  });
});
