#!/usr/bin/env bash
# ISH-822 in-sandbox isolation negative tests.
#
# Run inside the clone-mode sandbox:
#   sbx exec ish822-poc bash -lc "$(cat docs/ish-822-sandbox-poc/scripts/negative-tests.sh)"
#
# Every "SENTINEL" is a harmless file created on the HOST for this PoC; nothing
# in the relay repository is read or written. Expected results are on the
# "expect" lines.
set -uo pipefail

echo "=== identity / platform ==="
id
uname -a
grep -E '^(PRETTY_NAME|VERSION)=' /etc/os-release

echo "=== clone-mode: host repo is a READ-ONLY bind mount at /run/sandbox/source ==="
mount | grep -i 'sandbox/source' || mount | grep virtiofs
ls -la /run/sandbox/source

echo "=== the read-only source cannot be written (expect: Read-only file system) ==="
( touch /run/sandbox/source/ISH822-WRITE-TEST && echo "WROTE (unexpected)" ) 2>&1

echo "=== inspection surface: untracked + .gitignore'd files ARE readable (documented) ==="
cat /run/sandbox/source/untracked-sentinel.txt 2>&1
cat /run/sandbox/source/.env 2>&1

echo "=== host HOME sentinel is NOT visible (expect: No such file) ==="
ls -la ~/ISH822_HOST_HOME_SENTINEL.txt 2>&1

echo "=== host ~/.ssh is NOT visible / no host private key in the VM ==="
ls -la ~/.ssh 2>&1

echo "=== another host repo is NOT mounted (expect: No such file) ==="
ls -la /private/var/folders/2l/lk91l4dd1ysb1jfw7bkw0nrh0000gn/T/ish822-other-repo 2>&1

echo "=== SSH agent forwarding is ON; the secret is the agent socket, not a key file ==="
echo "SSH_AUTH_SOCK=$SSH_AUTH_SOCK"
ssh-add -l

echo "=== the sandbox runs its OWN docker engine (not the host daemon) ==="
docker info --format 'SandboxDocker={{.Name}} OS={{.OperatingSystem}} ARCH={{.Architecture}}'
ls -la /var/run/docker.sock
ls -la /Users/81ueman/.orbstack/run/docker.sock 2>&1   # expect: No such file
