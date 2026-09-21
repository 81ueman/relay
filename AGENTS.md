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

> **Currently deferred.** A formal run is not the gate for a scheduler change
> until the model has been re-examined (see the next subsection). Run
> `typecheck` + `bun test`, and say the formal run was deferred and why.

`bun run formal` / `formal:failures` / `formal:liveness` / `formal:done` model
check the supervisor's **state machine**. They are relevant to changes that can
alter what the control plane *does*:

- task/worker state transitions, ownership, leases, fencing, generation handling
- the reconciler / scheduler (wake, stall, revive, restart, cleanup, role gating)
- message delivery, nudge policy, completion/block bubbling
- anything that changes an event, a decision, or a durable row

### When TLC formal checks are NOT required

**Presentation-only changes do not need formal checks.** If the change cannot
alter state, a decision or a durable row, `typecheck` + `bun test` are enough.
Examples:

- `relay status` / `relay dashboard` formatting, columns, colors, widths
- new read-only projections or annotations (the numbers may come from the same
  domain functions, but nothing is written back)
- help text, usage strings, README/reference docs
- new tests

Rule of thumb: **if `git diff` touches no state transition, no decision, and no
write path, skip TLC and say so.** When in doubt, prefer running it; note the
skipped/last run in the change description either way.

### TLA vs. code: record the divergence, don't paper over it

`formal/Relay.tla` models the intended state machine. It is **not** a mirror of
the current implementation, and the two must not be forced into agreement by
whichever edit is convenient.

**Known open question (as of 2026-09-21): the TLA model may not match the
implementation, and this is unresolved.** The formal run is currently
**deferred** — do not treat a red/green TLC result as the gate for a scheduler
change until the model has been re-examined. Human decision: model it properly
later; land the code fix first.

Concrete divergences found so far:

- `Wake(w)` gates on `RunnableExists` only — there is **no `~WorkerWorking`
  conjunct**. The TS scheduler had `runnable > 0 && working === 0`, which is why
  idle role-matched workers were never nudged while any other worker was busy.
  Either the TS was too strict (fixed) **or** the spec is missing a condition it
  should have; that has not been decided.
- `Wake(w)` is per-worker under weak fairness (`WF_baseVars(Wake(w))` for every
  `w`), which suggests waking every eligible idle worker. The old TS woke one
  per pass (`break`) — again, either an implementation-only restriction (fixed)
  or the spec is under-constrained on how many wakes happen per tick.
- The spec models **reachability**, not tick budgets. Rate limiting (the
  per-worker wake cooldown) therefore has no TLA counterpart. Because of that,
  TLC would **not** have caught the runnable-stall bug at all: the bug was a
  guard that made a reachable state unreachable, and the invariant properties
  (`RunnableEventuallyMoves`, etc.) are about whether work *eventually* moves,
  not whether an idle peer is nudged on a given tick.

Until the model is revisited: for a state-transition/decision change, run
`typecheck` + `bun test`, state clearly that the formal run was deferred **and
why**, and list any spec/code divergence the change touches. Do not edit
`Relay.tla` to make a code change look correct, and do not claim formal
verification that was not performed.

Reference points in `src/`: `needsWorkerWakeup` (`src/scheduler.ts`) vs.
`Wake(w)` (`formal/Relay.tla`); the wake loop in `reconcile`
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
