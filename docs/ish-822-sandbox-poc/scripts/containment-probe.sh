#!/usr/bin/env bash
# ISH-822 real-key containment probe — THE KEY STAYS ON THE HOST.
#
# The sandbox-visible filesystem is streamed OUT of the VM (tar over `sbx exec`)
# and grepped on the HOST with the real key. The key value is never sent into the
# sandbox (unlike a naive `grep` run inside the VM). KEY_CMD must print the real
# key on stdout on the host.
#
#   POC="$(git rev-parse --show-toplevel)/docs/ish-822-sandbox-poc"
#   KEY_CMD=/abs/get-ollama-key.sh bash "$POC/scripts/containment-probe.sh"
#
# Expect: the real-key count is 0, while a positive control proves the stream
# really was inspected.
set -uo pipefail
KEY_CMD="${KEY_CMD:?set KEY_CMD to a host command that prints the key on stdout}"
SBX_SANDBOX="${SBX_SANDBOX:-ish822-poc}"
STREAM="$(mktemp -t ish822-sandbox-visible)"

echo "# sandbox user                 : $(sbx exec "$SBX_SANDBOX" id -un 2>/dev/null)"
echo "# host sha256(real key)        : $("$KEY_CMD" | shasum -a 256 | cut -d' ' -f1)"
echo "# tar reads as root inside the VM; its 2>/dev/null drops unreadable-file errors"
echo "# streaming sandbox /{home/agent,tmp,etc,var/tmp,opt} OUT to $STREAM"
sbx exec "$SBX_SANDBOX" sudo -n tar -C / -cf - home/agent tmp etc var/tmp opt 2>/dev/null > "$STREAM"
tar -xOf "$STREAM" > "$STREAM.txt" 2>/dev/null
echo "# stream: $(wc -c < "$STREAM") bytes (tar), $(wc -c < "$STREAM.txt") bytes (extracted)"
echo
echo "# POSITIVE CONTROLS (prove the pipeline inspects content), host-side:"
echo "#   grep -acF 'Ubuntu'     = $(grep -acF 'Ubuntu' "$STREAM.txt")   (expect >=1)"
echo "#   grep -acF 'ISH-822'    = $(grep -acF 'ISH-822' "$STREAM.txt")   (expect >=1)"
echo "# SUBJECT, host-side:"
echo "#   grep -acF -f <(KEY_CMD) = $(grep -acF -f <("$KEY_CMD") "$STREAM.txt")   (expect 0)"
echo "# also no persisted placeholder, host-side:"
echo "#   grep -acF 'sbx-cs-'      = $(grep -acF 'sbx-cs-' "$STREAM.txt")   (expect 0)"
rm -f "$STREAM" "$STREAM.txt"
