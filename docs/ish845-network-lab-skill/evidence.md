# ISH-845 — Network Lab skill + Task-owned lab cleanup: real evidence

**Issue:** ISH-845 (`[agent][lab] Network Lab skill and task-owned lab cleanup
hook`) — companion to [`../ish845-network-lab-skill.md`](../ish845-network-lab-skill.md).
**Host:** macOS (Darwin), arm64; Docker Sandboxes `sbx v0.48.0`.
**Date:** 2026-10-17 (UTC).

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
(`sbx kit inspect ./sandbox/coding-kit` → `Files: 2 home`, including the skill
path; `tests/network-lab-skill.test.ts` pins the byte-for-byte copy).

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

`dsh` exited `0` and its `final` reports the whole run. The topology the agent
wrote contains a **task-owned** lab name (`netlab-<owner>`) and a
`startup-config` asset applied to the node.

This run also **corrected two real skill bugs**, which are now fixed in
`skills/network-lab/SKILL.md`:

1. `labctl` reads the topology `name:` **verbatim** — it does not shell-expand
   `$RELAY_LAB_OWNER`, and the API rejects `Invalid characters in lab name`. The
   skill now says to **write** the owner id into `name:` before deploying.
2. `--insecure` is a **per-subcommand** option: `labctl --insecure deploy …`
   fails `unrecognized arguments`; for `exec` it must precede `<lab>/<node>`
   (everything after `--` is the remote command). The skill now shows the
   correct placement, and that `destroy` takes `--name` (no `--namespace`).

## 2. gNMI / NOS observation on the live Lab

With a published gNMI port and the exact `reachable_at` from `inspect --json`:

```console
$ labctl inspect netlab-T1 --json --reach-host localhost …
srl1 [(22, "localhost:18021"), (57400, "localhost:18011")]
$ gnmic -a localhost:18011 -u admin -p '…' --skip-verify -e json_ietf get --path /system/name/host-name
[ { "source": "localhost:18011", … "values": { "…host-name": "srl1" } } ]      # exit 0
$ labctl exec netlab-T1/srl1 -- sr_cli info system name
    host-name srl1
$ labctl exec netlab-T1/srl2 -- sr_cli info system name
    host-name srl2                                                              # startup-config applied
```

Raw: [`evidence/gnmi-observation.txt`](evidence/gnmi-observation.txt),
[`evidence/labctl-exec-observation.txt`](evidence/labctl-exec-observation.txt),
[`evidence/labctl-t1-inspect.json`](evidence/labctl-t1-inspect.json).

## 3. Relay holds the owner id and cleans only that Task's lab

Two real labs were deployed, one per Task, named and namespaced by the owner id:
`netlab-T1` (namespace `T1`) and `netlab-T2` (namespace `T2`) —
[`evidence/labctl-labs-both-tasks.json`](evidence/labctl-labs-both-tasks.json)
shows both.

The single trusted hook (`RELAY_LAB_CLEANUP_CMD`) is invoked as
`<cmd> <task-id>`; it lists the Labs and destroys only the owner's own
(`name == netlab-<owner>`), never touching images or other Tasks' labs.

### 3a. T1 — plan, then apply

```console
$ relay run cleanup T1 --abort "ISH-845 evidence" --json        # dry-run
  labCleanup.status = "dry-run"   ownerId = "T1"
$ relay run cleanup T1 --abort "ISH-845 evidence" --apply --json
  labCleanup = { ownerId: "T1", status: "ok", cleaned: true, exitCode: 0 }

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

The durable Relay events (also the retry of a hook that had failed for **missing
credentials**, exit `1`, before the operator file was provisioned) are committed
as [`evidence/relay-lab-cleanup-events.jsonl`](evidence/relay-lab-cleanup-events.jsonl):

```
T1 lab.cleanup_failed {exitCode:1}     ← hook ran without labctl creds (fail closed, recorded)
T1 lab.cleaned        {exitCode:0}     ← retry succeeded
T2 lab.cleanup_failed {exitCode:4}     ← injected auth error, recorded
T2 lab.cleaned        {exitCode:0}     ← retry succeeded
```

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
| A real dsh Agent references the skill and completes deploy→inspect→gNMI/SSH observe→destroy on an arbitrary topology | **PASS** | §1 (real `dsh` run, skill loaded, deploy/inspect/exec/destroy all exit 0); §2 (`gnmic` + `sr_cli`) |
| Relay holds the Task's external Lab owner id and can clean it; a Lab-unused Task does nothing extra | **PASS** | §3; `labOwnerId` = task id, injected as `RELAY_LAB_OWNER`; no hook configured ⇒ pure no-op (`tests/lab-cleanup.test.ts`) |
| Two Tasks' independent labs: ending one does not destroy the other | **PASS** | §3a — after T1 cleanup only `netlab-T2` remains |
| Failure injection (interruption/timeout, lab gone, auth error, Task crash) handled with evidence and re-runnable | **PASS** | §3b — exit 4 recorded, lab intact, retry succeeds; timeout + missing-executable + crash cases in `tests/lab-cleanup.test.ts` |
| One set of SR Linux/cEOS images remains in the Shared Lab after cleanup | **PASS** | §4 |
| A human can still use `labctl` without Relay | **PASS** | §1–§3 used plain `labctl` from the host and the sandbox; the hook is a normal `labctl` script; `labctl` is unchanged |
| No `relay lab` network command is added | **PASS** | `relay run [sandbox] cleanup` only; no `relay lab` exists |

**Not verified here:** cEOS was present in the cache but no cEOS topology was
deployed (SR Linux was); many-node / concurrent-lab scale is untested (per the
ISH-844 limits); the provider route for the dsh run was Ollama-Cloud (no
`DEEPSEEK_API_KEY` on this host).
