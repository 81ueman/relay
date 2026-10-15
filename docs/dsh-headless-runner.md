# Headless dsh Run (ISH-803)

Relay can run a **coding attempt as one `dsh --profile headless` process** — no
Herdr pane, no TUI, no `dsh web` server, no Cordis wake plugin, and no manual
attach. One Run = one process = one coding attempt.

This is implemented in `src/dsh-runner.ts` and driven from the CLI:

```sh
relay run start <task-id> [--cwd DIR] [--prompt TEXT] [--permission MODE] [--timeout 30m] [--json]
relay run list [--task <id>] [--json]
relay run show <run-id> [--json]
relay run logs <run-id> [--tail N]
relay run cancel <run-id>
relay run submit <run-id> [--evidence E] [--summary S]
```

The older `integrations/dsh-relay/` bridge is for the **long-lived** `dsh
web`/SDK (`worker.wake.await -> followup()`); a one-shot headless attempt is
launched directly instead — the bridge is not extended and not used here.

## Pinned CLI contract

Confirmed against the installed tool, not guessed:

- `dsh --version` → **`0.1.5-rc.1`** (bundle `@deepseek-ai/dsh-headless`
  `0.1.5-rc.2`), checked with the real `dsh --help` and `dsh --profile headless
  --help`.
- The app is `dsh --profile headless <task...>`; multiple words are joined by
  spaces. `-h/--help` prints usage and exits 0; a missing task is a usage error.
- **stdout**: the final assistant text, then a newline. *Observed deviation on
  this machine:* the locally installed `@gausszhou/dsh-opencode-session-id`
  plugin (mounted by this profile) also prints a `[opencode-session-id] mounted:
  ...` banner to stdout at boot, before the final text. The runner therefore
  records **every** stdout line as a `stdout` event and never parses stdout as a
  protocol.
- **stderr**: streamed provider *reasoning* (prefixed `dsh: reasoning:` on its own
  line) and errors (`dsh: <code>: <message>`).
- **exit code**: `0` only when the turn ended with reason `completed`; any other
  outcome exits `1`.
- **No `--json`/JSONL flag exists in this version** and there is no
  machine-readable event field to parse, so the runner treats stdout/stderr as
  text and writes its **own** lifecycle JSONL (see below). This deliberately
  avoids implementing unverified options/fields.
- Relevant environment variables observed in the profile config: `DSH_HOME`
  (profiles/sessions root), `DSH_PERMISSION_MODE`, `DSH_TOOLS_MODE`,
  `DEEPSEEK_API_KEY`. The runner only sets `DSH_PERMISSION_MODE` (plus
  `RELAY_RUN_ID` / `RELAY_TASK_ID` for attribution).

## Process and output

Starting a Run writes, under the control plane (`<dir-of-state.db>/runs/<run-id>/`,
never shared `/tmp`):

| file | contents |
| -- | -- |
| `spec.md` | the task text handed to dsh (title / description / acceptance) |
| `stdout.log` | the dsh stdout lines (final assistant text) |
| `stderr.log` | the dsh stderr lines (reasoning/errors) |
| `events.jsonl` | Relay's own lifecycle JSONL: `run.started`, one `stdout`/`stderr` per line, `run.fast_exit`, `run.cancelled`/`run.timeout`, `run.exited` |

The durable Run row (`runs` table) records id / task / phase / attempt /
generation / cwd / branch / **base_head_sha (the pre-run HEAD) / head_sha (the
PRODUCED HEAD, re-read from the worktree at Run end)** / pid / exit code / signal
/ dsh session id (when a `session-<uuid>` token appears in the output) /
start+end time / output and evidence refs. It is keyed to the Task; it is **not**
a second workflow state machine — the Task's `phase`/`attempt` stays the truth.

`relay run start` (the only form; there is no detached mode yet) **waits** for
the Run to reach a terminal state before returning, so the final state/exit is
always written to SQLite before the CLI's DB handle closes.

Cancel and timeout kill the whole **process group** (`Bun.spawn({detached:true})`
+ `kill(-pid)`), so a grandchild holding a pipe open cannot outlive the Run.

## Permission boundary

The Run is confined to its worktree: `DSH_PERMISSION_MODE` defaults to
**`workspace-write`** with `workspaceRoot = process.cwd()` (the Task worktree),
so file writes stay inside that directory. The runner never grants
`danger-full-access` and never hands the Run a review-approval socket/API. An
explicit `--permission`/`RELAY_DSH_*` override is the operator's choice.

## `exit 0` is not a submission

A clean exit 0 (or the final stdout text) **does not** complete the Task or
advance the phase. The only path that advances a Task is a structured
submission bound to the current Run/Task/phase/attempt/branch/HEAD:

```sh
relay run submit <run-id> [--evidence E] [--summary S]
```

`acceptRunSubmission` refuses (never advances) when the Run is not a clean
`exited`/exit-0 process (failed, signalled, cancelled, timeout, still running),
when the submission names a different task/phase/attempt than the Run recorded,
or when the **live** Task has moved: its branch is bound to a different branch,
or its head is bound to a revision other than the Run's **start** head
(`base_head_sha`). A task with no linked branch/head **yet** (the normal
implement phase — the branch is not linked until a PR exists) **adopts** the
Run's produced branch and HEAD, so a clean Run from a real git worktree with no
linked branch/HEAD is submittable.

The submission binds to the **produced** HEAD: dsh is asked to commit, so at Run
end Relay re-reads `git rev-parse HEAD` in the worktree and records it as
`head_sha` (`base_head_sha` keeps the pre-run fence). `relay run submit` validates
against that produced head, and on success writes it to `task.head_sha` /
`TaskSubmitted.head_sha` — so mechanical verify and review judge the revision the
Run actually committed, not the pre-run one. A chain of adoptions means a task
with no `--branch/--head` still ends up correctly bound after its first Run.

On success `submitImplementationFromRun` records the ordinary `TaskSubmitted`
structured result and advances `implement`/`integration` via the existing
workflow — the same phase machine every other submission uses. An **integration**
Run whose produced head differs from the reviewed head does **not** advance:
exactly like `submitPhase`, it calls `invalidateReview` and sends the task back
to `review` at a new attempt, so it can never reach `merge_ready` with an
unreviewed head (which would dead-end at the accept gate).

## Verified / not verified

- Verified: the fake-process suite (`tests/dsh-runner.test.ts`) covers normal,
  non-zero exit, spawn failure, process crash, cancel, timeout, malformed stdout,
  two concurrent Runs in different cwds, and every submission-rejection case; and
  one real local `dsh --profile headless` smoke
  (`RELAY_DSH_SMOKE=1 bun test tests/dsh-smoke.test.ts`) runs one process and
  observes exit 0.
- NOT verified here: anything beyond **one** Run's launch/observe/terminate. Task
  worktree creation, multi-writer control and FIX re-entry are ISH-760 — see
  [`run-lifecycle.md`](run-lifecycle.md).
