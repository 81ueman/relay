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
branch**. A Run's own durable end/cancel row is the confirmation that releases the
writer. Runs in **different** worktrees/branches are allowed to run in parallel,
even when they touch the same files; only when a real conflict appears does the
Gateway decide the fix and Relay re-verifies/re-reviews at the changed HEAD.

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
- it has **no uncommitted changes** (`--force` overrides only the last two).

The `runs` rows and their output directories are **never** deleted by cleanup —
they are the evidence. The Task row and its structured results survive too.

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
  different worktrees; FIX reuse + findings inheritance; submitter binding
  (moved head, superseded/late Run); safe cleanup (merge, abort, open PR, dirty,
  human workspace) with evidence retention; the CLI paths `run worktree|launch|
  cleanup`.
- **NOT verified here**: launching the **real** `dsh` binary (see
  [`dsh-headless-runner.md`](dsh-headless-runner.md), the opt-in
  `RELAY_DSH_SMOKE=1` smoke); deleting the old Herdr coding-runner path
  (ISH-805); and any provider write (Relay creates no push/merge authority).
