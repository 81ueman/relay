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

For **every control-plane semantic change, review whether the formal design
intent changed.** A formal *run* is heavy, so it is not part of the routine
loop; the *review* is mandatory.

- If the change alters no formal property or abstraction: `typecheck` + `bun
  test` only. (This is the common case: the model is design intent, not a
  mirror of `src/`.)
- If the intended property or abstraction changed: update `formal/` **in the
  same change** and run the matching suite.
- Presentation-only changes need no formal review.

Read `formal/README.md` first — it states what Relay must guarantee (Levels
A–D) before any TLA action. Then run the suite that matches the change:

```bash
bun run formal:safety       # ownership, role, the three fences, quiet, parent signals
bun run formal:scheduling   # the reconcile-boundary responsiveness obligation
bun run formal:roles        # claim-role gating vs review capability
bun run formal:tree         # one-hop parent signalling, no auto parent transition
bun run formal:recovery     # crash/restart/adopt, generation + session + lease fences
bun run formal:liveness     # bounded wake cooldown / quiet lease (FairSpec)
bun run formal:completion   # AllTasksDone demonstration (NOT a Relay guarantee)
bun run formal:mutations    # baseline PASS + mutant refuted by the EXPECTED property
```

If the intended property and the TypeScript disagree, decide from the property
(and the top-level `README.md`): fix the TypeScript and add a unit test. Do **not**
edit `Relay.tla` to make a code change look correct.

### When TLC formal checks are NOT required

**Everything that does not change the TLA model or the control-plane intent.**
For ordinary `src/` changes that keep the design intent intact — a refactor, a
new read-only projection, help text, a test — `bun run typecheck` + `bun test`
are the gate; no formal run. Examples:

- `relay status` / `relay dashboard` formatting, columns, colors, widths
- new read-only projections or annotations
- help text, usage strings, README/reference docs
- new tests

Rule of thumb: **run the formal suite only if `git diff` touches `formal/`;
otherwise, still ask whether the change alters a documented property** (a state
transition, a supervisor decision, a durable write ordering, an ownership
fence). If it does, update `formal/` in the same change. If it does not, say so
in the change description.

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
