import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RelayClient,
  isDshSessionId,
  relayEventForAgentStatus,
  relayEventForSessionEvent,
  relayRequest,
  resolveRelaySocket,
  wakeBackoff,
} from "../integrations/dsh-relay/lib/core.mjs";

// T-DSH-PLUGIN: the pure core of the dsh <-> relay bridge. The cordis glue
// (lib/index.js) is exercised only against a live dsh; this pins the parts that
// must be right regardless: socket discovery, id recognition, event shaping and
// the JSON-Lines transport.

const DSH_SESSION = "session-23274032-a2fc-4be5-9803-07cfeea34058";

describe("resolveRelaySocket", () => {
  test("RELAY_SOCK wins", () => {
    expect(resolveRelaySocket("/x/y", { RELAY_SOCK: "/tmp/custom.sock" })).toBe("/tmp/custom.sock");
  });

  test("walks up to the nearest .relay/.git marker", () => {
    const root = mkdtempSync(join(tmpdir(), "relay-sock-"));
    try {
      mkdirSync(join(root, ".relay"), { recursive: true });
      mkdirSync(join(root, "a", "b"), { recursive: true });
      expect(resolveRelaySocket(join(root, "a", "b"), {})).toBe(join(root, ".relay", "relay.sock"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("falls back to <cwd>/.relay/relay.sock with no marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-sock-none-"));
    try {
      expect(resolveRelaySocket(dir, {})).toBe(join(dir, ".relay", "relay.sock"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isDshSessionId", () => {
  test("accepts session-<uuid> and a prefixed variant; rejects others", () => {
    expect(isDshSessionId(DSH_SESSION)).toBe(true);
    expect(isDshSessionId("main-session-23274032-a2fc-4be5-9803-07cfeea34058")).toBe(true);
    expect(isDshSessionId("ses_abc123")).toBe(false);
    expect(isDshSessionId("01a0c405-70ba-7bf0-8522-98eba9dd5283")).toBe(false);
    expect(isDshSessionId("")).toBe(false);
  });
});

describe("event shaping", () => {
  test("tool/call -> tool.started; tool/result -> tool.execute.after", () => {
    expect(relayEventForSessionEvent({ type: "tool/call", name: "bash", callId: "c1" })).toEqual({
      type: "tool.started",
      payload: { tool: "bash", call_id: "c1" },
    });
    expect(relayEventForSessionEvent({ type: "tool/result", message: { id: "m1" } })).toEqual({
      type: "tool.execute.after",
      payload: { call_id: "m1", is_error: false },
    });
    expect(relayEventForSessionEvent({ type: "tool/result", message: { id: "m1" }, error: { name: "E" } })).toMatchObject({
      payload: { is_error: true },
    });
    expect(relayEventForSessionEvent({ type: "assistant/message" })).toBeNull();
  });

  test("agent status: idle -> session.idle, running -> session.status", () => {
    expect(relayEventForAgentStatus("idle")).toEqual({ type: "session.idle" });
    expect(relayEventForAgentStatus("running")).toEqual({ type: "session.status", payload: { status: "working" } });
    expect(relayEventForAgentStatus("disposed")).toBeNull();
  });
});

describe("JSON-Lines transport against a live relay-style socket", () => {
  function startServer(sockPath: string) {
    const seen: unknown[] = [];
    const server = Bun.listen({
      unix: sockPath,
      socket: {
        data(socket, data) {
          const line = data.toString().trim();
          if (!line) return;
          seen.push(JSON.parse(line));
          const req = JSON.parse(line) as { type?: string };
          const res = req.type === "worker.wake.await"
            ? { ok: true, wake: { reason: "wake", text: "continue T1", created_at: 1 } }
            : { ok: true, echoed: true };
          socket.write(JSON.stringify(res) + "\n");
        },
      },
    });
    return { server, seen, stop: () => server.stop(true) };
  }

  test("RelayClient.notify delivers a line and reads the ack", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-sock-live-"));
    const sockPath = join(dir, "relay.sock");
    const srv = startServer(sockPath);
    try {
      const client = new RelayClient(sockPath);
      expect(await client.notify({ type: "session.idle", session_id: DSH_SESSION })).toBe(true);
      expect(srv.seen).toEqual([{ type: "session.idle", session_id: DSH_SESSION }]);
    } finally {
      srv.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("awaitWake returns the queued nudge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-sock-live-"));
    const sockPath = join(dir, "relay.sock");
    const srv = startServer(sockPath);
    try {
      const client = new RelayClient(sockPath);
      const wake = await client.awaitWake(DSH_SESSION, { waitMs: 100 });
      expect(wake).toEqual({ reason: "wake", text: "continue T1", created_at: 1 });
    } finally {
      srv.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("relayRequest resolves null (never throws) when the socket is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-sock-none-"));
    try {
      expect(await relayRequest(join(dir, "missing.sock"), { type: "ping" }, 200)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("wakeBackoff", () => {
  test("a fast reply (or a connection error) cannot spin the wake loop", () => {
    // A poll that returned instantly still sleeps the floor before re-polling.
    expect(wakeBackoff(0, 1000)).toBe(1000);
    expect(wakeBackoff(50, 1000)).toBe(950);
  });

  test("a poll that already blocked for the floor is not padded", () => {
    expect(wakeBackoff(1000, 1000)).toBe(0);
    expect(wakeBackoff(20000, 1000)).toBe(0);
  });
});
