#!/usr/bin/env bash
# Counterexample-quality check for the Relay formal model.
#
#   formal/run-mutations.sh
#
# A green TLC run only proves the properties hold for THIS spec.  It says
# nothing about whether the spec is strong enough to catch the bugs it exists
# to catch.  This script mutates one ACTION at a time and asserts, for EACH
# mutation:
#
#   1. baseline spec + the exact same config/property PASSES
#   2. the mutated spec FAILS
#   3. it fails by the SPECIFICALLY EXPECTED property
#
# A mutation that changes an invariant is forbidden: only actions, guards and
# state updates are mutated.  A baseline that is already red makes the test
# invalid, and a mutant that survives (or fails the wrong property) means the
# MODEL has a hole -- fix the model, not the test.
#
# Exits non-zero if any mutation is invalid, survives, or fails the wrong thing.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
tools="$here/.tools"
jar="$tools/tla2tools.jar"
version="${TLA2TOOLS_VERSION:-v1.7.4}"

if [ ! -f "$jar" ]; then
  mkdir -p "$tools"
  curl -fsSL "https://github.com/tlaplus/tlaplus/releases/download/${version}/tla2tools.jar" -o "$jar"
fi

work="$(mktemp -d /tmp/relay-mut-XXXXXX)"
trap 'rm -rf "$work" formal/MutM*.tla' EXIT
# TLC cannot read an absolute -config when the SPEC is also an absolute path in a
# different directory; run from the repo root with a relative spec path.
repo="$(cd "$here/.." && pwd)"
cd "$repo"

pass=0; fail=0; bad=()

# --- constant blocks --------------------------------------------------------
K_2x2=$'  Tasks = {"t1", "t2"}\n  Workers = {"w1", "w2"}\n  Roots = {"t1", "t2"}\n  Edges = {}\n  MaxGeneration = 2\n  AllowFailure = FALSE\n  AllowCooldown = TRUE\n  ReleasesAllowed = TRUE\n  RejectsAllowed = TRUE\n  ReviewerWorkers = {"w1"}\n  RoleTask = "none"\n  RoleWorker = "none"'
K_2x2f=$'  Tasks = {"t1", "t2"}\n  Workers = {"w1", "w2"}\n  Roots = {"t1", "t2"}\n  Edges = {}\n  MaxGeneration = 2\n  AllowFailure = TRUE\n  AllowCooldown = TRUE\n  ReleasesAllowed = TRUE\n  RejectsAllowed = TRUE\n  ReviewerWorkers = {"w1"}\n  RoleTask = "none"\n  RoleWorker = "none"'
K_1x1f=$'  Tasks = {"t1"}\n  Workers = {"w1"}\n  Roots = {"t1"}\n  Edges = {}\n  MaxGeneration = 2\n  AllowFailure = TRUE\n  AllowCooldown = TRUE\n  ReleasesAllowed = TRUE\n  RejectsAllowed = TRUE\n  ReviewerWorkers = {"w1"}\n  RoleTask = "none"\n  RoleWorker = "none"'
K_1x1g3=$'  Tasks = {"t1"}\n  Workers = {"w1"}\n  Roots = {"t1"}\n  Edges = {}\n  MaxGeneration = 3\n  AllowFailure = TRUE\n  AllowCooldown = TRUE\n  ReleasesAllowed = TRUE\n  RejectsAllowed = TRUE\n  ReviewerWorkers = {"w1"}\n  RoleTask = "none"\n  RoleWorker = "none"'
K_tree=$'  Tasks = {"P", "C", "G"}\n  Workers = {"w1"}\n  Roots = {"P"}\n  Edges = {"P:C", "C:G"}\n  MaxGeneration = 2\n  AllowFailure = FALSE\n  AllowCooldown = FALSE\n  ReleasesAllowed = TRUE\n  RejectsAllowed = TRUE\n  ReviewerWorkers = {"w1"}\n  RoleTask = "none"\n  RoleWorker = "none"'
K_role=$'  Tasks = {"t1", "t2"}\n  Workers = {"w1", "w2"}\n  Roots = {"t1", "t2"}\n  Edges = {}\n  MaxGeneration = 2\n  AllowFailure = FALSE\n  AllowCooldown = TRUE\n  ReleasesAllowed = TRUE\n  RejectsAllowed = TRUE\n  ReviewerWorkers = {"w2"}\n  RoleTask = "t1"\n  RoleWorker = "w1"'
K_mail=$'  Tasks = {"t1"}\n  Workers = {"w1", "w2"}\n  Roots = {"t1"}\n  Edges = {}\n  MaxGeneration = 2\n  AllowFailure = TRUE\n  AllowCooldown = TRUE\n  ReleasesAllowed = TRUE\n  RejectsAllowed = TRUE\n  ReviewerWorkers = {"w1"}\n  RoleTask = "none"\n  RoleWorker = "none"'

# cfg <file> <spec> <kind inv|prop> <name> <constants>
cfg() {
  { echo "SPECIFICATION $2"; echo "CONSTANTS"; echo "$5"
    if [ "$3" = inv ]; then echo "INVARIANTS"; else echo "PROPERTIES"; fi
    echo "  TypeOK" 2>/dev/null || true
    echo "  $4"; echo "CHECK_DEADLOCK FALSE"; } > "$1"
}

# run <tla> <cfg> -> prints TLC output
run() { java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -metadir "$work/st-$$-$RANDOM" -config "$2" -workers 4 "$1" 2>&1 || true; }

# check <name> <cfg> <expected> <kind inv|prop> <snippet-file>
check() {
  local name="$1" cf="$2" expected="$3" kind="$4" snip="$5"
  local base="formal/Relay.tla" tla="formal/Mut$name.tla" mod="Mut$name"

  # 1. baseline must PASS with the exact same config.
  local bout; bout="$(run "$base" "$cf")"
  if ! grep -q "No error has been found" <<<"$bout"; then
    echo "  INVALID   $name   <-- BASELINE FAILS (mutation test is meaningless)"
    bad+=("$name:baseline"); fail=$((fail+1)); return
  fi

  # 2. apply the mutation (ACTION only).
  cp "$here/Relay.tla" "$tla"
  if ! python3 - "$name" "$tla" "$snip" "$mod" <<'PY'
import sys
name, tla, snip = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(tla, encoding='utf-8').read()
mod = sys.argv[4]
s = s.replace("------------------------------ MODULE Relay ", f"------------------------------ MODULE {mod} ", 1)
old, new = open(snip, encoding='utf-8').read().split("\n@@OLD@@\n", 1)
if old not in s:
    sys.stderr.write(f"{name}: OLD snippet not found\n"); sys.exit(3)
open(tla, 'w', encoding='utf-8').write(s.replace(old, new, 1))
PY
  then
    echo "  BROKEN    $name   (mutation snippet no longer matches the spec)"
    bad+=("$name:snippet"); fail=$((fail+1)); return
  fi

  # 3. mutant must FAIL by the expected property.
  local mout; mout="$(run "$tla" "$cf")"
  if grep -qE "TLC threw an unexpected exception|not completely specified|Parsing or semantic analysis failed|Unknown operator|Semantic errors|changed while it is specified as UNCHANGED" <<<"$mout"; then
    echo "  SPEC-ERR  $name   <-- mutation made the spec invalid, not a counterexample"
    bad+=("$name:specerr"); fail=$((fail+1)); return
  fi
  if grep -q "No error has been found" <<<"$mout"; then
    echo "  SURVIVED  $name   <-- MODEL HOLE (expected $expected)"
    bad+=("$name:survived"); fail=$((fail+1)); return
  fi
  if [ "$kind" = inv ]; then
    if grep -q "Invariant $expected is violated" <<<"$mout"; then
      echo "  M$name baseline PASS; refuted by $expected"
      pass=$((pass+1))
    else
      local got; got="$(grep -oE "Invariant [A-Za-z]+ is violated" <<<"$mout" | sort -u | paste -sd, - || true)"
      echo "  WRONG-PROP $name   <-- expected $expected, got: ${got:-$(grep -oE 'Error: .*' <<<"$mout" | head -1)}"
      bad+=("$name:wrongprop"); fail=$((fail+1))
    fi
  else
    if grep -q "Temporal properties were violated" <<<"$mout"; then
      echo "  M$name baseline PASS; refuted by $expected"
      pass=$((pass+1))
    else
      echo "  WRONG-PROP $name   <-- expected temporal $expected"
      bad+=("$name:wrongprop"); fail=$((fail+1))
    fi
  fi
}

m() { local name="$1" cf="$2" expected="$3" kind="$4"; cat > "$work/$name.snip"; check "$name" "$cf" "$expected" "$kind" "$work/$name.snip"; }

# --- configs (each lists ONLY its expected property + TypeOK) ----------------
cfg "$work/sched.cfg"   Spec inv NoAvoidableIdleAtReconcileBoundary "$K_2x2"
cfg "$work/role.cfg"    Spec inv NoClaimRoleViolation "$K_role"
cfg "$work/review.cfg"  Spec inv ReviewOwnerIsReviewer "$K_role"
cfg "$work/quiet.cfg"   Spec inv QuietScoped "$K_2x2f"
cfg "$work/owner.cfg"   Spec inv QueuedHasNoOwner "$K_2x2"
cfg "$work/fence.cfg"   Spec inv SessionFenceAgreement "$K_1x1g3"
cfg "$work/clean.cfg"   Spec inv CleanupIsRelayOwned "$K_1x1g3"
cfg "$work/adopt.cfg"   Spec inv AdoptedNeverReplaced "$K_1x1g3"
cfg "$work/tree-done.cfg"  Spec inv ChildDoneSignalled "$K_tree"
cfg "$work/tree-hop.cfg"   Spec inv ParentSignalsOneHop "$K_tree"
cfg "$work/tree-stable.cfg" Spec inv ParentStateStableByChildTransition "$K_tree"
cfg "$work/done.cfg"    Spec inv DoneOnlyByApprove "$K_2x2"
cfg "$work/lease.cfg"   Spec inv LeaseFenceAgreement "$K_2x2"
cfg "$work/detach.cfg"  Spec inv DetachedNotOperational "$K_2x2f"
cfg "$work/gen.cfg"     Spec inv GenerationMonotonicity "$K_1x1g3"
cfg "$work/transport.cfg" Spec inv DeadTransportClassified "$K_1x1f"
cfg "$work/live-quiet.cfg" FairSpec prop NoPermanentQuiet "$K_1x1f"
cfg "$work/wake.cfg"  Spec inv WakeFailureKeepsSignal "$K_1x1f"

echo "Relay mutation matrix -- baseline PASS, then mutant refuted by the EXPECTED property"
echo

# M1  fleet-global wake guard.
m M1 "$work/sched.cfg" NoAvoidableIdleAtReconcileBoundary inv <<'SNIP'
EligibleWakees ==
  { w \in Workers :
      Operational(w)
      /\ (   pendingWake[w] # {}
           \/ (\E t \in Tasks: t \in ClaimableBy(w) /\ taskOwner[t] = None))
      /\ ~wakeSuppressed[w] /\ ~retryWake[w] }
@@OLD@@
EligibleWakees ==
  { w \in Workers :
      (\A x \in Workers: workerState[x] # "working")
      /\ Operational(w)
      /\ (   pendingWake[w] # {}
           \/ (\E t \in Tasks: t \in ClaimableBy(w) /\ taskOwner[t] = None))
      /\ ~wakeSuppressed[w] /\ ~retryWake[w] }
SNIP

# M2  wake only the first eligible candidate.
m M2 "$work/sched.cfg" NoAvoidableIdleAtReconcileBoundary inv <<'SNIP'
  /\ WakeSet(EligibleWakees)
@@OLD@@
  /\ \E W \in SUBSET Workers: Cardinality(W) <= 1 /\ WakeSet(W)
SNIP

# M3  claim ignores role eligibility.
m M3 "$work/role.cfg" NoClaimRoleViolation inv <<'SNIP'
    /\ Runnable(t)
    /\ RoleEligible(t, w)
    /\ taskOwner[t] = None
@@OLD@@
    /\ Runnable(t)
    /\ taskOwner[t] = None
SNIP

# M4  quiet never expires.
m M4 "$work/live-quiet.cfg" NoPermanentQuiet prop <<'SNIP'
QuietExpire(w) ==
  /\ quietActive[w]
@@OLD@@
QuietExpire(w) ==
  /\ quietActive[w]
  /\ FALSE
SNIP

# M5  crash classification leaves the quiet lease behind (quiet outlives task).
m M5 "$work/quiet.cfg" QuietScoped inv <<'SNIP'
  /\ quietActive' = [w \in Workers |-> IF w \in Dead THEN FALSE ELSE quietActive[w]]
@@OLD@@
  /\ quietActive' = quietActive
SNIP

# M6  requeue keeps the old owner pointer.
m M6 "$work/owner.cfg" QueuedHasNoOwner inv <<'SNIP'
Requeue(t) ==
  /\ taskState' = [taskState EXCEPT ![t] = "queued"]
  /\ taskOwner' = [taskOwner EXCEPT ![t] = None]
@@OLD@@
Requeue(t) ==
  /\ taskState' = [taskState EXCEPT ![t] = "queued"]
  /\ taskOwner' = taskOwner
SNIP

# M7  a STALE generation is allowed to attach.
m M7 "$work/fence.cfg" SessionFenceAgreement inv <<'SNIP'
  /\ g = generation[w]                    \* the gateEvent fence
@@OLD@@
  /\ g <= generation[w]
SNIP

# M8  cleanup reaps a runtime that is NOT relay-owned.
m M8 "$work/clean.cfg" CleanupIsRelayOwned inv <<'SNIP'
             /\ relayOwned[w] = TRUE
             /\ g < generation[w]
             /\ g < genOwner[w]
@@OLD@@
             /\ g < generation[w]
             /\ g < genOwner[w]
SNIP

# M9  a dead ADOPTED worker is taken over instead of revived.
m M9 "$work/adopt.cfg" AdoptedNeverReplaced inv <<'SNIP'
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
                  prevTaskState, prevGeneration, prevPendingWake, prevWakeTried >>
@@OLD@@
ReviveAdopted(w) ==
  /\ AllowFailure
  /\ relayOwned[w] = FALSE
  /\ workerState[w] = "dead"
  /\ transportAlive[w]
  /\ stage' = 0
  /\ workerState' = [workerState EXCEPT ![w] = "idle"]
  /\ relayOwned' = [relayOwned EXCEPT ![w] = TRUE]
  /\ stallSeen' = [stallSeen EXCEPT ![w] = FALSE]
  /\ sessionGen' = [sessionGen EXCEPT ![w] = generation[w]]
  /\ sessionManaged' = [sessionManaged EXCEPT ![w] = TRUE]
  /\ UNCHANGED << taskState, taskOwner, taskLease, taskGen, lastLease, parent, workerTask,
                  workerLease, staleLease, generation, genOwner, genWatermark,
                  everAdopted, detached, retired, transportAlive, hasMail, quietUntil,
                  quietActive, pendingWake, wakeSuppressed, retryWake, wakeTried, wakeEligible,
                  parentDone, parentBlocked, activeRT, rtDurable, rtCleaned, approved, reviewed,
                  prevTaskState, prevGeneration, prevPendingWake, prevWakeTried >>
SNIP

# M10 child state changes but the durable parent signal is omitted.
m M10 "$work/tree-done.cfg" ChildDoneSignalled inv <<'SNIP'
  /\ LET p == parent[t] IN
       IF p = None
       THEN UNCHANGED << parentDone, parentBlocked >>
       ELSE /\ parentDone' = [parentDone EXCEPT ![p] = parentDone[p] \cup {t}]
            /\ parentBlocked' = [parentBlocked EXCEPT ![p] = parentBlocked[p] \ {t}]
@@OLD@@
  /\ LET p == parent[t] IN
       IF p = None
       THEN UNCHANGED << parentDone, parentBlocked >>
       ELSE /\ parentDone' = parentDone
            /\ parentBlocked' = [parentBlocked EXCEPT ![p] = parentBlocked[p] \ {t}]
SNIP

# M11 child-done bubbles recursively (grandparent signalled too).
m M11 "$work/tree-hop.cfg" ParentSignalsOneHop inv <<'SNIP'
  /\ LET p == parent[t] IN
       IF p = None
       THEN UNCHANGED << parentDone, parentBlocked >>
       ELSE /\ parentDone' = [parentDone EXCEPT ![p] = parentDone[p] \cup {t}]
            /\ parentBlocked' = [parentBlocked EXCEPT ![p] = parentBlocked[p] \ {t}]
@@OLD@@
  /\ LET p == parent[t] IN
       IF p = None
       THEN UNCHANGED << parentDone, parentBlocked >>
       ELSE /\ parentDone' = [q \in Tasks |->
                 IF q = p \/ q = t THEN parentDone[q] \cup {t} ELSE parentDone[q]]
            /\ parentBlocked' = [parentBlocked EXCEPT ![p] = parentBlocked[p] \ {t}]
SNIP

# M12 a worker marks its own task done without review.
m M12 "$work/done.cfg" DoneOnlyByApprove inv <<'SNIP'
  /\ taskState' = [taskState EXCEPT ![t] = "review"]
  /\ lastLease' = [lastLease EXCEPT ![t] = workerLease[w]]
  /\ workerTask' = [workerTask EXCEPT ![w] = None]
  /\ workerState' = [workerState EXCEPT ![w] = "idle"]
  /\ quietActive' = [quietActive EXCEPT ![w] = FALSE]
  /\ quietUntil' = [quietUntil EXCEPT ![w] = None]
  /\ reviewed' = reviewed \cup {t}
@@OLD@@
  /\ taskState' = [taskState EXCEPT ![t] = "done"]
  /\ lastLease' = [lastLease EXCEPT ![t] = workerLease[w]]
  /\ workerTask' = [workerTask EXCEPT ![w] = None]
  /\ workerState' = [workerState EXCEPT ![w] = "idle"]
  /\ quietActive' = [quietActive EXCEPT ![w] = FALSE]
  /\ quietUntil' = [quietUntil EXCEPT ![w] = None]
  /\ reviewed' = reviewed \cup {t}
SNIP

# M13 a STALE lease (same worker, later epoch) is accepted.
m M13 "$work/lease.cfg" LeaseFenceAgreement inv <<'SNIP'
  /\ taskState[t] = "running"
  /\ staleLease[w] = taskLease[t]                 \* the lease fence
@@OLD@@
  /\ taskState[t] = "running"
SNIP

# M14 IdleOperational ignores Operational (a detached worker looks wakeable).
m M14 "$work/detach.cfg" DetachedNotOperational inv <<'SNIP'
IdleOperational(w) ==
  /\ Operational(w)
  /\ workerState[w] = "idle"
  /\ workerTask[w] = None
@@OLD@@
IdleOperational(w) ==
  /\ workerState[w] = "idle"
  /\ workerTask[w] = None
SNIP

# M15 restart reuses/rewinds the generation.
m M15 "$work/gen.cfg" GenerationMonotonicity inv <<'SNIP'
  /\ LET g2 == genWatermark[w] + 1 IN
     /\ generation' = [generation EXCEPT ![w] = g2]
     /\ genWatermark' = [genWatermark EXCEPT ![w] = g2]
     /\ genOwner' = [genOwner EXCEPT ![w] = g2]
@@OLD@@
  /\ LET g2 == 1 IN
     /\ generation' = [generation EXCEPT ![w] = g2]
     /\ genWatermark' = [genWatermark EXCEPT ![w] = g2]
     /\ genOwner' = [genOwner EXCEPT ![w] = g2]
SNIP

# M16 child completion ALSO mutates the parent's task state.
m M16 "$work/tree-stable.cfg" ParentStateStableByChildTransition inv <<'SNIP'
  /\ taskState' = [taskState EXCEPT ![t] = "done"]
  /\ taskOwner' = [taskOwner EXCEPT ![t] = None]
  /\ taskLease' = [taskLease EXCEPT ![t] = taskLease[t] + 1]
@@OLD@@
  /\ taskState' = [q \in Tasks |->
       IF q = t THEN "done" ELSIF q = parent[t] THEN "done" ELSE taskState[q]]
  /\ taskOwner' = [taskOwner EXCEPT ![t] = None]
  /\ taskLease' = [taskLease EXCEPT ![t] = taskLease[t] + 1]
SNIP

# M17 transport-death classification is suppressed while the worker is quiet.
m M17 "$work/transport.cfg" DeadTransportClassified inv <<'SNIP'
DeadSet == { w \in Workers : ~transportAlive[w] /\ Operational(w) }
@@OLD@@
DeadSet == { w \in Workers : ~transportAlive[w] /\ Operational(w) /\ ~quietActive[w] }
SNIP

# M18 a wake failure erases the durable signal and owes no retry.
m M18 "$work/wake.cfg" WakeFailureKeepsSignal inv <<'SNIP'
WakeFails(w) ==
  /\ wakeTried[w]
  /\ stage' = 0
  /\ wakeTried' = [wakeTried EXCEPT ![w] = FALSE]
  /\ retryWake' = [retryWake EXCEPT ![w] = TRUE]
@@OLD@@
WakeFails(w) ==
  /\ wakeTried[w]
  /\ stage' = 0
  /\ wakeTried' = [wakeTried EXCEPT ![w] = FALSE]
  /\ retryWake' = [retryWake EXCEPT ![w] = FALSE]
  /\ pendingWake' = [pendingWake EXCEPT ![w] = {}]
SNIP

# M19 a rejected review goes straight to done, bypassing Approve.
m M19 "$work/done.cfg" DoneOnlyByApprove inv <<'SNIP'
  /\ Requeue(t)
  /\ LET o == taskOwner[t] IN
       IF o = None THEN UNCHANGED << workerTask, staleLease, workerLease, workerState >>
       ELSE /\ workerTask' = [workerTask EXCEPT ![o] = None]
            /\ workerState' = [workerState EXCEPT ![o] = "idle"]
            /\ staleLease' = [staleLease EXCEPT ![o] = workerLease[o]]
            /\ workerLease' = [workerLease EXCEPT ![o] = 0]
  /\ UNCHANGED << taskGen, lastLease, parent, generation, genOwner, genWatermark, relayOwned,
                  sessionGen, sessionManaged, everAdopted, detached, retired, transportAlive,
                  hasMail, quietUntil, quietActive, stallSeen, pendingWake, wakeSuppressed,
                  retryWake, wakeTried, wakeEligible, parentDone, parentBlocked, activeRT,
                  rtDurable, rtCleaned, approved, reviewed, prevTaskState, prevGeneration >>
@@OLD@@
  /\ taskState' = [taskState EXCEPT ![t] = "done"]
  /\ taskOwner' = [taskOwner EXCEPT ![t] = None]
  /\ taskLease' = [taskLease EXCEPT ![t] = taskLease[t] + 1]
  /\ LET o == taskOwner[t] IN
       IF o = None THEN UNCHANGED << workerTask, staleLease, workerLease, workerState >>
       ELSE /\ workerTask' = [workerTask EXCEPT ![o] = None]
            /\ workerState' = [workerState EXCEPT ![o] = "idle"]
            /\ staleLease' = [staleLease EXCEPT ![o] = workerLease[o]]
            /\ workerLease' = [workerLease EXCEPT ![o] = 0]
  /\ UNCHANGED << taskGen, lastLease, parent, generation, genOwner, genWatermark, relayOwned,
                  sessionGen, sessionManaged, everAdopted, detached, retired, transportAlive,
                  hasMail, quietUntil, quietActive, stallSeen, pendingWake, wakeSuppressed,
                  retryWake, wakeTried, wakeEligible, parentDone, parentBlocked, activeRT,
                  rtDurable, rtCleaned, approved, reviewed, prevTaskState, prevGeneration >>
SNIP

# M20 a non-reviewer adopts a review task (review capability ignored).
m M20 "$work/review.cfg" ReviewOwnerIsReviewer inv <<'SNIP'
  /\ taskState[t] = "review"
  /\ CanReview(w)
  /\ IdleOperational(w)
  /\ (\A x \in Workers: workerTask[x] # t)
@@OLD@@
  /\ taskState[t] = "review"
  /\ IdleOperational(w)
  /\ (\A x \in Workers: workerTask[x] # t)
SNIP

echo
echo "refuted: $pass   problems: $fail"
if [ "$fail" -ne 0 ]; then
  echo "PROBLEMS: ${bad[*]}"
  exit 1
fi
echo "OK: every baseline is green and every mutant is refuted by its expected property."
