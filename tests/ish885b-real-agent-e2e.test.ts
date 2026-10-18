import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateChain, extractAgentGithubWrites, fixtureCheck, resolveGithubPlaceholder, REPO, BASE } from "../scripts/ish885b-real-agent-e2e";

/**
 * ISH-885 item 1: the harness must attribute the GitHub writes to the dsh AGENT
 * (parsed from the per-Run dsh JSONL), never to the script. These tests pin the
 * parsing and the fixture so a future edit cannot quietly stop proving it.
 */

function jsonl(lines: Record<string, unknown>[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

describe("ISH-885b harness: fixture", () => {
  test("the required check only asserts the FILES exist; the behavioural rounding is left to the reviewer", () => {
    const c = fixtureCheck();
    expect(c.required).toBe(true);
    expect(c.command).toContain("docs/ish885b/AGENT-E2E.md");
    expect(c.command).toContain("src/ish885b/duration.ts");
    // The parser's behaviour is NOT in the mechanical check: the independent
    // reviewer must judge it from the diff, which is what produces the NG@A.
    expect(c.command).not.toContain("parseDuration");
  });

  test("the fixture targets the relay repo on main", () => {
    expect(REPO).toBe("81ueman/relay");
    expect(BASE).toBe("main");
  });
});

describe("ISH-885b harness: sbx GitHub credential placeholder", () => {
  test("resolves the custom-secret GH_TOKEN placeholder for api.github.com", () => {
    const out = [
      "SERVICE SECRETS",
      "SCOPE        TYPE      NAME     SECRET",
      "(global)     service   github   (stored)",
      "",
      "CUSTOM SECRETS",
      "SCOPE        TARGETS                      ENV        PLACEHOLDER               SECRET",
      "(global)     ollama.com                   OLLAMA_CLOUD_V41_API_KEY  sbx-cs-xZqR7tkU9V0NPHfd  command:/x",
      "(global)     api.github.com, github.com   GH_TOKEN   sbx-cs-62TD7dOKvqdXa5P9   gho_aV...Lu1U",
    ].join("\n");
    expect(resolveGithubPlaceholder(out)).toBe("sbx-cs-62TD7dOKvqdXa5P9");
  });

  test("returns null when no GitHub custom secret is stored", () => {
    expect(resolveGithubPlaceholder("SERVICE SECRETS\n(global) service github (stored)")).toBeNull();
  });
});

describe("ISH-885b harness: agent GitHub-write attribution", () => {
  test("extracts the dsh bash tool calls that push / create the PR", () => {
    const dir = mkdtempSync(join(tmpdir(), "ish885b-attrib-"));
    const dsh = join(dir, "dsh.jsonl");
    writeFileSync(
      dsh,
      jsonl([
        { type: "text", text: "working" },
        { type: "tool_call", tool: "bash", input: { command: "git status --short" } },
        { type: "tool_call", tool: "bash", input: { command: "git commit -qm 'docs: fixture A'" } },
        { type: "tool_call", callId: "p1", tool: "bash", input: { command: "git push origin HEAD:refs/heads/relay/ish885b-e2e-x" } },
        { type: "tool_result", callId: "p1", result: "Everything up-to-date" },
        { type: "tool_call", callId: "c1", tool: "bash", input: { command: "gh pr create --repo 81ueman/relay --head relay/ish885b-e2e-x --base main --title t --body b" } },
        { type: "tool_result", callId: "c1", result: "GraphQL: Head sha can't be blank" },
      ])
    );
    const ev = extractAgentGithubWrites(dir, [
      { id: "run-1", state: "exited", exit_code: 0, head_sha: "a".repeat(40), base_head_sha: "b".repeat(40), dsh_events_path: dsh },
    ]);
    expect(ev.agentGithubWrites.some((c) => /\bgit\s+push\b/.test(c))).toBe(true);
    expect(ev.agentGithubWrites.some((c) => /\bgh\s+pr\s+create\b/.test(c))).toBe(true);
    // the real dsh tool_result is correlated by callId — so a FAILED create is
    // recorded with its exact error, never silently counted as a success.
    const create = ev.agentGithubWriteDetails.find((d) => /\bgh\s+pr\s+create\b/.test(d.command));
    expect(create?.result).toBe("GraphQL: Head sha can't be blank");
    expect(ev.runs[0]!.runId).toBe("run-1");
  });

  test("does NOT attribute a plain commit, a read, or a Relay-style read argv as a GitHub write", () => {
    const dir = mkdtempSync(join(tmpdir(), "ish885b-attrib2-"));
    const dsh = join(dir, "dsh.jsonl");
    writeFileSync(
      dsh,
      jsonl([
        { type: "tool_call", tool: "bash", input: { command: "git commit -qm x" } },
        { type: "tool_call", tool: "bash", input: { command: "gh pr view 1 --repo 81ueman/relay --json headRefOid" } },
        { type: "tool_call", tool: "bash", input: { command: "gh pr list --repo 81ueman/relay" } },
        // a READ that merely mentions the command in a quoted grep pattern must
        // NOT be attributed as the write (the run-2 false positive).
        { type: "tool_call", tool: "bash", input: { command: "grep -ac 'gh pr create' /run/sandbox/source/.relay/daemon.log" } },
        { type: "tool_call", tool: "read", input: { path: "src/x.ts" } },
      ])
    );
    const ev = extractAgentGithubWrites(dir, [
      { id: "run-2", state: "exited", exit_code: 0, head_sha: null, base_head_sha: null, dsh_events_path: dsh },
    ]);
    expect(ev.agentGithubWrites).toEqual([]);
  });

  test("a missing dsh JSONL path is not an error and yields no writes", () => {
    const ev = extractAgentGithubWrites("/nonexistent", [
      { id: "run-3", state: "failed", exit_code: 1, head_sha: null, base_head_sha: null, dsh_events_path: null },
    ]);
    expect(ev.agentGithubWrites).toEqual([]);
    expect(ev.runs[0]!.dshJsonl).toBeNull();
  });
});

/**
 * Owner decision 2026-10-18: the success condition is a REAL independent Claude PASS
 * at the reviewed HEAD; the NG@A -> FIX -> PASS@B arc is OPTIONAL. These tests pin
 * that a first-try PASS is a PASS, that the arc is recorded when it happens, and
 * that a missing review is still NOT_PROVEN (never a fabricated PASS).
 */
describe("ISH-885b harness: success predicate (arc optional)", () => {
  const base = {
    outcome: "merge_ready",
    pushedByAgent: true,
    prNumber: 40,
    finalHead: "b".repeat(40),
    lastProducedHead: "b".repeat(40),
  };

  test("a genuine first-try PASS at the reviewed head is PASS", () => {
    const r = evaluateChain({
      ...base,
      attemptVerdicts: ["pass"],
      reviews: [{ body: "second-opinion: verdict=OK", commit_id: base.finalHead }],
    });
    expect(r.chainOk).toBe(true);
    expect(r.passHeadMatches).toBe(true);
    expect(r.ngArc).toBe(false);
    expect(r.fixRoundOccurred).toBe(false);
    expect(r.independentClaudeJudgment).toContain("first-try");
  });

  test("the NG@A -> FIX -> PASS@B arc counts when it really occurs", () => {
    const a = "a".repeat(40);
    const r = evaluateChain({
      ...base,
      attemptVerdicts: ["fix", "pass"],
      reviews: [
        { body: "verdict=NG", commit_id: a },
        { body: "verdict=OK", commit_id: base.finalHead },
      ],
    });
    expect(r.chainOk).toBe(true);
    expect(r.ngArc).toBe(true);
    expect(r.fixRoundOccurred).toBe(true);
    expect(r.independentClaudeJudgment).toContain("NG@A then OK@B");
  });

  test("an OK review at a DIFFERENT head than the produced head is NOT proven", () => {
    const r = evaluateChain({
      ...base,
      attemptVerdicts: ["pass"],
      reviews: [{ body: "verdict=OK", commit_id: "c".repeat(40) }],
    });
    expect(r.passHeadMatches).toBe(false);
    expect(r.chainOk).toBe(false);
    expect(r.independentClaudeJudgment).toBe("NOT_PROVEN");
  });

  test("no independent review -> NOT_PROVEN, never PASS", () => {
    const r = evaluateChain({ ...base, attemptVerdicts: ["pass"], reviews: [] });
    expect(r.chainOk).toBe(false);
    expect(r.independentClaudeJudgment).toBe("NOT_PROVEN");
  });

  test("a moved head after the last attempt is not the reviewed head", () => {
    const r = evaluateChain({
      ...base,
      finalHead: "d".repeat(40),
      lastProducedHead: "b".repeat(40),
      attemptVerdicts: ["pass"],
      reviews: [{ body: "verdict=OK", commit_id: "d".repeat(40) }],
    });
    expect(r.chainOk).toBe(false);
  });
});
