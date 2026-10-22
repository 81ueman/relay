import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { claimTask, getTask } from "../src/tasks";
import { registerWorker } from "../src/workers";
import {
  findPassingReview,
  intakeTask,
  recordReview,
  recordVerification,
  submitPhase,
} from "../src/workflow";
import { insertTaskResult } from "../src/results";
import { inheritFindings } from "../src/run-lifecycle";
import { requestRebase } from "../src/rebase";
import { checkMergeGate } from "../src/merge-gate";
import { FakeGitHub, type PrView, type ProviderAuthority } from "../src/providers";

// ISH-1122: a merge_ready Task whose PR has become CONFLICTING can be returned by
// the coordinator (integrator / Gateway) to implement at attempt+1 with the
// reason as the FIX brief. It is NOT a review verdict: an unresolved NG/HOLD is
// refused, and the old PASS can no longer satisfy the merge gate.

const HEAD = "a".repeat(40);
const BASE = "0".repeat(40);
const REASON = "sibling lane merged first: rebase onto origin/main, then re-run checks";
const GRANT: ProviderAuthority = { linearWrite: false, merge: true };

function view(over: Partial<PrView> = {}): PrView {
  return {
    ref: { repo: "o/r", number: 1 },
    url: "https://github.com/o/r/pull/1",
    state: "open",
    isDraft: false,
    headRefName: "feat/x",
    headSha: HEAD,
    baseRef: "main",
    baseSha: BASE,
    mergeable: "conflicting",
    labels: [],
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

let dir = "";
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-ish1122-"));
  process.env.RELAY_DB = join(dir, "state.db");
  db = openDb(process.env.RELAY_DB);
  registerWorker(db, "impl", { role: "worker" });
  registerWorker(db, "rev", { role: "reviewer" });
  registerWorker(db, "integ", { role: "integrator" });
  delete process.env.RELAY_HUMAN;
});

afterEach(() => {
  delete process.env.RELAY_HUMAN;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function intake(id: string, over: { prUrl?: string } = {}) {
  return intakeTask(db, {
    provider: "github",
    issueId: id,
    codeChange: true,
    headSha: HEAD,
    prUrl: over.prUrl ?? "https://github.com/o/r/pull/1",
    prRepo: "o/r",
    branch: "feat/x",
  });
}

/** Drive a task implement -> review -> merge_ready with a real passing review at HEAD. */
function toMergeReady(id: string): void {
  claimTask(db, id, "impl");
  submitPhase(db, id, "impl", { headSha: HEAD });
  claimTask(db, id, "impl"); // verify phase (manual, no mechanical checks)
  recordVerification(db, id, "impl", { passed: true, headSha: HEAD });
  recordReview(db, id, "rev", { verdict: "pass", headSha: HEAD });
  claimTask(db, id, "integ");
  submitPhase(db, id, "integ", { headSha: HEAD });
}

function conflictGithub(): FakeGitHub {
  return new FakeGitHub().putPullRequest(view());
}

function countReviewResults(taskId: string): number {
  const row = db
    .query(`SELECT COUNT(*) AS n FROM task_results WHERE task_id = ? AND kind = 'ReviewResult'`)
    .get(taskId) as { n: number };
  return row.n;
}

describe("ISH-1122: coordinator rebase route for a merge_ready + CONFLICTING PR", () => {
  test("the integrator returns the Task to implement at attempt+1 and the old PASS stops satisfying the gate", () => {
    const gh = conflictGithub();
    const t = intake("ISH-1122-1");
    toMergeReady(t.id);
    const before = getTask(db, t.id)!;
    expect(before.phase).toBe("merge_ready");
    expect(before.head_sha).toBe(HEAD);
    const reviewsBefore = countReviewResults(t.id);

    const updated = requestRebase(db, t.id, "integ", { reason: REASON, deps: { github: gh } });

    expect(updated.phase).toBe("implement");
    expect(updated.state).toBe("queued");
    expect(updated.attempt).toBe(before.attempt + 1);
    expect(updated.head_sha).toBeNull();
    // NOT a review verdict: the ReviewResult table is untouched.
    expect(countReviewResults(t.id)).toBe(reviewsBefore);
    expect(findPassingReview(db, t.id, before.attempt)).not.toBeNull();
    expect(findPassingReview(db, t.id, updated.attempt)).toBeNull();

    // The reason is the next implement Run's FIX brief.
    const findings = inheritFindings(db, updated);
    const rebase = findings.find((f) => f.kind === "RebaseRequested");
    expect(rebase?.reason).toBe(REASON);
    expect(rebase?.headSha).toBe(HEAD);

    // The old PASS no longer authorises a merge at the new attempt/phase.
    const gate = checkMergeGate(db, t.id, { github: gh, checks: gh, authority: GRANT })!;
    expect(gate.status).toBe("BLOCKED");
    expect(gate.reasons.map((r) => r.code)).toContain("NOT_MERGE_READY");

    // The decision is auditable as a rebase event, not a review result.
    const event = db
      .query(
        `SELECT payload_json FROM events WHERE task_id = ? AND type = 'workflow.rebase_requested' ORDER BY id DESC LIMIT 1`
      )
      .get(t.id) as { payload_json: string };
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    expect(payload.reason).toBe(REASON);
    expect(payload.fromAttempt).toBe(before.attempt);
    expect(payload.toAttempt).toBe(updated.attempt);
    expect(payload.supersededPass).toEqual(expect.any(Number));
  });

  test("the Gateway/human identity may rebase too", () => {
    process.env.RELAY_HUMAN = "gateway";
    const gh = conflictGithub();
    const t = intake("ISH-1122-2");
    toMergeReady(t.id);
    const before = getTask(db, t.id)!;

    const updated = requestRebase(db, t.id, "gateway", { reason: REASON, deps: { github: gh } });
    expect(updated.phase).toBe("implement");
    expect(updated.attempt).toBe(before.attempt + 1);
    expect(updated.head_sha).toBeNull();
  });

  test("a non-integrator / non-gateway identity is refused and nothing changes", () => {
    const gh = conflictGithub();
    const t = intake("ISH-1122-3");
    toMergeReady(t.id);
    const before = getTask(db, t.id)!;

    expect(() => requestRebase(db, t.id, "impl", { reason: REASON, deps: { github: gh } })).toThrow(/AUTHORITY/);
    const after = getTask(db, t.id)!;
    expect(after.phase).toBe("merge_ready");
    expect(after.attempt).toBe(before.attempt);
    expect(after.head_sha).toBe(HEAD);
  });

  test("refused when the Task is not merge_ready", () => {
    const gh = conflictGithub();
    const t = intake("ISH-1122-4");
    // At implement, still with a recorded head.
    expect(getTask(db, t.id)!.phase).toBe("implement");
    expect(() => requestRebase(db, t.id, "integ", { reason: REASON, deps: { github: gh } })).toThrow(
      /not merge_ready|only at merge_ready/i
    );
    expect(getTask(db, t.id)!.phase).toBe("implement");
  });

  test("refused when the PR is mergeable, unknown or unreadable", () => {
    const t = intake("ISH-1122-5");
    toMergeReady(t.id);
    const before = getTask(db, t.id)!;

    const mergeable = new FakeGitHub().putPullRequest(view({ mergeable: "mergeable" }));
    expect(() => requestRebase(db, t.id, "integ", { reason: REASON, deps: { github: mergeable } })).toThrow(
      /not conflicting/
    );
    const unknown = new FakeGitHub().putPullRequest(view({ mergeable: "unknown" }));
    expect(() => requestRebase(db, t.id, "integ", { reason: REASON, deps: { github: unknown } })).toThrow(
      /not conflicting/
    );
    const unreadable = new FakeGitHub();
    expect(() => requestRebase(db, t.id, "integ", { reason: REASON, deps: { github: unreadable } })).toThrow(
      /no pull request bound|not be read/
    );
    const after = getTask(db, t.id)!;
    expect(after.phase).toBe("merge_ready");
    expect(after.attempt).toBe(before.attempt);
    expect(after.head_sha).toBe(HEAD);
  });

  test("an unresolved reviewer NG/HOLD at the current HEAD is refused (never cleared)", () => {
    const gh = conflictGithub();
    const t = intake("ISH-1122-6");
    toMergeReady(t.id);
    const before = getTask(db, t.id)!;
    const pass = findPassingReview(db, t.id, before.attempt)!;
    // Replace the PASS at the same identity with an unresolved NG/HOLD (the same
    // shape a reviewer's later NG at the HEAD takes).
    insertTaskResult(db, {
      taskId: t.id,
      phase: "review",
      attempt: before.attempt,
      kind: "ReviewResult",
      workerId: "rev",
      passed: false,
      headSha: HEAD,
      profile: "default",
      reason: "NG: do not merge this head",
      payload: { reviewer: "rev" },
      supersedes: pass.id,
    });
    const reviewsBefore = countReviewResults(t.id);

    expect(() => requestRebase(db, t.id, "integ", { reason: REASON, deps: { github: gh } })).toThrow(
      /unresolved reviewer NG\/HOLD/
    );
    const after = getTask(db, t.id)!;
    expect(after.phase).toBe("merge_ready");
    expect(after.attempt).toBe(before.attempt);
    expect(after.head_sha).toBe(HEAD);
    expect(countReviewResults(t.id)).toBe(reviewsBefore);
  });

  test("refused when the observed PR head is not the recorded HEAD", () => {
    const gh = new FakeGitHub().putPullRequest(view({ headSha: "b".repeat(40) }));
    const t = intake("ISH-1122-7");
    toMergeReady(t.id);
    const before = getTask(db, t.id)!;
    expect(() => requestRebase(db, t.id, "integ", { reason: REASON, deps: { github: gh } })).toThrow(
      /HEAD_MISMATCH|not of this work/
    );
    expect(getTask(db, t.id)!.phase).toBe("merge_ready");
    expect(getTask(db, t.id)!.attempt).toBe(before.attempt);
  });

  test("a structured owner HOLD is refused, never cleared", () => {
    const gh = conflictGithub();
    const t = intakeTask(db, {
      provider: "linear",
      issueId: "ISH-1122-hold",
      codeChange: true,
      headSha: HEAD,
      prUrl: "https://github.com/o/r/pull/1",
      prRepo: "o/r",
      branch: "feat/x",
    });
    toMergeReady(t.id);
    const linear = {
      name: "fake-linear",
      readOnly: true as const,
      getIssue: () => ({ id: "ISH-1122-hold", state: "In Progress", labels: ["hold"], updatedAt: "" }),
    };
    expect(() =>
      requestRebase(db, t.id, "integ", { reason: REASON, deps: { github: gh, linear } })
    ).toThrow(/owner HOLD/);
    expect(getTask(db, t.id)!.phase).toBe("merge_ready");
  });

  test("a reason is required", () => {
    const gh = conflictGithub();
    const t = intake("ISH-1122-8");
    toMergeReady(t.id);
    expect(() => requestRebase(db, t.id, "integ", { reason: "   ", deps: { github: gh } })).toThrow(
      /reason/
    );
    expect(getTask(db, t.id)!.phase).toBe("merge_ready");
  });

  test("the CLI reads the bound PR through the read-only gh reader and routes it back", () => {
    const t = intake("ISH-1122-9");
    toMergeReady(t.id);
    const before = getTask(db, t.id)!;
    const binDir = join(dir, "bin");
    const gh = join(binDir, "gh");
    mkdirSync(binDir, { recursive: true });    writeFileSync(
      gh,
      `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  cat <<'JSON'
{"url":"https://github.com/o/r/pull/1","state":"OPEN","isDraft":false,"headRefName":"feat/x","headRefOid":"${before.head_sha}","baseRefName":"main","baseRefOid":"${BASE}","mergeable":"CONFLICTING","labels":[],"updatedAt":"2026-01-01T00:00:00Z","number":1,"isCrossRepository":false,"headRepository":{"nameWithOwner":"o/r"}}
JSON
  exit 0
fi
exit 1
`
    );
    chmodSync(gh, 0o755);
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const r = Bun.spawnSync(
      ["bun", cli, "result", "rebase", t.id, "--reason", REASON, "--worker", "integ"],
      {
        env: {
          ...process.env,
          RELAY_DB: process.env.RELAY_DB!,
          RELAY_PROVIDER_GITHUB: "gh",
          PATH: `${binDir}:${process.env.PATH}`,
        },
      }
    );
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
    const after = getTask(db, t.id)!;
    expect(after.phase).toBe("implement");
    expect(after.state).toBe("queued");
    expect(after.attempt).toBe(before.attempt + 1);
    expect(after.head_sha).toBeNull();
  });
});
