------------------------------ MODULE Relay ------------------------------
(***************************************************************************)
(* Relay control-plane model.  Scope, fairness, environment assumptions and *)
(* the TLA+ <-> TypeScript mapping live in formal/README.md.               *)
(***************************************************************************)
(* Relay control-plane model.  See formal/README.md for scope, the TLA+ <-> *)
(* TypeScript mapping, fairness and environment assumptions.                *)
(*                                                                         *)
(* Goal: TLC finds no execution in which runnable work exists while every   *)
(* supervised worker is permanently stopped, and (under documented          *)
(* fairness) no task is abandoned while Relay still supervises a worker.    *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences
CONSTANTS
  Tasks, Workers,       \* finite sets, e.g. {t1,t2}, {w1,w2}
  MaxGeneration,        \* bound on the per-worker fencing number
  LeaseMax,             \* bound on the claim/fence token (used as a modulus)
  AllowFailure,         \* TRUE => a worker turn may nondeterministically fail
  FailureBudget,        \* shared bound on environment failures per worker (Crash/
                        \* DetectStall/AttachTimeout/BlockInternal share one counter)
  AllowDetach           \* TRUE => the environment may permanently detach a worker
None == "none"
Gen == 0..MaxGeneration                 \* 0 = "no generation"
Generations == 1..MaxGeneration
Runtimes == Workers \X Gen
TaskStates == {"queued","running","review","done","blocked_human","blocked_internal","failed"}
TerminalTaskStates == {"done","blocked_human","failed"}
WorkerStates == {"starting","idle","working","waiting_input","stalled","dead"}
RuntimeStates == {"none","starting","active","stale","dead","cleaned"}
VARIABLES taskState, taskOwner, taskLease, taskReviewed,
          workerState, workerTask, workerGeneration, workerLease, workerWoken,
          permissionPending, detached, failureCount,
          sessionManaged, sessionGeneration,
          runtimeState, runtimePersisted, runtimeRelayOwned, runtimeBootstrapSent,
          genWatermark, genAtPrev
\* Variable groups, used to write UNCHANGED compactly (nested tuples).
TV == <<taskState, taskOwner, taskLease, taskReviewed>>
WV == <<workerState, workerTask, workerGeneration, workerLease, workerWoken>>
PV == <<permissionPending, detached, failureCount>>
SV == <<sessionManaged, sessionGeneration>>
RV == <<runtimeState, runtimePersisted, runtimeRelayOwned, runtimeBootstrapSent>>
GV == <<genWatermark>>
baseVars ==
  << taskState, taskOwner, taskLease, taskReviewed,
     workerState, workerTask, workerGeneration, workerLease, workerWoken,
     permissionPending, detached, failureCount,
     sessionManaged, sessionGeneration,
     runtimeState, runtimePersisted, runtimeRelayOwned, runtimeBootstrapSent,
     genWatermark >>
vars ==
  << taskState, taskOwner, taskLease, taskReviewed,
     workerState, workerTask, workerGeneration, workerLease, workerWoken,
     permissionPending, detached, failureCount,
     sessionManaged, sessionGeneration,
     runtimeState, runtimePersisted, runtimeRelayOwned, runtimeBootstrapSent,
     genWatermark, genAtPrev >>
NextGen(w) == genWatermark[w] + 1
FreshLease(t) == (taskLease[t] + 1) % (LeaseMax + 1)   \* always changes, never exhausts
Operational(w) ==
  /\ ~detached[w]
  /\ (sessionManaged[w]
      \/ (workerState[w] = "starting" /\ workerGeneration[w] > 0
          /\ runtimeRelayOwned[w, workerGeneration[w]]
          /\ runtimeState[w, workerGeneration[w]] = "starting"))
NoPendingSpawn(w) == \A g \in Generations : runtimeState[w,g] # "starting"
CanRecover(w) ==
  /\ ~detached[w] /\ workerState[w] \in {"dead","stalled"} /\ workerGeneration[w] > 0
  /\ (runtimeRelayOwned[w, workerGeneration[w]] \/ sessionManaged[w])
Supervised(w) == Operational(w) \/ CanRecover(w)
Failed(w) == workerState[w] \in {"dead","stalled"}
SessionCurrent(w) == sessionManaged[w] /\ sessionGeneration[w] = workerGeneration[w]
RunnableExists == \E t \in Tasks : taskState[t] = "queued"
ReviewExists == \E t \in Tasks : taskState[t] = "review"
WorkerWorking == \E w \in Workers : workerState[w] = "working" /\ workerTask[w] # None
HasSupervised == \E w \in Workers : Supervised(w)
RecoveryInProgress == \E w \in Workers : workerState[w] = "starting" \/ CanRecover(w)
IdleOperational ==
  \E w \in Workers : Operational(w) /\ workerState[w] = "idle" /\ workerTask[w] = None
\* WAITING_FOR_HUMAN: nothing runnable/reviewable and every unfinished task is
HumanOnlyWaiting ==
  /\ \A t \in Tasks : taskState[t] \in {"done","failed","blocked_human"}
  /\ \E t \in Tasks : taskState[t] = "blocked_human"
Init ==
  /\ taskState = [t \in Tasks |-> "queued"]        /\ taskOwner = [t \in Tasks |-> None]
  /\ taskLease = [t \in Tasks |-> 0]               /\ taskReviewed = [t \in Tasks |-> FALSE]
  /\ workerState = [w \in Workers |-> "idle"]      /\ workerTask = [w \in Workers |-> None]
  /\ workerGeneration = [w \in Workers |-> 0]      /\ workerLease = [w \in Workers |-> 0]
  /\ workerWoken = [w \in Workers |-> FALSE]       /\ permissionPending = [w \in Workers |-> FALSE]
  /\ detached = [w \in Workers |-> FALSE]          /\ failureCount = [w \in Workers |-> 0]
  /\ sessionManaged = [w \in Workers |-> FALSE]    /\ sessionGeneration = [w \in Workers |-> 0]
  /\ runtimeState = [r \in Runtimes |-> "none"]    /\ runtimePersisted = [r \in Runtimes |-> FALSE]
  /\ runtimeRelayOwned = [r \in Runtimes |-> FALSE]
  /\ runtimeBootstrapSent = [r \in Runtimes |-> FALSE]
  /\ genWatermark = [w \in Workers |-> 0]          /\ genAtPrev = [w \in Workers |-> 0]

SpawnTransport(w) ==
  /\ ~detached[w] /\ workerTask[w] = None /\ NoPendingSpawn(w) /\ NextGen(w) <= MaxGeneration
  /\ (workerState[w] \in {"dead","stalled"} \/ (~sessionManaged[w] /\ workerState[w] = "idle"))
  /\ LET g == NextGen(w) IN
       /\ runtimeState' = [runtimeState EXCEPT ![w,g] = "starting"] /\ runtimePersisted' = [runtimePersisted EXCEPT ![w,g] = FALSE]
       /\ runtimeRelayOwned' = [runtimeRelayOwned EXCEPT ![w,g] = TRUE] /\ runtimeBootstrapSent' = [runtimeBootstrapSent EXCEPT ![w,g] = FALSE]
       /\ genWatermark' = [genWatermark EXCEPT ![w] = g]
  /\ UNCHANGED <<TV, WV, PV, SV>>
\* Durable commit: row exists and the worker points at it BEFORE bootstrap/wake.
PersistRuntime(w) ==
  /\ ~detached[w]
  /\ (\E g \in Generations :
        /\ runtimeState[w,g] = "starting" /\ runtimeRelayOwned[w,g] /\ ~runtimePersisted[w,g]
        /\ runtimePersisted' = [runtimePersisted EXCEPT ![w,g] = TRUE] /\ workerGeneration' = [workerGeneration EXCEPT ![w] = g]
        /\ workerState' = [workerState EXCEPT ![w] = "starting"] /\ workerTask' = [workerTask EXCEPT ![w] = None]
        /\ workerWoken' = [workerWoken EXCEPT ![w] = FALSE] /\ workerLease' = [workerLease EXCEPT ![w] = 0]
        /\ permissionPending' = [permissionPending EXCEPT ![w] = FALSE] /\ sessionManaged' = [sessionManaged EXCEPT ![w] = FALSE])
  /\ UNCHANGED <<TV, <<detached, failureCount, sessionGeneration,   runtimeState, runtimeRelayOwned, runtimeBootstrapSent>>, GV>>
BootstrapDelivered(w) ==
  /\ ~detached[w] /\ workerState[w] = "starting" /\ workerGeneration[w] > 0
  /\ LET g == workerGeneration[w] IN
       /\ runtimeState[w,g] = "starting" /\ runtimePersisted[w,g] /\ ~runtimeBootstrapSent[w,g]
       /\ runtimeBootstrapSent' = [runtimeBootstrapSent EXCEPT ![w,g] = TRUE]
  /\ UNCHANGED <<TV, WV, PV, SV, <<runtimeState, runtimePersisted, runtimeRelayOwned>>, GV>>
BootstrapFailed(w) ==
  /\ ~detached[w] /\ workerState[w] = "starting" /\ workerGeneration[w] > 0
  /\ runtimeState[w, workerGeneration[w]] = "starting"
  /\ runtimePersisted[w, workerGeneration[w]] /\ ~runtimeBootstrapSent[w, workerGeneration[w]]
  /\ UNCHANGED baseVars
Attach(w) ==
  /\ ~detached[w] /\ workerState[w] = "starting" /\ workerGeneration[w] > 0
  /\ LET g == workerGeneration[w] IN
       /\ runtimeState[w,g] = "starting" /\ runtimePersisted[w,g]
       /\ runtimeRelayOwned[w,g] /\ runtimeBootstrapSent[w,g]
       /\ runtimeState' = [runtimeState EXCEPT ![w,g] = "active"] /\ sessionManaged' = [sessionManaged EXCEPT ![w] = TRUE]
       /\ sessionGeneration' = [sessionGeneration EXCEPT ![w] = g] /\ workerState' = [workerState EXCEPT ![w] = "idle"]
       /\ workerWoken' = [workerWoken EXCEPT ![w] = FALSE]
  /\ UNCHANGED <<TV, <<workerTask, workerGeneration, workerLease, permissionPending,   detached, failureCount, runtimePersisted, runtimeRelayOwned,   runtimeBootstrapSent>>, GV>>
\* An attach timeout consumes one unit of the shared failure budget but STAYS
\* relay-owned (recoverable).
AttachTimeout(w) ==
  /\ ~detached[w] /\ workerState[w] = "starting" /\ workerGeneration[w] > 0
  /\ failureCount[w] < FailureBudget
  /\ LET g == workerGeneration[w] IN
       /\ runtimeState[w,g] = "starting" /\ runtimePersisted[w,g] /\ runtimeRelayOwned[w,g]
       /\ runtimeState' = [runtimeState EXCEPT ![w,g] = "dead"] /\ workerState' = [workerState EXCEPT ![w] = "dead"]
       /\ sessionManaged' = [sessionManaged EXCEPT ![w] = FALSE] /\ failureCount' = [failureCount EXCEPT ![w] = failureCount[w] + 1]
  /\ UNCHANGED <<TV, <<workerTask, workerGeneration, workerLease, workerWoken,   permissionPending, detached, sessionGeneration,   runtimePersisted, runtimeRelayOwned, runtimeBootstrapSent>>, GV>>
ManualAttach(w) ==
  /\ ~detached[w] /\ NoPendingSpawn(w) /\ workerTask[w] = None /\ ~sessionManaged[w]
  /\ workerState[w] = "idle" /\ NextGen(w) <= MaxGeneration
  /\ LET g == NextGen(w) IN
       /\ runtimeState' = [runtimeState EXCEPT ![w,g] = "active"] /\ runtimePersisted' = [runtimePersisted EXCEPT ![w,g] = TRUE]
       /\ runtimeRelayOwned' = [runtimeRelayOwned EXCEPT ![w,g] = FALSE] /\ runtimeBootstrapSent' = [runtimeBootstrapSent EXCEPT ![w,g] = FALSE]
       /\ genWatermark' = [genWatermark EXCEPT ![w] = g] /\ workerGeneration' = [workerGeneration EXCEPT ![w] = g]
       /\ sessionManaged' = [sessionManaged EXCEPT ![w] = TRUE] /\ sessionGeneration' = [sessionGeneration EXCEPT ![w] = g]
       /\ workerWoken' = [workerWoken EXCEPT ![w] = FALSE]
  /\ UNCHANGED <<TV, <<workerState, workerTask, workerLease>>, PV>>
Detach(w) ==
  /\ AllowDetach
  /\ sessionManaged[w] /\ NoPendingSpawn(w) /\ workerState[w] = "idle" /\ workerTask[w] = None
  /\ sessionManaged' = [sessionManaged EXCEPT ![w] = FALSE] /\ detached' = [detached EXCEPT ![w] = TRUE]
  /\ workerWoken' = [workerWoken EXCEPT ![w] = FALSE] /\ permissionPending' = [permissionPending EXCEPT ![w] = FALSE]
  /\ UNCHANGED <<TV, <<workerState, workerTask, workerGeneration, workerLease,   failureCount, sessionGeneration>>, RV, GV>>
\* Core loop invariant: runnable work + idle operational worker => wake it.
Wake(w) ==
  /\ ~detached[w] /\ Operational(w) /\ workerState[w] = "idle"
  /\ workerTask[w] = None /\ RunnableExists
  /\ workerWoken' = [workerWoken EXCEPT ![w] = TRUE]
  /\ UNCHANGED <<TV, <<workerState, workerTask, workerGeneration, workerLease>>, PV, SV, RV, GV>>
MarkStale(w) ==
  /\ ~detached[w] /\ Failed(w) /\ workerGeneration[w] > 0
  /\ runtimeState[w, workerGeneration[w]] \in {"starting","active"}
  /\ runtimeState' = [runtimeState EXCEPT ![w, workerGeneration[w]] = "stale"]
  /\ UNCHANGED <<TV, WV, PV, SV, <<runtimePersisted, runtimeRelayOwned, runtimeBootstrapSent>>, GV>>
\* Transport gone -> generation dead (cleanup-eligible after grace).
DetectDead(w) ==
  /\ ~detached[w] /\ workerState[w] = "dead" /\ workerGeneration[w] > 0
  /\ runtimeState[w, workerGeneration[w]] \in {"starting","active"}
  /\ runtimeState' = [runtimeState EXCEPT ![w, workerGeneration[w]] = "dead"]
  /\ UNCHANGED <<TV, WV, PV, SV, <<runtimePersisted, runtimeRelayOwned, runtimeBootstrapSent>>, GV>>
\* Reap an OLD relay-owned stale/dead generation.  Never current, never adopted.
Cleanup(w,g) ==
  /\ runtimeRelayOwned[w,g] /\ runtimeState[w,g] \in {"stale","dead"}
  /\ workerGeneration[w] > 0 /\ g < workerGeneration[w]
  /\ runtimeState' = [runtimeState EXCEPT ![w,g] = "cleaned"]
  /\ UNCHANGED <<TV, WV, PV, SV, <<runtimePersisted, runtimeRelayOwned, runtimeBootstrapSent>>, GV>>

Claim(w) ==
  /\ ~detached[w] /\ SessionCurrent(w) /\ workerWoken[w]
  /\ workerState[w] = "idle" /\ workerTask[w] = None
  /\ (\E t \in Tasks :
        /\ taskState[t] = "queued"
        /\ taskState' = [taskState EXCEPT ![t] = "running"] /\ taskOwner' = [taskOwner EXCEPT ![t] = w]
        /\ taskLease' = [taskLease EXCEPT ![t] = FreshLease(t)] /\ workerLease' = [workerLease EXCEPT ![w] = FreshLease(t)]
        /\ workerTask' = [workerTask EXCEPT ![w] = t] /\ workerState' = [workerState EXCEPT ![w] = "working"]
        /\ workerWoken' = [workerWoken EXCEPT ![w] = FALSE])
  /\ UNCHANGED <<<<taskReviewed>>, <<workerGeneration>>, PV, SV, RV, GV>>
\* Heartbeat.  Never changes task state.
Progress(w) ==
  /\ SessionCurrent(w) /\ workerState[w] = "working" /\ workerTask[w] # None
  /\ UNCHANGED baseVars
Submit(w) ==
  /\ SessionCurrent(w) /\ workerState[w] = "working" /\ workerTask[w] # None
  /\ LET t == workerTask[w] IN
       /\ taskState[t] = "running" /\ taskOwner[t] = w /\ workerLease[w] = taskLease[t]
       /\ taskState' = [taskState EXCEPT ![t] = "review"] /\ taskOwner' = [taskOwner EXCEPT ![t] = None]
       /\ taskReviewed' = [taskReviewed EXCEPT ![t] = TRUE] /\ workerTask' = [workerTask EXCEPT ![w] = None]
       /\ workerState' = [workerState EXCEPT ![w] = "idle"]
  /\ UNCHANGED <<<<taskLease>>, <<workerGeneration, workerLease, workerWoken>>, PV, SV, RV, GV>>
BlockHuman(w) ==
  /\ SessionCurrent(w) /\ workerState[w] = "working" /\ workerTask[w] # None
  /\ LET t == workerTask[w] IN
       /\ taskState[t] = "running" /\ taskOwner[t] = w /\ workerLease[w] = taskLease[t]
       /\ taskState' = [taskState EXCEPT ![t] = "blocked_human"] /\ taskOwner' = [taskOwner EXCEPT ![t] = None]
       /\ taskLease' = [taskLease EXCEPT ![t] = FreshLease(t)] /\ workerTask' = [workerTask EXCEPT ![w] = None]
       /\ workerState' = [workerState EXCEPT ![w] = "idle"]
  /\ UNCHANGED <<<<taskReviewed>>, <<workerGeneration, workerLease, workerWoken>>, PV, SV, RV, GV>>
\* Internal block: consumes the shared failure budget (env assumption); still
\* retryable, so blocked_internal is NOT terminal.
BlockInternal(w) ==
  /\ SessionCurrent(w) /\ failureCount[w] < FailureBudget /\ workerState[w] = "working" /\ workerTask[w] # None
  /\ LET t == workerTask[w] IN
       /\ taskState[t] = "running" /\ taskOwner[t] = w /\ workerLease[w] = taskLease[t]
       /\ taskState' = [taskState EXCEPT ![t] = "blocked_internal"] /\ taskOwner' = [taskOwner EXCEPT ![t] = None]
       /\ taskLease' = [taskLease EXCEPT ![t] = FreshLease(t)] /\ workerTask' = [workerTask EXCEPT ![w] = None]
       /\ workerState' = [workerState EXCEPT ![w] = "idle"]
  /\ failureCount' = [failureCount EXCEPT ![w] = failureCount[w] + 1]
  /\ UNCHANGED <<<<taskReviewed>>, <<workerGeneration, workerLease, workerWoken>>, <<permissionPending, detached>>, SV, RV, GV>>
\* working -> waiting_input.  waiting_input is OCCUPIED (still holds its task).
PermissionAsked(w) ==
  /\ SessionCurrent(w) /\ workerState[w] = "working" /\ workerTask[w] # None
  /\ permissionPending' = [permissionPending EXCEPT ![w] = TRUE] /\ workerState' = [workerState EXCEPT ![w] = "waiting_input"]
  /\ UNCHANGED <<TV, <<workerTask, workerGeneration, workerLease, workerWoken>>, <<detached, failureCount>>, SV, RV, GV>>
PermissionReplied(w) ==
  /\ SessionCurrent(w) /\ workerState[w] = "waiting_input"
  /\ permissionPending' = [permissionPending EXCEPT ![w] = FALSE] /\ workerState' = [workerState EXCEPT ![w] = IF workerTask[w] # None THEN "working" ELSE "idle"]
  /\ UNCHANGED <<TV, <<workerTask, workerGeneration, workerLease, workerWoken>>, <<detached, failureCount>>, SV, RV, GV>>
\* session.idle is NEVER completion.
IdleSignal(w) ==
  /\ SessionCurrent(w) /\ workerState[w] \in {"working","idle"}
  /\ UNCHANGED baseVars
Fail(w) ==
  /\ AllowFailure /\ SessionCurrent(w) /\ workerState[w] = "working" /\ workerTask[w] # None
  /\ LET t == workerTask[w] IN
       /\ taskState[t] = "running" /\ taskOwner[t] = w
       /\ taskState' = [taskState EXCEPT ![t] = "failed"] /\ taskOwner' = [taskOwner EXCEPT ![t] = None]
       /\ workerTask' = [workerTask EXCEPT ![w] = None] /\ workerState' = [workerState EXCEPT ![w] = "idle"]
  /\ UNCHANGED <<<<taskLease, taskReviewed>>, <<workerGeneration, workerLease, workerWoken>>, PV, SV, RV, GV>>
\* Crash / stall.  Each consumes one unit of the SHARED failure budget.
Crash(w) ==
  /\ Operational(w) /\ failureCount[w] < FailureBudget /\ workerState[w] \in {"idle","working","waiting_input"}
  /\ failureCount' = [failureCount EXCEPT ![w] = failureCount[w] + 1] /\ workerState' = [workerState EXCEPT ![w] = "dead"]
  /\ permissionPending' = [permissionPending EXCEPT ![w] = FALSE]
  /\ UNCHANGED <<TV, <<workerTask, workerGeneration, workerLease, workerWoken>>, <<detached>>, SV, RV, GV>>
DetectStall(w) ==
  /\ SessionCurrent(w) /\ failureCount[w] < FailureBudget /\ workerState[w] = "working" /\ workerTask[w] # None
  /\ failureCount' = [failureCount EXCEPT ![w] = failureCount[w] + 1] /\ workerState' = [workerState EXCEPT ![w] = "stalled"]
  /\ UNCHANGED <<TV, <<workerTask, workerGeneration, workerLease, workerWoken>>, <<permissionPending, detached>>, SV, RV, GV>>
Requeue(w) ==
  /\ Failed(w) /\ workerTask[w] # None
  /\ LET t == workerTask[w] IN
       /\ taskState[t] = "running" /\ taskOwner[t] = w
       /\ taskState' = [taskState EXCEPT ![t] = "queued"] /\ taskLease' = [taskLease EXCEPT ![t] = FreshLease(t)]
       /\ taskOwner' = [taskOwner EXCEPT ![t] = None] /\ workerTask' = [workerTask EXCEPT ![w] = None]
       /\ workerWoken' = [workerWoken EXCEPT ![w] = FALSE]
  /\ UNCHANGED <<<<taskReviewed>>, <<workerState, workerGeneration, workerLease>>, PV, SV, RV, GV>>

\* The ONLY way to done: running -> review -> Approve.
Approve(t) ==
  /\ taskState[t] = "review"
  /\ taskState' = [taskState EXCEPT ![t] = "done"] /\ taskOwner' = [taskOwner EXCEPT ![t] = None]
  /\ UNCHANGED <<<<taskLease, taskReviewed>>, WV, PV, SV, RV, GV>>
Reject(t) ==
  /\ taskState[t] = "review"
  /\ taskState' = [taskState EXCEPT ![t] = "queued"] /\ taskLease' = [taskLease EXCEPT ![t] = FreshLease(t)]
  /\ taskOwner' = [taskOwner EXCEPT ![t] = None]
  /\ UNCHANGED <<<<taskReviewed>>, WV, PV, SV, RV, GV>>
\* blocked_internal is retryable, NOT terminal.
RetryInternal(t) ==
  /\ taskState[t] = "blocked_internal"
  /\ taskState' = [taskState EXCEPT ![t] = "queued"]
  /\ UNCHANGED <<<<taskOwner, taskLease, taskReviewed>>, WV, PV, SV, RV, GV>>
UnblockHuman(t) ==
  /\ taskState[t] = "blocked_human"
  /\ taskState' = [taskState EXCEPT ![t] = "queued"]
  /\ UNCHANGED <<<<taskOwner, taskLease, taskReviewed>>, WV, PV, SV, RV, GV>>

Next ==
  /\ (  \/ (\E w \in Workers : SpawnTransport(w))   \/ (\E w \in Workers : PersistRuntime(w))
         \/ (\E w \in Workers : BootstrapDelivered(w)) \/ (\E w \in Workers : BootstrapFailed(w))
         \/ (\E w \in Workers : Attach(w))          \/ (\E w \in Workers : AttachTimeout(w))
         \/ (\E w \in Workers : ManualAttach(w))    \/ (\E w \in Workers : Detach(w))
         \/ (\E w \in Workers : Wake(w))            \/ (\E w \in Workers : Claim(w))
         \/ (\E w \in Workers : Progress(w))        \/ (\E w \in Workers : Submit(w))
         \/ (\E w \in Workers : BlockHuman(w))      \/ (\E w \in Workers : BlockInternal(w))
         \/ (\E w \in Workers : PermissionAsked(w)) \/ (\E w \in Workers : PermissionReplied(w))
         \/ (\E w \in Workers : IdleSignal(w))      \/ (\E w \in Workers : Fail(w))
         \/ (\E w \in Workers : Crash(w))           \/ (\E w \in Workers : DetectStall(w))
         \/ (\E w \in Workers : DetectDead(w))      \/ (\E w \in Workers : Requeue(w))
         \/ (\E w \in Workers : MarkStale(w))       \/ (\E w \in Workers, g \in Generations : Cleanup(w,g))
         \/ (\E t \in Tasks : Approve(t))           \/ (\E t \in Tasks : Reject(t))
         \/ (\E t \in Tasks : RetryInternal(t))     \/ (\E t \in Tasks : UnblockHuman(t)) )
  /\ genAtPrev' = workerGeneration
Spec == Init /\ [][Next]_vars
\* Combined DECISIONS.  The environment assumption is only that an agent which
\* can decide does not stutter forever -- NOT that every outcome occurs.  The
\* worker may submit / block internally / block on the human / fail, and the
\* reviewer may approve / reject; the choice stays nondeterministic.
WorkerDecision(w) ==
  \/ Submit(w) \/ BlockHuman(w) \/ BlockInternal(w) \/ Fail(w)
ReviewDecision(t) ==
  \/ Approve(t) \/ Reject(t)
\* Fairness (normal liveness): supervisor chain is weak-fair; each worker/reviewer
\* DECISION is strong-fair, so a live decision state cannot be postponed forever.
\* See formal/README.md ("Fairness and environment assumptions").
Fairness ==
  /\ \A w \in Workers : WF_baseVars(SpawnTransport(w))    /\ WF_baseVars(PersistRuntime(w))
  /\ \A w \in Workers : WF_baseVars(BootstrapDelivered(w)) /\ WF_baseVars(Attach(w))
  /\ \A w \in Workers : WF_baseVars(Wake(w))              /\ WF_baseVars(Claim(w))
  /\ \A w \in Workers : WF_baseVars(Requeue(w))           /\ WF_baseVars(MarkStale(w))
  /\ \A w \in Workers : WF_baseVars(DetectDead(w))        /\ WF_baseVars(PermissionReplied(w))
  /\ \A w \in Workers : SF_baseVars(WorkerDecision(w))
  /\ \A t \in Tasks   : SF_baseVars(ReviewDecision(t))
  /\ \A t \in Tasks   : WF_baseVars(RetryInternal(t))     /\ WF_baseVars(UnblockHuman(t))
SpecFair == Spec /\ Fairness

\* Property C ONLY (RelayDone.cfg): the environment additionally chooses each
\* outcome "well" -- it eventually submits, never keeps a task in human-block, and
\* eventually approves.  These per-outcome assumptions are deliberately isolated
\* here and are NOT part of normal liveness (RelayLiveness.cfg uses SpecFair).
StrongFairness ==
  /\ \A w \in Workers : WF_baseVars(SpawnTransport(w))    /\ WF_baseVars(PersistRuntime(w))
  /\ \A w \in Workers : WF_baseVars(BootstrapDelivered(w)) /\ WF_baseVars(Attach(w))
  /\ \A w \in Workers : WF_baseVars(Wake(w))              /\ WF_baseVars(Claim(w))
  /\ \A w \in Workers : WF_baseVars(Requeue(w))           /\ WF_baseVars(MarkStale(w))
  /\ \A w \in Workers : WF_baseVars(DetectDead(w))        /\ WF_baseVars(PermissionReplied(w))
  /\ \A w \in Workers : SF_baseVars(Submit(w))            /\ SF_baseVars(BlockInternal(w))
  /\ \A t \in Tasks   : SF_baseVars(Approve(t))
  /\ \A t \in Tasks   : WF_baseVars(RetryInternal(t))     /\ WF_baseVars(UnblockHuman(t))
SpecDone == Spec /\ StrongFairness

TypeOK ==
  /\ taskState \in [Tasks -> TaskStates]            /\ taskOwner \in [Tasks -> Workers \cup {None}]
  /\ taskLease \in [Tasks -> 0..LeaseMax]           /\ taskReviewed \in [Tasks -> BOOLEAN]
  /\ workerState \in [Workers -> WorkerStates]      /\ workerTask \in [Workers -> Tasks \cup {None}]
  /\ workerGeneration \in [Workers -> 0..MaxGeneration]
  /\ workerLease \in [Workers -> 0..LeaseMax]       /\ workerWoken \in [Workers -> BOOLEAN]
  /\ permissionPending \in [Workers -> BOOLEAN]     /\ detached \in [Workers -> BOOLEAN]
  /\ failureCount \in [Workers -> 0..FailureBudget]  /\ sessionManaged \in [Workers -> BOOLEAN]
  /\ sessionGeneration \in [Workers -> 0..MaxGeneration]
  /\ runtimeState \in [Runtimes -> RuntimeStates]   /\ runtimePersisted \in [Runtimes -> BOOLEAN]
  /\ runtimeRelayOwned \in [Runtimes -> BOOLEAN]    /\ runtimeBootstrapSent \in [Runtimes -> BOOLEAN]
  /\ genWatermark \in [Workers -> 0..MaxGeneration] /\ genAtPrev \in [Workers -> 0..MaxGeneration]
  /\ \A w \in Workers : runtimeState[w,0] = "none"
SingleTaskOwner ==
  \A w \in Workers : workerTask[w] # None => taskOwner[workerTask[w]] = w
WorkerTaskConsistency ==
  \A w \in Workers :
    /\ (workerState[w] \in {"working","waiting_input"} => workerTask[w] # None)
    /\ (workerTask[w] # None => taskOwner[workerTask[w]] = w /\ taskState[workerTask[w]] = "running")
    /\ (workerState[w] = "idle" => workerTask[w] = None)
RunningTaskHasOwner ==
  \A t \in Tasks :
    /\ (taskState[t] = "running" => taskOwner[t] # None)
    /\ (taskState[t] \in {"queued","review","done","blocked_human","blocked_internal","failed"}
        => taskOwner[t] = None)
\* A permission wait is occupied: it is never woken or claimed over.
NoWaitingInputClaim ==
  \A w \in Workers :
    workerState[w] = "waiting_input" =>
      /\ workerTask[w] # None /\ workerWoken[w] = FALSE
      /\ \A t \in Tasks : taskOwner[t] = w => t = workerTask[w]
\* A detached worker is never operational, recoverable, woken or restarted.
DetachedNotOperational ==
  \A w \in Workers : detached[w] => ~Operational(w) /\ ~CanRecover(w) /\ ~Supervised(w)
\* Generation never moves backwards (genAtPrev is the previous generation).
GenerationMonotonicity ==
  \A w \in Workers : workerGeneration[w] >= genAtPrev[w]
CurrentRuntimeNeverCleaned ==
  \A w \in Workers : workerGeneration[w] > 0 => runtimeState[w, workerGeneration[w]] # "cleaned"
NonRelayOwnedNeverCleaned ==
  \A r \in Runtimes : runtimeState[r] = "cleaned" => runtimeRelayOwned[r]
\* A managed session always carries the worker's current generation, so a stale
StaleSessionCannotMutateCurrent ==
  \A w \in Workers : sessionManaged[w] => sessionGeneration[w] = workerGeneration[w]
AttachRequiresPersistedRuntime ==
  \A w \in Workers :
    /\ \A g \in Generations : runtimeState[w,g] = "active" => runtimePersisted[w,g]
    /\ (sessionManaged[w] => runtimePersisted[w, sessionGeneration[w]])
BootstrapRequiresPersistedRuntime ==
  \A w \in Workers, g \in Generations : runtimeBootstrapSent[w,g] => runtimePersisted[w,g]
\* An attach timeout keeps a relay-owned failed generation supervised.
AttachTimeoutStaysSupervised ==
  \A w \in Workers :
    (workerGeneration[w] > 0 /\ runtimeRelayOwned[w, workerGeneration[w]]
     /\ runtimeState[w, workerGeneration[w]] \in {"starting","dead","stale"}) => Supervised(w)
\* idle / session.idle is NEVER completion: done only after review.
DoneRequiresReview ==
  \A t \in Tasks : taskState[t] = "done" => taskReviewed[t]
\* The central invariant: runnable work + nobody working always has a legitimate
QuiescenceIsLegitimate ==
  (RunnableExists /\ ~WorkerWorking)
  => ( ~HasSupervised \/ RecoveryInProgress \/ IdleOperational
       \/ (\E w \in Workers : Supervised(w) /\ workerState[w] = "waiting_input") )
\* Same, covering tasks sitting in review.
QuiescenceCoversReview ==
  (ReviewExists /\ ~WorkerWorking)
  => ( ~HasSupervised \/ RecoveryInProgress \/ IdleOperational
       \/ (\E w \in Workers : Supervised(w) /\ workerState[w] = "waiting_input") )

\* Property A (Relay's own obligation).
RunnableEventuallyMoves ==
  []( (RunnableExists /\ HasSupervised /\ ~HumanOnlyWaiting)
      => <>( WorkerWorking \/ ~RunnableExists \/ HumanOnlyWaiting \/ ~HasSupervised ) )
\* Property B (worker/reviewer fairness): no task stalls forever inside a LIVE
\* decision state.  `running` waits on the worker, `review` waits on the reviewer;
\* under decision-level fairness each such wait ends.  The OUTCOME stays
\* nondeterministic (the environment may keep rejecting / re-blocking), so the
\* stronger "eventually done" claim is Property C only.
TaskProgress ==
  []( (HasSupervised /\ \E t \in Tasks : taskState[t] \in {"running","review"})
      => <> ( ~HasSupervised
              \/ (\A t \in Tasks : taskState[t] \notin {"running","review"}) ) )
\* Property C (optional, stronger environment assumptions: SpecDone).
AllTasksDone == <>( \A t \in Tasks : taskState[t] = "done" )
=============================================================================
