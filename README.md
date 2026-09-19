# relay — `agentctl`: a lightweight supervisor for Herdr + OpenCode agents

Goal: **as long as unblocked work exists, at least one agent keeps moving.**

`agentctl` is a small deterministic control plane (Bun + TypeScript + SQLite).
It is not an orchestration framework. It owns:

- durable task queue (SQLite is the **only** source of truth, WAL mode)
- worker state, durable inbox, append-only event log
- OpenCode event hooks (triggers only — `session.idle` is never completion)
- Herdr session/pane adapter (transport only, never truth)
- stalled/dead worker recovery, planner/worker/reviewer auto wake-up
- an OpenCode Skill (`agent-worker`)

Failure philosophy: `process alive ≠ progressing`, `session idle ≠ done`,
`LLM says done ≠ done`, `wake delivered ≠ accepted`,
`human blocker ≠ worker must stop`, `parent dead ≠ system stops`.

## Install

```bash
cd relay
bun install
# make `agentctl` available (pick one):
bun link                      # global `agentctl`
# or: export AGENTCTL_BIN="bun /path/to/relay/src/cli.ts"
#     (the OpenCode plugin uses $AGENTCTL_BIN, default `agentctl`)
```

Requires: Bun ≥ 1.1, `herdr` on PATH (daemon works DB-only without it),
OpenCode v2 (plugin shape verified against the bundled `herdr-agent-state`
integration: default export `{ id, setup }` with
`ctx.session/ctx.tool.hook` + `ctx.event.subscribe`; event payloads carry
`{ type, data }` with `data.sessionID`).

## Setup

```bash
agentctl init     # creates .agentctl/state.db (WAL)
```

The OpenCode plugin (`.opencode/plugins/agentctl.ts`) and Skill
(`.opencode/skills/agent-worker/SKILL.md`) are auto-discovered when OpenCode
runs under this repo — no config needed. Verify:

```bash
opencode plugin list   # relay.agentctl ... .opencode/plugins/agentctl.ts
```

`$AGENTCTL_WORKER` (or `--worker`, or `.agentctl/worker-id`) identifies the
calling worker. DB path: `$AGENTCTL_DB` or `.agentctl/state.db`.
Tuning: `AGENTCTL_LEASE_MS` (120000), `AGENTCTL_STALL_MS` (60000),
`AGENTCTL_LOW_WATER` (3), `AGENTCTL_AUTO_APPROVE`, `AGENTCTL_INTERVAL_MS` (1500).

## Minimal demo: 2 workers + planner + reviewer

Terminal 1 — supervisor:

```bash
agentctl init
agentctl daemon
```

Terminal 2 — register the cast (run each worker's commands with its identity):

```bash
export AGENTCTL_WORKER=worker-1
agentctl worker register worker-1 --role worker
agentctl worker register worker-2 --role worker
agentctl worker register planner --role planner
agentctl worker register reviewer --role reviewer

agentctl task add "Add password reset endpoint" --priority 10 \
  --acceptance "POST /reset requested, token emailed, tests green"
agentctl task add "Write reset-email template" --priority 5
agentctl task add "Add rate limiting to /reset" --priority 1
agentctl status
```

Worker loop (worker-1 and worker-2, e.g. two Herdr panes running OpenCode
with the `agent-worker` skill):

```bash
export AGENTCTL_WORKER=worker-1
agentctl next                                    # atomic claim, prints lease
agentctl note T1 "endpoint scaffolded"
agentctl note T1 "token flow works, writing tests"
agentctl submit T1 --evidence "bun test reset (8 pass)"
agentctl next                                    # immediately, never wait
```

Reviewer loop:

```bash
export AGENTCTL_WORKER=reviewer
agentctl next                 # picks up review tasks (state stays `review`)
agentctl approve T1           # review -> done
# or: agentctl reject T1 "token not hashed"   # review -> queued + note
```

Planner tops up the queue when it runs low (daemon wakes it automatically):

```bash
export AGENTCTL_WORKER=planner
agentctl task add "Expire reset tokens after 1h" --priority 8 --role worker
```

Durable messages (survive restarts; wake is best-effort after commit):

```bash
agentctl send worker-2 "T1 is ready for review" --task T1
AGENTCTL_WORKER=worker-2 agentctl inbox --claim
```

Human blocker (parks the task, never the worker or the system):

```bash
agentctl block T2 --human "need prod SMTP credentials"
agentctl next        # keep going; SYSTEM_WAITING_FOR_HUMAN only when
                    # every unfinished task is blocked_human
```

Observe:

```bash
agentctl status
agentctl events --follow
```

## Worker protocol (also in the Skill)

`next → claim → work → note → work → submit|block → next …`
`submit` moves `running → review`; only `approve` moves `review → done`.
Claims carry fencing leases (`lease_token`, `lease_until`); heartbeats via
`note`; a stale worker's late `submit` is rejected with `STALE_LEASE`.
Pane/Herdr `idle` is never completion — the DB decides.

## Tests

```bash
bun test            # 19 integration tests incl. the 6 failure tests:
                    # idle false-positive, crash, zombie completion,
                    # blocked-human, lost wake, no-productive-worker
bunx tsc --noEmit
```

## Layout

```text
src/cli.ts  daemon.ts  db.ts  schema.ts  scheduler.ts  reconciler.ts
    messages.ts  tasks.ts  workers.ts  events.ts  runtime/{runtime,herdr}.ts
.opencode/plugins/agentctl.ts  .opencode/skills/agent-worker/SKILL.md
tests/integration.test.ts
```
