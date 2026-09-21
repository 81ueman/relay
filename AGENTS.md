# AGENTS.md — working notes for coding agents in `relay`

`relay` is a small, deterministic control plane (Bun + TypeScript + SQLite). Keep
changes boring and local; SQLite is the only source of truth.

## Verification gate

Run this for every change:

```bash
bun run typecheck   # tsc --noEmit
bun test            # all suites
```

### When TLC formal checks are run

Run the formal suites **only when you change the TLA+ model itself** — i.e. when
you write or edit `formal/Relay.tla`, `formal/*.cfg`, or
`formal/run-mutations.sh`. The model is design intent for the control plane, not
a mirror of `src/`, so it is **not** re-run for ordinary implementation changes.
A formal run is **heavy**: it is not part of the routine loop.

Read `formal/README.md` first — it states what Relay must guarantee (Levels A–D)
before any TLA action. Then run the suite that matches the model change:

```bash
bun run formal:safety       # ownership, role gating, fencing, quiet, parent signals
bun run formal:scheduling   # the reconcile-boundary responsiveness obligation
bun run formal:recovery     # crash/restart/detach, generation + session fence
bun run formal:liveness     # bounded wake cooldown / quiet lease (FairSpec)
bun run formal:completion   # AllTasksDone demonstration (NOT a Relay guarantee)
bun run formal:mutations    # M1–M12: every mutant must be refuted
```

If the intended property and the TypeScript disagree, decide from the property
(and the top-level `README.md`): fix the TypeScript and add a unit test. Do **not**
edit `Relay.tla` to make a code change look correct.

### When TLC formal checks are NOT required

**Everything that does not change the TLA model.** For ordinary `src/` changes —
including a new state transition, a supervisor decision, a durable write, a new
event, or a new column — `bun run typecheck` + `bun test` are the gate; no formal
run. The model is not a mirror of `src/`, so an implementation change never
obliges a model change. Examples:

- any `src/` state transition, supervisor decision, or durable write
- `relay status` / `relay dashboard` formatting, columns, colors, widths
- new read-only projections or annotations
- help text, usage strings, README/reference docs
- new tests

Rule of thumb: **run formal only if `git diff` touches `formal/`.** Otherwise
skip it (and say so in the change description).

### TLA vs. code: record the divergence, don't paper over it

`formal/Relay.tla` models the intended state machine. It is **not** a mirror of
the current implementation, and the two must not be forced into agreement by
whichever edit is convenient. The `formal/README.md` "Formal ↔ TypeScript
mapping" table is the contract between them.

When the model and the code disagree, decide from the *property*: if the code is
wrong, fix the code and add a unit test; if the model is wrong, fix the model and
add a mutation that would have caught the bug (`formal/run-mutations.sh`).

Reference points in `src/`: `needsWorkerWakeup` (`src/scheduler.ts`) vs.
`EligibleWakees`/`Reconcile` (`formal/Relay.tla`); the wake loop in `reconcile`
(`src/reconciler.ts`).

## Commits

- Commit **path-scoped** (`git commit --only <path> ...`); never `git add -A`
  in a shared checkout.
- Don't mix a big refactor into an unrelated fix; split by intent.

## Working with agents

- Workers are peers; the task tree is work decomposition, not an agent hierarchy.
- One-hop signalling only: completion/block bubbles to the **immediate** parent.
- Never treat pane/session idleness as task completion.
- `relay wait <task> --for <dur> "reason"` is the bounded, intentional pause; a
  worker that is only waiting should declare it instead of being nudged.
