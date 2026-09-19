import type { Worker } from "../schema";

// Transport interface. Herdr is a process/session transport only:
// durable state always lives in SQLite first; wake() is just a nudge.
//
// All methods take the full Worker row so adapters can route via
// worker.runtime_id consistently. Callers must NEVER build Herdr
// targets themselves.

/** Result of spawning a fresh generation. Herdr metadata stays out of the workers row. */
export interface StartedRuntime {
  runtimeId: string; // Herdr agent name (unique per generation)
  tabId?: string;
  paneId?: string;
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
}

export interface Runtime {
  readonly name: string;
  isAlive(worker: Worker): Promise<boolean>;
  wake(worker: Worker, text: string): Promise<void>;
  interrupt(worker: Worker): Promise<void>;
  /** Spawn a brand-new generation in a fresh tab (must work when nothing exists). */
  start(worker: Worker, generation: number): Promise<StartedRuntime>;
  /** interrupt (best effort) + start a fresh generation. */
  restart(worker: Worker, generation: number): Promise<StartedRuntime>;
  /** Safely reap an old generation's tab. MUST refuse if it cannot prove relay ownership. */
  cleanup(runtime: RuntimeRecord): Promise<void>;
  peek(worker: Worker): Promise<string>;
}

export class MockRuntime implements Runtime {
  readonly name = "mock";
  alive = new Map<string, boolean>();
  /** Every transport target actually used, in call order (for routing tests). */
  targets: { op: string; target: string }[] = [];
  wakes: { workerId: string; target: string; text: string }[] = [];
  interrupts: string[] = [];
  starts: string[] = [];
  restarts: string[] = [];
  /** runtime ids passed to cleanup(), in order. */
  cleanups: string[] = [];
  failWake = new Set<string>();
  failStart = new Set<string>();
  /** Workers whose restart() should throw. */
  failRestart = new Set<string>();
  /** Runtime ids (or `${worker}:g${generation}`) whose cleanup should throw. */
  failCleanup = new Set<string>();
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

  async isAlive(w: Worker): Promise<boolean> {
    this.targets.push({ op: "isAlive", target: MockRuntime.targetOf(w) });
    return this.alive.get(this.key(w)) ?? true;
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
  async restart(w: Worker, generation: number): Promise<StartedRuntime> {
    const target = MockRuntime.targetOf(w);
    this.targets.push({ op: "restart", target });
    if (this.failRestart.has(this.key(w))) throw new Error("restart failed (simulated)");
    this.restarts.push(this.key(w));
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
    if (this.failCleanup.has(runtimeId) || this.failCleanup.has(`${rec.worker_id}:g${rec.generation}`)) {
      throw new Error("cleanup failed (simulated)");
    }
    this.cleanups.push(runtimeId);
  }
  async peek(w: Worker): Promise<string> {
    this.targets.push({ op: "peek", target: MockRuntime.targetOf(w) });
    return this.peekText;
  }
}
