# Relay formal model (TLA+ / TLC)

This directory contains a small, finite TLA+ model of Relay's **control plane**
(`formal/Relay.tla`). Its job is not to produce a green checkmark: it exists to
search for executions where Relay *permanently stops moving work even though
runnable work exists*, and to act as a counterexample-driven test harness for the
event-ordering and recovery bugs that Relay has historically had (see
[Historical bugs and mutations](#historical-bugs-and-mutations)).

> **Model ≠ implementation proof.** TLC explores a finite abstraction of the
> *orchestration logic*. It does not execute the TypeScript, SQLite, Herdr, or
> OpenCode. A green run means "no counterexample inside this abstraction", not
> "the implementation is correct". See
> [What is modelled vs abstracted](#what-is-modelled-vs-abstracted).

---

## Implementation boundary (single supervisor)

```text
Implementation boundary assumption:
exactly one Relay supervisor process holds the dedicated SQLite supervisor lock
for a physical/canonical control-plane DB at a time.
```

The TLA+ model does not model two concurrent supervisor processes racing through
the same SQLite DB / Herdr workspace. The implementation enforces the
single-supervisor assumption at daemon startup (a long-lived `BEGIN IMMEDIATE`
transaction on the dedicated lock DB `<canonical-db>.relay-lock.db`, plus a
non-destructive `.relay/relay.sock` ownership probe; see the top-level
`README.md` §"Single-supervisor invariant"). Because the boundary excludes
concurrent daemons, generation allocation in the implementation stays
process-local (`restartingWorkers` + a commit-time generation re-check); the model
needs **no** generation reservation table, distributed lock, or leader election,
and none is added.

This assumption is not hidden — it is the reason the model has a single implicit
supervisor. See [Historical bugs and mutations](#historical-bugs-and-mutations)
for why a multi-daemon race is deliberately *not* a TLA+ mutation.

---

## Why a TLA+ model at all

Relay's core promise (from the top-level `README.md`) is a loop invariant:

```text
if runnable_tasks > 0 and working_workers == 0:
    wake_or_start_some_worker()
```

The interesting failures are **ordering and recovery** failures across many
components at once:

- a durable runtime row must be committed **before** a worker is woken with a
  bootstrap prompt (otherwise a fresh agent runs without a persisted binding);
- a fresh restart must allocate a **strictly greater** generation, or a stale
  session can mutate the current worker;
- an attach **timeout** must not be confused with a **detach**: a relay-owned
  failed generation must stay recoverable;
- a detached worker must be permanently removed from supervision;
- a permission wait is *occupied*, not idle;
- an `idle` event is **not** task completion.

These are exactly the kind of properties where unit tests only cover the cases
you thought of. TLC does an exhaustive breadth-first search of all interleavings
in a bounded state space, so it finds the interleaving you did not think of.

## What is modelled vs abstracted

**Modelled (kept faithful to the TypeScript names and behaviour):**

| Concept | Model |
| --- | --- |
| Task lifecycle | `queued`, `running`, `review`, `done`, `blocked_human`, `blocked_internal`, `failed` |
| Worker lifecycle | `starting`, `idle`, `working`, `waiting_input`, `stalled`, `dead` |
| Runtime generation | `none`, `starting`, `active`, `stale`, `dead`, `cleaned` |
| Session | managed / unmanaged, with a fencing `generation` |
| Supervisor | wake, claim, submit, review, requeue, restart, bootstrap, attach, cleanup |
| Ownership | single writer per task, fence token bumped on every (re)assignment |
| Detach | permanent removal from supervision |

**Abstracted away (deliberately not modelled):**

- timestamps, cooldowns, jitter, retry backoff (timeouts are nondeterministic
  actions);
- UUIDs, SQL rows, DDL, `relay` CLI plumbing;
- message/token payloads (we assume a bootstrap token is either valid or the
  attach never happens);
- Herdr and OpenCode themselves, and the LLM. They are a **nondeterministic
  environment**: a worker may progress, ask permission, block internally, crash,
  stall, or finish a turn at any time;
- unbounded retries and unbounded generations (both are bounded so TLC can
  terminate; see [Environment assumptions](#environment-assumptions));
- **two concurrent supervisor processes** on one control-plane DB / Herdr
  workspace. This is outside the model by the
  [implementation boundary](#implementation-boundary-single-supervisor) above.

## The state

```
Tasks, Workers            finite sets, e.g. {t1,t2}, {w1,w2}
Gen      = 0..MaxGeneration          (0 = "no generation")
Runtimes = Workers \X Gen
```

Variables (all functions / relations, see `Relay.tla`):

| Variable | Meaning |
| --- | --- |
| `taskState`, `taskOwner`, `taskLease`, `taskReviewed` | task lifecycle, current owner, fence token, "went through review" (so `done` can require review) |
| `workerState`, `workerTask`, `workerGeneration`, `workerLease`, `workerWoken` | worker lifecycle, task held, current generation, fence token, "was nudged" |
| `permissionPending` | a permission request is outstanding |
| `detached` | worker was explicitly detached (permanent) |
| `failureCount` | shared per-worker count (0..`FailureBudget`) of environment failures consumed (crash / stall / attach timeout / internal block) |
| `sessionManaged`, `sessionGeneration` | whether a managed session is bound, and at which generation |
| `runtimeState`, `runtimePersisted`, `runtimeRelayOwned`, `runtimeBootstrapSent` | per-`(worker,generation)` runtime record |
| `genWatermark` | highest generation ever allocated for a worker |
| `genAtPrev` | history variable: `workerGeneration` in the previous state, used to check monotonicity |

`genWatermark` is the model of `nextGeneration()` (`src/runtimes.ts`) returning
`max(current, session, maxRuntimeGeneration) + 1`: a generation is never reused.

## The control-plane actions

`Next` is an explicit disjunction of named actions so a counterexample reads like
a story. The spawn path is deliberately split so the durable-before-wake ordering
is checkable:

| Action | Role |
| --- | --- |
| `SpawnTransport(w)` | create a fresh generation's process (not durable yet) |
| `PersistRuntime(w)` | **durable commit**: runtime row exists and the worker points at it, *before* any wake |
| `BootstrapDelivered(w)` / `BootstrapFailed(w)` | deliver the bootstrap prompt (requires persisted runtime); failure is a stutter/retry |
| `Attach(w)` | managed attach (requires persisted + relay-owned + bootstrap sent) |
| `AttachTimeout(w)` | a generation that never attaches transitions to `dead` but **stays relay-owned** (recoverable); consumes one unit of the failure budget |
| `ManualAttach(w)` | adopt an existing session (`relay_owned = FALSE`, never closed by Relay) |
| `Detach(w)` | permanent removal from supervision (rejected for a busy worker) |
| `MarkStale(w)`, `DetectDead(w)` | failed generation becomes `stale` / `dead` |
| `Cleanup(w,g)` | reap an **old**, relay-owned, `stale`/`dead` generation (never current, never non-relay-owned) |
| `Wake(w)` | the core loop invariant: runnable work + idle operational worker ⇒ nudge |
| `Claim(w)` | single-writer claim of a `queued` task with a fresh fence token |
| `Progress(w)` | heartbeat (stutters; never touches task state) |
| `Submit(w)`, `BlockHuman(w)`, `BlockInternal(w)`, `Fail(w)` | end a turn; each verifies owner + fence token |
| `PermissionAsked(w)`, `PermissionReplied(w)` | `working → waiting_input → working/idle` |
| `IdleSignal(w)` | `session.idle`; **never** completion |
| `Crash(w)`, `DetectStall(w)` | environment failures (each consumes one unit of the shared `failureCount < FailureBudget` budget) |
| `Requeue(w)` | release a failed worker's task back to `queued` with a new fence token |
| `Approve(t)`, `Reject(t)`, `RetryInternal(t)`, `UnblockHuman(t)` | review / human / internal-block environment |
| `WorkerDecision(w)` | combined worker decision (`Submit` / `BlockHuman` / `BlockInternal` / `Fail`) — the unit of worker fairness |
| `ReviewDecision(t)` | combined reviewer decision (`Approve` / `Reject`) — the unit of review fairness |

## Safety invariants

`formal/Relay.cfg` checks these in **all** behaviours (no fairness):

| Invariant | What it rules out |
| --- | --- |
| `TypeOK` | malformed states (also forces `runtimeState[w,0] = "none"`) |
| `SingleTaskOwner` | a worker holding a task that is not its owner |
| `WorkerTaskConsistency` | `working`/`waiting_input` without a task; holding a non-`running` task; idle with a task |
| `RunningTaskHasOwner` | a `running` task with no owner, or an owner on a non-`running` task |
| `NoWaitingInputClaim` | a `waiting_input` worker being woken/claimed over (the wait is *occupied*) |
| `DetachedNotOperational` | a detached worker still operational/recoverable/supervised |
| `GenerationMonotonicity` | a worker generation moving backwards |
| `CurrentRuntimeNeverCleaned` | cleaning the current generation |
| `NonRelayOwnedNeverCleaned` | Relay closing an adopted (manual) runtime |
| `StaleSessionCannotMutateCurrent` | a managed session whose generation ≠ the worker's current generation |
| `AttachRequiresPersistedRuntime` | attaching without a durable runtime row |
| `BootstrapRequiresPersistedRuntime` | delivering bootstrap before the durable commit |
| `AttachTimeoutStaysSupervised` | an attach timeout dropping a relay-owned failed generation out of supervision |
| `DoneRequiresReview` | `idle`/`session.idle` counting as completion |
| `QuiescenceIsLegitimate` | runnable work + nobody working, with no legitimate reason |
| `QuiescenceCoversReview` | the same for tasks sitting in `review` |

`formal/RelayFailures.cfg` re-checks the same invariants on a deliberately small
instance (`Tasks = {t1}`, `Workers = {w1}`, `FailureBudget = 2`) so TLC can
explore **≥2 sequential failures of different kinds** — e.g.
`working → crash → requeue → fresh generation → attach → working → stall →
requeue → fresh generation`, `fresh generation → attach timeout → recover → later
crash`, or `running → blocked_internal → retry → claim → crash`. The main safety
model exhaustively checks its bounded failure abstraction; `RelayFailures.cfg`
widens that abstraction to multiple sequential failures. (Wording is deliberate: a
green `Relay.cfg` does not mean "no safety bug is hidden anywhere else".)

`QuiescenceIsLegitimate` is the machine-checked form of the top-level invariant:

```tla
QuiescenceIsLegitimate ==
  (RunnableExists /\ ~WorkerWorking)
  => ( ~HasSupervised          \* nobody left to supervise
       \/ RecoveryInProgress   \* a fresh generation is in flight
       \/ IdleOperational      \* a wakeable idle worker exists
       \/ \E w: Supervised(w) /\ workerState[w] = "waiting_input" )
```

The last disjunct is important: a worker parked on a **permission wait** is
occupied, so "nobody working" is legitimate. That is the abstraction of
`systemStatus() == WAITING_FOR_HUMAN` in `src/scheduler.ts`.

## Liveness properties and fairness

Safety only proves "never enters a bad state". Liveness proves work is not
permanently abandoned. `formal/RelayLiveness.cfg` uses `SpecFair = Spec /\ Fairness`
and checks:

```tla
RunnableEventuallyMoves ==
  []( (RunnableExists /\ HasSupervised /\ ~HumanOnlyWaiting)
      => <>( WorkerWorking \/ ~RunnableExists \/ HumanOnlyWaiting \/ ~HasSupervised ) )

TaskProgress ==
  []( (HasSupervised /\ \E t: taskState[t] \in {"running","review"})
      => <>( ~HasSupervised
              \/ (\A t: taskState[t] \notin {"running","review"}) ) )
```

- **Property A — `RunnableEventuallyMoves`** is Relay's own obligation: while it
  supervises a worker and runnable work exists, some worker eventually works.
- **Property B — `TaskProgress`** is the worker/reviewer-fairness obligation: a
  task never stalls forever inside a **live decision state** (`running` waiting on
  the worker, `review` waiting on the reviewer). The *outcome* is deliberately
  nondeterministic — the environment may keep rejecting or re-blocking — so we do
  **not** claim "eventually terminal" here. `blocked_internal` is not terminal, and
  a task can loop `review → queued → running → review` forever if a reviewer keeps
  rejecting. The stronger "all tasks eventually `done`" claim is Property C only.

### Fairness assumptions

`SpecFair = Spec /\ Fairness`. The environment assumption is only that an agent
that *can* decide does not stutter forever — **not** that each outcome occurs. So
fairness is attached to *decisions*, not to outcomes:

| Assumption | Why |
| --- | --- |
| `WF(SpawnTransport)`, `WF(PersistRuntime)`, `WF(BootstrapDelivered)`, `WF(Attach)` | transport can always eventually perform an enabled recovery |
| `WF(Wake)`, `WF(Claim)` | an enabled wake/claim is eventually taken |
| `WF(Requeue)`, `WF(MarkStale)`, `WF(DetectDead)` | crash recovery is not starved |
| `WF(PermissionReplied)` | a permission request is eventually answered (environment assumption — see below) |
| `SF(WorkerDecision(w))` | a working worker eventually ends its turn instead of stuttering forever. It may `Submit`, `BlockHuman`, `BlockInternal`, or `Fail`; **no single outcome is forced** |
| `SF(ReviewDecision(t))` | a review is never ignored forever. It may `Approve` or `Reject`; the choice stays nondeterministic |
| `WF(RetryInternal)`, `WF(UnblockHuman)` | internal retries and human unblocks are eventual |

This is deliberately weaker than per-outcome fairness: we do **not** require
`Submit` and `BlockHuman` and `BlockInternal` each to happen, only that the worker
does not stutter. Likewise `Approve` is not forced in normal liveness.

> **Permission fairness.** Relay cannot force the user/host to answer a permission
> request. `WF(PermissionReplied)` is an explicit environment assumption used
> **only** for liveness; the safety config needs no fairness at all.

### Why the `~HasSupervised` escape hatch

`Detach` is a legitimate, **permanent** environment action (a human removes a
worker from supervision). If the environment detaches *every* worker while work
is still queued, Relay is no longer responsible for anyone, so the liveness
conclusions allow `~HasSupervised`. Without that escape the liveness properties
are false, and the counterexample is precisely "all supervised workers were
detached" — which is intended behaviour, not a bug.

## Environment assumptions

These are the assumptions under which the liveness properties hold. They are
modelling assumptions, stated explicitly rather than hidden inside fairness:

1. **Failures are finite per worker.** `Crash`, `DetectStall`, `AttachTimeout`,
   and `BlockInternal` share one counter `failureCount[w]`, bounded by the
   constant `FailureBudget`. This is a *liveness* device: it stops the
   environment from consuming the finite generation budget with infinitely many
   failures. `Relay.cfg` / `RelayLiveness.cfg` / `RelayDone.cfg` use
   `FailureBudget = 1`; `RelayFailures.cfg` uses `2` to explore ≥2 sequential
   failures. Safety is checked with the same bound, so it cannot hide a safety
   bug.
2. **Internal blocks are finite.** `BlockInternal` consumes the same budget (a
   worker cannot block internally forever), while `RetryInternal` is always
   enabled. So a `blocked_internal` task is always retryable and, once the
   failure budget is spent, must be submitted / blocked on a human / failed.
3. **Generations are finite but never reused.** `genWatermark` only increases and
   `NextGen = genWatermark + 1`; TLC's `MaxGeneration` is a size bound, not a
   semantic one.
4. **Human actions are eventual but not guaranteed.** `UnblockHuman` and
   `PermissionReplied` are fair. Relay cannot force a human, so a task blocked on
   a human is treated as *terminal*; `Approve` is **not** assumed under normal
   liveness (Property A/B) — only Property C assumes eventual approval.
5. **Detach is optional.** The constant `AllowDetach` gates `Detach(w)`. It is
   `TRUE` for safety and liveness (a human *may* detach a worker — hence the
   `~HasSupervised` escape above), and `FALSE` for Property C, which assumes no
   worker is permanently removed from supervision.
6. **The worker pool is fixed.** Relay guarantees progress *within the
   registered/supervised worker pool*. It does not promise elastic worker
   creation merely because all workers are waiting on input (that design is
   unchanged; auto-scaling is not part of the spec).

`formal/RelayDone.cfg` uses `SpecDone = Spec /\ StrongFairness` and additionally
sets `AllowFailure = FALSE` / `AllowDetach = FALSE`. It checks the stronger
property:

```tla
AllTasksDone == <>(\A t: taskState[t] = "done")
```

`StrongFairness` is the **only** place eventual approval is assumed: it adds
`SF(Approve(t))` (plus `SF(Submit)` / `SF(BlockInternal)`) on top of the normal
weak supervisor fairness. It is deliberately **not** mixed into
`RelayLiveness.cfg`.

> **This is conditional.** It holds only because we additionally assume no task
> failure, no permanent detach, no permanent human block, and
> human/permission/review eventualness. Relay alone cannot guarantee arbitrary
> LLM work succeeds (or that a human ever responds). It is documented here to
> make the assumption explicit, not to claim success is guaranteed.

## How to run

```sh
# Safety: all behaviours, no fairness (exhaustive).
bun run formal

# Liveness: Property A + B under the fairness above.
bun run formal:liveness

# Optional Property C (stronger environment assumptions).
bun run formal:done

# Safety widened to >=2 sequential failures.
bun run formal:failures
```

The scripts call `formal/run-tlc.sh`, which downloads `tla2tools.jar` into the
gitignored `formal/.tools/` on first use. **No JAR is committed.** TLC needs a
JDK 11+ (`java` on `PATH`); model-check output goes to the gitignored
`formal/states/`.

Manual invocation (equivalent):

```sh
formal/run-tlc.sh Relay           # or RelayLiveness / RelayDone / RelayFailures
```

The model is intentionally tiny: `Tasks = {t1,t2}`, `Workers = {w1,w2}`,
`MaxGeneration = 3`, `LeaseMax = 1`. Bump these in the `.cfg` files to widen the
search (expect the state space to grow quickly).

`MaxGeneration = 3` is the model bound; with `FailureBudget = 1` generation 3 is
**unreachable** because each worker can fail at most once, so every recovery path
uses generation 1 or 2. The safety config is exhaustive over the full
2-task × 2-worker instance. `RelayFailures.cfg` uses `FailureBudget = 2` on a
1-task instance, where generation 3 *is* reachable across two sequential
failures. The liveness and Property-C configs use a 1-task instance
(`Tasks = {t1}`) because TLC's temporal-property check is much more expensive than
safety and the 2-task graph is ~10× larger.

## How to read a counterexample

TLC prints a behaviour (a sequence of states, ending in `Stuttering`). Read it
top-to-bottom, tracking `taskState`, `workerState`, `workerGeneration`,
`sessionManaged`/`sessionGeneration`, `detached`, and `runtimeState`. A liveness
failure is a **lasso**: the suffix from some state repeats forever, so look for
the state that recurs.

Worked example (a real bug that this model caught *in an earlier draft of the
model itself*): `PersistRuntime` lacked a `~detached[w]` guard. The trace showed
`detached[w2] = TRUE` and `workerGeneration` going `2 → 1`, i.e. a leftover
in-flight `starting` generation resurrected a detached worker and then
`AttachTimeout` kept it relay-owned forever — so `HasSupervised` stayed true but
no progress could ever happen. The fix is in the spec: the entire spawn /
persist / bootstrap / attach chain is guarded by `~detached[w]`. This is the
model failing its own "detach is permanent" invariant (`DetachedNotOperational`),
which is exactly the class of bug the model is meant to surface.

## Historical bugs and mutations

These are the real event-ordering / recovery bug classes Relay has had. Each is
a small mutation of `formal/Relay.tla` that TLC rejects. They were run against the
checked-in spec; TLC reports the violated operator and a shortest counterexample.
This is how we know the model is **not vacuous** — it does not merely pass, it
fails when the control plane is broken in the ways we care about.

| id | Mutation | Invariant violated | Distinct states to counterexample |
| --- | --- | --- | --- |
| **Bug A** | `IdleSignal(w)` treats `session.idle` as completion: it sets the held task `done` directly, without review | `DoneRequiresReview` | 137 |
| **Bug B** | drop the `~detached[w]` guards from the spawn / persist / attach chain (and from `Operational` / `CanRecover`) | `DetachedNotOperational` | 51 |
| **Bug C** | `BootstrapDelivered(w)` no longer requires `runtimePersisted[w,g]` (wake before durable commit) | `BootstrapRequiresPersistedRuntime` | 8 |
| **Bug D** | `AttachTimeout(w)` leaves the worker `idle` instead of `dead` / unsupervised while Relay still owns the failed runtime | `AttachTimeoutStaysSupervised` | 28 |
| **Bug E** | `PersistRuntime(w)` no longer invalidates the previous session's generation on a fresh generation | `StaleSessionCannotMutateCurrent` | 155 |

Counterexample shapes (read top-to-bottom):

- **A**: a `working` worker emits `session.idle`; the task goes `running → done`
  while `taskReviewed[t] = FALSE`. Exactly the "idle ≠ done" rule.
- **B**: after `Detach(w)`, `detached[w] = TRUE`, but the spawn chain resurrects a
  `starting` generation at the same worker (`workerState = "starting"`,
  `runtimeRelayOwned[w,g] = TRUE`), so `Operational(w)` becomes true while the
  worker is detached.
- **C**: `SpawnTransport(w)` creates generation 1 (`runtimeState[w,1] = "starting"`,
  `runtimePersisted[w,1] = FALSE`); `BootstrapDelivered(w)` then sets
  `runtimeBootstrapSent[w,1] = TRUE` with no durable runtime row — waking an agent
  that has no persisted binding.
- **D**: `AttachTimeout(w)` marks the runtime `dead` but the worker `idle`, so
  `Supervised(w)` is false while `runtimeRelayOwned[w,g] = TRUE` and the current
  runtime is `dead` — the failed generation is dropped out of supervision and can
  never be restarted.
- **E**: a fresh generation advances `workerGeneration` to 2 but leaves
  `sessionManaged[w] = TRUE` / `sessionGeneration[w] = 1`, so a stale managed
  session can still mutate the current worker.

> These mutations are not committed (per the task's instruction); each was a
> throwaway copy. To reproduce, copy `formal/Relay.tla`, apply the edit described
> above, and run it with `formal/Relay.cfg`; TLC prints the counterexample.

> **Multi-daemon races are not a TLA+ mutation.** They are excluded by the
> [implementation-level single-supervisor boundary](#implementation-boundary-single-supervisor),
> not by a `Daemons = {d1,d2}` machine. Relay is specified as a *single*
> deterministic supervisor, and the model verifies correctness inside that
> boundary; two concurrent daemons racing through one SQLite DB / Herdr workspace
> are outside its scope by construction.

## TLA+ ↔ TypeScript mapping

| TLA+ | TypeScript |
| --- | --- |
| `TaskStates` / `WorkerStates` / `RuntimeStates` | `TASK_STATES` / `WORKER_STATES` / `RUNTIME_STATES` in `src/schema.ts` |
| `Operational(w)` | `isOperationalWorker` in `src/scheduler.ts` |
| `CanRecover(w)` | `isRecoverableWorker` in `src/scheduler.ts` |
| `Supervised(w)` | `isSupervisedWorker` in `src/scheduler.ts` |
| `WorkerWorking` | `workingWorkers` in `src/scheduler.ts` |
| `RunnableExists` / `ReviewExists` | `supervisorView` in `src/scheduler.ts` |
| `HumanOnlyWaiting` | `systemStatus == WAITING_FOR_HUMAN` in `src/scheduler.ts` |
| `Wake(w)` | wake branch of `reconcile` in `src/reconciler.ts` |
| `Claim(w)` | `claimNext` in `src/tasks.ts` |
| `Submit(w)` | `submitTask` (stale-lease fencing) in `src/tasks.ts` |
| `Approve(t)` / `Reject(t)` | `approveTask` / `rejectTask` in `src/tasks.ts` |
| `BlockHuman(w)` / `BlockInternal(w)` | `blockTask` in `src/tasks.ts` |
| `SpawnTransport` + `PersistRuntime` | `restartWorker` in `src/reconciler.ts` (durable-before-wake) |
| `BootstrapDelivered` | `deliverBootstrap` in `src/reconciler.ts` |
| `Attach` | `attachSession` in `src/sessions.ts` |
| `AttachTimeout` | `activatePendingRuntimes` in `src/reconciler.ts` |
| `Detach` | `detachSession` in `src/sessions.ts` |
| `StaleSessionCannotMutateCurrent` | `gateEvent` / `managedWorkerForSession` in `src/sessions.ts` |
| `GenerationMonotonicity` | `nextGeneration` in `src/runtimes.ts` |
| `Cleanup` | `cleanupOldRuntimes` + `cleanupCandidates` in `src/reconciler.ts` / `src/runtimes.ts` |

## Results

_This section is updated from actual TLC output; timings depend on the machine._

- `bun run formal` (safety, all behaviours): **no invariant violated**.
  `9,382,049` states generated, `1,850,128` distinct states, depth `38`, ~1m43s
  (`Tasks = {t1,t2}`, `Workers = {w1,w2}`, `MaxGeneration = 3`, `LeaseMax = 1`,
  `FailureBudget = 1`).
- `bun run formal:failures` (safety widened to ≥2 sequential failures): **no
  invariant violated**. `17,479` states generated, `6,490` distinct states, depth
  `25`, <1s (`Tasks = {t1}`, `Workers = {w1}`, `FailureBudget = 2`).
- `bun run formal:done` (Property C): **`AllTasksDone` holds** under `SpecDone`
  (`AllowFailure = FALSE`, `AllowDetach = FALSE`, stronger fairness).
  `477,241` states generated, `109,216` distinct states, ~29s.
- `bun run formal:liveness` (Property A `RunnableEventuallyMoves` + Property B
  `TaskProgress`): **no violation** under `SpecFair` (decision-level fairness).
  `819,633` states generated, `193,520` distinct states, depth `32`, ~2m21s (the
  temporal check is ~33s). This is the documented 1-task reduction
  (`Tasks = {t1}`); the safety config is the full 2-task instance.

Wording: the main safety model (`Relay.cfg`) **exhaustively checks its bounded
failure abstraction**. `RelayFailures.cfg` widens that abstraction to multiple
sequential failures. This is evidence about the abstractions we checked — not a
proof that no safety bug is hidden anywhere in the implementation.

## Files

| File | Purpose |
| --- | --- |
| `Relay.tla` | the model |
| `Relay.cfg` | safety config (all behaviours) |
| `RelayLiveness.cfg` | Property A + B (fair behaviours) |
| `RelayDone.cfg` | Property C (`SpecDone`, stronger environment assumptions) |
| `RelayFailures.cfg` | safety widened to ≥2 sequential failures (small instance) |
| `run-tlc.sh` | downloads TLC and runs a config |
