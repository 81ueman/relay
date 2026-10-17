# ISH-845 — Network Lab skill + Task-owned lab cleanup: real evidence

**Issue:** ISH-845 (`[agent][lab] Network Lab skill and task-owned lab cleanup
hook`) — companion to [`../ish845-network-lab-skill.md`](../ish845-network-lab-skill.md).
**Host:** macOS (Darwin), arm64; Docker Sandboxes `sbx v0.48.0`.
**Dates:** 2026-10-17 (UTC) — §1–§4 from round 1, §3c/§6 from the round-2 fix.

Everything below was run against the **live Shared Lab** (`sbx` sandbox
`ish824-lab`, `clab-api-server` v0.8.0, real `ghcr.io/nokia/srlinux:latest`) and
a **real `dsh 0.2.0-rc.2`** agent inside a Coding Sandbox (`ish827-kit`, with the
`network-lab` skill installed at the real dsh sandbox skill path). Raw outputs are
committed under [`evidence/`](evidence/). Secrets are not recorded.

> Note: the provider route for the real dsh run is the ISH-822/827 recipe — an
> Ollama-Cloud `--patch` overlay plus an `sbx secret set-custom` credential
> proxy, so the sandbox sees only a `sbx-cs-…` placeholder. Credentials for
> `labctl` are provisioned by the operator at runtime (`~/.labctl.env` in the
> sandbox / the hook's own file), never in the skill.

## 1. The real dsh Agent loads the skill and completes deploy→inspect→exec→destroy

`network-lab` was installed at the path `dsh 0.2.0-rc.2` actually scans for a
sandbox/user skill, `/home/agent/.agents/skills/network-lab/SKILL.md`
(`@deepseek-ai/dsh-skill-filesystem` → `FileSystemSkillProvider.roots`,
`$AGENTS_HOME/skills`). The exact same file is what the Coding Kit ships
(`sbx kit inspect ./sandbox/coding-kit` → `Files: 2 home`; the kit copy is pinned
byte-for-byte by `tests/network-lab-skill.test.ts`).

A real headless run (`dsh --profile headless --patch … --json`) was given only
"use the `network-lab` skill to run a real network E2E owned by this task". The
original dsh JSONL is committed as
[`evidence/dsh-network-lab-e2e.jsonl`](evidence/dsh-network-lab-e2e.jsonl).

The agent **loaded the skill** (first tool call, `<skill_content name="network-lab">`)
and then, on the live Lab:

| step | command | exit |
| --- | --- | --- |
| deploy | `labctl deploy -t netlab-agent845/netlab-agent845.clab.yml --namespace "$RELAY_LAB_OWNER" --api "$LABCTL_API" --insecure --json` | `0` |
| inspect | `labctl inspect "netlab-$RELAY_LAB_OWNER" --json --reach-host host.docker.internal --api "$LABCTL_API" --insecure` | `0` |
| observe | `labctl exec --api "$LABCTL_API" --insecure "netlab-$RELAY_LAB_OWNER/srl1" -- sr_cli info system name` → `host-name netlab-agent845-srl1` | `0` |
| destroy | `labctl destroy --name "netlab-$RELAY_LAB_OWNER" --api "$LABCTL_API" --insecure --json` → `{"destroyed":true,…}` | `0` |
| confirm | `labctl inspect --json --api "$LABCTL_API" --insecure` → `{}` | `0` |

This run also **corrected two real skill bugs**, now fixed in
`skills/network-lab/SKILL.md`: `labctl` reads the topology `name:` **verbatim**
(no shell expansion — write the owner id in), and `--insecure` is a
**per-subcommand** option (before `<lab>/<node>` for `exec`); `destroy` takes
`--name` (no `--namespace`).

## 2. gNMI / NOS observation on the live Lab

With a published gNMI port and the exact `reachable_at` from `inspect --json`:

```console
$ labctl inspect netlab-T1 --json --reach-host localhost …
srl1 [(22, "localhost:18021"), (57400, "localhost:18011")]
$ gnmic -a localhost:18011 -u admin -p '…' --skip-verify -e json_ietf get --path /system/name/host-name
[ { "source": "localhost:18011", … "values": { "…host-name": "srl1" } } ]      # exit 0
$ labctl exec netlab-T1/srl1 -- sr_cli info system name   →  host-name srl1
$ labctl exec netlab-T1/srl2 -- sr_cli info system name   →  host-name srl2     # startup-config applied
```

Raw: [`evidence/gnmi-observation.txt`](evidence/gnmi-observation.txt),
[`evidence/labctl-exec-observation.txt`](evidence/labctl-exec-observation.txt),
[`evidence/labctl-t1-inspect.json`](evidence/labctl-t1-inspect.json).

## 3. Relay holds the owner id and cleans only that Task's lab

> Round-1 evidence below used a pre-commit hook variant and an owner id equal to
> the task id (`T1`/`T2`). The **round-2 fix** makes the owner id never-reused
> (`<id>-<created_at>`) and ships the hardened reference hook; the new behaviour
> is covered by `tests/lab-cleanup.test.ts`, `tests/lab-cleanup-hook.test.ts`
> and `tests/gc.test.ts`, plus the live §3c check.

Two real labs were deployed one per Task — `netlab-T1` (namespace `T1`) and
`netlab-T2` (namespace `T2`) —
[`evidence/labctl-labs-both-tasks.json`](evidence/labctl-labs-both-tasks.json).

### 3a. T1 — plan, then apply

```console
$ relay run cleanup T1 --abort "ISH-845 evidence" --json        # dry-run
  labCleanup.status = "dry-run"
$ relay run cleanup T1 --abort "ISH-845 evidence" --apply --json
  labCleanup = { status: "ok", cleaned: true, exitCode: 0 }
$ labctl inspect --json …   →  ["netlab-T2"]                    # T1 gone, T2 intact
```

Raw: [`evidence/relay-cleanup-t1-plan.json`](evidence/relay-cleanup-t1-plan.json),
[`evidence/relay-cleanup-t1-apply.json`](evidence/relay-cleanup-t1-apply.json),
[`evidence/labctl-labs-after-t1.json`](evidence/labctl-labs-after-t1.json).

### 3b. T2 — failure injection, then retry

A hook that reports an auth error (exit `4`) was injected:

```console
$ RELAY_LAB_CLEANUP_CMD=…/lab-cleanup-authfail.sh relay run cleanup T2 --abort … --apply --json
  labCleanup = { status: "failed", exitCode: 4, error: "labctl: authentication failed (injected)" }
$ labctl inspect --json …   →  ["netlab-T2"]                    # cleanup failed ⇒ lab NOT destroyed
$ relay run cleanup T2 --abort … --apply --json
  labCleanup = { status: "ok", cleaned: true }
$ labctl inspect --json …   →  {}                               # retry succeeded
```

Raw: [`evidence/relay-cleanup-t2-failure-injection.json`](evidence/relay-cleanup-t2-failure-injection.json),
[`evidence/labctl-labs-after-t2-failure.json`](evidence/labctl-labs-after-t2-failure.json),
[`evidence/relay-cleanup-t2-retry.json`](evidence/relay-cleanup-t2-retry.json),
[`evidence/labctl-labs-final.json`](evidence/labctl-labs-final.json).

The durable Relay events (including the retry of a hook that had failed for
**missing credentials**, exit `1`) are committed as
[`evidence/relay-lab-cleanup-events.jsonl`](evidence/relay-lab-cleanup-events.jsonl):

```
T1 lab.cleanup_failed {exitCode:1}   ← hook ran without labctl creds (fail closed, recorded)
T1 lab.cleaned        {exitCode:0}   ← retry succeeded
T2 lab.cleanup_failed {exitCode:4}   ← injected auth error, recorded
T2 lab.cleaned        {exitCode:0}   ← retry succeeded
```

### 3c. The committed hook, run live, selects strictly by owner (round 2)

`scripts/lab-cleanup.sh` (the documented `RELAY_LAB_CLEANUP_CMD`) was copied into
the coding sandbox and run against the live Lab with two labs present:
`netlab-agent845b` (owner `agent845b`) and `bgp-agent845b` in **another** owner's
namespace — the exact name-suffix trap.

```console
$ sh /home/agent/lab-cleanup.sh agent845b
lab-cleanup: destroying netlab-agent845b (owner=agent845b)
{ "destroyed": true, "lab": "netlab-agent845b", … }
lab-cleanup: done owner=agent845b (destroyed=1; images untouched)   # HOOK_EXIT=0

$ labctl inspect --json …   →  ["bgp-agent845b"]                    # the decoy SURVIVED
```

Raw: [`evidence/hook-live-run.txt`](evidence/hook-live-run.txt),
[`evidence/labctl-labs-after-hook.json`](evidence/labctl-labs-after-hook.json).
The companion unit test (`tests/lab-cleanup-hook.test.ts`) pins the same rule
against a fake `labctl` with `netlab-T1`, `bgp-T1` and `netlab-T11`, asserting
only `netlab-T1` is destroyed.

## 4. NOS images are retained after cleanup

```console
$ (in ish824-lab, after all labs destroyed)
$ docker images --format "{{.Repository}}:{{.Tag}}"; echo count=$(docker images -q | wc -l)
ghcr.io/srl-labs/clab-api-server/clab-api-server:latest
ceos:4.36.0.1F
ghcr.io/nokia/srlinux:latest
alpine:3.20
count=4
```

Both `ghcr.io/nokia/srlinux:latest` (SR Linux) and `ceos:4.36.0.1F` (cEOS) remain
— the shared image cache is never touched by a lab destroy.

## 5. Done-when

| Done-when | Verdict | Evidence |
| --- | --- | --- |
| A real dsh Agent references the skill and completes deploy→inspect→gNMI/SSH observe→destroy on an arbitrary topology | **PASS** | §1 (real `dsh` run, skill loaded, all steps exit 0); §2 (`gnmic` + `sr_cli`) |
| Relay holds the Task's external Lab owner id and can clean it; a Lab-unused Task does nothing extra | **PASS** | §3; owner id assigned durably (`lab.owner_assigned`) and never reused; `planLabCleanup` skips a Task with no assignment; the committed hook runs **through Relay** with the forwarded `LABCTL_*` env (§7) |
| Two Tasks' independent labs: ending one does not destroy the other | **PASS** | §3a (after T1 cleanup only `netlab-T2` remains); §3c (suffix decoy survives); two-task isolation test |
| Failure injection (interruption/timeout, lab gone, auth error, Task crash) handled with evidence and re-runnable | **PASS** | §3b; `tests/lab-cleanup.test.ts` (auth error, timeout, missing executable) + `tests/gc.test.ts` (gc refuses a pending cleanup, so it stays re-runnable) |
| One set of SR Linux/cEOS images remains in the Shared Lab after cleanup | **PASS** | §4 |
| A human can still use `labctl` without Relay | **PASS** | §1–§3 used plain `labctl`; the hook is a normal `labctl` script; `labctl` is unchanged |
| No `relay lab` network command is added | **PASS** | `relay run [sandbox] cleanup` only; no `relay lab` exists |

## 6. Round-2 review fixes

1. **Active-run guard** — `planLabCleanup` now refuses while any `runs` row for
   the Task is `starting`/`running`, even with `--abort` (`tests/lab-cleanup.test.ts`:
   active Run + `--abort` ⇒ skipped, hook not called).
2. **Never-reused owner id** — `labOwnerId` = `<id>-<created_at>`; **and**
   `planGc` skips a terminal Task whose latest `lab.*` event is not `lab.cleaned`
   while a hook is configured (`tests/gc.test.ts`). After gc the Task survives, so
   the cleanup stays addressable and re-runnable, and a reused Task id cannot
   collide with or destroy the earlier Task's lab.
3. **Committed, strict reference hook** — [`scripts/lab-cleanup.sh`](../../scripts/lab-cleanup.sh)
   selects exactly `netlab-<owner>` (never by suffix) and purges the owner's
   leftover workspace; pinned by `tests/lab-cleanup-hook.test.ts` and exercised
   live in §3c.
4. **Owner assignment recorded / skipped** — `launchTaskSandboxRun` writes
   `lab.owner_assigned`; `planLabCleanup` skips with reason `no lab owner
   assigned` when absent, so a Lab-unused Task makes **no** external call even
   with a hook configured (`tests/lab-cleanup.test.ts`).

**Not verified:** cEOS was present in the cache but no cEOS topology was deployed
(SR Linux was); many-node / concurrent-lab scale is untested; the provider route
for the dsh run was Ollama-Cloud (no `DEEPSEEK_API_KEY` on this host).

## 7. Round-3 review fixes

1. **The hook can authenticate when Relay runs it** — `applyLabCleanup` now gives
   the hook a narrow, explicitly named `LABCTL_*` set copied from Relay's own
   environment (`labCleanupHookEnv` / `LABCTL_ENV_ALLOWLIST`: `API`, `USER`,
   `PASSWORD`, `PASSWORD_FILE`, `TOKEN`, `CA_CERT`, `BIN`); the hook may instead
   load `$HOME/.config/relay/labctl.env`. `tests/lab-cleanup.test.ts` runs the
   committed `scripts/lab-cleanup.sh` **through `applyLabCleanup` +
   `realLabCleanupRunner`** against a fake `labctl` and asserts the credentials
   arrive and the result is `ok`. (The round-1 §3c live run invoked the hook by
   hand; the through-Relay path is now covered by a test.) The design doc's
   credential/isolation wording is corrected: the SSH agent socket *is* part of
   the `childEnv()` startup allowlist for every Relay child; the reference hook
   reads credentials from the environment (or the operator file), not "its own".
2. **The workspace purge fails closed** — `scripts/lab-cleanup.sh` treats only
   labctl's `EXIT_NOTFOUND` (6: no remote dir, or a lab still exists) as a no-op
   and exits non-zero on any other purge failure (auth 4, API 5, timeout 7, …),
   so a hidden purge failure can never be recorded as `lab.cleaned` and leak the
   directory. `tests/lab-cleanup-hook.test.ts` covers purge `5`/`7` (hook exits
   non-zero) and `6` (no-op).
