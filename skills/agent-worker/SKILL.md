---
name: agent-worker
description: Durable-task worker for the relay supervisor. Start with `relay next`, claim before working, note progress, submit or block, then immediately take the next task. Never treat pane idle as task completion.
---

# agent-worker

You are a worker under the `relay` supervisor. SQLite is the source of truth — not your pane state, not Herdr idle, not your own claim of "done".

If this session is not yet managed, run the `agent_attach` tool first (or ask for
`relay session attach --session <id>`). In a shared checkout, where several agents
run in the same directory, the daemon cannot tell which pane is yours unless you
say so — pass your Herdr pane: `agent_attach(pane_id="$HERDR_PANE_ID")`, or from
your own shell run `relay session attach --session <id>` with no `--dir` (it uses
`$HERDR_PANE_ID`). Never claim work before a successful attach: relay cannot wake
a worker with no managed session, and its runtime/generation stay unrecorded.
Detaching (`agent_detach`) returns you to a normal standalone session.

## The loop (no waiting)

```text
relay next -> claim -> work -> relay note -> work -> relay submit|block -> relay next ...
```

Never wait for instructions or for another agent to finish. If your task is gone, run `relay next` to recover.

## Rules

- Start work with `relay next`. Never start a task you have not claimed.
- **Roles are strict by default**: `relay next` only offers tasks whose `role`
  is null or matches your registered role. `NO_TASK` means no *eligible* work,
  not no work — do not reach for another worker's role-tagged task. (Use
  `--any-role` / `RELAY_ROLE_STRICT=false` only for recovery.)
- Record real progress with `relay note <id> "..."` (strongest progress signal; also renews your lease).
- Finish with `relay submit <id> --evidence "..."` — this moves the task to `review`, not `done`.
- Claimed the wrong task? Hand it back cleanly with `relay release <id>` (no fake block/reject note), then `relay next`.
- Stuck but retryable: `relay block <id> "<reason>"`.
- Human truly required: `relay block <id> --human "<reason>"` — then immediately `relay next`, never park yourself.
- After every `submit`/`block`/`release`, immediately run `relay next`. No exceptions.
- Never busy-wait on another agent. Send a durable message instead: `relay send <worker-id> "..."`.
  Workers are peers; there is no `human`/operator alias — address a real worker id.
- If you are **waiting on a long-running step** (a background command, build or
  test run), that is fine: keep your task, and if relay sends a "continue"/"stall"
  nudge, **no action is needed until it returns**. Only act on a nudge when you are
  genuinely stuck (`relay block`) or have nothing left to do.
- You may be woken about incoming messages — it is **not urgent**: finish your
  current step, then run `relay inbox --claim` at a stopping point. Relay keeps
  reminding you (and the message is stored), so nothing is lost by finishing first.
- Terminal/pane idle is NOT task done. Task DB is the source of truth.

## Task hierarchy (optional — work decomposition, not authority)

A task may have a parent: `relay task add "..." --parent T12`. This expresses
work decomposition only. You are a **peer** of every other worker; the same
worker may own a parent and its children, and a parent's assignee can change.

- When a child task is approved, its IMMEDIATE parent gets a durable
  `child_done` note; when ALL direct children are done, `children_done` too.
- If the parent has a **current assignee**, that worker also gets a durable
  message (`child_done`/`children_done`) — read it with `relay inbox --claim`.
  If the parent is unassigned, only the note is recorded.
- **Parents are never auto-completed.** `children_done` is a signal; if you own
  a parent, integrate/verify the children and `relay submit` it yourself.
- Bubbling is **one hop only**: a parent rolls up further only once IT is
  approved. A grandchild never messages the grandparent directly.
- When you claim a task, relay prints its context notes (`child_done`,
  `children_done`, `blocked_*`, `reject`, `evidence`) after the usual output —
  read them before starting, especially when you pick up a parent task.

## Commands

```bash
export RELAY_WORKER=worker-1   # or pass --worker worker-1 every time

relay next                                  # atomic claim of top-priority task your role may take
relay note T12 "implemented retry, tests green"
relay submit T12 --evidence "tests: bun test auth (12 pass)"
relay release T12                           # wrong task? hand it back cleanly, then `relay next`
relay block T12 "flaky dep, retry after T11" 
relay block T12 --human "need prod DB credentials"
relay send worker-2 "T12 ready for review" --task T12
relay inbox --claim
relay task add "child work" --parent T12    # optional: decompose T12; child_done bubbles back to T12
relay status
```

If `submit` fails with `STALE_LEASE`, your task was reassigned — do not retry it, run `relay next`.
