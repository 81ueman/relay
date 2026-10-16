#!/usr/bin/env bash
# ISH-822 in-sandbox real `dsh` headless run.
#
# Run inside the clone-mode sandbox with the provider placeholder injected:
#
#   sbx exec \
#     -e OLLAMA_CLOUD_V41_API_KEY=<placeholder from `sbx secret ls`> \
#     -w "$CLONE" \
#     ish822-poc bash -lc "$(cat docs/ish-822-sandbox-poc/scripts/run-dsh-in-sandbox.sh)"
#
# Preconditions: `dsh` 0.2.0-rc.2 is installed (`npm i -g @deepseek-ai/dsh@0.2.0-rc.2`)
# and /home/agent/dsh-overlay.yml exists (scripts/dsh-overlay.yml).
set -uo pipefail

CLONE="${CLONE:-/private/var/folders/2l/lk91l4dd1ysb1jfw7bkw0nrh0000gn/T/ish822-fixture}"
cd "$CLONE"

# Confine writes to the worktree; never grant danger-full-access.
export DSH_PERMISSION_MODE=workspace-write

TASK="Read the file README.md in the current working directory, then create a new file named poc-note.txt containing exactly the line: ISH-822 sandbox dsh run OK. Then stage it and commit it with: git commit -m \"ISH-822: sandbox dsh commit\". Finally reply with exactly DSH_SANDBOX_OK on its own line."

dsh --profile headless --patch /home/agent/dsh-overlay.yml --json "$TASK" \
  > /tmp/dsh-out.jsonl 2> /tmp/dsh-err.log
echo "DSH_EXIT=$?"

echo "=== stdout (dsh --json JSONL: session/status/text/tool_call/tool_result/final) ==="
cat /tmp/dsh-out.jsonl
echo "=== stderr ==="
cat /tmp/dsh-err.log
echo "=== produced commit ==="
git log --oneline -2
git rev-parse HEAD
