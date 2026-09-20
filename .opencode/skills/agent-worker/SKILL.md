---
name: agent-worker
description: Durable-task worker for the relay supervisor. Start with `relay next`, claim before working, note progress, submit or block, then immediately take the next task. Never treat pane idle as task completion.
---

# agent-worker

You are a worker under the `relay` supervisor. SQLite is the source of truth — not your pane state, not Herdr idle, not your own claim of "done".

If this session is not yet managed, run the `agent_attach` tool first (or ask for
`relay session attach --session <id>`). Detaching (`agent_detach`) returns you
to a normal standalone session.

## The loop (no waiting)

```text
relay next -> claim -> work -> relay note -> work -> relay submit|block -> relay next ...
```

Never wait for instructions or for another agent to finish. If your task is gone, run `relay next` to recover.

## Rules

- Start work with `relay next`. Never start a task you have not claimed.
- Record real progress with `relay note <id> "..."` (strongest progress signal; also renews your lease).
- Finish with `relay submit <id> --evidence "..."` — this moves the task to `review`, not `done`.
- Stuck but retryable: `relay block <id> "<reason>"`.
- Human truly required: `relay block <id> --human "<reason>"` — then immediately `relay next`, never park yourself.
- After every `submit`/`block`, immediately run `relay next`. No exceptions.
- Never busy-wait on another agent. Send a durable message instead: `relay send <worker-id> "..."`.
- Check `relay inbox --claim` when woken for messages.
- Terminal/pane idle is NOT task done. Task DB is the source of truth.

## Commands

```bash
export RELAY_WORKER=worker-1   # or pass --worker worker-1 every time

relay next                                  # atomic claim of top-priority runnable task
relay note T12 "implemented retry, tests green"
relay submit T12 --evidence "tests: bun test auth (12 pass)"
relay block T12 "flaky dep, retry after T11" 
relay block T12 --human "need prod DB credentials"
relay send worker-2 "T12 ready for review" --task T12
relay inbox --claim
relay status
```

If `submit` fails with `STALE_LEASE`, your task was reassigned — do not retry it, run `relay next`.
