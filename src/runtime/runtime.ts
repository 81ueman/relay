// Transport interface. Herdr is a process/session transport only:
// durable state always lives in SQLite first; wake() is just a nudge.

export interface Runtime {
  readonly name: string;
  isAlive(workerId: string): Promise<boolean>;
  wake(workerId: string, text: string): Promise<void>;
  interrupt(workerId: string): Promise<void>;
  restart(workerId: string): Promise<void>;
  peek(workerId: string): Promise<string>;
}

/** Resolve the Herdr target (agent name or pane id) for a worker. */
export function targetFor(worker: { id: string; runtime_id: string | null }): string {
  return worker.runtime_id ?? worker.id;
}

export class MockRuntime implements Runtime {
  readonly name = "mock";
  alive = new Map<string, boolean>();
  wakes: { workerId: string; text: string }[] = [];
  interrupts: string[] = [];
  restarts: string[] = [];
  failWake = new Set<string>();
  peekText = "";

  setAlive(id: string, v: boolean): void {
    this.alive.set(id, v);
  }

  async isAlive(workerId: string): Promise<boolean> {
    return this.alive.get(workerId) ?? true;
  }
  async wake(workerId: string, text: string): Promise<void> {
    if (this.failWake.has(workerId)) throw new Error("wake delivery failed (simulated)");
    this.wakes.push({ workerId, text });
  }
  async interrupt(workerId: string): Promise<void> {
    this.interrupts.push(workerId);
  }
  async restart(workerId: string): Promise<void> {
    this.restarts.push(workerId);
    this.alive.set(workerId, true);
  }
  async peek(_workerId: string): Promise<string> {
    return this.peekText;
  }
}
