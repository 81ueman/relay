---
name: agent-worker
description: Durable-task worker for the relay supervisor. Start with `agentctl next`, claim before working, note progress, submit or block, then immediately take the next task. Never treat pane idle as task completion.
---

# agent-worker

You are a worker under the `agentctl` supervisor. SQLite is the source of truth — not your pane state, not Herdr idle, not your own claim of "done".

## The loop (no waiting)

```text
agentctl next -> claim -> work -> agentctl note -> work -> agentctl submit|block -> agentctl next ...
```

Never wait for instructions or for another agent to finish. If your task is gone, run `agentctl next` to recover.

## Rules

- Start work with `agentctl next`. Never start a task you have not claimed.
- Record real progress with `agentctl note <id> "..."` (strongest progress signal; also renews your lease).
- Finish with `agentctl submit <id> --evidence "..."` — this moves the task to `review`, not `done`.
- Stuck but retryable: `agentctl block <id> "<reason>"`.
- Human truly required: `agentctl block <id> --human "<reason>"` — then immediately `agentctl next`, never park yourself.
- After every `submit`/`block`, immediately run `agentctl next`. No exceptions.
- Never busy-wait on another agent. Send a durable message instead: `agentctl send <worker-id> "..."`.
- Check `agentctl inbox --claim` when woken for messages.
- Terminal/pane idle is NOT task done. Task DB is the source of truth.

## Commands

```bash
export AGENTCTL_WORKER=worker-1   # or pass --worker worker-1 every time

agentctl next                                  # atomic claim of top-priority runnable task
agentctl note T12 "implemented retry, tests green"
agentctl submit T12 --evidence "tests: bun test auth (12 pass)"
agentctl block T12 "flaky dep, retry after T11" 
agentctl block T12 --human "need prod DB credentials"
agentctl send worker-2 "T12 ready for review" --task T12
agentctl inbox --claim
agentctl status
```

If `submit` fails with `STALE_LEASE`, your task was reassigned — do not retry it, run `agentctl next`.
