------------------------------ MODULE Relay ------------------------------
(***************************************************************************)
(* Relay control-plane model.                                              *)
(*                                                                         *)
(* This is NOT a transcription of src/.  It is the design intent of Relay  *)
(* written so TLC can BREAK it: the model exists to produce counterexamples *)
(* against the properties in formal/README.md ("What Relay must guarantee").*)
(*                                                                         *)
(* The two properties the whole model is organised around:                  *)
(*                                                                         *)
(*   1. REACH.  Relay must never waste progress capacity it knows how to    *)
(*      use: at a reconcile boundary an operational idle worker that can    *)
(*      take claimable durable work, and has no legitimate temporary        *)
(*      excuse, MUST have been woken -- regardless of who else is working.  *)
(*                                                                         *)
(*   2. FENCE.  Making progress must never trade away ownership: a stale    *)
(*      lease, session or generation must never mutate the current task     *)
(*      after ownership has moved on.                                       *)
(*                                                                         *)
(* Shape: a two-stage tick.  The environment moves first (Environment,      *)
(* including worker transitions and crashes), then the supervisor takes     *)
(* exactly one Reconcile pass.  The obligation is read off the state at the *)
(* reconcile boundary -- see NoAvoidableIdleAtReconcileBoundary.            *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS
  Tasks,            \* finite task ids, e.g. {t1,t2}
  Workers,          \* finite worker ids, e.g. {w1,w2}
  Roots,            \* parent-less task ids (the forest); a SUBSET of Tasks
  Edges,            \* task-tree edges as "parent:child" strings, e.g. {"t1:t2"}
                    \* (a set of strings because TLC configs cannot hold tuples)
  MaxGeneration,    \* bound on the per-worker fencing generation
  AllowFailure,     \* TRUE => the environment may crash / stall / detach
  AllowCooldown,    \* TRUE => a wake may be rate-limited (suppressed)
  ReleasesAllowed,  \* FALSE = strong env assumption: workers never abandon a task
  RejectsAllowed,   \* FALSE = the strong environment assumption used by the
                    \* AllTasksDone demonstration (reviews are never rejected)
  RoleTask,         \* optional role tag: the task that is role-restricted, or None
  RoleWorker        \* the ONLY worker eligible for RoleTask (or None)

None == "none"

Edge(p, c) == (p \o ":" \o c) \in Edges
ChildrenOf(p) == { c \in Tasks : Edge(p, c) }
ParentTask(t) == IF t \in Roots THEN None ELSE (CHOOSE p \in Tasks : Edge(p, t))

(* --------------------------------------------------------------------- *)
(* Enumerated domains                                                      *)
(* --------------------------------------------------------------------- *)
TaskStates == {"queued", "running", "review", "done", "blocked_internal", "blocked_human"}
WorkerStates == {"starting", "idle", "working", "waiting_input", "dead"}
Generations  == 0..MaxGeneration               \* 0 = worker has no generation yet
RealGenerations == 1..MaxGeneration

(* --------------------------------------------------------------------- *)
(* Variables                                                               *)
(* --------------------------------------------------------------------- *)
VARIABLE stage,
         taskState,
         taskOwner,
         taskVersion,
         parent,
         workerState,
         workerTask,
         generation,
         genOwner,
         relayOwned,
         sessionGen,
         sessionManaged,
         everAdopted,
         hasMail,
         quietUntil,
         quietActive,
         stallSeen,
         pendingWake,
         wakeSuppressed,
         retryWake,
         wakeTried,
         wakeEligible,
         parentDone,
         parentBlocked,
         activeRT,
         rtDurable,
         rtCleaned,
         reviewed

vars == << stage, taskState, taskOwner, taskVersion, parent, workerState, workerTask, generation, genOwner, relayOwned, sessionGen, sessionManaged, everAdopted, hasMail, quietUntil, quietActive, stallSeen, pendingWake, wakeSuppressed, retryWake, wakeTried, wakeEligible, parentDone, parentBlocked, activeRT, rtDurable, rtCleaned, reviewed >>


(* --------------------------------------------------------------------- *)
(* Derived predicates -- the vocabulary of the guarantee.                  *)
(* --------------------------------------------------------------------- *)

(* Runnable != claimable.  Runnable is a durable queued task.                *)
Runnable(t) == taskState[t] = "queued"

(* A worker can accept NEW work: idle, holds no task. waiting_input is        *)
(* explicitly NOT here -- it still owns its task.                              *)
IdleOperational(w) ==
  /\ workerState[w] = "idle"
  /\ workerTask[w] = None

RoleEligible(t, w) ==
  \/ RoleTask = None            \* no task is role-restricted
  \/ t # RoleTask               \* this task is untagged => any worker
  \/ w = RoleWorker             \* the tagged task's one eligible worker

ClaimableBy(w) ==
  { t \in { x \in Tasks : Runnable(x) } : IdleOperational(w) /\ RoleEligible(t, w) }

HasClaimableWork(w) == ClaimableBy(w) # {}

ActionableWork == { t \in Tasks : \E w \in Workers: t \in ClaimableBy(w) }

(* A legitimate TEMPORARY excuse to skip a worker: an active wake cooldown,    *)
(* or a delivery that just failed and will be retried next pass. It must       *)
(* never become permanent -- see NoPermanentCooldown (Level C).               *)
LegitSuppressed(w) == wakeSuppressed[w] \/ retryWake[w]

(* The reconcile boundary is a real STAGE, not a derived flag: after a          *)
(* Reconcile step the system is Stable until the environment moves again.      *)
Stable == stage = 1

(* Level-S legality ---------------------------------------------------------- *)
AtMostOneOwner ==
  \A w1, w2 \in Workers:
    (w1 # w2 /\ workerTask[w1] # None /\ workerTask[w2] # None
     /\ workerTask[w1] = workerTask[w2]) => FALSE

OwnerConsistent ==
  \A w \in Workers:
    (workerTask[w] # None) =>
      (taskState[workerTask[w]] \in {"running", "review"}
       /\ taskOwner[workerTask[w]] = w)

(* A queued/done/blocked task has NO owner: ownership is cleared on every       *)
(* transition out of running/review.  This is the invariant that catches a       *)
(* "release without a new fence" that leaves a stale owner pointer behind.       *)
QueuedHasNoOwner ==
  \A t \in Tasks:
    (taskState[t] \in {"queued", "done", "blocked_internal", "blocked_human"})
      => taskOwner[t] = None

(* Role gating is not advisory: a worker may only own a task it is eligible for  *)
(* under the strict-default policy.  Manual recovery (--any-role) is a separate  *)
(* operator escape hatch, NOT part of this automatic property.                  *)
NoRoleViolation ==
  \A t \in Tasks:
    (taskOwner[t] # None) => RoleEligible(t, taskOwner[t])

NoIdleHoldsTask ==
  \A w \in Workers: (workerState[w] = "idle") => workerTask[w] = None

NoWaitingInputClaim ==
  \A w \in Workers:
    (workerState[w] = "waiting_input") =>
      /\ workerTask[w] # None
      /\ ClaimableBy(w) = {}

WaitingInputOccupied ==
  \A w \in Workers:
    (workerState[w] = "waiting_input") =>
      (workerTask[w] # None /\ taskOwner[workerTask[w]] = w)

RunningTaskHasOwner ==
  \A t \in Tasks: (taskState[t] = "running") => taskOwner[t] # None
ReviewTaskHasOwner ==
  \A t \in Tasks: (taskState[t] = "review") => taskOwner[t] # None

(* S3 -- stale-actor isolation for a RUNNING task.  A running task always has a  *)
(* live owner: crash / restart / detach requeue it (releaseTaskOfDeadWorker only  *)
(* touches `running`), so the owner must still hold it and its current session    *)
(* must carry the generation that won the task's fence.  A stale lease, session   *)
(* or generation therefore can never mutate current state.                       *)
(*                                                                              *)
(* `review` is deliberately NOT covered here: a dead reviewer's pointer is        *)
(* reassigned lazily (claimNext re-assigns review tasks), so the pointer may      *)
(* outlive its owner.  Mutation of a review task is fenced by Approve/Reject's    *)
(* guards instead -- see NoStaleSession and FenceAgreement.                      *)
NoStaleMutation ==
  \A t \in Tasks:
    (taskState[t] = "running") =>
      \E w \in Workers:
        /\ taskOwner[t] = w
        /\ workerTask[w] = t
        /\ genOwner[w] = generation[w]
        /\ genOwner[w] = taskVersion[t]

(* S2 -- the fence on the SESSION, mirroring src/sessions.ts gateEvent: a managed *)
(* session always carries the worker's CURRENT generation.  A relay-spawned      *)
(* attach whose generation is older than the worker's is rejected outright        *)
(* ("attach rejected: generation N is older than worker gM"), so a stale session  *)
(* can never become the mutator of current state.                                 *)
NoStaleSession ==
  \A w \in Workers:
    (sessionManaged[w] /\ sessionGen[w] # 0) => sessionGen[w] = generation[w]

(* S2b -- a RUNNING task is owned by a worker whose live session carries the     *)
(* generation that won the task's fence.  Together with NoStaleSession this is    *)
(* the full fencing story: ownership + generation + session generation agree.     *)
FenceAgreement ==
  \A t \in Tasks:
    (taskState[t] = "running") =>
      \E w \in Workers:
        /\ taskOwner[t] = w
        /\ taskVersion[t] = generation[w]
        /\ sessionGen[w] = generation[w]

GenerationMonotonicity ==
  \A w \in Workers: genOwner[w] <= generation[w]

(* S6 -- quiet is task-scoped, temporary, and never survives a task change.   *)
QuietScoped ==
  \A w \in Workers:
    quietActive[w] =>
      /\ workerTask[w] # None
      /\ taskState[workerTask[w]] = "running"
      /\ quietUntil[w] = workerTask[w]

(* S7 -- waiting_input occupancy *)
WaitingInputOccupancy ==
  \A w \in Workers:
    (workerState[w] = "waiting_input") => taskOwner[workerTask[w]] = w

(* S4 -- nothing is activated or started before its durable row exists.       *)
DurableBeforeDelivery ==
  \A w \in Workers:
    (activeRT[w] \/ workerState[w] # "starting") => rtDurable[w]

(* S5 -- Relay cleans only its OWN, non-current, positively-reaped runtimes.  *)
CleanupIsRelayOwned ==
  \A w \in Workers:
    /\ (\A g \in rtCleaned[w]: relayOwned[w] = TRUE)
    /\ (\A g \in rtCleaned[w]: g < generation[w])

(* S8 -- parent signals: present iff the child reached the state, one hop.    *)
ParentDoneMeansChildDone ==
  \A p \in Tasks: \A c \in parentDone[p]: taskState[c] = "done"
ParentBlockedMeansChildBlocked ==
  \A p \in Tasks: \A c \in parentBlocked[p]: taskState[c] \in {"blocked_internal", "blocked_human"}

(* One-hop only: a parent signal concerns a DIRECT child.                      *)
ParentSignalsOneHop ==
  \A p \in Tasks: \A c \in parentDone[p] \cup parentBlocked[p]: parent[c] = p

(* S5b -- an adopted (externally-owned) runtime is NEVER taken over by Relay.    *)
(* Relay may revive it, but it may never become relay-owned (the tab belongs to   *)
(* the operator).  Once adopted, always adopted.                                 *)
AdoptedNeverReplaced ==
  \A w \in Workers: everAdopted[w] => relayOwned[w] = FALSE

(* S8b -- the durable one-hop signal is ATOMIC with the child's completion: a    *)
(* done child with a parent is ALWAYS recorded in the parent's parentDone set.   *)
(* Splitting the child state change from the parent signal (M10) breaks this.     *)
ChildDoneSignalled ==
  \A c \in Tasks:
    (taskState[c] = "done" /\ parent[c] # None) => c \in parentDone[parent[c]]

(* S8c -- block bubbling is one-hop and atomic too.                              *)
ChildBlockedSignalled ==
  \A c \in Tasks:
    (taskState[c] \in {"blocked_internal", "blocked_human"} /\ parent[c] # None)
      => c \in parentBlocked[parent[c]]

(* No automatic parent transition: a parent with a done child is never queued  *)
(* by that fact alone (the parent owner decides).                              *)
NoAutomaticParentTransition ==
  \A p \in Tasks:
    (\E c \in Tasks: parent[c] = p /\ taskState[c] = "done") => taskState[p] # "queued"

(* S1 -- done is reachable ONLY through review.  A worker cannot self-approve:  *)
(* session.idle != done, quiet != done, a crash != done, children_done != the   *)
(* parent being done.  Expressed as a HISTORY property: `reviewed` records      *)
(* every task that ever entered "review", and a task may only be "done" if it   *)
(* is in that evergreen set.  A mutation that writes "done" directly from       *)
(* "running" sets a done task that was never reviewed and is refuted.           *)
DoneRequiresReview ==
  \A t \in Tasks: (taskState[t] = "done") => t \in reviewed

ReviewedNow(t) == t \in { x \in Tasks : taskState[x] = "review" }

(* R -- the CORE responsiveness property, at the reconcile boundary.            *)
(* Stable (this pass completed) AND operational idle AND claimable work AND    *)
(* no legitimate temporary excuse  =>  the pass must have tried to wake it.    *)
NoAvoidableIdleAtReconcileBoundary ==
  \A w \in Workers:
    (Stable /\ IdleOperational(w) /\ HasClaimableWork(w) /\ ~LegitSuppressed(w))
      => wakeTried[w]

(* A woken worker that the transport failed to reach stays owed a wake.        *)
WakeFailureOwed ==
  \A w \in Workers: (retryWake[w] => pendingWake[w] # {})

(* The supervisor never CREATES a wake for work the woken worker cannot        *)
(* claim.  `wakeEligible` snapshots the eligibility AT the moment Wake ran, so *)
(* an attempt later overtaken by the world is still legitimate.                 *)
NoWakeForUnclaimableWork ==
  \A w \in Workers: (wakeTried[w] => wakeEligible[w])

(* Quiet suppresses a STALL, never a crash.                              *)
QuietDoesNotSuppressCrash ==
  \A w \in Workers: (quietActive[w] => workerState[w] = "working")

(* Quiet is bounded: a quiet lease that survives into a new task is illegal.   *)
QuietIsBounded == QuietScoped

TypeOK ==
  /\ stage \in {0, 1}
  /\ taskState \in [Tasks -> TaskStates]
  /\ taskOwner \in [Tasks -> Workers \cup {None}]
  /\ taskVersion \in [Tasks -> Generations]
  /\ parent \in [Tasks -> Tasks \cup {None}]
  /\ workerState \in [Workers -> WorkerStates]
  /\ workerTask \in [Workers -> Tasks \cup {None}]
  /\ generation \in [Workers -> Generations]
  /\ genOwner \in [Workers -> Generations]
  /\ relayOwned \in [Workers -> BOOLEAN]
  /\ sessionGen \in [Workers -> Generations]
  /\ sessionManaged \in [Workers -> BOOLEAN]
  /\ everAdopted \in [Workers -> BOOLEAN]
  /\ hasMail \in [Workers -> SUBSET Workers]
  /\ quietUntil \in [Workers -> Tasks \cup {None}]
  /\ quietActive \in [Workers -> BOOLEAN]
  /\ stallSeen \in [Workers -> BOOLEAN]
  /\ pendingWake \in [Workers -> SUBSET Workers]
  /\ wakeSuppressed \in [Workers -> BOOLEAN]
  /\ retryWake \in [Workers -> BOOLEAN]
  /\ wakeTried \in [Workers -> BOOLEAN]
  /\ wakeEligible \in [Workers -> BOOLEAN]
  /\ parentDone \in [Tasks -> SUBSET Tasks]
  /\ parentBlocked \in [Tasks -> SUBSET Tasks]
  /\ activeRT \in [Workers -> BOOLEAN]
  /\ rtDurable \in [Workers -> BOOLEAN]
  /\ rtCleaned \in [Workers -> SUBSET RealGenerations]
  /\ reviewed \in SUBSET Tasks

(* --------------------------------------------------------------------- *)
(* Encapsulated updates, so the actions below stay readable.                *)
(* --------------------------------------------------------------------- *)
Requeue(t) ==
  /\ taskState' = [taskState EXCEPT ![t] = "queued"]
  /\ taskOwner' = [taskOwner EXCEPT ![t] = None]
  /\ taskVersion' = [taskVersion EXCEPT ![t] = 0]      \* invalidates every prior owner

(* Fully release a worker: ownership returns to the queue, fence bumped.      *)
ReleaseWorker(w) ==
  \E t \in Tasks:
    /\ workerTask[w] = t
    /\ taskState[t] = "running"
    /\ Requeue(t)
    /\ workerTask' = [workerTask EXCEPT ![w] = None]
    /\ workerState' = [workerState EXCEPT ![w] = "idle"]
    /\ quietActive' = [quietActive EXCEPT ![w] = FALSE]
    /\ quietUntil' = [quietUntil EXCEPT ![w] = None]
    /\ stallSeen' = [stallSeen EXCEPT ![w] = FALSE]
    /\ stage' = 0
    /\ UNCHANGED << parent, generation, genOwner, relayOwned, everAdopted, sessionGen,
                    sessionManaged, hasMail, pendingWake, wakeSuppressed, retryWake, wakeTried,
                    wakeEligible, parentDone, parentBlocked, activeRT, rtDurable, rtCleaned,
                    reviewed >>
(* ===================================================================== *)
(* ENVIRONMENT actions                                                     *)
(* ===================================================================== *)

(* A worker asks for the next runnable task and claims one it may take.       *)
(* Atomic: pick + claim.  Ties between equally eligible workers are resolved  *)
(* by TLC's interleaving, not by Relay -- so several workers may be woken for *)
(* the same task and only one ends up owning it.                        *)
Claim(w) ==
  \E t \in Tasks:
    /\ IdleOperational(w)
    /\ Runnable(t)
    /\ RoleEligible(t, w)
    /\ taskOwner[t] = None
    /\ taskState' = [taskState EXCEPT ![t] = "running"]
    /\ taskOwner' = [taskOwner EXCEPT ![t] = w]
    /\ taskVersion' = [taskVersion EXCEPT ![t] = (IF generation[w] = 0 THEN 1 ELSE generation[w])]
    /\ workerTask' = [workerTask EXCEPT ![w] = t]
    /\ workerState' = [workerState EXCEPT ![w] = "working"]
    /\ generation' = [generation EXCEPT ![w] = (IF generation[w] = 0 THEN 1 ELSE generation[w])]
    /\ genOwner' = [genOwner EXCEPT ![w] = (IF generation[w] = 0 THEN 1 ELSE generation[w])]
    /\ sessionGen' = [sessionGen EXCEPT ![w] = (IF generation[w] = 0 THEN 1 ELSE generation[w])]
    /\ sessionManaged' = [sessionManaged EXCEPT ![w] = TRUE]
    /\ activeRT' = [activeRT EXCEPT ![w] = TRUE]
    /\ rtDurable' = [rtDurable EXCEPT ![w] = TRUE]
    /\ stallSeen' = [stallSeen EXCEPT ![w] = FALSE]
    /\ quietActive' = [quietActive EXCEPT ![w] = FALSE]
    /\ quietUntil' = [quietUntil EXCEPT ![w] = None]
    /\ stage' = 0
    /\ UNCHANGED << parent, relayOwned, hasMail, pendingWake, wakeSuppressed, retryWake, wakeTried,
                    wakeEligible, parentDone, parentBlocked, rtCleaned, reviewed, everAdopted >>
(* running -> review.  The owner keeps the task; a reviewer takes it over.     *)
Submit(w) ==
  /\ workerTask[w] # None
  /\ taskState[workerTask[w]] = "running"
  /\ genOwner[w] = generation[w]
  /\ genOwner[w] = taskVersion[workerTask[w]]
  /\ sessionGen[w] = taskVersion[workerTask[w]]    \* the session fence (gateEvent)
  /\ taskState' = [taskState EXCEPT ![workerTask[w]] = "review"]
  /\ reviewed' = reviewed \cup {workerTask[w]}
  \* submitTask keeps the assignee but clears the worker's current_task_id, so the
  \* review task now has an owner (the submitter) but no worker holding it until a
  \* reviewer adopts it.
  /\ workerTask' = [workerTask EXCEPT ![w] = None]
  /\ workerState' = [workerState EXCEPT ![w] = "idle"]
  /\ quietActive' = [quietActive EXCEPT ![w] = FALSE]
  /\ quietUntil' = [quietUntil EXCEPT ![w] = None]
  /\ stage' = 0
  /\ UNCHANGED << taskOwner, taskVersion, parent, generation, genOwner,
                  relayOwned, everAdopted, sessionGen, sessionManaged, hasMail, stallSeen,
                  pendingWake, wakeSuppressed, retryWake, wakeTried, wakeEligible, parentDone,
                  parentBlocked, activeRT, rtDurable, rtCleaned >>
(* A reviewer adopts a review task: this is `claimNext`'s reviewer path, which
   REASSIGNS the task's assignee to the reviewer (the previous assignee, the
   submitter, no longer holds it). *)
AdoptReview(t, w) ==
  /\ taskState[t] = "review"
  /\ IdleOperational(w)
  /\ (\A x \in Workers: workerTask[x] # t)    \* one writer per task
  /\ taskOwner' = [taskOwner EXCEPT ![t] = w]
  /\ taskVersion' = [taskVersion EXCEPT ![t] = (IF generation[w] = 0 THEN 1 ELSE generation[w])]
  /\ workerTask' = [workerTask EXCEPT ![w] = t]
  /\ workerState' = [workerState EXCEPT ![w] = "working"]
  /\ generation' = [generation EXCEPT ![w] = (IF generation[w] = 0 THEN 1 ELSE generation[w])]
  /\ genOwner' = [genOwner EXCEPT ![w] = (IF generation[w] = 0 THEN 1 ELSE generation[w])]
  /\ sessionGen' = [sessionGen EXCEPT ![w] = (IF generation[w] = 0 THEN 1 ELSE generation[w])]
  /\ sessionManaged' = [sessionManaged EXCEPT ![w] = TRUE]
  /\ activeRT' = [activeRT EXCEPT ![w] = TRUE]
  /\ rtDurable' = [rtDurable EXCEPT ![w] = TRUE]
  /\ stage' = 0
  /\ UNCHANGED << taskState, parent, relayOwned, hasMail, quietUntil, quietActive, stallSeen,
                  pendingWake, wakeSuppressed, retryWake, wakeTried, wakeEligible, parentDone,
                  parentBlocked, rtCleaned, reviewed, everAdopted >>
(* review -> done.  THE ONLY PATH TO done.  Child completion and the      *)
(* one-hop parent signal are ONE atomic transaction (Level A12).                     *)
Approve(t, w) ==
  /\ stage' = 0
  /\ taskState[t] = "review"
  /\ taskOwner[t] = w
  /\ workerTask[w] = t
  /\ taskState' = [taskState EXCEPT ![t] = "done"]
  /\ taskOwner' = [taskOwner EXCEPT ![t] = None]
  /\ workerTask' = [workerTask EXCEPT ![w] = None]
  /\ workerState' = [workerState EXCEPT ![w] = "idle"]
  /\ quietActive' = [quietActive EXCEPT ![w] = FALSE]
  /\ quietUntil' = [quietUntil EXCEPT ![w] = None]
  /\ LET p == parent[t] IN
       IF p = None
       THEN UNCHANGED << parentDone, parentBlocked >>
       ELSE /\ parentDone' = [parentDone EXCEPT ![p] = parentDone[p] \cup {t}]
            /\ parentBlocked' = [parentBlocked EXCEPT ![p] = parentBlocked[p] \ {t}]
  /\ UNCHANGED << taskVersion, parent, generation, genOwner, relayOwned, everAdopted, sessionGen,
                  sessionManaged, hasMail, stallSeen, pendingWake, wakeSuppressed, retryWake,
                  wakeTried, wakeEligible, activeRT, rtDurable, rtCleaned, reviewed >>

(* review -> queued.  Ownership cleared, fence bumped.                         *)
Reject(t, w) ==
  /\ RejectsAllowed
  /\ taskState[t] = "review"
  /\ taskOwner[t] = w
  /\ workerTask[w] = t
  /\ Requeue(t)
  /\ workerTask' = [workerTask EXCEPT ![w] = None]
  /\ workerState' = [workerState EXCEPT ![w] = "idle"]
  /\ quietActive' = [quietActive EXCEPT ![w] = FALSE]
  /\ quietUntil' = [quietUntil EXCEPT ![w] = None]
  /\ stage' = 0
  /\ UNCHANGED << parent, generation, genOwner, relayOwned, everAdopted, sessionGen,
                  sessionManaged, hasMail, stallSeen, pendingWake, wakeSuppressed, retryWake,
                  wakeTried, wakeEligible, parentDone, parentBlocked, activeRT, rtDurable,
                  rtCleaned, reviewed >>
(* The owner releases;  running -> queued.  Gated by ReleasesAllowed: the
   AllTasksDone demonstration assumes workers do not abandon a task forever. *)
Release(w) ==
  /\ ReleasesAllowed
  /\ ReleaseWorker(w)

(* running -> blocked_*.  One atomic transaction with the one-hop signal.      *)
Block(t, w, human) ==
  /\ stage' = 0
  /\ AllowFailure
  /\ taskState[t] = "running"
  /\ taskOwner[t] = w
  /\ workerTask[w] = t
  /\ ~quietActive[w]
  /\ taskState' = [taskState EXCEPT ![t] = (IF human THEN "blocked_human" ELSE "blocked_internal")]
  /\ taskOwner' = [taskOwner EXCEPT ![t] = None]
  /\ taskVersion' = [taskVersion EXCEPT ![t] = 0]
  /\ workerTask' = [workerTask EXCEPT ![w] = None]
  /\ workerState' = [workerState EXCEPT ![w] = "idle"]
  /\ LET p == parent[t] IN
       IF p = None
       THEN UNCHANGED << parentDone, parentBlocked >>
       ELSE /\ parentBlocked' = [parentBlocked EXCEPT ![p] = parentBlocked[p] \cup {t}]
            /\ parentDone' = [parentDone EXCEPT ![p] = parentDone[p] \ {t}]
  /\ UNCHANGED << parent, generation, genOwner, relayOwned, everAdopted, sessionGen,
                  sessionManaged, hasMail, quietUntil, quietActive, stallSeen, pendingWake,
                  wakeSuppressed, retryWake, wakeTried, wakeEligible, activeRT, rtDurable,
                  rtCleaned, reviewed >>

(* blocked_* -> queued (human or operator).                                    *)
Unblock(t) ==
  /\ AllowFailure
  /\ taskState[t] \in {"blocked_internal", "blocked_human"}
  /\ taskState' = [taskState EXCEPT ![t] = "queued"]
  /\ stage' = 0
  /\ UNCHANGED << taskOwner, taskVersion, parent, workerState, workerTask, generation, genOwner,
                  relayOwned, everAdopted, sessionGen, sessionManaged, hasMail, quietUntil,
                  quietActive, stallSeen, pendingWake, wakeSuppressed, retryWake, wakeTried,
                  wakeEligible, parentDone, parentBlocked, activeRT, rtDurable, rtCleaned, reviewed >>
(* working -> waiting_input.  Task KEPT.  Asking for input supersedes a   *)
(* quiet lease: a worker cannot be both "quiet" (deliberately idle on a bounded  *)
(* lease) and "waiting_input" (blocked on the human) at once.                    *)
WaitInput(w) ==
  /\ workerState[w] = "working"
  /\ workerTask[w] # None
  /\ workerState' = [workerState EXCEPT ![w] = "waiting_input"]
  /\ quietActive' = [quietActive EXCEPT ![w] = FALSE]
  /\ quietUntil' = [quietUntil EXCEPT ![w] = None]
  /\ stage' = 0
  /\ UNCHANGED << taskState, taskOwner, taskVersion, parent, workerTask, generation, genOwner,
                  relayOwned, everAdopted, sessionGen, sessionManaged, hasMail, stallSeen,
                  pendingWake, wakeSuppressed, retryWake, wakeTried, wakeEligible, parentDone,
                  parentBlocked, activeRT, rtDurable, rtCleaned, reviewed >>
(* waiting_input -> working.                                                   *)
TakeInput(w) ==
  /\ workerState[w] = "waiting_input"
  /\ workerState' = [workerState EXCEPT ![w] = "working"]
  /\ stage' = 0
  /\ UNCHANGED << taskState, taskOwner, taskVersion, parent, workerTask, generation, genOwner,
                  relayOwned, everAdopted, sessionGen, sessionManaged, hasMail, quietUntil,
                  quietActive, stallSeen, pendingWake, wakeSuppressed, retryWake, wakeTried,
                  wakeEligible, parentDone, parentBlocked, activeRT, rtDurable, rtCleaned, reviewed >>
(* A working task-owner declares a bounded session-idle.                       *)
QuietStart(w) ==
  /\ workerState[w] = "working"
  /\ workerTask[w] # None
  /\ taskState[workerTask[w]] = "running"
  /\ quietActive' = [quietActive EXCEPT ![w] = TRUE]
  /\ quietUntil' = [quietUntil EXCEPT ![w] = workerTask[w]]
  /\ stage' = 0
  /\ UNCHANGED << taskState, taskOwner, taskVersion, parent, workerState, workerTask, generation,
                  genOwner, relayOwned, everAdopted, sessionGen, sessionManaged, hasMail,
                  stallSeen, pendingWake, wakeSuppressed, retryWake, wakeTried, wakeEligible,
                  parentDone, parentBlocked, activeRT, rtDurable, rtCleaned, reviewed >>
(* The quiet deadline lapses.                                                  *)
QuietExpire(w) ==
  /\ quietActive[w]
  /\ quietActive' = [quietActive EXCEPT ![w] = FALSE]
  /\ quietUntil' = [quietUntil EXCEPT ![w] = None]
  /\ stage' = 0
  /\ UNCHANGED << taskState, taskOwner, taskVersion, parent, workerState, workerTask, generation,
                  genOwner, relayOwned, everAdopted, sessionGen, sessionManaged, hasMail,
                  stallSeen, pendingWake, wakeSuppressed, retryWake, wakeTried, wakeEligible,
                  parentDone, parentBlocked, activeRT, rtDurable, rtCleaned, reviewed >>
(* A peer sends a durable signal -- any worker state, quiet included.    *)
Deliver(w, p) ==
  /\ p # w
  /\ hasMail' = [hasMail EXCEPT ![w] = hasMail[w] \cup {p}]
  /\ pendingWake' = [pendingWake EXCEPT ![w] = pendingWake[w] \cup {p}]
  /\ stage' = 0
  /\ UNCHANGED << taskState, taskOwner, taskVersion, parent, workerState, workerTask, generation,
                  genOwner, relayOwned, everAdopted, sessionGen, sessionManaged, quietUntil,
                  quietActive, stallSeen, wakeSuppressed, retryWake, wakeTried, wakeEligible,
                  parentDone, parentBlocked, activeRT, rtDurable, rtCleaned, reviewed >>
(* The woken worker reads its mail.                                            *)
AckMail(w, p) ==
  /\ p \in hasMail[w]
  /\ hasMail' = [hasMail EXCEPT ![w] = hasMail[w] \ {p}]
  /\ stage' = 0
  /\ UNCHANGED << taskState, taskOwner, taskVersion, parent, workerState, workerTask, generation,
                  genOwner, relayOwned, everAdopted, sessionGen, sessionManaged, quietUntil,
                  quietActive, stallSeen, pendingWake, wakeSuppressed, retryWake, wakeTried,
                  wakeEligible, parentDone, parentBlocked, activeRT, rtDurable, rtCleaned, reviewed >>
(* The transport delivers the prompt the supervisor asked for.                 *)
WakeDelivered(w) ==
  /\ wakeTried[w]
  /\ wakeTried' = [wakeTried EXCEPT ![w] = FALSE]
  /\ retryWake' = [retryWake EXCEPT ![w] = FALSE]
  /\ wakeSuppressed' = [wakeSuppressed EXCEPT ![w] = AllowCooldown]
  /\ stage' = 0
  /\ UNCHANGED << taskState, taskOwner, taskVersion, parent, workerState, workerTask, generation,
                  genOwner, relayOwned, everAdopted, sessionGen, sessionManaged, hasMail,
                  quietUntil, quietActive, stallSeen, pendingWake, wakeEligible, parentDone,
                  parentBlocked, activeRT, rtDurable, rtCleaned, reviewed >>
(* The transport fails;  the durable signal survives (a failed wake is retried).               *)
WakeFails(w) ==
  /\ wakeTried[w]
  /\ wakeTried' = [wakeTried EXCEPT ![w] = FALSE]
  /\ retryWake' = [retryWake EXCEPT ![w] = TRUE]
  /\ stage' = 0
  /\ UNCHANGED << taskState, taskOwner, taskVersion, parent, workerState, workerTask, generation,
                  genOwner, relayOwned, everAdopted, sessionGen, sessionManaged, hasMail,
                  quietUntil, quietActive, stallSeen, pendingWake, wakeEligible, wakeSuppressed,
                  parentDone, parentBlocked, activeRT, rtDurable, rtCleaned, reviewed >>
(* A failed delivery is retried.                                               *)
RetryWake(w) ==
  /\ retryWake[w]
  /\ retryWake' = [retryWake EXCEPT ![w] = FALSE]
  /\ wakeTried' = [wakeTried EXCEPT ![w] = TRUE]
  /\ stage' = 0
  /\ UNCHANGED << taskState, taskOwner, taskVersion, parent, workerState, workerTask, generation,
                  genOwner, relayOwned, everAdopted, sessionGen, sessionManaged, hasMail,
                  quietUntil, quietActive, stallSeen, pendingWake, wakeEligible, wakeSuppressed,
                  parentDone, parentBlocked, activeRT, rtDurable, rtCleaned, reviewed >>
(* A new generation is allocated: strictly newer, and it becomes the only      *)
(* generation allowed to mutate.  Any owned running task is requeued with a    *)
(* bumped fence, so the prior owner can never submit it.            *)
RestartOwned(w) ==
  /\ AllowFailure
  /\ relayOwned[w] = TRUE
  /\ generation[w] < MaxGeneration
  /\ LET g2 == generation[w] + 1 IN
     /\ generation' = [generation EXCEPT ![w] = g2]
     /\ genOwner' = [genOwner EXCEPT ![w] = (IF activeRT[w] THEN 0 ELSE g2)]
     /\ activeRT' = [activeRT EXCEPT ![w] = TRUE]
     /\ rtDurable' = [rtDurable EXCEPT ![w] = TRUE]
     /\ quietActive' = [quietActive EXCEPT ![w] = FALSE]
     /\ quietUntil' = [quietUntil EXCEPT ![w] = None]
     /\ stallSeen' = [stallSeen EXCEPT ![w] = FALSE]
     /\ workerState' = [workerState EXCEPT ![w] = "starting"]
     /\ workerTask' = [workerTask EXCEPT ![w] = None]
     \* The old session is fenced out: it is no longer managed until the fresh
     \* generation attaches (which sets sessionGen = generation).
     /\ sessionManaged' = [sessionManaged EXCEPT ![w] = FALSE]
     \* Requeue the owned running task (if any), so the old generation can never
     \* submit it.  Written as total updates so every variable is always assigned.
     /\ LET owned == (\E t \in Tasks: workerTask[w] = t /\ taskState[t] = "running")
            ot == (CHOOSE t \in Tasks: workerTask[w] = t /\ taskState[t] = "running")
        IN
        /\ taskState' = [t \in Tasks |->
             IF owned /\ t = ot THEN "queued" ELSE taskState[t]]
        /\ taskOwner' = [t \in Tasks |->
             IF owned /\ t = ot THEN None ELSE taskOwner[t]]
        /\ taskVersion' = [t \in Tasks |->
             IF owned /\ t = ot THEN 0 ELSE taskVersion[t]]
  /\ stage' = 0
  /\ UNCHANGED << parent, relayOwned, sessionGen, hasMail, pendingWake, wakeSuppressed, retryWake,
                  wakeTried, wakeEligible, parentDone, parentBlocked, rtCleaned, reviewed,
                  everAdopted >>
(* The fresh generation finishes attaching:  starting -> idle.  The session     *)
(* carries the current generation, which is what makes it non-stale.           *)
Attach(w) ==
  /\ workerState[w] = "starting"
  /\ genOwner[w] = generation[w]
  /\ rtDurable[w]
  /\ workerState' = [workerState EXCEPT ![w] = "idle"]
  /\ sessionGen' = [sessionGen EXCEPT ![w] = generation[w]]
  /\ sessionManaged' = [sessionManaged EXCEPT ![w] = TRUE]
  /\ stage' = 0
  /\ UNCHANGED << taskState, taskOwner, taskVersion, parent, workerTask, generation, genOwner,
                  relayOwned, hasMail, quietUntil, quietActive, stallSeen, pendingWake,
                  wakeSuppressed, retryWake, wakeTried, wakeEligible, parentDone, parentBlocked,
                  activeRT, rtDurable, rtCleaned, reviewed, everAdopted >>
(* The gateEvent fence (src/sessions.ts): an attach that presents a generation    *)
(* STRICTLY OLDER than the worker's is rejected.  A correct Relay only lets the  *)
(* current generation attach, so the guard below is `g = generation[w]`; the      *)
(* mutation M7 removes it, letting a stale generation become the live session and *)
(* breaking NoStaleSession.                                                      *)
StaleAttach(w, g) ==
  /\ AllowFailure
  /\ g \in Generations
  /\ g = generation[w]                    \* the gateEvent fence
  /\ sessionGen' = [sessionGen EXCEPT ![w] = g]
  /\ sessionManaged' = [sessionManaged EXCEPT ![w] = TRUE]
  /\ stage' = 0
  /\ UNCHANGED << taskState, taskOwner, taskVersion, parent, workerState, workerTask, generation,
                  genOwner, relayOwned, hasMail, quietUntil, quietActive, stallSeen, pendingWake,
                  wakeSuppressed, retryWake, wakeTried, wakeEligible, parentDone, parentBlocked,
                  activeRT, rtDurable, rtCleaned, reviewed, everAdopted >>
(* An ADOPTED worker that is actually alive but was misclassified dead/stalled *)
(* is REVIVED, not replaced (M9).                                        *)
ReviveAdopted(w) ==
  /\ AllowFailure
  /\ relayOwned[w] = FALSE
  /\ workerState[w] = "dead"
  /\ workerState' = [workerState EXCEPT ![w] = "idle"]
  /\ stallSeen' = [stallSeen EXCEPT ![w] = FALSE]
  /\ sessionGen' = [sessionGen EXCEPT ![w] = generation[w]]
  /\ sessionManaged' = [sessionManaged EXCEPT ![w] = TRUE]
  /\ stage' = 0
  /\ UNCHANGED << taskState, taskOwner, taskVersion, parent, workerTask, generation, genOwner,
                  relayOwned, hasMail, quietUntil, quietActive, pendingWake, wakeSuppressed,
                  retryWake, wakeTried, wakeEligible, parentDone, parentBlocked, activeRT,
                  rtDurable, rtCleaned, reviewed, everAdopted >>
(* Relay begins supervising an EXTERNAL runtime it does not own (an adopted tab,
   `relay session attach`).  The worker stays supervised; `relayOwned` becomes
   FALSE and can never flip back (AdoptedNeverReplaced).  Its transport can still
   die (Crash), and Relay recovers it by REVIVING, never by replacing the tab. *)
Adopt(w) ==
  /\ AllowFailure
  /\ relayOwned[w] = TRUE
  /\ relayOwned' = [relayOwned EXCEPT ![w] = FALSE]
  /\ everAdopted' = [everAdopted EXCEPT ![w] = TRUE]
  /\ stage' = 0
  /\ UNCHANGED << taskState, taskOwner, taskVersion, parent, workerState, workerTask, generation,
                  genOwner, sessionGen, sessionManaged, hasMail, quietUntil, quietActive,
                  stallSeen, pendingWake, wakeSuppressed, retryWake, wakeTried, wakeEligible,
                  parentDone, parentBlocked, activeRT, rtDurable, rtCleaned, reviewed >>
(* A stall: an owned running task stops progressing.  Quiet suppresses it.     *)
Stall(w) ==
  /\ AllowFailure
  /\ workerState[w] = "working"
  /\ workerTask[w] # None
  /\ taskState[workerTask[w]] = "running"
  /\ ~quietActive[w]
  /\ stallSeen' = [stallSeen EXCEPT ![w] = TRUE]
  /\ stage' = 0
  /\ UNCHANGED << taskState, taskOwner, taskVersion, parent, workerState, workerTask, generation,
                  genOwner, relayOwned, everAdopted, sessionGen, sessionManaged, hasMail,
                  quietUntil, quietActive, pendingWake, wakeSuppressed, retryWake, wakeTried,
                  wakeEligible, parentDone, parentBlocked, activeRT, rtDurable, rtCleaned, reviewed >>
(* A crash: the runtime dies, the worker is classed dead, its task requeued     *)
(* with a bumped fence.  Quiet does NOT prevent this (M5).               *)
Crash(w) ==
  /\ AllowFailure
  /\ workerState[w] \in {"working", "idle", "waiting_input"}
  /\ workerState' = [workerState EXCEPT ![w] = "dead"]
  /\ LET owned == (\E t \in Tasks: workerTask[w] = t /\ taskState[t] = "running")
            ot == (CHOOSE t \in Tasks: workerTask[w] = t /\ taskState[t] = "running")
     IN
     /\ taskState' = [t \in Tasks |->
          IF owned /\ t = ot THEN "queued" ELSE taskState[t]]
     /\ taskOwner' = [t \in Tasks |->
          IF owned /\ t = ot THEN None ELSE taskOwner[t]]
     /\ taskVersion' = [t \in Tasks |->
          IF owned /\ t = ot THEN 0 ELSE taskVersion[t]]
  /\ workerTask' = [workerTask EXCEPT ![w] = None]
  /\ quietActive' = [quietActive EXCEPT ![w] = FALSE]
  /\ quietUntil' = [quietUntil EXCEPT ![w] = None]
  /\ stallSeen' = [stallSeen EXCEPT ![w] = FALSE]
  /\ sessionManaged' = [sessionManaged EXCEPT ![w] = FALSE]
  /\ stage' = 0
  /\ UNCHANGED << parent, generation, genOwner, relayOwned, everAdopted, sessionGen, hasMail,
                  pendingWake, wakeSuppressed, retryWake, wakeTried, wakeEligible, parentDone,
                  parentBlocked, activeRT, rtDurable, rtCleaned, reviewed >>
(* The cooldown lapses (M4).                                                   *)
CooldownExpire(w) ==
  /\ AllowCooldown
  /\ wakeSuppressed[w]
  /\ wakeSuppressed' = [wakeSuppressed EXCEPT ![w] = FALSE]
  /\ stage' = 0
  /\ UNCHANGED << taskState, taskOwner, taskVersion, parent, workerState, workerTask, generation,
                  genOwner, relayOwned, everAdopted, sessionGen, sessionManaged, hasMail,
                  quietUntil, quietActive, stallSeen, pendingWake, retryWake, wakeTried,
                  wakeEligible, parentDone, parentBlocked, activeRT, rtDurable, rtCleaned, reviewed >>
(* The environment detaches a worker for good;  it leaves the supervised set.  *)
Detach(w) ==
  /\ AllowFailure
  /\ workerState[w] # "dead"
  /\ workerState' = [workerState EXCEPT ![w] = "idle"]
  /\ relayOwned' = [relayOwned EXCEPT ![w] = FALSE]
  /\ workerTask' = [workerTask EXCEPT ![w] = None]
  \* A detached worker must not orphan a running task: requeue it with an
  \* invalidated fence, exactly like a crash.  Detach is not an escape from
  \* ownership.
  /\ LET owned == (\E t \in Tasks: workerTask[w] = t /\ taskState[t] = "running")
            ot == (CHOOSE t \in Tasks: workerTask[w] = t /\ taskState[t] = "running")
     IN
     /\ taskState' = [t \in Tasks |->
          IF owned /\ t = ot THEN "queued" ELSE taskState[t]]
     /\ taskOwner' = [t \in Tasks |->
          IF owned /\ t = ot THEN None ELSE taskOwner[t]]
     /\ taskVersion' = [t \in Tasks |->
          IF owned /\ t = ot THEN 0 ELSE taskVersion[t]]
  /\ quietActive' = [quietActive EXCEPT ![w] = FALSE]
  /\ quietUntil' = [quietUntil EXCEPT ![w] = None]
  /\ pendingWake' = [pendingWake EXCEPT ![w] = {}]
  /\ sessionManaged' = [sessionManaged EXCEPT ![w] = FALSE]
  /\ everAdopted' = [everAdopted EXCEPT ![w] = TRUE]
  /\ stage' = 0
  /\ UNCHANGED << parent, generation, genOwner, sessionGen, hasMail, stallSeen, wakeSuppressed,
                  retryWake, wakeTried, wakeEligible, parentDone, parentBlocked, activeRT,
                  rtDurable, rtCleaned, reviewed >>
Environment ==
  \/ \E w \in Workers: Claim(w)
  \/ \E w \in Workers: Submit(w)
  \/ \E t \in Tasks: \E w \in Workers: AdoptReview(t, w)
  \/ \E t \in Tasks: \E w \in Workers: Approve(t, w)
  \/ \E t \in Tasks: \E w \in Workers: Reject(t, w)
  \/ \E w \in Workers: Release(w)
  \/ \E t \in Tasks: \E w \in Workers: \E human \in BOOLEAN: Block(t, w, human)
  \/ \E t \in Tasks: Unblock(t)
  \/ \E w \in Workers: WaitInput(w)
  \/ \E w \in Workers: TakeInput(w)
  \/ \E w \in Workers: QuietStart(w)
  \/ \E w \in Workers: QuietExpire(w)
  \/ \E w, p \in Workers: Deliver(w, p)
  \/ \E w, p \in Workers: AckMail(w, p)
  \/ \E w \in Workers: WakeDelivered(w)
  \/ \E w \in Workers: WakeFails(w)
  \/ \E w \in Workers: RetryWake(w)
  \/ \E w \in Workers: RestartOwned(w)
  \/ \E w \in Workers: Attach(w)
  \/ \E w \in Workers: \E g \in Generations: StaleAttach(w, g)
  \/ \E w \in Workers: Adopt(w)
  \/ \E w \in Workers: ReviveAdopted(w)
  \/ \E w \in Workers: Stall(w)
  \/ \E w \in Workers: Crash(w)
  \/ \E w \in Workers: CooldownExpire(w)
  \/ \E w \in Workers: Detach(w)

(* ===================================================================== *)
(* SUPERVISOR actions -- one reconcile pass per tick.                      *)
(* ===================================================================== *)

(* --------------------------------------------------------------------- *)
(* The reconcile pass.  ONE atomic supervisor step, entered in stage "env"    *)
(* "env" and leaving the system Stable.  It decides, for THIS pass, the set *)
(* of workers it attempts to wake.  A correct Relay attempts every worker   *)
(* that has claimable work or an owed signal; the model does NOT force      *)
(* that -- it is the property under test                                *)
(* (NoAvoidableIdleAtReconcileBoundary).                                    *)
(*                                                                          *)
(* `W` is the supervisor's CHOICE of whom to wake.  Wake is advisory: it     *)
(* never picks a task, so a task is still claimed by exactly one worker even *)
(* if several were woken for it.                                      *)
(* --------------------------------------------------------------------- *)
(* The set of workers a CORRECT supervisor attempts to wake this pass: every    *)
(* worker with an owed signal or claimable work, minus the legitimately        *)
(* suppressed.  Relay's implemented semantics (the reconciler wake loop) is this. *)
EligibleWakees ==
  { w \in Workers :
      (   pendingWake[w] # {}
       \/ (\E t \in Tasks: t \in ClaimableBy(w) /\ taskOwner[t] = None))
      /\ ~wakeSuppressed[w] /\ ~retryWake[w] }

WakeSet(W) ==
  /\ W \subseteq Workers
  /\ \A w \in W:
       (   (pendingWake[w] # {} \/ (\E t \in Tasks: t \in ClaimableBy(w) /\ taskOwner[t] = None))
        /\ ~wakeSuppressed[w] /\ ~retryWake[w])
  /\ wakeTried' = [w \in Workers |-> (w \in W)]
  /\ wakeEligible' = [w \in Workers |->
       IF w \in W THEN (pendingWake[w] # {} \/ HasClaimableWork(w)) ELSE wakeEligible[w]]

Reconcile ==
  /\ stage' = 1
  /\ WakeSet(EligibleWakees)
  \* Quiet leases are NOT cleared here: a lease lapses only through QuietExpire
  \* (its deadline).  The supervisor does not get to clear a live lease.
  \* Reap runtimes: Relay reaps ONLY its own, non-current, positively-reaped
  \* generations.  `ToReap` is a per-worker set of generation numbers; the guard
  \* is the whole content of NonRelayOwnedNeverCleaned / CurrentRuntimeNeverCleaned.
  \* M8 removes the relayOwned guard, M-current removes the `g < generation` guard.
  /\ \E ToReap \in [Workers -> SUBSET RealGenerations]:
        /\ \A w \in Workers: \A g \in ToReap[w]:
             /\ relayOwned[w] = TRUE        \* never reap an adopted runtime
             /\ g < generation[w]           \* never reap the current generation
             /\ g < genOwner[w]             \* never reap the live mutator
        /\ rtCleaned' = [w \in Workers |-> rtCleaned[w] \cup ToReap[w]]
  /\ UNCHANGED << taskState, taskOwner, taskVersion, parent, workerState, workerTask, generation,
                  genOwner, relayOwned, everAdopted, sessionGen, sessionManaged, hasMail,
                  quietUntil, quietActive, pendingWake, wakeSuppressed, retryWake, stallSeen,
                  parentDone, parentBlocked, activeRT, rtDurable, reviewed >>

(* A full tick: one environment step, or one reconcile pass.                    *)
Tick ==
  \/ Environment
  \/ Reconcile

(* --------------------------------------------------------------------- *)
(* Initial state                                                           *)
(* --------------------------------------------------------------------- *)
Init ==
  /\ stage = 0
  /\ taskState = [t \in Tasks |-> "queued"]
  /\ taskOwner = [t \in Tasks |-> None]
  /\ taskVersion = [t \in Tasks |-> 0]
  /\ parent = [t \in Tasks |-> ParentTask(t)]
  /\ workerState = [w \in Workers |-> "idle"]
  /\ workerTask = [w \in Workers |-> None]
  /\ generation = [w \in Workers |-> 0]
  /\ genOwner = [w \in Workers |-> 0]
  /\ relayOwned = [w \in Workers |-> TRUE]
  /\ sessionGen = [w \in Workers |-> 0]
  /\ sessionManaged = [w \in Workers |-> TRUE]
  /\ everAdopted = [w \in Workers |-> FALSE]
  /\ hasMail = [w \in Workers |-> {}]
  /\ quietUntil = [w \in Workers |-> None]
  /\ quietActive = [w \in Workers |-> FALSE]
  /\ stallSeen = [w \in Workers |-> FALSE]
  /\ pendingWake = [w \in Workers |-> {}]
  /\ wakeSuppressed = [w \in Workers |-> FALSE]
  /\ retryWake = [w \in Workers |-> FALSE]
  /\ wakeTried = [w \in Workers |-> FALSE]   \* no reconcile pass has run yet
  /\ wakeEligible = [w \in Workers |-> FALSE]
  /\ parentDone = [t \in Tasks |-> {}]
  /\ parentBlocked = [t \in Tasks |-> {}]
  /\ activeRT = [w \in Workers |-> FALSE]
  /\ rtDurable = [w \in Workers |-> TRUE]
  /\ rtCleaned = [w \in Workers |-> {}]
  /\ reviewed = {}
(* --------------------------------------------------------------------- *)
(* Fairness.  Deliberately minimal: only the liveness that the              *)
(* environment itself owes.  An implementation defect must NOT be hidden    *)
(* behind a fairness conjunct.                                             *)
(* --------------------------------------------------------------------- *)
LivenessFairness ==
  \* The ONLY fairness Relay itself owes: the supervisor loop keeps running and
  \* its own bounded-suppression deadlines lapse.  An implementation defect must
  \* NOT be hidden behind a fairness conjunct -- never add WF/SF here to make a
  \* Relay guarantee come out true.
  /\ WF_vars(Reconcile)
  /\ \A w \in Workers: WF_vars(CooldownExpire(w))
  /\ \A w \in Workers: WF_vars(QuietExpire(w))
  /\ \A w \in Workers: WF_vars(RetryWake(w))

(* Environment-assumption fairness: the workers themselves eventually act.      *)
(* This is Level D -- it is an assumption on the world, NOT a Relay guarantee.  *)
EnvFairness ==
  /\ \A w \in Workers: WF_vars(Claim(w))
  /\ \A w \in Workers: WF_vars(Submit(w))
  /\ \A t \in Tasks: \A w \in Workers: WF_vars(AdoptReview(t, w))
  /\ \A t \in Tasks: \A w \in Workers: WF_vars(Approve(t, w))
  /\ \A w \in Workers: WF_vars(TakeInput(w))      \* a permission wait is answered

Spec == Init /\ [][Tick]_vars
FairSpec == Init /\ [][Tick]_vars /\ LivenessFairness
CompletionSpec == FairSpec /\ EnvFairness

(* ===================================================================== *)
(* Level-R and Level-L temporal properties.                                *)
(* ===================================================================== *)

(* R (temporal form): claimable work cannot stay unclaimed forever.  This is   *)
(* the honest replacement for the old, too-weak `RunnableExists => <> some      *)
(* WorkerWorking` -- see formal/README.md "What Relay must guarantee".          *)
NoPermanentStranding ==
  (ActionableWork # {}) ~> (ActionableWork = {})

(* L3: a wake cooldown is bounded -- every cooldown eventually lapses.         *)
NoPermanentCooldown ==
  \A w \in Workers: wakeSuppressed[w] ~> ~wakeSuppressed[w]

(* L4: a quiet lease is bounded -- every quiet lease eventually lapses.         *)
NoPermanentQuiet ==
  \A w \in Workers: quietActive[w] ~> ~quietActive[w]

(* L2: a deliverable wake is never lost -- if a worker is owed a wake it        *)
(* eventually has wakeTried again.                                             *)
NoLostWake ==
  \A w \in Workers: (pendingWake[w] # {}) ~> wakeTried[w]

(* Level D -- demonstration only, under the strong environment assumptions in  *)
(* the README.  NOT a Relay guarantee.                                         *)
AllTasksDone ==
  <>( \A t \in Tasks: taskState[t] = "done" )

===========================================================================
