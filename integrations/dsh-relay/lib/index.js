// relay bridge for DeepSeek Harness (dsh) — dsh/cordis glue.
//
// Installed into a dsh profile (see cordis.patch.yml). It makes a dsh session a
// first-class relay worker WITHOUT a Herdr input pane:
//
//   1. IDENTITY/STATUS -> Herdr. On session start it calls
//      `herdr pane report-agent-session` and `herdr pane report-agent`, so
//      Herdr (and therefore relay's identity resolution + reportedSessions)
//      knows the pane hosts this dsh session with an idle/working status.
//   2. EVENTS -> relay socket. It forwards session.idle / tool.started /
//      tool.execute.after (see lib/core.mjs) to relay's daemon, exactly like
//      the OpenCode plugin, so dsh is an EVENT-driven harness.
//   3. WAKES <- relay socket. It long-polls `worker.wake.await` and calls
//      `agent.followup(...)` for each queued nudge — dsh's in-process wake.
//
// Everything is best-effort and never throws into dsh: a missing Herdr or relay
// socket must not break the agent. Errors are logged once per session.
//
// NOTE: untested against a live dsh here (no dsh in CI). Verify the smoke path
// in README.md before relying on it.

import { spawnSync } from "node:child_process";
import {
  RelayClient,
  isDshSessionId,
  relayEventForAgentStatus,
  relayEventForSessionEvent,
  resolveRelaySocket,
  wakeBackoff,
} from "./core.mjs";

export const name = "relay-bridge";
export const inject = ["agents"];

const WAKE_POLL_MS = 20000;
// Floor between wake polls. relay long-polls, but a null reply for an
// unattached session (or a connection error while the daemon is down) returns
// instantly; without this the loop spins.
const WAKE_MIN_GAP_MS = 1000;

function log(msg) {
  try {
    console.log(`[relay-bridge] ${msg}`);
  } catch {
    /* stdout closed */
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function herdrBin() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

function run(bin, args, timeout = 6000) {
  try {
    const r = spawnSync(bin, args, { timeout, stdio: "ignore" });
    return r && r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Report the session's presence + status to Herdr.
 *
 * The `report-agent` call is what LABELS the pane `agent=dsh`; relay's identity
 * resolution matches on that label (Herdr 0.9.x does not record a resume
 * command / `agent_session` mapping for an agent it does not ship, so the label
 * — not the session mapping — is the load-bearing part). We therefore always
 * report a state, defaulting to `unknown` at session start.
 *
 * `report-agent-session` is sent on the start report for forward compatibility:
 * Herdr >= 0.10 records the resume command from it, 0.9.x ignores it.
 */
function reportHerdr(paneId, label, sessionId, cwd, state) {
  if (!paneId) return;
  run(herdrBin(), [
    "pane", "report-agent", paneId,
    "--source", "dsh-relay",
    "--agent", label,
    "--state", state || "unknown",
    "--agent-session-id", sessionId,
  ]);
  if (!state) {
    run(herdrBin(), [
      "pane", "report-agent-session", paneId,
      "--source", "dsh-relay",
      "--agent", label,
      "--agent-session-id", sessionId,
      "--agent-session-path", cwd,
    ]);
  }
}

export function apply(ctx, config = {}) {
  const cfg = {
    report: config.report !== false,
    wake: config.wake !== false,
    agentLabel: config.agentLabel || "dsh",
    paneIdEnv: config.paneIdEnv || "HERDR_PANE_ID",
    ...config,
  };
  const paneId = process.env[cfg.paneIdEnv] || config.paneId || "";
  if (cfg.report && !paneId) {
    log(`no ${cfg.paneIdEnv}; Herdr reporting disabled (relay cannot resolve the pane)`);
  }

  /** sessionId -> bridge state */
  const states = new Map();

  function sessionCwd(agent) {
    return (
      (agent && agent.session && agent.session.meta && agent.session.meta.cwd) ||
      (agent && agent.session && agent.session.cwd) ||
      process.cwd()
    );
  }

  function ensure(agent) {
    const sessionId = String((agent && agent.session && agent.session.id) || (agent && agent.id) || "");
    if (!isDshSessionId(sessionId)) return null;
    let st = states.get(sessionId);
    if (st) return st;
    const cwd = sessionCwd(agent);
    st = { sessionId, cwd, client: new RelayClient(resolveRelaySocket(cwd)), stopped: false };
    states.set(sessionId, st);
    if (cfg.report) reportHerdr(paneId, cfg.agentLabel, sessionId, cwd, null);
    log(`session ${sessionId} -> relay ${st.client.sockPath}`);
    if (cfg.wake) void wakeLoop(ctx, st);
    return st;
  }

  async function wakeLoop(agentCtx, st) {
    while (!st.stopped) {
      const started = Date.now();
      let wake = null;
      try {
        wake = await st.client.awaitWake(st.sessionId, { waitMs: WAKE_POLL_MS });
      } catch {
        wake = null;
      }
      if (st.stopped) break;
      if (wake && wake.text) deliver(agentCtx, st, wake);
      const gap = wakeBackoff(Date.now() - started, WAKE_MIN_GAP_MS);
      if (gap > 0 && !st.stopped) await sleep(gap);
    }
  }

  function deliver(agentCtx, st, wake) {
    const agent = agentCtx.agents.get(st.sessionId);
    if (!agent) return;
    try {
      agent.followup({ content: [{ type: "text", text: String(wake.text) }], source: { kind: "plugin", plugin: "relay" } });
      log(`delivered wake to ${st.sessionId} (${wake.reason || "wake"})`);
    } catch (e) {
      log(`wake delivery failed for ${st.sessionId}: ${String(e).slice(0, 160)}`);
    }
  }

  for (const ev of ["agent/created", "agent/session-start"]) {
    ctx.on(ev, (payload) => {
      try {
        if (payload && payload.agent) ensure(payload.agent);
      } catch {
        /* never throw into dsh */
      }
    });
  }

  ctx.on("agent/status", (payload) => {
    try {
      const agent = payload && payload.agent;
      if (!agent) return;
      const st = ensure(agent);
      if (!st) return;
      if (cfg.report) reportHerdr(paneId, cfg.agentLabel, st.sessionId, st.cwd, payload.status === "running" ? "working" : "idle");
      const msg = relayEventForAgentStatus(payload.status);
      if (msg) void st.client.notify({ ...msg, session_id: st.sessionId });
    } catch {
      /* never throw into dsh */
    }
  });

  ctx.on("session/event", (session, event) => {
    try {
      const sessionId = String((session && session.id) || "");
      const st = states.get(sessionId);
      if (!st) return;
      const msg = relayEventForSessionEvent(event);
      if (msg) void st.client.notify({ ...msg, session_id: sessionId });
    } catch {
      /* never throw into dsh */
    }
  });

  ctx.on("agent/disposed", (payload) => {
    try {
      const sessionId = String((payload && payload.agent && payload.agent.session && payload.agent.session.id) || "");
      const st = states.get(sessionId);
      if (st) {
        st.stopped = true;
        if (cfg.report) reportHerdr(paneId, cfg.agentLabel, sessionId, st.cwd, "unknown");
        states.delete(sessionId);
      }
    } catch {
      /* never throw into dsh */
    }
  });

  // Pick up any sessions that already exist when the plugin mounts.
  try {
    for (const agent of ctx.agents.list()) ensure(agent);
  } catch {
    /* registry not ready */
  }
}

export default { name, inject, apply };
