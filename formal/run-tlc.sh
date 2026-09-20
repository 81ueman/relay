#!/usr/bin/env bash
# Run TLC on one of the Relay*.cfg configs.
#
#   formal/run-tlc.sh Relay           # safety invariants (all behaviours)
#   formal/run-tlc.sh RelayLiveness   # Property A + B (fair behaviours)
#   formal/run-tlc.sh RelayDone       # Property C (stronger env assumptions)
#   formal/run-tlc.sh RelayFailures   # safety widened to >=2 sequential failures
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
