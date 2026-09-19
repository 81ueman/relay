import { spawnSync } from "node:child_process";
import { targetFor, type Runtime } from "./runtime";

// Herdr adapter. Verified against the installed CLI (herdr 0.8.2):
//   herdr agent get <target>            -> exit 0 iff the agent exists
//   herdr agent prompt <target> <text>  -> fire-and-forget nudge (no --wait here)
//   herdr agent send-keys <target> <k>  -> esc / ctrl+c
//   herdr agent read <target> --source recent-unwrapped --lines N
// Agent lifecycle states observed by Herdr: idle | working | blocked | done | unknown.
// NOTE: Herdr idle/wait is NEVER a source of truth; it is only a wake-up transport.

function runHerdr(args: string[], timeoutMs = 8000): { ok: boolean; stdout: string; stderr: string } {
  try {
    const r = spawnSync("herdr", args, { encoding: "utf-8", timeout: timeoutMs });
    return { ok: r.status === 0, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e) };
  }
}

export class HerdrRuntime implements Runtime {
  readonly name = "herdr";

  async isAlive(workerId: string): Promise<boolean> {
    // `agent get` exits 0 for a live agent; anything else means unreachable here.
    const r = runHerdr(["agent", "get", workerId], 5000);
    return r.ok;
  }

  async wake(workerId: string, text: string): Promise<void> {
    // No --wait: the daemon must never block on an agent turn.
    const r = runHerdr(["agent", "prompt", workerId, text], 10000);
    if (!r.ok) throw new Error(`herdr wake failed for ${workerId}: ${r.stderr.trim()}`);
  }

  async interrupt(workerId: string): Promise<void> {
    const r = runHerdr(["agent", "send-keys", workerId, "esc"], 5000);
    if (!r.ok) throw new Error(`herdr interrupt failed for ${workerId}: ${r.stderr.trim()}`);
  }

  async restart(workerId: string): Promise<void> {
    // Best-effort: stop the current turn, then nudge a fresh loop.
    // Pane processes belong to the user; we never kill them, only interrupt + nudge.
    runHerdr(["agent", "send-keys", workerId, "ctrl+c"], 5000);
    await new Promise((res) => setTimeout(res, 500));
    await this.wake(workerId, "Restart requested by supervisor. Read your worker skill, then run `agentctl next`.");
  }

  async peek(workerId: string): Promise<string> {
    const r = runHerdr(["agent", "read", workerId, "--source", "recent-unwrapped", "--lines", "60"], 8000);
    return r.ok ? r.stdout : "";
  }
}

export function targetForWorker(w: { id: string; runtime_id: string | null }): string {
  return targetFor(w);
}
