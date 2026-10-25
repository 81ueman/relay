# Headless dsh Run (ISH-803, upgraded in ISH-810)

Relay can run a **coding attempt as one `dsh --profile headless --json` process**
— no Herdr pane, no TUI, no `dsh web` server, no Cordis wake plugin, and no
manual attach. One Run = one process = one coding attempt.

This is implemented in `src/dsh-runner.ts` (process lifecycle) and
`src/dsh-events.ts` (the JSONL decoder) and driven from the CLI:

```sh
relay run start <task-id> [--cwd DIR] [--prompt TEXT] [--permission MODE] [--timeout 30m] [--json]
relay run list [--task <id>] [--leaks] [--json]
relay run show <run-id> [--json]
relay run logs <run-id> [--tail N]     # stdout + stderr + the dsh event chronology
relay run cancel <run-id>
relay run submit <run-id> [--evidence E] [--summary S]
```

A one-shot headless attempt is launched directly by `src/dsh-runner.ts`; there
is no long-lived `dsh web` bridge.

## Per-Run TMPDIR and the Task build cache (ISH-1221, ISH-1225)

Each Run owns `<control-plane>/runs/<run-id>/scratch/` and receives
`TMPDIR`/`TMP`/`TEMP` = `scratch/tmp` (see `src/scratch.ts`). The Relay values
override an inherited host `TMPDIR`, so a focused check writes into the Run's
root instead of shared `/tmp/<name>`. The Run logs stay in
`<control-plane>/runs/<run-id>/` as retained evidence; cleanup removes only the
`scratch` subtree.

`CARGO_TARGET_DIR` is **not** per-Run. ISH-1225 scopes the Cargo build cache to
the Task: every implement/FIX Run, mechanical VERIFY and the reviewer receive
`CARGO_TARGET_DIR=<task-worktree>/target` (`taskCargoTarget` in
`src/scratch.ts:71`; the Run env is assembled in `src/dsh-runner.ts:653,720-731`,
VERIFY passes the same value in `src/workflow.ts:1174-1181`, and the reviewer in
`src/reviewer-runner.ts:1092`). A second Run of the same Task therefore reuses
the warm cache instead of creating another tree, and the directory is reclaimed
with the Task worktree by `relay run cleanup`. ISH-1226 makes that reclamation
conditional: only an **untracked** `target/` is Relay-owned scratch. In a repo
that tracks files under `target/`, it is repo content — cleanup's dirty guard
sees uncommitted edits there (`git ls-files -- target`,
`src/run-lifecycle.ts:152,1801-1807`) and the apply path does not name it as a
build dir (`src/run-lifecycle.ts:1605-1607`). The whole worktree is still
removed when the Task is reclaimable; the dirty guard is what refuses while
tracked content under `target/` is uncommitted.

The reviewer shares the target only after `runHeadlessReview` has proved there
is no live writer on the Task worktree (`REVIEW_WRITER_ACTIVE`,
`src/reviewer-runner.ts:1027-1039`) and has taken a durable `review_fences` row
in the same `BEGIN IMMEDIATE` transaction (`src/review-fence.ts:116-165`,
`src/schema.ts:840`). `startDshRun` checks that fence inside its own
`BEGIN IMMEDIATE` insert transaction and refuses a writer with
`REVIEW_IN_FLIGHT` (`src/dsh-runner.ts:374-382`), so Relay-started writers and a
review cannot run concurrently. Cargo's build-directory lock is the remaining
safeguard for two builds racing for any other reason (for example, a manual
`cargo` invocation in the worktree).

The process also receives `RELAY_DOCKER_LABEL_PLANE`,
`RELAY_DOCKER_LABEL_TASK` and `RELAY_DOCKER_LABEL_RUN`; any container/volume it
starts must carry all three so `relay run cleanup` can attribute it to this
Task in this control plane.
The devcontainer docker-in-docker `dind-var-lib-docker-*` volume is **named**, so
`docker rm -v` does not remove it. Relay derives its exact id from the Run's
recorded workspace and the workspace's `.devcontainer/devcontainer.json` (or
`.devcontainer.json`), records the exact name on the Run row
(`runs.devcontainer_volumes`), and reclaims that recorded volume at cleanup /
lists it in the patrol when orphaned. A stopped devcontainer's own exact
`devcontainer.local_folder` + `devcontainer.config_file` labels are a second
source (ISH-1224): the container is attributed only on a Relay-owned worktree
path, listed as the holder of its dind volume (even when Docker reports
`Links` > 0), and removed before that volume by `relay run cleanup --apply`.
Start the devcontainer with `devcontainer up --workspace-folder <this worktree>`;
overriding the workspace or config path changes the id and makes the volume
untraceable (Relay never scans for `dind-*`).
`relay run list --leaks` reports orphaned scratch roots, Task build dirs,
worktrees, Relay-labelled containers/volumes, attributed stopped devcontainers
and exact derived dind volumes (with the holding container) with Docker's
reported size. The `build` entry is emitted only for a terminal Task with no
live writer; the worktree entry excludes those bytes so they are not counted
twice (`src/run-leaks.ts`).

## Coding binary (ISH-1133)

The coding binary defaults to `$HOME/.dsh/bin/dsh-model` when it is an executable
file (the wrapper applies the time-of-day model band), else `dsh` on PATH.
`--dsh` / `RELAY_DSH_BIN` override. The chosen path and source
(`option` / `env` / `dsh-model` / `path`) are recorded in the Run's
`run.started` and durable `dsh.run.started` events.

## Pinned CLI contract (dsh 0.2.1-rc.2)

Confirmed against the installed tool, not guessed. The pin is a single
constant, `PINNED_DSH_VERSION` in `src/dsh-version.ts`; Relay never floats on
`latest`/`alpha` and carries **one** 0.2.x code path (ISH-869).

- `dsh --version` → **`0.2.1-rc.2`**, checked with the real `dsh --help` and
  `dsh --profile headless --help`. **The CLI/JSONL contract below is identical
  to 0.2.0-rc.2** (diffed against a real returned JSONL stream), so no decoder
  change was required for the version bump.
- The app is `dsh --profile headless --json <task...>`; multiple words are joined
  by spaces, and `--json -` reads the task from stdin. `-h/--help` prints usage
  and exits 0; a missing task is a usage error.
- **stdout** is **newline-delimited JSON execution events**:
  `session` (`sessionId`/`cwd`), `status` (turn/step phases; a `turn_end` phase
  carries the `reason`), `text`, `thinking`, `tool_call`
  (`callId`/`tool`/`input`), `tool_result` (`callId`/`status`/`result`), and a
  terminal `final` — or `error` when a failure happens **outside** a turn.
- **stderr** carries provider *reasoning* (`dsh: reasoning:` lines) and errors
  (`dsh: <code>: <message>`). It is stored verbatim; the runner never parses it
  as a protocol.
- **exit code**: `0` only when the turn completed. The runner treats the exit
  code as authoritative for **process** success (a `final` event is *not*
  required, and is *never* a substitute for `relay run submit`).
- Observed deviation on this machine: the locally installed
  `@gausszhou/dsh-opencode-session-id` plugin (mounted by the profile) prints a
  `[opencode-session-id] mounted: …` banner to **stdout** before the JSONL. The
  decoder therefore tolerates non-JSON lines and records them as
  `stdout.malformed`; it never treats a stray banner as a dsh event.
- The JSONL is a **bounded projection**, not a lossless Session log: individual
  strings are capped (typically ≤8 KiB), a whole event is capped (≤32 KiB, the
  terminal `final` exempt), truncated fields are flagged, and tool results may
  contain sensitive data. Relay stores the **raw** JSONL (see below) rather than
  re-encoding it, so whatever dsh emitted (including its truncation flags) is
  what the evidence shows.
- Environment observed in the profile config: `DSH_HOME` (profiles/sessions
  root), `DSH_PERMISSION_MODE`, `DSH_TOOLS_MODE`, `DEEPSEEK_API_KEY`. The runner
  only sets `DSH_PERMISSION_MODE` (plus `RELAY_RUN_ID` / `RELAY_TASK_ID` for
  attribution). It does **not** pass `--session-id`: a FIX is a fresh Run.
- **Credential precedence (dsh 0.2.1-rc.1 →):** headless reads the API key from
  the **environment / `.env`** and does **not** read a saved credential by
  default (Web/Desktop keep the saved-credential path). On the
  `deepseek-official` route the key comes only from `DEEPSEEK_API_KEY` in the
  launching environment. **Relay forwards only its allowlisted child env
  (`src/child-env.ts`) and does NOT inject a DeepSeek provider key.** No CLI path
  sets one: `relay run start` / `relay run launch` / `relay run factory` and
  `tests/dsh-smoke.test.ts` pass no provider key `env`/`dshEnv` to `startDshRun`,
  and `DEEPSEEK_API_KEY` is deliberately **not** on the allowlist. The operator
  authenticates dsh through their **own provider configuration** (a dsh profile /
  provider route or an injected `.env`).
  `childEnv` forwards `HOME` and `DSH_HOME` unchanged (`src/child-env.ts`), so a
  host Run runs against the operator's own `~/.dsh` and **can read
  `~/.dsh/.credentials.yaml`**: dsh 0.2.1 headless does not *read* a saved
  credential by default, but Relay does **not** isolate it on the host. A
  `deepseek-official` **host CLI** Run on the pin therefore cannot authenticate
  until provider-key forwarding lands under ISH-869 (deferred); per-Run
  `HOME`/`DSH_HOME` isolation is likewise tracked under ISH-869. With no key the
  real `dsh --profile headless --json` emits `status turn_end reason=error`
  (`MISSING_CREDENTIAL`) **and exits non-zero**, so the Run is recorded `failed`
  (never a silent `exited`).

## Process and output

Starting a Run writes, under the control plane (`<dir-of-state.db>/runs/<run-id>/`,
never shared `/tmp`):

| file | contents |
| -- | -- |
| `spec.md` | the task text handed to dsh (title / description / acceptance) |
| `stdout.log` | the raw dsh stdout lines (the JSONL events, plus any boot banner) |
| `stderr.log` | the dsh stderr lines (reasoning/errors) |
| `dsh.jsonl` | **the ORIGINAL dsh `--json` JSONL evidence** — one dsh event per line, verbatim |
| `events.jsonl` | **Relay's own** lifecycle JSONL: `run.started`, one `dsh.event` **annotation** per dsh event (type + callId only — never the dsh payload), `stdout.malformed` for an unparseable line, `stderr` lines, `run.fast_exit`, `run.cancelled`/`run.timeout`, `run.exited` |

The two logs are deliberately **distinct**: Relay never writes its own events
into `dsh.jsonl`, and never writes a dsh payload into `events.jsonl` as if it
were a dsh event.

The durable Run row (`runs` table) records id / task / phase / attempt /
generation / cwd / branch / **base_head_sha (the pre-run HEAD) / head_sha (the
PRODUCED HEAD, re-read from the worktree at Run end)** / pid / exit code / signal
/ **dsh `sessionId` (from the `session` event)** / start+end time / output and
evidence refs (`stdout_path` / `stderr_path` / `events_path` / `dsh_events_path`).
It is keyed to the Task; it is **not** a second workflow state machine — the
Task's `phase`/`attempt` stays the truth.

`relay run start` (the only form; there is no detached mode yet) **waits** for
the Run to reach a terminal state before returning, so the final state/exit is
always written to SQLite before the CLI's DB handle closes.

Cancel and timeout kill the whole **process group** (`Bun.spawn({detached:true})`
+ `kill(-pid)`), so a grandchild holding a pipe open cannot outlive the Run.

## Read-only Run history

`relay run logs <run-id>` renders, from the per-Run `dsh.jsonl` (no dsh Web UI or
TUI required):

- the dsh **Session ID** (also in `relay run show` as `session_id`);
- an ordered, one-line-per-event chronology —
  `session … cwd=…`, `status turn_start …`, `tool_call read c1 input=…`,
  `tool_result c1 status=completed result=…`, `text …`, `final "…"` — with a
  `[truncated]` marker when dsh flagged a bounded field.

The raw JSONL remains the evidence; the CLI view is only a rendering.

If the Run is the one a Factory stop is bound to, `relay run logs` prints the
ISH-1013 Factory classification/next-action header before the raw logs (and
`relay run show`/`--json` exposes the same report), so a rotated or empty log
still explains why the Run stopped.

**Web exposure is intentionally deferred.** `relay web` can bind a non-loopback
address **without a token** (it warns but starts), so publishing unredacted
`tool_call`/`tool_result` payloads there would leak tool traces to
unauthenticated off-host clients. Adding a new global auth framework is out of
scope, so the bounded Run history is exposed **only** through the local CLI
(`relay run logs`). This can be revisited if/when `relay web` gains real access
control.

## Permission boundary

The Run is confined to its worktree: `DSH_PERMISSION_MODE` defaults to
**`workspace-write`** with `workspaceRoot = process.cwd()` (the Task worktree),
so file writes stay inside that directory. A `danger-full-access` grant is never
made and the Run is never handed a review-approval socket/API. An explicit
`--permission`/`RELAY_DSH_*` override is the operator's choice.

## `exit 0` is not a submission

A clean exit 0 (or the terminal `final` event) **does not** complete the Task or
advance the phase. The only path that advances a Task is a structured submission
bound to the current Run/Task/phase/attempt/branch/HEAD:

```sh
relay run submit <run-id> [--evidence E] [--summary S]
```

`acceptRunSubmission` refuses (never advances) when the Run is not a clean
`exited`/exit-0 process (failed, signalled, cancelled, timeout, still running),
when the submission names a different task/phase/attempt than the Run recorded,
or when the **live** Task has moved: its branch is bound to a different branch,
or its head is bound to a revision other than the Run's **start** head
(`base_head_sha`), **the Run's own produced head** (`head_sha`), an
**intermediate commit on the Run's own history** (the base is its ancestor and it
is an ancestor of the produced head, proved with `git merge-base --is-ancestor`
in the Run's worktree), or **an own head the worker amended/rebased and
force-pushed away** (ISH-1128). The Run's own heads are accepted because the
daemon's provider poll may bind the Run's pushed PR head onto the Task mid-Run
(ISH-1087/ISH-1125), a Run may push more than once between polls, and a worker
may amend its own commit before submitting. The amended-away head is not on the
base→produced lineage; the poll records it in `run_observed_heads` only while the
Run is LIVE and only when the Run's own worktree held that commit (HEAD or HEAD
reflog) on the Run's own branch, so a head bound by anyone else — before the base,
off the produced history, ahead of it, or pushed by a different writer — is still
refused. A task with no linked branch/head **yet** (the normal
implement phase — the branch is not linked until a PR exists) **adopts** the
Run's produced branch and HEAD, so a clean Run from a real git worktree with no
linked branch/HEAD is submittable.

A Task already parked by the pre-ISH-1128 stale refusal is recovered at the
parked Run's produced head without another coding Run: `relay unblock`, then
`relay result submit <task> --head <parked-run-produced-head> --evidence
"recovered from parked run <run-id>"`. The exact command sequence (including the
`relay claim` step and the guard conditions) is in
[`run-lifecycle.md`](run-lifecycle.md#recovering-a-task-parked-by-the-stale-head-fence-ish-1128).

A terminal `error` event that contradicts a 0 exit fails **closed** (`failed`): a
parse/truncation problem is surfaced and can never manufacture a success.

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
to `verify` at a new attempt (Relay re-runs the mechanical checks there, then the
new head is reviewed), so it can never reach `merge_ready` with an unreviewed
head (which would dead-end at the accept gate).

## Resuming a Session manually (operator only)

A Factory FIX defaults to a **fresh Run/Session in the same Worktree with the
previous findings** — Relay does **not** auto-resume a persisted dsh Session.
If an operator wants to continue one by hand, they can, after locating the
Session ID:

```sh
relay run show <run-id>          # -> session_id: session-<uuid>
dsh --profile headless --session-id session-<uuid> "continue"
```

This only works when the new invocation has a **compatible cwd / agent preset**
and the Session was **persisted** (the JSONL is a bounded projection; the full
Session lives under `$DSH_HOME`). An unknown id is an error. Relay never passes
`--session-id` itself.

## Verified / not verified

- Verified: the fake-process suite (`tests/dsh-runner.test.ts`) covers normal
  JSONL, non-zero exit, spawn failure, process crash, cancel, timeout, a
  truncated event, a missing `session`, an in-turn failure with a `final`, a
  terminal `error` contradicting exit 0, malformed/banner stdout, and every
  submission-rejection case; the pure decoder has its own suite
  (`tests/dsh-events.test.ts`); and one real local
  `dsh --profile headless --json` smoke
  (`RELAY_DSH_SMOKE=1 bun test tests/dsh-smoke.test.ts`) runs one process and
  asserts the Session ID and an ordered `session` → … → `final` stream with a
  real `tool_call`/`tool_result`.
- **ISH-869:** the pin is `0.2.1-rc.2` and the JSONL contract above is unchanged
  from `0.2.0-rc.2` (diffed on real streams). The host runner
  (`startDshRun`) enforces the pin fail-closed: `dshBin
  --version` must be exactly `0.2.1-rc.2` or the Run is refused with
  `DSH_VERSION_MISMATCH` before any Run row or process. The authenticated
  `deepseek-flash` smoke (`RELAY_DSH_SMOKE=1 …`) is **opt-in**; Relay does not
  forward a provider key to the host Run, so it needs the operator's **own dsh
  provider configuration** (provider-key forwarding to the host Run is deferred
  under ISH-869). With no key the real process exits **non-zero**
  (`MISSING_CREDENTIAL`) and the Run is recorded `failed` — never a silent
  `exited`. The ISH-869 change records what was and was not run.
- NOT verified here: anything beyond **one** Run's launch/observe/terminate. Task
  worktree creation, multi-writer control and FIX re-entry are ISH-760 — see
  [`run-lifecycle.md`](run-lifecycle.md). The real Factory E2E (ISH-762) is not
  run here.
