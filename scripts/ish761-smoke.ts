#!/usr/bin/env bun
/**
 * ISH-761 dry-run, READ-ONLY smoke: read a REAL GitHub PR through the read-only
 * `gh` adapter and run the HEAD-bound merge gate over it.
 *
 * It performs NO writes of any kind: no branch push, no comment/label, no merge,
 * no Linear write. The only network verbs are `gh pr view` + `gh api` GETs. The
 * review evidence is SYNTHETIC (so the smoke isolates the provider-driven
 * conditions); the PR facts (state/draft/head/base/mergeable/checks) are REAL.
 *
 *   bun scripts/ish761-smoke.ts 81ueman/relay#7
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultExec, GhCliGitHub } from "../src/provider-adapters";
import { parsePrUrl, rollupChecks } from "../src/providers";
import { openDb } from "../src/db";
import { intakeTask } from "../src/workflow";
import { insertTaskResult } from "../src/results";
import { checkMergeGate } from "../src/merge-gate";

const target = process.argv[2] ?? "81ueman/relay#7";
const ref = parsePrUrl(target, null);
if (!ref) {
  console.error("usage: bun scripts/ish761-smoke.ts owner/repo#n");
  process.exit(2);
}

const gh = new GhCliGitHub(defaultExec);
const view = gh.getPullRequest(ref);
if (!view) {
  console.error(`could not read ${target} (is gh authenticated? gh auth status)`);
  process.exit(1);
}
const checks = gh.listChecks(ref, view.headSha);
const raw = {
  url: view.url,
  state: view.state,
  isDraft: view.isDraft,
  head: view.headSha,
  base: `${view.baseRef}@${view.baseSha.slice(0, 10)}`,
  mergeable: view.mergeable,
  labels: view.labels,
  checks: checks === null ? "UNREADABLE (NOT_RUN)" : rollupChecks(checks),
};

const dir = mkdtempSync(join(tmpdir(), "relay-ish761-smoke-"));
process.env.RELAY_DB = join(dir, "state.db");
const db = openDb(process.env.RELAY_DB);
try {
  const t = intakeTask(db, {
    provider: "github",
    issueId: `${ref.repo}#${ref.number}`,
    codeChange: true,
    headSha: view.headSha,
    prUrl: view.url,
    prRepo: ref.repo,
    branch: view.headRefName,
    prBase: view.baseRef,
    prBaseSha: view.baseSha,
  });
  // The smoke evaluates a merge_ready candidate with SYNTHETIC review evidence
  // bound to the REAL head; everything provider-side is read live.
  db.query(`UPDATE tasks SET phase = 'merge_ready', state = 'queued', attempt = 0 WHERE id = ?`).run(t.id);
  insertTaskResult(db, {
    taskId: t.id,
    phase: "merge_ready",
    attempt: 0,
    kind: "ReviewResult",
    workerId: "smoke:reviewer",
    passed: true,
    headSha: view.headSha,
    profile: "default",
    evidenceRef: "smoke:synthetic-review",
    payload: { source: "smoke", reviewer: "smoke:reviewer" },
  });
  const decision = checkMergeGate(db, t.id, { github: gh, checks: gh });
  console.log(JSON.stringify({ target, readOnly: true, raw, decision }, null, 2));
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
