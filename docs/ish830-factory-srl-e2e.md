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
=== ISH-830 E2E summary ===
  PASS     env: darwin/arm64 macOS 26.2; sbx sbx version v0.48.0 5caf923e0587d376848f6f388eca3e0f5ca00e2d; dsh 0.2.1-rc.2; claude 2.1.292 (Claude Code)
  PASS     env.host-resources: 2026-10-18T03:05:07.969Z; host disk(/) /dev/disk3s1s1   926Gi    11Gi   194Gi     6%    453k  2.0G    0%   /; host RAM 32.0 GiB
  PASS     env.lab-resources: Shared Lab VM: cpus=10; mem=15Gi; disk=20G
  PASS     env.labvm: Shared Lab VM: ish824-lab             shell           ● running   127.0.0.1:49161->8090/tcp, ::1:49161->8090/tcp, 0.0.0.0:49170->8090/tcp4, 127.0.0.1:49305->8090/tcp4, 0.0.0.0:18001->18001/tcp4, 0.0.0.0:18002->18002/tcp4, 0.0.0.0:18011->18011/tcp4, 0.0.0.0:18012->18012/tcp4, 0.0.0.0:18021->18021/tcp4   -                                                                                             1d
  PASS     env.srl-image: SR Linux image: sha256:0096fe3ebcafabb7253492e2060425fe027a168e0e066766d1e85efbb0b48be8 ghcr.io/nokia/srlinux@sha256:0096fe3ebcafabb7253492e2060425fe027a168e0e066766d1e85efbb0b48be8
  PASS     env.clab-api: clab-api-server: ghcr.io/srl-labs/clab-api-server/clab-api-server:latest running
  BLOCKED  provider: real dsh/DeepSeek leg cannot run (no provider credential)
  PASS     lab.warm: Shared Lab clab-api-server is ready
  PASS     lab.keepalive: started a keep-alive exec session on the Shared Lab VM
  PASS     nos: real SR Linux VERIFY at the bound HEAD 266d5c34b9c4: "image": "ghcr.io/nokia/srlinux:latest",
  NOT_RUN  nos.ssh: SSH NOT_RUN (no SSH evidence obtained)
  NOT_RUN  nos.gnmi: gNMI NOT_RUN (gnmic not installed in the Sandbox)
  PASS     nos.head-mismatch: HEAD mismatch -> not_run (never a PASS)
  PASS     nos.dirty-tree: a check that dirties the tree -> inconclusive
  PASS     nos.required-verify-fail: a required check that exits non-zero -> fail (never a PASS)
  PASS     nos.lab-port-failure: a second Task lab on the already-published host port 18001 -> deploy ok=false (never a PASS)
  PASS     nos.lab-port-holder-cleanup: netlab-T1-1792292713260: destroyed
  PASS     nos.api-unavailable: Lab API unavailable -> VERIFY fail (never a PASS)
  PASS     nos.foreign-lab: a foreign-lab destroy is refused: LAB_FOREIGN: lab 'netlab-SOMEONE-ELSE' is not owned by task T1 (expected netlab-T1-1792292713260)
  PASS     nos.cleanup: destroy: destroy failed (exit 6): labctl: not found: DELETE /api/v1/labs/netlab-T1-1792292713260: lab 'netlab-T1-1792292713260' not found; inspect exit 6
  PASS     nos.lab-port-cleanup: netlab-T1-port-1792292713261 destroyed
  PASS     nos.sandbox-cleanup: sandbox relay-ish830-nos-mvd8t0ch removed
  PASS     parallel: two Task-named labs deployed concurrently: netlab-ish830-par-a-mvd8un9i-1792292789574 + netlab-ish830-par-b-mvd8un9i-1792292789575 (distinct owners/ports)
  PASS     parallel.cleanup-a: netlab-ish830-par-a-mvd8un9i-1792292789574 destroyed
  PASS     parallel.isolation: netlab-ish830-par-b-mvd8un9i-1792292789575 still running after the other lab was destroyed
  PASS     parallel.image-retained: shared SR Linux image retained: sha256:0096fe3ebcafabb7253492e2060425fe027a168e0e066766d1e85efbb0b48be8
  PASS     parallel.cleanup-b: netlab-ish830-par-b-mvd8un9i-1792292789575 destroyed
  PASS     parallel.sandbox-cleanup: sandbox relay-ish830-par-mvd8un9i removed
  BLOCKED  factory: real factory fails CLOSED (no provider credential, no false PASS): runFactoryTask(T1) -> coding_failed (head none); run run-3bb52c2a failed exit 1
  PASS     factory.read-only: merged_at=null accepted_at=null pr_url=null (MergeReady is read-only)
  PASS     factory.lab-cleanup: destroy netlab-T1-1792292862541: destroy failed (exit 6): labctl: not found: DELETE /api/v1/labs/netlab-T1-1792292862541: lab 'netlab-T1-1792292862541' not found; inspect exit 6
  PASS     factory.sandbox-cleanup: sandbox relay-ish-830-factory-1f93603d removed

counts: {"PASS":28,"BLOCKED":2,"NOT_RUN":2}
evidence-json: [{"stage":"env","verdict":"PASS","detail":"darwin/arm64 macOS 26.2; sbx sbx version v0.48.0 5caf923e0587d376848f6f388eca3e0f5ca00e2d; dsh 0.2.1-rc.2; claude 2.1.292 (Claude Code)"},{"stage":"env.host-resources","verdict":"PASS","detail":"2026-10-18T03:05:07.969Z; host disk(/) /dev/disk3s1s1   926Gi    11Gi   194Gi     6%    453k  2.0G    0%   /; host RAM 32.0 GiB"},{"stage":"env.lab-resources","verdict":"PASS","detail":"Shared Lab VM: cpus=10; mem=15Gi; disk=20G"},{"stage":"env.labvm","verdict":"PASS","detail":"Shared Lab VM: ish824-lab             shell           ● running   127.0.0.1:49161->8090/tcp, ::1:49161->8090/tcp, 0.0.0.0:49170->8090/tcp4, 127.0.0.1:49305->8090/tcp4, 0.0.0.0:18001->18001/tcp4, 0.0.0.0:18002->18002/tcp4, 0.0.0.0:18011->18011/tcp4, 0.0.0.0:18012->18012/tcp4, 0.0.0.0:18021->18021/tcp4   -                                                                                             1d"},{"stage":"env.srl-image","verdict":"PASS","detail":"SR Linux image: sha256:0096fe3ebcafabb7253492e2060425fe027a168e0e066766d1e85efbb0b48be8 ghcr.io/nokia/srlinux@sha256:0096fe3ebcafabb7253492e2060425fe027a168e0e066766d1e85efbb0b48be8"},{"stage":"env.clab-api","verdict":"PASS","detail":"clab-api-server: ghcr.io/srl-labs/clab-api-server/clab-api-server:latest running"},{"stage":"provider","verdict":"BLOCKED","detail":"real dsh/DeepSeek leg cannot run (no provider credential)","command":"dsh --profile headless --json \"reply with the single token PING\"","raw":"{\"type\":\"status\",\"phase\":\"turn_end\",\"turn\":1,\"reason\":{\"kind\":\"error\",\"error\":{\"message\":\"llm-pi-ai: no credential for provider route \\\"ollama-cloud-v41\\\"; its profile resolves OLLAMA_CLOUD_V41_API_KEY, which is not set — store OLLAMA_CLOUD_V41_API_KEY through the credentials service (the web Models page writes it) or export it, and remove apiKeyEnv only if this provider should authenticate from pi-ai's own environment discovery\",\"code\":\"MISSING_CREDENTIAL\"}}}\n{\"type\":\"final\",\"text\":\"\"}"},{"stage":"lab.warm","verdict":"PASS","detail":"Shared Lab clab-api-server is ready"},{"stage":"lab.keepalive","verdict":"PASS","detail":"started a keep-alive exec session on the Shared Lab VM"},{"stage":"nos","verdict":"PASS","detail":"real SR Linux VERIFY at the bound HEAD 266d5c34b9c4: \"image\": \"ghcr.io/nokia/srlinux:latest\",","command":"sandboxVerifyTarget.runner.run(nos-readback)","raw":".\nSerial Number        : Sim Serial No.\nSystem HW MAC Address: 1A:13:00:FF:00:00\nOS                   : SR Linux\nSoftware Version     : v26.7.2\nBuild Number         : 519-g94fbd638fa8\nArchitecture         : aarch64\nLast Booted          : 2026-10-18T03:05:46.266Z\nTotal Memory         : 16593984 kB\nFree Memory          : 13934304 kB\n--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------\n--- real SSH leg (published :22) ---\nConnection closed by 169.254.1.1 port 18001\r\nSSH_LEG_FAIL\n--- real gNMI leg (published :57400) ---\nGNMI_NOT_RUN: gnmic is not installed in the sandbox\n{\n  \"destroyed\": true,\n  \"lab\": \"netlab-T1-1792292713260\",\n  \"response\": {\n    \"message\": \"Lab 'netlab-T1-1792292713260' destroyed successfully\"\n  }\n}\nNOS_CHECK_DONE\n\nParsing error: Unknown token 'commit'. Options are ['!', '#', '..', '/', 'acl', 'back', 'bash', 'bfd', 'cls', 'date', 'diff', 'echo', 'enter', 'environment', 'exit', 'file', 'help', 'history', 'info', 'interface', 'list', 'monitor', 'network-instance', 'passwd', 'ping', 'ping6', 'platform', 'pwc', 'qos', 'quit', 'references', 'routing-policy', 'save', 'show', 'source', 'ssh', 'system', 'tcptraceroute', 'tech-support', 'tools', 'traceroute', 'traceroute6', 'tree', 'tunnel', 'tunnel-interface', 'watch', '{']"},{"stage":"nos.ssh","verdict":"NOT_RUN","detail":"SSH NOT_RUN (no SSH evidence obtained)","raw":"Connection closed by 169.254.1.1 port 18001\r\nSSH_LEG_FAIL"},{"stage":"nos.gnmi","verdict":"NOT_RUN","detail":"gNMI NOT_RUN (gnmic not installed in the Sandbox)"},{"stage":"nos.head-mismatch","verdict":"PASS","detail":"HEAD mismatch -> not_run (never a PASS)"},{"stage":"nos.dirty-tree","verdict":"PASS","detail":"a check that dirties the tree -> inconclusive"},{"stage":"nos.required-verify-fail","verdict":"PASS","detail":"a required check that exits non-zero -> fail (never a PASS)"},{"stage":"nos.lab-port-failure","verdict":"PASS","detail":"a second Task lab on the already-published host port 18001 -> deploy ok=false (never a PASS)","raw":"LAB_ERROR: labctl deploy failed (exit 5): labctl: API error 500 for POST /api/v1/labs/netlab-T1-port-1792292713261/deploy: Failed to deploy lab 'netlab-T1-port-1792292713261': deployment failed: deployment failed for one or more nodes: node \"srl1\" deploy: Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint clab-netlab-T1-port-1792292713261-srl1 (07b4e8387c72aaa4b0f"},{"stage":"nos.lab-port-holder-cleanup","verdict":"PASS","detail":"netlab-T1-1792292713260: destroyed"},{"stage":"nos.api-unavailable","verdict":"PASS","detail":"Lab API unavailable -> VERIFY fail (never a PASS)","raw":"LABCTL_EXIT=5\n\nLABCTL_EXIT=5\n\nlabctl: cannot reach API server at https://127.0.0.1:9: [Errno 111] Connection refused"},{"stage":"nos.foreign-lab","verdict":"PASS","detail":"a foreign-lab destroy is refused: LAB_FOREIGN: lab 'netlab-SOMEONE-ELSE' is not owned by task T1 (expected netlab-T1-1792292713260)"},{"stage":"nos.cleanup","verdict":"PASS","detail":"destroy: destroy failed (exit 6): labctl: not found: DELETE /api/v1/labs/netlab-T1-1792292713260: lab 'netlab-T1-1792292713260' not found; inspect exit 6"},{"stage":"nos.lab-port-cleanup","verdict":"PASS","detail":"netlab-T1-port-1792292713261 destroyed"},{"stage":"nos.sandbox-cleanup","verdict":"PASS","detail":"sandbox relay-ish830-nos-mvd8t0ch removed"},{"stage":"parallel","verdict":"PASS","detail":"two Task-named labs deployed concurrently: netlab-ish830-par-a-mvd8un9i-1792292789574 + netlab-ish830-par-b-mvd8un9i-1792292789575 (distinct owners/ports)"},{"stage":"parallel.cleanup-a","verdict":"PASS","detail":"netlab-ish830-par-a-mvd8un9i-1792292789574 destroyed"},{"stage":"parallel.isolation","verdict":"PASS","detail":"netlab-ish830-par-b-mvd8un9i-1792292789575 still running after the other lab was destroyed"},{"stage":"parallel.image-retained","verdict":"PASS","detail":"shared SR Linux image retained: sha256:0096fe3ebcafabb7253492e2060425fe027a168e0e066766d1e85efbb0b48be8"},{"stage":"parallel.cleanup-b","verdict":"PASS","detail":"netlab-ish830-par-b-mvd8un9i-1792292789575 destroyed"},{"stage":"parallel.sandbox-cleanup","verdict":"PASS","detail":"sandbox relay-ish830-par-mvd8un9i removed"},{"stage":"factory","verdict":"BLOCKED","detail":"real factory fails CLOSED (no provider credential, no false PASS): runFactoryTask(T1) -> coding_failed (head none); run run-3bb52c2a failed exit 1","raw":"dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route \"deepseek-official\"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment"},{"stage":"factory.read-only","verdict":"PASS","detail":"merged_at=null accepted_at=null pr_url=null (MergeReady is read-only)"},{"stage":"factory.lab-cleanup","verdict":"PASS","detail":"destroy netlab-T1-1792292862541: destroy failed (exit 6): labctl: not found: DELETE /api/v1/labs/netlab-T1-1792292862541: lab 'netlab-T1-1792292862541' not found; inspect exit 6"},{"stage":"factory.sandbox-cleanup","verdict":"PASS","detail":"sandbox relay-ish-830-factory-1f93603d removed"}]

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
Connection closed by 169.254.1.1 port 18001
SSH_LEG_FAIL
--- real gNMI leg (published :57400) ---
GNMI_NOT_RUN: gnmic is not installed in the sandbox
{ "destroyed": true, "lab": "netlab-T1-1792291652678", "response": { "message": "Lab 'netlab-T1-1792291652678' destroyed successfully" } }
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
| a second Task lab on an already-published Lab port (18001) | `deployTaskLab` `ok=false` (API 500, container networking) — and the partial container is torn down (`nos.lab-port-cleanup`) | never a PASS |
| Lab API unavailable (`--api https://127.0.0.1:9`, creds sourced) | `fail`, `LABCTL_EXIT=5` + `[Errno 111] Connection refused` | never a PASS |
| `destroyTaskLab` on a foreign lab (`netlab-SOMEONE-ELSE`) | refused `LAB_FOREIGN` before `labctl` | never a PASS |

### C. Two Task-named labs coexist (LAB isolation) — **measured**

Two Task-named labs (`netlab-ish830-par-a-<run>-…` on host ports 18001/18002 and
`…-b-…` on 18011/18012, **unique per run**) were deployed **concurrently**
(`Promise.all`); destroying `…-a-…` left `…-b-…` running, and the shared SR Linux
image (`sha256:0096fe3e…`) survived. Each destroy's verdict is recorded from its
**result** (`parallel.cleanup-a` / `parallel.cleanup-b`) and the sandbox removal is
recorded (`parallel.sandbox-cleanup`), never discarded. The sandbox is created
**inside** the stage's `try`, so an abort before the deploys — a failed
`ensureLabctlInSandbox`, or a malformed `LABCTL_API` in `new URL` — still runs the
`finally` and stops/removes the sandbox (a leak would be a `FAIL`).

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

**Fail-closed teardown (factory).** Everything after `ensureTaskSandbox` runs in a
`try/finally`: the Task's own lab is destroyed (same exit-6 verdict as `nos`, row
`factory.lab-cleanup`) and the Coding Sandbox is removed (`factory.sandbox-cleanup`).
A leaked lab/sandbox is a recorded `FAIL`, and a stage error is a `FAIL` — never a
silent leak. When `LABCTL_API` is unset the `factory` stage is skipped as `BLOCKED`
(no sandbox is created). `nos-check.sh` also carries a
`trap 'labctl destroy …' EXIT`, so **every** VERIFY attempt tears down its own lab
even if it fails after `deploy`.

**Provider credential.** The stage forwards `DEEPSEEK_API_KEY` into the Sandbox Run
when the operator exports it (`dshEnv`), and runs `warmLab()` whenever a Lab stage
runs, so the factory VERIFY cannot hit a stopped Shared Lab API.

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
  - *VM restart / orphan* → `tests/factory.test.ts` (adoption, orphan sweep);
  - *stale generation* → `tests/run-lifecycle.test.ts:389` (a superseded Run is
    refused) and `tests/workflow.test.ts:238` (a review of a moved HEAD is refused);
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
  BLOCKED on a provider credential. Export `DEEPSEEK_API_KEY` and re-run the
  `factory` stage (`RELAY_ISH830_E2E=1 LABCTL_API=… … ISH830_STAGES=factory bun
  scripts/ish830-real-e2e.ts`): the harness forwards `DEEPSEEK_API_KEY` into the
  Sandbox Run (`dshEnv`) and runs `warmLab()`, so the Run can reach the provider;
  `PASS` is credited only when the FIX→fresh-Run→PASS chain and the HEAD equality
  hold.
- Real SSH and real gNMI read-backs (a Sandbox egress path that permits SSH, and
  `gnmic` installed in the Coding Kit).
- No GitHub push/PR/Linear write is performed by the harness (MergeReady is
  read-only); this PR is opened by the owner flow, unmerged.
