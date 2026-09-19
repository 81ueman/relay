import type { Worker } from "../schema";

// Transport interface. Herdr is a process/session transport only:
// durable state always lives in SQLite first; wake() is just a nudge.
//
// All methods take the full Worker row so adapters can route via
// worker.runtime_id consistently. Callers must NEVER build Herdr
// targets themselves.

export interface Runtime {
  readonly name: string;
  isAlive(worker: Worker): Promise<boolean>;
  wake(worker: Worker, text: string): Promise<void>;
  interrupt(worker: Worker): Promise<void>;
  /** Spawn a brand-new agent generation for this worker (must work when nothing exists). Returns the new runtime target. */
  start(worker: Worker): Promise<string>;
  /** interrupt (best effort) + start a fresh generation. Returns the new runtime target. */
  restart(worker: Worker): Promise<string>;
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
  failWake = new Set<string>();
  failStart = new Set<string>();
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
  async start(w: Worker): Promise<string> {
    const target = MockRuntime.targetOf(w);
    this.targets.push({ op: "start", target });
    if (this.failStart.has(this.key(w))) throw new Error("start failed (simulated)");
    this.starts.push(this.key(w));
    this.alive.set(this.key(w), true);
    return target;
  }
  async restart(w: Worker): Promise<string> {
    const target = MockRuntime.targetOf(w);
    this.targets.push({ op: "restart", target });
    this.restarts.push(this.key(w));
    this.alive.set(this.key(w), true);
    return target;
  }
  async peek(w: Worker): Promise<string> {
    this.targets.push({ op: "peek", target: MockRuntime.targetOf(w) });
    return this.peekText;
  }
}
