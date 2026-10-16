# ISH-822 PoC — ARM64 Docker Sandbox + real `dsh` headless + Git-over-SSH isolation

**Scope:** measurement only. No Relay integration, no writes to the relay main
checkout, no existing Sandbox or global policy destroyed. All evidence below is
raw output captured on the machine named in
[`evidence/`](evidence/).

## TL;DR

On **Apple Silicon** (Darwin 25.2.0 `arm64`), a Docker Sandboxes **clone-mode**
sandbox created from a harmless verification Git repo runs a real
**`dsh` 0.2.0-rc.2 headless** deepseek model (via the host's configured
Ollama-Cloud provider) inside an **Ubuntu 26.04 `aarch64`** microVM, commits
inside its private clone, is reached by **Git over SSH through the forwarded
host agent** (no key file in the VM), and cannot see host personal areas, the
host Docker daemon, or other host repos. The clone's commit is fetched back to
the host with `git fetch sandbox-<name>`.

| Claim | Result |
| --- | --- |
| Apple Silicon + `sbx` install/version recorded | ✅ sbx `v0.48.0` |
| Clone-mode sandbox from a main checkout | ✅ `ish822-poc` |
| Real `dsh` 0.2.0-rc.2 headless run, JSONL + exit + commit | ✅ exit `0`, commit `526f8a1` |
| DeepSeek model via API **inside** the sandbox | ⚠️ DeepSeek model yes; **not** `api.deepseek.com` (no key on host) — see [Caveats](#caveats--not-verified) |
| Credential never enters the sandbox (proxy placeholder) | ✅ substitution proven on a 401-vs-200 endpoint; containment measured |
| Git over SSH using the forwarded agent, no key file | ✅ (over `ssh.github.com:443`) |
| Host personal areas / other repos / host Docker not visible | ✅ host-absolute sentinel negative tests |
| Balanced network policy effective allow/deny | ✅ allow npm/github/`*.github.com:443`; deny `example.com` → 403 |
| Sandbox clone commit fetched back on the host | ✅ `sandbox-ish822-poc/main` |
| No existing Sandbox / global policy destroyed | ✅ (one global policy *initialized*, was uninitialized) |
| Relay integration | ❌ none attempted (correct) |

## Environment (measured)

| Thing | Value | Evidence |
| --- | --- | --- |
| Host | `Darwin DaichinoMacBook-Pro.local 25.2.0 … RELEASE_ARM64_T8142 arm64` | session |
| `sbx` | `sbx version v0.48.0 5caf923e0587d376848f6f388eca3e0f5ca00e2d` | `01`, `20` |
| Host `dsh` | `0.2.0-rc.2` (`@deepseek-ai/dsh`) | session |
| Host Docker | Docker Desktop **not installed** (`ls -d /Applications/Docker.app` → `No such file`; `docker-desktop` → `command not found`; `~/.docker/cli-plugins/docker-sandbox` is a dangling symlink; active context `orbstack`) | `02a` |
| Sandbox kernel | `Linux ish822-poc 7.0.14 … aarch64 GNU/Linux` | `08`, `11` |
| Sandbox OS | `Ubuntu 26.04.1 LTS` | `08`, `11` |
| Sandbox user | `uid=1000(agent) … 27(sudo),1001(docker)`, `sudo` works | `08`, `09` |
| Sandbox toolchain | `node v22.22.1`, `npm 9.2.0`, `git`, `docker 29.8.1` | `11`, `20` |

**Apple-Silicon requirement (from Docker docs):** macOS Sonoma 14+ on Apple
Silicon for local sandboxes; Docker Desktop / Docker Engine are **not**
required for `sbx` (confirmed: Docker Desktop is absent here and `sbx` works).

## Reproduce

```bash
# 0. Resolve the PoC dir to an ABSOLUTE path FIRST — later steps `cd` into
#    $OTHER/$FIX, so relative script paths would silently expand to "".
POC="$(git rev-parse --show-toplevel)/docs/ish-822-sandbox-poc"

# 0a. HOST side: harmless sentinels + a separate "other" repo (host-absolute paths).
#     Nothing in the relay repo is touched. Proof they exist on the host (raw `ls`
#     is in evidence/00-host-sentinels-setup.log):
TMP=/private/var/folders/2l/lk91l4dd1ysb1jfw7bkw0nrh0000gn/T
printf 'HOST-HOME-SENTINEL-<home77>\n' > "$HOME/ISH822_HOST_HOME_SENTINEL.txt"
printf 'HOST-DOCUMENTS-SENTINEL-<docs88>\n' > "$HOME/Documents/ISH822_HOST_DOCUMENTS_SENTINEL.txt"
OTHER="$TMP/ish822-other-repo"; mkdir -p "$OTHER" && cd "$OTHER"
git init -q -b main && printf 'OTHER-REPO-SENTINEL-<other42>\n' > secret.txt
git add -A && git -c user.email=a@b.c -c user.name=x commit -q -m init
ls -la "$HOME/ISH822_HOST_HOME_SENTINEL.txt" "$HOME/.ssh" \
       "$HOME/Documents/ISH822_HOST_DOCUMENTS_SENTINEL.txt" "$OTHER/secret.txt"

# 0b. fixture: a harmless verification Git repo (main checkout, NOT a worktree)
FIX="$TMP/ish822-fixture"
mkdir -p "$FIX/src" && cd "$FIX"
git init -q -b main
git config user.email poc@example.invalid && git config user.name "ISH-822 POC"
printf 'ISH-822 harmless verification repo\n' > README.md
printf 'tracked\n' > src/app.txt
printf 'ISH822-UNTRACKED-SENTINEL-<abc123>\n' > untracked-sentinel.txt
printf 'ISH822-GITIGNORED-SECRET-<zzz999>\n' > .env
printf 'untracked-sentinel.txt\n.env\n' > .gitignore
git add README.md src/app.txt .gitignore && git commit -q -m "fixture: initial tracked content"

# 1. install sbx (standalone; Homebrew tap)
brew trust docker/tap && brew install docker/tap/sbx
sbx version

# 2. sign in (device code; a human completes it in a browser)
sbx login

# 3. global network policy — this host had NONE; initialize Balanced
sbx policy ls                       # -> "global network policy has not been initialized"
sbx policy init balanced

# 4. clone-mode sandbox from the fixture main checkout
cd "$FIX"
sbx create --clone --name ish822-poc shell "$FIX"

# 5. allow the model provider hosts for THIS sandbox only
sbx policy allow network --sandbox ish822-poc \
  "api.deepseek.com:443,ollama.com:443,opencode.ai:443"

# 6. isolation negative tests
sbx exec ish822-poc bash -lc "$(cat "$POC/scripts/negative-tests.sh")"

# 7. store the provider key via the credential proxy (placeholder; real value stays on host)
HOSTKEY_CMD=/abs/path/to/get-ollama-key.sh      # prints the key to stdout on the host
sbx secret set-custom --sandbox ish822-poc --host ollama.com \
  --env OLLAMA_CLOUD_V41_API_KEY --command "$HOSTKEY_CMD"
sbx secret ls                                    # copy the placeholder

# 8. install dsh in the sandbox and run it (overlay file from scripts/)
sbx exec ish822-poc bash -lc 'npm i -g @deepseek-ai/dsh@0.2.0-rc.2 && dsh --version'
sbx exec ish822-poc bash -lc 'cat > /home/agent/dsh-overlay.yml' \
  < "$POC/scripts/dsh-overlay.yml"
sbx exec -e OLLAMA_CLOUD_V41_API_KEY=<placeholder> -w "$FIX" \
  ish822-poc bash -lc "$(cat "$POC/scripts/run-dsh-in-sandbox.sh")"

# 9. Git over SSH (forwarded agent; GitHub SSH on 443)
sbx exec ish822-poc bash -lc \
  'GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new" \
   git ls-remote ssh://git@ssh.github.com:443/81ueman/relay.git HEAD refs/heads/main'

# 9b. prove the real key is NOT inside the sandbox — run AFTER the dsh run (step 8),
#     so dsh has written its session/log state (the `ISH-822` positive control needs it).
#     The key stays on the HOST: the VM filesystem is streamed out and grepped host-side.
KEY_CMD="$HOSTKEY_CMD" bash "$POC/scripts/containment-probe.sh"

# 10. fetch the sandbox commit back to the host
git -C "$FIX" fetch sandbox-ish822-poc

# 11. cleanup
sbx exec ish822-poc bash -lc 'docker rm -f ish822-sbx-probe' || true
sbx stop ish822-poc
sbx secret rm --placeholder <placeholder> --sandbox ish822-poc -f
# full removal (drops the in-VM clone — fetch first):
#   sbx rm --force ish822-poc
```

## What was measured

### 1. `sbx` install / diagnose ([`01`](evidence/01-sbx-install.log), [`02`](evidence/02-sbx-state-before-login.log), [`03`](evidence/03-sbx-diagnose.log))

`brew install docker/tap/sbx` → `sbx was successfully installed!` /
`sbx version v0.48.0`. `sbx diagnose`: virtualization `kern.hv_support is 1`,
`mkfs.erofs`/`mkfs.ext4` present, 221.5 GiB free. Before sign-in, `sbx ls` and
`sbx policy ls` returned `not signed in to Docker` ([`02`](evidence/02-sbx-state-before-login.log)).

### 2. Global policy ([`04`](evidence/04-sbx-precreate-state.log), [`05`](evidence/05-policy-init-balanced.log), [`07`](evidence/07-policy-allow-providers.log))

`sbx policy ls` → `error: global network policy has not been initialized`
([`04`](evidence/04-sbx-precreate-state.log)). Initialized `balanced`: `network: 194 allow;
filesystem read: 1 allow; filesystem write: 1 allow`. **Only an uninitialized
policy was initialized; no existing policy was overwritten.** The three
provider hosts were then allowed for **this sandbox only**
(`sbx policy allow network --sandbox ish822-poc …`, [`07`](evidence/07-policy-allow-providers.log)).

### 3. Clone-mode sandbox ([`06`](evidence/06-sbx-create-clone.log))

```
$ sbx create --clone --name ish822-poc shell "$FIX"
  ✓ workspace — Git repository at …/ish822-fixture
  ✓ Created sandbox ish822-poc
      source …/ish822-fixture → /run/sandbox/source (ro)
```

### 4. Isolation negative tests ([`08`](evidence/08-sandbox-env-isolation.log), [`09`](evidence/09-sandbox-clone-engine-tooling.log), [`10`](evidence/10-clone-isolation-host-side.log))

```
HOME=/home/agent   (the VM user's home — NOT the host home)
host on /run/sandbox/source type virtiofs (ro,nosuid,nodev,relatime)
touch /run/sandbox/source/ISH822-WRITE-TEST  -> Read-only file system

# NEGATIVE TESTS probe HOST-ABSOLUTE paths (probing `~` inside the VM is vacuous):
ls /Users/81ueman                                          -> No such file or directory
ls /Users/81ueman/ISH822_HOST_HOME_SENTINEL.txt            -> No such file or directory
cat /Users/81ueman/.ssh/id_ed25519                         -> No such file or directory
ls /Users/81ueman/Documents/ISH822_HOST_DOCUMENTS_SENTINEL.txt -> No such file or directory
ls …/ish822-other-repo/secret.txt                          -> No such file or directory
ls /Users/81ueman/.orbstack/run/docker.sock                -> No such file or directory
```

`negative-tests.sh` probes `/Users/81ueman/...` (the **host** home), not `~`
(which inside the VM is `/home/agent`). The host home is not mounted at all — the
whole `/Users/81ueman` path is absent — which is the meaningful, non-vacuous
form of the ISH-822 §6 negative test. (The only `~/.ssh` inside the VM is the
sandbox's own, created by the SSH client and holding only `known_hosts`, no key.)

The clone is a **separate writable copy**: a file written by the sandbox to the
workspace path does **not** appear on the host, and the host fixture `git status
--porcelain` is empty ([`10`](evidence/10-clone-isolation-host-side.log),
[`18`](evidence/18-host-fetch-sandbox-commit.log)). Per the Docker docs, clone mode
protects against *modification*, **not inspection** — untracked and `.gitignore`'d
files (here `.env`) remain readable, which is exactly what the sentinels show.

### 5. Docker-engine isolation ([`19`](evidence/19-docker-engine-isolation.log))

```
HOST:     27 containers; socket unix:///Users/81ueman/.orbstack/run/docker.sock
SANDBOX:  own /var/run/docker.sock -> /run/docker.sock, 0 containers
          docker run -d --name ish822-sbx-probe alpine sleep 60  -> started
          /Users/81ueman/.orbstack/run/docker.sock -> No such file or directory
HOST after: 27 containers (sandbox container NOT visible; host socket unreachable)
```

### 6. Credential proxy ([`12`](evidence/12-secret-set-custom.log), [`12a`](evidence/12a-secret-readd.log), [`14`](evidence/14-credential-proxy-probe.log))

`sbx secret set-custom --sandbox ish822-poc --host ollama.com --env
OLLAMA_CLOUD_V41_API_KEY --command /abs/get-ollama-key.sh` stores the real value
on the host and exposes only a placeholder (`sbx-cs-…`) to the sandbox. The
placeholder is a **real** substitution, proven on an **authenticated** endpoint
(the completion API — the model list is public and proves nothing):

```
POST https://ollama.com/v1/chat/completions
  no auth          -> 401 {"error":{"message":"Unauthorized",…}}
  BOGUS auth       -> 401 {"error":{"message":"Unauthorized",…}}
  PLACEHOLDER auth -> 200 {"id":"chatcmpl-637",…,"model":"deepseek-v4.1-flash:cloud",…}
GET  /v1/models with BOGUS auth -> 200          # public; why the earlier 200 was meaningless
curl https://example.com        -> 403          # Balanced deny
```

The real key never enters the sandbox — measured **host-side**, keeping the key
on the host ([`14b`](evidence/14b-real-key-containment.log), script
[`containment-probe.sh`](scripts/containment-probe.sh)): the sandbox's
`/{home/agent,tmp,etc,var/tmp,opt}` is streamed *out* (`sudo tar` over `sbx exec`)
and grepped **on the host** with the real key, so the value is never sent into
the VM. It is run **after the dsh run** (README step 9b), and the script exits
non-zero unless both positive controls are `>=1` and the key/placeholder counts
are `0` — so `RESULT: PASS` / `EXIT=0` below is a real pass, not an absence:

```
# sandbox user          : agent
# host sha256(real key) : dc0865b0…                              # host-side, hash only
# NOTE: taken AFTER the dsh run (README step 9b), so dsh session/log state exists
# stream: 184616960 bytes (tar), 179868429 bytes (extracted)
# POSITIVE CONTROLS (must be >=1):
#   grep -acF 'Ubuntu'      = 21                                  # proves the stream IS inspected
#   grep -acF 'ISH-822'     = 8                                   # from dsh's own run state
# SUBJECT (must be 0):
#   grep -acF -f <(KEY_CMD) = 0                                   # real key absent
#   grep -acF 'sbx-cs-'     = 0                                   # placeholder not persisted either
RESULT: PASS
```

The script's **failure path** is exercised in
[`14c`](evidence/14c-containment-probe-selftest.log): forcing a key that matches
present text yields `grep -acF -f <(KEY_CMD) = 21`, then
`FAIL: real key present in the sandbox (21 matches)`, `RESULT: FAIL`, `EXIT=1`.

(The sandbox was created *before* the secret, so the placeholder was also passed
explicitly with `sbx exec -e` — placeholders are not secret.)

### 7. Real `dsh` headless run ([`13`](evidence/13-sandbox-overlay.log), [`15`](evidence/15-sandbox-dsh-run.log))

`npm i -g @deepseek-ai/dsh@0.2.0-rc.2` → `dsh --version` = `0.2.0-rc.2`. The
shipped `headless` profile defaults to `deepseek-official`/`deepseek-flash`;
this host has no DeepSeek key, so `scripts/dsh-overlay.yml` selects the host's
Ollama-Cloud DeepSeek model. Run:

```
$ DSH_PERMISSION_MODE=workspace-write dsh --profile headless \
    --patch /home/agent/dsh-overlay.yml --json "<task>"
DSH_EXIT=0
{"type":"session","sessionId":"session-76446c5f-…","cwd":"…/ish822-fixture"}
{"type":"status","phase":"turn_start","turn":1}
… {"type":"tool_call","callId":"call_vizitsrt","tool":"read", …}
… {"type":"tool_call","callId":"call_8skp12ft","tool":"write", …}
… {"type":"tool_call","callId":"call_y2ftscec","tool":"bash","input":{"command":"git status …"}}
… {"type":"tool_call","callId":"call_09mm5xn3","tool":"bash","input":{"command":"git add poc-note.txt && git commit -m \"ISH-822: sandbox dsh commit\" …"}}
… {"type":"tool_result","callId":"call_09mm5xn3","status":"completed", … "[main 526f8a1] …"}
{"type":"final","text":"DSH_SANDBOX_OK"}
```

`git log` (in the clone) → `526f8a1 ISH-822: sandbox dsh commit`; produced HEAD
`526f8a13e88e58429f8a4a27c31f16a24cc92bd1`. The run committed **only**
`poc-note.txt`, not the earlier write-probe.

### 8. Git over SSH ([`16`](evidence/16-sandbox-git-ssh-port22.log), [`17`](evidence/17-sandbox-git-ssh-443.log))

```
SSH_AUTH_SOCK=/run/ssh-agent.sock
ssh-add -l -> 256 SHA256:NS4st6… mathmathds@gmail.com (ED25519)   # host key, forwarded
~/.ssh -> no private key (absent on first run; later holds only the sandbox's own known_hosts)
ssh -T git@ssh.github.com -p 443 -> Hi 81ueman! You've successfully authenticated…
git ls-remote ssh://git@ssh.github.com:443/81ueman/relay.git HEAD refs/heads/main
  -> ad7ab7d…  HEAD
  -> ad7ab7d…  refs/heads/main
git fetch …/relay.git main -> * branch main -> FETCH_HEAD          # read-only
```

SSH on **port 22** fails: the TCP connect succeeds but the remote closes the
session (`Connection closed by 20.27.177.113 port 22`, [`16`](evidence/16-sandbox-git-ssh-port22.log)).
The effective policy has no `:22` rule — `sbx policy ls ish822-poc --json` shows
`github.com:443`, `**.github.com:443`, `**.githubusercontent.com:443`,
`**.githubcopilot.com:443` and **zero** `:22` rules
([`07a`](evidence/07a-policy-rules-github.log)); the exact accept-then-close
mechanism is observed but not further explained. GitHub's SSH-on-443 endpoint
(`ssh.github.com:443`) is therefore used. No push/PR is performed (out of scope).

### 9. Host fetch of the sandbox commit ([`18`](evidence/18-host-fetch-sandbox-commit.log))

```
$ git -C "$FIX" fetch sandbox-ish822-poc
From git://127.0.0.1:49156/ish822-fixture
 * [new branch]      main       -> sandbox-ish822-poc/main
$ git -C "$FIX" rev-parse HEAD   -> ab967ff…      # host HEAD unchanged
$ git -C "$FIX" status --porcelain -> (clean)
```

(An earlier round-0 fetch also printed a `refs/sandboxes/ish822-poc/main` ref
line; the committed `evidence/18` from the re-run above is the authoritative one.)

### 10. Cleanup ([`20`](evidence/20-final-state-cleanup.log), [`21`](evidence/21-secret-cleanup.log))

Probe container removed; sandbox **stopped** (kept, not removed); the two
sandbox-scoped custom secrets removed (`sbx secret ls` → `No secrets found`).
`sbx rm --force ish822-poc` documented as full teardown (would drop the in-VM
clone — fetch first).

## Caveats / NOT verified

- **"DeepSeek API" is the DeepSeek *model*, not `api.deepseek.com`.** The host
  has **no** `DEEPSEEK_API_KEY` ([`02b`](evidence/02b-no-deepseek-key.log): `env`
  shows it unset, no shell-rc assignment, and the dsh credential store lists only
  `OPENCODE_GO_API_KEY`, `OLLAMA_CLOUD_V41_API_KEY`, `COMMAND_CODE_GOAT_API_KEY`).
  The run therefore used the host's
  configured Ollama-Cloud DeepSeek model (`deepseek-v4.1-flash:cloud`). A run
  against the DeepSeek-official endpoint is **Not verified**:
  `dsh --profile headless --json …` with the shipped default provider was not
  executed because no `DEEPSEEK_API_KEY` exists on this host.
- **No real push / PR / merge from the sandbox** (explicitly out of scope);
  only read-only `ls-remote`/`fetch` over SSH were performed.
- **SSH port 22** is not usable (TCP connect accepted, session closed by the
  remote); the effective policy has no `:22` rule ([`07a`](evidence/07a-policy-rules-github.log)),
  so `443` is used.
- **`sbx login` is human-gated** (device code). Automation would need a Docker
  PAT via `sbx login --username … --password-stdin`.
- Relay was **not modified**; this is a `docs/`-only PoC change (no `src/`,
  no `formal/`, so no TLC run is required per `AGENTS.md`).
