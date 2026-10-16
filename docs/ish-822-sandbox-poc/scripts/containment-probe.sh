#!/usr/bin/env bash
# ISH-822 real-key containment probe — THE KEY STAYS ON THE HOST.
#
# The sandbox-visible filesystem is streamed OUT of the VM (tar over `sbx exec`)
# and grepped on the HOST with the real key. The key value is never sent into the
# sandbox. KEY_CMD must print the real key on stdout on the host.
#
# RUN THIS AFTER THE dsh RUN (README step 9b) — dsh must have written its session/
# log state first; one of the positive controls below (`ISH-822`) depends on it.
#
#   POC="$(git rev-parse --show-toplevel)/docs/ish-822-sandbox-poc"
#   KEY_CMD=/abs/get-ollama-key.sh bash "$POC/scripts/containment-probe.sh"
#
# Exits 0 ONLY when both positive controls are >=1 and the key/placeholder counts
# are 0; otherwise it exits non-zero (so `EXIT=0` in evidence/14b is a real pass).
set -uo pipefail
KEY_CMD="${KEY_CMD:?set KEY_CMD to a host command that prints the key on stdout}"
SBX_SANDBOX="${SBX_SANDBOX:-ish822-poc}"

WORK="$(mktemp -d -t ish822-contain)"
trap 'rm -rf "$WORK"' EXIT
STREAM="$WORK/stream.tar"; TXT="$WORK/stream.txt"; KEYFILE="$WORK/key"

"$KEY_CMD" > "$KEYFILE"
if [ ! -s "$KEYFILE" ]; then echo "FAIL: KEY_CMD produced no key"; exit 2; fi

echo "# sandbox user          : $(sbx exec "$SBX_SANDBOX" id -un 2>/dev/null)"
echo "# host sha256(real key) : $(shasum -a 256 < "$KEYFILE" | cut -d' ' -f1)"
echo "# NOTE: taken AFTER the dsh run (README step 9b), so dsh session/log state exists"
echo "# tar reads as root inside the VM; its 2>/dev/null drops unreadable-file errors"
echo "# streaming sandbox /{home/agent,tmp,etc,var/tmp,opt} OUT to $STREAM"
sbx exec "$SBX_SANDBOX" sudo -n tar -C / -cf - home/agent tmp etc var/tmp opt 2>/dev/null > "$STREAM"
tar -xOf "$STREAM" > "$TXT" 2>/dev/null
echo "# stream: $(wc -c < "$STREAM") bytes (tar), $(wc -c < "$TXT") bytes (extracted)"
echo

# grep -c prints the count and exits 1 when there are no matches; `|| true` keeps
# the count (0) instead of tripping `set -o pipefail`.
ctl_ubuntu="$(grep -acF 'Ubuntu'   "$TXT" || true)"
ctl_ish="$(grep -acF 'ISH-822'     "$TXT" || true)"
key="$(grep -acF -f "$KEYFILE"     "$TXT" || true)"
ph="$(grep -acF 'sbx-cs-'          "$TXT" || true)"

echo "# POSITIVE CONTROLS (must be >=1):"
echo "#   grep -acF 'Ubuntu'      = $ctl_ubuntu"
echo "#   grep -acF 'ISH-822'     = $ctl_ish"
echo "# SUBJECT (must be 0):"
echo "#   grep -acF -f <(KEY_CMD) = $key"
echo "#   grep -acF 'sbx-cs-'     = $ph"

rc=0
[ "${ctl_ubuntu:-0}" -ge 1 ] || { echo "FAIL: positive control 'Ubuntu' = ${ctl_ubuntu:-0} (expected >=1)"; rc=1; }
[ "${ctl_ish:-0}" -ge 1 ]    || { echo "FAIL: positive control 'ISH-822' = ${ctl_ish:-0} (expected >=1)"; rc=1; }
[ "${key:-1}" -eq 0 ]        || { echo "FAIL: real key present in the sandbox ($key matches)"; rc=1; }
[ "${ph:-1}" -eq 0 ]         || { echo "FAIL: placeholder persisted in the sandbox ($ph matches)"; rc=1; }
echo "RESULT: $([ "$rc" -eq 0 ] && echo PASS || echo FAIL)"
exit "$rc"
