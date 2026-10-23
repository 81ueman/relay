// Test fixture: run one `daemon --once` supervisor pass, with an optional
// rendezvous INSIDE the pass.
//
// READY_FILE is written from the injected runtime's `agentStatus`, which a
// supervisor pass calls for a POLLED (codex/claude) worker. By that point the
// daemon has already acquired the SQLite supervisor lock and opened the state
// DB, so READY_FILE proves this process is a live supervisor HOLDING the lock.
// The fixture then blocks until RELEASE_FILE exists. A test can therefore start
// a competing `--once` run and observe its rejection while this pass is still
// in flight: a deterministic overlap that does not depend on wall-clock start
// alignment. See tests/singleton.test.ts test H.
//
// Paths come from RELAY_DB / RELAY_SOCK, exactly like the production CLI.
import { existsSync, writeFileSync } from "node:fs";
import { runDaemon } from "../../src/daemon";
import { MockRuntime, type AgentStatus } from "../../src/runtime/runtime";
import type { Worker } from "../../src/schema";

const readyFile = process.env.READY_FILE;
const releaseFile = process.env.RELEASE_FILE;

class GatedRuntime extends MockRuntime {
  async agentStatus(w: Worker): Promise<AgentStatus> {
    if (readyFile) {
      writeFileSync(readyFile, String(process.pid));
      if (releaseFile) while (!existsSync(releaseFile)) await Bun.sleep(5);
    }
    // "working" only touches last_seen; it keeps the rest of the pass quiet.
    return "working";
  }
}

await runDaemon({ once: true, runtime: new GatedRuntime(), intervalMs: 0 });
