# Task Worktree + disposable dsh Run lifecycle (ISH-760)

Relay centrally manages a minimal lifecycle: the **Task / Worktree / branch
persists**, while a **headless dsh Run is disposable** (ISH-803). A coding worker
needs **no Herdr pane, tab, or session attach** — Relay owns the workspace and
launches one process per attempt.

This is implemented in `src/run-lifecycle.ts` on top of the ISH-758 phase machine
(`src/workflow.ts`) and the ISH-803 one-shot runner (`src/dsh-runner.ts`). It does
**not** reimplement either one.

```sh
relay run worktree <task-id> [--branch B] [--base REF] [--path DIR] [--json]
relay run launch   <task-id> [--timeout 30m] [--permission MODE] [--json]
relay run cleanup  <task-id> [--abort REASON] [--apply] [--force] [--json]
relay run submit   <run-id> [--evidence E] [--summary S]     # the only thing that advances a Task
```

## One branch + worktree per Task (create / select / own)

`relay run worktree` (or `launch`, which ensures it first) creates, or **selects
and reuses**, the single worktree a Task owns:

- **Branch** — the Task's recorded `branch`, else a deterministic
  `relay/<issue-or-id>[-<slice>]`. Re-running is idempotent; it never mints a
  second branch.
- **Path** — `<control-plane>/worktrees/<task-id>` (under the same `.relay/`
  directory as the DB; never shared `/tmp`).
- **Base** — `--base`, else `task.pr_base`, else `origin/main` when present, else
  `HEAD`.

### Self-contained workspace (ISH-904)

The workspace is a **local clone** of the source repo
(`git clone --local --no-checkout <source> <path>`), not a linked
`git worktree add` checkout. A linked worktree keeps its git dir at
`<source>/.git/worktrees/<T>` and its common dir at `<source>/.git` — both
OUTSIDE the workspace — and a headless Run's default `workspace-write` sandbox
writes only inside its cwd, so every git mutation (`index.lock`, `ORIG_HEAD`,
refs) was denied and the Run could never commit. A local clone has `.git` *inside*
the path, so:

```sh
git -C <path> rev-parse --path-format=absolute --git-dir        # <path>/.git
git -C <path> rev-parse --path-format=absolute --git-common-dir # <path>/.git
```

`--local` hardlinks/copies objects (cheap, no network). If the source itself has
`objects/info/alternates` (e.g. a `--shared` clone), the clone would inherit that
escape and read objects outside the workspace, so the alternate objects are
hardlinked into the clone and the alternates file is removed — the workspace is
complete on its own.

`origin` is re-pointed at the **source repo's `origin` URL**
(`git -C <source> remote get-url origin`), so the pinned brief's
`git push origin HEAD:refs/heads/<branch>` pushes to the real provider. A source
with no origin has no provider to push to, so the clone's local-path origin is
**removed** (Relay never invents a remote, and nothing can push into the source
checkout by accident).

Everything else is answered from **local** refs — creating a workspace never
runs `ls-remote`. ISH-904 adds a best-effort `git -C <source> fetch origin`
FIRST (no interactive credentials; a failure is a warning, not a create
failure), so a lane is not cut from a `origin/main` that the last manual fetch
left stale:

- **Base** is resolved in the SOURCE (`git -C <source> rev-parse <base>^{commit}`)
  after that fetch, and that commit is fetched from the source path. This matters
  because the clone's own `refs/remotes/origin/*` are copies of the source's
  **local** branches: left to itself, the default `origin/main` would mean the
  source's local `main`, not the real `refs/remotes/origin/main`. A Task's
  recorded `pr_base` (e.g. `main`) also prefers `origin/<base>`; an explicit
  `--base` is honoured exactly. A resolved base that is behind `origin/main` is
  reported as a binding warning (and in the Factory `steps`), never silently cut.
- **Existing branch** (a re-run/FIX of `relay/<n>`): the source's local branch if
  it has one, else its `refs/remotes/origin/<branch>` — a branch that was pushed
  to GitHub but has no local source branch, which a linked `git worktree add` used
  to resolve. It is imported into the clone at the same name (local path fetch).

Consumers that read a produced head from the SOURCE repo (the ISH-829 detached
review worktree) import it first: the source does not share the workspace's
object store, so `importHeadIntoSource` does a local path fetch before
`git worktree add --detach`.

The chosen path + branch are written back to `tasks.worktree` / `tasks.branch`, so
the Task **owns** its workspace. A second call on the same Task returns the
existing binding (`worktree.selected`) instead of creating a new one — this is
what makes a FIX the *same worktree*.

## Pre-launch disk-space guard (ISH-1009)

Before a Run row is inserted, and before `launchTaskRun` creates/pins a
worktree, Relay measures free space on the **worktrees root** and the volume
holding the **Relay DB** (`src/disk-guard.ts`). The threshold is
`RELAY_MIN_FREE_DISK_BYTES` (default 20 GiB; `0` turns off the threshold only —
an unmeasurable volume still refuses). If **either** volume is below it:

- no workspace, Run row, output directory or dsh process is created;
- the Task is left exactly as it was (`queued`), so the next launch attempt
  after space is freed proceeds normally — no manual requeue/unblock;
- a durable `run.launch_refused` event is written with `reason: "low_disk"`,
  `freeBytes`, `minFreeBytes`, the per-path probe results and the launch
  `target`/`scope`;
- `relay status` and the dashboard show the live measurement and the last
  refusal (free space and threshold).

A probe that cannot measure is **not** a pass: the launch is refused with
`reason: "probe_failed"` and the probe error is recorded in the event and
surfaced by both UIs. This is fail-closed by design: an unmeasurable volume is
treated like a full one.

The guard is enforced in `startDshRun` (so raw `relay run start` cannot bypass
it). The Task lifecycle calls the same guard earlier so a low-disk refusal never
creates a worktree.

## The Run brief is pinned BEFORE launch

`launchTaskRun` composes a brief and writes it to
`<worktree>/.relay/run-brief.md` **before** the dsh process starts (the same text
is handed to `dsh --profile headless` and stored as the Run's `spec.md`). The
brief contains:

1. the Task text (ISH-803's `buildTaskPrompt`: title / description / acceptance);
2. the recorded **verification steps** (`--check name=command`);
3. the **prior findings** inherited from the immediately preceding attempt (see
   below).

Pinning into the worktree removes the shared-`/tmp` and late-prompt race: the
worker always sees exactly the durable state Relay had at launch time. `.relay/`
is gitignored, so the brief never appears as a change.

## One disposable Run per phase/attempt; single-writer

`launchTaskRun` launches exactly **one** headless dsh Run (ISH-803's
`startDshRun`) bound at start to Task / phase / attempt / generation / branch /
HEAD, with stdout / stderr / events under `<control-plane>/runs/<run-id>/`.

**Single-writer is enforced in `startDshRun`** (so no entrypoint can bypass it): a
launch is refused with `DUPLICATE_WRITER` while another Run is still
`starting`/`running` on the **same worktree** (resolved path) or the **same
branch**. The existence check and the Run INSERT happen in **one
`BEGIN IMMEDIATE` transaction**, so the guard is atomic **across processes** — two
concurrent `relay run launch`/`start` processes cannot both be admitted (the
second blocks/gets `BUSY`, then observes the first committed row and is refused).
A Run's own durable end/cancel row is the confirmation that releases the writer.
Runs in **different** worktrees/branches are allowed to run in parallel, even when
they touch the same files; only when a real conflict appears does the Gateway
decide the fix and Relay re-verifies/re-reviews at the changed HEAD.

`launchTaskRun` also refuses a duplicate writer **before pinning the brief**, so a
launch that will be rejected never writes into the worktree the live Run owns —
the pinned brief always keeps matching the Run that holds the worktree. The atomic
guard inside `startDshRun` remains authoritative.

## Daemon Run liveness sweep (ISH-1008)

The launching coroutine is normally the **only** writer of a Run's terminal row.
If it dies (daemon crash, reboot, or an `ENOSPC` terminal write), the row would
stay `starting`/`running` forever: `DUPLICATE_WRITER` keeps fencing and nobody is
alerted. `reconcile()` therefore runs a throttled liveness pass
(`src/run-liveness.ts`, `RELAY_RUN_LIVENESS_MS` default **45s**) over every
non-terminal Run. The durable throttle advances only after a **clean** pass, so
a write failure (a full disk) retries on the next reconcile tick instead of
waiting a whole interval.

The **launcher** is checked before the dsh. The child can exit while the
launching coroutine still runs `git rev-parse`/`git fetch` before its terminal
write; the Run row records `launcher_pid`/`launcher_lstart`, and the sweep leaves
the row (and the single-writer fence) alone while that launcher may still write.
The lease is cleared in the launcher's `finally`, even when its terminal write
failed, so the next sweep can retry the row.

Local Runs reuse `identifyRunProcess`:

| identity | outcome |
| --- | --- |
| `dead` | `failed` (`orphaned: owner pid … is not alive`) |
| `reused` | `failed` (`orphaned: … unrelated process (reused)`); **no signal** |
| `match` | untouched — the writer is live |
| `undeterminable` | untouched — the single-writer fence stays held |

A `starting` row that has not recorded a PID yet is left alone for
`RELAY_RUN_START_GRACE_MS` (default `max(60s, 2 x interval)`), so a sweep never
races a concurrent launch. The sweep never kills a local process: it only writes
a terminal row after proving the original one is gone.

A sweep failure is never a success. It reads the tail of the Run's
`stderr.log`/`dsh.jsonl`, classifies the cause (`ENOSPC`, `OOM`, `signal`,
`unknown`), stores `cause=<CLASS>: <evidence>` in `runs.error`, emits `run.died`,
shows the cause on the dashboard (`RUNS` and `ATTENTION`), and sends immediate
`run_died` mail to the responsible owner. `stderr.log` is authoritative across
all classes; `dsh.jsonl` contributes only its parsed terminal `error` events
(never tool-call output or a success `final` summary), and the last matching line
in a source wins. `relay run show <id>` projects the class as `failure_class`.
When the Run is the one a Factory stop is bound to, `run show`/`run logs` also
project the ISH-1013 `factory` report (classification, cause, evidence and next
action) from the durable `factory.outcome` event; the Run row itself is unchanged.
Per-run errors are isolated so a failed write cannot crash the daemon or prevent
the remaining Runs from being swept. The sweep does **not** add a pre-launch disk
guard (ISH-1009) or stall detection for a live but silent dsh.

## FIX = same worktree + previous findings + a new Run

A review `--fail`/FIX (or a failed mechanical verify) sends the Task back to
`implement` at `attempt+1` (ISH-758), clearing the head. The next `launchTaskRun`:

- reuses the **same** worktree/branch (the Task still owns them);
- computes the **previous findings** from the structured results of the
  immediately preceding attempt (`ReviewResult`/`VerificationResult` with
  `passed=0`) and pins them into the brief — never from another Task, an older
  attempt, or an older HEAD;
- carries the actionable evidence itself: for a VERIFY FAIL, the failing check
  name, outcome, exit code, a bounded/redacted stdout+stderr tail, the verified
  HEAD, the Run's base HEAD and the check's reproduction command (from
  `payload_json.checks`, the existing result); for a REVIEW FIX, the reviewed
  HEAD and the reviewer's `severity`/`file:line`/message findings (the existing
  `reason`); for a **failed IMPLEMENT Run** with no submission (ISH-1012), the
  failed Run id, terminal state/exit code, base + produced HEAD, its recorded
  error and a bounded stderr tail, plus the Factory's bounded-retry reason; in
  all cases the brief still contains the original acceptance;
- labels `not_run`/`inconclusive`/blocked results as **BLOCKED evidence**, not a
  code defect, so they never become a "fix this" instruction. A failed
  IMPLEMENT Run is a **RETRY** instruction only because the Factory already
  classified it as repairable and issued the next attempt; an environment
  failure (ENOSPC/resource/permission/auth/launch) is never retried, so
  the fresh brief never presents it as a code fix;
- starts a **new** disposable dsh Run — there is no session continuation and the
  previous Run is already terminal.

The inherited output is truncated (12 lines / 1200 chars per check) and passed
through the same `redactSecrets` filter as other run evidence; raw logs and
credentials are never copied into the brief.

## A terminal Run CLOSES its attempt (Factory path)

Once an IMPLEMENT Run for `(task, phase=implement, attempt=N)` is terminal it is
**closed** for the Factory: `implementOnce` starts a Run only for a NEW attempt,
and re-entering the Factory with a closed attempt does not start a second writer
for it:

- a clean `exit 0` Run that was never submitted (a crash between the process
  exit and the structured submission) is finished through the ordinary
  `acceptRunSubmission` fence — never re-launched;
- a failed/cancelled/timed-out Run is surfaced as its recorded failure so the
  Factory's bounded-recovery policy decides (new attempt, or an explicit stop);
- `blocked_human` is a **HOLD**: an in-flight Run cannot submit and advance a HELD
  Task, so a late `exit 0` never bypasses the human decision.

## A Run is *not* a submission

`dsh exit 0`, a final assistant message, or an LLM "done" advances **nothing**. The
only path that moves a Task is the structured
`acceptRunSubmission` (`relay run submit`), bound to the current
Task/phase/attempt/**generation**/branch/HEAD. It refuses (never advances):

- a Run that is not a clean `exited`/exit-0 process (failed, signalled, cancelled,
  timeout, still running);
- a Run superseded by a **newer** Run for the same `(task, phase, attempt)` (a late
  event);
- a submission naming a different task/phase/attempt/branch/HEAD, or a **live**
  Task whose head/branch/phase/attempt has moved since the Run started
  (`base_head_sha` is the staleness fence; the Run's own produced `head_sha` and
  an intermediate commit on its history — base ancestor of head ancestor of
  produced — are accepted because the provider poll may bind the Run's own
  pushed PR head mid-Run, and a Run may push more than once between polls —
  ISH-1125);
- a duplicate `TaskSubmitted` for the same `(task, phase, attempt)`.

A review is an **independent** principal (`REVIEWER_ROLE`, or the review claim)
and may not be the worker that recorded the submission — the Run submits as
`dsh-run:<run-id>`, never as the reviewer. VERIFY runs on the **changed worktree**
at the recorded HEAD (`git rev-parse HEAD` must equal `task.head_sha`); a pass in
the parent/main checkout is never substituted.

## Safe workspace cleanup (evidence-retaining)

`relay run cleanup` is **dry-run** by default. Removal happens only when every
guard passes:

- the Task is **really merged** (`TaskMerged`) or explicitly **aborted**
  (`--abort <reason>`);
- there is no **open PR** (`pr_url` bound and not merged, without `--abort`);
- no Run still holds the worktree/branch;
- the worktree is **relay-owned** (under the Relay worktrees root, never the main
  checkout or a human workspace);
- it has **no uncommitted changes** (`--force` overrides only the last two);
- its commits are on a remote, or were copied back into the source repo (above).

The `runs` rows and their output directories are **never** deleted by cleanup —
they are the evidence. The Task row and its structured results survive too.

A self-contained clone workspace is removed as a directory (`rm -rf`), so the
SOURCE repo's `.git` is never touched (a linked `git worktree remove` would have
mutated it). A legacy linked worktree recorded before ISH-904 is still reclaimed
through `git worktree remove` in its own source. Cleanup is idempotent: a second
`--apply` sees no recorded workspace and is a no-op.

Deleting the directory also deletes the Task branch. A linked worktree left its
branch (and every commit on it) in the source repo, so before removal cleanup
checks whether the workspace holds commits **no remote has**
(`git rev-list <head/branch> --not --remotes`, after refreshing `origin`; an
unreachable remote just keeps the last known tracking state). Those commits are
copied back into the source repo under `refs/relay-kept/<branch>/*` and
`refs/relay-kept/HEAD` (a local path fetch, event `worktree.commits_kept`), which
is the custody the linked worktree used to provide. If the copy fails, removal is
refused. `--force` skips this and really discards the commits.

## Fixture coverage

`tests/run-lifecycle.test.ts` builds a throwaway git repo + control plane and
drives the whole lifecycle with a **fake** `dsh` binary (no network, no real dsh,
no Herdr): worktree create/select → launch (pin brief) → duplicate writer refused
→ submit → verify PASS → review FIX → a new Run on the same worktree that inherits
the findings → submit → review PASS → observed merge → safe cleanup with retained
evidence, and asserts every rejection case.

## Verified / not verified

- **Verified** (`bun test`): worktree create/select/
  own; brief pinning; single-writer rejection (same worktree/branch) vs parallel
  different worktrees — including a real **cross-process** race (two concurrent
  launch processes admit exactly one writer) and that a **refused** launch leaves
  the live Run's pinned brief unchanged; FIX reuse + findings inheritance;
  submitter binding
  (moved head, superseded/late Run); safe cleanup (merge, abort, open PR, dirty,
  human workspace) with evidence retention; the CLI paths `run worktree|launch|
  cleanup`; and the ISH-1009 pre-launch disk guard (threshold refusal, fail-closed
  probe error, and the same queued Task launching after space is freed) surfaced
  in `relay status` and the dashboard.
- **NOT verified here**: launching the **real** `dsh` binary (see
  [`dsh-headless-runner.md`](dsh-headless-runner.md), the opt-in
  `RELAY_DSH_SMOKE=1` smoke); deleting the old Herdr coding-runner path
  (ISH-805); and any provider write (Relay creates no push/merge authority).
