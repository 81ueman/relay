import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyAttachResult,
  attachAllowed,
  directoryFor,
  maybeAttachFromText,
  sendRequest,
  socketPathFor,
  type AttachState,
} from "../.opencode/plugins/relay";

// Plugin-side routing + attach correctness:
//   - a KNOWN session directory never routes to another project's RELAY_SOCK
//   - RELAY_SOCK is only a fallback when the directory is unknown
//   - a transient directory lookup failure is not cached forever
//   - auto-attach is request/response: ok=false/timeout never poisons the cache
//     and a retry is allowed after a cooldown

const SAVED_SOCK = process.env.RELAY_SOCK;
const SAVED_DEDICATED = process.env.RELAY_DEDICATED;

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "relay-plugin-"));
  delete process.env.RELAY_DEDICATED;
});
afterEach(() => {
  if (SAVED_SOCK === undefined) delete process.env.RELAY_SOCK;
  else process.env.RELAY_SOCK = SAVED_SOCK;
  if (SAVED_DEDICATED === undefined) delete process.env.RELAY_DEDICATED;
  else process.env.RELAY_DEDICATED = SAVED_DEDICATED;
  rmSync(root, { recursive: true, force: true });
});

function newAttachState(): AttachState {
  return {
    autoAttached: new Set(),
    attachAttemptAt: new Map(),
    generationCache: new Map(),
    detachedCache: new Set(),
  };
}

describe("per-session socket routing", () => {
  test("known directory never routes to another project's RELAY_SOCK", () => {
    const projA = join(root, "project-A");
    const projB = join(root, "project-B");
    mkdirSync(join(projA, ".relay"), { recursive: true });
    mkdirSync(join(projB, ".relay"), { recursive: true });
    process.env.RELAY_SOCK = join(projB, ".relay", "relay.sock");

    // project-A has a control plane dir but no socket yet: its OWN path, not B.
    expect(socketPathFor(projA)).toBe(join(projA, ".relay", "relay.sock"));

    // An existing socket deeper down wins, walking up from a subdirectory.
    writeFileSync(join(projA, ".relay", "relay.sock"), "");
    const sub = join(projA, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(socketPathFor(sub)).toBe(join(projA, ".relay", "relay.sock"));

    // A directory with no .relay anywhere: fail closed (NEVER project-B).
    const projC = join(root, "project-C");
    mkdirSync(projC, { recursive: true });
    expect(socketPathFor(projC)).toBeNull();
  });

  test("RELAY_SOCK is only a fallback in dedicated mode when the directory is unknown", () => {
    process.env.RELAY_SOCK = "/some/dedicated.sock";
    // No directory and no explicit dedicated opt-in: fail closed.
    expect(socketPathFor(undefined)).toBeNull();
    expect(socketPathFor(null)).toBeNull();
    // Explicit dedicated single-project mode: the env socket is the only handle.
    process.env.RELAY_DEDICATED = "1";
    expect(socketPathFor(undefined)).toBe("/some/dedicated.sock");
    expect(socketPathFor(null)).toBe("/some/dedicated.sock");
    delete process.env.RELAY_SOCK;
    expect(socketPathFor(undefined)).toBeNull();
  });

  test("a known directory with no control plane yields no socket (request fails closed)", async () => {
    const proj = join(root, "project-none");
    mkdirSync(proj, { recursive: true });
    process.env.RELAY_SOCK = "/elsewhere/relay.sock";
    // Even in dedicated mode a KNOWN directory must never cross-route.
    process.env.RELAY_DEDICATED = "1";
    const res = await sendRequest({ type: "session.attach", session_id: "ses_probe" }, proj, 50);
    expect(res).toMatchObject({ ok: false, reason: "no-socket" });
  });

  test("a transient directory lookup failure is retried, not cached", async () => {
    const sid = `ses_${Math.random().toString(36).slice(2)}`;
    let calls = 0;
    const ctx = {
      session: {
        get: async () => {
          calls++;
          if (calls === 1) throw new Error("session not ready");
          return { location: { directory: "/proj/A" } };
        },
      },
    };
    expect(await directoryFor(ctx, sid)).toBeUndefined();
    expect(await directoryFor(ctx, sid)).toBe("/proj/A");
    // Success is cached: no third lookup.
    expect(await directoryFor(ctx, sid)).toBe("/proj/A");
    expect(calls).toBe(2);
  });
});

describe("auto-attach is request/response", () => {
  test("ok=false / timeout never poison the cache and a retry is allowed", () => {
    const state = newAttachState();
    const t = 1_000;

    expect(attachAllowed(state, "ses_a", t, 1500)).toBe(true);
    state.attachAttemptAt.set("ses_a", t);
    // Within the cooldown: no thundering retry.
    expect(attachAllowed(state, "ses_a", t + 100, 1500)).toBe(false);
    // After the cooldown: retry allowed.
    expect(attachAllowed(state, "ses_a", t + 1500, 1500)).toBe(true);

    expect(applyAttachResult(state, "ses_a", 3, { ok: false, reason: "no-daemon" })).toBe(false);
    expect(applyAttachResult(state, "ses_a", 3, { ok: false, reason: "timeout" })).toBe(false);
    expect(state.generationCache.has("ses_a")).toBe(false);
    expect(state.autoAttached.has("ses_a")).toBe(false);
    expect(attachAllowed(state, "ses_a", 10_000, 1500)).toBe(true);

    // Only an explicit ok+managed binds, using the DAEMON's generation.
    expect(applyAttachResult(state, "ses_a", 3, { ok: true, managed: true, generation: 4 })).toBe(true);
    expect(state.generationCache.get("ses_a")).toBe(4);
    expect(state.autoAttached.has("ses_a")).toBe(true);
    expect(attachAllowed(state, "ses_a", 20_000, 1500)).toBe(false);
  });

  test("ok=true without managed=true is not treated as success", () => {
    const state = newAttachState();
    expect(applyAttachResult(state, "ses_b", 2, { ok: true })).toBe(false);
    expect(applyAttachResult(state, "ses_b", 2, { ok: true, managed: false })).toBe(false);
    expect(state.generationCache.has("ses_b")).toBe(false);
  });

  test("a rejected attach is retried after the cooldown and binds only on ok+managed", async () => {
    const proj = join(root, "project-retry");
    mkdirSync(join(proj, ".relay"), { recursive: true });
    const sockPath = join(proj, ".relay", "relay.sock");

    let connections = 0;
    const server: Server = createServer((socket) => {
      connections++;
      socket.on("data", () => {
        // First attempt is rejected; the retry succeeds.
        const accepted = connections >= 2;
        socket.write(
          JSON.stringify({ ok: accepted, managed: accepted, generation: 2, worker_id: "w1" }) + "\n"
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));

    const sid = `ses_${Math.random().toString(36).slice(2)}`;
    const ctx = { session: { get: async () => ({ location: { directory: proj } }) } };
    const marker = "RELAY-ATTACH worker=w1 gen=2 token=tok-2\nYou are managed by the relay supervisor.";

    try {
      expect(await maybeAttachFromText(ctx, sid, marker)).toBe(false);
      // The rejected attempt never poisoned the cache: a retry is allowed later.
      await Bun.sleep(1600);
      expect(await maybeAttachFromText(ctx, sid, marker)).toBe(true);
      expect(connections).toBeGreaterThanOrEqual(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
