#!/usr/bin/env bash
# Counterexample-quality check for the Relay formal model.
#
#   formal/run-mutations.sh
#
# A green TLC run only proves the properties hold for THIS spec.  It says
# nothing about whether the spec is strong enough to catch the bugs it exists
# to catch.  This script mutates one ACTION at a time (M1..M12 in
# formal/README.md "Mutation matrix") and asserts each mutant IS refuted.
#
# Rules:
#   * a mutation changes an ACTION (or a guard), NEVER an invariant -- weakening
#     an invariant would just be checking a weaker spec.
#   * each mutant is checked with the SMALLEST config that can expose it (fast,
#     and the refutation names the one property the mutation is about).
#   * a surviving mutant means the MODEL has a hole: fix the model, not the test.
#
# Exits non-zero if any mutant survives.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
tools="$here/.tools"
jar="$tools/tla2tools.jar"
version="${TLA2TOOLS_VERSION:-v1.7.4}"

if [ ! -f "$jar" ]; then
  mkdir -p "$tools"
  curl -fsSL "https://github.com/tlaplus/tlaplus/releases/download/${version}/tla2tools.jar" -o "$jar"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

pass=0; fail=0; survivors=()

# write_cfg <file> <spec> <constants-lines> <kind:inv|prop> <property-list>
write_cfg() {
  local file="$1" spec="$2" consts="$3" kind="$4" props="$5"
  { echo "SPECIFICATION $spec"; echo "CONSTANTS"; echo "$consts"
    if [ "$kind" = inv ]; then echo "INVARIANTS"; else echo "PROPERTIES"; fi
    echo "$props"; echo "CHECK_DEADLOCK FALSE"; } > "$file"
}

# run_mutant <name> <cfgfile> <snippet-file>
run_mutant() {
  local name="$1" cfg="$2" snip="$3"
  local tla="$work/$name.tla"
  cp "$here/Relay.tla" "$tla"
  if ! python3 - "$name" "$tla" "$snip" <<'PY'
import sys
name, tla, snip = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(tla, encoding='utf-8').read()
s = s.replace("------------------------------ MODULE Relay ", f"------------------------------ MODULE {name} ", 1)
old, new = open(snip, encoding='utf-8').read().split("\n@@OLD@@\n", 1)
if old not in s:
    sys.stderr.write(f"{name}: OLD snippet not found\n"); sys.exit(3)
open(tla, 'w', encoding='utf-8').write(s.replace(old, new, 1))
PY
  then
    echo "  BROKEN    $name   (mutation snippet no longer matches the spec)"
    survivors+=("$name"); fail=$((fail + 1)); return
  fi
  local out
  out="$(java -XX:+UseParallelGC -cp "$jar" tlc2.TLC \
      -metadir "$work/${name}states" -config "$cfg" -workers 4 "$tla" 2>&1 || true)"
  if grep -qE "TLC threw an unexpected exception|not completely specified|Parsing or semantic analysis failed|Unknown operator|Semantic errors|changed while it is specified as UNCHANGED" <<<"$out"; then
    echo "  SPEC-ERR  $name   <-- the mutation made the spec invalid (not a counterexample)"
    survivors+=("$name"); fail=$((fail + 1)); return
  fi
  if grep -q "No error has been found" <<<"$out"; then
    echo "  SURVIVED  $name   <-- MODEL HOLE"
    survivors+=("$name"); fail=$((fail + 1))
  else
    local hit
    hit="$(grep -oE "Invariant [A-Za-z]+ is violated|Property [A-Za-z]+ is violated" <<<"$out" \
           | sed 's/ is violated//;s/Invariant //;s/Property //' | sort -u | paste -sd, - || true)"
    if [ -z "$hit" ] && grep -q "Temporal properties were violated" <<<"$out"; then hit="temporal property"; fi
    [ -n "$hit" ] || hit="$(grep -oE "Error: .*" <<<"$out" | head -1 || true)"
    echo "  refuted   $name   ($hit)"
    pass=$((pass + 1))
  fi
}

m() { # m <name> <cfgfile> ; snippet on stdin
  local name="$1" cfg="$2"
  cat > "$work/$name.snip"
  run_mutant "$name" "$cfg" "$work/$name.snip"
}

# --- configs ----------------------------------------------------------------
C_2x2=$'  Tasks = {\"t1\", \"t2\"}\n  Workers = {\"w1\", \"w2\"}\n  Roots = {\"t1\", \"t2\"}\n  Edges = {}\n  MaxGeneration = 2\n  AllowFailure = FALSE\n  AllowCooldown = TRUE\n  RoleTask = \"none\"\n  RoleWorker = \"none\"\n  RejectsAllowed = TRUE\n  ReleasesAllowed = TRUE'
C_2x2_fail=$'  Tasks = {\"t1\", \"t2\"}\n  Workers = {\"w1\", \"w2\"}\n  Roots = {\"t1\", \"t2\"}\n  Edges = {}\n  MaxGeneration = 2\n  AllowFailure = TRUE\n  AllowCooldown = TRUE\n  RoleTask = \"none\"\n  RoleWorker = \"none\"\n  RejectsAllowed = TRUE\n  ReleasesAllowed = TRUE'
C_role=$'  Tasks = {\"t1\", \"t2\"}\n  Workers = {\"w1\", \"w2\"}\n  Roots = {\"t1\", \"t2\"}\n  Edges = {}\n  MaxGeneration = 2\n  AllowFailure = FALSE\n  AllowCooldown = TRUE\n  RejectsAllowed = TRUE\n  ReleasesAllowed = TRUE\n  RoleTask = \"t1\"\n  RoleWorker = \"w1\"'
C_1x1_gen3=$'  Tasks = {\"t1\"}\n  Workers = {\"w1\"}\n  Roots = {\"t1\"}\n  Edges = {}\n  MaxGeneration = 3\n  AllowFailure = TRUE\n  AllowCooldown = TRUE\n  RoleTask = \"none\"\n  RoleWorker = \"none\"\n  RejectsAllowed = TRUE\n  ReleasesAllowed = TRUE'
C_1x1_fail=$'  Tasks = {\"t1\", \"t2\"}\n  Workers = {\"w1\"}\n  Roots = {\"t1\", \"t2\"}\n  Edges = {}\n  MaxGeneration = 2\n  AllowFailure = TRUE\n  AllowCooldown = TRUE\n  RoleTask = \"none\"\n  RoleWorker = \"none\"\n  RejectsAllowed = TRUE\n  ReleasesAllowed = TRUE'
C_tree=$'  Tasks = {\"t1\", \"t2\", \"t3\"}\n  Workers = {\"w1\", \"w2\"}\n  Roots = {\"t1\"}\n  Edges = {"t1:t2", "t2:t3"}\n  MaxGeneration = 2\n  AllowFailure = FALSE\n  AllowCooldown = TRUE\n  RoleTask = \"none\"\n  RoleWorker = \"none\"\n  RejectsAllowed = TRUE\n  ReleasesAllowed = TRUE'

write_cfg "$work/sched.cfg"  Spec "$C_2x2"      inv  $'  TypeOK\n  NoAvoidableIdleAtReconcileBoundary'
write_cfg "$work/role.cfg"   Spec "$C_role"     inv  $'  TypeOK\n  NoRoleViolation'
write_cfg "$work/quiet.cfg"  Spec "$C_2x2_fail" inv  $'  TypeOK\n  QuietScoped\n  QuietDoesNotSuppressCrash'
write_cfg "$work/fence.cfg"  Spec "$C_1x1_gen3" inv  $'  TypeOK\n  NoStaleSession\n  GenerationMonotonicity'
write_cfg "$work/owner.cfg"  Spec "$C_2x2"      inv  $'  TypeOK\n  QueuedHasNoOwner'
write_cfg "$work/clean.cfg"  Spec "$C_1x1_gen3" inv  $'  TypeOK\n  CleanupIsRelayOwned'
write_cfg "$work/adopt.cfg"  Spec "$C_2x2_fail" inv  $'  TypeOK\n  AdoptedNeverReplaced'
write_cfg "$work/tree.cfg"   Spec "$C_tree"     inv  $'  TypeOK\n  ChildDoneSignalled\n  ParentSignalsOneHop'
write_cfg "$work/done.cfg"   Spec "$C_2x2"      inv  $'  TypeOK\n  DoneRequiresReview'
write_cfg "$work/live.cfg"   FairSpec "$C_1x1_fail" prop $'  NoPermanentQuiet'

echo "Relay mutation matrix -- every mutant MUST be refuted"
echo

# M1  fleet-global wake guard: nobody is woken while anyone is working.
m M1 "$work/sched.cfg" <<'SNIP'
EligibleWakees ==
  { w \in Workers :
      (   pendingWake[w] # {}
       \/ (\E t \in Tasks: t \in ClaimableBy(w) /\ taskOwner[t] = None))
      /\ ~wakeSuppressed[w] /\ ~retryWake[w] }
@@OLD@@
EligibleWakees ==
  { w \in Workers :
      (\A x \in Workers: workerState[x] # "working")
      /\ (   pendingWake[w] # {}
          \/ (\E t \in Tasks: t \in ClaimableBy(w) /\ taskOwner[t] = None))
      /\ ~wakeSuppressed[w] /\ ~retryWake[w] }
SNIP

# M2  wake only the first eligible candidate.
m M2 "$work/sched.cfg" <<'SNIP'
  /\ WakeSet(EligibleWakees)
@@OLD@@
  /\ \E W \in SUBSET Workers: Cardinality(W) <= 1 /\ WakeSet(W)
SNIP

# M3  claim ignores role eligibility.
m M3 "$work/role.cfg" <<'SNIP'
    /\ Runnable(t)
    /\ RoleEligible(t, w)
    /\ taskOwner[t] = None
@@OLD@@
    /\ Runnable(t)
    /\ taskOwner[t] = None
SNIP

# M4  quiet never expires (bounded lease -> permanent suppression).
m M4 "$work/live.cfg" <<'SNIP'
QuietExpire(w) ==
  /\ quietActive[w]
@@OLD@@
QuietExpire(w) ==
  /\ quietActive[w]
  /\ FALSE
SNIP

# M5  a crash leaves the quiet lease behind (quiet outlives its task).
m M5 "$work/quiet.cfg" <<'SNIP'
  /\ quietActive' = [quietActive EXCEPT ![w] = FALSE]
  /\ quietUntil' = [quietUntil EXCEPT ![w] = None]
  /\ stallSeen' = [stallSeen EXCEPT ![w] = FALSE]
  /\ sessionManaged' = [sessionManaged EXCEPT ![w] = FALSE]
@@OLD@@
  /\ quietActive' = quietActive
  /\ quietUntil' = quietUntil
  /\ stallSeen' = [stallSeen EXCEPT ![w] = FALSE]
  /\ sessionManaged' = [sessionManaged EXCEPT ![w] = FALSE]
SNIP

# M6  release keeps the old owner pointer (no ownership clear).
m M6 "$work/owner.cfg" <<'SNIP'
Requeue(t) ==
  /\ taskState' = [taskState EXCEPT ![t] = "queued"]
  /\ taskOwner' = [taskOwner EXCEPT ![t] = None]
@@OLD@@
Requeue(t) ==
  /\ taskState' = [taskState EXCEPT ![t] = "queued"]
  /\ taskOwner' = taskOwner
SNIP

# M7  a STALE generation is allowed to attach (gateEvent fence removed).
m M7 "$work/fence.cfg" <<'SNIP'
  /\ g = generation[w]                    \* the gateEvent fence
@@OLD@@
  /\ g <= generation[w]
SNIP

# M8  cleanup reaps a runtime that is NOT relay-owned (adopted tab closed).
m M8 "$work/clean.cfg" <<'SNIP'
        /\ \A w \in Workers: \A g \in ToReap[w]:
             /\ relayOwned[w] = TRUE        \* never reap an adopted runtime
@@OLD@@
        /\ \A w \in Workers: \A g \in ToReap[w]:
             /\ TRUE
SNIP

# M9  a dead ADOPTED worker is taken over instead of revived.
m M9 "$work/adopt.cfg" <<'SNIP'
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
@@OLD@@
ReviveAdopted(w) ==
  /\ AllowFailure
  /\ relayOwned[w] = FALSE
  /\ workerState[w] = "dead"
  /\ workerState' = [workerState EXCEPT ![w] = "idle"]
  /\ relayOwned' = [relayOwned EXCEPT ![w] = TRUE]
  /\ stallSeen' = [stallSeen EXCEPT ![w] = FALSE]
  /\ sessionGen' = [sessionGen EXCEPT ![w] = generation[w]]
  /\ sessionManaged' = [sessionManaged EXCEPT ![w] = TRUE]
  /\ stage' = 0
  /\ UNCHANGED << taskState, taskOwner, taskVersion, parent, workerTask, generation, genOwner,
                  hasMail, quietUntil, quietActive, pendingWake, wakeSuppressed,
                  retryWake, wakeTried, wakeEligible, parentDone, parentBlocked, activeRT,
                  rtDurable, rtCleaned, reviewed, everAdopted >>
SNIP

# M10 child-done is recorded but the durable parent signal is not sent.
m M10 "$work/tree.cfg" <<'SNIP'
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

# M11 child-done bubbles RECURSIVELY (grandparent signalled too).
m M11 "$work/tree.cfg" <<'SNIP'
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
m M12 "$work/done.cfg" <<'SNIP'
  /\ taskState' = [taskState EXCEPT ![workerTask[w]] = "review"]
  /\ reviewed' = reviewed \cup {workerTask[w]}
@@OLD@@
  /\ taskState' = [taskState EXCEPT ![workerTask[w]] = "done"]
  /\ reviewed' = reviewed
SNIP

echo
echo "refuted: $pass   survived: $fail"
if [ "$fail" -ne 0 ]; then
  echo "MODEL HOLES: ${survivors[*]}"
  exit 1
fi
echo "OK: every mutant is refuted."
