# Task Worktree + disposable dsh Run lifecycle (ISH-760)

Relay centrally manages a minimal lifecycle: the **Task / Worktree / branch
persists**, while a **headless dsh Run is disposable** (ISH-803). A coding worker
needs **no Herdr pane, tab, or session attach** — Relay owns the workspace and
launches one process per attempt.

This is implemented in `src/run-lifecycle.ts` on top of the ISH-758 phase machine
(`src/workflow.ts`) and the ISH-803 one-shot runner (`src/dsh-runner.ts`). It does
**not** reimplement either one.

> **ISH-828:** the worktree is being superseded by a **Task-scoped Coding Sandbox**
> (Docker Sandboxes clone mode): one Task = one private in-VM clone, one Run = one
> fresh `dsh` inside it. That path is `src/sandbox.ts` +
> `src/sandbox-lifecycle.ts`; see [`sandbox-lifecycle.md`](sandbox-lifecycle.md).
> The worktree lifecycle below remains for tasks that have not moved to a sandbox.

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

Sandbox Runs reuse `sweepOrphanedSandboxRuns({ apply: true })` and inherit its
fail-closed proof: the Run is terminal only when the in-VM dsh is confirmed
**gone** (see [`sandbox-lifecycle.md`](sandbox-lifecycle.md)).

A sweep failure is never a success. It reads the tail of the Run's
`stderr.log`/`dsh.jsonl`, classifies the cause (`ENOSPC`, `OOM`, `signal`,
`unknown`), stores `cause=<CLASS>: <evidence>` in `runs.error`, emits `run.died`,
shows the cause on the dashboard (`RUNS` and `ATTENTION`), and sends immediate
`run_died` mail to the responsible owner. `relay run show <id>` projects the
class as `failure_class`. Per-run errors are isolated so a failed write cannot
crash the daemon or prevent the remaining Runs from being swept. The sweep does
**not** add a pre-launch disk guard (ISH-1009) or stall detection for a live but
silent dsh.

## FIX = same worktree + previous findings + a new Run

A review `--fail`/FIX (or a failed mechanical verify) sends the Task back to
`implement` at `attempt+1` (ISH-758), clearing the head. The next `launchTaskRun`:

- reuses the **same** worktree/branch (the Task still owns them);
- computes the **previous findings** from the structured results of the preceding
  attempt (`ReviewResult`/`VerificationResult` with `passed=0`) and pins them into
  the brief;
- starts a **new** disposable dsh Run — there is no session continuation and the
  previous Run is already terminal.

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
  (`base_head_sha` is the staleness fence);
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

## One-command fixture smoke

```sh
bun run smoke:run-lifecycle
```

Builds a throwaway git repo + control plane and drives the whole lifecycle with a
**fake** `dsh` binary (no network, no real dsh, no Herdr): worktree create/select
→ launch (pin brief) → duplicate writer refused → submit → verify PASS → review
FIX → a new Run on the same worktree that inherits the findings → submit → review
PASS → observed merge → safe cleanup with retained evidence. `tests/run-lifecycle.test.ts`
covers the same ground with a fake process and asserts every rejection case.

## Verified / not verified

- **Verified** (`bun test`, `bun run smoke:run-lifecycle`): worktree create/select/
  own; brief pinning; single-writer rejection (same worktree/branch) vs parallel
  different worktrees — including a real **cross-process** race (two concurrent
  launch processes admit exactly one writer) and that a **refused** launch leaves
  the live Run's pinned brief unchanged; FIX reuse + findings inheritance;
  submitter binding
  (moved head, superseded/late Run); safe cleanup (merge, abort, open PR, dirty,
  human workspace) with evidence retention; the CLI paths `run worktree|launch|
  cleanup`.
- **NOT verified here**: launching the **real** `dsh` binary (see
  [`dsh-headless-runner.md`](dsh-headless-runner.md), the opt-in
  `RELAY_DSH_SMOKE=1` smoke); deleting the old Herdr coding-runner path
  (ISH-805); and any provider write (Relay creates no push/merge authority).
