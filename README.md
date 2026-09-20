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

## Core invariant

```text
if runnable_tasks > 0 and working_workers == 0:
    wake_or_start_some_worker()
```

`working` means strictly `state == working AND current_task != null`.
**Idle is not productive.** Reviewers/planners are counted separately.

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
  also claims queued `role=reviewer` tasks.
- `relay task add --role R` warns (stderr, non-fatal) when `R` matches no
  registered worker and is not a built-in special role
  (`worker`/`planner`/`reviewer`) — a typo cannot silently create an
  unclaimable task.
- `relay status` lists **Unclaimable** runnable tasks (non-null role, no
  registered worker role); the supervisor view carries the same count and the
  daemon logs `supervisor.unclaimable_work` instead of looping on a wake that
  cannot help.

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

## Install

```bash
bun install
bun link   # global `relay`; or export RELAY_BIN="bun $PWD/src/cli.ts"
```

No build step: the `bin` is `src/cli.ts`, which Bun executes directly — so
`bun run build` is optional (bundling only). Install straight from git with:

```bash
bun install -g github:81ueman/relay
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
scripts/install.sh   # bun install + build + `bun link` + OpenCode plugin symlink
relay init           # creates .relay/state.db (WAL)
relay daemon         # reconcile loop + Unix socket .relay/relay.sock
```

The OpenCode plugin (`.opencode/plugins/relay.ts`) and Skill
(`skills/agent-worker/SKILL.md`, symlinked from `.opencode/skills/agent-worker`)
are auto-discovered under this repo:

```bash
opencode plugin list   # relay ... .opencode/plugins/relay.ts
```

The `agent-worker` skill is also published through APM (Agent Package Manager):

```bash
apm install -g --target agent-skills 81ueman/relay
```

APM deploys skills only. Install the `relay` CLI itself and symlink the
plugin with `scripts/install.sh` (runs `bun install`, `bun run build`,
`bun link`, and links `.opencode/plugins/relay.ts` into
`~/.config/opencode/plugins/relay.ts`).

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
RELAY_DEDICATED=1            # opt-in: allow $RELAY_SOCK when no session dir is known
```

Spawning **requires** an explicit Herdr workspace. `herdr tab create` is
always called with `--workspace <ws>`; if no workspace is configured the spawn
fails closed rather than silently using the currently focused workspace (which
is how agents once landed in an unrelated workspace).

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

Messages (durable-first: INSERT → commit → wake; wake failure keeps the row):

```bash
relay send worker-2 "T1 is ready for review" --task T1
RELAY_WORKER=worker-2 relay inbox --claim   # bulk (compat)
RELAY_WORKER=worker-2 relay inbox --ack 7   # per-ID ack
```

The wake target is resolved against live Herdr state — the worker's recorded
runtime, its id, or the sanitized agent name (`u2-corpus` → `u2_corpus`) — so a
worker registered before its pane was recorded is still woken instead of
failing with `agent_not_found` (the message stays queued either way).

`human` is the operator's mailbox, not a Herdr agent. Mail addressed to `human`
is routed to the configured operator — `RELAY_OPERATOR=<worker-id>` or a
one-line `.relay/operator` file — which may read and ack it via `relay inbox`
(the durable `recipient` is never rewritten). Separately, the daemon nudges any
recipient with **undelivered** mail once per `RELAY_MAIL_NUDGE_MS` (default 3
min), so a missed send-time wake cannot leave a backlog invisible; reading the
inbox marks messages delivered and stops the nudge. `relay status` reports
unread counts per recipient.

**Completion notices.** The operator is also told when work finishes, so it does
not have to poll: `RELAY_NOTIFY_ON=off|task|drain|both` (env, or a one-line
`.relay/notify` file; default `off`). `task` sends a durable message at each
approval (`T67 done (approved by reviewer)`); `drain` sends ONE message when the
whole grid drains (no queued/running/review/blocked), debounced durably so it
never repeats while empty and re-arms when new work appears. Relay-generated
notices skip the mail-nudge delay and are woken on the next tick.

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
- **All work done**: the system goes quiet. The planner is not woken to invent
  new work unless unfinished work still exists and the queue is below low-water.

## States (MVP core)

```text
Task:    queued running review done blocked_human blocked_internal (+ failed)
Worker:  idle working waiting_input stalled dead (+ starting transient)
Session: managed | unmanaged
Runtime: starting active stale dead cleaned, each relay_owned = true | false
Message: queued delivered acked (+ failed)
```

## Tests

```bash
bun test            # 133 tests across integration / contract / lifecycle / herdr / release
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

## Layout

```text
src/cli.ts  daemon.ts  db.ts  schema.ts  scheduler.ts  reconciler.ts
    sessions.ts  socket.ts  messages.ts  tasks.ts  workers.ts  events.ts
    runtimes.ts  runtime/{runtime,herdr}.ts
.opencode/plugins/relay.ts  skills/agent-worker/SKILL.md
tests/{integration,contract,lifecycle,herdr,release}.test.ts
```
