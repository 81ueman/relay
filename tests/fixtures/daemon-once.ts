// Test fixture: run one `daemon --once` supervisor pass, gated by a wall-clock
// barrier so two of them race the same canonical-DB lock simultaneously.
//
// Paths come from RELAY_DB / RELAY_SOCK, exactly like the production CLI.
import { runDaemon } from "../../src/daemon";
import { MockRuntime } from "../../src/runtime/runtime";

const startAt = Number(process.env.START_AT ?? "0");
while (Date.now() < startAt) await Bun.sleep(1);

await runDaemon({ once: true, runtime: new MockRuntime(), intervalMs: 0 });
