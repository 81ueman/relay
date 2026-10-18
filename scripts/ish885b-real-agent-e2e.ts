#!/usr/bin/env bun
/**
 * ISH-885 (item 1) — REAL Agent-owned GitHub PR E2E (opt-in, no stand-in).
 *
 *   RELAY_ISH885B_E2E=1 bun scripts/ish885b-real-agent-e2e.ts
 *
 * Proves the honest item-1 chain against a REAL disposable PR on `81ueman/relay`:
 *
 *   - the **dsh/DeepSeek Coding Agent** runs INSIDE a real Coding Sandbox
 *     (`sandbox/coding-kit`) and performs the GitHub writes itself: `git commit`
 *     + `git push` (SSH agent forwarding) + `gh pr create`/update (the sbx GitHub
 *     credential proxy). Relay has NO publisher and makes ZERO GitHub writes.
 *   - an **independent headless Claude** (`claude -p`) posts a native
 *     `gh pr review` NG at A and, after a FRESH dsh FIX pushes B to the SAME PR,
 *     a PASS at B — from its own judgment (the verdict is NOT pre-filled).
 *   - Relay OBSERVES: `bindTaskPr` (read-only) binds A then B and `verifyNativeReview`
 *     reads both reviews back bound to the exact HEADs; a FAIL reaches the read-only
 *     merge gate. Nothing is merged and the default branch is never pushed.
 *
 * The disposable PR + branch + sandbox are cleaned up ONLY after the durable
 * evidence file is written. This script NEVER merges and NEVER pushes to the
 * default branch.
 *
 * PREREQUISITE (owner/operator): a working GitHub credential inside the sandbox.
 *   printf '%s' "$(gh auth token)" | sbx secret set github   # global service secret
 * Without it the sandbox falls back to the sbx sentinel token
 * (`SBX_CRED_GITHUB_MODE=none`, `gh` -> Bad credentials) and the dsh Agent cannot
 * `gh pr create`; the run is then recorded BLOCKED, never PASS.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, projectRoot } from "../src/db";
import { getTask } from "../src/tasks";
import { intakeTask } from "../src/workflow";
import { runFactoryTask } from "../src/factory";
import { GhCliGitHub, defaultExec } from "../src/provider-adapters";
import { bashLc, getSandbox, realSbxCli, resolveMainCheckout, sbxExecArgv } from "../src/sandbox";
import { ensureTaskSandbox } from "../src/sandbox-lifecycle";
import { parsePrUrl } from "../src/providers";
import type { Task } from "../src/schema";

export const REPO = "81ueman/relay";
export const BASE = "main";
/** The Coding Sandbox kit the dsh Agent runs in (ships the `ollama-cloud` route). */
export const CODING_KIT = join(import.meta.dir, "..", "sandbox", "coding-kit");

type Leg = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";

/** The disposable fixture the Task asks the dsh Agent to produce. */
export function fixtureCheck(): { name: string; command: string; required: boolean } {
  return {
    name: "ish885b-fixture",
    // Deliberately only checks that the FILES exist (the sandbox has no bun/node
    // to run the code). The behavioural rounding requirement is left to the
    // INDEPENDENT reviewer to judge from the diff — which is what can produce a
    // genuine NG@A (the classic "round half away from zero" negative case).
    command: "test -f docs/ish885b/AGENT-E2E.md && grep -q '^# ISH-885b Agent E2E$' docs/ish885b/AGENT-E2E.md && test -f src/ish885b/duration.ts",
    required: true,
  };
}

interface ShResult {
  ok: boolean;
  code: number | null;
  out: string;
  err: string;
}

function sh(bin: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): ShResult {
  try {
    const out = execFileSync(bin, args, {
      cwd: opts.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
    return { ok: true, code: 0, out: out.trim(), err: "" };
  } catch (e) {
    const a = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      ok: false,
      code: typeof a.status === "number" ? a.status : null,
      out: (a.stdout ?? "").toString().trim(),
      err: (a.stderr ?? a.message ?? "").toString().trim(),
    };
  }
}

export interface GithubWriteDetail {
  command: string;
  /** The dsh tool_result for this call (the real exit/error text), or null. */
  result: string | null;
}

export interface ActorEvidence {
  /** The dsh Agent's own bash tool calls that performed the GitHub writes. */
  agentGithubWrites: string[];
  agentGithubWriteDetails: GithubWriteDetail[];
  runs: { runId: string; state: string; exitCode: number | null; headSha: string | null; baseHeadSha: string | null; dshJsonl: string | null }[];
}

/**
 * The `sbx` GitHub credential placeholder from `sbx secret ls` (the CUSTOM secret
 * row whose TARGETS include `api.github.com` and whose ENV is `GH_TOKEN`), or null.
 *
 * A sandbox created from a KIT does not get the built-in `github` *service*
 * secret binding (`SBX_CRED_GITHUB_MODE=none`), so `gh` falls back to the sbx
 * sentinel and 401s. A CUSTOM secret DOES apply to kit sandboxes: setting
 * `GH_TOKEN` to its placeholder in the Run env makes the egress proxy substitute
 * the REAL token on the wire — the secret never enters the sandbox or argv.
 */
export function resolveGithubPlaceholder(listOut: string): string | null {
  for (const line of listOut.split("\n")) {
    if (!/api\.github\.com/.test(line) || !/GH_TOKEN/.test(line)) continue;
    const m = /(sbx-cs-[A-Za-z0-9]+)/.exec(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * The write signatures that must be attributed to the AGENT, never to Relay.
 * Quoted segments are stripped first so a `grep 'gh pr create' log` (a READ of a
 * string that mentions the command) is never mis-attributed as the write itself.
 */
export function isAgentGithubWrite(cmd: string): boolean {
  const c = cmd.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  return /\bgit\s+push\b/.test(c) || /\bgh\s+pr\s+(create|edit)\b/.test(c);
}

/**
 * Extract, per Run, the dsh Agent's `git push` / `gh pr` bash tool calls AND the
 * matching dsh `tool_result` (correlated by `callId`) so a FAILED `gh pr create`
 * is recorded with its real error — never silently attributed as a success.
 */
export function extractAgentGithubWrites(dbDir: string, rows: { id: string; state: string; exit_code: number | null; head_sha: string | null; base_head_sha: string | null; dsh_events_path: string | null }[]): ActorEvidence {
  void dbDir;
  const writes: string[] = [];
  const details: GithubWriteDetail[] = [];
  const runs = rows.map((r) => {
    if (r.dsh_events_path && existsSync(r.dsh_events_path)) {
      const jsonl = readFileSync(r.dsh_events_path, "utf-8");
      const results = new Map<string, string>();
      const calls: { callId: string | null; cmd: string }[] = [];
      for (const line of jsonl.split("\n")) {
        if (!line.trim()) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (ev.type === "tool_result") {
          const id = ev.callId == null ? "" : String(ev.callId);
          results.set(id, String(ev.result ?? ev.output ?? ""));
          continue;
        }
        if (ev.type === "tool_call" && String(ev.tool ?? "") === "bash") {
          const input = (ev.input ?? {}) as Record<string, unknown>;
          calls.push({ callId: ev.callId == null ? null : String(ev.callId), cmd: String(input.command ?? "") });
        }
      }
      for (const c of calls) {
        if (!isAgentGithubWrite(c.cmd)) continue;
        writes.push(c.cmd.trim());
        const res = c.callId != null ? results.get(c.callId) : undefined;
        details.push({ command: c.cmd.trim(), result: res == null ? null : res.slice(0, 4000) });
      }
    }
    return { runId: r.id, state: r.state, exitCode: r.exit_code, headSha: r.head_sha, baseHeadSha: r.base_head_sha, dshJsonl: r.dsh_events_path };
  });
  return { agentGithubWrites: writes, agentGithubWriteDetails: details, runs };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "relay-ish885b-real-"));
  // Raw per-Run dsh evidence (dsh.jsonl / stdout / stderr) is kept OUTSIDE the
  // disposable `dir` so a failed run stays diagnosable after cleanup.
  const runsRoot = process.env.RELAY_ISH885B_RUNS ?? join(tmpdir(), `ish885b-e2e-runs-${Date.now().toString(36)}`);
  mkdirSync(runsRoot, { recursive: true });
  const evidencePath = process.env.RELAY_ISH885B_EVIDENCE ?? join(process.cwd(), "docs", "ish885b-real-agent-e2e-evidence.json");
  const startedAt = new Date().toISOString();
  const evidence: Record<string, unknown> = {
    task: "T18 / ISH-885 item 1",
    architecture: "read-only Relay; Agent-owned GitHub writes; independent Claude native review",
    repo: REPO,
    base: BASE,
    startedAt,
    runsRoot,
    legs: [] as { leg: string; verdict: Leg; detail: string }[],
    githubWriter: "PENDING",
    independentClaudeJudgment: "PENDING",
    relayGithubWrites: "PENDING",
    result: "PENDING",
    steps: [] as unknown[],
  };
  const leg = (name: string, verdict: Leg, detail: string) => {
    (evidence.legs as { leg: string; verdict: Leg; detail: string }[]).push({ leg: name, verdict, detail });
    console.log(`  ${verdict.padEnd(8)} ${name}: ${detail}`);
  };
  const step = (name: string, data: Record<string, unknown>) => {
    (evidence.steps as unknown[]).push({ step: name, ...data, at: new Date().toISOString() });
  };

  const mc = resolveMainCheckout(projectRoot());
  if (!mc || !mc.isMain) throw new Error(`not a main checkout: ${JSON.stringify(mc)}`);
  const repo = mc.root;

  // ---- preconditions (fail closed, recorded) --------------------------------
  const ghUser = sh("gh", ["api", "user", "-q", ".login"]);
  const dshV = sh("dsh", ["--version"]);
  const claudeV = sh("claude", ["--version"]);
  const sbxSecret = sh("sbx", ["secret", "ls"]).out;
  const ghPlaceholder = resolveGithubPlaceholder(sbxSecret);
  leg("env.gh", ghUser.ok ? "PASS" : "BLOCKED", ghUser.ok ? `gh authenticated as ${ghUser.out}` : `gh not authenticated: ${ghUser.err}`);
  leg("env.dsh", dshV.out.startsWith("0.2.1-rc.2") ? "PASS" : "FAIL", `dsh ${dshV.out || "MISSING"} (pin 0.2.1-rc.2)`);
  leg("env.claude", claudeV.ok ? "PASS" : "BLOCKED", `claude ${claudeV.out}`);
  leg(
    "env.sbx-github-credential",
    ghPlaceholder ? "PASS" : "BLOCKED",
    ghPlaceholder
      ? `a global sbx CUSTOM secret binds GH_TOKEN to api.github.com (placeholder ${ghPlaceholder.slice(0, 12)}…)`
      : "no sbx CUSTOM secret for GH_TOKEN@api.github.com: run " +
        "`printf '%s' \"$(gh auth token)\" | sbx secret set-custom --host api.github.com --host github.com --env GH_TOKEN`"
  );

  const db = openDb(join(dir, "state.db"));
  const github = new GhCliGitHub(defaultExec);
  const branch = `relay/ish885b-e2e-${Date.now().toString(36)}`;
  let prNumber: number | null = null;
  let sandboxName: string | null = null;

  try {
    // ISH-885b fixture: the DESCRIPTION mentions only the first artifact, while the
    // ACCEPTANCE enumerates all three — so a genuinely partial first pass reaches
    // REVIEW and an INDEPENDENT reviewer (not a script) is what returns NG@A.
    const task = intakeTask(db, {
      provider: "fixture",
      issueId: "ISH-885B-E2E",
      codeChange: true,
      title: "ISH-885b real Agent-owned PR fixture",
      // A general CONTRACT (not an enumerated example list) with many edge cases:
      // a first-pass parser commonly mishandles one of them, and the INDEPENDENT
      // reviewer must find it from the diff on its own — no pre-filled verdict.
      description:
        "Add `src/ish885b/duration.ts` exporting `parseDuration(s: string): number` that parses a duration string into " +
        "whole milliseconds. Also add `docs/ish885b/AGENT-E2E.md` whose first line is exactly `# ISH-885b Agent E2E`. " +
        "Commit on this branch, `git push`, and open a PR against `main`.",
      acceptance:
        "ALL must hold at the reviewed commit. (1) `parseDuration` is correct and COMPLETE for its contract: it accepts " +
        "an integer or decimal quantity followed by a unit among `ms`, `s`, `m`, `h`, `d` (units are case-INSENSITIVE), and " +
        "accepts ONE OR MORE components concatenated with no separator (e.g. `1h30m`, `1d2h3m4s`); it returns the total in " +
        "whole milliseconds rounded to the nearest millisecond (half up). It MUST return `-1` for ANY malformed input — " +
        "specifically including an empty string, surrounding whitespace, a bare number with no unit, an unknown unit, a unit " +
        "with no quantity, a negative sign, and a repeated unit. " +
        "(2) `docs/ish885b/AGENT-E2E.md` exists with first line exactly `# ISH-885b Agent E2E`. " +
        "(3) the commit is pushed to the feature branch and an OPEN pull request against `main` exists (run `gh pr create` yourself — Relay never creates the PR).",
      checks: [fixtureCheck()],
      prRepo: REPO,
      prBase: BASE,
      branch,
    });
    step("intake", { taskId: task.id, branch, prRepo: REPO, prBase: BASE, check: fixtureCheck() });

    // ISH-878: `implementTarget` selects the Sandbox-backed path ONLY when the Task
    // already has a durable sandbox row; with none it deliberately runs on the
    // HOST worktree. Create the Coding Sandbox from the kit BEFORE the factory so
    // the dsh Agent runs INSIDE the sandbox (never a host worktree).
    process.env.RELAY_SANDBOX_AGENT = CODING_KIT;
    const binding = ensureTaskSandbox(db, task.id, { source: repo, agent: CODING_KIT, cli: realSbxCli });
    sandboxName = binding.name;
    step("sandbox-created", { name: binding.name, agent: CODING_KIT, workspace: binding.workspace, branch: binding.branch, created: binding.created });
    leg("coding-sandbox", "PASS", `dsh Agent runs inside Coding Sandbox ${binding.name} (kit ${CODING_KIT})`);
    // Operator provisioning: pin GitHub's `ssh.github.com:443` host key (the kit
    // routes github.com there because the egress policy has no :22 rule) so the
    // Agent's `git push` does not fail on first-connection host verification. The
    // Agent still performs the push/PR write itself.
    const kh = realSbxCli.run(
      sbxExecArgv(binding.name, bashLc("mkdir -p ~/.ssh && ssh-keyscan -p 443 ssh.github.com 2>/dev/null > ~/.ssh/known_hosts && chmod 600 ~/.ssh/known_hosts && wc -l < ~/.ssh/known_hosts"), {
        workdir: binding.workspace,
      })
    );
    leg("sandbox-known-hosts", kh.ok ? "PASS" : "NOT_RUN", kh.ok ? `pinned ssh.github.com host key (${kh.out.trim()} line(s))` : `could not pin host key: ${kh.err || kh.out}`);
    // The dsh Agent's bash tool runs with a SANITIZED env (no GH_TOKEN/GITHUB_TOKEN
    // reaches it), so an env-injected credential is invisible to the Agent. Give
    // `gh` a config file instead: `~/.config/gh/hosts.yml` carries the PROXY
    // PLACEHOLDER (never the real token), and the egress proxy substitutes the real
    // token on the wire for api.github.com.
    let ghConfigWrote = false;
    if (ghPlaceholder) {
      const cfg = `github.com:\n    oauth_token: ${ghPlaceholder}\n    user: ${ghUser.out || "81ueman"}\n    git_protocol: ssh\n`;
      const w = realSbxCli.run(
        sbxExecArgv(binding.name, bashLc(`mkdir -p ~/.config/gh && printf '${cfg}' > ~/.config/gh/hosts.yml && chmod 600 ~/.config/gh/hosts.yml && wc -c < ~/.config/gh/hosts.yml`), {
          workdir: binding.workspace,
        })
      );
      ghConfigWrote = w.ok;
      leg("sandbox-gh-config", w.ok ? "PASS" : "FAIL", w.ok ? `wrote ~/.config/gh/hosts.yml with the proxy placeholder (${w.out.trim()} bytes)` : `could not write hosts.yml: ${w.err || w.out}`);
    }
    // Prove the SANDBOX's `gh` really works through the credential proxy in an env
    // WITHOUT GH_TOKEN (exactly what the Agent's sanitized shell sees).
    const ghPre = realSbxCli.run(
      sbxExecArgv(binding.name, bashLc("env -u GH_TOKEN -u GITHUB_TOKEN gh api user -q .login"), { workdir: binding.workspace })
    );
    leg(
      "sandbox-gh-api",
      ghPre.ok && ghPre.out.includes(ghUser.out) ? "PASS" : "BLOCKED",
      ghPre.ok ? `sandbox gh authenticated as ${ghPre.out.trim()} (hosts.yml proxy placeholder, GH_TOKEN unset)` : `sandbox gh failed: ${(ghPre.err || ghPre.out).slice(0, 300)}`
    );
    if (!ghConfigWrote) throw new Error("the sandbox gh credential config could not be written");

    const result = await runFactoryTask(db, task.id, {
      repo,
      outputRoot: runsRoot,
      permissionMode: "workspace-write",
      timeoutMs: 20 * 60_000,
      maxAttempts: 3,
      sandboxCli: realSbxCli,
      dshBin: process.env.RELAY_DSH_BIN ?? "dsh",
      // NOTE: an env-injected GH_TOKEN is useless — dsh's bash tool runs with a
      // sanitized env. The Agent's `gh` credential is provided via the proxy
      // placeholder written to ~/.config/gh/hosts.yml above.
      reviewerCommand: "claude",
      reviewerModel: process.env.RELAY_REVIEW_MODEL ?? "opus",
      reviewWorktreeRoot: join(dir, "review-wt"),
      nativeReview: { reader: github, github, author: ghUser.out || "81ueman", allowedTools: "Read Grep Glob Bash" },
      prBinding: { github },
    });
    evidence.factoryResult = { outcome: result.outcome, head: result.head, reason: result.reason, attempts: result.attempts, gate: result.gate?.status ?? null };
    step("factory-result", evidence.factoryResult as Record<string, unknown>);

    // ---- actor evidence: did the dsh AGENT do the GitHub writes? -------------
    const runRows = db
      .query("SELECT id, state, exit_code, head_sha, base_head_sha, dsh_events_path FROM runs WHERE task_id = ? ORDER BY created_at")
      .all(task.id) as { id: string; state: string; exit_code: number | null; head_sha: string | null; base_head_sha: string | null; dsh_events_path: string | null }[];
    const actor = extractAgentGithubWrites(dir, runRows);
    evidence.actorEvidence = actor;
    const pushedByAgent = actor.agentGithubWrites.some((c) => /\bgit\s+push\b/.test(c));
    const prCreateAttempted = actor.agentGithubWrites.some((c) => /\bgh\s+pr\s+(create|edit)\b/.test(c));
    leg(
      "dsh-agent-push",
      pushedByAgent ? "PASS" : "FAIL",
      pushedByAgent ? `dsh Agent ran git push in the Coding Sandbox (${actor.agentGithubWrites.length} GitHub-write tool call(s))` : "no dsh `git push` tool call found in dsh.jsonl"
    );
    leg("dsh-agent-pr-write", prCreateAttempted ? "PASS" : "FAIL", prCreateAttempted ? "dsh Agent ran `gh pr create`/`gh pr edit` in the Coding Sandbox" : "no dsh `gh pr create` tool call found");
    evidence.githubWriter = pushedByAgent && prCreateAttempted ? "dsh/DeepSeek Coding Agent (from dsh.jsonl tool calls)" : "NOT the dsh Agent";
    if (prCreateAttempted) {
      const createDetail = actor.agentGithubWriteDetails.find((d) => /\bgh\s+pr\s+(create|edit)\b/.test(d.command));
      step("dsh-gh-pr-create", { command: createDetail?.command ?? null, result: createDetail?.result ?? null });
    }

    // ---- Relay read-back: PR identity, HEADs, native reviews -----------------
    const t = getTask(db, task.id)!;
    const ref = parsePrUrl(t.pr_url, t.pr_repo);
    prNumber = ref?.number ?? null;
    // Even when the factory BLOCKS (e.g. the Agent's PR create failed), record and
    // clean up the branch's PR if one exists — never leak a disposable fixture.
    if (!prNumber) {
      const found = github.findPullRequestForBranch(REPO, branch);
      if (found) prNumber = found.ref.number;
    }
    leg("dsh-agent-pr-created", prNumber ? "PASS" : "FAIL", prNumber ? `a real PR #${prNumber} exists for ${branch}` : `no PR exists for ${branch} (the Agent's gh pr create did not land)`);
    evidence.task = {
      id: t.id,
      headSha: t.head_sha,
      branch: t.branch,
      prUrl: t.pr_url,
      prRepo: t.pr_repo,
      prBase: t.pr_base,
      attempt: t.attempt,
      phase: t.phase,
      state: t.state,
      mergedAt: t.merged_at,
    };
    step("task-final", evidence.task as Record<string, unknown>);
    if (ref) prNumber = ref.number;

    // Relay's own GitHub writes: static — no write ARGV (not merely a doc string)
    // anywhere under src/. Matches constructed command tokens only.
    const writeArgvRe = "\"git\",[[:space:]]*\"push\"|\"gh\",[[:space:]]*\"pr\",[[:space:]]*\"(create|edit|merge|review|comment)\"|\"--method\",[[:space:]]*\"(POST|PATCH|PUT|DELETE)\"";
    const staticWrites = sh("bash", ["-lc", `grep -rnE '${writeArgvRe}' src/ | head`], { cwd: repo });
    evidence.relayGithubWrites = staticWrites.out === "" ? "NONE (no write argv in src/)" : `FOUND: ${staticWrites.out}`;
    leg("relay-zero-github-writes", staticWrites.out === "" ? "PASS" : "FAIL", staticWrites.out === "" ? "no GitHub write argv in src/ (static)" : staticWrites.out.slice(0, 300));

    // Native reviews actually on the PR, read back from GitHub.
    let reviews: { id: number; user?: { login?: string }; state?: string; commit_id?: string; body?: string }[] = [];
    if (prNumber) {
      const rl = sh("gh", ["api", `repos/${REPO}/pulls/${prNumber}/reviews`]);
      if (rl.ok) {
        try {
          reviews = JSON.parse(rl.out) as typeof reviews;
        } catch {
          reviews = [];
        }
      }
    }
    const ngA = reviews.find((r) => /verdict=NG/.test(r.body ?? ""));
    const okB = reviews.find((r) => /verdict=OK/.test(r.body ?? ""));
    evidence.reviews = reviews.map((r) => ({ id: r.id, author: r.user?.login, state: r.state, headSha: r.commit_id, marker: /verdict=(NG|OK|HOLD)/.exec(r.body ?? "")?.[1] ?? null }));
    leg("claude-native-NG@A", ngA ? "PASS" : "FAIL", ngA ? `native review ${ngA.id} by ${ngA.user?.login} NG @ ${(ngA.commit_id ?? "").slice(0, 10)}` : "no NG review on the PR");
    leg("claude-native-PASS@B", okB ? "PASS" : "FAIL", okB ? `native review ${okB.id} by ${okB.user?.login} OK @ ${(okB.commit_id ?? "").slice(0, 10)}` : "no OK review on the PR");
    const distinctHeads = !!ngA && !!okB && ngA.commit_id !== okB.commit_id;
    evidence.independentClaudeJudgment = ngA && okB && distinctHeads ? "real: NG@A then OK@B by an independent headless Claude" : "NOT_PROVEN";
    leg("distinct-reviewed-heads-A-B", distinctHeads ? "PASS" : "FAIL", distinctHeads ? `A=${(ngA!.commit_id ?? "").slice(0, 10)} B=${(okB!.commit_id ?? "").slice(0, 10)} on PR #${prNumber}` : "A/B not both present as distinct reviewed HEADs");

    // The whole chain: dsh writes + independent NG->FIX->PASS + MergeReady.
    const fixIdx = result.attempts.findIndex((a) => a.reviewVerdict === "fix");
    const passIdx = result.attempts.findIndex((a, i) => a.reviewVerdict === "pass" && fixIdx !== -1 && i > fixIdx);
    const chainOk =
      result.outcome === "merge_ready" &&
      pushedByAgent &&
      !!prNumber &&
      distinctHeads &&
      fixIdx !== -1 &&
      passIdx > fixIdx &&
      !!(result.head && result.attempts[result.attempts.length - 1]?.producedHead === result.head);
    evidence.chainProven = chainOk;
    leg("full-chain", chainOk ? "PASS" : "FAIL", chainOk ? "dsh Agent push/PR -> Relay bind A -> Claude NG@A -> dsh FIX B -> Relay bind B -> Claude PASS@B -> MergeReady (read-only)" : `outcome=${result.outcome} fixIdx=${fixIdx} passIdx=${passIdx}`);
    evidence.result = chainOk ? "PASS" : "FAIL";
  } catch (e) {
    evidence.error = e instanceof Error ? e.stack ?? e.message : String(e);
    evidence.result = "FAIL";
    console.error(`ISH-885b run error: ${evidence.error}`);
  } finally {
    // ---- cleanup AFTER evidence is retained ---------------------------------
    const sb = (() => {
      try {
        const t = db.query("SELECT id FROM tasks LIMIT 1").get() as { id: string } | null;
        return t ? getSandbox(db, t.id) : null;
      } catch {
        return null;
      }
    })();
    sandboxName = sb?.name ?? null;
    const cleanup: Record<string, unknown> = {};
    if (prNumber) {
      const closed = sh("gh", ["pr", "close", String(prNumber), "--repo", REPO]);
      cleanup.prClosed = closed.ok || closed.err.includes("already closed");
    }
    // Delete the disposable feature branch whether or not a PR was created.
    const del = sh("git", ["-C", repo, "push", "origin", "--delete", branch]);
    cleanup.branchDeleted = del.ok || /remote ref does not exist/i.test(del.err) || /deleted/i.test(del.err);
    if (sandboxName) {
      sh("sbx", ["stop", sandboxName]);
      const rm = sh("sbx", ["rm", "--force", sandboxName]);
      cleanup.sandboxRemoved = rm.ok;
      sh("git", ["-C", repo, "remote", "remove", `sandbox-${sandboxName}`]);
    }
    cleanup.tempDir = dir;
    evidence.cleanup = cleanup;
    evidence.finishedAt = new Date().toISOString();
    try {
      mkdirSync(join(process.cwd(), "docs"), { recursive: true });
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    } catch {
      /* best effort */
    }
    db.close();
    rmSync(dir, { recursive: true, force: true });
    console.log(`\nresult=${evidence.result}  evidence: ${evidencePath}`);
    if (evidence.result !== "PASS") process.exitCode = 1;
  }
}

if (import.meta.main) {
  if (process.env.RELAY_ISH885B_E2E !== "1") {
    console.log("ISH-885b real Agent-owned GitHub E2E is opt-in: set RELAY_ISH885B_E2E=1 to run it (real sandbox + real PR).");
    process.exit(0);
  }
  try {
    await main();
  } catch (e) {
    console.error(`ISH-885b E2E crashed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
