#!/usr/bin/env bash
# ISH-822 in-sandbox isolation negative tests.
#
# Run inside the clone-mode sandbox:
#   sbx exec ish822-poc bash -lc "$(cat docs/ish-822-sandbox-poc/scripts/negative-tests.sh)"
#
# The negative tests probe HOST-ABSOLUTE paths (`/Users/81ueman/...`), not the
# sandbox user's own home (`/home/agent`). Probing `~` inside the VM is vacuous:
# `~` is the VM's home, so it says nothing about the host. sbx mounts workspaces
# at their host-absolute path, so the host path is the meaningful probe.
#
# Every "SENTINEL" is a harmless file created on the HOST for this PoC (see the
# README "Reproduce" step 0); nothing in the relay repository is read or written.
# Expected results are on the "expect" lines.
set -uo pipefail

echo "=== identity / platform ==="
id
uname -a
grep -E '^(PRETTY_NAME|VERSION)=' /etc/os-release
echo "HOME=$HOME   (the VM user's home — NOT the host home)"

echo "=== clone-mode: host repo is a READ-ONLY bind mount at /run/sandbox/source ==="
mount | grep -i 'sandbox/source' || mount | grep virtiofs
ls -la /run/sandbox/source

echo "=== the read-only source cannot be written (expect: Read-only file system) ==="
( touch /run/sandbox/source/ISH822-WRITE-TEST && echo "WROTE (unexpected)" ) 2>&1

echo "=== inspection surface: untracked + .gitignore'd files ARE readable (documented) ==="
cat /run/sandbox/source/untracked-sentinel.txt 2>&1
cat /run/sandbox/source/.env 2>&1

echo
echo "=== NEGATIVE TESTS — host-absolute paths (the host home is NOT mounted) ==="

echo "--- host /Users/81ueman (parent dir) — expect: No such file or directory"
ls -la /Users/81ueman 2>&1

echo "--- host HOME sentinel /Users/81ueman/ISH822_HOST_HOME_SENTINEL.txt — expect: No such file"
ls -la /Users/81ueman/ISH822_HOST_HOME_SENTINEL.txt 2>&1
cat /Users/81ueman/ISH822_HOST_HOME_SENTINEL.txt 2>&1

echo "--- host ~/.ssh /Users/81ueman/.ssh (private key) — expect: No such file"
ls -la /Users/81ueman/.ssh 2>&1
cat /Users/81ueman/.ssh/id_ed25519 2>&1

echo "--- host ~/Documents sentinel /Users/81ueman/Documents/ISH822_HOST_DOCUMENTS_SENTINEL.txt — expect: No such file"
ls -la /Users/81ueman/Documents/ISH822_HOST_DOCUMENTS_SENTINEL.txt 2>&1
cat /Users/81ueman/Documents/ISH822_HOST_DOCUMENTS_SENTINEL.txt 2>&1

echo "--- a different host repo (/private/var/.../ish822-other-repo) — expect: No such file"
ls -la /private/var/folders/2l/lk91l4dd1ysb1jfw7bkw0nrh0000gn/T/ish822-other-repo/secret.txt 2>&1

echo
echo "=== SSH agent forwarding is ON; the secret is the agent socket, not a key file ==="
echo "SSH_AUTH_SOCK=$SSH_AUTH_SOCK"
ssh-add -l
ls -la "$HOME/.ssh" 2>&1   # expect: No such file (no key file in the VM)

echo
echo "=== the sandbox runs its OWN docker engine (not the host daemon) ==="
docker info --format 'SandboxDocker={{.Name}} OS={{.OperatingSystem}} ARCH={{.Architecture}}'
ls -la /var/run/docker.sock
ls -la /Users/81ueman/.orbstack/run/docker.sock 2>&1   # expect: No such file
