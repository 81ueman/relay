#!/bin/sh
# ISH-845 — Relay's trusted Task-owned Network Lab cleanup hook.
#
# This is the reference value for `RELAY_LAB_CLEANUP_CMD`. Relay invokes it once
# per ended Task as:
#
#     lab-cleanup.sh <owner-id>
#
# where `<owner-id>` is `RELAY_LAB_OWNER` (see src/lab-cleanup.ts). It destroys
# ONLY the lab named `netlab-<owner-id>` — the exact name the `network-lab` skill
# is required to use — and purges that owner's leftover workspace directory (a
# crashed/timed-out deploy can leave a dir with no lab). It never matches a lab
# by name SUFFIX, so it can never touch another owner's lab; it never removes
# NOS images; it never touches the Shared Lab VM.
#
# Requires `labctl` (LABCTL_BIN, default `labctl`) and python3, and a
# containerlab `name:` of exactly `netlab-<owner>` (the skill's contract).
#
# Connection/auth come from the environment (never argv): LABCTL_API,
# LABCTL_USER + LABCTL_PASSWORD (or LABCTL_PASSWORD_FILE / LABCTL_TOKEN),
# LABCTL_CA_CERT (else --insecure for the Lab's self-signed PoC cert).
set -eu

OWNER="${1:?usage: lab-cleanup.sh <owner-id>}"
case "$OWNER" in
  '' | *[!A-Za-z0-9._-]*)
    echo "lab-cleanup: refusing unsafe owner id: '$OWNER'" >&2
    exit 2
    ;;
esac

LABCTL="${LABCTL_BIN:-labctl}"
TARGET="netlab-$OWNER"

# labctl options are per-subcommand: build an argv-safe list (no shell splitting).
set --
if [ -n "${LABCTL_API:-}" ]; then set -- "$@" --api "$LABCTL_API"; fi
if [ -n "${LABCTL_CA_CERT:-}" ]; then set -- "$@" --ca-cert "$LABCTL_CA_CERT"; else set -- "$@" --insecure; fi
if [ -n "${LABCTL_PASSWORD_FILE:-}" ]; then set -- "$@" --password-file "$LABCTL_PASSWORD_FILE"; fi
if [ -n "${LABCTL_USER:-}" ]; then set -- "$@" --user "$LABCTL_USER"; fi

TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
if ! "$LABCTL" inspect "$@" --json > "$TMP"; then
  echo "lab-cleanup: could not list labs for owner=$OWNER" >&2
  exit 5
fi

labs="$(python3 -c 'import json, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    data = {}
print("\n".join(sorted(data if isinstance(data, dict) else {})))' "$TMP")"

destroyed=0
for lab in $labs; do
  # STRICT: only the exact task-owned lab name, never a suffix/prefix match.
  [ "$lab" = "$TARGET" ] || continue
  echo "lab-cleanup: destroying $lab (owner=$OWNER)"
  "$LABCTL" destroy --name "$TARGET" "$@" --json
  destroyed=1
done

# Recover a workspace directory left by a failed/timed-out deploy (no lab exists,
# so `destroy` cannot reach it). A no-op when there is nothing to purge.
if "$LABCTL" purge "$TARGET" --namespace "$OWNER" "$@" --json >/dev/null 2>&1; then
  echo "lab-cleanup: purged leftover workspace $OWNER/$TARGET"
fi

echo "lab-cleanup: done owner=$OWNER (destroyed=$destroyed; images untouched)"
