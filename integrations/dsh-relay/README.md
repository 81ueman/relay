# dsh <-> relay bridge

Makes a **DeepSeek Harness (`dsh`)** session a first-class relay worker without a
Herdr input pane, using the official `dsh --profile web` server plus this
out-of-tree [cordis](https://github.com/) plugin bundle.

## Why this shape

Herdr can start/type into TUIs it knows (`opencode`, `codex`, `claude`). dsh has
no such TUI in-tree, and the community TUIs are young and unofficial. Instead:

- run the **official** `dsh --profile web` server (no third-party TUI code);
- this plugin (relay-owned, small, auditable) bridges it:

| relay needs | how the plugin provides it |
| --- | --- |
| identity + liveness | `herdr pane report-agent-session` / `report-agent` (`--agent dsh`) |
| turn-boundary idle | `ctx.on('agent/status')` -> `session.idle` / `session.status` |
| long-tool liveness | `ctx.on('session/event')` -> `tool.started` / `tool.execute.after` |
| wake | long-poll `worker.wake.await`, deliver via `agent.followup()` |

dsh is therefore registered as an **event-driven** harness (`src/harness.ts`),
and its wake uses relay's durable **wake outbox** (`src/wake-outbox.ts`) because
a server has no pane to type into.

## Install

```bash
# from the relay checkout
dsh plugin --profile web add "$(pwd)/integrations/dsh-relay"
```

The bundle inserts one row (`relay-bridge`) into the profile. All hooks are
best-effort: a missing Herdr or relay socket never breaks the agent.

## Run + attach

```bash
# 1. start dsh inside a Herdr pane (the plugin needs $HERDR_PANE_ID)
dsh --profile web

# 2. in another pane, register a worker and attach the dsh session
relay worker register dsh-1 --role worker
relay session attach --session session-<uuid> --kind dsh --worker dsh-1 --dir "$PWD"
```

`--kind dsh` is inferred automatically from the `session-<uuid>` id shape; it is
accepted here for clarity. Once attached, relay forwards no events until the
session is managed and it will only nudge through the outbox.

## Smoke test (verify before relying on it)

1. **Herdr sees the session.** After the first turn, `herdr agent list` (or
   `herdr pane get <pane>`) should show `agent=dsh` with
   `agent_session=session-<uuid>` and a `working`/`idle` status.
2. **Events arrive.** With the session attached, `relay events --worker dsh-1`
   should show `tool.started`/`tool.execute.after` and `session.idle` as you
   prompt.
3. **Wake round-trips.** Queue a task for the worker and confirm the session
   runs it *without you typing* — the plugin pulled `worker.wake.await` and
   called `followup()`. `relay events --worker dsh-1` shows `worker.woken`.
4. **No shell-outs on the hot path.** The plugin spawns `herdr` only on
   identity/status changes (not per event), and trades JSON Lines with the relay
   socket for the rest.

## Notes / limits

- One dsh server per Herdr pane maps that pane to one `agent_session`; run one
  `dsh --profile web` per relay worker (its own tab), as relay spawns agent tabs
  one-per-worker.
- dsh session ids are `session-<uuid>` (an agent id may prefix it:
  `main-session-<uuid>`); both shapes are accepted.
- `worker.spawn --kind dsh` is refused: Herdr cannot `agent start --kind dsh`.
  Start dsh by hand and attach, as above.
- Context-window rotation (`session.context`) is not yet forwarded; a dsh worker
  degrades to relay's liveness-only handling (no cooperative handoff).
