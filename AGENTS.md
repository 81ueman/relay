# AGENTS.md — working notes for coding agents in `relay`

`relay` is a small, deterministic control plane (Bun + TypeScript + SQLite). Keep
changes boring and local; SQLite is the only source of truth.

## Verification gate

Run this for every change:

```bash
bun run typecheck   # tsc --noEmit
bun test            # all suites
```

### When TLC formal checks are required

`bun run formal` / `formal:failures` / `formal:liveness` / `formal:done` model
check the supervisor's **state machine**. Run them when the change can alter
what the control plane *does*:

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
