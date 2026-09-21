# Relay formal model (TLA+ / TLC)

`formal/Relay.tla` is a small, finite TLA+ model of Relay's **control plane**.
It is not a transcription of `src/`. It is the design intent of Relay — *what the
control plane must guarantee* — written so TLC can **break it**. Read this file
first; the model exists to produce counterexamples against the properties below.

> **Model ≠ implementation proof.** TLC explores a finite abstraction of the
> *orchestration logic*. It does not execute the TypeScript, SQLite, Herdr, or
> OpenCode. A green run means "no counterexample inside this abstraction", not
> "the implementation is correct". See [What is modelled vs abstracted](#what-is-modelled-vs-abstracted).

---

## What Relay must guarantee

Relay is a supervisor for a fleet of agent workers. Its job is to keep durable
work moving *without ever corrupting ownership*. Everything else is in service of
those two ideas. They are stated here in order of what Relay owes, from
"always true" to "only true if the world cooperates".

### A. Relay safety — what must hold in every execution

These must hold with **no fairness assumption at all**: every reachable state,
every interleaving, including crashes and duplicate signals.

| # | Guarantee | Invariant |
| --- | --- | --- |
| A1 | A task has at most one owner; ownership is cleared on every transition out of `running`/`review`. | `AtMostOneOwner`, `OwnerConsistent`, `QueuedHasNoOwner` |
| A2 | A worker may only own a task it is role-eligible for (strict default). Manual `--any-role` is a separate operator escape hatch, not this property. | `NoRoleViolation` |
| A3 | **A stale actor can never mutate current state.** A running task's owner is live, holds the task, and its current session generation is the one that won the task's fence. | `NoStaleMutation`, `FenceAgreement` |
| A4 | A managed session always carries the worker's *current* generation. An attach presenting an older generation is rejected. | `NoStaleSession` |
| A5 | Generations never move backwards. | `GenerationMonotonicity` |
| A6 | **`done` is reachable only through review.** `session.idle`, a quiet lease, a crash, or a child's completion are never completion. | `DoneRequiresReview` |
| A7 | A quiet lease is task-scoped, bounded, and never outlives its task. | `QuietScoped`, `QuietDoesNotSuppressCrash` |
| A8 | A permission wait is *occupied*: it keeps its task and never takes new work. | `NoWaitingInputClaim`, `WaitingInputOccupancy` |
| A9 | Nothing is activated or started before its durable row exists. | `DurableBeforeDelivery` |
| A10 | Relay reaps only runtimes it owns, never the current generation. | `CleanupIsRelayOwned` |
| A11 | An adopted (externally-owned) runtime is never taken over by Relay. | `AdoptedNeverReplaced` |
| A12 | Child completion/blocking produces a durable one-hop parent signal, atomically with the child's state change, and never auto-transitions the parent. | `ParentSignalsOneHop`, `ChildDoneSignalled`, `ChildBlockedSignalled`, `NoAutomaticParentTransition` |

The two the whole model is organised around are **A3** (fencing) and **B1**
(responsiveness, below).

### B. Relay responsiveness / liveness — what Relay owes while the world keeps moving

> **Central property.** *If Relay can make useful progress now, Relay must not be
> the reason useful work remains idle.*

The naive reading — "runnable > 0 and nobody working ⇒ wake somebody" — is
**too weak**: in a parallel fleet someone is usually working, and that says
nothing about whether *queued work has a taker*. `WorkerWorking` is not system
progress. The model therefore evaluates the obligation at a **reconcile
boundary**, per eligible idle worker:

| # | Guarantee | Property |
| --- | --- | --- |
| B1 | At a reconcile boundary, every operational idle worker that can take claimable durable work, and has no legitimate temporary excuse, was woken this pass — regardless of who else is working. | `NoAvoidableIdleAtReconcileBoundary` |
| B2 | Relay never wakes a worker for work that worker cannot claim (role-ineligible). The snapshot is taken at the moment of the attempt, so a later overtaking claim does not make it bogus. | `NoWakeForUnclaimableWork` |

`NoAvoidableIdleAtReconcileBoundary` is evaluated only in the `stable` stage —
i.e. after a complete reconcile pass — so it is checkable at a well-defined
boundary. See [The reconcile boundary](#the-reconcile-boundary).

### C. Environment-assumption liveness — only true if the world cooperates

These need assumptions on the environment (workers eventually act; the
supervisor loop keeps running). They are **not** Relay guarantees on their own.

| # | Guarantee | Property / assumption |
| --- | --- | --- |
| C1 | A wake cooldown is *bounded* — it is never a permanent reason to ignore work. | `NoPermanentCooldown` (needs `WF(Reconcile)`, `WF(CooldownExpire)`) |
| C2 | A quiet lease is *bounded*. | `NoPermanentQuiet` (needs `WF(Reconcile)`, `WF(QuietExpire)`) |
| C3 | A durable wake is never lost: a worker owed a wake eventually has one attempted. | `NoLostWake` (needs `WF(Reconcile)`, `WF(RetryWake)`) |
| C4 | Claimable work does not stay claimable forever. | `NoPermanentStranding` (needs worker fairness — see Level D) |

### D. Explicitly NOT guaranteed

| # | Not guaranteed | Why |
| --- | --- | --- |
| D1 | **`AllTasksDone`.** Relay does not promise the fleet drains to all-done. | If the environment never acts (workers never claim/submit/approve), work legitimately stays queued. `AllTasksDone` is a demonstration under strong environment fairness, kept in `RelayCompletion.cfg`, and **is not a Relay guarantee**. |
| D2 | Completion of *unclaimable* work. A queued task whose role has no registered worker is visible (surfaced by `unclaimableRunnableTasks`) but is **not** a liveness violation. | Relay cannot invent a worker of a missing role. |
| D3 | `NoPermanentStranding` under `FairSpec` alone. | The workers' own progress is an environment assumption, not a Relay obligation. |
| D4 | Correct behaviour under two concurrent supervisors on one DB. | Excluded by the [implementation boundary](#implementation-boundary-single-supervisor). |
| D5 | Planner low-water wake, dashboard/clustering/affinity, ANSI/width, `relay status` formatting, git KPI. | Presentation / non-control-plane concerns, deliberately out of scope. |

### The bad executions this model exists to forbid

1. **Avoidable idle.** `w1` working `t1`, `w2` idle, `t2` queued and claimable by
   `w2` — and Relay wakes nobody because *someone* is working. (`M1`)
2. **First-candidate only.** Two idle workers, two tasks, but Relay wakes only the
   first candidate and one task strands. (`M2`)
3. **Role-blind wake.** Relay wakes a worker for a task its role cannot claim. (`M3`)
4. **Permanent suppression.** A wake cooldown or quiet lease becomes a permanent
   reason to skip a worker. (`M4`)
5. **Quiet outlives its task.** A crash leaves a quiet lease behind, suppressing
   recovery. (`M5`)
6. **Release without a new fence.** A released task keeps its old owner pointer,
   so a stale actor can still mutate it. (`M6`)
7. **Stale attach.** A generation older than the worker's is accepted as the live
   session. (`M7`)
8. **Adopted runtime reaped / taken over.** Relay closes or replaces a tab it does
   not own. (`M8`, `M9`)
9. **Split child-done.** The child's state changes but the durable parent signal
   is not sent in the same transaction. (`M10`)
10. **Recursive bubbling.** A grandparent is signalled for a grandchild. (`M11`)
11. **Self-approval.** A worker marks its own task done without review. (`M12`)
12. **Idle means done.** Treating `session.idle` as completion.

---

## Implementation boundary (single supervisor)

```text
Exactly one Relay supervisor process holds the dedicated SQLite supervisor lock
for a canonical control-plane DB at a time.
```

The model has a single implicit supervisor. The implementation enforces this at
daemon startup (a long-lived `BEGIN IMMEDIATE` on `<canonical-db>.relay-lock.db`
plus a non-destructive `.relay/relay.sock` ownership probe). Because concurrent
daemons are excluded, generation allocation stays process-local
(`restartingWorkers` + a commit-time re-check) and the model needs **no**
generation reservation table, distributed lock, or leader election.

## The reconcile boundary

The model has a two-stage tick:

- **environment** — workers and the outside world act (claim, submit, crash,
  stall, block, wait, quiet, adopt, detach, deliver mail, …). Environment steps
  set `stage = 0`.
- **reconcile** — one atomic supervisor pass that sets `stage = 1`. It decides
  whom to wake this pass and reaps eligible runtimes. (A quiet lease lapses only
  through its own deadline, `QuietExpire` — the supervisor does not clear a live
  lease.)

`NoAvoidableIdleAtReconcileBoundary` is only asserted when `stage = 1`.
This is what makes a *scheduling* obligation checkable: the model can ask "after
this pass completed, was any eligible idle worker left un-woken?" without having
to encode wall-clock tick budgets. (The old model could not catch the
fleet-global wake bug because it only modelled reachability, not pass completion.)

`wakeTried` is **per pass**: a wake attempt from an earlier pass can never
satisfy this pass's obligation. Wake is *advisory* — the supervisor never selects
a task for a worker, so the same queued task may be claimable by several
same-role workers; safety comes from the atomic claim plus the fence.

## What is modelled vs abstracted

**Modelled (kept faithful):**

| Concept | Model |
| --- | --- |
| Task lifecycle | `queued`, `running`, `review`, `done`, `blocked_human`, `blocked_internal` |
| Worker lifecycle | `starting`, `idle`, `working`, `waiting_input`, `dead` |
| Generation | per-worker fencing counter, never reused |
| Session | `sessionManaged` + `sessionGen`, the `gateEvent` fence |
| Runtime ownership | `relayOwned` (relay-owned vs adopted), `rtCleaned` |
| Reconcile pass | wake set, quiet expiry, runtime reaping |
| Ownership | single writer per task, fence advanced on every (re)assignment |

**Abstracted away (deliberately not modelled):**

- wall-clock timestamps, jitter, backoff (timeouts are nondeterministic actions);
- UUIDs, SQL rows, DDL, the `relay` CLI;
- message/token payloads (a token is valid or the attach never happens);
- Herdr / OpenCode / the LLM — a nondeterministic environment;
- unbounded retries and generations (bounded so TLC terminates);
- two concurrent supervisors (see the boundary above);
- presentation concerns (dashboard, clustering, affinity, `next:`, colors).

## The state

```
Tasks, Workers        finite sets, e.g. {"t1","t2"}, {"w1","w2"}
Roots                 parent-less tasks (the forest)
Edges                 "parent:child" strings; ChildrenOf/ParentTask derive the tree
Generations  = 0..MaxGeneration     (0 = "no generation")
RealGenerations = 1..MaxGeneration
RoleTask, RoleWorker  optional role gate: RoleTask is claimable only by RoleWorker
AllowFailure          TRUE => the environment may crash / stall / adopt / detach
AllowCooldown         TRUE => a wake may be rate-limited
ReleasesAllowed, RejectsAllowed   strong env assumptions for the Level-D demo
```

| Variable | Meaning |
| --- | --- |
| `stage` | `0` = environment, `1` = a reconcile pass just completed |
| `taskState`, `taskOwner`, `taskVersion`, `reviewed` | lifecycle, owner, claimed-generation fence, "ever entered review" |
| `workerState`, `workerTask`, `generation`, `genOwner` | lifecycle, task held, current generation, generation allowed to mutate |
| `relayOwned`, `sessionGen`, `sessionManaged`, `everAdopted` | runtime ownership and the session fence |
| `hasMail`, `pendingWake`, `wakeSuppressed`, `retryWake`, `wakeTried`, `wakeEligible` | durable signals and wake bookkeeping |
| `quietUntil`, `quietActive` | bounded, task-scoped quiet lease |
| `stallSeen` | a stall was observed |
| `parentDone`, `parentBlocked` | one-hop parent signals |
| `activeRT`, `rtDurable`, `rtCleaned` | runtime durability and reaping |

`taskVersion[t]` is the **generation of the owning claim** (0 when unowned).
`genOwner[w]` is the only generation allowed to mutate for `w`. A stale session
has `sessionGen[w] < generation[w]`, which `NoStaleSession` forbids.

## The actions

`Tick` is an explicit disjunction, so a counterexample reads like a story:

- **Environment:** `Claim`, `Submit`, `AdoptReview`, `Approve`, `Reject`,
  `Release`, `Block`, `Unblock`, `WaitInput`, `TakeInput`, `QuietStart`,
  `QuietExpire`, `Deliver`, `AckMail`, `WakeDelivered`, `WakeFails`, `RetryWake`,
  `RestartOwned`, `Attach`, `StaleAttach`, `Adopt`, `ReviveAdopted`, `Stall`,
  `Crash`, `CooldownExpire`, `Detach`.
- **Supervisor:** `Reconcile` — one atomic pass: `WakeSet(EligibleWakees)`,
  quiet-lease expiry, runtime reaping.

## Formal ↔ TypeScript mapping

The model is *design intent*, but it must stay answerable to the implementation.
This table is the contract: if the intended property and the TypeScript disagree,
decide from the property (and the top-level `README.md`), fix the TypeScript, and
add a unit test — do not bend the TLA to the bug.

| TLA | TypeScript |
| --- | --- |
| `taskState`, `taskOwner`, `taskVersion`, `role` | `src/schema.ts` `tasks` (`state`, `assignee`, `lease_token`, `role`), `src/tasks.ts` |
| `Claim` | `src/tasks.ts` `claimNext` / `claimTask` (`lease_token + 1`, role gate) |
| `Submit` | `src/tasks.ts` `submitTask` (`running → review`) |
| `AdoptReview`, `Approve`, `Reject` | `src/tasks.ts` `claimNext` (reviewer path), `approveTask`, review rejection |
| `Release`, `Block`, `Unblock`, `WaitInput`, `TakeInput` | `src/tasks.ts` `releaseTask`, `blockTask`, `unblockTask`, `waitTask` |
| `QuietStart`, `QuietExpire`, `quietActive`, `quietUntil` | `src/workers.ts` `quietActive`, `grantQuiet`, `clearQuiet` |
| `parentDone`, `parentBlocked`, `ChildDoneSignalled` | `src/tasks.ts` `bubbleChildDone`, `bubbleChildBlocked` |
| `generation`, `genOwner`, `RestartOwned`, `Attach` | `src/runtimes.ts` `nextGeneration`, `recordRuntime`; `src/sessions.ts` `attachSession` |
| `StaleAttach`, `NoStaleSession`, `sessionGen`, `sessionManaged` | `src/sessions.ts` `gateEvent`, `managedWorkerForSession` (stale-generation rejection) |
| `relayOwned`, `ReviveAdopted`, `AdoptedNeverReplaced` | `src/runtimes.ts` `relay_owned`; `src/reconciler.ts` revive-vs-restart branch |
| `rtCleaned`, `CleanupIsRelayOwned`, reaping in `Reconcile` | `src/runtimes.ts` `cleanupCandidates` (`relay_owned = 1`, non-current) |
| `EligibleWakees`, `WakeSet`, `NoAvoidableIdleAtReconcileBoundary` | `src/reconciler.ts` wake loop; `src/scheduler.ts` `needsWorkerWakeup` |
| `wakeSuppressed`, `CooldownExpire` | `src/reconciler.ts` `recentlyWoken` / `tryWake` cooldown |
| `wakeTried`, `WakeDelivered`, `WakeFails`, `retryWake` | `src/reconciler.ts` `tryWake`; durable signal in `src/messages.ts` |
| `deliver`/`hasMail` | `src/messages.ts` `sendMessage` (durable before wake) |
| `RoleEligible`, `NoRoleViolation`, `ClaimableBy` | `src/tasks.ts` `roleMatches`, `roleStrictDefault`, `claimableRunnableTasks`, `unclaimableRunnableTasks` |
| `ActionableWork` | `src/tasks.ts` `runnableTasks`, `reviewTasks` |
| `NoIdleHoldsTask`, `WorkerTaskConsistency` | `src/workers.ts` `normalizeWorkerAfterTaskRelease`, `current_task_id` |
| `DurableBeforeDelivery` | `src/runtimes.ts` `recordRuntime` before `wake`; `src/messages.ts` |

## Safety invariants (Level A)

`RelaySafety.cfg` checks A1–A12 exhaustively (no fairness). The two central ones:

```tla
NoStaleMutation ==
  \A t \in Tasks:
    (taskState[t] = "running") =>
      \E w \in Workers:
        /\ taskOwner[t] = w
        /\ workerTask[w] = t
        /\ genOwner[w] = generation[w]
        /\ genOwner[w] = taskVersion[t]

NoStaleSession ==
  \A w \in Workers:
    (sessionManaged[w] /\ sessionGen[w] # 0) => sessionGen[w] = generation[w]
```

`review` tasks are deliberately *not* covered by `NoStaleMutation`: a dead
reviewer's pointer is reassigned lazily (`claimNext` re-assigns review tasks), so
the pointer may outlive its owner. Mutation of a review task is fenced by
`Approve`/`Reject`'s guards instead.

## Fairness (deliberately minimal)

Fairness is added **only** where a property genuinely needs it, and never to hide
a Relay defect:

| Spec | Fairness | Used for |
| --- | --- | --- |
| `Spec` | none | all Level-A safety |
| `FairSpec` | `WF(Reconcile)`, `WF(CooldownExpire)`, `WF(QuietExpire)`, `WF(RetryWake)` | Level C (`NoPermanentQuiet`, `NoPermanentCooldown`, `NoLostWake`) |
| `CompletionSpec` | `FairSpec` + `WF(Claim)`, `WF(Submit)`, `WF(AdoptReview)`, `WF(Approve)`, `WF(TakeInput)` | Level D demonstration only |

`WF(Reconcile)` is the **only** fairness Relay itself owes: the supervisor loop
keeps running. Everything else in `FairSpec` is a bounded-deadline lapse. Worker
progress (`Claim`, `Submit`, …) is an **environment assumption**, not a Relay
guarantee — which is exactly why `AllTasksDone` is Level D.

## Environment assumptions

Levels A and B assume **nothing** beyond the transition system itself. Levels C
and D add the following, explicitly:

- The transport is eventually up or down; a wake either lands or fails. A failed
  wake leaves the durable signal intact (`pendingWake`) and is retried (C).
- The supervisor loop keeps running: `WF(Reconcile)` (C).
- Workers eventually claim / submit, a reviewer eventually adopts and approves,
  and a permission wait is eventually answered (`CompletionSpec` only) (D).
- **Completion additionally sets `RejectsAllowed = FALSE` and
  `ReleasesAllowed = FALSE`** — i.e. it assumes reviews are never rejected and
  workers never abandon a task. Without those, a worker can `Release` or reject
  forever and the fleet legitimately never drains. This is exactly why
  `AllTasksDone` is Level D, not a Relay guarantee.
- A crash / stall / detach happens at most `MaxGeneration` times per worker
  (bounded so TLC terminates).
- No concurrent supervisor (implementation boundary).

## Mutation matrix

A green TLC run proves the properties hold for the spec. It says **nothing**
about whether the spec is strong enough to catch the bugs it exists to catch.
`formal/run-mutations.sh` mutates one **action** at a time and asserts each mutant
is refuted. A mutation never weakens an invariant; a surviving mutant means the
model has a hole.

| # | Mutation | Refuted by |
| --- | --- | --- |
| M1 | fleet-global wake guard (`no wake while anyone works`) | `NoAvoidableIdleAtReconcileBoundary` |
| M2 | wake only the first eligible candidate | `NoAvoidableIdleAtReconcileBoundary` |
| M3 | `Claim` ignores role eligibility | `NoRoleViolation` |
| M4 | `QuietExpire` disabled (quiet never lapses) | `NoPermanentQuiet` (liveness) |
| M5 | `Crash` leaves the quiet lease behind | `QuietScoped` |
| M6 | `Requeue` keeps the old owner pointer | `QueuedHasNoOwner` |
| M7 | `StaleAttach` accepts an older generation | `NoStaleSession` |
| M8 | reaping drops the relay-owned guard | `CleanupIsRelayOwned` |
| M9 | `ReviveAdopted` takes over an adopted runtime | `AdoptedNeverReplaced` |
| M10 | `Approve` records the child but not the parent signal | `ChildDoneSignalled` |
| M11 | `Approve` bubbles recursively to the grandparent | `ParentSignalsOneHop` |
| M12 | `Submit` writes `done` directly | `DoneRequiresReview` |

Run it with `formal/run-mutations.sh` (exits non-zero if any mutant survives).

## How to run

```sh
formal/run-tlc.sh RelaySafety       # A1–A12, exhaustive, no fairness
formal/run-tlc.sh RelayScheduling   # B1–B2, the reconcile-boundary obligation
formal/run-tlc.sh RelayRecovery     # recovery + fencing under failure
formal/run-tlc.sh RelayLiveness     # C1–C3 under FairSpec
formal/run-tlc.sh RelayCompletion   # D1 demonstration (NOT a guarantee)
formal/run-mutations.sh             # M1–M12: every mutant must be refuted
```

or via package scripts: `bun run formal:safety`, `formal:scheduling`,
`formal:recovery`, `formal:liveness`, `formal:completion`.

The TLA+ tools are downloaded on first use into `formal/.tools/` (gitignored). No
JAR is committed.

## How to read a counterexample

TLC prints a numbered behaviour; each state names the action that produced it and
the changed variables. The interesting part is usually the *first* state where a
precondition that should have held did not — e.g. for `M1` the pass at
`Reconcile` where `w1` is working, `w2` is idle with claimable work, and
`wakeTried[w2]` is still `FALSE`.

## Files

| File | Purpose |
| --- | --- |
| `Relay.tla` | the model (state, actions, invariants, temporal properties, fairness) |
| `RelaySafety.cfg` | Level A — all safety invariants, exhaustive |
| `RelayScheduling.cfg` | Level B — the reconcile-boundary obligation |
| `RelayRecovery.cfg` | recovery + fencing under failure |
| `RelayLiveness.cfg` | Level C — bounded suppression under `FairSpec` |
| `RelayCompletion.cfg` | Level D — `AllTasksDone` demonstration (not a guarantee) |
| `run-tlc.sh` | run one config |
| `run-mutations.sh` | the M1–M12 counterexample-quality check |
| `states/` | TLC scratch (gitignored) |

`Relay.cfg`, `RelayFailures.cfg`, `RelayDone.cfg` are kept only as thin
compatibility aliases; new work should use the named configs above.
