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
| identity + liveness | `herdr pane report-agent --agent dsh` — the pane LABEL relay's `resolveIdentity` matches on |
| turn-boundary idle | `ctx.on('agent/status')` -> `session.idle` / `session.status` |
| long-tool liveness | `ctx.on('session/event')` -> `tool.started` / `tool.execute.after` |
| wake | long-poll `worker.wake.await`, deliver via `agent.followup()` |

dsh is therefore registered as an **event-driven** harness (`src/harness.ts`),
and its wake uses relay's durable **wake outbox** (`src/wake-outbox.ts`) because
a server has no pane to type into.

> **Herdr 0.9.x caveat.** Herdr only records a resume command (`agent_session`)
> for the agents it ships. `report-agent-session` is therefore a no-op for
> `--agent dsh` on 0.9.x (resume commands require Herdr 0.10.0+), so the pane
> shows `agent=dsh` with `agent_session=null`. relay does not depend on that
> mapping for dsh: `resolveIdentity` resolves the pane by the `dsh` label +
> directory/pane hint, which the `report-agent` call above establishes from
> session start. The plugin still sends `report-agent-session` for forward
> compatibility.

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

1. **Herdr sees the agent.** From session start (not just after the first turn)
   the pane is labelled `agent=dsh` with a `working`/`idle` status:
   `herdr agent list` shows it; `herdr pane get <pane>` shows `agent=dsh`. On
   Herdr 0.9.x `agent_session` stays `null` (see the caveat above) — that is
   expected.
2. **Events arrive.** With the session attached, `relay events --worker dsh-1`
   should show `tool.started`/`tool.execute.after` and `session.idle` as you
   prompt.
3. **Wake round-trips.** Queue a task for the worker and confirm the session
   runs it *without you typing* — the plugin pulled `worker.wake.await` and
   called `followup()`. `relay events --worker dsh-1` shows `worker.woken`.
4. **Wake loop is paced.** The loop never re-polls faster than 1/s even when a
   reply is instant or the relay socket is absent (`wakeBackoff` in `lib/core.mjs`);
   it does not hot-loop.

### Verified against dsh 0.1.5-rc.1 + Herdr 0.9.1

- plugin loads in `--profile headless` and forwards `session.status`(working) ->
  `session.idle` for a real `session-<uuid>` session;
- the pane becomes `agent=dsh` from session start;
- a queued `worker.wake.await` wake is delivered via `followup()` and the agent
  runs the injected turn (fake relay, no typing);
- `HerdrRuntime.resolveIdentity` accepts the dsh session by pane hint AND by
  directory, returning `agentKind="dsh"`;
- the wake loop measured ~1 poll/s under an instant-reply server (the pre-fix
  build sent 4M requests and never exited).

### Real-relay end-to-end (dsh 0.1.5-rc.1, Herdr 0.9.1)

Driven against a real `relay` daemon (source build), a live long-lived dsh agent
(SDK profile, `session/prompt`), pane `agent=dsh`:

- `relay session attach --kind dsh` binds the worker (`runtime_id=<pane>`);
- a row in relay's wake outbox is pulled by the plugin's `worker.wake.await` and
  delivered via `followup()` — the agent runs a **second turn** with no typing,
  and `relay events` shows `session.status working` -> `session.idle`;
- the wake loop is paced (~1 poll/s) and never hot-loops.

## Notes / limits

- **Use a long-lived profile.** `--profile web` (recommended) or an
  sdk/acp server keep the agent alive across turns, which is what makes
  `followup()` wakes work. `--profile headless` is a **one-shot**: it disposes
  its agent after the first task, so a wake delivered afterwards has no live
  agent (`followup` would target a disposed agent). Do not run headless as a
  supervised worker.
- **stdout may be a protocol channel.** Profiles `sdk` and `acp` reserve stdout
  for JSON-RPC frames, so the plugin logs to **stderr** only. Keep any added
  logging on stderr too.
- **The `agents` service is captured at `apply` time.** Cordis resolves a
  service through the context getter; reading `ctx.agents` from the long-lived
  wake loop throws `cannot get required service "agents" in inactive context`
  once this plugin's fiber is no longer the active provider — and an unhandled
  rejection is fatal to dsh. `deliver()` therefore uses the captured service
  (falling back to the last-seen agent handle) and is fully guarded.
- One `dsh --profile web` server per Herdr pane maps that pane to one relay
  worker; run one server per worker (its own tab), as relay spawns agent tabs
  one-per-worker.
- dsh session ids are `session-<uuid>` (an agent id may prefix it:
  `main-session-<uuid>`); both shapes are accepted.
- `worker.spawn --kind dsh` is refused: Herdr cannot `agent start --kind dsh`.
  Start dsh by hand and attach, as above.
- Context-window rotation (`session.context`) is not yet forwarded; a dsh worker
  degrades to relay's liveness-only handling (no cooperative handoff).
