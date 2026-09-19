# relay — `agentctl`: a lightweight supervisor for Herdr + OpenCode agents

Goal: **as long as unblocked work exists, at least one agent keeps moving.**

`agentctl` is a small deterministic control plane (Bun + TypeScript + SQLite).
It is not an orchestration framework and has no parent-child model: agents are
peers (`communication = many-to-many`, `task ownership = single writer`).

- durable task queue (SQLite is the **only** source of truth, WAL mode)
- worker state, durable inbox, append-only event log, managed-session table
- OpenCode event hooks (triggers only — `session.idle` is never completion)
- Herdr session/pane adapter (transport only, never truth)
- stalled/dead worker recovery with real process regeneration
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

## Install

```bash
bun install
bun link   # global `agentctl`; or export AGENTCTL_BIN="bun $PWD/src/cli.ts"
```

Requires: Bun ≥ 1.1, `herdr` on PATH, OpenCode v2.
Plugin shape verified against the bundled `herdr-agent-state` integration
(default export `{ id, setup }`) and `@opencode-ai/plugin` types (custom tools).

## Setup

```bash
agentctl init     # creates .agentctl/state.db (WAL)
agentctl daemon   # reconcile loop + Unix socket .agentctl/relay.sock
```

The OpenCode plugin (`.opencode/plugins/agentctl.ts`) and Skill
(`.opencode/skills/agent-worker/SKILL.md`) are auto-discovered under this repo:

```bash
opencode plugin list   # relay.agentctl ... .opencode/plugins/agentctl.ts
```

Identity / paths / tuning:

```text
$AGENTCTL_WORKER (or --worker, or .agentctl/worker-id)
$AGENTCTL_DB (default .agentctl/state.db), $AGENTCTL_SOCK (default .agentctl/relay.sock)
AGENTCTL_LEASE_MS=120000 AGENTCTL_STALL_MS=60000 AGENTCTL_LOW_WATER=3
AGENTCTL_WAKE_COOLDOWN_MS=30000 AGENTCTL_AUTO_APPROVE AGENTCTL_INTERVAL_MS=1500
```

## Managed sessions: plain `opencode` stays untouched

The plugin loads everywhere but does nothing by itself. A session that just
runs `opencode` is **unmanaged**: no DB writes, no subprocess, no Herdr calls,
no reaction to idle, no auto prompt, no task claim. The daemon ignores its
events (verified by contract test B).

Attach a live session without restarting it (custom tool or CLI):

```text
agent_attach(role="worker")   # OpenCode tool; context gives sessionID/directory/worktree
agent_detach()
```

```bash
agentctl session attach --session ses_xxx --role worker
agentctl session detach --session ses_xxx
agentctl session list
```

Attach bumps a per-session `generation`; events carrying a stale generation
are ignored (zombie-session protection). Detach returns the session to normal.

## Plugin → daemon: Unix socket, not subprocess

```text
OpenCode event -> .agentctl/relay.sock (JSON Lines) -> daemon -> SQLite/Herdr
```

```json
{"type": "session.idle", "session_id": "ses_xxx", "generation": 2}
{"ok": true, "outcome": "woke-next"}
```

The plugin never spawns processes and never throws into OpenCode; a dead
daemon just means silent best-effort drops. High-frequency
`tool.execute.after` is liveness only (explicit `agentctl note` is the
strongest progress signal).

## Minimal demo: 2 workers + planner + reviewer

Terminal 1 — supervisor: `agentctl daemon`

Terminal 2 — cast + queue:

```bash
agentctl worker register worker-1 --role worker --cwd $PWD
agentctl worker register worker-2 --role worker --cwd $PWD
agentctl worker register planner --role planner
agentctl worker register reviewer --role reviewer

agentctl task add "Add password reset endpoint" --priority 10 \
  --acceptance "POST /reset requested, token emailed, tests green"
agentctl task add "Write reset-email template" --priority 5
```

Workers (two OpenCode panes; run `agent_attach`, load `agent-worker` skill):

```bash
export AGENTCTL_WORKER=worker-1
agentctl next                                    # atomic claim, prints lease
agentctl note T1 "endpoint scaffolded"
agentctl submit T1 --evidence "bun test reset (8 pass)"
agentctl next                                    # immediately, never wait
```

Reviewer: `agentctl next` (review first, then queued — peer, no hierarchy),
`agentctl approve T1` (`review → done`) or `agentctl reject T1 "reason"`
(`review → queued` + note). Planner tops up when the queue runs low (daemon
wakes it). Human blocker: `agentctl block T2 --human "..."` then `agentctl
next` — the system keeps moving.

Messages (durable-first: INSERT → commit → wake; wake failure keeps the row):

```bash
agentctl send worker-2 "T1 is ready for review" --task T1
AGENTCTL_WORKER=worker-2 agentctl inbox --claim   # bulk (compat)
AGENTCTL_WORKER=worker-2 agentctl inbox --ack 7   # per-ID ack
```

Observe: `agentctl status`, `agentctl events --follow`.

## Worker protocol (also in the Skill)

`next → claim → work → note → work → submit|block → next …`
`submit` moves `running → review`; only `approve` moves `review → done`.
Claims carry fencing leases; `note` heartbeats + renews; a stale worker's late
`submit` is rejected with `STALE_LEASE`. Pane/Herdr `idle` is never completion.

## Recovery (all deterministic, no LLM)

- **Dead worker** (transport reports gone): task requeued with bumped token,
  then `restart()` spawns a **fresh generation** — new background tab
  (`herdr tab create --no-focus`), `herdr agent start --kind opencode`,
  bootstrap prompt, reachability check. Old panes are never closed.
- **Stalled** (running + valid lease + alive + stale progress + repeated idle):
  nudge once → still nothing → interrupt, requeue, restart fresh.
- **Crash between heartbeats**: lease expiry returns the task to queued.

## States (MVP core)

```text
Task:    queued running review done blocked_human blocked_internal (+ failed)
Worker:  idle working stalled dead (+ starting/waiting_input/restarting transient)
Session: managed | unmanaged
Message: queued delivered acked (+ failed)
```

## Tests

```bash
bun test            # 29 tests: 19 integration (6 failure tests) + 10 contract (A–H)
bunx tsc --noEmit
```

Contract: idle+queued forces a wake · unmanaged sessions cause zero
DB/runtime effects · attach/detach gating · idle reaches the real runtime ·
dead workers truly restart · `runtime_id` routes every call · stale
generations ignored · human blocks don't stop other work.

## Layout

```text
src/cli.ts  daemon.ts  db.ts  schema.ts  scheduler.ts  reconciler.ts
    sessions.ts  socket.ts  messages.ts  tasks.ts  workers.ts  events.ts
    runtime/{runtime,herdr}.ts
.opencode/plugins/agentctl.ts  .opencode/skills/agent-worker/SKILL.md
tests/{integration,contract}.test.ts
```
