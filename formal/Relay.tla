------------------------------ MODULE Relay ------------------------------
(***************************************************************************)
(* Relay control-plane model.                                              *)
(*                                                                         *)
(* This is NOT a transcription of src/.  It is the design intent of Relay  *)
(* written so that TLC can BREAK it: the model exists to produce           *)
(* counterexamples against the properties in formal/README.md ("What Relay *)
(* must guarantee").  Read that file first.                                *)
(*                                                                         *)
(* The two properties the whole model is organised around:                  *)
(*                                                                         *)
(*   1. REACH.  If an OPERATIONAL idle worker can take useful durable work  *)
(*      now, a reconcile pass must not ignore that capacity merely because  *)
(*      some unrelated worker is busy.                                      *)
(*                                                                         *)
(*   2. FENCE.  Only the current ownership epoch may advance a task.  The   *)
(*      task LEASE, the worker/runtime GENERATION and the managed-SESSION   *)
(*      generation are DISTINCT fences; a stale value from any of them must *)
(*      be unable to mutate current work.                                   *)
(*                                                                         *)
(* Shape: a two-stage tick.  The environment moves (Environment), then the  *)
(* supervisor takes one atomic Reconcile pass.  The REACH obligation is read *)
(* off the state at the reconcile boundary (stage = 1).                     *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS
  Tasks,            \* finite task ids, e.g. {"t1","t2"}
  Workers,          \* finite worker ids, e.g. {"w1","w2"}
  Roots,            \* parent-less task ids (the forest); a SUBSET of Tasks
  Edges,            \* task-tree edges as "parent:child" strings, e.g. {"t1:t2"}
                    \* (a set of strings because TLC configs cannot hold tuples)
  MaxGeneration,    \* bound on the per-worker fencing generation
  AllowFailure,     \* TRUE => the environment may crash / stall / adopt / detach
  AllowCooldown,    \* TRUE => a wake may be rate-limited (suppressed)
  ReleasesAllowed,  \* FALSE = strong env assumption: workers never abandon a task
  RejectsAllowed,   \* FALSE = strong env assumption: reviews are never rejected
  ReviewerWorkers,  \* the workers that have REVIEW capability (a SUBSET of Workers)
  RoleTask,         \* optional role tag: the task that is role-restricted, or None
  RoleWorker        \* the ONLY worker eligible for RoleTask (or None)

None == "none"

(* --------------------------------------------------------------------- *)
(* Enumerated domains                                                      *)
(* --------------------------------------------------------------------- *)
TaskStates == {"queued", "running", "review", "done", "blocked_internal", "blocked_human"}
WorkerStates == {"starting", "idle", "working", "waiting_input", "dead", "stalled"}
Generations  == 0..MaxGeneration
RealGenerations == 1..MaxGeneration

Edge(p, c) == (p \o ":" \o c) \in Edges
ChildrenOf(p) == { c \in Tasks : Edge(p, c) }
ParentTask(t) == IF t \in Roots THEN None ELSE (CHOOSE p \in Tasks : Edge(p, t))

(* --------------------------------------------------------------------- *)
(* Variables                                                               *)
(* --------------------------------------------------------------------- *)
VARIABLE
  stage,          \* 0 = environment, 1 = a reconcile pass just completed
  taskState,      \* [Tasks -> TaskStates]
  taskOwner,      \* [Tasks -> Workers \cup {None}]
  taskLease,      \* [Tasks -> Nat]  monotone per-task LEASE token (bumped on every change)
  taskGen,        \* [Tasks -> Generations]  runtime generation that won the claim
  lastLease,      \* [Tasks -> Nat]  the lease under which the task last entered running/review
  parent,         \* [Tasks -> Tasks \cup {None}]  the tree
  workerState,    \* [Workers -> WorkerStates]
  workerTask,     \* [Workers -> Tasks \cup {None}]
  workerLease,    \* [Workers -> Nat]  lease the worker's CURRENT session holds (0 = none)
  staleLease,     \* [Workers -> Nat]  lease a LEFTOVER session holds (0 = none)
  generation,     \* [Workers -> Generations]  current durable generation
  genOwner,       \* [Workers -> Generations]  generation allowed to mutate (0 = none)
  genWatermark,   \* [Workers -> Generations]  highest generation ever allocated
  relayOwned,     \* [Workers -> BOOLEAN]  Relay created the runtime (FALSE = adopted)
  sessionGen,     \* [Workers -> Generations]  generation the current session presents
  sessionManaged, \* [Workers -> BOOLEAN]
  everAdopted,    \* [Workers -> BOOLEAN]
  detached,       \* [Workers -> BOOLEAN]  left the supervised set for good
  retired,        \* [Workers -> BOOLEAN]  history only, never supervised
  transportAlive, \* [Workers -> BOOLEAN]  the runtime transport is alive
  hasMail,        \* [Workers -> SUBSET Workers]  unread durable signals
  quietUntil,     \* [Workers -> Tasks \cup {None}]  quiet lease, scoped to a task
  quietActive,    \* [Workers -> BOOLEAN]
  stallSeen,      \* [Workers -> BOOLEAN]
  pendingWake,    \* [Workers -> SUBSET Workers]  durable signal w is owed a wake for
  wakeSuppressed, \* [Workers -> BOOLEAN]  a wake is legitimately rate-limited now
  retryWake,      \* [Workers -> BOOLEAN]  a delivery failed; owed a retry (durable)
  wakeTried,      \* [Workers -> BOOLEAN]  this reconcile pass attempted a wake
  wakeEligible,   \* [Workers -> BOOLEAN]  eligibility snapshot taken when Wake ran
  parentDone,     \* [Tasks -> SUBSET Tasks]
  parentBlocked,  \* [Tasks -> SUBSET Tasks]
  activeRT,       \* [Workers -> BOOLEAN]
  rtDurable,      \* [Workers -> BOOLEAN]
  rtCleaned,      \* [Workers -> SUBSET Generations]
  approved,       \* SUBSET Tasks: tasks that were APPROVED (done only by approve)
  reviewed,       \* SUBSET Tasks: tasks that have EVER entered review
  prevTaskState,  \* [Tasks -> TaskStates]  history: taskState in the previous state
  prevGeneration, \* [Workers -> Generations]  history: generation in the previous state
  prevPendingWake, \* [Workers -> SUBSET Workers]  history: pendingWake in the previous state
  prevWakeTried   \* [Workers -> BOOLEAN]  history: wakeTried in the previous state

baseVars == << stage, taskState, taskOwner, taskLease, taskGen, lastLease, parent,
           workerState, workerTask, workerLease, staleLease, generation, genOwner,
           genWatermark, relayOwned, sessionGen, sessionManaged, everAdopted, detached,
           retired, transportAlive, hasMail, quietUntil, quietActive, stallSeen,
           pendingWake, wakeSuppressed, retryWake, wakeTried, wakeEligible, parentDone,
           parentBlocked, activeRT, rtDurable, rtCleaned, approved, reviewed >>

(* History variables are updated ONLY by the Tick wrapper, so fairness is        *)
(* expressed over `baseVars` (the actions fully specify those).                  *)
vars == << baseVars, prevPendingWake, prevWakeTried >>

(* --------------------------------------------------------------------- *)
(* Derived predicates -- the vocabulary of the guarantee.                  *)
(* --------------------------------------------------------------------- *)
Runnable(t) == taskState[t] = "queued"

(* Role gating is for CLAIMING a queued task.  Review is a separate capability. *)
CanReview(w) == w \in ReviewerWorkers
RoleEligible(t, w) ==
  \/ RoleTask = None
  \/ t # RoleTask
  \/ w = RoleWorker

(* --- supervision predicates, mirroring scheduler.ts --------------------- *)
(* Operational: a live managed session, or a relay-owned starting runtime.   *)
Operational(w) ==
  /\ ~detached[w]
  /\ ~retired[w]
  /\ (sessionManaged[w] \/ (workerState[w] = "starting" /\ relayOwned[w]))

(* Recoverable: a relay-owned generation that failed and must be replaced.   *)
Recoverable(w) ==
  /\ ~detached[w]
  /\ ~retired[w]
  /\ ~Operational(w)
  /\ relayOwned[w]
  /\ (workerState[w] = "dead" \/ workerState[w] = "stalled")

Supervised(w) == Operational(w) \/ Recoverable(w)

(* A worker that can accept NEW work right now. *)
IdleOperational(w) ==
  /\ Operational(w)
  /\ workerState[w] = "idle"
  /\ workerTask[w] = None

ClaimableBy(w) ==
  { t \in { x \in Tasks : Runnable(x) } : IdleOperational(w) /\ RoleEligible(t, w) }

HasClaimableWork(w) == ClaimableBy(w) # {}
ActionableWork == { t \in Tasks : \E w \in Workers: t \in ClaimableBy(w) }

LegitSuppressed(w) == wakeSuppressed[w] \/ retryWake[w]
Stable == stage = 1

(* --- the fence guards, in one place ------------------------------------- *)
(* A normal PROGRESS mutation by w on t requires ALL THREE fences to agree:  *)
(*   ownership:  w owns t and holds it                                       *)
(*   lease:      the session's lease is the task's current lease             *)
(*   generation: the session generation is the one that won the task's claim *)
CanProgress(t, w) ==
  /\ taskOwner[t] = w
  /\ workerTask[w] = t
  /\ taskState[t] = "running"
  /\ workerLease[w] = taskLease[t]
  /\ taskGen[t] = generation[w]
  /\ sessionGen[w] = generation[w]
  /\ sessionManaged[w]

(* --------------------------------------------------------------------- *)
(* Invariants                                                              *)
(* --------------------------------------------------------------------- *)
TypeOK ==
  /\ stage \in {0, 1}
  /\ taskState \in [Tasks -> TaskStates]
  /\ taskOwner \in [Tasks -> Workers \cup {None}]
  /\ taskLease \in [Tasks -> Nat]
  /\ taskGen \in [Tasks -> Generations]
  /\ lastLease \in [Tasks -> Nat]
  /\ parent \in [Tasks -> Tasks \cup {None}]
  /\ workerState \in [Workers -> WorkerStates]
  /\ workerTask \in [Workers -> Tasks \cup {None}]
  /\ workerLease \in [Workers -> Nat]
  /\ staleLease \in [Workers -> Nat]
  /\ generation \in [Workers -> Generations]
  /\ genOwner \in [Workers -> Generations]
  /\ genWatermark \in [Workers -> Generations]
  /\ relayOwned \in [Workers -> BOOLEAN]
  /\ sessionGen \in [Workers -> Generations]
  /\ sessionManaged \in [Workers -> BOOLEAN]
  /\ everAdopted \in [Workers -> BOOLEAN]
  /\ detached \in [Workers -> BOOLEAN]
  /\ retired \in [Workers -> BOOLEAN]
  /\ transportAlive \in [Workers -> BOOLEAN]
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
  /\ approved \in SUBSET Tasks
  /\ reviewed \in SUBSET Tasks
  /\ prevTaskState \in [Tasks -> TaskStates]
  /\ prevGeneration \in [Workers -> Generations]
  /\ prevPendingWake \in [Workers -> SUBSET Workers]
  /\ prevWakeTried \in [Workers -> BOOLEAN]

(* A1 -- ownership --------------------------------------------------------- *)
AtMostOneOwner ==
  \A w1, w2 \in Workers:
    (w1 # w2 /\ workerTask[w1] # None /\ workerTask[w2] # None
     /\ workerTask[w1] = workerTask[w2]) => FALSE

OwnerConsistent ==
  \A w \in Workers:
    (workerTask[w] # None) =>
      (taskState[workerTask[w]] \in {"running", "review"}
       /\ taskOwner[workerTask[w]] = w)

QueuedHasNoOwner ==
  \A t \in Tasks:
    (taskState[t] \in {"queued", "done", "blocked_internal", "blocked_human"})
      => taskOwner[t] = None

RunningTaskHasOwner ==
  \A t \in Tasks: (taskState[t] = "running") => taskOwner[t] # None
ReviewTaskHasOwner ==
  \A t \in Tasks: (taskState[t] = "review") => taskOwner[t] # None

(* A2 -- role gating is for CLAIMING; review is a separate capability -------- *)
NoClaimRoleViolation ==
  \A t \in Tasks: (taskState[t] = "running") => RoleEligible(t, taskOwner[t])

(* A review task's assignee is the SUBMITTER until a reviewer adopts it, so the  *)
(* pointer may be a non-reviewer.  What must hold is that whoever HOLDS a review  *)
(* task is a reviewer.                                                          *)
ReviewOwnerIsReviewer ==
  \A w \in Workers:
    (workerTask[w] # None /\ taskState[workerTask[w]] = "review") => CanReview(w)

(* A3 -- the three fences, separated ---------------------------------------- *)
(* Lease: the task's current lease is the one its owner last presented.       *)
LeaseFenceAgreement ==
  \A t \in Tasks:
    (taskState[t] \in {"running", "review"}) => lastLease[t] = taskLease[t]

(* Generation: the task's claim generation is the owner's current generation.  *)
GenerationFenceAgreement ==
  \A t \in Tasks:
    (taskState[t] \in {"running", "review"}) => taskGen[t] = generation[taskOwner[t]]

(* Session: a managed session always carries the worker's CURRENT generation.  *)
SessionFenceAgreement ==
  \A w \in Workers:
    (sessionManaged[w] /\ sessionGen[w] # 0) => sessionGen[w] = generation[w]

(* A4 -- a running task's owner is live and holds it ------------------------ *)
NoStaleMutation ==
  \A t \in Tasks:
    (taskState[t] = "running") =>
      \E w \in Workers:
        /\ taskOwner[t] = w
        /\ workerTask[w] = t
        /\ Operational(w)
        /\ workerLease[w] = taskLease[t]
        /\ sessionGen[w] = generation[w]

(* A5 -- generation never moves backwards or is reused --------------------- *)
GenerationMonotonicity ==
  /\ \A w \in Workers: generation[w] >= prevGeneration[w]
  /\ \A w \in Workers: generation[w] <= genWatermark[w]
  /\ \A w \in Workers: genWatermark[w] >= prevGeneration[w]

(* A6 -- done is reachable ONLY through Approve ---------------------------- *)
DoneOnlyByApprove ==
  \A t \in Tasks: (taskState[t] = "done") => t \in approved

(* A7 -- quiet is task-scoped, bounded, and the worker is working ------------ *)
QuietScoped ==
  \A w \in Workers:
    quietActive[w] =>
      /\ workerState[w] = "working"
      /\ workerTask[w] # None
      /\ taskState[workerTask[w]] = "running"
      /\ quietUntil[w] = workerTask[w]

(* A8 -- waiting_input occupancy ------------------------------------------- *)
NoWaitingInputClaim ==
  \A w \in Workers:
    (workerState[w] = "waiting_input") => (workerTask[w] # None /\ ClaimableBy(w) = {})

WaitingInputOccupancy ==
  \A w \in Workers:
    (workerState[w] = "waiting_input") => (workerTask[w] # None /\ taskOwner[workerTask[w]] = w)

NoIdleHoldsTask ==
  \A w \in Workers: (workerState[w] = "idle") => workerTask[w] = None

(* A9 -- nothing is activated or started before its durable row exists ------ *)
DurableBeforeDelivery ==
  \A w \in Workers:
    (activeRT[w] \/ workerState[w] # "starting") => rtDurable[w]

(* A10/A11 -- cleanup and adoption ------------------------------------------ *)
CleanupIsRelayOwned ==
  \A w \in Workers:
    /\ (\A g \in rtCleaned[w]: relayOwned[w] = TRUE)
    /\ (\A g \in rtCleaned[w]: g < generation[w])

AdoptedNeverReplaced ==
  \A w \in Workers: everAdopted[w] => relayOwned[w] = FALSE

(* A12 -- parent signals: present iff the child reached the state, one hop --- *)
ParentSignalsOneHop ==
  \A p \in Tasks: \A c \in parentDone[p] \cup parentBlocked[p]: parent[c] = p

ChildDoneSignalled ==
  \A c \in Tasks:
    (taskState[c] = "done" /\ parent[c] # None) => c \in parentDone[parent[c]]

ChildBlockedSignalled ==
  \A c \in Tasks:
    (taskState[c] \in {"blocked_internal", "blocked_human"} /\ parent[c] # None)
      => c \in parentBlocked[parent[c]]

ParentDoneMeansChildDone ==
  \A p \in Tasks: \A c \in parentDone[p]: taskState[c] = "done"
ParentBlockedMeansChildBlocked ==
  \A p \in Tasks: \A c \in parentBlocked[p]: taskState[c] \in {"blocked_internal", "blocked_human"}

(* A12b -- NO AUTOMATIC PARENT TRANSITION, as ACTION semantics.               *)
(* If a child's state changed in the last step, its parent's state did NOT.    *)
ParentStateStableByChildTransition ==
  \A c \in Tasks:
    (parent[c] # None /\ taskState[c] # prevTaskState[c])
      => taskState[parent[c]] = prevTaskState[parent[c]]

(* A12c -- a dead/retired worker is never operational (no wake obligation).  *)
DetachedNotOperational ==
  \A w \in Workers: (detached[w] \/ retired[w]) => ~Operational(w) /\ ~IdleOperational(w)

(* C4 -- a wake FAILURE never erases the durable pending signal.  If the       *)
(* pending signal was non-empty and became empty in a step, that step was not  *)
(* a wake attempt (it must have been an explicit Detach).                      *)
WakeFailureKeepsSignal ==
  \A w \in Workers:
    (prevPendingWake[w] # {} /\ pendingWake[w] = {} /\ ~detached[w]) => ~prevWakeTried[w]

(* A13 -- at a reconcile boundary, a dead transport is classified dead, even  *)
(* for a QUIET worker: quiet suppresses STALL suspicion, never transport death.*)
DeadTransportClassified ==
  Stable =>
    \A w \in Workers:
      (~transportAlive[w] /\ ~detached[w] /\ ~retired[w]) => workerState[w] = "dead"

(* B -- the CORE responsiveness property, at the reconcile boundary --------- *)
NoAvoidableIdleAtReconcileBoundary ==
  \A w \in Workers:
    (Stable /\ IdleOperational(w) /\ HasClaimableWork(w) /\ ~LegitSuppressed(w))
      => wakeTried[w]

NoWakeForUnclaimableWork ==
  \A w \in Workers: (wakeTried[w] => wakeEligible[w])

(* --------------------------------------------------------------------- *)
(* Helpers                                                                 *)
(* --------------------------------------------------------------------- *)
Requeue(t) ==
  /\ taskState' = [taskState EXCEPT ![t] = "queued"]
  /\ taskOwner' = [taskOwner EXCEPT ![t] = None]
  /\ taskLease' = [taskLease EXCEPT ![t] = taskLease[t] + 1]

(* --------------------------------------------------------------------- *)
(* ENVIRONMENT actions                                                     *)
(* --------------------------------------------------------------------- *)

(* A worker claims a queued task it is eligible for.  Atomic: pick + claim.  *)
Claim(w) ==
  \E t \in Tasks:
    /\ IdleOperational(w)
    /\ Runnable(t)
    /\ RoleEligible(t, w)
    /\ taskOwner[t] = None
    /\ stage' = 0
    /\ taskState' = [taskState EXCEPT ![t] = "running"]
    /\ taskOwner' = [taskOwner EXCEPT ![t] = w]
    /\ taskLease' = [taskLease EXCEPT ![t] = taskLease[t] + 1]
    /\ taskGen' = [taskGen EXCEPT ![t] = (IF generation[w] = 0 THEN 1 ELSE generation[w])]
    /\ lastLease' = [lastLease EXCEPT ![t] = (taskLease[t] + 1)]
    /\ workerTask' = [workerTask EXCEPT ![w] = t]
    /\ workerState' = [workerState EXCEPT ![w] = "working"]
    /\ workerLease' = [workerLease EXCEPT ![w] = (taskLease[t] + 1)]
    /\ generation' = [generation EXCEPT ![w] = (IF generation[w] = 0 THEN 1 ELSE generation[w])]
    /\ genOwner' = [genOwner EXCEPT ![w] = (IF generation[w] = 0 THEN 1 ELSE generation[w])]
    /\ genWatermark' = [genWatermark EXCEPT ![w] =
         (IF generation[w] = 0 THEN 1 ELSE generation[w])]
    /\ sessionGen' = [sessionGen EXCEPT ![w] = (IF generation[w] = 0 THEN 1 ELSE generation[w])]
    /\ sessionManaged' = [sessionManaged EXCEPT ![w] = TRUE]
    /\ transportAlive' = [transportAlive EXCEPT ![w] = TRUE]
    /\ activeRT' = [activeRT EXCEPT ![w] = TRUE]
    /\ rtDurable' = [rtDurable EXCEPT ![w] = TRUE]
    /\ stallSeen' = [stallSeen EXCEPT ![w] = FALSE]
    /\ quietActive' = [quietActive EXCEPT ![w] = FALSE]
    /\ quietUntil' = [quietUntil EXCEPT ![w] = None]
    /\ UNCHANGED << parent, relayOwned, everAdopted, detached, retired, hasMail, pendingWake,
                   wakeSuppressed, retryWake, wakeTried, wakeEligible, parentDone, parentBlocked,
                   rtCleaned, approved, reviewed, staleLease >>

(* A normal submit: running -> review, by the CURRENT owner through all fences. *)
Submit(t, w) ==
  /\ CanProgress(t, w)
  /\ stage' = 0
  /\ taskState' = [taskState EXCEPT ![t] = "review"]
  /\ lastLease' = [lastLease EXCEPT ![t] = workerLease[w]]
  /\ workerTask' = [workerTask EXCEPT ![w] = None]
  /\ workerState' = [workerState EXCEPT ![w] = "idle"]
  /\ quietActive' = [quietActive EXCEPT ![w] = FALSE]
  /\ quietUntil' = [quietUntil EXCEPT ![w] = None]
  /\ reviewed' = reviewed \cup {t}
  /\ UNCHANGED << taskOwner, taskLease, taskGen, parent, workerLease, staleLease, generation,
                  genOwner, genWatermark, relayOwned, sessionGen, sessionManaged, everAdopted,
                  detached, retired, transportAlive, hasMail, stallSeen, pendingWake,
                  wakeSuppressed, retryWake, wakeTried, wakeEligible, parentDone, parentBlocked,
                  activeRT, rtDurable, rtCleaned, approved >>

(* A STALE session submits: it presents the lease of a LEFTOVER session.  A     *)
(* correct Relay rejects this because staleLease # taskLease after any reclaim; *)
(* the guard below is the fence, and mutation M13 removes it.                   *)
StaleSubmit(t, w) ==
  /\ taskOwner[t] = w
  /\ workerTask[w] = t
  /\ taskState[t] = "running"
  /\ staleLease[w] = taskLease[t]                 \* the lease fence
  /\ stage' = 0
  /\ taskState' = [taskState EXCEPT ![t] = "review"]
  /\ lastLease' = [lastLease EXCEPT ![t] = staleLease[w]]
  /\ workerTask' = [workerTask EXCEPT ![w] = None]
  /\ workerState' = [workerState EXCEPT ![w] = "idle"]
  /\ reviewed' = reviewed \cup {t}
  /\ UNCHANGED << taskOwner, taskLease, taskGen, parent, workerLease, staleLease, generation,
                  genOwner, genWatermark, relayOwned, sessionGen, sessionManaged, everAdopted,
                  detached, retired, transportAlive, hasMail, quietUntil, quietActive, stallSeen,
                  pendingWake, wakeSuppressed, retryWake, wakeTried, wakeEligible, parentDone,
                  parentBlocked, activeRT, rtDurable, rtCleaned, approved >>

(* A REVIEWER adopts a review task (claimNext's reviewer path).  Review is a     *)
(* capability, NOT the task's claim role.  One writer per task.                 *)
AdoptReview(t, w) ==
  /\ taskState[t] = "review"
  /\ CanReview(w)
  /\ IdleOperational(w)
  /\ (\A x \in Workers: workerTask[x] # t)
  /\ stage' = 0
  /\ taskOwner' = [taskOwner EXCEPT ![t] = w]
  /\ taskLease' = [taskLease EXCEPT ![t] = taskLease[t] + 1]
  /\ taskGen' = [taskGen EXCEPT ![t] = (IF generation[w] = 0 THEN 1 ELSE generation[w])]
  /\ lastLease' = [lastLease EXCEPT ![t] = (taskLease[t] + 1)]
  /\ workerTask' = [workerTask EXCEPT ![w] = t]
  /\ workerState' = [workerState EXCEPT ![w] = "working"]
  /\ workerLease' = [workerLease EXCEPT ![w] = (taskLease[t] + 1)]
  /\ generation' = [generation EXCEPT ![w] = (IF generation[w] = 0 THEN 1 ELSE generation[w])]
  /\ genOwner' = [genOwner EXCEPT ![w] = (IF generation[w] = 0 THEN 1 ELSE generation[w])]
  /\ genWatermark' = [genWatermark EXCEPT ![w] = (IF generation[w] = 0 THEN 1 ELSE generation[w])]
  /\ sessionGen' = [sessionGen EXCEPT ![w] = (IF generation[w] = 0 THEN 1 ELSE generation[w])]
  /\ sessionManaged' = [sessionManaged EXCEPT ![w] = TRUE]
  /\ transportAlive' = [transportAlive EXCEPT ![w] = TRUE]
  /\ activeRT' = [activeRT EXCEPT ![w] = TRUE]
  /\ rtDurable' = [rtDurable EXCEPT ![w] = TRUE]
  /\ UNCHANGED << taskState, parent, staleLease, relayOwned, everAdopted, detached, retired,
                  hasMail, quietUntil, quietActive, stallSeen, pendingWake, wakeSuppressed,
                  retryWake, wakeTried, wakeEligible, parentDone, parentBlocked, rtCleaned,
                  approved, reviewed >>

(* review -> done.  THE ONLY PATH TO done.  Operator-permitted (approveTask does *)
(* not fence on owner), but the lease is invalidated and the one-hop parent      *)
(* signal commits atomically.                                                   *)
Approve(t, actor) ==
  /\ taskState[t] = "review"
  /\ actor \in Workers
  /\ stage' = 0
  /\ taskState' = [taskState EXCEPT ![t] = "done"]
  /\ taskOwner' = [taskOwner EXCEPT ![t] = None]
  /\ taskLease' = [taskLease EXCEPT ![t] = taskLease[t] + 1]
  /\ LET o == taskOwner[t] IN
       IF o = None THEN UNCHANGED << workerTask, staleLease, workerLease >>
       ELSE /\ workerTask' = [workerTask EXCEPT ![o] = None]
            /\ workerState' = [workerState EXCEPT ![o] = "idle"]
            /\ staleLease' = [staleLease EXCEPT ![o] = workerLease[o]]
            /\ workerLease' = [workerLease EXCEPT ![o] = 0]
  /\ quietActive' = [w \in Workers |->
       IF w = actor \/ (taskOwner[t] # None /\ w = taskOwner[t]) THEN FALSE ELSE quietActive[w]]
  /\ quietUntil' = [w \in Workers |->
       IF w = actor \/ (taskOwner[t] # None /\ w = taskOwner[t]) THEN None ELSE quietUntil[w]]
  /\ approved' = approved \cup {t}
  /\ LET p == parent[t] IN
       IF p = None
       THEN UNCHANGED << parentDone, parentBlocked >>
       ELSE /\ parentDone' = [parentDone EXCEPT ![p] = parentDone[p] \cup {t}]
            /\ parentBlocked' = [parentBlocked EXCEPT ![p] = parentBlocked[p] \ {t}]
  /\ UNCHANGED << taskGen, lastLease, parent, generation, genOwner, genWatermark, relayOwned,
                  sessionGen, sessionManaged, everAdopted, detached, retired, transportAlive,
                  hasMail, stallSeen, pendingWake, wakeSuppressed, retryWake, wakeTried,
                  wakeEligible, activeRT, rtDurable, rtCleaned, reviewed >>

(* review -> queued.  Operator-permitted; the lease is invalidated.             *)
Reject(t, actor) ==
  /\ RejectsAllowed
  /\ taskState[t] = "review"
  /\ actor \in Workers
  /\ stage' = 0
  /\ Requeue(t)
  /\ LET o == taskOwner[t] IN
       IF o = None THEN UNCHANGED << workerTask, staleLease, workerLease, workerState, quietActive, quietUntil >>
       ELSE /\ workerTask' = [workerTask EXCEPT ![o] = None]
            /\ workerState' = [workerState EXCEPT ![o] = "idle"]
            /\ staleLease' = [staleLease EXCEPT ![o] = workerLease[o]]
            /\ workerLease' = [workerLease EXCEPT ![o] = 0]
            /\ quietActive' = [quietActive EXCEPT ![o] = FALSE]
            /\ quietUntil' = [quietUntil EXCEPT ![o] = None]
  /\ UNCHANGED << taskGen, lastLease, parent, generation, genOwner, genWatermark, relayOwned,
                  sessionGen, sessionManaged, everAdopted, detached, retired, transportAlive,
                  hasMail, stallSeen, pendingWake, wakeSuppressed,
                  retryWake, wakeTried, wakeEligible, parentDone, parentBlocked, activeRT,
                  rtDurable, rtCleaned, approved, reviewed >>

(* NORMAL owner release: running -> queued, by the current owner.               *)
OwnerRelease(w, t) ==
  /\ ReleasesAllowed
  /\ CanProgress(t, w)
  /\ stage' = 0
  /\ Requeue(t)
  /\ workerTask' = [workerTask EXCEPT ![w] = None]
  /\ workerState' = [workerState EXCEPT ![w] = "idle"]
  /\ staleLease' = [staleLease EXCEPT ![w] = workerLease[w]]
  /\ workerLease' = [workerLease EXCEPT ![w] = 0]
  /\ quietActive' = [quietActive EXCEPT ![w] = FALSE]
  /\ quietUntil' = [quietUntil EXCEPT ![w] = None]
  /\ stallSeen' = [stallSeen EXCEPT ![w] = FALSE]
  /\ UNCHANGED << taskGen, lastLease, parent, generation, genOwner, genWatermark, relayOwned,
                  sessionGen, sessionManaged, everAdopted, detached, retired, transportAlive,
                  hasMail, pendingWake, wakeSuppressed, retryWake, wakeTried, wakeEligible,
                  parentDone, parentBlocked, activeRT, rtDurable, rtCleaned, approved, reviewed,
                  prevPendingWake, prevWakeTried >>

(* RECOVERY release: an external actor (operator / supervisor) revokes a running  *)
(* task.  It may ONLY invalidate ownership and requeue -- it can never advance    *)
(* the task to review/done/blocked.                                             *)
RecoveryRelease(actor, t) ==
  /\ ReleasesAllowed
  /\ actor \in Workers
  /\ taskState[t] = "running"
  /\ taskOwner[t] # actor
  /\ stage' = 0
  /\ Requeue(t)
  /\ LET o == taskOwner[t] IN
       IF o = None THEN UNCHANGED << workerTask, staleLease, workerLease, workerState, quietActive, quietUntil >>
       ELSE /\ workerTask' = [workerTask EXCEPT ![o] = None]
            /\ workerState' = [workerState EXCEPT ![o] = "idle"]
            /\ staleLease' = [staleLease EXCEPT ![o] = workerLease[o]]
            /\ workerLease' = [workerLease EXCEPT ![o] = 0]
            /\ quietActive' = [quietActive EXCEPT ![o] = FALSE]
            /\ quietUntil' = [quietUntil EXCEPT ![o] = None]
  /\ UNCHANGED << taskGen, lastLease, parent, generation, genOwner, genWatermark, relayOwned,
                  sessionGen, sessionManaged, everAdopted, detached, retired, transportAlive,
                  hasMail, stallSeen, pendingWake, wakeSuppressed,
                  retryWake, wakeTried, wakeEligible, parentDone, parentBlocked, activeRT,
                  rtDurable, rtCleaned, approved, reviewed >>

(* running -> blocked_*.  Operator-permitted (blockTask does not fence on owner). *)
Block(t, actor, human) ==
  /\ AllowFailure
  /\ taskState[t] = "running"
  /\ actor \in Workers
  /\ ~quietActive[actor]
  /\ stage' = 0
  /\ taskState' = [taskState EXCEPT ![t] = (IF human THEN "blocked_human" ELSE "blocked_internal")]
  /\ taskOwner' = [taskOwner EXCEPT ![t] = None]
  /\ taskLease' = [taskLease EXCEPT ![t] = taskLease[t] + 1]
  /\ LET o == taskOwner[t] IN
       IF o = None THEN UNCHANGED << workerTask, staleLease, workerLease, workerState >>
       ELSE /\ workerTask' = [workerTask EXCEPT ![o] = None]
            /\ workerState' = [workerState EXCEPT ![o] = "idle"]
            /\ staleLease' = [staleLease EXCEPT ![o] = workerLease[o]]
            /\ workerLease' = [workerLease EXCEPT ![o] = 0]
            /\ quietActive' = [quietActive EXCEPT ![o] = FALSE]
            /\ quietUntil' = [quietUntil EXCEPT ![o] = None]
  /\ LET p == parent[t] IN
       IF p = None
       THEN UNCHANGED << parentDone, parentBlocked >>
       ELSE /\ parentBlocked' = [parentBlocked EXCEPT ![p] = parentBlocked[p] \cup {t}]
            /\ parentDone' = [parentDone EXCEPT ![p] = parentDone[p] \ {t}]
  /\ UNCHANGED << taskGen, lastLease, parent, generation, genOwner, genWatermark, relayOwned,
                  sessionGen, sessionManaged, everAdopted, detached, retired, transportAlive,
                  hasMail, stallSeen, pendingWake, wakeSuppressed,
                  retryWake, wakeTried, wakeEligible, activeRT, rtDurable, rtCleaned, approved,
                  reviewed >>

(* blocked_* -> queued (human or operator).                                    *)
Unblock(t) ==
  /\ AllowFailure
  /\ taskState[t] \in {"blocked_internal", "blocked_human"}
  /\ stage' = 0
  /\ taskState' = [taskState EXCEPT ![t] = "queued"]
  /\ UNCHANGED << taskOwner, taskLease, taskGen, lastLease, parent, workerState, workerTask,
                  workerLease, staleLease, generation, genOwner, genWatermark, relayOwned,
                  sessionGen, sessionManaged, everAdopted, detached, retired, transportAlive,
                  hasMail, quietUntil, quietActive, stallSeen, pendingWake, wakeSuppressed,
                  retryWake, wakeTried, wakeEligible, parentDone, parentBlocked, activeRT,
                  rtDurable, rtCleaned, approved, reviewed >>

(* working -> waiting_input.  Task KEPT.  Asking for input supersedes quiet.    *)
WaitInput(w) ==
  /\ workerState[w] = "working"
  /\ workerTask[w] # None
  /\ stage' = 0
  /\ workerState' = [workerState EXCEPT ![w] = "waiting_input"]
  /\ quietActive' = [quietActive EXCEPT ![w] = FALSE]
  /\ quietUntil' = [quietUntil EXCEPT ![w] = None]
  /\ UNCHANGED << taskState, taskOwner, taskLease, taskGen, lastLease, parent, workerTask,
                  workerLease, staleLease, generation, genOwner, genWatermark, relayOwned,
                  sessionGen, sessionManaged, everAdopted, detached, retired, transportAlive,
                  hasMail, stallSeen, pendingWake, wakeSuppressed, retryWake, wakeTried,
                  wakeEligible, parentDone, parentBlocked, activeRT, rtDurable, rtCleaned,
                  approved, reviewed >>

(* waiting_input -> working.                                                   *)
TakeInput(w) ==
  /\ workerState[w] = "waiting_input"
  /\ stage' = 0
  /\ workerState' = [workerState EXCEPT ![w] = "working"]
  /\ UNCHANGED << taskState, taskOwner, taskLease, taskGen, lastLease, parent, workerTask,
                  workerLease, staleLease, generation, genOwner, genWatermark, relayOwned,
                  sessionGen, sessionManaged, everAdopted, detached, retired, transportAlive,
                  hasMail, quietUntil, quietActive, stallSeen, pendingWake, wakeSuppressed,
                  retryWake, wakeTried, wakeEligible, parentDone, parentBlocked, activeRT,
                  rtDurable, rtCleaned, approved, reviewed >>

(* A working task-owner declares a bounded session-idle.                       *)
QuietStart(w) ==
  /\ workerState[w] = "working"
  /\ workerTask[w] # None
  /\ taskState[workerTask[w]] = "running"
  /\ stage' = 0
  /\ quietActive' = [quietActive EXCEPT ![w] = TRUE]
  /\ quietUntil' = [quietUntil EXCEPT ![w] = workerTask[w]]
  /\ UNCHANGED << taskState, taskOwner, taskLease, taskGen, lastLease, parent, workerState,
                  workerTask, workerLease, staleLease, generation, genOwner, genWatermark,
                  relayOwned, sessionGen, sessionManaged, everAdopted, detached, retired,
                  transportAlive, hasMail, stallSeen, pendingWake, wakeSuppressed, retryWake,
                  wakeTried, wakeEligible, parentDone, parentBlocked, activeRT, rtDurable,
                  rtCleaned, approved, reviewed >>

(* The quiet deadline lapses (M4 disables this).                               *)
QuietExpire(w) ==
  /\ quietActive[w]
  /\ stage' = 0
  /\ quietActive' = [quietActive EXCEPT ![w] = FALSE]
  /\ quietUntil' = [quietUntil EXCEPT ![w] = None]
  /\ UNCHANGED << taskState, taskOwner, taskLease, taskGen, lastLease, parent, workerState,
                  workerTask, workerLease, staleLease, generation, genOwner, genWatermark,
                  relayOwned, sessionGen, sessionManaged, everAdopted, detached, retired,
                  transportAlive, hasMail, stallSeen, pendingWake, wakeSuppressed, retryWake,
                  wakeTried, wakeEligible, parentDone, parentBlocked, activeRT, rtDurable,
                  rtCleaned, approved, reviewed >>

(* A peer sends a durable signal -- any worker state, quiet included.          *)
Deliver(w, p) ==
  /\ p # w
  /\ stage' = 0
  /\ hasMail' = [hasMail EXCEPT ![w] = hasMail[w] \cup {p}]
  /\ pendingWake' = [pendingWake EXCEPT ![w] = pendingWake[w] \cup {p}]
  /\ UNCHANGED << taskState, taskOwner, taskLease, taskGen, lastLease, parent, workerState,
                  workerTask, workerLease, staleLease, generation, genOwner, genWatermark,
                  relayOwned, sessionGen, sessionManaged, everAdopted, detached, retired,
                  transportAlive, quietUntil, quietActive, stallSeen, wakeSuppressed, retryWake,
                  wakeTried, wakeEligible, parentDone, parentBlocked, activeRT, rtDurable,
                  rtCleaned, approved, reviewed >>

AckMail(w, p) ==
  /\ p \in hasMail[w]
  /\ stage' = 0
  /\ hasMail' = [hasMail EXCEPT ![w] = hasMail[w] \ {p}]
  /\ UNCHANGED << taskState, taskOwner, taskLease, taskGen, lastLease, parent, workerState,
                  workerTask, workerLease, staleLease, generation, genOwner, genWatermark,
                  relayOwned, sessionGen, sessionManaged, everAdopted, detached, retired,
                  transportAlive, quietUntil, quietActive, stallSeen, pendingWake, wakeSuppressed,
                  retryWake, wakeTried, wakeEligible, parentDone, parentBlocked, activeRT,
                  rtDurable, rtCleaned, approved, reviewed >>

(* The transport delivers the prompt the supervisor asked for.                 *)
WakeDelivered(w) ==
  /\ wakeTried[w]
  /\ stage' = 0
  /\ wakeTried' = [wakeTried EXCEPT ![w] = FALSE]
  /\ retryWake' = [retryWake EXCEPT ![w] = FALSE]
  /\ wakeSuppressed' = [wakeSuppressed EXCEPT ![w] = AllowCooldown]
  /\ UNCHANGED << taskState, taskOwner, taskLease, taskGen, lastLease, parent, workerState,
                  workerTask, workerLease, staleLease, generation, genOwner, genWatermark,
                  relayOwned, sessionGen, sessionManaged, everAdopted, detached, retired,
                  transportAlive, hasMail, quietUntil, quietActive, stallSeen, pendingWake,
                  wakeEligible, parentDone, parentBlocked, activeRT, rtDurable, rtCleaned,
                  approved, reviewed >>

(* The transport fails;  the durable signal survives (M18 erases it).          *)
WakeFails(w) ==
  /\ wakeTried[w]
  /\ stage' = 0
  /\ wakeTried' = [wakeTried EXCEPT ![w] = FALSE]
  /\ retryWake' = [retryWake EXCEPT ![w] = TRUE]
  /\ UNCHANGED << taskState, taskOwner, taskLease, taskGen, lastLease, parent, workerState,
                  workerTask, workerLease, staleLease, generation, genOwner, genWatermark,
                  relayOwned, sessionGen, sessionManaged, everAdopted, detached, retired,
                  transportAlive, hasMail, quietUntil, quietActive, stallSeen, pendingWake,
                  wakeSuppressed, wakeEligible, parentDone, parentBlocked, activeRT, rtDurable,
                  rtCleaned, approved, reviewed >>

RetryWake(w) ==
  /\ retryWake[w]
  /\ stage' = 0
  /\ retryWake' = [retryWake EXCEPT ![w] = FALSE]
  /\ wakeTried' = [wakeTried EXCEPT ![w] = TRUE]
  /\ UNCHANGED << taskState, taskOwner, taskLease, taskGen, lastLease, parent, workerState,
                  workerTask, workerLease, staleLease, generation, genOwner, genWatermark,
                  relayOwned, sessionGen, sessionManaged, everAdopted, detached, retired,
                  transportAlive, hasMail, quietUntil, quietActive, stallSeen, pendingWake,
                  wakeSuppressed, wakeEligible, parentDone, parentBlocked, activeRT, rtDurable,
                  rtCleaned, approved, reviewed >>

(* The runtime transport dies.  Relay must CLASSIFY it dead (Reconcile), even   *)
(* while the worker is quiet.                                                  *)
TransportDies(w) ==
  /\ AllowFailure
  /\ transportAlive[w]
  /\ stage' = 0
  /\ transportAlive' = [transportAlive EXCEPT ![w] = FALSE]
  /\ UNCHANGED << taskState, taskOwner, taskLease, taskGen, lastLease, parent, workerState,
                  workerTask, workerLease, staleLease, generation, genOwner, genWatermark,
                  relayOwned, sessionGen, sessionManaged, everAdopted, detached, retired,
                  hasMail, quietUntil, quietActive, stallSeen, pendingWake, wakeSuppressed,
                  retryWake, wakeTried, wakeEligible, parentDone, parentBlocked, activeRT,
                  rtDurable, rtCleaned, approved, reviewed >>

(* The transport comes back (a revive path or a fresh spawn).                  *)
TransportRevives(w) ==
  /\ AllowFailure
  /\ ~transportAlive[w]
  /\ stage' = 0
  /\ transportAlive' = [transportAlive EXCEPT ![w] = TRUE]
  /\ UNCHANGED << taskState, taskOwner, taskLease, taskGen, lastLease, parent, workerState,
                  workerTask, workerLease, staleLease, generation, genOwner, genWatermark,
                  relayOwned, sessionGen, sessionManaged, everAdopted, detached, retired,
                  hasMail, quietUntil, quietActive, stallSeen, pendingWake, wakeSuppressed,
                  retryWake, wakeTried, wakeEligible, parentDone, parentBlocked, activeRT,
                  rtDurable, rtCleaned, approved, reviewed >>

(* A new generation is allocated: strictly newer (genWatermark + 1), and it     *)
(* becomes the only generation allowed to mutate.  M15 reuses/rewinds it.       *)
RestartOwned(w) ==
  /\ AllowFailure
  /\ relayOwned[w] = TRUE
  /\ workerState[w] = "dead"
  /\ generation[w] < MaxGeneration
  /\ stage' = 0
  /\ LET g2 == genWatermark[w] + 1 IN
     /\ generation' = [generation EXCEPT ![w] = g2]
     /\ genWatermark' = [genWatermark EXCEPT ![w] = g2]
     /\ genOwner' = [genOwner EXCEPT ![w] = g2]
  /\ workerState' = [workerState EXCEPT ![w] = "starting"]
  /\ workerTask' = [workerTask EXCEPT ![w] = None]
  /\ sessionManaged' = [sessionManaged EXCEPT ![w] = FALSE]
  /\ activeRT' = [activeRT EXCEPT ![w] = TRUE]
  /\ rtDurable' = [rtDurable EXCEPT ![w] = TRUE]
  /\ quietActive' = [quietActive EXCEPT ![w] = FALSE]
  /\ quietUntil' = [quietUntil EXCEPT ![w] = None]
  /\ stallSeen' = [stallSeen EXCEPT ![w] = FALSE]
  /\ UNCHANGED << taskState, taskOwner, taskLease, taskGen, lastLease, parent, workerLease,
                  staleLease, relayOwned, sessionGen, everAdopted, detached, retired,
                  transportAlive, hasMail, pendingWake, wakeSuppressed, retryWake, wakeTried,
                  wakeEligible, parentDone, parentBlocked, rtCleaned, approved, reviewed,
                  prevPendingWake, prevWakeTried >>

(* The fresh generation finishes attaching: starting -> idle.                  *)
Attach(w) ==
  /\ workerState[w] = "starting"
  /\ rtDurable[w]
  /\ stage' = 0
  /\ workerState' = [workerState EXCEPT ![w] = "idle"]
  /\ sessionGen' = [sessionGen EXCEPT ![w] = generation[w]]
  /\ sessionManaged' = [sessionManaged EXCEPT ![w] = TRUE]
  /\ UNCHANGED << taskState, taskOwner, taskLease, taskGen, lastLease, parent, workerTask,
                  workerLease, staleLease, generation, genOwner, genWatermark, relayOwned,
                  everAdopted, detached, retired, transportAlive, hasMail, quietUntil,
                  quietActive, stallSeen, pendingWake, wakeSuppressed, retryWake, wakeTried,
                  wakeEligible, parentDone, parentBlocked, activeRT, rtDurable, rtCleaned,
                  approved, reviewed >>

(* The gateEvent fence: an attach presenting a generation OLDER than the        *)
(* worker's is rejected.  M7 removes the fence (`<=`), letting a stale          *)
(* generation become the live session.                                         *)
StaleAttach(w, g) ==
  /\ AllowFailure
  /\ g \in Generations
  /\ g = generation[w]                    \* the gateEvent fence
  /\ stage' = 0
  /\ sessionGen' = [sessionGen EXCEPT ![w] = g]
  /\ sessionManaged' = [sessionManaged EXCEPT ![w] = TRUE]
  /\ UNCHANGED << taskState, taskOwner, taskLease, taskGen, lastLease, parent, workerState,
                  workerTask, workerLease, staleLease, generation, genOwner, genWatermark,
                  relayOwned, everAdopted, detached, retired, transportAlive, hasMail,
                  quietUntil, quietActive, stallSeen, pendingWake, wakeSuppressed, retryWake,
                  wakeTried, wakeEligible, parentDone, parentBlocked, activeRT, rtDurable,
                  rtCleaned, approved, reviewed >>

(* Relay begins supervising an EXTERNAL runtime it does not own.               *)
Adopt(w) ==
  /\ AllowFailure
  /\ relayOwned[w] = TRUE
  /\ stage' = 0
  /\ relayOwned' = [relayOwned EXCEPT ![w] = FALSE]
  /\ everAdopted' = [everAdopted EXCEPT ![w] = TRUE]
  /\ UNCHANGED << taskState, taskOwner, taskLease, taskGen, lastLease, parent, workerState,
                  workerTask, workerLease, staleLease, generation, genOwner, genWatermark,
                  sessionGen, sessionManaged, detached, retired, transportAlive, hasMail,
                  quietUntil, quietActive, stallSeen, pendingWake, wakeSuppressed, retryWake,
                  wakeTried, wakeEligible, parentDone, parentBlocked, activeRT, rtDurable,
                  rtCleaned, approved, reviewed >>

(* An adopted worker that is ALIVE but was misclassified dead is REVIVED.       *)
(* A truly dead adopted runtime is NOT replaced by Relay (M9 takes it over).    *)
ReviveAdopted(w) ==
  /\ AllowFailure
  /\ relayOwned[w] = FALSE
  /\ workerState[w] = "dead"
  /\ transportAlive[w]
  /\ stage' = 0
  /\ workerState' = [workerState EXCEPT ![w] = "idle"]
  /\ stallSeen' = [stallSeen EXCEPT ![w] = FALSE]
  /\ sessionGen' = [sessionGen EXCEPT ![w] = generation[w]]
  /\ sessionManaged' = [sessionManaged EXCEPT ![w] = TRUE]
  /\ UNCHANGED << taskState, taskOwner, taskLease, taskGen, lastLease, parent, workerTask,
                  workerLease, staleLease, generation, genOwner, genWatermark, relayOwned,
                  everAdopted, detached, retired, transportAlive, hasMail, quietUntil,
                  quietActive, pendingWake, wakeSuppressed, retryWake, wakeTried, wakeEligible,
                  parentDone, parentBlocked, activeRT, rtDurable, rtCleaned, approved, reviewed,
                  prevPendingWake, prevWakeTried >>

(* A stall: an owned running task stops progressing.  Quiet SUPPRESSES it.     *)
Stall(w) ==
  /\ AllowFailure
  /\ workerState[w] = "working"
  /\ workerTask[w] # None
  /\ taskState[workerTask[w]] = "running"
  /\ ~quietActive[w]
  /\ stage' = 0
  /\ stallSeen' = [stallSeen EXCEPT ![w] = TRUE]
  /\ UNCHANGED << taskState, taskOwner, taskLease, taskGen, lastLease, parent, workerState,
                  workerTask, workerLease, staleLease, generation, genOwner, genWatermark,
                  relayOwned, sessionGen, sessionManaged, everAdopted, detached, retired,
                  transportAlive, hasMail, quietUntil, quietActive, pendingWake, wakeSuppressed,
                  retryWake, wakeTried, wakeEligible, parentDone, parentBlocked, activeRT,
                  rtDurable, rtCleaned, approved, reviewed >>

(* A stall that was nudged and did not recover: requeue with a bumped lease.    *)
ReleaseStalled(w) ==
  /\ stallSeen[w]
  /\ workerState[w] = "working"
  /\ workerTask[w] # None
  /\ stage' = 0
  /\ Requeue(workerTask[w])
  /\ workerTask' = [workerTask EXCEPT ![w] = None]
  /\ workerState' = [workerState EXCEPT ![w] = "idle"]
  /\ staleLease' = [staleLease EXCEPT ![w] = workerLease[w]]
  /\ workerLease' = [workerLease EXCEPT ![w] = 0]
  /\ stallSeen' = [stallSeen EXCEPT ![w] = FALSE]
  /\ quietActive' = [quietActive EXCEPT ![w] = FALSE]
  /\ quietUntil' = [quietUntil EXCEPT ![w] = None]
  /\ UNCHANGED << taskGen, lastLease, parent, generation, genOwner, genWatermark, relayOwned,
                  sessionGen, sessionManaged, everAdopted, detached, retired, transportAlive,
                  hasMail, pendingWake, wakeSuppressed, retryWake,
                  wakeTried, wakeEligible, parentDone, parentBlocked, activeRT, rtDurable,
                  rtCleaned, approved, reviewed >>

(* The cooldown lapses (M4' disables this).                                    *)
CooldownExpire(w) ==
  /\ AllowCooldown
  /\ wakeSuppressed[w]
  /\ stage' = 0
  /\ wakeSuppressed' = [wakeSuppressed EXCEPT ![w] = FALSE]
  /\ UNCHANGED << taskState, taskOwner, taskLease, taskGen, lastLease, parent, workerState,
                  workerTask, workerLease, staleLease, generation, genOwner, genWatermark,
                  relayOwned, sessionGen, sessionManaged, everAdopted, detached, retired,
                  transportAlive, hasMail, quietUntil, quietActive, stallSeen, pendingWake,
                  retryWake, wakeTried, wakeEligible, parentDone, parentBlocked, activeRT,
                  rtDurable, rtCleaned, approved, reviewed >>

(* The environment detaches a worker for good; it leaves the supervised set.    *)
Detach(w) ==
  /\ AllowFailure
  /\ ~detached[w]
  /\ stage' = 0
  /\ detached' = [detached EXCEPT ![w] = TRUE]
  /\ sessionManaged' = [sessionManaged EXCEPT ![w] = FALSE]
  /\ relayOwned' = [relayOwned EXCEPT ![w] = FALSE]
  /\ everAdopted' = [everAdopted EXCEPT ![w] = TRUE]
  /\ pendingWake' = [pendingWake EXCEPT ![w] = {}]
  /\ quietActive' = [quietActive EXCEPT ![w] = FALSE]
  /\ quietUntil' = [quietUntil EXCEPT ![w] = None]
  /\ UNCHANGED << taskState, taskOwner, taskLease, taskGen, lastLease, parent, workerState,
                  workerTask, workerLease, staleLease, generation, genOwner, genWatermark,
                  retired, sessionGen, transportAlive, hasMail, stallSeen, wakeSuppressed,
                  retryWake, wakeTried, wakeEligible, parentDone, parentBlocked, activeRT,
                  rtDurable, rtCleaned, approved, reviewed >>

(* A worker is retired: history only, never supervised.                        *)
Retire(w) ==
  /\ AllowFailure
  /\ ~retired[w]
  /\ stage' = 0
  /\ retired' = [retired EXCEPT ![w] = TRUE]
  /\ sessionManaged' = [sessionManaged EXCEPT ![w] = FALSE]
  /\ UNCHANGED << taskState, taskOwner, taskLease, taskGen, lastLease, parent, workerState,
                  workerTask, workerLease, staleLease, generation, genOwner, genWatermark,
                  relayOwned, sessionGen, everAdopted, detached, transportAlive, hasMail,
                  quietUntil, quietActive, stallSeen, pendingWake, wakeSuppressed, retryWake,
                  wakeTried, wakeEligible, parentDone, parentBlocked, activeRT, rtDurable,
                  rtCleaned, approved, reviewed >>

Environment ==
  \/ \E w \in Workers: \E t \in Tasks: Submit(t, w)
  \/ \E w \in Workers: \E t \in Tasks: StaleSubmit(t, w)
  \/ \E w \in Workers: Claim(w)
  \/ \E t \in Tasks: \E w \in Workers: AdoptReview(t, w)
  \/ \E t \in Tasks: \E a \in Workers: Approve(t, a)
  \/ \E t \in Tasks: \E a \in Workers: Reject(t, a)
  \/ \E w \in Workers: \E t \in Tasks: OwnerRelease(w, t)
  \/ \E a \in Workers: \E t \in Tasks: RecoveryRelease(a, t)
  \/ \E t \in Tasks: \E a \in Workers: \E human \in BOOLEAN: Block(t, a, human)
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
  \/ \E w \in Workers: TransportDies(w)
  \/ \E w \in Workers: TransportRevives(w)
  \/ \E w \in Workers: RestartOwned(w)
  \/ \E w \in Workers: Attach(w)
  \/ \E w \in Workers: \E g \in Generations: StaleAttach(w, g)
  \/ \E w \in Workers: Adopt(w)
  \/ \E w \in Workers: ReviveAdopted(w)
  \/ \E w \in Workers: Stall(w)
  \/ \E w \in Workers: ReleaseStalled(w)
  \/ \E w \in Workers: CooldownExpire(w)
  \/ \E w \in Workers: Detach(w)
  \/ \E w \in Workers: Retire(w)

(* ===================================================================== *)
(* SUPERVISOR -- one reconcile pass per tick.                              *)
(* ===================================================================== *)

(* Every worker a CORRECT supervisor attempts to wake this pass.               *)
EligibleWakees ==
  { w \in Workers :
      Operational(w)
      /\ (   pendingWake[w] # {}
           \/ (\E t \in Tasks: t \in ClaimableBy(w) /\ taskOwner[t] = None))
      /\ ~wakeSuppressed[w] /\ ~retryWake[w] }

WakeSet(W) ==
  /\ W \subseteq Workers
  /\ \A w \in W:
       (   Operational(w)
        /\ (pendingWake[w] # {} \/ (\E t \in Tasks: t \in ClaimableBy(w) /\ taskOwner[t] = None))
        /\ ~wakeSuppressed[w] /\ ~retryWake[w])
  /\ wakeTried' = [w \in Workers |-> (w \in W)]
  /\ wakeEligible' = [w \in Workers |->
       IF w \in W THEN (pendingWake[w] # {} \/ HasClaimableWork(w)) ELSE wakeEligible[w]]

(* Transport-death classification happens IN the reconcile pass, so it is       *)
(* quiet-AGNOSTIC and checkable as a boundary safety property.  M17 makes the    *)
(* classification conditional on ~quietActive.                                  *)
DeadSet == { w \in Workers : ~transportAlive[w] /\ Operational(w) }

TaskHeldByDead(t) == \E w \in DeadSet: workerTask[w] = t /\ taskState[t] = "running"

Reconcile ==
  /\ stage' = 1
  /\ WakeSet(EligibleWakees)
  /\ LET Dead == DeadSet IN
     /\ workerState' = [w \in Workers |-> IF w \in Dead THEN "dead" ELSE workerState[w]]
     /\ workerTask' = [w \in Workers |-> IF w \in Dead THEN None ELSE workerTask[w]]
     /\ sessionManaged' = [w \in Workers |-> IF w \in Dead THEN FALSE ELSE sessionManaged[w]]
     /\ quietActive' = [w \in Workers |-> IF w \in Dead THEN FALSE ELSE quietActive[w]]
     /\ quietUntil' = [w \in Workers |-> IF w \in Dead THEN None ELSE quietUntil[w]]
     /\ stallSeen' = [w \in Workers |-> IF w \in Dead THEN FALSE ELSE stallSeen[w]]
     /\ staleLease' = [w \in Workers |-> IF w \in Dead THEN workerLease[w] ELSE staleLease[w]]
     /\ workerLease' = [w \in Workers |-> IF w \in Dead THEN 0 ELSE workerLease[w]]
     /\ taskState' = [t \in Tasks |-> IF TaskHeldByDead(t) THEN "queued" ELSE taskState[t]]
     /\ taskOwner' = [t \in Tasks |-> IF TaskHeldByDead(t) THEN None ELSE taskOwner[t]]
     /\ taskLease' = [t \in Tasks |-> IF TaskHeldByDead(t) THEN taskLease[t] + 1 ELSE taskLease[t]]
  /\ \E ToReap \in [Workers -> SUBSET RealGenerations]:
        /\ \A w \in Workers: \A g \in ToReap[w]:
             /\ relayOwned[w] = TRUE
             /\ g < generation[w]
             /\ g < genOwner[w]
        /\ rtCleaned' = [w \in Workers |-> rtCleaned[w] \cup ToReap[w]]
  /\ UNCHANGED << taskGen, lastLease, parent, generation, genOwner, genWatermark, relayOwned,
                  everAdopted, detached, retired, transportAlive, sessionGen, hasMail,
                  pendingWake, wakeSuppressed, retryWake, parentDone, parentBlocked, activeRT,
                  rtDurable, approved, reviewed >>

Tick ==
  /\ (Environment \/ Reconcile)
  /\ prevTaskState' = taskState
  /\ prevGeneration' = generation
  /\ prevPendingWake' = pendingWake
  /\ prevWakeTried' = wakeTried

(* --------------------------------------------------------------------- *)
(* Initial state                                                           *)
(* --------------------------------------------------------------------- *)
Init ==
  /\ stage = 0
  /\ taskState = [t \in Tasks |-> "queued"]
  /\ taskOwner = [t \in Tasks |-> None]
  /\ taskLease = [t \in Tasks |-> 0]
  /\ taskGen = [t \in Tasks |-> 0]
  /\ lastLease = [t \in Tasks |-> 0]
  /\ parent = [t \in Tasks |-> ParentTask(t)]
  /\ workerState = [w \in Workers |-> "idle"]
  /\ workerTask = [w \in Workers |-> None]
  /\ workerLease = [w \in Workers |-> 0]
  /\ staleLease = [w \in Workers |-> 0]
  /\ generation = [w \in Workers |-> 0]
  /\ genOwner = [w \in Workers |-> 0]
  /\ genWatermark = [w \in Workers |-> 0]
  /\ relayOwned = [w \in Workers |-> TRUE]
  /\ sessionGen = [w \in Workers |-> 0]
  /\ sessionManaged = [w \in Workers |-> TRUE]
  /\ everAdopted = [w \in Workers |-> FALSE]
  /\ detached = [w \in Workers |-> FALSE]
  /\ retired = [w \in Workers |-> FALSE]
  /\ transportAlive = [w \in Workers |-> TRUE]
  /\ hasMail = [w \in Workers |-> {}]
  /\ quietUntil = [w \in Workers |-> None]
  /\ quietActive = [w \in Workers |-> FALSE]
  /\ stallSeen = [w \in Workers |-> FALSE]
  /\ pendingWake = [w \in Workers |-> {}]
  /\ wakeSuppressed = [w \in Workers |-> FALSE]
  /\ retryWake = [w \in Workers |-> FALSE]
  /\ wakeTried = [w \in Workers |-> FALSE]
  /\ wakeEligible = [w \in Workers |-> FALSE]
  /\ parentDone = [t \in Tasks |-> {}]
  /\ parentBlocked = [t \in Tasks |-> {}]
  /\ activeRT = [w \in Workers |-> FALSE]
  /\ rtDurable = [w \in Workers |-> TRUE]
  /\ rtCleaned = [w \in Workers |-> {}]
  /\ approved = {}
  /\ reviewed = {}
  /\ prevTaskState = [t \in Tasks |-> "queued"]
  /\ prevGeneration = [w \in Workers |-> 0]
  /\ prevPendingWake = [w \in Workers |-> {}]
  /\ prevWakeTried = [w \in Workers |-> FALSE]

(* --------------------------------------------------------------------- *)
(* Fairness.  Minimal: only what Relay itself owes (the supervisor loop and *)
(* its bounded deadlines).  An implementation defect must not be hidden     *)
(* behind a fairness conjunct.                                             *)
(* --------------------------------------------------------------------- *)
LivenessFairness ==
  /\ WF_baseVars(Reconcile)
  /\ \A w \in Workers: WF_baseVars(CooldownExpire(w))
  /\ \A w \in Workers: WF_baseVars(QuietExpire(w))
  /\ \A w \in Workers: WF_baseVars(RetryWake(w))

(* Environment-assumption fairness (Level D).                              *)
EnvFairness ==
  /\ \A w \in Workers: WF_baseVars(Claim(w))
  /\ \A w \in Workers: \A t \in Tasks: WF_baseVars(Submit(t, w))
  /\ \A t \in Tasks: \A w \in Workers: WF_baseVars(AdoptReview(t, w))
  /\ \A t \in Tasks: \A a \in Workers: WF_baseVars(Approve(t, a))
  /\ \A w \in Workers: WF_baseVars(TakeInput(w))

Spec == Init /\ [][Tick]_vars
FairSpec == Init /\ [][Tick]_vars /\ LivenessFairness
CompletionSpec == FairSpec /\ EnvFairness

(* --------------------------------------------------------------------- *)
(* Temporal properties                                                     *)
(* --------------------------------------------------------------------- *)
NoPermanentStranding ==
  (ActionableWork # {}) ~> (ActionableWork = {})

NoPermanentCooldown ==
  \A w \in Workers: wakeSuppressed[w] ~> ~wakeSuppressed[w]

NoPermanentQuiet ==
  \A w \in Workers: quietActive[w] ~> ~quietActive[w]

NoLostWake ==
  \A w \in Workers: (pendingWake[w] # {}) ~> wakeTried[w]

AllTasksDone ==
  <>( \A t \in Tasks: taskState[t] = "done" )

===========================================================================
