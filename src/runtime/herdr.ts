import { spawnSync } from "node:child_process";
import type { Worker } from "../schema";
import { MockRuntime, type Runtime } from "./runtime";

// Herdr adapter. Verified against the installed CLI (herdr 0.8.2) and the
// installed `herdr --skill` text:
//   herdr agent get <target>                        exit 0 iff the agent exists
//     (target = live agent name OR pane id hosting it)
//   herdr agent prompt <target> <text>              fire-and-forget nudge
//   herdr agent send-keys <target> esc|ctrl+c
//   herdr agent read <target> --source recent-unwrapped --lines N
//   herdr agent start <NAME> --kind <KIND> --pane <ID> [--timeout MS]
//     (NAME: [a-z][a-z0-9_-]{0,31}, unique; pane must be at shell prompt;
//      waits for interactive readiness, default 30s)
//   herdr tab create --cwd <PATH> --no-focus [--env K=V] [--label T]
//     (returns .result.tab + .result.root_pane; never disturbs user layout)
// Agent lifecycle: idle | working | blocked | done | unknown.
// NOTE: Herdr idle/wait is NEVER a source of truth; only a wake transport.

function runHerdr(args: string[], timeoutMs = 8000): { ok: boolean; stdout: string; stderr: string } {
  try {
    const r = spawnSync("herdr", args, { encoding: "utf-8", timeout: timeoutMs });
    return { ok: r.status === 0, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e) };
  }
}

/** Single place where a Worker maps to a Herdr target. */
export function herdrTarget(w: Pick<Worker, "id" | "runtime_id">): string {
  return w.runtime_id ?? w.id;
}

function sanitizeAgentName(id: string): string {
  const s = id.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+/, "") || "worker";
  const base = (s.startsWith("-") ? `w${s}` : s).slice(0, 24);
  return base || "worker";
}

function tryParseJson(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** Defensively extract the new root pane id from `tab create` output. */
function extractRootPaneId(parsed: any): string | null {
  const result = parsed?.result ?? parsed;
  const candidates = [
    result?.root_pane?.pane_id,
    result?.root_pane,
    result?.pane?.pane_id,
    result?.pane,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.includes(":p")) return c;
  }
  return null;
}

export const BOOTSTRAP_PROMPT = (workerId: string) =>
  `You are managed by the relay supervisor as worker ${workerId}. ` +
  `Load the agent-worker skill, then run \`agentctl next\` to claim work. ` +
  `Never wait for instructions; after each submit/block run \`agentctl next\` again.`;

export class HerdrRuntime implements Runtime {
  readonly name = "herdr";

  async isAlive(w: Worker): Promise<boolean> {
    return runHerdr(["agent", "get", herdrTarget(w)], 5000).ok;
  }

  async wake(w: Worker, text: string): Promise<void> {
    // No --wait: the daemon must never block on an agent turn.
    const r = runHerdr(["agent", "prompt", herdrTarget(w), text], 10000);
    if (!r.ok) throw new Error(`herdr wake failed for ${herdrTarget(w)}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  }

  async interrupt(w: Worker): Promise<void> {
    const r = runHerdr(["agent", "send-keys", herdrTarget(w), "esc"], 5000);
    if (!r.ok) throw new Error(`herdr interrupt failed for ${herdrTarget(w)}`);
  }

  /**
   * Spawn a brand-new opencode agent generation in a fresh background tab.
   * Works when nothing exists. Returns the new runtime target (agent name).
   * Never closes existing panes/tabs.
   */
  async start(w: Worker): Promise<string> {
    const cwd = w.cwd ?? process.cwd();
    const base = sanitizeAgentName(w.id);
    // Pick a unique live agent name.
    let name = base;
    for (let i = 2; i < 20; i++) {
      if (!runHerdr(["agent", "get", name], 5000).ok) break;
      name = `${base.slice(0, 28)}-${i}`;
    }
    if (runHerdr(["agent", "get", name], 5000).ok) {
      throw new Error(`no free agent name for worker ${w.id}`);
    }

    const envArgs: string[] = ["--env", `AGENTCTL_WORKER=${w.id}`];
    if (process.env.AGENTCTL_DB) envArgs.push("--env", `AGENTCTL_DB=${process.env.AGENTCTL_DB}`);
    const tab = runHerdr(
      ["tab", "create", "--cwd", cwd, "--no-focus", "--label", `relay:${w.id}`, ...envArgs],
      15000
    );
    if (!tab.ok) throw new Error(`herdr tab create failed: ${(tab.stderr || tab.stdout).trim().slice(0, 200)}`);
    const paneId = extractRootPaneId(tryParseJson(tab.stdout));
    if (!paneId) throw new Error(`herdr tab create returned no pane id: ${tab.stdout.slice(0, 200)}`);

    const started = runHerdr(["agent", "start", name, "--kind", "opencode", "--pane", paneId, "--timeout", "60000"], 75000);
    if (!started.ok) {
      throw new Error(`herdr agent start failed in ${paneId}: ${(started.stderr || started.stdout).trim().slice(0, 200)}`);
    }
    // Bootstrap + verify reachability.
    await this.wake({ ...w, runtime_id: name }, BOOTSTRAP_PROMPT(w.id));
    if (!(await this.isAlive({ ...w, runtime_id: name }))) {
      throw new Error(`started agent ${name} is not reachable`);
    }
    return name;
  }

  async restart(w: Worker): Promise<string> {
    // Best effort: stop the current turn, then start a fresh generation.
    // Old panes/tabs are deliberately left alone (never destroy user layout).
    try {
      await this.interrupt(w);
    } catch { /* already dead or unreachable */ }
    return this.start(w);
  }

  async peek(w: Worker): Promise<string> {
    const r = runHerdr(["agent", "read", herdrTarget(w), "--source", "recent-unwrapped", "--lines", "60"], 8000);
    return r.ok ? r.stdout : "";
  }
}

/** Build the real transport when herdr is usable, else a DB-only mock. */
export function buildRuntime(): Runtime {
  if (process.env.AGENTCTL_RUNTIME === "mock") return new MockRuntime();
  if (process.env.HERDR_ENV !== "1" && !process.env.HERDR_SOCKET_PATH) {
    return new MockRuntime();
  }
  try {
    const probe = Bun.spawnSync(["herdr", "agent", "list"]);
    if (probe.exitCode !== 0) throw new Error("herdr CLI unavailable");
    return new HerdrRuntime();
  } catch {
    return new MockRuntime();
  }
}
