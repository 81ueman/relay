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
  `0.2.1-rc.2`**. One Run = one process = one coding attempt.
- **Independent reviewer = Claude** — `claude -p --output-format json`, run with
  `--permission-mode auto` by default (**never** `bypassPermissions`, no
  all-tools allowlist), returning ONE structured verdict. This is an approval
  mode, not an OS sandbox: read-only is **not** claimed against uncommitted
  writes. What holds is independence (`recordReview`), a HEAD-bound verdict, and a
  disposable detached review checkout where one is configured
  (`reviewWorktreeRoot`; the Factory's CLI always sets it). The brief also carries
  the mechanical VERIFY result already produced in the Task worktree, so the host
  reviewer need not re-run the required checks **wholesale**; it is still expected
  to run the focused variants the diff's blast radius and the repo rubric call
  for, and to say which it ran. The Gateway and reviewer deliberately use
  different models/harnesses.

## Repo rubric and focused execution (ISH-1135, ISH-1143)

The reviewer brief tells the reviewer to **read the repository's own rubric at
the reviewed HEAD** before judging (`src/reviewer-runner.ts`
`## Repo review rubric — READ THIS FIRST`). The default path is the ishiul skill
layout, `.agents/skills/independent-pr-review/references/rubric.md` plus
`references/output-contract.md`; the path is configurable per repository with
`RELAY_REVIEW_RUBRICS` (a JSON object keyed by `owner/name`, bare repo name or
`default`), with `RELAY_REVIEW_RUBRIC` / `RELAY_REVIEW_OUTPUT_CONTRACT`, or with
`--review-rubric` / `--review-output-contract` for one `relay run factory`
invocation. **ISH-1143:** the two flags are a pair: `--review-output-contract`
without `--review-rubric` is refused, never silently ignored. The file is checked
in the **reviewed commit** (not the mutable working tree) and the brief points the
reviewer at `git show <head>:<path>`, so a dirty checkout cannot substitute a
different rubric; when it is missing at that HEAD the brief says so explicitly and
tells the reviewer not to substitute another revision's rubric.

Relay's structured verdict JSON remains the machine contract. The rubric's
severity buckets map onto it: `Act on` → `blocker`/`major`; `Consider`/`Noted` →
non-blocking `minor`; `Dismissed` → non-blocking `nit`. Non-blocking findings are
**kept** in `findings` (the ISH-1086 read path), never dropped. The VERIFY section
says the required checks already passed and not to re-run them wholesale; the
separate `## Focused execution` section expects the reviewer to run the focused
tests, commands or variants the blast radius calls for (other address family,
sibling vendor, deleted path re-sweep) and to name them in `summary`, or to write
an explicit `no execution needed because …`.

## No-env defaults (ISH-1133)

`relay run factory` requires no environment variables:

- **GitHub** — the read-only `gh` reader is the default for PR binding **and** the
  native review; both legs share one detection
  (`factoryGithubDepsFromEnv` in `src/provider-adapters.ts`). An authenticated
  `gh` is required; a missing/unauthenticated `gh` blocks fail-closed.
  `RELAY_PROVIDER_GITHUB=off` is the explicit opt-out for tests (the Factory then
  refuses the mandatory native review). An exhausted `gh` budget stays the typed,
  retryable `PROVIDER_RATE_LIMITED`, never "not configured".
- **dsh binary** — `$HOME/.dsh/bin/dsh-model` when it is an executable file, else
  `dsh`; `--dsh` / `RELAY_DSH_BIN` still override. The chosen binary and its
  source (`option` / `env` / `dsh-model` / `path`) are recorded in the Run's
  `run.started` and durable `dsh.run.started` events.
- **Review budget** — 45 min / 2,700,000 ms; `RELAY_REVIEW_TIMEOUT_MS` overrides.

## Pipeline and where it lives

```
implement ──Run submit──▶ verify ──checks──▶ review ──FIX──▶ implement (attempt+1)
   ▲  real dsh headless        Relay runs            │            same worktree,
   │  in the Task worktree     required checks       │            fresh Run
   │                                                 └── IMPLEMENT failed (repairable) ──┐
   └─────────────────────────────────────────────────────────────────────────────────────┘
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

## Bounded IMPLEMENT recovery (ISH-1012)

VERIFY FAIL and REVIEW FIX already continue the Task at `attempt+1`. Before
ISH-1012 an IMPLEMENT Run failure **stopped** the Task
(`coding_failed`/`no_implementation`) with no bounded rework. The Factory now
classifies the failed Run with a small, conservative policy
(`src/implement-recovery.ts`) and, **only when it is provably safe**, issues a
fresh disposable Run on the SAME Task/worktree through the ordinary
phase/attempt transition (`workflow.recordImplementRecovery`):

| failed IMPLEMENT Run | decision |
| -- | -- |
| `exit 0` + **no new commit** (`NO_IMPLEMENTATION`) | **RETRY** (missing-commit) |
| non-zero exit **after producing a new commit** (host worktree) | **RETRY** (partial-commit) |
| the SAME missing-commit/partial-commit at the SAME base HEAD again | **STOP** (`REPEATED_FAILURE`) — no progress, no loop |
| `attempt + 1 >= maxAttempts` | **STOP** (`max_attempts`) — the SAME budget as VERIFY/REVIEW FIX |
| ENOSPC / resource exhaustion (`ENOSPC`/`RESOURCE`) | **BLOCKED**, never retried |
| permission / auth / credential (`PERMISSION`/`AUTH`) | **BLOCKED**, never retried |
| launch problem (`LAUNCH`) | **BLOCKED**, never retried |
| invalid/stale submission (`INVALID_RESULT`) | **BLOCKED**, never retried |
| cancelled / time-limited / unknown cause (`CANCELLED`/`TIMEOUT`/`UNKNOWN_CAUSE`) | **STOPPED**, never retried |
| an unconfirmed live writer (`WRITER_NOT_TERMINAL`) | the fence is held; no new Run |
| the adopted/orphaned Run path (`ORPHAN`) | **STOPPED**; ISH-1008 owns liveness/cause |

The transition is conditional and only runs after the previous Run is
**provably terminal**, no live Run owns `(task, implement, attempt)`, and the
single-writer fence is released for the Run's worktree/branch. A stale/replayed
call therefore observes 0 changes (`STALE_ATTEMPT`) instead of bumping the
attempt twice.

The fresh Run receives the failed Run's id, terminal state/exit code, base and
produced HEAD, its recorded error and a bounded stderr tail, plus the retry
reason, pinned into the SAME Run brief — the original Task acceptance and the
durable worktree are unchanged. A terminal Run **closes** its attempt: restart/
re-entry finishes a clean unsubmitted submission through the normal fence or
re-reads the recorded failure, and **never starts a second Run for that
attempt**. A `blocked_human` HOLD is never bypassed by an in-flight Run.

An environment-class failure parks the Task `blocked_human` at `attempt+1`, so an
explicit `unblock` starts a fresh attempt after the environment is fixed; it is
not an automatic retry.

## Repair exhaustion: classification and next action (ISH-1013)

A non-ready Factory result now carries a `failure` projection derived **only**
from the rows the Factory already wrote (the Task, its `runs`, `task_results`,
`events` and retained log/review paths). It adds no state machine and no second
evidence store, and it never mutates the Task. A Factory call on an already
finished Task (`done`/`failed`/`cancelled`) is not a new failure: it records no
new `factory.outcome` event, so the success or diagnosis that actually ended the
Task is never replaced by an UNKNOWN "investigate" projection.

`CHECK_NOT_RUN` is decided from the structured `VerificationResult` row (a
REQUIRED check with `not_run`/`inconclusive`), **before** any process-marker
regex. The Factory's VERIFY-block reason embeds a bounded raw check-output tail,
which may legitimately contain words like `command not found`, `permission
denied` or `stale result`; that tail is evidence for the operator, never proof of
a launch/permission/stale cause.

`relay run factory <task-id> --json` includes the projection:

```json
{
  "outcome": "blocked",
  "reason": "IMPLEMENT_RECOVERY/ENOSPC: ...",
  "failure": {
    "class": "infra_blocked",
    "cause": "ENOSPC",
    "resume": "after_environment_fix",
    "requiresUnblock": true,
    "taskId": "T1",
    "attempt": 0,
    "taskAttempt": 1,
    "head": "<unchanged base SHA>",
    "runId": "run-...",
    "runState": "exited",
    "runExitCode": 0,
    "evidence": [
      "run run-... (implement/0) state=failed ... logs=.../stderr.log, .../dsh.jsonl",
      "event #44 factory.implement_retry_refused: ..."
    ],
    "next": {
      "action": "The Run hit a full disk (ENOSPC); the Factory never auto-retries this. Free space on the Run volume, then `relay unblock T1` to start a fresh attempt.",
      "read": "relay status",
      "command": "relay unblock T1",
      "resumeWhen": "the disk guard reports OK ... and no live writer holds the worktree"
    }
  }
}
```

The minimal `class` is one of:

| class | examples (`cause`) | resume |
| -- | -- | -- |
| `code_rework_exhausted` | `MAX_ATTEMPTS`, `REPEATED_FAILURE`, `NO_IMPLEMENTATION` | fix the remaining check/review finding, then re-run with a larger attempt budget |
| `infra_blocked` | `ENOSPC`, `LOW_DISK`, `RESOURCE`, `LAUNCH`, `TIMEOUT`, `ORPHAN`, `WORKSPACE`, `WRITER_ACTIVE` | fix the environment; a live writer must finish first; a parked Task still needs an explicit `unblock` |
| `permission_or_human_decision` | `PERMISSION`, `AUTH`, `HUMAN_HOLD`, `REVIEW_BLOCKED` | restore the permission/credential or make the human decision, then explicitly unblock |
| `missing_or_inconclusive_evidence` | `REVIEW_REFUSED`, `CHECK_NOT_RUN`, `NO_REQUIRED_CHECK`, `EVIDENCE_UNAVAILABLE` | re-run the review/check with readable evidence; an unrun gate never PASSes |
| `stale_head` | `STALE_HEAD`, `STALE_EVIDENCE` | never reuse the old attempt/HEAD; re-run only with evidence naming the current HEAD |
| `unknown` | `UNKNOWN` | read the Run logs; do not retry blindly or guess a cause |

The same projection is written once per Factory result as a durable
`factory.outcome` event (best effort; a full disk cannot turn a decided result
into a new failure). A later success supersedes an older failure in `task show`,
and the projection is read back without re-running anything:

```sh
relay run show <run-id>            # factory_outcome / classification / evidence / next
relay run show <run-id> --json     # { ...run, "factory": { outcome, reason, failure } }
relay run logs <run-id>            # factory header, then the raw Run logs
relay task show <task-id> --json   # { ...task, "factory": { outcome, reason, failure } }
```

`relay run show/logs` uses the Run's own task/attempt (an exact `runId` match
first), so an old Run never displays another attempt's diagnosis. The dashboard's
existing `blocked_human` ATTENTION line keeps showing the Factory block reason;
the detailed next action is on the surfaces above.

**Safe resume rules.** The projection never auto-releases anything:

- A resolved **infra** cause still resumes through the existing path: fix the
  cause, then `relay unblock <task>` (the block already advanced the attempt, so
  a fresh Run is issued) or re-run the Factory. There is no automatic retry.
- A **HOLD**, missing permission, an unfinished writer or stale/old evidence
  keeps the Task BLOCKED — `requiresUnblock` is true and the next command is the
  explicit `relay unblock`, never an implicit release.
- `max_attempts` is re-entered with a larger `--max-attempts`; the old attempt/
  HEAD is never reused.
- `no_implementation` / `repeated_failure` keeps the closed attempt/HEAD closed
  too: fix the brief/worktree or the repeated blocker, then re-enter through the
  existing Factory (the projection's `next.command` is
  `relay run factory <task> --max-attempts <n>`, or `relay unblock <task>` when
  the Task is parked).
- `review_refused` re-runs the review stage at the recorded HEAD; no structured
  verdict is never a PASS.
- The durable event and the existing Run/result/log files are retained across
  restart. Re-entry creates no second Run for a closed attempt, no second review
  and no old-SHA PASS.
- An **unknown** cause has no resume command; the operator must read the evidence
  and choose an explicit safe re-entry.

## PR check before review (ISH-880/885, read-only)

A produced commit is bridged to a real GitHub PR **before the review
stage**, so a review PASS is bound to the PR's *real current remote HEAD*. When
`FactoryDeps.prBinding` is configured and the Task records a `pr_repo`/`pr_url`,
the Factory re-reads the PR and requires its live `headSha` to equal the produced
commit; a moved/unreadable/other-repo PR — or no identity/adoptable PR — returns
the Factory outcome `blocked` and the reviewer **never runs** (never a fake
`review_pass`). The **Coding Agent** (dsh/DeepSeek) owns the GitHub write
(`git push` + `gh pr create`/update) and the Claude reviewer posts the native
review; **Relay never writes to GitHub**. See [`pr-binding.md`](pr-binding.md).
Unset, the Factory is unchanged and read-only.

## Commands

```sh
# the fixture suite
bun test tests/factory.test.ts              # fixture: fake dsh + fake reviewer (deterministic)

# the pilot entrypoint (one Task, real dsh + real Claude by default)
relay run factory <task-id> [--repo DIR] [--dsh BIN] [--reviewer CMD] [--model M] \
  [--max-attempts N] [--permission MODE] [--timeout 30m] [--json]
# no env required (see "No-env defaults" above); overrides:
# --dsh / RELAY_DSH_BIN / RELAY_REVIEW_CMD / RELAY_REVIEW_MODEL /
# RELAY_REVIEW_TIMEOUT_MS
```

The one-off ISH-762 smoke scripts were removed in ISH-1100; their recorded
output is preserved under [Evidence](#evidence).

The factory runs **code-change tasks only** (`relay task intake --code-change`); a
plain `relay task add` task is refused up front, before any worktree is created,
with that re-intake instruction. VERIFY requires **at least one REQUIRED**
`--check name=command` recorded at intake, else the outcome is `no_checks`. The
task branch is cut from the SOURCE repo's freshly fetched `origin/main` (or the
task's `pr_base`); a resolved base behind `origin/main` is reported as a warning
and in the Factory `steps`, never silently accepted.

`--json` prints the `FactoryResult`: `outcome`, `head`, per-attempt
`runId`/`verifyOutcome`/`reviewVerdict`, the read-only `gate` decision, the
ordered `steps`, and (ISH-1013) the `failure` classification/evidence/next-action
projection. A non-`merge_ready` outcome exits non-zero.

## Fail-closed rules (a coding/review agent can never manufacture an advance)

- **A dsh exit 0 / terminal `final` is NOT a submission.** Only the structured
  `acceptRunSubmission` advances the Task. A Run that exits 0 but commits
  **nothing** (`head == base_head`) is `NO_IMPLEMENTATION`; a non-zero/signalled/
  cancelled/timeout Run is `CODING_FAILED`; a stale/superseded Run's submission is
  `RUN_SUBMISSION_REFUSED`. A `NO_IMPLEMENTATION`/partial-commit failure may get a
  bounded rework **only** through the ISH-1012 policy above; every other cause
  stops (and environment/invalid causes BLOCK) with an explicit
  `IMPLEMENT_RECOVERY/<CODE>` reason.
- **An attempt with a terminal Run is CLOSED.** Restart/re-entry reuses the
  recorded outcome (or finishes a clean, never-submitted `exit 0` Run through the
  normal submission fence) and NEVER launches a second Run for the same
  `(task, implement, attempt)`. A `blocked_human` HOLD is not advanced by any
  in-flight Run.
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
- **An orphaned Run never hangs the Factory, never lets a second writer in, and
  never signals a stranger.** On adoption the Run's PID is checked
  (`process.kill(pid, 0)`); a Run whose owning process is gone is marked terminal
  `failed`. A Run that is still ALIVE when it exceeds its budget (the deadline is
  `started_at + run timeout`, not the moment of adoption) is **identified before
  any signal**: the factory requires it to be a **process-group leader**
  (`pgid === pid`, as the `setsid`-spawned dsh is) **and** its process **start time**
  (`ps -o lstart=`, stored on `runs.spawn_lstart` at spawn) to match the token
  captured at launch. Only then is the detached process group `SIGTERM`-ed, then
  `SIGKILL`-ed after a grace period, and the Run marked `failed` **only once the
  leader is confirmed gone**. A **reused PID** (a live process that is not this
  Run's dsh) is treated like a dead one — the Run is marked `failed` and **no
  signal is sent** to the stranger; an **unidentifiable** live PID is left
  `running` so `findActiveWriter` keeps returning `DUPLICATE_WRITER`. There is
  **no `kill(pid)` fallback**: a bare `kill(pid)` fires exactly when `pid` is not a
  group leader, which proves it is not the dsh. The identity token is
  **canonical**: `ps` runs with a pinned environment (`LC_ALL=C`, `TZ=UTC`) and the
  token carries a version tag (`lstart-v1:`), so a factory restarted under a
  different `LANG`/`LC_*`/`TZ` still matches the genuine writer. A row written in
  the OLD non-canonical format is treated as **undeterminable** (fence held, no
  signal), never as `reused`.
- **The live Run is the only control-plane writer for its `(task, phase,
  attempt)`.** The headless dsh inherits `RELAY_DB`/`PATH`, so it *could* reach the
  generic worker CLI. `relay claim`/`relay submit` (`claimTask`/`claimNext`/
  `submitPhase`) **refuse with `RUN_OWNED`** while a `starting`/`running` Run owns
  the Task's current phase/attempt — the Run-bound `acceptRunSubmission` is the
  only advance. The Run brief also tells the coding process not to invoke `relay`
  mutations. (`RELAY_DB` is deliberately NOT dropped: the CLI would then fall back
  to the user's real control plane.)
- **Old HEAD cannot advance.** Every result is bound to the revision it judged;
  the merge gate re-reads GitHub and refuses a PR head != `task.head_sha`.
- **Hosted CI is informational (ISH-1140).** GitHub check runs are reported as
  `hosted_ci` but are never a merge gate; READY comes from Relay's VERIFY +
  head-pinned review. See
  [`ish-1140-merge-gate.md`](ish-1140-merge-gate.md).
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

The transcripts below are the output recorded by the one-off ISH-762 smoke
scripts, which were removed in ISH-1100 (the raw runs remain in git history and
the original PRs).

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

### Real smoke (real dsh 0.2.1-rc.2 + real Claude)

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
2. The fixture suite (`bun test tests/factory.test.ts`) is green, and the real
   smoke recorded under [Evidence](#evidence) completed.
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

- **Verified** — `bun run typecheck`; `bun test` (see the ISH-1012 change for the
  current count);
  `bun run smoke:factory` (PASS, 13 checks); `RELAY_REAL_SMOKE=1 bun run
  smoke:factory:real` (PASS with real `dsh 0.2.1-rc.2` + real Claude; see the raw
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
  an all-optional check list is `no_checks` (finding 5). The round-3/round-4
  revisions add: a reused PID (non-leader, or a leader with a different canonical
  start token) is never signalled; the spawn token is canonical and a legacy
  non-canonical token is `undeterminable` (fence held); and `claimTask`/`claimNext`/
  `submitPhase` refuse with `RUN_OWNED` while a Run owns the phase/attempt — proven
  by a fake dsh that runs `relay claim`+`relay submit` during the Run and still
  reaches `merge_ready` only via the Run-bound submission.
  ISH-1012 adds the bounded-recovery matrix above: a partial-commit failure →
  fresh attempt/Run on the SAME worktree → VERIFY PASS → independent REVIEW PASS;
  exit-0-no-commit → fresh Run → PASS; ENOSPC and MISSING_CREDENTIAL are BLOCKED
  with no retry; a bare non-zero exit is stopped as `UNKNOWN_CAUSE`; the attempt
  cap and the repeated-same-failure stop; restart after the cap resumes on a
  fresh attempt without a second Run for the old one; and a HOLD rejects an
  in-flight submission. `tests/implement-recovery.test.ts` pins the classifier's
  explicit allow/deny reasons, and the fresh brief is asserted to carry the
  failed Run id/exit/heads/error/retry reason plus the original acceptance.
- **NOT verified here** — an end-to-end **real-FIX** loop (real dsh attempt 0
  genuinely insufficient → real Claude FIX → real dsh attempt 1 → real Claude
  PASS): the real smoke reached MergeReady on attempt 0 because the real model
  completed the task correctly; the FIX→fresh-Run loop is proven deterministically
  by the fixture smoke/suite. Also not run: any provider write, a real GitHub PR
  or merge, a Linear state change, and the legacy `lane.sh` removal (ISH-805).
