import type { Worker } from "../schema";

// Transport interface. Relay is a Herdr-only control plane: Herdr is the ONLY
// process/session transport. durable state always lives in SQLite first; wake()
// is just a nudge, and Herdr idleness is NEVER a source of truth.
//
// There is deliberately no capability model and no tmux/other backend: the
// production implementation is HerdrRuntime, and MockRuntime exists solely for
// unit/integration tests (injected via DaemonOptions.runtime).
//
// Restart is a CONTROL-PLANE policy, not a transport primitive: the supervisor
// marks the old generation stale, best-effort interrupts it, then calls start()
// for a fresh generation. The adapter therefore has no restart().

/**
 * Polled agent status for runtimes WITHOUT an event stream (codex). Herdr
 * reports idle|working|blocked|done|unknown; `done` maps to `idle` (the turn
 * finished) and anything unrecognized to `unknown`.
 */
export type AgentStatus = "idle" | "working" | "blocked" | "dead" | "unknown";

/** Result of spawning a fresh generation. Herdr metadata stays out of the workers row. */export interface StartedRuntime {
  runtimeId: string; // Herdr agent name (or pane id when the agent is unnamed)
  tabId?: string;
  paneId?: string;
  workspaceId?: string;
  /**
   * Secret baked into the bootstrap prompt. The daemon requires it on the
   * managed attach so a stale/foreign plugin (or another project's session on a
   * shared OpenCode server) cannot bind a session it does not own.
   */
  attachToken?: string;
}

/** Minimal shape the cleanup path needs from worker_runtimes history. */
export interface RuntimeRecord {
  worker_id: string;
  generation: number;
  runtime_id: string | null;
  tab_id: string | null;
  pane_id: string | null;
  /** 1 = relay-created tab; 0 = adopted (never closed). */
  relay_owned?: number;
}

/**
 * Resolved Herdr identity of a live OpenCode session. Every managed session
 * must have one: Relay refuses to manage a session it cannot prove is running
 * inside a Herdr agent (fail closed, never guess).
 */
export interface HerdrIdentity {
  /** Herdr agent name, or the pane id for an unnamed agent (both are valid targets). */
  agent: string;
  tabId: string;
  paneId: string;
  workspaceId: string | null;
  /** Herdr agent kind, e.g. "opencode". */
  agentKind: string;
}

/**
 * Caller-provided hints. Verified against live Herdr state, never trusted
 * blindly. A `directory` alone is enough to identify the pane when it is the
 * only live opencode agent in that directory (a shared OpenCode server has no
 * per-session pane env); a pane hint is verified against that pane's cwd.
 */
export interface HerdrIdentityHint {
  paneId?: string;
  tabId?: string;
  workspaceId?: string;
  /** OpenCode session working directory: identifies/validates the pane. */
  directory?: string;
  /**
   * Expected agent kind ("opencode" | "codex"). A codex session has a UUID id
   * (not `ses...`), so identity resolution must accept a codex agent; when this
   * is absent the kind is inferred from the session id.
   */
  agentKind?: string;
}

export interface Runtime {
  readonly name: string;
  isAlive(worker: Worker): Promise<boolean>;
  /**
   * Is the agent actively executing right now (Herdr reports `working`)? Used to
   * treat a long command/benchmark as PROGRESS for the stall clock: an agent
   * inside one tool call makes no relay command for minutes, which must not read
   * as "stalled".
   */
  isWorking(worker: Worker): Promise<boolean>;
  /**
   * Polled agent status for a runtime with NO event stream (codex): relay
   * derives liveness/idle/blocked from this instead of plugin events. Optional;
   * the event-driven opencode path does not need it.
   */
  agentStatus?(worker: Worker): Promise<AgentStatus>;
  wake(worker: Worker, text: string): Promise<void>;
  interrupt(worker: Worker): Promise<void>;
  /**
   * Move the agent's currently BLOCKING tool call to the background (OpenCode
   * `session.background`, default key Ctrl-B). Used as a recovery action for a
   * hung foreground command: unlike `interrupt` (Esc) it does not discard the
   * work — the command keeps running and the session unblocks, so the agent can
   * check its result. Best-effort: the caller decides when.
   */
  background(worker: Worker): Promise<void>;
  /**
   * Spawn a brand-new generation in a fresh tab (must work when nothing exists).
   * Transport primitive only: it MUST NOT send the bootstrap prompt or touch the
   * DB. The supervisor records the generation durably, then delivers the
   * bootstrap itself.
   */
  start(worker: Worker, generation: number): Promise<StartedRuntime>;
  /**
   * Safely reap an old generation's tab. MUST refuse if it cannot prove relay
   * ownership, and MUST refuse outright when relay_owned is not true.
   */
  cleanup(runtime: RuntimeRecord): Promise<void>;
  peek(worker: Worker): Promise<string>;
  /**
   * Resolve the Herdr identity of the runtime hosting `sessionId` (manual
   * attach). MUST throw when the identity cannot be proven exactly: missing or
   * ambiguous mappings are rejected, never guessed.
   */
  resolveIdentity(input: { sessionId: string; hint?: HerdrIdentityHint }): Promise<HerdrIdentity>;
}

export class MockRuntime implements Runtime {
  readonly name = "mock";
  alive = new Map<string, boolean>();
  /** workerId -> Herdr agent_status === "working" (for the stall clock). */
  working = new Map<string, boolean>();
  /** Every transport target actually used, in call order (for routing tests). */
  targets: { op: string; target: string }[] = [];
  wakes: { workerId: string; target: string; text: string }[] = [];
  interrupts: string[] = [];
  /** Runtime targets passed to background(), in order. */
  backgrounded: string[] = [];
  starts: string[] = [];
  /** runtime ids passed to cleanup(), in order. */
  cleanups: string[] = [];
  failWake = new Set<string>();
  failStart = new Set<string>();
  /** Runtime ids (or `${worker}:g${generation}`) whose cleanup should throw. */
  failCleanup = new Set<string>();
  /** sessionId -> resolved Herdr identity (manual attach). Missing => reject. */
  identities = new Map<string, HerdrIdentity>();
  /** Every resolveIdentity call (for hint/verification assertions). */
  resolves: { sessionId: string; hint?: HerdrIdentityHint }[] = [];
  /** workerId -> polled agent status (codex path). */
  statuses = new Map<string, AgentStatus>();
  /** When set, resolveIdentity throws this (simulated ambiguity/unverifiable). */
  resolveError?: string;
  peekText = "";

  static targetOf(w: Pick<Worker, "id" | "runtime_id">): string {
    return w.runtime_id ?? w.id;
  }

  private key(w: Pick<Worker, "id" | "runtime_id">): string {
    return w.id;
  }

  setAlive(id: string, v: boolean): void {
    this.alive.set(id, v);
  }

  setWorking(id: string, v: boolean): void {
    this.working.set(id, v);
  }

  setAgentStatus(id: string, s: AgentStatus): void {
    this.statuses.set(id, s);
  }

  async agentStatus(w: Worker): Promise<AgentStatus> {
    this.targets.push({ op: "agentStatus", target: MockRuntime.targetOf(w) });
    return this.statuses.get(this.key(w)) ?? "idle";
  }

  setIdentity(sessionId: string, identity: HerdrIdentity): void {
    this.identities.set(sessionId, identity);
  }

  async isAlive(w: Worker): Promise<boolean> {
    this.targets.push({ op: "isAlive", target: MockRuntime.targetOf(w) });
    return this.alive.get(this.key(w)) ?? true;
  }
  async isWorking(w: Worker): Promise<boolean> {
    this.targets.push({ op: "isWorking", target: MockRuntime.targetOf(w) });
    return this.working.get(this.key(w)) ?? false;
  }
  async wake(w: Worker, text: string): Promise<void> {
    const target = MockRuntime.targetOf(w);
    this.targets.push({ op: "wake", target });
    if (this.failWake.has(this.key(w))) throw new Error("wake delivery failed (simulated)");
    this.wakes.push({ workerId: w.id, target, text });
  }
  async interrupt(w: Worker): Promise<void> {
    const target = MockRuntime.targetOf(w);
    this.targets.push({ op: "interrupt", target });
    this.interrupts.push(target);
  }
  async background(w: Worker): Promise<void> {
    const target = MockRuntime.targetOf(w);
    this.targets.push({ op: "background", target });
    this.backgrounded.push(target);
  }
  async start(w: Worker, generation: number): Promise<StartedRuntime> {
    const target = MockRuntime.targetOf(w);
    this.targets.push({ op: "start", target });
    if (this.failStart.has(this.key(w))) throw new Error("start failed (simulated)");
    this.starts.push(this.key(w));
    this.alive.set(this.key(w), true);
    return {
      runtimeId: `${target}#g${generation}`,
      tabId: `tab-${w.id}-g${generation}`,
      paneId: `pane-${w.id}-g${generation}`,
      attachToken: `mock-token-${w.id}-g${generation}`,
    };
  }
  async cleanup(rec: RuntimeRecord): Promise<void> {
    const runtimeId = rec.runtime_id ?? `${rec.worker_id}:g${rec.generation}`;
    this.targets.push({ op: "cleanup", target: runtimeId });
    // Ownership is absolute: an adopted (relay_owned=false) runtime is never closed.
    if (rec.relay_owned !== undefined && rec.relay_owned === 0) {
      throw new Error("refusing to clean a non-relay-owned runtime (simulated)");
    }
    if (this.failCleanup.has(runtimeId) || this.failCleanup.has(`${rec.worker_id}:g${rec.generation}`)) {
      throw new Error("cleanup failed (simulated)");
    }
    this.cleanups.push(runtimeId);
  }
  async peek(w: Worker): Promise<string> {
    this.targets.push({ op: "peek", target: MockRuntime.targetOf(w) });
    return this.peekText;
  }
  async resolveIdentity(input: { sessionId: string; hint?: HerdrIdentityHint }): Promise<HerdrIdentity> {
    this.targets.push({ op: "resolveIdentity", target: input.sessionId });
    this.resolves.push({ sessionId: input.sessionId, hint: input.hint });
    if (this.resolveError) throw new Error(this.resolveError);
    const id = this.identities.get(input.sessionId);
    if (!id) throw new Error("session is not running inside Herdr (simulated)");
    return id;
  }
}
