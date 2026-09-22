# Relay formal model (TLA+ / TLC)

`formal/Relay.tla` is a small, finite TLA+ model of Relay's **control plane**.
It is not a transcription of `src/`. It is the design intent of Relay — *what the
control plane must guarantee* — written so TLC can **break it**. Read this file
first; the model exists to produce counterexamples against the properties below.

> **Model ≠ implementation proof.** TLC explores a finite abstraction of the
> *orchestration logic*. It does not execute the TypeScript, SQLite, Herdr, or
> OpenCode. A green run means "no counterexample inside this abstraction", not
> "the implementation is correct".

---

## What Relay must guarantee

Relay is a supervisor for a fleet of agent workers. Its job is to keep durable
work moving *without ever corrupting ownership*.

### A. Relay safety — must hold in every execution, with NO fairness

| # | Guarantee | Invariant |
| --- | --- | --- |
| A1 | A task has at most one owner; ownership is cleared on every transition out of `running`/`review`. | `AtMostOneOwner`, `OwnerConsistent`, `QueuedHasNoOwner` |
| A2 | Claiming a queued task is role-gated. **Review capability is a separate axis** — whoever *holds* a review task must be a reviewer (the review *assignee* may be the submitter until adopted). | `NoClaimRoleViolation`, `ReviewOwnerIsReviewer` |
| A3 | **The three fences.** A normal progress mutation requires the task's current **lease**, the owner's current **generation**, and the owner's current managed-**session** generation to agree. | `LeaseFenceAgreement`, `GenerationFenceAgreement`, `SessionFenceAgreement` |
| A4 | A running task's owner is live, holds it, and its session carries the winning lease + generation. | `NoStaleMutation` |
| A5 | Generations never move backwards and are never reused. | `GenerationMonotonicity` |
| A6 | **`done` is reachable only through `Approve`.** `session.idle`, quiet, a crash, a rejection, or a child's completion are never completion. | `DoneOnlyByApprove` |
| A7 | A quiet lease is task-scoped, bounded, and only while the worker is working. | `QuietScoped` |
| A8 | A permission wait is *occupied*: it keeps its task and takes no new work. | `NoWaitingInputClaim`, `WaitingInputOccupancy` |
| A9 | Nothing is activated or started before its durable row exists. | `DurableBeforeDelivery` |
| A10 | Relay reaps only runtimes it owns, never the current generation. | `CleanupIsRelayOwned` |
| A11 | An adopted (externally-owned) runtime is never taken over by Relay. | `AdoptedNeverReplaced` |
| A12 | Child completion/blocking produces a durable one-hop parent signal, atomically with the child's state change. **A child's transition never changes the parent's task state** (action semantics). | `ChildDoneSignalled`, `ChildBlockedSignalled`, `ParentSignalsOneHop`, `ParentStateStableByChildTransition` |
| A13 | A detached or retired worker is never operational and creates no wake obligation. | `DetachedNotOperational` |
| A14 | At a reconcile boundary a dead transport is classified dead, **even for a quiet worker** (quiet suppresses *stall* suspicion, never transport death). | `DeadTransportClassified` |

### B. Relay responsiveness — what Relay owes while the world keeps moving

> **Central property.** *If an operational idle worker can take useful durable
> work now, a reconcile pass must not ignore that capacity merely because some
> unrelated worker is busy.*

| # | Guarantee | Property |
| --- | --- | --- |
| B1 | At a reconcile boundary, every operational idle worker that can take claimable work, and has no legitimate temporary excuse, was woken this pass. | `NoAvoidableIdleAtReconcileBoundary` |
| B2 | Relay never wakes a worker for work it cannot claim (role-ineligible). The snapshot is taken at the moment of the attempt. | `NoWakeForUnclaimableWork` |

### C. Environment-assumption liveness

| # | Guarantee | Property / assumption |
| --- | --- | --- |
| C1 | A wake cooldown is *bounded*. | `NoPermanentCooldown` (needs `WF(Reconcile)`, `WF(CooldownExpire)`) |
| C2 | A quiet lease is *bounded*. | `NoPermanentQuiet` (needs `WF(Reconcile)`, `WF(QuietExpire)`) |
| C3 | A durable wake is never lost. | `NoLostWake` |
| C4 | A wake **failure never erases the durable pending signal**. | `WakeFailureKeepsSignal` |

### D. Explicitly NOT guaranteed

| # | Not guaranteed | Why |
| --- | --- | --- |
| D1 | **`AllTasksDone`.** | If the environment never acts, work legitimately stays queued. Kept as a demonstration under strong assumptions in `RelayCompletion.cfg`; **not a Relay guarantee**. |
| D2 | Completion of *unclaimable* work (no registered worker of the role). | Relay cannot invent a worker. Visible, not a liveness violation. |
| D3 | `NoPermanentStranding` under `FairSpec` alone. | Worker progress is an environment assumption. |
| D4 | Correctness under two concurrent supervisors. | Excluded by the implementation boundary. |
| D5 | Planner low-water wake, dashboard/affinity, formatting, git KPI. | Presentation concerns. |

---

## The three fences

Relay fences a task against three **distinct** things, which the model keeps
separate (a single combined counter cannot express a same-generation stale claim):

| Fence | Model | Implementation |
| --- | --- | --- |
| **Task lease** | `taskLease[t]` (monotone per-task token), `lastLease[t]`, `workerLease[w]`, `staleLease[w]` | `tasks.lease_token` (`+1` on every change); `submitTask`'s `leaseToken` check |
| **Runtime generation** | `generation[w]`, `genWatermark[w]`, `genOwner[w]`, `taskGen[t]` | `worker_runtimes.generation` / `nextGeneration()` |
| **Session generation** | `sessionGen[w]`, `sessionManaged[w]` | `sessions.managed` + `sessions.generation`, `gateEvent`'s stale-generation rejection |

A normal progress mutation (`Submit`, `OwnerRelease`) requires all three to
agree — see `CanProgress`. A **same-generation stale claim** is representable:
`StaleSubmit` models a leftover session presenting an old lease
(`staleLease[w]`), which a correct Relay rejects because
`staleLease[w] # taskLease[t]` after any reclaim.

## Operational / Recoverable / Supervised

`IdleOperational` is not merely `idle`; it mirrors `scheduler.ts`:

```
Operational(w)  = not detached, not retired, and
                  (managed session  OR  relay-owned starting runtime)
Recoverable(w)  = not operational, not detached/retired, relay-owned, dead/stalled
Supervised(w)   = Operational(w) or Recoverable(w)
IdleOperational = Operational(w) and idle and holding no task
```

A detached/retired/unmanaged worker therefore has **no wake obligation** (A13),
even when claimable work exists. An adopted runtime can be `Operational` (a
managed session) while `relayOwned = FALSE` — the two axes are not mixed.

## Recovery release vs normal mutation

- **`OwnerRelease(w, t)`** — the current owner releases its own running task
  (all fences must agree).
- **`RecoveryRelease(actor, t)`** — an external actor (operator/supervisor)
  revokes a running task. It may **only** invalidate ownership and requeue; it can
  never advance the task to `review`/`done`/`blocked`.

`blockTask` / `approveTask` / `rejectTask` are **operator-permitted** in the
implementation (they do not fence on owner). The model follows the code here and
records it: `Block`/`Approve`/`Reject` require the state, not ownership. This is
an audited divergence candidate, not a formal obligation.

## The reconcile boundary

A two-stage tick: **environment** actions (`stage = 0`), then one atomic
**`Reconcile`** pass (`stage = 1`) that wakes eligible workers, classifies dead
transports, and reaps runtimes. `NoAvoidableIdleAtReconcileBoundary` and
`DeadTransportClassified` are asserted at `stage = 1`, which makes scheduling and
detection obligations checkable at a well-defined boundary.

## Formal ↔ TypeScript mapping

| TLA | TypeScript |
| --- | --- |
| `taskLease`, `workerLease`, `staleLease`, `lastLease` | `tasks.lease_token`; `submitTask`'s `leaseToken`; `releaseTask`'s `lease_token + 1` |
| `generation`, `genWatermark`, `taskGen` | `src/runtimes.ts` `nextGeneration`, `maxRuntimeGeneration` |
| `sessionGen`, `sessionManaged`, `StaleAttach` | `src/sessions.ts` `gateEvent`, `managedWorkerForSession` |
| `Operational`, `Recoverable`, `Supervised` | `src/scheduler.ts` `isOperationalWorker`, `isRecoverableWorker`, `isSupervisedWorker` |
| `detached`, `retired` | `workers.retired_at`; detach removes the managed session |
| `transportAlive`, `DeadSet` | `rt.isAlive`; the reconciler's dead classification |
| `OwnerRelease` / `RecoveryRelease` | `src/tasks.ts` `releaseTask` (owner + recovery caller) |
| `Block`, `Approve`, `Reject` | `src/tasks.ts` `blockTask`, `approveTask`, `rejectTask` (operator-permitted) |
| `AdoptReview`, `CanReview`, `ReviewOwnerIsReviewer` | `src/tasks.ts` `claimNext` reviewer path; `ReviewerWorkers` ~ reviewer role |
| `RoleEligible`, `NoClaimRoleViolation` | `src/tasks.ts` `roleMatches`, `roleStrictDefault`, `claimableRunnableTasks` |
| `approved`, `DoneOnlyByApprove` | `approveTask` is the only path to `done` |
| `parentDone`, `parentBlocked`, `ChildDoneSignalled` | `bubbleChildDone`, `bubbleChildBlocked` (one-hop) |
| `relayOwned`, `Adopt`, `ReviveAdopted` | `worker_runtimes.relay_owned`; the revive-vs-restart branch |
| `rtCleaned`, `CleanupIsRelayOwned` | `src/runtimes.ts` `cleanupCandidates` |

## Mutation matrix

`formal/run-mutations.sh` mutates one **action** at a time and asserts, for each:
(1) the **baseline** spec + the exact same config PASSES, (2) the mutant FAILS,
(3) it fails by the **specifically expected** property. A mutation never changes
an invariant. A red baseline invalidates the test; a surviving mutant is a model
hole.

| # | Mutation (action) | Expected refutation |
| --- | --- | --- |
| M1 | fleet-global wake guard | `NoAvoidableIdleAtReconcileBoundary` |
| M2 | wake only the first candidate | `NoAvoidableIdleAtReconcileBoundary` |
| M3 | `Claim` ignores role eligibility | `NoClaimRoleViolation` |
| M4 | `QuietExpire` disabled | `NoPermanentQuiet` |
| M5 | dead classification leaves the quiet lease | `QuietScoped` |
| M6 | `Requeue` keeps the owner pointer | `QueuedHasNoOwner` |
| M7 | `StaleAttach` accepts an older generation | `SessionFenceAgreement` |
| M8 | reaping drops the relay-owned guard | `CleanupIsRelayOwned` |
| M9 | `ReviveAdopted` takes over an adopted runtime | `AdoptedNeverReplaced` |
| M10 | `Approve` omits the parent signal | `ChildDoneSignalled` |
| M11 | `Approve` bubbles recursively | `ParentSignalsOneHop` |
| M12 | `Submit` writes `done` | `DoneOnlyByApprove` |
| M13 | `StaleSubmit` accepts a stale lease | `LeaseFenceAgreement` |
| M14 | `IdleOperational` ignores `Operational` | `DetachedNotOperational` |
| M15 | `RestartOwned` reuses/rewinds a generation | `GenerationMonotonicity` |
| M16 | `Approve` mutates the parent's task state | `ParentStateStableByChildTransition` |
| M17 | dead classification suppressed while quiet | `DeadTransportClassified` |
| M18 | a wake failure erases the durable signal | `WakeFailureKeepsSignal` |
| M19 | `Reject` goes straight to `done` | `DoneOnlyByApprove` |
| M20 | `AdoptReview` ignores review capability | `ReviewOwnerIsReviewer` |

Which mutations prove each important property is **non-vacuous**: A3 lease ←
M13; A4 ← M6/M7; A5 ← M15; A6 ← M12/M19; A7 ← M5; A11 ← M9; A12 ←
M10/M11/M16; A13 ← M14; A14 ← M17; B1 ← M1/M2; C2 ← M4; C4 ← M18; review
capability ← M20; C4 ← M18.

## Intentional abstractions (not modelled)

- **Lease expiry by wall clock.** The implementation only requeues a task when
  its lease lapsed *and* the owner is missing/dead/stalled. The model abstracts
  time away; liveness of an expired-but-live lease is not modelled.
- **`SYSTEM_WAITING_FOR_HUMAN`.** A global "all unfinished tasks are
  blocked_human" condition is not modelled; `blocked_human` ownership is.
- **Free-form `APPROVE` notes.** Note text is outside the model; only the
  durable task state transition matters.
- Message payloads, UUIDs, SQL, Herdr/OpenCode, two concurrent supervisors.

## Fairness

| Spec | Fairness | Used for |
| --- | --- | --- |
| `Spec` | none | all Level-A safety |
| `FairSpec` | `WF(Reconcile)`, `WF(CooldownExpire)`, `WF(QuietExpire)`, `WF(RetryWake)` | Level C |
| `CompletionSpec` | `FairSpec` + `WF(Claim/Submit/AdoptReview/Approve/TakeInput)` | Level D demo |

`WF(Reconcile)` is the only fairness Relay itself owes. Worker progress is an
environment assumption.

## How to run

```sh
formal/run-tlc.sh RelaySafety       # A1–A12
formal/run-tlc.sh RelayScheduling   # B1–B2
formal/run-tlc.sh RelayRoles        # claim role vs review capability
formal/run-tlc.sh RelayTree         # one-hop parent signalling (P -> C -> G)
formal/run-tlc.sh RelayRecovery     # crash/restart/adopt, all three fences
formal/run-tlc.sh RelayLiveness     # C1–C3
formal/run-tlc.sh RelayCompletion   # D1 demonstration (NOT a guarantee)
formal/run-mutations.sh             # baseline PASS + mutant refuted by the expected property
```

Package scripts: `formal:safety`, `formal:scheduling`, `formal:roles`,
`formal:tree`, `formal:recovery`, `formal:liveness`, `formal:completion`,
`formal:mutations`.

## Files

| File | Purpose |
| --- | --- |
| `Relay.tla` | the model |
| `RelaySafety.cfg` | Level A |
| `RelayScheduling.cfg` | Level B |
| `RelayRoles.cfg` | claim role vs review capability |
| `RelayTree.cfg` | non-vacuous parent-signal tree |
| `RelayRecovery.cfg` | recovery + all three fences |
| `RelayLiveness.cfg` | Level C |
| `RelayCompletion.cfg` | Level D demonstration |
| `run-tlc.sh`, `run-mutations.sh` | runners |

`Relay.cfg` / `RelayFailures.cfg` / `RelayDone.cfg` are compatibility aliases.
