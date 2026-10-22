# relay — `relay`: a Herdr-only supervisor for OpenCode agents

Goal: **as long as unblocked work exists, at least one agent keeps moving.**

> **Relay is a Herdr-only supervisor for OpenCode agents.**
> It does not support managing OpenCode outside Herdr. Every Relay-managed
> OpenCode session must be running inside a Herdr agent.

`relay` is a small deterministic control plane (Bun + TypeScript + SQLite).
It is not an orchestration framework and has no parent-child model: agents are
peers (`communication = many-to-many`, `task ownership = single writer`).

```text
Herdr   = process/session transport
SQLite  = durable truth
OpenCode = coding agent
Relay   = deterministic supervisor
```

- durable task queue (SQLite is the **only** source of truth, WAL mode)
- worker state, durable inbox, append-only event log, managed-session table
- OpenCode event hooks (triggers only — idle/turn-end is never completion)
- Herdr agent/tab adapter (the only transport; never truth)
- stalled/dead worker recovery with fresh-generation regeneration
- planner/worker/reviewer auto wake-up, OpenCode Skill (`agent-worker`)

Failure philosophy: `process alive ≠ progressing`, `session idle ≠ done`,
`LLM says done ≠ done`, `wake delivered ≠ accepted`,
`human blocker ≠ worker must stop`, `parent dead ≠ system stops`.

## Quick start (5 minutes)

**Prerequisites:** [Bun](https://bun.sh), [Herdr](https://github.com/81ueman/herdr),
[OpenCode](https://opencode.ai). Relay only manages OpenCode sessions running
inside a **Herdr pane** — that is the one hard requirement.

```sh
# 1) install the CLI (builds a standalone artifact) and link the OpenCode plugin
git clone https://github.com/81ueman/relay && cd relay
scripts/install.sh

# 2) create the control plane (SQLite, WAL) in the project you want supervised
cd /path/to/your/project
relay init

# 3) run the supervisor (one per project)
relay daemon

# 4) start an OpenCode agent in a Herdr pane, then attach it as a worker
relay worker register my-worker --role worker --runtime <herdr-pane-id> --cwd "$PWD"
#   ...then, inside that OpenCode session, call the `agent_attach` tool:
#   worker_id="my-worker", pane_id="<herdr-pane-id>"
```

Then:

```sh
relay status                        # workers + counts
relay dashboard --watch             # live tree (ATTENTION first)
relay web                           # browser view + send form (127.0.0.1:8787)
relay task add "do the thing" --role worker
relay next --worker my-worker       # claim work
```

- **Task lifecycle:** `relay next` → `claim` → work → `relay note` →
  `relay submit --evidence` → review → `done`. A worker saying "done" is *not*
  completion; `submit` sends to review, approval makes it `done`.
- **Agents get skills** via APM (optional but recommended):
  `apm install -g --target agent-skills 81ueman/relay` installs `agent-worker`
  (the relay protocol) and `parallel-worktrees` (recursive worktree lanes).
- **Deeper reference:** the `Install` and `Setup` sections below, and
  `formal/Relay.tla` for the normative wake/scheduling model.

## Core invariant

```text
if runnable_tasks > 0:
    wake every idle operational worker that could claim some of it
```

`working` means strictly `state == working AND current_task != null`.
**Idle is not productive.** Reviewers/planners are counted separately.

The gate is **not** `working == 0`. A parallel fleet almost always has someone
busy, and whether anyone else is working says nothing about whether the *queued*
work has a taker: with six workers busy and a fresh role-gated child queued, an
idle role-matched worker must still be nudged. Requiring `working == 0` was the
runnable-stall bug — the child sat until a human ran `relay next --worker <id>`.
This matches `Wake(w)` in `formal/Relay.tla`, which requires only
`RunnableExists`.

Rate limiting lives in `tryWake` (per-worker wake cooldown, default 30s via
`RELAY_WAKE_COOLDOWN_MS`), so waking every eligible candidate cannot become a
nudge storm; a task left unclaimed is re-woken on a later pass rather than
being treated as consumed.

`WAITING_FOR_HUMAN` only when `runnable == 0 AND review == 0 AND all
unfinished tasks are blocked_human`. A `blocked_human` task releases its
worker immediately to take other runnable work.

## Task roles, claiming, and release

Peer ownership stays single-writer, but a task's `role` is a **real claim gate
by default (strict)**:

```text
role IS NULL            -> claimable by any worker
role = R (non-null)     -> claimable ONLY by a worker registered with role R
```

- `relay next` / `relay claim` enforce the gate. A `role=worker` pane is never
  woken for a queue that is entirely `role=dataplane-rust`; it simply gets
  `NO_TASK` and stays idle.
- `--role <r>` overrides the match role for a single call
  (`relay next --role dataplane-rust`). It does not change the worker's
  registered role.
- `--any-role`, or `RELAY_ROLE_STRICT=false`, is the **recovery escape hatch**
  that restores the old any-worker behavior (ignore task roles). Strict is the
  default; a live fleet must be migrated (see below) or it will strand
  role-tagged tasks.
- Review tasks (`state=review`) are still claimable only by `role=reviewer`
  workers, and reviewers check the review queue before queued work. A reviewer
  also claims queued `role=reviewer` tasks — but a **pre-created queued review
  gate** is only *runnable* while something is in `review` (or its declared
  prerequisites are done), so it cannot be claimed before its inputs exist (see
  **Run gating** below).
- `relay task add --role R` warns (stderr, non-fatal) when `R` matches no
  registered worker and is not a built-in special role
  (`worker`/`planner`/`reviewer`) — a typo cannot silently create an
  unclaimable task.
- `relay status` lists **Unclaimable** runnable tasks (non-null role, no
  registered worker role); the supervisor view carries the same count and the
  daemon logs `supervisor.unclaimable_work` instead of looping on a wake that
  cannot help.
- `relay status` also annotates every worker with `next:` — the tasks it would
  pick up right now, computed with the **same** policy `relay next` uses (not a
  second scheduler):

  ```text
  perf-research  working  T147  last progress 2m  next: T144,T145 (queued, role match)
  reviewer       idle     -     last progress -   next: T12 (runnable, role match — wake me)
  ```

  A busy worker's `next:` is the queue waiting behind it; an **idle** worker with
  role-matched work is marked `wake me` (the actionable supervisor line). A
  `reviewer` lists `review` tasks instead of `queued` ones, and a worker never
  lists the task it already holds. When several workers of one role share the same
  queue the line says `any <role>` rather than blaming one worker. The list is
  capped (`T1,T2,+3 more`), and a role no live worker has stays under
  **Unclaimable** rather than being promised to anyone.

**Migration (strict roles):** every existing worker must be registered with the
role it is meant to serve, e.g.
`relay worker register <worker-id> --role <role>` (or
`relay worker register <worker-id> --role worker` for generic workers). Tasks
tagged with a role that no worker registers are reported as unclaimable in
`relay status`; register a matching worker, retag the task, or release/re-add it
under `--any-role` as a temporary recovery.

**Duplicate and obsolete registrations: `relay worker retire`.** Re-registering
the same agent under a new id (a common accident when a batch of ids is created
up front and then re-created under cleaner names) leaves two worker rows for one
session. Deleting the old row would break historical events and task
references, so `relay worker retire <id> [--reason <text>]` keeps the row as a
tombstone instead and takes it out of every operational surface:

- `relay worker list` hides retired workers unless `--all`; `relay status` hides
  them entirely.
- A retired worker is excluded from the operational/supervised sets, so it is
  never woken, stalled, restarted or counted as a role owner (a role only
  retired workers registered becomes visible as unclaimable).
- Retirement refuses while the worker still owns a task — release/submit it
  first. `relay worker unretire <id>` reverses it, and re-registering the same id
  revives it automatically.
- `worker.retired` / `worker.unretired` are recorded in the event log.
- Attaching a live session to a retired id **revives** it (the same intent as
  re-registering): `relay session attach` / the plugin's `session.attach` clears
  the tombstone and logs `worker.unretired`. Only a *successful* attach revives;
  a rejected one leaves the tombstone untouched.

### One-command lane setup: `relay worker spawn` / `relay worker reap`

Spawning a managed worker is a repeated 4-step sequence (worktree → agent start
→ register → prompt to attach). `relay worker spawn` does all four:

```bash
relay worker spawn dsl-v4-w1 --role dsl-v4 --base dsl-v4 [--label DSL-V4-W1]
relay worker spawn reviewer-6 --role reviewer --cwd /existing/dir --pane w75:p1
relay worker spawn w7 --role worker --kind codex --no-attach
relay worker reap dsl-v4-w1            # retire + close pane + remove worktree
```

- It runs exactly the documented primitives, in order:
  `herdr worktree create --branch <id> --base <ref> --label <L> --no-focus`
  (unless `--cwd` reuses an existing directory), then finds the lane workspace's
  root pane, then `herdr agent start <id> --kind <k> --pane <p> --timeout 90000`,
  then `relay worker register` (as an **adopted** worker, `relay_owned=0` — not a
  managed generation) and finally prompts the agent to call `agent_attach`. The
  session id does not exist until the first turn, so **attach stays
  agent-driven**: spawn only sends the prompt.
- It is **fail-closed**: a failed `worktree create` / `agent start`, or a create
  that returns no path, aborts with Herdr's reason instead of registering a
  worker with no pane. `--no-attach` skips the prompt (prompt it later yourself).
- `relay worker reap <id>` is the inverse: it **retires** the worker first (so no
  further work is routed), then closes the Herdr pane and removes the worktree.
  It is **idempotent** — a pane/worktree that is already gone is reported, not an
  error. Paths come from the worker row unless `--worktree`/`--pane` override.

### Run gating: declared prerequisites (`relay task depend`)

A queued task is **not runnable** — never offered by `relay next`, never
claimable, never woken — until every prerequisite it declares is `done`:

```bash
relay task add "review gate" --role reviewer --depends-on T150,T151   # at creation
relay task depend T153 T152 T154                                      # set/replace later
relay task depend T153 --clear                                        # remove the gate
```

- Prerequisites are a join table, so a gate can wait on several sibling inputs
  (the CP-W3 gate T153 waited on T150/T151/T152/T154).
- Run gating is orthogonal to `role` and is **not** bypassable with
  `--any-role`. An explicit `relay claim` of a gated task refuses with
  *not yet runnable*.
- For a **`role=reviewer` gate** a prerequisite counts as satisfied when it is
  `done` **or merely `review`**: the gate's input is ready to be reviewed the
  moment it is submitted, so requiring it to be approved first would deadlock
  the gate (the gate *is* the approval). Non-reviewer tasks still require `done`.
  This is what makes the documented remedy actually work when the input is
  submitted-but-not-yet-approved (T295).
- A pre-created queued `role=reviewer` gate with **no** declared prerequisites
  is runnable only while something is in `review`; declare its inputs to make it
  open independently (see below). It can ALSO always be taken by **naming it**:
  `relay claim <gate-id>` opens a named queued reviewer gate explicitly, because
  the deliberate act of naming it is exactly what the rule protects against
  (only `relay next`/the scheduler are barred from grabbing a *standing* gate,
  never an explicit named claim) — T295.
- `relay status` lists gated tasks under **Waiting (not yet runnable)** so they
  are visible instead of looking stranded or unclaimable.
- Cycles and unknown prerequisites are refused at insert time.

## Code-change workflow (implement → verify → review → FIX/merge)

A **code-change** task (`relay task intake ... --code-change`) is driven by Relay
through a fixed phase machine. Structured results are the source of truth;
`relay send` prose is never parsed for a verdict, and `relay approve` /
`RELAY_AUTO_APPROVE` can never satisfy the gate.

```
implement --TaskSubmitted--> verify --VerificationResult--> review
  review --ReviewResult PASS--> integration --TaskSubmitted--> merge_ready
  review --ReviewResult FIX-->  implement (new attempt, same task)
  review --ReviewResult BLOCKED / verify NOT_RUN / INCONCLUSIVE --> blocked_human
  merge_ready --TaskAccepted--> done   (Relay-internal acceptance)
  merged (GitHub) --> TaskMerged       (the ONLY "truly done" for a task with a PR)
```

- **Mechanical verify, no LLM wait.** Intake the standard commands with
  `--check name=command` (repeatable) and the checkout with `--worktree DIR`. When
  a task reaches `verify`, Relay runs them itself and reads the **process exit
  result**. Before running it confirms that `git rev-parse HEAD` in the worktree
  equals the recorded `head_sha`; a missing/unreadable/mismatched head records
  `not_run` and BLOCKS — a PASS is never credited to a tree the commands did not
  run against. pass → review, fail → implement FIX, a **required**
  `not_run`/`inconclusive` → BLOCKED. The verify phase is Relay-owned
  (`claim_role=relay`), so the claim machine never offers it to a worker. Each
  command has a hard timeout: it runs in its own process group and the whole tree
  is killed on timeout, so a hung check cannot stall the daemon. Without `--check`,
  verify stays the manual worker path. `relay verify <task>` runs the same checks.
- **A block is resumable.** `relay unblock` on a code task blocked at `verify` (a
  NOT_RUN/INCONCLUSIVE) or `review` (a review BLOCKED) routes the SAME task back
  to `implement` at `attempt+1` with the head cleared. A HOLD that landed in
  `review` before any review (e.g. a Linear HOLD) has no result to supersede, so
  it resumes **at `review`** (`state=review`, the state a verify PASS produces,
  which `claimNext` keeps at `review`) — never as a `queued` review-phase task
  that a claim would drive to `running`.
- **Independent review.** VERIFY PASS moves the task to `review` and the ordinary
  reviewer wake dispatches an idle reviewer in the same reconcile pass. The
  reviewer must hold `REVIEWER_ROLE` (or the review claim) and may not be the
  worker that submitted the attempt; a reviewer has **no write/merge** authority.
- **HEAD is the review identity.** A PASS must name the current `head_sha`; a
  moved head sends the task back to review. The same PR+HEAD+profile is reviewed
  once, and an **unresolved NG at the same HEAD is never cleared by a later OK
  alone** (it must `--supersedes <result-id>` explicitly).
- **Provider reconciliation is read-only / fail-closed.** With a bound PR, Relay
  polls open/synchronize/merged: a head move invalidates the review, and a
  `merged` PR at the recorded head records `TaskMerged`. A merge is credited
  whenever it is observed after the review passed — in `integration`,
  `merge_ready`, or **after** accept (a done, unmerged task is still polled) — and
  for **any** intake provider (a Linear issue with a GitHub PR is polled too). A
  real merge is the **only** "truly done" for a task with a PR: an internal accept
  does not satisfy `ChildrenReady`, and a dependent task is not runnable until a
  PR-bound prerequisite is merged. Review verdicts are absorbed from `lane.sh`'s
  `<!-- ishiul-review head=<sha> verdict=OK|NG|HOLD reviewer=<id> -->` markers, but
  only from an authorized reviewer identity — a reviewer's TurnEnded, a GitHub
  **label**, and a self-claimed comment are **not** an approval. Repeated
  `merge_not_credited` / `marker_not_applied` events are logged once per
  (task, head / marker).
- **Providers are GET-only readers.** `RELAY_PROVIDER_GITHUB=gh` uses the `gh`
  CLI (read verbs only), `RELAY_PROVIDER_LINEAR=api` + `LINEAR_API_TOKEN` uses a
  read-only GraphQL query (the token rides **stdin**, never argv), and
  `RELAY_REVIEW_AUTHORIZED=a,b` sets the authorized marker authors. The
  operator/Factory/daemon paths auto-detect an authenticated `gh` when the flag is
  **unset**; `RELAY_PROVIDER_GITHUB=off` disables it (fail closed). Each task is
  polled at most once per `RELAY_PROVIDER_POLL_MS` (default 60s) and comments are
  fetched only when the PR `updatedAt`/head moved; the "comments scanned"
  watermark advances only when a scan **succeeded**, so neither a marker posted
  before the task reached `review` nor a transient `gh api` failure (which reports
  an incomplete read as `null`, never a partial list) loses the marker. Any real
  provider write (comment/label), Linear write, or merge requires an explicit
  point-of-use `ProviderAuthority` grant (ISH-288); the default is deny.
- **Gateway is notified only for judgment.** `ChildrenReady` (all direct children
  truly complete) and `ChildBlocked` (a blocked child) reach the fixed Gateway
  worker; ordinary FIX/PASS never wake it. The Gateway is never a per-phase
  coordinator.

### Merge gate: read-only, HEAD-bound (ISH-761)

An independent Review PASS is **not** merge permission and **not** Task Done.
`relay merge-check <task>` (and the daemon's workflow pass) evaluates a
**read-only, HEAD-bound** merge gate over the current GitHub state plus the
required SQLite evidence, and prints ONE structured decision — `READY`,
`BLOCKED` (with concrete reason codes) or `MERGED`:

- **GitHub (re-fetched, never assumed).** OPEN / non-draft (an owner-designated
  draft is retained, still not ready), the PR head must equal the recorded
  `head_sha` (a missing recorded head is `HEAD_UNKNOWN`; a retargeted base branch
  is `BASE_CHANGED` and also invalidates the review in the provider pass without
  moving the head — a FRESH review at that same head is then accepted, keyed on the
  review epoch (head/attempt/profile) so a revert or a pre-base review cannot
  deadlock it, and a pre-retarget marker is not re-applied — while a base-*SHA* move
  alone is not), and mergeability is
  judged. A `conflicting` PR raises
  **`IntegrationRequired`** to the Gateway (a routing decision: fix the new HEAD,
  then re-VERIFY/REVIEW) — it never rebases. The coordinator can execute that
  routing decision with `relay result rebase <task> --reason "<why>"` (ISH-1122):
  the Task returns to `implement` at attempt+1 with the reason as the FIX brief,
  **no ReviewResult is recorded**, an unresolved reviewer NG/HOLD or owner HOLD is
  refused, and the prior PASS stays as history only — the new HEAD needs a fresh
  VERIFY and a fresh independent review. An **unrelated** merge of another PR
  that only moves the base does **not** force a rebase/review loop (no
  unconditional ancestor requirement); a **changed HEAD** does require a fresh
  independent review at the new HEAD.
- **Evidence in SQLite.** A trusted **independent** review PASS at the CURRENT
  head, no **unresolved NG** at that head (a later OK alone never clears it), no
  owner **HOLD** (a STRUCTURED Linear state/label or an owner label on the PR —
  never a keyword scan of free text), the required **check results** (a failed or
  unreadable read, zero reported checks, or an all-skipped roll-up is `NOT_RUN` →
  BLOCKED; a CI credit outage can never become PASS), and the **dependent change
  order** (a PR-bound prerequisite counts as complete only once merged).
- **Permission.** A real merge needs an explicit point-of-use authority
  (ISH-288); with none the verdict is `BLOCKED/NO_PERMISSION`. The gate has **no
  push/rebase/merge executor** and never writes a provider or Linear — it only
  observes. When GitHub re-fetches `merged` at the recorded head, the task is
  confirmed done (a `TaskMerged` result) — but only when Relay itself would credit
  it (the same post-review guard as `confirmMerged`; otherwise
  `MERGE_NOT_CREDITED`); an unmerged PASS is distinguished from Done. There is no
  `--no-merge` internal-approve path: acceptance and merge readiness are separate
  decisions.

The decision is a PURE function of observable facts (`evaluateMergeGate`), so the
whole table is unit-tested; the daemon pass (`runMergeGates`) is idempotent and
logs each new decision identity once. Real-PR dry run:
`relay merge-check <task> --json`.

### Factory E2E: dsh → VERIFY → Claude review → MergeReady (ISH-762)

`relay run factory <task-id>` (or `runFactoryTask`) drives ONE Task through the
whole factory with **no hand-driven TUI/pane for the coding**: a real headless
dsh Run implements, Relay **mechanically VERIFYs** the recorded worktree/HEAD, an
**independent headless Claude** reviewer (`claude -p --output-format json`,
`--permission-mode auto` by default — **never** `bypassPermissions`; an approval
mode, not an OS sandbox; the brief carries the mechanical VERIFY result) returns
a **structured** FIX/PASS, a FIX is the **SAME worktree + a
fresh dsh Run** with the findings, and a PASS reaches **read-only MergeReady**.
It is sequencing only — every transition reuses the ordinary durable results
(`acceptRunSubmission`, `runMechanicalVerification`, `recordReview`,
`submitPhase`), so a `dsh` exit 0 / `final`, a missing/malformed reviewer result,
a foreign/stale HEAD, or a non-independent reviewer **cannot advance** the Task.
The Factory never pushes, merges, accepts, or writes a provider/Linear.
**ISH-1087:** the dsh worker opens the PR (title `ISH-<n>: <what>`, body from the
target repo's `.github/pull_request_template.md` with a `## Documentation Impact`)
before its Run ends; the Factory records the repo at intake, **always** binds the
PR head before review (a Task that records only a branch included), and
`relay run factory` requires the ISH-883 native review at that head. No PR →
`blocked`, never `merge_ready`; the merge gate reports the bound PR
(`pr=owner/name#n@sha`). A merge with no bound PR is never credited by Relay.
A non-ready result (`max_attempts`, `review_refused`, `blocked`, …) also carries
the **ISH-1013 failure projection**: a minimal class (code rework exhausted /
infra blocked / permission-or-human decision / missing-or-inconclusive evidence /
stale head / unknown), the evidence-derived cause, the last Run/attempt/HEAD,
references to the failing check/review/log, and the concrete next action + resume
condition. The same projection is a durable `factory.outcome` event and is shown
by `relay run show` / `relay run logs` / `relay task show`; it never auto-unblocks
a HOLD, a missing permission, a live writer or stale evidence. See
[`docs/factory-e2e.md`](docs/factory-e2e.md).

### Native GitHub PR Review, HEAD-bound (ISH-883)

The independent headless reviewer can **post a native GitHub Pull Request Review
itself** (a `COMMENT` review, with actionable `path:line` inline comments, from its
disposable review checkout — never the coding writer's tree, never a push or a
merge). Relay then accepts the verdict only after reading the **actual** GitHub
review back — never the reviewer's own URL or JSON verdict. The review body must
carry the head-pinned `<!-- ishiul-review head=<sha> verdict=OK|NG|HOLD
reviewer=<id> -->` marker, and Relay requires that the reviewer's **newest**
review at that HEAD is a submitted **`COMMENTED`** review (a
`PENDING`/`DISMISSED` review is never a verdict) by the expected GitHub `author`,
pinned to the exact reviewed `commit_id`, on the bound `PR number`, posted
**after any base-change invalidation at that HEAD**, with GitHub's **current** PR
head still that commit. That newest review's marker must match the structured
verdict — a newer contradicting review is **REFUSED**, never shadowed by an older
matching one. A missing review, a foreign author, a mismatched HEAD/PR, a moved
HEAD, a stale same-HEAD review, a contradicting newest review, or an unreadable
read is **REFUSED** (fail closed — the Task never advances); the verified review
id/url is retained in the local evidence next to the structured verdict. The
review body must also carry `## Findings — attempt <n>` (or `No findings.`) so the
attempt-N finding text is readable from the PR itself, not only in Relay's local
`.relay/` evidence. Mechanical VERIFY and the merge gate are unchanged.

This external write is **deny-by-default** (ISH-288) for a direct reviewer call:
the reviewer is given the `gh` shell + a scoped token (`RELAY_REVIEW_GH_TOKEN`,
else `GH_TOKEN`) ONLY when an operator grants `RELAY_GITHUB_REVIEW_WRITE=1`
**and** names the gh-authenticated login the review posts as
(`RELAY_REVIEW_AUTHOR=<login>`) with `RELAY_PROVIDER_GITHUB=gh`. The **Factory**
(ISH-1087 owner decision) authorizes the reviewer's `COMMENT` review by default,
derives the author from `gh api user` unless `RELAY_REVIEW_AUTHOR` is set, and
auto-detects the reader; `RELAY_GITHUB_REVIEW_WRITE=0` opts out, after which
`relay run factory` refuses to reach MergeReady. Without the grant the plain
reviewer keeps the local structured-verdict path and Relay requires no native
review. `--allowedTools` is an approval allowlist, **not** an OS sandbox — Relay
does not claim process
isolation from it. The reviewer model is configurable (`RELAY_REVIEW_MODEL` /
`--model`, default `opus`).

**PR check (ISH-880/885/1087, read-only):** a Sandbox-produced commit is bridged
to a real GitHub PR **before the review stage** (`FactoryDeps.prBinding`). The
Factory records `pr_repo` at intake from the Task identity or the workspace/source
`origin` (`--pr-repo` overrides), re-reads the PR and requires its live `headSha`
to equal the produced commit; a moved/unreadable/other-repo PR — or no
identity/adoptable PR — **blocks** before the reviewer runs. A Task that records
only a branch is therefore still bindable. `relay pr bind <task-id>` re-reads and
verifies the PR (an authenticated `gh` is auto-detected; `RELAY_PROVIDER_GITHUB=off`
disables it), and `relay merge-check <task-id>` prints the bound PR. The **Coding
Agent** owns the GitHub write (`git push` + `gh pr create`/update) and the Claude
reviewer posts the native review; **Relay never writes to GitHub** (the ISH-880
`--publish`/`githubWrite` write path was removed). A merge with no bound PR is
never credited (`CODE_CHANGE_GATE: NO_PR`). See
[`docs/pr-binding.md`](docs/pr-binding.md) and
[`docs/ish-1087-factory-pr-contract.md`](docs/ish-1087-factory-pr-contract.md).

### Headless dsh Runs (no Herdr)

A coding attempt can run as **one `dsh --profile headless --json` process** — no
Herdr pane, TUI, `dsh web` server, wake plugin, or manual attach (`relay run
start`, `list`, `show`, `logs`, `cancel`, `submit`). Under `<control-plane>/runs/<run-id>/`:
`stdout.log` is the **raw dsh JSONL event stream** (`session`, `status`, `text`,
`thinking`, `tool_call`, `tool_result`, `final`/`error`), `stderr.log` carries
reasoning/errors, **`dsh.jsonl` is the ORIGINAL dsh events captured verbatim as
per-Run evidence**, and `events.jsonl` is **Relay's own lifecycle log** (a
`dsh.event` annotation only — never a dsh payload). The durable `runs` row is
keyed to the Task (it is not a second workflow state), records the dsh `sessionId`
and both the pre-run `base_head_sha` and the PRODUCED HEAD re-read in the worktree
at Run end (dsh is asked to commit). `relay run start` waits for a terminal state.
Cancel/timeout kill the whole process group. Permissions stay in the worktree
(`DSH_PERMISSION_MODE=workspace-write`). A process `exit 0` or a terminal `final`
event is **not** a submission — only a structured `relay run submit` bound to the
current Run/Task/phase/attempt/branch/HEAD advances the Task (a task with no
linked branch/HEAD yet adopts the Run's; the recorded head is the produced one);
a non-zero/cancelled/stale Run never does. `relay run logs <run-id>` renders the
read-only session id + ordered `tool_call`/`tool_result` chronology (no TUI/Web UI
needed). This covers one Run's launch/observe/terminate only; the Task worktree
(create/select/own), single-writer control and FIX re-entry are ISH-760 — see
[`docs/run-lifecycle.md`](docs/run-lifecycle.md). See
[`docs/dsh-headless-runner.md`](docs/dsh-headless-runner.md) for the pinned
`dsh` CLI contract and the exact file/output format.

### Task worktree + Run lifecycle, single-writer (ISH-760)

`relay run launch` is the Task lifecycle entrypoint (still no Herdr pane/attach):
it **owns one branch + worktree per Task** (`relay run worktree`, under
`<control-plane>/worktrees/`, never shared `/tmp`), **pins the Run brief** (task
text + verification steps + the **previous findings**) into the worktree BEFORE
launch, and runs **one disposable dsh Run per phase/attempt**. A **FIX is the
same worktree + findings + a NEW Run** — no session continuation.

**Single-writer** is enforced in the runner: while a Run is non-terminal, another
launch into the same worktree/branch is refused (`DUPLICATE_WRITER`) until the
previous Run's end/cancel row exists. The existence check and the Run INSERT are
one `BEGIN IMMEDIATE` transaction, so the guard is **atomic across processes**
(two concurrent `relay run launch`/`start` processes cannot both be admitted), and
`launchTaskRun` refuses **before** pinning the brief so a rejected launch never
touches the live writer's worktree. **Different** worktrees/branches may run in
parallel, even on the same files. A Run is **not** a submission: `relay run
submit` is the only thing that advances the Task, and it refuses a stale/late/
superseded Run (by Task/phase/attempt/**generation**/branch/HEAD). `relay run
cleanup` reclaims a worktree only when it is **safe** (a real merge or `--abort`,
no open PR, no active writer, no uncommitted changes, relay-owned) and always
**retains the run logs** as evidence. See
[`docs/run-lifecycle.md`](docs/run-lifecycle.md).

**Pre-launch disk guard (ISH-1009).** Before a Run row is created, and before a
Task workspace is created or a sandbox Run starts, Relay measures free space on
the worktrees root and the volume holding the Relay DB. Below
`RELAY_MIN_FREE_DISK_BYTES` (default 20 GiB) no Run starts: the Task stays
`queued` and `run.launch_refused` records reason `low_disk`, the measured bytes
and the threshold. A failed probe is **also** a refusal (`probe_failed`), never
a pass. `relay status` and the dashboard show the live measurement and the last
refusal; the next launch attempt after space is freed proceeds normally. A
Sandbox Run additionally probes the in-VM DinD volume (`/var/lib/docker`)
against `RELAY_MIN_FREE_DIND_BYTES` (default 2 GiB; `0` disables).

### Task Coding Sandbox lifecycle (ISH-828)

`relay run sandbox` runs a coding Task inside its own **Docker Sandboxes
clone-mode microVM** instead of a host worktree. `relay run sandbox create`
(or `launch`) creates, or **selects and reuses**, one sandbox per Task
(`sbx create --clone --name <name> <agent|kit> <main-checkout>`), refusing a
linked worktree as the clone source. The Task→sandbox `name`/`branch`/`HEAD`
mapping is durable in SQLite (`sandboxes`), and each Run/attempt is a fresh
`dsh` started with `sbx exec` inside the same sandbox — a **FIX reuses the
sandbox** with the previous findings pinned into the brief. The original dsh
JSONL, Relay's events and the produced commit (`git fetch sandbox-<name>`) are
recorded per Run; `exit 0` is not a submission. A fetch failure, a non-zero exit,
a cancel/timeout whose in-VM dsh survived (`orphaned`) and a stale/duplicate
submit all fail **closed**. `relay run sandbox cleanup` is dry-run by default and
refuses to remove the VM until the produced commit and every Run's evidence
directory are saved; run logs are retained. One-command fixture smoke:
`bun run smoke:sandbox`; the real-sandbox smoke is `bun run smoke:sandbox:real`
(opt-in). See [`docs/sandbox-lifecycle.md`](docs/sandbox-lifecycle.md).

### Daemon Run liveness sweep (ISH-1008)

A Run's terminal row is normally written once by the coroutine that launched it.
If that process dies — a crash, a reboot, or a failed ENOSPC terminal write — the
durable row used to stay `starting`/`running` forever, holding the single-writer
fence and alerting nobody. `reconcile()` now performs a **throttled liveness
sweep** (`RELAY_RUN_LIVENESS_MS`, default 45s) over every non-terminal Run:

- **launcher first** — the child can exit while the launching coroutine is still
  finishing (`git rev-parse`, or a sandbox `git fetch` before its terminal
  write). The Run row records the launcher PID + start-time token, and the sweep
  leaves the Run alone while that launcher may still write. The lease is cleared
  in the launcher's `finally`; only then may the sweep finish a row whose
  terminal write did not land.
- **local Run** — `identifyRunProcess` proves the recorded PID. A dead PID or a
  **reused** PID (the original dsh is gone) becomes `failed` with an
  `orphaned:` reason; a **live** PID is never touched and an **undeterminable**
  identity leaves the Run running so the fence keeps holding. The sweep never
  signals a local process.
- **sandbox Run** — reuses `sweepOrphanedSandboxRuns({ apply: true })`; the Run
  becomes terminal only when the in-VM dsh is confirmed **gone**. A still-alive
  or `unknown` dsh keeps the Run non-terminal.
- A just-inserted `starting` row with no PID yet gets a launch grace window
  (`RELAY_RUN_START_GRACE_MS`, default 2x the sweep interval / at least 60s), so
  the sweep never races a concurrent launch.

A proven death is never a success. The sweep reads the tail of the Run's own
`stderr.log`/`dsh.jsonl` and classifies the cause as `ENOSPC`, `OOM`, `signal` or
`unknown`, stores `cause=<CLASS>: <evidence>` in `runs.error`, emits a `run.died`
event, shows it on the dashboard (`RUNS` + `ATTENTION`), and sends immediate
`run_died` coordinator mail to the responsible owner (`RELAY_HUMAN` or the
nearest assigned ancestor). `stderr.log` is authoritative across all classes;
`dsh.jsonl` contributes only parsed terminal `error` events (never tool output or
a success `final` summary), and the last matching line in a source wins.
`relay run show <id>` projects `failure_class`. The sweep is failure-isolated: a
DB-write error (e.g. a full disk) does not crash the daemon, leaves the throttle
unadvanced, and the next reconcile tick retries. It does **not** implement a
pre-launch disk guard (ISH-1009) or stall detection for a live-but-silent dsh.

### Task-owned Network Lab skill + cleanup hook (ISH-845)

A coding Task may deploy an **arbitrary containerlab topology** on the shared
Network Lab. Relay stays **containerlab-agnostic**: it models no network, no NOS
and no topology, and adds **no `relay lab` command**. It knows only the Task's
**owner id** (`labOwnerId` = `<task id>-<created_at>`, never reused, handed out as
`RELAY_LAB_OWNER` and recorded as `lab.owner_assigned` when the Coding Sandbox is
launched) and *when* cleanup is due. The `network-lab` skill
([`skills/network-lab/SKILL.md`](skills/network-lab/SKILL.md), installed for the
pinned dsh at the real Sandbox skill path `~/.agents/skills/` by
`sandbox/coding-kit`) tells the agent to deploy with `labctl` under
`--namespace "$RELAY_LAB_OWNER"`.

`relay run [sandbox] cleanup <task-id>` reclaims the Task's external Lab through
**one trusted, pre-configured hook** (the repo ships a reference,
[`scripts/lab-cleanup.sh`](scripts/lab-cleanup.sh)), `RELAY_LAB_CLEANUP_CMD`,
invoked as `<cmd> <owner-id>` (the only argument). A Task-prompt-derived
shell/URL is never executed; with no hook configured — or no owner ever assigned
— it is a pure no-op. The hook runs only when the Task has **ended** (merged or
`--abort`) with **no active Run** — reaching `merge_ready` alone cleans nothing —
and a non-zero exit, a missing hook or a timeout is **recorded** and
**re-runnable** (`relay gc` refuses a Task whose Lab cleanup is still pending, so
its owner id stays addressable). The reference hook selects the lab by exact
owner name (`netlab-<owner>`), never by suffix, and fails closed if its workspace
purge does not succeed. Relay forwards a narrow, named `LABCTL_*` set
(`LABCTL_ENV_ALLOWLIST`) to the **hook only** (never to the dsh Run), so the hook
can authenticate without leaking host secrets into the sandbox. Image and
Shared-Lab VM management stay out of Relay.

### Historical cleanup: `relay gc`

There was no supported purge for old worker/runtime/session/task rows (fleet
cleanup needed raw SQL). `relay gc` is **dry-run by default**:

```bash
relay gc                              # report only (deletes nothing)
relay gc --apply                      # delete the reported rows
relay gc --apply --older-than 1h      # only rows older than a grace window
relay gc --apply --with-history       # also purge their events/messages/task_notes
```

- Only **retired** workers, **terminal** (`done`/`failed`) tasks,
  `stale`/`dead`/`cleaned` runtimes, and unmanaged/retired sessions are
  eligible. Live workers and non-terminal tasks are never selected, and every
  `DELETE` re-asserts that predicate.
- A terminal task still required as a dependency (or with a non-terminal child)
  is **skipped**, not deleted.
- `events`, `messages` and `task_notes` are **never** touched without
  `--with-history`; with it, only rows referencing the purged workers/tasks go.
- Every applied run logs `gc.applied`.

### Clean hand-back: `relay release`

The only other exits for a running task were `block`→`unblock` or
`submit`→`reject`, both of which fabricate a block/reject note just to fix
ownership. `relay release <task-id> [--worker <id>]` hands a **running** task
straight back to `queued`:

```text
running -> queued   assignee=NULL  lease_until=NULL  lease_token += 1
owner.current_task_id cleared       task_notes kind='release'   event task.released
```

The current assignee may release, **and a human/any other worker may also
release** — this is the recovery path for a mis-claimed task whose owner is gone
(no hard fencing is imposed, by design). The bumped `lease_token` still fences
the old owner's later `submit` with `STALE_LEASE`.

## Single-supervisor invariant

```text
Relay is a single-supervisor control plane.

One physical (canonical) SQLite control-plane DB must have exactly one active
Relay daemon. Running multiple Relay daemons against the same DB is unsupported
and rejected.
```

The daemon owns generation allocation, liveness reconciliation, restart
decisions, and the project Unix socket, so two daemons on one DB would race on
all of them. Singleton ownership belongs to the **physical SQLite file**, not to
a path spelling and not to a socket path: the DB is canonicalized with
`realpath`, symlink aliases converge on one lock, and a different `$RELAY_SOCK`
cannot smuggle a second supervisor onto the same state. The boundary is enforced
at startup, locally (no distributed lock, no leader election):

- **the supervisor lock is an OS-backed SQLite writer lock, not a lockfile.**
  Relay derives `<canonical-state-db>.relay-lock.db` and holds a long-lived
  `BEGIN IMMEDIATE` transaction on it for the daemon lifetime. A second supervisor
  cannot acquire that SQLite writer lock and is rejected with a clear
  "already has an active supervisor" error. If the owner process exits or crashes
  (even `SIGKILL`), the OS/SQLite lock is released automatically — there is no
  pid, token, mtime, grace window, or stale-reclaim step. The lock DB is just a
  reusable container (`file exists != lock held`) and is never deleted; the
  canonical `state.db` itself is **never** held under a long-lived transaction;
- the daemon probes `.relay/relay.sock` before binding: a **live** listener is
  never unlinked (a second daemon is rejected), only a **stale** one (file
  exists, nobody answers) is reclaimed; a non-socket file at the path fails
  closed;
- a bind failure is **fatal** in production, so there is never a socket-less
  "poll-only" second supervisor;
- `relay daemon --once` runs the same acquisition (it executes a supervisor
  pass) and refuses while a live daemon owns the DB.

Legacy `<canonical-db>.relay.lock` files from older versions are ignored: the
SQLite supervisor lock is the singleton authority, and no migration cleanup is
performed.

Within this single-supervisor boundary, generation allocation stays simple and
process-local (`restartingWorkers` in-flight guard + a commit-time generation
re-check). Tests inject `MockRuntime` + `bypassSingleton` to bypass the guard.

## `relay dashboard` (read-only)

`relay status` stays a lightweight, greppable one-shot. `relay dashboard` is the
human view: the **task tree**, the **workers** with each one's *current* runtime
overlaid, **ATTENTION**, and (ISH-1008) the **RUNS** — live headless Runs plus
recently-died ones with their classified cause — all rendered from the Relay
domain functions, never by re-reading the SQLite schema.

```bash
relay dashboard                     # one render to the current terminal
relay dashboard --watch             # redraw in a loop (Ctrl-C/q to stop)
relay dashboard --watch --no-alt-screen  # draw inline instead (for piping/logging)
relay dashboard --show              # open/reuse a Herdr pane next to this one
relay dashboard --show --tab        # ...in its own tab
relay dashboard --hide              # close the tracked dashboard pane
relay dashboard --doctor            # source check (db / socket / herdr / counts)
relay dashboard --json              # machine-readable view
relay dashboard --runtime-history   # include old runtime generations
```

It is **read-only**: it never creates tasks, mutates workers, sends messages or
starts/stops runtimes. The one pane it manages is its own UI pane (tracked in
`.relay/dashboard.pane`), and that pane is not a worker.

`--watch` follows the pane as it is resized: width **and height** are re-read on
every redraw (and a `resize` event triggers an immediate redraw, rather than
waiting for the next tick), so dragging the pane drops `progress -> generation
-> pane` in that order and never overflows. Full-width (CJK) characters count as
two columns. Three things keep it readable:

- **Clipped to the pane height.** A frame taller than the pane would scroll into
  the scrollback, and a full-screen erase clears only the *visible* screen — so
  every redraw appended another stale copy. Each frame is clipped to the pane
  height **minus one row** (a line that exactly fills the pane width sets the
  terminal's wrap-pending flag, so the next line-feed would scroll) and written
  with **no trailing newline**, so it can never overflow or accumulate.
- **Alternate screen is opt-in inside Herdr (T340).** `herdr pane read` reads the
  *normal* screen, and some Herdr/terminal setups never show the alternate screen
  buffer — so an alt-screen dashboard looks **blank** in a Herdr pane (where the
  fleet runs). `--watch` therefore draws **inline** by default when
  `HERDR_ENV=1`/`HERDR_PANE_ID` is set. `--alt-screen` forces the alternate screen
  (prior screen restored on quit); `--no-alt-screen` forces inline anywhere. Inline
  is **scrollback-clean**: the loop homes and clears each line (`ESC[2K`) instead
  of a full-screen erase (`ESC[0J`/`ESC[2J` both push the erased window into
  scrollback), so past frames do not accumulate. A non-interactive stdout is never
  alt-screened.
- **Pause and scroll (`space`/`p`, then `↑`/`↓`, `j`/`k`, PageUp/Down).** Pausing
  freezes the view with a `PAUSED` banner showing the visible line range
  (`lines 1-11/88`); the arrows/`j`/`k` scroll it so the clipped tail is
  readable, and space resumes at the live top. `Ctrl-C`/`q` exits and restores
  the terminal (cursor, screen).

### WORK (phase, not bare state)

A code-change task renders its workflow **phase** instead of the lifecycle
state, because a live factory lane and a `merge_ready` task both sit in state
`queued`:

```text
WORK
T140     running implement/2  storage engine  [fix-rust]
T141     merge_ready          ready for acceptance  [-]

HISTORY
  ✓ 34 done   ✕ 2 cancelled
```

`implement/N` carries the current rework attempt; `verify`, `review`,
`integration` and `merge_ready` render as themselves. `running`, `failed` and
the `blocked_*` states stay visible next to the phase so the phase never hides
an actionable lifecycle state. Terminal `done`/`cancelled` leaves are not
interleaved with live work; they are summarised in `HISTORY` (and still counted
in the header summary). `failed` stays in WORK because it needs attention.

Worker and Runtime stay distinct. A worker row is:

```text
WORKERS
  dp-1   running   busy    T140   g3   w52:p8K   6m
         ^Relay    ^Herdr  ^task  ^generation  ^pane  ^progress age
```

- the **Relay state** (`idle working waiting_input stalled dead`) is control
  plane;
- the **execution** column is Herdr telemetry only (`busy idle quiet !idle
  starting unavailable`). `!idle` means "the worker is `working` but the pane is
  idle with no quiet lease" — an ATTENTION row, never a state change.

### WORKERS grouping (task affinity)

Workers are **flat peers**; tasks may form a **tree**. The WORKERS section is a
*projection* of the flat worker set onto the authoritative task topology, so the
two sections read together:

```text
WORKERS

T149  CP-W3 control-exactness wave  next: T153
  program-coord    working  busy   T149  g1  w6D:p1   3s
  control-rust     idle     idle   -     g2  w6E:p2   14m

AVAILABLE / OTHER
  corpus           idle     idle   -
```

The `next:` on a cluster header is the **dashboard form of `relay status`'s
`next:`**: the runnable work that cluster's members could pick up right now,
computed with the same policy and the same rule (never a task a member already
owns or anchors on). It is shown once per cluster, not once per worker, and is
capped to one line (`T1,T2,T3,T4,+2 more`). A cluster with no backlog simply
omits it.

Each worker gets exactly **one** derived `anchor task` (never stored):

1. `worker.current_task_id` — **ownership is observed truth** and wins over any
   role rule (including a task held via `--any-role`);
2. otherwise the task it could claim now, via the **same** domain functions
   `relay next` uses (`claimableRunnableTasks` / `reviewTasks`) — the dashboard
   never reimplements role matching. Reviewers take the review queue first,
   exactly as `claimNext` does;
3. otherwise the worker goes to **AVAILABLE / OTHER**.

The cluster is the child directly below the root ancestor (a root task clusters
under itself), so a big program root does not swallow every worker into one
block. Cluster order matches WORK preorder; within a cluster, the anchor's
preorder position comes first, then current owners, then worker state, then id.

Important properties, all covered by `tests/dashboard-affinity.test.ts`:

- **no worker hierarchy is invented** — indentation means "relates to this task
  cluster", never "reports to". `integration-coord` is a peer of `perf-rust`;
- **no durable grouping exists** — no `parent_worker_id`, `coordinator_id`,
  `worker_group_id` or `cluster_task_id` column is added; grouping is recomputed
  every build and follows task reparent / claim / completion automatically;
- **no name or role is special-cased** — a coordinator appears near the top only
  because it currently *owns* a cluster-root/ancestor task;
- a worker is **rendered exactly once**, never duplicated across clusters it
  could claim from; unclaimable tasks attract nobody (they surface as ATTENTION);
- affinity is **not ownership**: an idle peer keeps `-` in the task column and
  may show a small `→T150` hint (wide layouts only).

`--json` preserves the split (`workers[].state` vs `workers[].execution.state`,
`workers[].runtime`) and adds the derived projection:

```json
{ "id": "control-rust", "state": "idle", "taskId": null,
  "affinity": { "anchor_task_id": "T150", "cluster_task_id": "T149", "source": "claimable" } }
```

plus `worker_clusters` (`cluster_task_id` null = `AVAILABLE / OTHER`, and each
cluster carries `claimable_task_ids` — the header's `next:` queue).

### ATTENTION

```text
ATTENTION
  ! program-coord   unread messages=1 (next nudge in 42s)
```

The unread countdown is computed by the **same** policy the supervisor uses
(`src/mail-policy.ts`: `mailNudgeMs`, `IMMEDIATE_MAIL_KINDS`, `nextMailNudgeIn`),
so the dashboard and the daemon cannot drift. `(nudge now)` means an immediate
notice (`child_done` / `child_blocked` / …) is queued and will be delivered on the
next tick.

### Ctrl+click a pane

Pane ids are OSC8 links (`https://relay.local/pane/<pane_id>`). With the bundled
Herdr plugin installed, a Control+click focuses that pane:

```bash
herdr plugin link "$(pwd)/integrations/herdr"   # relay.pane-links
```

See `integrations/herdr/README.md`. The handler is `relay dashboard --focus`
(thin shim, no Python).

## `relay web` (browser view + send)

`relay dashboard` is the terminal view. `relay web` serves the same durable
state (workers, tasks grouped by state, per-mailbox unread counts, and a
selected worker's inbox) as a single self-contained HTML page, plus a small
JSON API:

```bash
relay web                              # http://127.0.0.1:8787
relay web --port 9000
relay web --host 0.0.0.0 --token "$(openssl rand -hex 16)"   # reachable from the tailnet
#   open  http://<tailscale-host>:8787/?token=<t>
```

- **Loopback by default.** It binds `127.0.0.1:8787` unless you opt in with
  `--host`. `--host 0.0.0.0` (or a tailnet address) makes it reachable from
  another machine — e.g. over Tailscale — which is why the host/port are
  explicit rather than assumed.
- **Token.** `--token <t>` (or `RELAY_WEB_TOKEN`) is required on **every**
  request once set: `Authorization: Bearer <t>` or `?token=<t>`. With a
  non-loopback bind and no token it prints a prominent warning and still starts
  (the simple path the user asked for) — anyone who can reach the port can then
  read state and send messages, so set a token on a tailnet.
- **Read-only GETs.** `GET /api/status` and `GET /api/inbox?worker=<id>` open
  the shared SQLite WAL **read-only**, so the view can never mutate state or
  race the daemon. Viewing an inbox does **not** mark mail delivered (the
  worker's own `relay inbox` is still what consumes it).
- **One writer.** `POST /api/send` `{worker, message, kind?}` enqueues through
  the **same** durable `sendMessage` path `relay send` uses — there is no second
  delivery mechanism. `kind` is `note` (default) or `urgent`; the daemon's mail
  policy delivers/wakes the recipient at the turn boundary. The page polls
  `/api/status` every ~3s.
- **No new dependencies and no external assets**: `Bun.serve` plus the repo's
  existing DB helpers, and the page's CSS/JS are inline (a tailnet may have no
  internet). It is an ops view — no accounts, no websockets.

## Install

```bash
scripts/install.sh   # build + install the artifact (recommended, see Setup)
```

The installed `relay` is the **built bundle** (`dist/cli.js`), not `src/cli.ts`,
so an uncommitted edit to `src/` cannot break the live CLI (T338). For a quick
hack without installing globally, run the source directly:

```bash
bun "$PWD/src/cli.ts" status        # or: export RELAY_BIN="bun $PWD/src/cli.ts"
```

Build only (no install): `bun run build` → `dist/cli.js`. Install straight from
git with:

```bash
bun install -g github:81ueman/relay   # installs the package; run scripts/install.sh to pin the artifact
```

Requires: Bun ≥ 1.1, `herdr` on PATH, OpenCode v2.
**Herdr is mandatory**: the daemon fails to start when the herdr CLI/socket is
unavailable (`relay requires Herdr; ...`). There is no mock fallback, no tmux
backend and no capability negotiation — `MockRuntime` exists only so tests can
inject a transport.
Plugin shape verified against the bundled `herdr-agent-state` integration
(default export `{ id, setup }`) and `@opencode-ai/plugin` types (custom tools).

## CLI help

```bash
relay --help              # full command list
relay task --help         # help for a command
relay task add --help     # help for a subcommand (also: `relay help task add`)
```

Every command and subcommand accepts `-h` / `--help`.

## Setup

```bash
scripts/install.sh   # bun install + build + install the BUILT artifact + plugin symlink
relay init           # creates .relay/state.db (WAL)
relay daemon         # reconcile loop + Unix socket .relay/relay.sock
```

**The installed CLI is a BUILD ARTIFACT, not the repo source (T338).**
`scripts/install.sh` runs `bun run build`, copies `dist/cli.js` to a stable path
outside the repo (`~/.local/share/relay/cli.js`) and writes a launcher
(`~/.bun/bin/relay` or `~/.bin/relay`) that `exec`s it. It does **not** `bun link`
and never symlinks the bin to source, so an in-progress edit to `src/` can no
longer break the fleet's `relay` command. The consequence:

```bash
# editing src/ does NOT change the live CLI until you rebuild+reinstall:
bun run build && cp dist/cli.js ~/.local/share/relay/cli.js
# (or re-run scripts/install.sh)
```

`relay --version` reports the embedded source commit
(`relay 0.1.0 (build 772e107)`); run from inside a relay checkout it warns when
the installed build is behind repo HEAD. The build injects the commit/version via
`scripts/build.ts` (`--define`), so a bundle is self-identifying. **The daemon
must be (re)started from the installed build** (`~/.bun/bin/relay daemon` or
`bun ~/.local/share/relay/cli.js daemon`) so a restart runs what is installed.

### Where the control plane lives (`relay db`)

By default the control plane is **in the repo** (`<repo>/.relay/state.db` + the
socket beside it). That is all a worktree of the *same* repo needs — the git
common dir resolves it (below). To share ONE control plane across **different**
repos (e.g. the relay tool's worktree coordinating the nv-papers fleet) without a
`.relay` symlink, specify the location explicitly:

```bash
relay db path      # which DB wins, and why (env / config / legacy / xdg)
relay db sources   # every candidate in the resolution order
relay db move <path-to-state.db>          # dry-run plan (no writes)
relay db move <path-to-state.db> --apply  # move DB + WAL/SHM out of the repo
```

Resolution order (first match wins):

1. `RELAY_DB`
2. `~/.config/relay/config.json` (`{"db": "<path>"}`; see `relay config`)
3. legacy `<repo>/.relay/state.db` **if it exists** (backward compatible)
4. `<cwd>/.relay/state.db` (the historical default)

The socket always lives **next to** the resolved DB, so a shared control plane
shares its socket. `relay db move` refuses to overwrite an existing DB, refuses
while a socket is present (a daemon may be live), and moves `state.db` **and** its
`-wal`/`-shm` sidecars (a partial move would lose recent commits). Existing repos
are unaffected: a legacy `state.db` always wins over any external default.

The OpenCode plugin (`.opencode/plugins/relay.ts`) and Skills
(`skills/agent-worker/SKILL.md` and `skills/parallel-worktrees/SKILL.md`,
symlinked from `.opencode/skills/`) are auto-discovered under this repo:

```bash
opencode plugin list   # relay ... .opencode/plugins/relay.ts
```

The `agent-worker` and `parallel-worktrees` skills are also published through APM
(Agent Package Manager):

```bash
apm install -g --target agent-skills 81ueman/relay
```

APM deploys skills only. Install the `relay` CLI itself with `scripts/install.sh`
(runs `bun install`, `bun run build`, installs the built artifact to
`~/.local/share/relay/cli.js` behind a launcher, and symlinks
`.opencode/plugins/relay.ts` into `~/.config/opencode/plugins/relay.ts`).

Identity / paths / tuning:

```text
$RELAY_WORKER (or --worker, or .relay/worker-id)
$RELAY_DB (default .relay/state.db), $RELAY_SOCK (default .relay/relay.sock)
RELAY_LEASE_MS=120000 RELAY_LEASE_LIVENESS_GRACE_MS=300000
RELAY_STALL_MS=60000 RELAY_LOW_WATER=3 RELAY_ROLE_STRICT=true
RELAY_WAKE_COOLDOWN_MS=30000 RELAY_AUTO_APPROVE RELAY_INTERVAL_MS=1500
RELAY_HERDR_WORKSPACE=<ws>   # REQUIRED to spawn (falls back to $HERDR_WORKSPACE_ID)
RELAY_RUNTIME_CLEANUP_GRACE_MS=300000 RELAY_ATTACH_TIMEOUT_MS=30000
RELAY_RESTART_COOLDOWN_MS=30000 RELAY_CLEANUP_LOG_WINDOW_MS=60000
RELAY_BOOTSTRAP_RETRY_MS=5000 RELAY_BOOTSTRAP_LOG_WINDOW_MS=60000
RELAY_TOOL_WARN_MS=60000 RELAY_TOOL_BACKGROUND_MS=180000
RELAY_TOOL_MAX_MS=3600000 RELAY_TOOL_STALE_GRACE_MS=60000
RELAY_TOOL_HARD_CAP_MS=900000 RELAY_TOOL_NO_OUTPUT_MS=600000
RELAY_MIN_FREE_DISK_BYTES=21474836480   # 20 GiB pre-launch floor (0 = threshold off)
RELAY_MIN_FREE_DIND_BYTES=2147483648    # 2 GiB sandbox DinD floor (0 = probe off)
RELAY_BACKGROUND_KEY=ctrl+b
RELAY_WEB_TOKEN=<t>          # token required by `relay web` (unless --token is given)
RELAY_DEDICATED=1            # opt-in: allow $RELAY_SOCK when no session dir is known
```

Spawning **requires** an explicit Herdr workspace. `herdr tab create` is
always called with `--workspace <ws>`; if no workspace is configured the spawn
fails closed rather than silently using the currently focused workspace (which
is how agents once landed in an unrelated workspace).

### Git worktrees: one control plane per repository

A linked git worktree (`~/.herdr/worktrees/<repo>/<lane>`) has no ancestor
`.relay`, so it used to be unusable: the plugin resolved no socket (dropping
every event) and the CLI could not find `state.db`. Both now resolve the **main
checkout** through the git common dir, so a worktree session attaches to the
main repo's daemon automatically — no manual `.relay` symlink:

```text
<worktree>/  --git rev-parse --git-common-dir-->  <main>/.git  -->  <main>/.relay
```

- Same repository ⇒ the resolution can never cross-route to another project's
  control plane; per-directory routing stays fail-closed (a directory with no
  repo/`.relay` still drops).
- `relay session attach` records the worktree root in the session row
  (`directory` / `worktree`); the control plane itself stays centralized in the
  main checkout, so one ledger serves every lane.

### Codex and Claude Code agents

A worker is not necessarily OpenCode. `workers.agent_kind` records the harness
(`opencode` | `codex` | `claude`); it is set from the resolved Herdr agent kind
at attach. The Factory's own reviewer/integrator principals are headless and
store `agent_kind = 'headless'` instead: they never own a Herdr pane, so they
are excluded from pane-attention checks (a real `claude` pane worker is not).
The registry lives in `src/harness.ts` and pins two axes:

| kind | idles via | Herdr `agent start --kind` |
| --- | --- | --- |
| `opencode` | plugin **events** | `opencode` |
| `codex` | Herdr **poll** | `codex` |
| `claude` | Herdr **poll** | `claude` |

**Claude Code** is polled exactly like Codex (Herdr `agent_status`, no plugin):

```bash
relay session attach --session <uuid> --kind claude --worker claude-1 --role design-v4
```

**Headless dsh Runs** are a separate, non-session path — a disposable
`dsh --profile headless --json` process with no Herdr pane, plugin or wake; see
[Headless dsh Runs (no Herdr)](#headless-dsh-runs-no-herdr).

- A **codex/claude session id is a UUID**, not `ses...`. The socket/CLI attach
  accepts it ONLY when `kind` is declared (and it matches the UUID shape), so the
  OpenCode `ses...` guard is not weakened: an undeclared non-`ses` id is still
  refused.
- A **polled** harness (codex, claude) has **no plugin event stream**, so relay
  does not wait for `session.idle`. The reconciler polls Herdr `agent_status`
  each pass and maps it onto the same state machine an idle event runs: `working`
  = progress (never stall a busy agent), `blocked` = `waiting_input`, unreachable
  = `dead`, and `idle`/`done` runs the idle transition (nudge to the next task, or
  continue a running one). Each poll logs `worker.status_polled`.
- Wake/detach/retire/recovery go through the harness's Herdr-pane wake path and
  the same worker/runtime rows.
- Existing workers default to `agent_kind = 'opencode'` (idempotent migration).

## Managed sessions: plain `opencode` stays untouched

Herdr-runtime is mandatory; Relay *management* is optional. Running OpenCode
inside Herdr is **not** the same as being Relay-managed. The plugin loads
everywhere but does nothing by itself: a session that just runs `opencode` is
**unmanaged** — no DB writes, no subprocess, no Herdr calls, no reaction to
idle, no auto prompt, no task claim. The daemon ignores its events (verified by
contract test B).

```text
Herdr session + unmanaged
        │ agent_attach
        ▼
Herdr session + managed
```

There are exactly two ways a session becomes managed.

### A. Attach an existing Herdr session (relay_owned = false)

Attach a live session without restarting it (custom tool or CLI):

```text
agent_attach(role="worker")   # OpenCode tool; context gives sessionID/directory/worktree
agent_attach(role="worker", pane_id="$HERDR_PANE_ID")  # shared checkout: name your pane
agent_detach()
```

```bash
relay session attach --session ses_xxx --dir <project>   # identify the pane by directory
relay session attach --session ses_xxx --pane <pane>     # or by explicit Herdr pane
relay session attach --session ses_xxx                   # no --dir: uses $HERDR_PANE_ID (your pane)
relay session detach --session ses_xxx
relay session list
```

When several opencode agents run in the SAME directory (a shared checkout), the
directory identifies nothing: Herdr no longer reliably reports `agent_session`,
so a manual attach with only `--dir` is ambiguous and is refused, and the worker
stays at gen 0 / runtime null even if it then claims a task. Pass the pane
explicitly (`pane_id` / `--pane`, or omit `--dir` so the caller's own
`$HERDR_PANE_ID` is used). Every rejection is logged as `session.attach_failed`
and `relay status` lists workers that hold a task without a managed session.

The daemon **resolves the session's Herdr identity before any DB write**
(agent, tab id, pane id, workspace id). If Herdr itself reports a session id for
a pane, that mapping is authoritative. Otherwise the daemon identifies the pane
by the session's `directory`: **exactly one** live `opencode` agent must run
there. This is why a shared OpenCode server (`opencode serve --service`) is
safe — its process env names no session, so the plugin never sends pane env; it
sends the session id and project directory, and the daemon resolves the pane
itself. An explicit `--pane`/`--tab`/`--workspace` hint (or the plugin's pane
env on a dedicated server) is verified against that pane's cwd. If the identity
cannot be proven — missing, ambiguous, or a mismatch — the attach is
**rejected** (`attach failed: session is not running inside Herdr`): Relay never
guesses and never creates a half-managed state (`managed=true`, `runtime_id=null`).

On success the existing runtime is registered as the worker's current runtime:

```text
worker.state = idle            worker.runtime_id = <herdr agent>
worker.opencode_session_id = <session>   worker.generation = N
session.managed = true         session.generation = N
worker_runtime: state = active  relay_owned = false  tab_id/pane_id = existing
```

Attach bumps a per-session `generation`; events carrying a stale generation are
ignored (zombie-session protection). Re-attaching the **same** session to the
same worker on the same Herdr agent/tab/pane is idempotent (no new generation,
no new runtime row), and a worker that already owns a task — or a boundary that
another managed session already holds — is rejected rather than silently
rebound. Detach returns the session to normal: it clears `session.managed` and
the worker's session binding, so a detached worker is never woken, polled,
stalled or restarted again. A worker that still owns a task cannot be detached
(`submit`/`block`/`requeue` first). **No process is restarted, detach is not a
destroy, and Relay never closes the adopted tab (or any `relay_owned=false`
runtime), even after cleanup grace.**

### B. Let Relay spawn a fresh Herdr runtime (relay_owned = true)

```text
Relay → herdr tab create --workspace <ws> --no-focus --label relay:<worker>:g<N>
      → herdr agent start --kind opencode --pane <pane>
      → fresh OpenCode session → agent_attach (auto) → managed
```

Sessions spawned by relay itself are **automatically managed**. Identity cannot
come from process env alone: a single OpenCode server (`opencode serve
--service`) can host many sessions and its env names at most one worker. So the
relay bootstrap prompt carries a per-spawn marker

```text
RELAY-ATTACH worker=<worker-id> gen=<generation> token=<spawn-token>
```

and the plugin reads it out of that session's own prompt text, then attaches
**that** session with the intended worker/generation. Plain `opencode` has no
marker and stays unmanaged. (`RELAY_MANAGED/WORKER/GENERATION/DB/SOCK` are
still exported into the spawned tab; `RELAY_AUTO_ATTACH=1` enables the
env-only path for dedicated one-server-per-worker deployments, but it is off by
default because a shared server cannot identify a session from process env.)

The `token` is the **per-spawn secret** (`worker_runtimes.attach_token`). A
relay-generation attach is **fail-closed**: it is accepted only when the
matching runtime row exists, is `relay_owned=true`, is `starting`/`active`,
**records a non-null token**, and the incoming token matches exactly. A tokenless
runtime row (legacy/corrupt) or a missing token is rejected — so a stale plugin
instance, another project's session, or an unrelated OpenCode session on the
same shared server can never bind a session it does not own. A managed session
also belongs to exactly one worker: a cross-worker attach is refused outright,
and once a generation is `active` on one session it can never be taken by
another session even with a valid token (the token proves generation ownership,
not a licence to rebind). A retry of the identical attach is an idempotent
success.

## Runtime generations (fresh start, stale old, later cleanup)

`worker_runtimes` is the history/cleanup authority; the `workers` row only
points at the **active** generation (`runtime_id`, `generation`,
`opencode_session_id`). Runtime states: `starting → active → stale/dead →
cleaned`. Each row also records **ownership**:

```text
relay_owned = true   Relay created this tab     → eligible for later cleanup
relay_owned = false  adopted via manual attach  → NEVER closed by Relay
```

Restart is **control-plane policy**, not a transport primitive: the Herdr
adapter has no `restart()`, only `wake`/`interrupt`/`start`/`cleanup`/`isAlive`/
`peek`. The supervisor composes a restart from those primitives:

```text
generation N (active)
      │ problem: task ownership released/requeued
      ▼
 mark stale (cleanup_after = now + grace)      # old tab NOT closed here
      │
      ▼
 best-effort interrupt of generation N's runtime
      │
      ▼
 start() fresh generation N+1: herdr tab create --workspace <ws> --no-focus \
   --label relay:<worker>:g<N+1> --env RELAY_MANAGED=1 --env RELAY_GENERATION=<N+1>
      │
      ▼
  ONE transaction: commit runtime row (gen=N+1, starting, relay_owned, attach_token)
  + point workers at it (generation=N+1, runtime_id, session=NULL, state=starting)
      │
      ▼
 ONLY THEN deliver the bootstrap (durable-before-wake); the plugin attaches with
  (worker, generation=N+1, token) and ALWAYS finds the committed runtime row
      │
      ▼
 worker active (state idle, generation N+1)
      │
      └─ old generation N: stale → grace → safe cleanup (relay_owned only) → cleaned
```

`HerdrRuntime.start()` is a transport primitive: it does **not** send the
bootstrap prompt and does **not** touch the DB. The supervisor records the
generation durably and delivers the prompt itself, so an attach that races the
prompt cannot arrive before its runtime row exists. If the spawn itself fails the
old metadata is kept (`worker.restart_failed`, backoff). If only the bootstrap
*wake* fails the generation is **kept** (`worker.bootstrap_failed`, runtime still
`starting`, worker still supervised) and retried at most once per
`RELAY_BOOTSTRAP_RETRY_MS` until it attaches or the attach timeout fires.

A generation that never attaches (agent up, no managed session) is marked `dead`
at `RELAY_ATTACH_TIMEOUT_MS`, but the worker stays **recoverable**: after the
restart cooldown the supervisor spawns generation N+2 and the timed-out tab is
reaped through the normal grace path. Only an explicitly detached worker (state
`idle`, no managed session, no relay-owned runtime for its current generation)
is left unsupervised forever.

Generation is a **per-worker fencing number and is monotonic**: every manual
attach, fresh spawn and restart computes
`nextGeneration = max(workers.generation, session.generation, MAX(worker_runtimes.generation)) + 1`.
A new manual attach on a worker at generation 4 is therefore >= 5, and a legacy
`worker.generation=2` with runtime history at 5 yields 6. Re-binding the exact
same session/worker/Herdr runtime is idempotent and does not bump it. Allocation
is **single-writer per worker**: a fresh spawn is guarded so overlapping
reconcile passes (the daemon loop and the immediate reconcile on a session error)
can never mint the same number twice and leave two runtime rows for one
generation; the commit transaction re-checks the number so a generation taken by
another daemon is never duplicated.

A dead/stalled **manual** runtime follows the same path: g1 (`relay_owned=false`)
goes stale but is never closed, and Relay spawns a fresh relay-owned g2.

Restart success is **not** "a tab exists": the worker stays `starting` until a
matching managed attach lands (or times out). Cleanup is a separate maintenance
pass and deletes a tab only when all of these hold:

```text
runtime.relay_owned == true            runtime.worker_id == worker
runtime.generation  < workers.generation   runtime.runtime_id != workers.runtime_id
state ∈ {stale, dead}   cleanup_after <= now
tab label == relay:<worker>:g<generation>
```

A `relay_owned=false` runtime is never a cleanup candidate, whatever its state,
and the adapter refuses such a cleanup outright. Cleanup failures are logged as
`runtime.cleanup_failed` and retried later; a leftover old tab is acceptable, a
stopped fresh worker is not. Repeated failures are recorded at most once per
`RELAY_CLEANUP_LOG_WINDOW_MS` (default 60000) so a stuck cleanup cannot
flood the event log. If the recorded tab is already gone there is nothing to
reap, so the runtime is marked `cleaned` instead of retrying forever; an
unreadable label on a tab that still exists is refused. `waiting_input` workers
are never wake candidates for `relay next`.

Restart attempts are throttled by `RELAY_RESTART_COOLDOWN_MS` (default
30000), applied after **failures** too, so a spawn that cannot come up is
retried on a slow cadence and `worker.restart_failed` cannot flood the log. If
the target agent name already exists, `start()` reaps it only when its tab
label proves relay ownership of the same `<worker>:g<generation>` (a leftover
from an earlier attempt or run) and otherwise refuses — it never closes an
agent it cannot prove it owns.


## Plugin → daemon: Unix socket, not subprocess

```text
OpenCode event -> .relay/relay.sock (JSON Lines) -> daemon -> SQLite/Herdr
```

```json
{"type": "session.idle", "session_id": "ses_xxx", "generation": 2}
{"ok": true, "outcome": "woke-next"}
```

OpenCode 2 does not emit `session.idle` itself: a finished execution
(`session.execution.succeeded`) or an interrupt (`.interrupted`) is the
turn-complete signal, and the plugin normalizes it onto `session.idle`.

The plugin never spawns processes and never throws into OpenCode; a dead
daemon just means silent best-effort drops. High-frequency
`tool.execute.after` is liveness only (explicit `relay note` is the
strongest progress signal).

**Per-session routing is fail-closed.** A shared server hosts sessions from many
projects, so when a session's project directory is known the plugin resolves the
socket by walking up for `<dir>/.relay/relay.sock` (then `<dir>/.relay/`)
and otherwise **drops** the event — it never falls back to another project's
`$RELAY_SOCK`. `$RELAY_SOCK` is only used when the directory is unknown
**and** `RELAY_DEDICATED=1` (dedicated single-project deployments). Directory
lookups cache successes only, so a transient failure is retried on the next
event.

**Auto-attach is request/response.** The plugin only records the generation and
stops re-trying once the daemon answers `{ok:true, managed:true, generation:G}`.
An `ok:false`, a rejection, a timeout or a missing daemon leaves the local caches
untouched and the attach is retried on the next prompt/status/idle (at most once
per ~1.5s). A failed attach can therefore never poison later events with a stale
generation.

Install the plugin where the sessions run. One OpenCode server can host many
projects and it loads `.opencode/plugins/` per project **location**; the event
forwarder and bootstrap auto-attach are server-global once any location has
loaded the plugin, but the `agent_attach` / `agent_detach` tools are registered
per location. To get the tools in every project (and guarantee the forwarder is
present), symlink it once:

```bash
ln -s "$(pwd)/.opencode/plugins/relay.ts" ~/.config/opencode/plugins/relay.ts
```

## Minimal demo: 2 workers + planner + reviewer

Terminal 1 — supervisor: `relay daemon`

Terminal 2 — cast + queue:

```bash
relay worker register worker-1 --role worker --cwd $PWD
relay worker register worker-2 --role worker --cwd $PWD
relay worker register planner --role planner
relay worker register reviewer --role reviewer
# role-tagged work only goes to a worker with the SAME role (strict default):
relay worker register rust-1 --role dataplane-rust --cwd $PWD

relay task add "Add password reset endpoint" --priority 10 \
  --acceptance "POST /reset requested, token emailed, tests green"
relay task add "Write reset-email template" --priority 5
relay task add "Port the parser to Rust" --role dataplane-rust
```

(Registering a worker that will serve role R with `--role worker` is the
classic migration mistake: role-tagged tasks then show up as **Unclaimable** in
`relay status` until a matching worker exists.)

Workers (two OpenCode panes; run `agent_attach`, load `agent-worker` skill):

```bash
export RELAY_WORKER=worker-1
relay next                                    # atomic claim (role-gated), prints lease
relay note T1 "endpoint scaffolded"
relay submit T1 --evidence "bun test reset (8 pass)"
relay next                                    # immediately, never wait

# claimed the wrong task? hand it back without a fake block/reject note:
relay release T1
relay next
```

Reviewer: `relay next` (review first, then queued — peer, no hierarchy),
`relay approve T1` (`review → done`) or `relay reject T1 "reason"`
(`review → queued` + note). Planner tops up when the queue runs low (daemon
wakes it). Human blocker: `relay block T2 --human "..."` then `relay
next` — the system keeps moving.

Close work that will never be `done` — superseded, duplicate, obsolete, or
policy-changed — with the explicit terminal state `cancelled` (distinct from
`done` and from the reversible `blocked_*` parks). The reason is recorded as a
`cancel` note plus a `task.cancelled` event, ownership is released, and a
cancelled task leaves `relay next`/claim/wake and the Unclaimable/Attention
surfaces. `done`/`failed` are refused; re-cancelling is an idempotent no-op.

```bash
relay task cancel T246 --reason "superseded by T293"
```

Messages (durable-first: INSERT → commit → wake; wake failure keeps the row):

```bash
relay send worker-2 "T1 is ready for review" --task T1
RELAY_WORKER=worker-2 relay inbox --claim   # bulk (compat)
RELAY_WORKER=worker-2 relay inbox --ack 7   # per-ID ack
```

The **message is the second argument**, after the recipient; options come last.
`relay send` refuses an empty body and a body that starts with `-`, because
`relay send <worker> --worker <id> "..."` puts the flag in the body position and
would otherwise persist a durable message whose payload is the literal string
`--worker` while the real text is dropped (and the recipient gets woken for an
empty message). Both cases exit non-zero and write no row.

The wake target is resolved against live Herdr state — the worker's recorded
runtime, its id, or the sanitized agent name (`u2-corpus` → `u2_corpus`) — so a
worker registered before its pane was recorded is still woken instead of
failing with `agent_not_found` (the message stays queued either way).

**Workers are peers.** Messages are addressed to ordinary worker ids, always
durable. `relay status` reports unread counts per recipient. There is **no
built-in human/operator mailbox** and no agent hierarchy: relay has no special
"human" recipient, no operator alias, and no role-based coordinator routing.

**Mail never interrupts active work, but it is never silently dropped either
(T329/T339).** `relay send <worker> "..."` is durable. Every kind is delivered at
the recipient's next **idle/turn boundary**; while the worker is mid-turn the
nudge **defers** (logged as `worker.mail_nudge_deferred`), so it cannot break a
turn. Only *actionable* kinds may pre-empt that idle wait via starvation:
`child_done` / `children_done` / `child_blocked` / `children_blocked`
(relay-generated completion notices) and `relay send --urgent`
(`kind=urgent`). Ordinary peer mail is delivered at idle like everything else —
the `relay inbox --claim` pull path (in the `agent-worker` lifecycle) is the
belt-and-braces for a worker that ends a turn without reading.

Deferral lifts in three cases:

- the worker goes **idle** (or its bounded **quiet lease** — the explicit
  "resume me" signal — is active, so `child_done` still wakes a quiet parent);
- the **starvation cap** passes for that message class
  (`RELAY_MAIL_STARVATION_MS`, default `4 ×` the nudge window, for actionable
  mail; `RELAY_MAIL_ORDINARY_STARVATION_MS`, default `2 ×` that, for ordinary
  mail, which may legitimately wait a whole turn).

Each class has its own clock: a stale ordinary message can never make an urgent
message nudge a busy worker early (and vice-versa). `relay send --urgent` is the
only way to force a genuine mid-work wake.

Cooldown: at most one nudge per `RELAY_MAIL_NUDGE_MS` (default 3 min) per
recipient, and reading the inbox marks messages delivered, stopping the nudge.
`relay status` shows `(nudge now)` when an actionable message is ready to fire.

**Standing reminders (the daemon owns the schedule).** Because the relay daemon
already runs continuously, it — not `launchd`/`cron` — owns recurring sends.
Register a reminder once and the daemon enqueues the durable message on its
reconcile cadence:

```bash
relay remind add needsfix-coord --every 30m "定期nudge: check Linear for runnable tasks"
relay remind list            # add --json for machine-readable, --all to include disabled
relay remind rm 3            # DISABLES (keeps the row as history)
```

A reminder fires when `--every` (`30s` / `30m` / `1h`) has elapsed since its last
send **and** the recipient has no unread (queued or delivered, i.e. un-acked)
mail. The anti-spam guard skips — and does not advance the reminder rather than
stacking behind — unread mail, so a nudge can never pile up behind one the worker
has not read. The first send lands one full interval after `add`.

**Task hierarchy (optional).** A task may have `parent_task_id`. This expresses
**work decomposition**, not authority between workers: the same worker may own a
parent and its child, and a parent's assignee may change at any time. Relay
routes work-completion through **task ownership**, not through a hierarchy of
agents. `--parent` used to be creation-only, so a subtree created without it was
orphaned (no bubbling, wrong tree); reparent it in place:

```bash
relay task reparent T312 T301        # re-attach an orphaned subtree
relay task move T312 T301            # alias
relay task reparent T312 --clear     # detach (always allowed)
```

The new parent must exist and must not be a descendant of the task — a
reparent that would make the task its own ancestor is refused (`parent cycle`),
as is `self` and an unknown parent. Reattaching a subtree root re-attaches the
whole subtree (each node keeps its own `parent_task_id`). `task.reparented` /
`task.unparented` are recorded in the event log, and `relay task list` shows each
task's `parent=`.

**Completion bubbling.** When a task reaches `done`, its IMMEDIATE parent gets a
durable `child_done` task note (visible in `relay task show <parent> --json`),
plus `children_done` when ALL direct children are done. If the parent currently
has an assignee, that worker also receives a durable message
(`kind=child_done`/`children_done`, woken immediately); if it has no assignee,
only the note is written, and whoever claims the parent later sees it (claim
prints these notes; `--json` returns them all). The child's approval, the parent
notes and the message commit in ONE transaction, so a crash never leaves "child
done but parent never told". Bubbling is **one hop only** — a parent rolls up
further only when the PARENT itself is approved — and there is **no automatic
parent completion**: `children_done` is a signal, the parent agent decides what
to do and submits its own work.

**Blocked roll-up and the human interface (T337).** Blocking a child records a
durable `child_blocked` note on its IMMEDIATE parent (`children_blocked` when ALL
direct children are blocked) and messages the parent's assignee when it has one —
one hop only, same as completion. A `blocked_human` task additionally reaches a
**human**, so a decision can never sit unseen:

- the recipient is `RELAY_HUMAN` if set, else the nearest **assigned ancestor**
  (walking up `parent_task_id` — the coordinator / program-root is just the
  topmost assigned ancestor);
- the message is `kind=blocked_human` (an immediate kind) and carries the task id
  **and** the decision-needed reason, so the human can act without digging;
- if **no** ancestor is assigned, relay records a prominent
  `blocked_human_unrouted` note on the task and a `task.blocked_human_unrouted`
  event instead of parking it silently.

`blocked_internal` keeps the parent roll-up only and never pings the human.
Because even immediate kinds defer while a worker is mid-turn, this surfaces at
the recipient's next idle/turn boundary (or immediately for an idle human).

**Cancelled roll-up (ISH-808).** Cancelling a child records a durable
`child_cancelled` note on its IMMEDIATE parent and messages the parent's assignee
when it has one — one hop only, so a parent waiting on that subtree learns it was
CLOSED rather than completed. It is deliberately NOT folded into the `done`
aggregation: a cancelled child never makes `children_done` fire, and the parent
is never auto-completed.

**Runtime idle is not task idle (bounded quiet lease).** A worker may hold a
RUNNING task and still end its turn (session idle). Normally that is an anomaly;
to make a *deliberate* short wait explicit and bounded, declare a quiet lease:

```bash
relay wait T12 --for 2m "benchmark running in background"
```

The worker stays `working` and the task stays `running`; `quiet_until` only
permits the runtime to be idle until the deadline (it is temporary metadata, not
a state). While active it suppresses idle/stall nudges; on expiry relay clears it
and wakes the owner. It is cleared by any resumed-work action
(note/submit/block/release/claim/restart), never leaks onto another task, and
does **not** suppress crash recovery (a dead process is recovered immediately) or
useful wakes (peer messages, `child_done`/`children_done`). Foreground work that
Herdr reports as `working` needs no quiet lease.

`relay task show <id>` keeps stdout a single parseable JSON document (notes go
to stderr); `relay task show <id> --json` emits ONE document with the task and
its notes.

Observe: `relay status`, `relay events --follow`.

## Worker protocol (also in the Skill)

`next → claim → work → note → work → submit|block → next …`
`submit` moves `running → review`; only `approve` moves `review → done`.
`relay next` only offers tasks your registered role may claim (strict); use
`relay release <id>` to hand a running task back cleanly. Claims carry fencing
leases; `note` heartbeats + renews; a stale worker's late `submit` is rejected
with `STALE_LEASE`. Pane/Herdr `idle` is never completion.

Identity follows `--worker` → `$RELAY_WORKER` → the caller's Herdr pane → the
shared `.relay/worker-id`. In a multi-agent checkout that file is merely the
LAST registration, so a caller whose pane names a live worker always uses that
worker, and borrowing a file default that lives in another live pane is
**refused** (it would misattribute notes and break `submit`'s assignee fence).

## Recovery (all deterministic, no LLM)

- **Dead worker** (transport reports gone): task requeued with bumped token,
  then the supervisor marks the old generation **stale**, best-effort
  interrupts it, and `start()`s a **fresh generation** — new tab in the explicit
  workspace (`herdr tab create --workspace <ws> --no-focus --label
  relay:<worker>:g<N>`), `herdr agent start --kind opencode`, managed
  auto-attach, activation. Old tabs are never closed in the restart path.
- **Old generation cleanup**: a separate pass reaps `relay_owned` stale/dead
  runtimes past their grace period, only when provably relay-owned (label check)
  and never the current generation/runtime (`relay runtime list` to inspect).
  Adopted (`relay_owned=false`) tabs are never closed.
- **Stalled** (running + alive + stale progress, after a nudge): interrupt,
  requeue the task, and **never spawn a replacement while the agent is alive** —
  a fresh generation is only started once the transport reports the agent GONE.
  Spawning a second agent on the same task is what produced duplicate, competing
  agents editing the same files. A live-but-stalled worker is released to `idle`
  (`worker.stall_released`) so the task can be re-claimed.
- **High-context wedged session (T549)**: some sessions stop acting on a
  delivered wake before the context-rotation threshold is reached (measured live
  at ~311K–314K tokens). The supervisor still sends `worker.woken`, receives
  `session.idle`, and — because the agent is **alive** — takes the
  stall-release branch, so the worker can silently loop idle forever while
  role-matched work sits queued. Relay now counts the consecutive wake-without-
  claim cycles inside `RELAY_UNRESPONSIVE_WINDOW_MS` (default 5 min); after
  `RELAY_UNRESPONSIVE_WAKES` (default 3) it logs **`worker.wake_unresponsive`**
  (once per window) and surfaces the worker in `relay status` / dashboard
  **ATTENTION** with its token figure — never a silent idle. **Operator
  recovery** (the case that worked live): `relay session detach --session
  <ses_…>`, close/retire the stuck pane, then spawn a fresh worker into the same
  worktree — the new session starts near-empty (~20K) and claims immediately.
  Prefer this when the worker's runtime is **adopted** (`relay_owned=0`, e.g. a
  manually attached lane): automatic context rotation is refused for adopted
  lanes, so relay cannot retire the wedged generation itself.
- **Only relay-owned generations are replaceable**: a worker whose CURRENT
  runtime is adopted (`relay_owned=0`) is never auto-replaced, because relay
  cannot close that tab — replacing it would leave the old agent running
  (`worker.restart_refused`). Restarts are additionally capped per worker per
  window (`RELAY_RESTART_CAP`, default 3; `RELAY_RESTART_CAP_WINDOW_MS`, default
  30 min) so a repeatedly-failing generation cannot spawn without bound.
- **Crash between heartbeats**: a **liveness-aware** lease expiry returns the
  task to queued — but only when the assignee is **missing or dead/stalled**
  (or has gone silent past `RELAY_LEASE_LIVENESS_GRACE_MS`, default 300000). A
  live-but-slow worker keeps its lease even after `RELAY_LEASE_MS` (the
  reconciler's transport `isAlive` check still requeues a genuinely crashed
  process). A `relay release` is the manual equivalent.
- **Hung foreground tool** (early detection + bounded recovery): a running
  command is invisible to the stall clock — `tool.execute.after` fires only when
  it FINISHES and Herdr reports `working` for the whole call, so the stall path
  is skipped. The plugin's `tool.started` marker closes that gap: relay surfaces
  the command in `relay status` / dashboard **ATTENTION** once it passes
  `RELAY_TOOL_WARN_MS` (`worker.tool_long`, once per tool). Past
  `RELAY_TOOL_BACKGROUND_MS` (or, when the command declared its own `timeout`,
  once it is overdue by `RELAY_TOOL_STALE_GRACE_MS`) relay sends **Ctrl-B**
  (`session.background`, `RELAY_BACKGROUND_KEY`) via Herdr so the blocking call
  moves to the background and the session unblocks, then nudges the worker to
  **check the result** (`worker.tool_backgrounded`). The action is once per tool,
  is skipped while the worker is `waiting_input` (a permission prompt is not a
  running tool), and `RELAY_TOOL_BACKGROUND_MS=0` disables it. A lost finish
  event cannot pin a marker forever: it is cleared as stale past its budget
  (`worker.tool_stale`), and any explicit relay command clears it too.
- **A long declared budget is not evidence of progress (T345).** A command that
  asked for a 40-minute `timeout` but is wedged (no output, no finish) is
  surfaced as `worker.tool_overdue` in ATTENTION once it passes
  `RELAY_TOOL_NO_OUTPUT_MS` (default 10 min) — it does **not** wait out the whole
  budget to become visible. It is also backgrounded at the absolute
  `RELAY_TOOL_HARD_CAP_MS` (default 15 min) regardless of the declared budget, so
  a hung call cannot hold a worker (and the task behind it) for its full budget.
  Both are `0`-disableable. After Ctrl-B the tool marker is **cleared** and a
  worker left with no task returns to `idle`, so state and the marker agree (the
  background shell is intentionally untracked — poll its output yourself).
- **Review-pending wake is change-limited (T345).** An idle reviewer is woken
  when review work CHANGES (`review-pending`), not re-woken every wake cooldown
  for the same unchanged review queue.
- **All work done**: the system goes quiet. The planner is not woken to invent
  new work unless unfinished work still exists and the queue is below low-water.

## States (MVP core)

```text
Task:    queued running review done blocked_human blocked_internal cancelled (+ failed)
Worker:  idle working waiting_input stalled dead (+ starting transient)
Session: managed | unmanaged
Runtime: starting active stale dead cleaned, each relay_owned = true | false
Message: queued delivered acked (+ failed)
```

## Tests

```bash
bun test            # integration / contract / lifecycle / herdr / release / dashboard
bun run typecheck   # tsc --noEmit
```

Contract: idle+queued forces a wake · unmanaged sessions cause zero
DB/runtime effects · attach/detach gating · idle reaches the real runtime ·
dead workers truly restart · `runtime_id` routes every call · stale
generations ignored · human blocks don't stop other work.

Lifecycle: restart creates a fresh generation · old runtime is not destroyed
synchronously · cleanup happens only after the grace period · the current
generation is never cleaned · cleanup failure retries without breaking work ·
relay-spawned sessions auto-attach · plain sessions stay unmanaged ·
`waiting_input` is not wakeable · all-done stays quiet.

Release / roles / leases: `relay release` returns running→queued with a bumped
fencing token and clears the owner · a different worker can then claim it ·
release on a non-running task throws · strict role gating (a `role=worker`
cannot steal `role=dataplane-rust`; `role IS NULL` stays open) · `--any-role` /
`RELAY_ROLE_STRICT=false` restore any-worker claiming · unclaimable tasks are
exposed in the supervisor view and never trigger a pointless wake · a live
worker keeps its lapsed lease while a dead/missing one is requeued.

Herdr-only: manual attach registers the existing runtime `relay_owned=false` ·
non-Herdr / ambiguous attach is rejected with no half-state · an adopted runtime
is never cleaned · a dead manual runtime is replaced by a fresh relay-owned
generation · the current generation is never cleaned · missing Herdr fails
daemon startup (no mock fallback) · relay-generation attach requires a matching
relay-owned runtime row + token · old session/generation events are fenced out.

Dashboard (read-only): the task forest follows `parent_task_id` with active
children before done · a fully-done subtree is one collapsed `allDone` node · a
worker joins its **current** runtime by generation (old generations are history,
never the row) · execution telemetry is a separate column from Relay state ·
`working + runtime idle + no quiet lease` renders `!idle` and an ATTENTION row ·
an active quiet lease renders `quiet` and suppresses it · retired workers are
hidden · no runtime pane → `unavailable` + ATTENTION · unread ATTENTION carries
the `relay wait`-policy next-nudge countdown · narrow widths never overflow (CJK
counts 2) · `--json` preserves the worker/runtime split · `relay dashboard
--json` / `--doctor` run end to end · `--watch` re-reads the terminal width/height
on resize instead of caching the startup value · `windowLines` windows a frame to
the pane (never more rows than fit, top line kept, offset clamped), and the
inline path emits no trailing newline (the off-by-one that scrolled the pane).
The alt-screen + pause/scroll behaviour is verified in a real tmux emulator
(history stays flat; the top line survives; paused scroll reads the clipped tail).

## Layout

```text
src/cli.ts  daemon.ts  db.ts  schema.ts  scheduler.ts  reconciler.ts
    sessions.ts  socket.ts  messages.ts  tasks.ts  workers.ts  events.ts
    runtimes.ts  mail-policy.ts  harness.ts  dsh-runner.ts
    run-lifecycle.ts  sandbox.ts  sandbox-lifecycle.ts
docs/dsh-headless-runner.md  docs/run-lifecycle.md  docs/sandbox-lifecycle.md
docs/factory-e2e.md  docs/pr-binding.md
    runtime/{runtime,herdr}.ts
    dashboard/{command,model,render,affinity,herdr,doctor}.ts
.opencode/plugins/relay.ts  integrations/herdr/{herdr-plugin.toml,focus-pane.ts}
skills/agent-worker/SKILL.md  skills/parallel-worktrees/SKILL.md
tests/{integration,contract,lifecycle,herdr,release,dashboard,dashboard-affinity}.test.ts
tests/{dsh-runner,dsh-smoke,run-lifecycle}.test.ts
```
