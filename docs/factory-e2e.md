# Factory E2E (ISH-762): real dsh → VERIFY → independent Claude review/FIX → MergeReady

One Task travels the **whole factory without hand-driving a TUI/pane for the
coding**: a real **headless dsh Run** implements → Relay **mechanically VERIFYs**
the recorded worktree/HEAD → an **independent headless Claude** reviewer returns a
structured verdict → a **FIX** produces a **fresh dsh Run** on the SAME worktree
with the findings → re-VERIFY → Claude **PASS** → **MergeReady** (read-only; NOT
merged, NOT Linear Done).

## Role split (owner runtime decision 2026-10-16)

- **Gateway = OpenCode + DeepSeek** — human conversation, `Todo + agent:deepseek`
  reminder sweeps, decision-only callbacks. This E2E does **not** require a Claude
  Gateway.
- **Coding worker = `dsh` headless** — `dsh --profile headless --json`, **pinned
  `0.2.0-rc.2`**. One Run = one process = one coding attempt.
- **Independent reviewer = Claude** — `claude -p --output-format json`, invoked
  **read-only** (`--allowedTools "Read Grep Glob"`), returning ONE structured
  verdict. The Gateway and reviewer deliberately use different models/harnesses.

## Pipeline and where it lives

```
implement ──Run submit──▶ verify ──checks──▶ review ──FIX──▶ implement (attempt+1)
   ▲  real dsh headless        Relay runs            │            same worktree,
   │  in the Task worktree     required checks       │            fresh Run
   └────────────────────────────────────────────────┘
                                        review ──PASS──▶ integration ──submit──▶ merge_ready
                                                                                  (read-only gate)
```

| step | module | reuse |
| -- | -- | -- |
| worktree + disposable Run + brief | `src/run-lifecycle.ts` (ISH-760) | unchanged |
| Run process + JSONL evidence + structured submission | `src/dsh-runner.ts` (ISH-803/810) | unchanged |
| mechanical VERIFY (HEAD-bound, required checks) | `src/verify.ts` + `runMechanicalVerification` (ISH-759) | unchanged |
| **independent headless Claude review** | **`src/reviewer-runner.ts`** (new) | records via `recordReview` |
| **whole-Task sequencing** | **`src/factory.ts`** (new) | reuses the phase machine |
| read-only HEAD-bound merge gate | `src/merge-gate.ts` (ISH-761) | unchanged |

The Factory is **sequencing only**: every transition is the ordinary durable
result (`acceptRunSubmission`, `runMechanicalVerification`, `recordReview`,
`submitPhase`). There is no parallel state machine.

## Commands

```sh
# the library/smoke entrypoints
bun run smoke:factory                       # fixture: fake dsh + fake reviewer (deterministic)
RELAY_REAL_SMOKE=1 bun run smoke:factory:real   # real dsh 0.2.0-rc.2 + real Claude
bun test tests/factory.test.ts              # the fixture suite

# the pilot entrypoint (one Task, real dsh + real Claude by default)
relay run factory <task-id> [--repo DIR] [--dsh BIN] [--reviewer CMD] [--model M] \
  [--max-attempts N] [--timeout 30m] [--json]
# overrides also via RELAY_DSH_BIN / RELAY_REVIEW_CMD / RELAY_REVIEW_MODEL
```

`--json` prints the `FactoryResult`: `outcome`, `head`, per-attempt
`runId`/`verifyOutcome`/`reviewVerdict`, the read-only `gate` decision, and the
ordered `steps`. A non-`merge_ready` outcome exits non-zero.

## Fail-closed rules (a coding/review agent can never manufacture an advance)

- **A dsh exit 0 / terminal `final` is NOT a submission.** Only the structured
  `acceptRunSubmission` advances the Task. A Run that exits 0 but commits
  **nothing** (`head == base_head`) is `NO_IMPLEMENTATION`; a non-zero/signalled/
  cancelled/timeout Run is `CODING_FAILED`; a stale/superseded Run's submission is
  `RUN_SUBMISSION_REFUSED`.
- **Only a runnable Task state is driven.** The Factory whitelists `queued`/
  `running`/`review`; **every** other state — including `blocked_internal` (which
  `blockTask` sets while leaving `phase` unchanged) and `blocked_human`/terminal —
  returns immediately. A durable block is never carried to MergeReady or erased.
- **A FAILED reviewer process is not a verdict.** A reviewer that exits non-zero
  or is signalled is `REVIEW_PROCESS_FAILED` **before** its stdout is parsed — a
  crash can never be mistaken for a pass, even with a well-formed verdict on
  stdout.
- **Hard required checks.** The Factory requires **at least one REQUIRED**
  (`required !== false`) mechanical check — an all-optional list is `no_checks`,
  so an optional `not_run`/`inconclusive` can never be aggregated into a PASS.
  VERIFY runs the Task's commands in the recorded worktree and requires
  `git rev-parse HEAD == task.head_sha`. `pass → review`, `fail → implement (new
  attempt)`, a **required** `not_run`/`inconclusive` → the task BLOCKS. CI credit
  exhaustion / an unrun required check is **NOT_RUN, never PASS**.
- **Independent structured review.** The reviewer must print ONE structured JSON
  verdict. No structured result / malformed output → `REVIEW_NO_STRUCTURED_RESULT`
  (REFUSED). A verdict that does not name the CURRENT head, or a worktree HEAD
  that moved → `REVIEW_HEAD_MISMATCH` (REFUSED). The worktree HEAD **and** the
  live `review@head` binding are re-checked **after** the reviewer returns, so a
  reviewer that commits to the worktree while it runs cannot have its verdict
  credited. A principal that is not an independent reviewer (wrong role, or the
  submitter) → `REVIEW_NOT_INDEPENDENT`. An unresolved NG at the same head is
  never cleared by a later OK alone.
- **An orphaned Run never hangs the Factory, and never lets a second writer in.**
  On adoption the Run's PID is checked (`process.kill(pid, 0)`); a Run whose
  owning process is gone is marked terminal `failed`. A Run that is still ALIVE
  when it exceeds its budget (the deadline is `started_at + run timeout`, not the
  moment of adoption) is **killed before the single-writer fence is released**:
  the detached process group is `SIGTERM`-ed, then `SIGKILL`-ed after a grace
  period, and the Run is marked `failed` **only once the leader is confirmed
  gone**. If the group cannot be killed, the Run is **left `running`** so
  `findActiveWriter` keeps returning `DUPLICATE_WRITER` for the worktree/branch —
  the Factory still returns `CODING_FAILED`, but never frees the workspace for a
  second writer.
- **Old HEAD cannot advance.** Every result is bound to the revision it judged;
  the merge gate re-reads GitHub and refuses a PR head != `task.head_sha`.
- **MergeReady is read-only.** The Factory never pushes, merges, accepts,
  comments, labels or writes Linear. `task.merged_at`/`accepted_at`/`pr_url`
  stay `null`; the gate decision is recorded, not executed.
- **Single writer.** A second Run on the **same worktree/branch** is refused
  (`DUPLICATE_WRITER`) until the previous Run ends; **distinct worktrees run in
  parallel**. A real conflict raises `IntegrationRequired` to the Gateway **once**
  and the fix is a new HEAD that must be re-VERIFY + re-REVIEW.
- **Restart/reconcile is idempotent.** Re-entering the Factory adopts an already
  live implement Run for the phase/attempt instead of starting a second writer.

## Evidence

### Fixture smoke (deterministic)

```
$ bun run smoke:factory
ISH-762 factory fixture smoke
  ok 1. the task starts in the implement phase
  ok 2. a duplicate writer on the same worktree/branch is REFUSED
  ok 3. the factory reached MergeReady
  ok 4. the task phase is merge_ready
  ok 5. MergeReady is READ-ONLY: NOT merged, NOT accepted
  ok 6. two coding attempts (FIX then PASS)
  ok 7. review FIX then PASS
  ok 8. mechanical VERIFY pass on both attempts
  ok 9. two disposable dsh Runs (no session continuation)
  ok 10. Run 1 kept its original dsh JSONL (with the session id)
  ok 11. the raw reviewer output is retained as per-review evidence
  ok 12. the read-only merge gate was evaluated (BLOCKED)
  ok 13. exactly two review decisions were recorded

PASS — 13 checks
```

### Real smoke (real dsh 0.2.0-rc.2 + real Claude)

```
$ RELAY_REAL_SMOKE=1 bun run smoke:factory:real
ISH-762 real dsh + real Claude factory smoke
{
  "outcome": "merge_ready",
  "head": "435378b910577c2c6872ed75dde8158ff96f2adb",
  "attempts": [
    { "attempt": 0, "runId": "run-d98d3654",
      "baseHead": "49ec72f4424026543d6f0db7ee8c54c72d1b5060",
      "producedHead": "435378b910577c2c6872ed75dde8158ff96f2adb",
      "verifyOutcome": "pass", "reviewVerdict": "pass", "phase": "implement" }
  ],
  "gate": "BLOCKED",
  "steps": [
    "implement:run run-d98d3654 -> submitted (head 435378b9...)",
    "verify:pass@0", "review:pass@0",
    "integration:submitted (head 435378b9...)",
    "merge_ready:gate=BLOCKED"
  ],
  "runs": [
    { "id": "run-d98d3654", "state": "submitted", "exit": 0,
      "sessionId": "session-46a2889a-fa3e-4ea4-b6e9-aefd3ad0001f",
      "dshJsonl": ".../runs/run-d98d3654/dsh.jsonl",
      "baseHead": "49ec72f4...", "head": "435378b9..." }
  ],
  "reviews": [".../worktrees/T1/.relay/reviews/attempt-0-435378b910.json"],
  "task": { "phase": "merge_ready", "state": "queued",
            "merged_at": null, "accepted_at": null, "pr_url": null }
}
PASS — real dsh -> VERIFY -> real Claude -> MergeReady (reviewer=claude-review)
```

The per-Run dsh **session id** and the **original `dsh.jsonl`** are retrievable
with `relay run show <run-id>` / `relay run logs <run-id>`; the raw reviewer
output is retained at `<worktree>/.relay/reviews/attempt-<n>-<head>.json`.

## Gateway (OpenCode + DeepSeek): conversation, reminder, only-needed notifications

The Factory emits a Gateway message **only for judgment**: `ChildBlocked` (a
review BLOCKED / a verify BLOCK) and `IntegrationRequired` (a real conflict). An
ordinary FIX/PASS never wakes the Gateway — verified in
`tests/factory.test.ts` ("an ordinary FIX never messages the Gateway; a BLOCKED
review does, once"). Routing uses the existing `resolveHumanInterface`
(`RELAY_HUMAN`, else the nearest ancestor assignee). The human-facing Gateway
conversation (human message, `Todo + agent:deepseek` reminder sweeps,
select/reject blocked/decision/duplicate, decision-only callbacks, session
rotation, no waiting loops) is the ordinary OpenCode + DeepSeek TUI/Session —
unchanged by this issue.

## Lane lessons (recorded)

- **Do not ship `lane.sh` or a dual coordinator.** The Factory is `relay run
  factory` + the durable phase machine; the legacy lane scripts are removed later
  (ISH-805), **after** this E2E.
- **A coding agent's "done" is not done.** Only a structured submission moves the
  Task; an exit 0 with no commit is explicitly refused.
- **FIX = same worktree, fresh Run.** No session continuation; the findings are
  pinned into the worktree brief before the new process starts.
- **One writer per worktree.** Parallelism is across worktrees, not within one.
- **The reviewer is a separate principal.** A reviewer that is the submitter, or
  that lacks the reviewer role with no claim, is refused.

## Pilot cutover conditions

1. `bun run typecheck` and `bun test` are green.
2. The fixture smoke (`bun run smoke:factory`) and a real smoke
   (`RELAY_REAL_SMOKE=1 bun run smoke:factory:real`) both complete.
3. The Gateway (OpenCode + DeepSeek) is attached as the human interface
   (`RELAY_HUMAN`/ancestor assignee); ordinary FIX/PASS stay silent, and only
   `ChildBlocked`/`IntegrationRequired` reach it.
4. Merge authority stays **deny**: the merge gate returns `BLOCKED/NO_PERMISSION`
   unless an explicit ISH-288 point-of-use grant is present. The Factory never
   merges.
5. Tasks are intaken with at least one REQUIRED `--check name=command`
   (the Factory refuses a task without mechanical checks), and a real PR binding
   is provided when merge readiness (not just MergeReady) is wanted.

## Verified / not verified

- **Verified** — `bun run typecheck`; `bun test` (822 pass, 1 skipped, 0 fail);
  `bun run smoke:factory` (PASS, 13 checks); `RELAY_REAL_SMOKE=1 bun run
  smoke:factory:real` (PASS with real `dsh 0.2.0-rc.2` + real Claude; see the raw
  output above); `tests/factory.test.ts` covers the FIX→fresh-Run→PASS loop, the
  exit/exit-0-no-commit refusals, the required-check NOT_RUN block, missing/
  malformed reviewer output, foreign-HEAD verdicts, fake/non-independent reviewer
  identities, an unresolved NG, the blocked/terminal task, the live-Run adoption
  (no duplicate running work), the same-worktree single-writer exclusion, distinct
  parallel worktrees, and the judgment-only Gateway notifications. The PR #10
  round-1 findings each have a dedicated regression test: `blocked_internal` is
  terminal (finding 1); a non-zero/signalled reviewer process is
  `REVIEW_PROCESS_FAILED` (finding 2); a worktree HEAD moved during review is
  `REVIEW_HEAD_MISMATCH` (finding 3); a dead-pid orphan is marked `failed`, a
  real detached-child orphan that is still alive past its budget is **killed**
  (asserted dead) before the fence is released, and an orphan that cannot be
  killed leaves the Run `running` so `DUPLICATE_WRITER` still fences (finding 4);
  an all-optional check list is `no_checks` (finding 5).
- **NOT verified here** — an end-to-end **real-FIX** loop (real dsh attempt 0
  genuinely insufficient → real Claude FIX → real dsh attempt 1 → real Claude
  PASS): the real smoke reached MergeReady on attempt 0 because the real model
  completed the task correctly; the FIX→fresh-Run loop is proven deterministically
  by the fixture smoke/suite. Also not run: any provider write, a real GitHub PR
  or merge, a Linear state change, and the legacy `lane.sh` removal (ISH-805).
