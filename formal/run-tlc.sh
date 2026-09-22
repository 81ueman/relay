#!/usr/bin/env bash
# Run TLC on one of the Relay*.cfg configs.
#
#   formal/run-tlc.sh RelaySafety      # Level A -- structural safety + three fences
#   formal/run-tlc.sh RelayScheduling  # Level B -- reconcile-boundary responsiveness
#   formal/run-tlc.sh RelayRoles       # claim role vs review capability
#   formal/run-tlc.sh RelayTree        # one-hop parent signalling (P -> C -> G)
#   formal/run-tlc.sh RelayRecovery    # crash/restart/adopt, all three fences
#   formal/run-tlc.sh RelayLiveness    # Level C -- bounded suppression under FairSpec
#   formal/run-tlc.sh RelayCompletion  # Level D -- AllTasksDone demonstration (NOT a guarantee)
#
# Old names Relay / RelayFailures / RelayDone are thin compatibility aliases.
#
# The TLA+ tools are downloaded on first use into formal/.tools/ (gitignored).
# No JAR is committed to the repository.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
tools="$here/.tools"
jar="$tools/tla2tools.jar"
version="${TLA2TOOLS_VERSION:-v1.7.4}"

if [ ! -f "$jar" ]; then
  mkdir -p "$tools"
  url="https://github.com/tlaplus/tlaplus/releases/download/${version}/tla2tools.jar"
  echo "downloading tla2tools.jar ($version) ..." >&2
  curl -fsSL "$url" -o "$jar"
fi

cfg="${1:-Relay}"
shift || true

exec java -XX:+UseParallelGC -cp "$jar" tlc2.TLC \
  -metadir "$here/states" \
  -config "$here/${cfg}.cfg" "$@" "$here/Relay.tla"
