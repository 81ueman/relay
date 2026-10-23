# ISH-1140 — hosted CI is not a merge gate

Status: implemented in Relay (this repo). The ishiul-side gateway/skill text is a
separate change; this document is the contract Relay now enforces.

## Decision (owner, 2026-10-23)

GitHub-hosted CI (Actions check runs and commit statuses) is **not** a merge gate.
`relay merge-check <task>` decides from Relay's own evidence, and must not report
`BLOCKED` because hosted check runs failed or are absent. This closes both live
failures: ishiul PRs whose Actions jobs never start (previously
`BLOCKED — CHECKS_NOT_PASSED` despite green Relay VERIFY) and the relay repo, which
has no hosted CI (previously `BLOCKED — CHECKS_NOT_RUN` on every PR).

## What gates READY

`evaluateMergeGate` (`src/merge-gate.ts:226`) requires all of:

1. a **mechanical VERIFY** result that passed at the Task's recorded head
   (`src/merge-gate.ts:333-345`); missing / failed / another head is
   `VERIFY_MISSING` / `VERIFY_FAILED` / `VERIFY_STALE`;
2. a trusted **independent ReviewResult PASS** pinned to that head
   (`REVIEW_MISSING` / `REVIEW_STALE` / `REVIEW_NOT_INDEPENDENT`), with no
   unresolved `NG` at the head and no owner `HOLD`;
3. an **open, non-draft PR** whose head equals the recorded head and whose base
   branch is the reviewed one, with resolved mergeability (`CONFLICT` raises
   `IntegrationRequired`);
4. **dependencies done** (a PR-bound prerequisite only once merged);
5. a point-of-use **merge authority** (`NO_PERMISSION` otherwise — the gate never
   merges).

## A post-review HEAD move re-enters VERIFY

Because (1) is HEAD-pinned, a moved HEAD must earn a new VERIFY or the Task would
dead-end at `merge_ready`. Every post-review head change goes through
`invalidateReview` (`src/workflow.ts:256-288`): an integration submit or Run that
names a new head (`src/workflow.ts:634-638`, `src/workflow.ts:789-794`) and a
provider-poll PR re-push (`src/workflow.ts:563-566`). On a HEAD change it now
sends the Task back to **`verify`** at the new head and `attempt+1` — with
`claim_role=relay` when the Task has mechanical checks, so
`runPendingMechanicalVerifications` re-runs them; with the Task's own role
otherwise — instead of skipping straight to `review`. A **base-branch** change
keeps the same HEAD, so its VERIFY still applies and only the review re-opens.

`tests/merge-gate.test.ts` covers both paths end to end: integration submit at a
new head -> VERIFY -> review PASS -> integration -> `merge_ready` -> gate
`READY`, and a PR-link head move at `merge_ready` through the same route.

## Hosted CI is informational

Check runs are still read, HEAD-pinned, when a reader is configured
(`gatherMergeGateInput`, `src/merge-gate.ts:521-530`), but the roll-up only fills
the decision's `hosted_ci` field (`src/merge-gate.ts:165-192`,
`src/merge-gate.ts:214`). It is never part of the decision identity
(`src/merge-gate.ts:211-213`) and never adds a block reason
(`src/merge-gate.ts:369-371`).

| `hosted_ci` | Meaning |
| --- | --- |
| `passing` | at least one required check concluded green; none failing/pending |
| `failing` | a check run concluded `fail` or `cancel` |
| `not verified` | no reader / no recorded head / unreadable read / zero checks / all skipped / still pending |

`CHECKS_NOT_RUN` and `CHECKS_NOT_PASSED` were removed from `MergeBlockCode`
(`src/merge-gate.ts:72-97`). A rate-limited hosted-CI read is likewise only
`not verified`; a rate-limited **PR** read still blocks with
`PROVIDER_RATE_LIMITED` because the PR itself is a required gate input.

## Operator output

The human line and `--json` both expose the observation:

```
T46  READY  head=38ee595e7a  pr=81ueman/relay#68@38ee595e7a  attempt=0  action=merge  hosted_ci: not verified
```

```json
{
  "status": "READY",
  "hosted_ci": "not verified"
}
```

`--json` emits the whole `MergeGateDecision`; `hosted_ci` is one of the three
values above (`src/merge-gate.ts:750-755`).

## Live verification (coordinator)

These are read-only. Use a copy of the live DB so a running daemon is not touched:

```bash
# WAL-safe backup of the live control plane (source opened read-only)
sqlite3 -readonly /Users/81ueman/ghq/github.com/81ueman/relay/.relay/state.db \
  ".backup /tmp/relay-live.db"
sqlite3 -readonly /Users/81ueman/ghq/github.com/81ueman/ishiul/.relay/state.db \
  ".backup /tmp/ishiul-live.db"

# READ-ONLY merge readiness of a live merge_ready Task. --authority merge is the
# DRY-RUN grant; merge-check never performs the merge. Run from a checkout of this
# PR head (or main after merge):
git -C /Users/81ueman/ghq/github.com/81ueman/relay worktree add /tmp/relay-ish1140 \
  origin/relay/ish-1140-factory
cd /tmp/relay-ish1140
RELAY_DB=/tmp/relay-live.db  bun src/cli.ts merge-check <relay-task>  --authority merge
RELAY_DB=/tmp/ishiul-live.db bun src/cli.ts merge-check <ishiul-task> --authority merge
```

In the 2026-10-23 DBs, `T46` (PR #68) was a live relay `merge_ready` Task and
`T271` (PR #952) a live ishiul one; the PR body records the exact commands and
output that were run against them.

Add `--json` for the structured decision. The live output recorded in the
ISH-1140 PR body shows a live relay Task `READY` with `hosted_ci: not verified`
(that head has no check runs) and a live ishiul Task `READY` with
`hosted_ci: failing` (its Actions jobs failed). The ishiul case is the point of
the change: hosted CI failed and the Task is still READY.

## Coordinator merge record (ishiul gateway skill note)

The coordinator still runs `gh pr merge`; Relay never merges. When it records the
merge in the Task/PR it must name Relay's local evidence, not hosted CI:

```
merged on local checks: <commands → results>; hosted CI: not verified
```

Do **not** edit ishiul in this change. Copy this exact note into the ishiul gateway
skill in its own PR.

## Tests

`tests/merge-gate.test.ts` covers the pure table and the gathered facts:

- green VERIFY + head-pinned OK + mergeable PR is `READY` with all check runs
  failing and with check runs absent;
- `hosted_ci` classifies passing / failing / not-verified without changing the
  status;
- a rate-limited hosted-CI read is informational too (`not verified`, never a
  block);
- a failed VERIFY, a missing/stale VERIFY, a missing/stale review, a moved head and
  a HOLD still `BLOCKED`;
- a post-review head move re-enters `verify`: an integration submit with a new
  head, and a PR-link head move at `merge_ready`, both re-run the mechanical
  checks, take a fresh review PASS at the new head, and produce a `READY` gate
  with `hosted_ci: not verified`.

`tests/provider-poll-rate-limit.test.ts` keeps the typed rate-limit behaviour and
asserts the informational `hosted_ci: not verified` when the check read is skipped.
