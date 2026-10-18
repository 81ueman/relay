# ISH-830 — real DeepSeek → Shared-Lab SR Linux → Claude FIX factory E2E

**Issue:** [ISH-830](https://linear.app/ishiul/issue/ISH-830) — *[test][factory] Real
DeepSeek → Shared Lab SR Linux → Claude FIX E2E*. **Kind:** E2E harness + evidence
record. Companion to [`factory-e2e.md`](factory-e2e.md) (ISH-762),
[`ish829-verify-in-sandbox.md`](ish829-verify-in-sandbox.md) (the Sandbox VERIFY
boundary), [`sandbox-lifecycle.md`](sandbox-lifecycle.md) (ISH-828) and
[`ish845-network-lab-skill.md`](ish845-network-lab-skill.md) (the Lab skill +
Task-owned cleanup).

> **Scope.** This is the **SR Linux / Shared-Lab** E2E, not the GitHub PR-integration
> E2E (ISH-885). It does **not** re-implement ISH-762's FSM/harness: it drives the
> existing `runFactoryTask` over a durable Coding Sandbox (ISH-878) and reuses
> ISH-829's `sandboxVerifyTarget` VERIFY boundary and ISH-845's Task-owned Lab
> identity. Relay gains **no** lab engine, no NOS/image management, and no
> `relay lab` command.

## The harness

`scripts/ish830-real-e2e.ts` (opt-in: `RELAY_ISH830_E2E=1`) is the single entry
point. It is **honest**: a leg that cannot run is recorded `BLOCKED`/`NOT_RUN` with
the exact command — **never** a `PASS`.

```sh
RELAY_ISH830_E2E=1 \
LABCTL_API=https://host.docker.internal:49170 LABCTL_INSECURE=1 \
LABCTL_USER=<u> LABCTL_PASSWORD=<pw>   # or LABCTL_TOKEN=<jwt> \
  bun scripts/ish830-real-e2e.ts
# stage selection: ISH830_STAGES=env,provider,nos,parallel,factory
```

| stage | what it drives |
| --- | --- |
| `env` | Mac/ARM64 + `sbx`/`dsh`/`claude` versions, the Shared Lab VM + `clab-api-server` + SR Linux image ID, and host/Lab time/disk/RAM |
| `provider` | the pinned headless `dsh` (`0.2.1-rc.2`) provider leg |
| `nos` | a REAL Coding Sandbox (`sbx create --clone`) VERIFYs the **exact bound HEAD** against a **real** Shared-Lab SR Linux through ISH-829's `sandboxVerifyTarget`; plus failure injections |
| `parallel` | two Task-named labs deployed concurrently; destroying one leaves the other running; the shared image survives |
| `factory` | the REAL `runFactoryTask` over a durable Coding Sandbox (ISH-878) with the pinned `dsh`; PASS is gated on the full FIX→fresh-Run→PASS chain at one HEAD |

## Environment (measured)

```
darwin/arm64 macOS 26.2; sbx v0.48.0 5caf923e0587d376848f6f388eca3e0f5ca00e2d;
dsh 0.2.1-rc.2; claude 2.1.292 (Claude Code)
Shared Lab VM: ish824-lab (Docker Sandbox, aarch64) — cpus/mem/disk recorded by `env.lab-resources`
clab-api-server: ghcr.io/srl-labs/clab-api-server/clab-api-server:latest (v0.8.0), running
SR Linux image: sha256:0096fe3ebcafabb7253492e2060425fe027a168e0e066766d1e85efbb0b48be8
  ghcr.io/nokia/srlinux@sha256:0096fe3ebcafabb7253492e2060425fe027a168e0e066766d1e85efbb0b48be8
host disk/RAM + timestamp: recorded by `env.host-resources` (`df -h /`, `hw.memsize`, ISO time)
```

## Result summary (raw)

```
ok   [env]            darwin/arm64 … sbx v0.48.0 … dsh 0.2.1-rc.2; claude 2.1.292
ok   [env.host-resources]  <time>; host disk(/) …; host RAM …
ok   [env.lab-resources]   Shared Lab VM: cpus=…; mem=…; disk=…
ok   [env.srl-image]  sha256:0096fe3e… (ghcr.io/nokia/srlinux@sha256:0096fe3e…)
ok   [env.clab-api]   clab-api-server: …:latest running
BLOCKED [provider]    real dsh/DeepSeek leg cannot run (no provider credential)
ok   [lab.warm]       Shared Lab clab-api-server is ready
ok   [lab.keepalive]  keep-alive exec session started on the Shared Lab VM
ok   [nos]            real SR Linux VERIFY at the bound HEAD <sha>: v26.7.2 (clab-api exec)
NOT_RUN [nos.ssh]     SSH NOT_RUN (no SSH evidence obtained)
NOT_RUN [nos.gnmi]    gNMI NOT_RUN (gnmic not installed in the Sandbox)
ok   [nos.head-mismatch]         HEAD mismatch -> not_run (never a PASS)
ok   [nos.dirty-tree]            a check that dirties the tree -> inconclusive
ok   [nos.required-verify-fail]  a required check that exits non-zero -> fail
ok   [nos.lab-port-failure]      an unpublished Lab port -> VERIFY fail
ok   [nos.api-unavailable]       Lab API unavailable -> VERIFY fail (transport failure)
ok   [nos.foreign-lab]           a foreign-lab destroy is refused (LAB_FOREIGN)
ok   [nos.cleanup]               lab destroyed (NOS image retained)
ok   [parallel]                  two Task-named labs deployed concurrently (distinct owners/ports)
ok   [parallel.cleanup-a]        lab A destroyed (verdict from the destroy result)
ok   [parallel.isolation]        lab B still running after A was destroyed
ok   [parallel.image-retained]   shared SR Linux image retained: sha256:0096fe3e…
ok   [parallel.cleanup-b]        lab B destroyed
BLOCKED [factory]     real factory fails CLOSED (no provider credential, no false PASS)
ok   [factory.read-only]         merged_at=null accepted_at=null pr_url=null
```

### A. Real SR Linux VERIFY at the bound HEAD — **measured**

A throwaway main checkout carries `labs/labctl/labctl.py` + a Task-named topology
(`name: netlab-<owner>` == `labNameForTask(task)`, ISH-845) + the check script,
committed **before** `sbx create --clone` so the clone starts clean. ISH-829's
`sandboxVerifyTarget` runs the check **inside** the clone at the recorded HEAD;
the check deploys a real `ghcr.io/nokia/srlinux` node on the Shared Lab through
`labctl`, reads it back, and destroys it. Raw tail:

```
--- clab-api exec (NOT SSH) ---
Hostname             : srl1
Chassis Type         : 7220 IXR-D3
OS                   : SR Linux
Software Version     : v26.7.2
Build Number         : 519-g94fbd638fa8
Architecture         : aarch64
--- real SSH leg (published :22) ---
Connection closed by 169.254.1.1 port 18001   # SSH_NOT_RUN
--- real gNMI leg (published :57400) ---
GNMI_NOT_RUN: gnmic is not installed in the sandbox
{ "destroyed": true, "lab": "netlab-<owner>", "response": { "message": "Lab '…' destroyed successfully" } }
NOS_CHECK_DONE
```

**Transport honesty.** The read-back above is `labctl exec` → clab-api-server
`POST /api/v1/labs/{lab}/exec` → `docker exec` on the Lab host — **not SSH**. The
real SSH attempt to the node's published `:22` (`sshpass … ssh -p 18001
admin@host.docker.internal`) reached the published port but the connection was
closed (the Sandbox egress proxy / node sshd), so **SSH is NOT_RUN**; **gNMI is
NOT_RUN** (`gnmic` is not installed). `inspect --json` did report the running node
and a reachable management endpoint, and the read-back is bound to the **real**
NOS and to the checked-out HEAD.

### B. Failure injections — **no false PASS**

| injection | observed | expected |
| --- | --- | --- |
| clone HEAD ≠ the bound head | `not_run` (the command never ran) | never a PASS |
| a check that dirties the tree | `inconclusive` | never a PASS |
| a REQUIRED check that exits non-zero | `fail` | never a PASS |
| an unpublished Lab port | `fail` | never a PASS |
| Lab API unavailable (`--api https://127.0.0.1:9`, creds sourced) | `fail`, with a transport failure (`LABCTL_EXIT=5/7` / connection refused) | never a PASS |
| `destroyTaskLab` on a foreign lab (`netlab-SOMEONE-ELSE`) | refused `LAB_FOREIGN` before `labctl` | never a PASS |

### C. Two Task-named labs coexist (LAB isolation) — **measured**

Two Task-named labs (`netlab-ish830-par-a-<run>-…` on host ports 18001/18002 and
`…-b-…` on 18011/18012, **unique per run**) were deployed **concurrently**
(`Promise.all`); destroying `…-a-…` left `…-b-…` running, and the shared SR Linux
image (`sha256:0096fe3e…`) survived. Each destroy's verdict is recorded from its
**result** (`parallel.cleanup-a` / `parallel.cleanup-b`), not discarded.

**Scope of this proof:** it is a **lab** isolation proof only. The Tasks are not
Relay Tasks with their own Coding Sandboxes/branches, so **branch / review-HEAD
isolation is NOT_RUN here**; it is covered deterministically by
`tests/factory.test.ts` (distinct worktrees run in parallel; one writer per
worktree).

### D. The real factory over a Coding Sandbox — **fails closed (BLOCKED)**

`runFactoryTask` was driven over a durable Coding Sandbox (ISH-878) with the pinned
`dsh` and the **real SR Linux NOS check** as the Task's REQUIRED check. With no
provider credential it fails **closed** — it does not reach `merge_ready`, and
MergeReady stays read-only:

```
runFactoryTask(T1) -> coding_failed (head none); run run-<id> failed exit 1
dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route
     "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service
     (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching
     environment
merged_at=null accepted_at=null pr_url=null   # MergeReady is read-only
```

A `merge_ready` outcome is credited `PASS` **only** when the ISH-830 chain is
proven — a `FIX` review followed by a **later** `PASS`, with the final attempt's
produced HEAD equal to the MergeReady HEAD (verified HEAD == reviewer HEAD ==
MergeReady HEAD). A bare `merge_ready` without that chain is recorded `FAIL`.

## BLOCKED / NOT_RUN (do not treat as PASS)

- **BLOCKED — the real DeepSeek/provider leg.** No provider credential is
  provisioned in this environment. The pinned host `dsh` fails closed:
  ```
  $ dsh --profile headless --json "reply with the single token PING"
  {"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":
   {"message":"llm-pi-ai: no credential for provider route \"ollama-cloud-v41\";
    its profile resolves OLLAMA_CLOUD_V41_API_KEY, which is not set …",
    "code":"MISSING_CREDENTIAL"}}}
  {"type":"final","text":""}
  ```
  Inside a Coding Sandbox the route is `deepseek-official` and it needs
  `DEEPSEEK_API_KEY`. **Consequently the full chain — real dsh IMPLEMENT → real
  SR Linux VERIFY → independent Claude FIX → fresh dsh Run → re-VERIFY → Claude
  PASS → MergeReady — was NOT RUN end-to-end.**
- **NOT_RUN — real SSH.** The real SSH attempt to the node published `:22`
  (`sshpass … ssh -p 18001 admin@host.docker.internal`) was refused/closed, so no
  SSH evidence was obtained; the read-back is the clab-api exec channel.
- **NOT_RUN — real gNMI.** `gnmic` is not installed in the Coding Sandbox.
- **NOT_RUN — spec §6 cases not injected here** (each has deterministic unit
  coverage; the real chain is BLOCKED anyway):
  - *lab destroy fail* → `tests/lab.test.ts` (`destroy` failure is `ok:false`);
  - *VM restart / stale generation / orphan* → `tests/factory.test.ts` (adoption,
    orphan sweep, generation fence);
  - *dsh timeout / early exit* → `tests/dsh-runner.test.ts` (timeout → `not_run`/
    `failed`; `exit 0` with no commit → `NO_IMPLEMENTATION`);
  - *duplicate writer* → `tests/factory.test.ts` (same worktree → `DUPLICATE_WRITER`);
  - *branch / review-HEAD isolation* → `tests/factory.test.ts` (distinct worktrees).
- **NOT_RUN — cEOS side lane (ISH-825).** Optional; the SR Linux mainline is
  independent of it.
- **NOT_RUN — `bun run smoke:factory` (ISH-762 fixture smoke).** Pre-existing
  breakage, **not** caused by this change: its fake `dsh-slow` prints no
  `--version`, so the ISH-869 pin guard refuses it
  (`DSH_VERSION_MISMATCH … reports no version`). `bun test` (which includes the
  fixture Factory suite) is green.

## Gates

```sh
bun run typecheck          # tsc --noEmit -> exit 0
bun test                   # 999 pass, 1 skip, 0 fail  (3679 expect() calls, 71 files)
bun run smoke:factory      # FAIL: pre-existing DSH_VERSION_MISMATCH (see above)
RELAY_ISH830_E2E=1 … bun scripts/ish830-real-e2e.ts   # stages: see the summary
```

`formal/` is untouched (`git diff --name-only | grep -q '^formal/'` is empty), so
no TLC run is required (AGENTS.md).

## Not verified / follow-ups

- The **real model chain** (DeepSeek IMPLEMENT → Claude FIX → PASS → MergeReady):
  BLOCKED on a provider credential. Once `DEEPSEEK_API_KEY` is available to the
  host Run (or the operator credential proxy to the Sandbox), re-run the
  `factory` stage — it credits `PASS` only when the FIX→fresh-Run→PASS chain and
  the HEAD equality hold.
- Real SSH and real gNMI read-backs (a Sandbox egress path that permits SSH, and
  `gnmic` installed in the Coding Kit).
- No GitHub push/PR/Linear write is performed by the harness (MergeReady is
  read-only); this PR is opened by the owner flow, unmerged.
