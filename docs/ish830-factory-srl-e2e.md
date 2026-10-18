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
| `nos` | a REAL Coding Sandbox (`sbx create --clone`) VERIFYs the **exact bound HEAD** against a **real** Shared-Lab SR Linux through ISH-829's `sandboxVerifyTarget`; a REAL `ssh` on the node's published `:22` and a REAL `gnmic` get on `:57400` are recorded alongside the clab-api `exec` read-back; plus failure injections |
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

Run at head `7eedfb2` — the round-3 fix commit (the PASS detail reports the
attempt that succeeded; **this run took the direct path, `SSH_EXIT=0`**, and the
CONNECT-proxy fallback branch is covered by the unit test only):

```
=== ISH-830 E2E summary ===
  PASS     env: darwin/arm64 macOS 26.2; sbx sbx version v0.48.0 5caf923e0587d376848f6f388eca3e0f5ca00e2d; dsh 0.2.1-rc.2; claude 2.1.292 (Claude Code)
  PASS     env.host-resources: 2026-10-18T04:13:45.787Z; host disk(/) /dev/disk3s1s1   926Gi    11Gi   191Gi     6%    453k  2.0G    0%   /; host RAM 32.0 GiB
  PASS     env.lab-resources: Shared Lab VM: cpus=10; mem=15Gi; disk=20G
  PASS     env.labvm: Shared Lab VM: ish824-lab             shell           ● running   127.0.0.1:49161->8090/tcp, ::1:49161->8090/tcp, 0.0.0.0:49170->8090/tcp4, 127.0.0.1:49342->8090/tcp4, 0.0.0.0:18001->18001/tcp4, 0.0.0.0:18002->18002/tcp4, 0.0.0.0:18011->18011/tcp4, 0.0.0.0:18012->18012/tcp4, 0.0.0.0:18021->18021/tcp4   -                                                                                             1d
  PASS     env.srl-image: SR Linux image: sha256:0096fe3ebcafabb7253492e2060425fe027a168e0e066766d1e85efbb0b48be8 ghcr.io/nokia/srlinux@sha256:0096fe3ebcafabb7253492e2060425fe027a168e0e066766d1e85efbb0b48be8
  PASS     env.clab-api: clab-api-server: ghcr.io/srl-labs/clab-api-server/clab-api-server:latest running
  BLOCKED  provider: real dsh/DeepSeek leg cannot run (no provider credential)
  PASS     lab.warm: Shared Lab clab-api-server is ready
  PASS     lab.keepalive: started a keep-alive exec session on the Shared Lab VM
  PASS     nos.lab-ports: Shared Lab node ports published 1:1 on 0.0.0.0: 18002: already published; 18021: already published
  PASS     nos: real SR Linux VERIFY at the bound HEAD b4993057b9dc: Software Version     : v26.7.2
  PASS     nos.ssh: real SSH from the Sandbox to host.docker.internal:18021 (node :22) returned `show version` [SSH_EXIT=0] SSH command: sshpass -p <redacted> ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -p 18021 admin@host.docker.internal 'show version'
  PASS     nos.gnmi: real gNMI from the Sandbox to host.docker.internal:18002 (node :57400) returned the host-name [GNMI_EXIT=0]
  PASS     nos.head-mismatch: HEAD mismatch -> not_run (never a PASS)
  PASS     nos.dirty-tree: a check that dirties the tree -> inconclusive
  PASS     nos.required-verify-fail: a required check that exits non-zero -> fail (never a PASS)
  PASS     nos.lab-port-failure: a second Task lab on the already-published host port 18021 -> deploy ok=false (never a PASS)
  PASS     nos.lab-port-holder-cleanup: netlab-T1-1792296829859: destroyed
  PASS     nos.api-unavailable: Lab API unavailable -> VERIFY fail (never a PASS)
  PASS     nos.foreign-lab: a foreign-lab destroy is refused: LAB_FOREIGN: lab 'netlab-SOMEONE-ELSE' is not owned by task T1 (expected netlab-T1-1792296829859)
  PASS     nos.cleanup: destroy: destroy failed (exit 6): labctl: not found: DELETE /api/v1/labs/netlab-T1-1792296829859: lab 'netlab-T1-1792296829859' not found; inspect exit 6
  PASS     nos.lab-port-cleanup: netlab-T1-port-1792296829860 destroyed
  PASS     nos.sandbox-cleanup: sandbox relay-ish830-nos-mvdb98qh removed
  PASS     parallel: two Task-named labs deployed concurrently: netlab-ish830-par-a-mvdbb734-1792296920992 + netlab-ish830-par-b-mvdbb734-1792296920993 (distinct owners/ports)
  PASS     parallel.cleanup-a: netlab-ish830-par-a-mvdbb734-1792296920992 destroyed
  PASS     parallel.isolation: netlab-ish830-par-b-mvdbb734-1792296920993 still running after the other lab was destroyed
  PASS     parallel.image-retained: shared SR Linux image retained: sha256:0096fe3ebcafabb7253492e2060425fe027a168e0e066766d1e85efbb0b48be8
  PASS     parallel.cleanup-b: netlab-ish830-par-b-mvdbb734-1792296920993 destroyed
  PASS     parallel.sandbox-cleanup: sandbox relay-ish830-par-mvdbb734 removed
  PASS     factory.lab-ports: Shared Lab node ports published 1:1 on 0.0.0.0: 18002: already published; 18021: already published
  BLOCKED  factory: real factory fails CLOSED (no provider credential, no false PASS): runFactoryTask(T1) -> coding_failed (head none); run run-e5bc6029 failed exit 1
  PASS     factory.read-only: merged_at=null accepted_at=null pr_url=null (MergeReady is read-only)
  PASS     factory.lab-cleanup: destroy netlab-T1-1792296980464: destroy failed (exit 6): labctl: not found: DELETE /api/v1/labs/netlab-T1-1792296980464: lab 'netlab-T1-1792296980464' not found; inspect exit 6
  PASS     factory.sandbox-cleanup: sandbox relay-ish-830-factory-1f93603d removed

counts: {"PASS":32,"BLOCKED":2}
evidence-json: [{"stage":"env","verdict":"PASS","detail":"darwin/arm64 macOS 26.2; sbx sbx version v0.48.0 5caf923e0587d376848f6f388eca3e0f5ca00e2d; dsh 0.2.1-rc.2; claude 2.1.292 (Claude Code)"},{"stage":"env.host-resources","verdict":"PASS","detail":"2026-10-18T04:13:45.787Z; host disk(/) /dev/disk3s1s1   926Gi    11Gi   191Gi     6%    453k  2.0G    0%   /; host RAM 32.0 GiB"},{"stage":"env.lab-resources","verdict":"PASS","detail":"Shared Lab VM: cpus=10; mem=15Gi; disk=20G"},{"stage":"env.labvm","verdict":"PASS","detail":"Shared Lab VM: ish824-lab             shell           ● running   127.0.0.1:49161->8090/tcp, ::1:49161->8090/tcp, 0.0.0.0:49170->8090/tcp4, 127.0.0.1:49342->8090/tcp4, 0.0.0.0:18001->18001/tcp4, 0.0.0.0:18002->18002/tcp4, 0.0.0.0:18011->18011/tcp4, 0.0.0.0:18012->18012/tcp4, 0.0.0.0:18021->18021/tcp4   -                                                                                             1d"},{"stage":"env.srl-image","verdict":"PASS","detail":"SR Linux image: sha256:0096fe3ebcafabb7253492e2060425fe027a168e0e066766d1e85efbb0b48be8 ghcr.io/nokia/srlinux@sha256:0096fe3ebcafabb7253492e2060425fe027a168e0e066766d1e85efbb0b48be8"},{"stage":"env.clab-api","verdict":"PASS","detail":"clab-api-server: ghcr.io/srl-labs/clab-api-server/clab-api-server:latest running"},{"stage":"provider","verdict":"BLOCKED","detail":"real dsh/DeepSeek leg cannot run (no provider credential)","command":"dsh --profile headless --json \"reply with the single token PING\"","raw":"{\"type\":\"status\",\"phase\":\"turn_end\",\"turn\":1,\"reason\":{\"kind\":\"error\",\"error\":{\"message\":\"llm-pi-ai: no credential for provider route \\\"ollama-cloud\\\"; its profile resolves OLLAMA_CLOUD_V41_API_KEY, which is not set — store OLLAMA_CLOUD_V41_API_KEY through the credentials service (the web Models page writes it) or export it, and remove apiKeyEnv only if this provider should authenticate from pi-ai's own environment discovery\",\"code\":\"MISSING_CREDENTIAL\"}}}\n{\"type\":\"final\",\"text\":\"\"}"},{"stage":"lab.warm","verdict":"PASS","detail":"Shared Lab clab-api-server is ready"},{"stage":"lab.keepalive","verdict":"PASS","detail":"started a keep-alive exec session on the Shared Lab VM"},{"stage":"nos.lab-ports","verdict":"PASS","detail":"Shared Lab node ports published 1:1 on 0.0.0.0: 18002: already published; 18021: already published"},{"stage":"nos","verdict":"PASS","detail":"real SR Linux VERIFY at the bound HEAD b4993057b9dc: Software Version     : v26.7.2","command":"sandboxVerifyTarget.runner.run(nos-readback)","raw":"   \"reachable_at\": \"host.docker.internal:18002\"\n        }\n      ],\n      \"mgmt_ipv4\": \"172.20.20.2/24\",\n      \"mgmt_ipv6\": \"3fff:172:20:20::2/64\",\n      \"node\": \"srl1\",\n      \"state\": \"running\"\n    }\n  ],\n  \"remote_dir\": \"T1-1792296829859/netlab-T1-1792296829859\"\n}\n--- clab-api exec (NOT SSH) ---\n--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------\nHostname             : srl1\nChassis Type         : 7220 IXR-D3\nPart Number          : Sim Part No.\nSerial Number        : Sim Serial No.\nSystem HW MAC Address: 1A:CB:00:FF:00:00\nOS                   : SR Linux\nSoftware Version     : v26.7.2\nBuild Number         : 519-g94fbd638fa8\nArchitecture         : aarch64\nLast Booted          : 2026-10-18T04:14:26.260Z\nTotal Memory         : 16593984 kB\nFree Memory          : 14024896 kB\n--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------\n--- real SSH leg (published :22) ---\nSSH command: sshpass -p <redacted> ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -p 18021 admin@host.docker.internal 'show version'\nWarning: Permanently added '[host.docker.internal]:18021' (ED25519) to the list of known hosts.\r\n................................................................\n:                  Welcome to Nokia SR Linux!                  :\n:              Open Network OS for the NetOps era.             :\n:                                                              :\n:    This is a freely distributed official container image.    :\n:                      Use it - Share it                       :\n:                                                              :\n: Get started: https://learn.srlinux.dev                       :\n: Container:   https://go.srlinux.dev/container-image          :\n: Docs:        https://doc.srlinux.dev/26-7                    :\n: Rel. notes:  https://doc.srlinux.dev/rnn                     :\n: YANG:        https://yang.srlinux.dev/26.7.2                 :\n: Discord:     https://go.srlinux.dev/discord                  :\n: Contact:     https://go.srlinux.dev/contact-sales            :\n................................................................\n\n--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------\nHostname             : srl1\nChassis Type         : 7220 IXR-D3\nPart Number          : Sim Part No.\nSerial Number        : Sim Serial No.\nSystem HW MAC Address: 1A:CB:00:FF:00:00\nOS                   : SR Linux\nSoftware Version     : v26.7.2\nBuild Number         : 519-g94fbd638fa8\nArchitecture         : aarch64\nLast Booted          : 2026-10-18T04:14:26.260Z\nTotal Memory         : 16593984 kB\nFree Memory          : 13670608 kB\n--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------\nSSH_EXIT=0\nSSH_LEG_OK\n--- real gNMI leg (published :57400) ---\ngNMI command: gnmic -a host.docker.internal:18002 -u admin -p <redacted> --skip-verify -e json_ietf get --path /system/name/host-name\n[\n  {\n    \"source\": \"host.docker.internal:18002\",\n    \"timestamp\": 1792296887131809852,\n    \"time\": \"2026-10-18T04:14:47.131809852Z\",\n    \"updates\": [\n      {\n        \"Path\": \"srl_nokia-system:system/srl_nokia-system-name:name/host-name\",\n        \"values\": {\n          \"srl_nokia-system:system/srl_nokia-system-name:name/host-name\": \"srl1\"\n        }\n      }\n    ]\n  }\n]\nGNMI_EXIT=0\nGNMI_LEG_OK\n{\n  \"destroyed\": true,\n  \"lab\": \"netlab-T1-1792296829859\",\n  \"response\": {\n    \"message\": \"Lab 'netlab-T1-1792296829859' destroyed successfully\"\n  }\n}\nNOS_CHECK_DONE\n\n        : srl1\nChassis Type         : 7220 IXR-D3\nPart Number          : Sim Part No.\nSerial Number        : Sim Serial No.\nSystem HW MAC Address: 1A:CB:00:FF:00:00\nOS                   : SR Linux\nSoftware Version     : v26.7.2\nBuild Number         : 519-g94fbd638fa8\nArchitecture         : aarch64\nLast Booted          : 2026-10-18T04:14:26.260Z\nTotal Memory         : 16593984 kB\nFree Memory          : 14024896 kB\n--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------\n--- real SSH leg (published :22) ---\nSSH command: sshpass -p <redacted> ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -p 18021 admin@host.docker.internal 'show version'\nWarning: Permanently added '[host.docker.internal]:18021' (ED25519) to the list of known hosts.\r\n................................................................\n:                  Welcome to Nokia SR Linux!                  :\n:              Open Network OS for the NetOps era.             :\n:                                                              :\n:    This is a freely distributed official container image.    :\n:                      Use it - Share it                       :\n:                                                              :\n: Get started: https://learn.srlinux.dev                       :\n: Container:   https://go.srlinux.dev/container-image          :\n: Docs:        https://doc.srlinux.dev/26-7                    :\n: Rel. notes:  https://doc.srlinux.dev/rnn                     :\n: YANG:        https://yang.srlinux.dev/26.7.2                 :\n: Discord:     https://go.srlinux.dev/discord                  :\n: Contact:     https://go.srlinux.dev/contact-sales            :\n................................................................\n\n--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------\nHostname             : srl1\nChassis Type         : 7220 IXR-D3\nPart Number          : Sim Part No.\nSerial Number        : Sim Serial No.\nSystem HW MAC Address: 1A:CB:00:FF:00:00\nOS                   : SR Linux\nSoftware Version     : v26.7.2\nBuild Number         : 519-g94fbd638fa8\nArchitecture         : aarch64\nLast Booted          : 2026-10-18T04:14:26.260Z\nTotal Memory         : 16593984 kB\nFree Memory          : 13670608 kB\n--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------\nSSH_EXIT=0\nSSH_LEG_OK\n--- real gNMI leg (published :57400) ---\ngNMI command: gnmic -a host.docker.internal:18002 -u admin -p <redacted> --skip-verify -e json_ietf get --path /system/name/host-name\n[\n  {\n    \"source\": \"host.docker.internal:18002\",\n    \"timestamp\": 1792296887131809852,\n    \"time\": \"2026-10-18T04:14:47.131809852Z\",\n    \"updates\": [\n      {\n        \"Path\": \"srl_nokia-system:system/srl_nokia-system-name:name/host-name\",\n        \"values\": {\n          \"srl_nokia-system:system/srl_nokia-system-name:name/host-name\": \"srl1\"\n        }\n      }\n    ]\n  }\n]\nGNMI_EXIT=0\nGNMI_LEG_OK\n{\n  \"destroyed\": true,\n  \"lab\": \"netlab-T1-1792296829859\",\n  \"response\": {\n    \"message\": \"Lab 'netlab-T1-1792296829859' destroyed successfully\"\n  }\n}\nNOS_CHECK_DONE\n\nParsing error: Unknown token 'commit'. Options are ['!', '#', '..', '/', 'acl', 'back', 'bash', 'bfd', 'cls', 'date', 'diff', 'echo', 'enter', 'environment', 'exit', 'file', 'help', 'history', 'info', 'interface', 'list', 'monitor', 'network-instance', 'passwd', 'ping', 'ping6', 'platform', 'pwc', 'qos', 'quit', 'references', 'routing-policy', 'save', 'show', 'source', 'ssh', 'system', 'tcptraceroute', 'tech-support', 'tools', 'traceroute', 'traceroute6', 'tree', 'tunnel', 'tunnel-interface', 'watch', '{']"},{"stage":"nos.ssh","verdict":"PASS","detail":"real SSH from the Sandbox to host.docker.internal:18021 (node :22) returned `show version` [SSH_EXIT=0] SSH command: sshpass -p <redacted> ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -p 18021 admin@host.docker.internal 'show version'","raw":"SSH command: sshpass -p <redacted> ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -p 18021 admin@host.docker.internal 'show version'\nWarning: Permanently added '[host.docker.internal]:18021' (ED25519) to the list of known hosts.\r\n................................................................\n:                  Welcome to Nokia SR Linux!                  :\n:              Open Network OS for the NetOps era.             :\n:                                                              :\n:    This is a freely distributed official container image.    :\n:                      Use it - Share it                       :\n:                                                              :\n: Get started: https://learn.srlinux.dev                       :\n: Container:   https://go.srlinux.dev/container-image          :\n: Docs:        https://doc.srlinux.dev/26-7                    :\n: Rel. notes:  https://doc.srlinux.dev/rnn                     :\n: YANG:        https://yang.srlinux.dev/26.7.2                 :\n: Discord:     https://go.srlinux.dev/discord                  :\n: Contact:     https://go.srlinux.dev/contact-sales            :\n................................................................\n\n--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------\nHostname             : srl1\nChassis Type         : 7220 IXR-D3\nPart Number          : Sim Part No.\nSerial Number        : Sim Serial No.\nSystem HW MAC Address: 1A:CB:00:FF:00:00\nOS                   : SR Linux\nSoftware Version     : v26.7.2\nBuild Number         : 519-g94fbd638fa8\nArchitecture         : aarch64\nLast Booted          : 2026-10-18T04:14:26.260Z\nTotal Memory         : 16593984 kB\nFree Memory          : 13670608 kB\n--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------\nSSH_EXIT=0\nSSH_LEG_OK"},{"stage":"nos.gnmi","verdict":"PASS","detail":"real gNMI from the Sandbox to host.docker.internal:18002 (node :57400) returned the host-name [GNMI_EXIT=0]","raw":"gNMI command: gnmic -a host.docker.internal:18002 -u admin -p <redacted> --skip-verify -e json_ietf get --path /system/name/host-name\n[\n  {\n    \"source\": \"host.docker.internal:18002\",\n    \"timestamp\": 1792296887131809852,\n    \"time\": \"2026-10-18T04:14:47.131809852Z\",\n    \"updates\": [\n      {\n        \"Path\": \"srl_nokia-system:system/srl_nokia-system-name:name/host-name\",\n        \"values\": {\n          \"srl_nokia-system:system/srl_nokia-system-name:name/host-name\": \"srl1\"\n        }\n      }\n    ]\n  }\n]\nGNMI_EXIT=0\nGNMI_LEG_OK"},{"stage":"nos.head-mismatch","verdict":"PASS","detail":"HEAD mismatch -> not_run (never a PASS)"},{"stage":"nos.dirty-tree","verdict":"PASS","detail":"a check that dirties the tree -> inconclusive"},{"stage":"nos.required-verify-fail","verdict":"PASS","detail":"a required check that exits non-zero -> fail (never a PASS)"},{"stage":"nos.lab-port-failure","verdict":"PASS","detail":"a second Task lab on the already-published host port 18021 -> deploy ok=false (never a PASS)","raw":"LAB_ERROR: labctl deploy failed (exit 5): labctl: API error 500 for POST /api/v1/labs/netlab-T1-port-1792296829860/deploy: Failed to deploy lab 'netlab-T1-port-1792296829860': deployment failed: deployment failed for one or more nodes: node \"srl1\" deploy: Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint clab-netlab-T1-port-1792296829860-srl1 (dee7324057e4b577188"},{"stage":"nos.lab-port-holder-cleanup","verdict":"PASS","detail":"netlab-T1-1792296829859: destroyed"},{"stage":"nos.api-unavailable","verdict":"PASS","detail":"Lab API unavailable -> VERIFY fail (never a PASS)","raw":"LABCTL_EXIT=5\n\nLABCTL_EXIT=5\n\nlabctl: cannot reach API server at https://127.0.0.1:9: [Errno 111] Connection refused"},{"stage":"nos.foreign-lab","verdict":"PASS","detail":"a foreign-lab destroy is refused: LAB_FOREIGN: lab 'netlab-SOMEONE-ELSE' is not owned by task T1 (expected netlab-T1-1792296829859)"},{"stage":"nos.cleanup","verdict":"PASS","detail":"destroy: destroy failed (exit 6): labctl: not found: DELETE /api/v1/labs/netlab-T1-1792296829859: lab 'netlab-T1-1792296829859' not found; inspect exit 6"},{"stage":"nos.lab-port-cleanup","verdict":"PASS","detail":"netlab-T1-port-1792296829860 destroyed"},{"stage":"nos.sandbox-cleanup","verdict":"PASS","detail":"sandbox relay-ish830-nos-mvdb98qh removed"},{"stage":"parallel","verdict":"PASS","detail":"two Task-named labs deployed concurrently: netlab-ish830-par-a-mvdbb734-1792296920992 + netlab-ish830-par-b-mvdbb734-1792296920993 (distinct owners/ports)"},{"stage":"parallel.cleanup-a","verdict":"PASS","detail":"netlab-ish830-par-a-mvdbb734-1792296920992 destroyed"},{"stage":"parallel.isolation","verdict":"PASS","detail":"netlab-ish830-par-b-mvdbb734-1792296920993 still running after the other lab was destroyed"},{"stage":"parallel.image-retained","verdict":"PASS","detail":"shared SR Linux image retained: sha256:0096fe3ebcafabb7253492e2060425fe027a168e0e066766d1e85efbb0b48be8"},{"stage":"parallel.cleanup-b","verdict":"PASS","detail":"netlab-ish830-par-b-mvdbb734-1792296920993 destroyed"},{"stage":"parallel.sandbox-cleanup","verdict":"PASS","detail":"sandbox relay-ish830-par-mvdbb734 removed"},{"stage":"factory.lab-ports","verdict":"PASS","detail":"Shared Lab node ports published 1:1 on 0.0.0.0: 18002: already published; 18021: already published"},{"stage":"factory","verdict":"BLOCKED","detail":"real factory fails CLOSED (no provider credential, no false PASS): runFactoryTask(T1) -> coding_failed (head none); run run-e5bc6029 failed exit 1","raw":"dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route \"deepseek-official\"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment"},{"stage":"factory.read-only","verdict":"PASS","detail":"merged_at=null accepted_at=null pr_url=null (MergeReady is read-only)"},{"stage":"factory.lab-cleanup","verdict":"PASS","detail":"destroy netlab-T1-1792296980464: destroy failed (exit 6): labctl: not found: DELETE /api/v1/labs/netlab-T1-1792296980464: lab 'netlab-T1-1792296980464' not found; inspect exit 6"},{"stage":"factory.sandbox-cleanup","verdict":"PASS","detail":"sandbox relay-ish-830-factory-1f93603d removed"}]
```




### A. Real SR Linux VERIFY at the bound HEAD — **measured**

A throwaway main checkout carries `labs/labctl/labctl.py` + a Task-named topology
(`name: netlab-<owner>` == `labNameForTask(task)`, ISH-845) + the check script,
committed **before** `sbx create --clone` so the clone starts clean. ISH-829's
`sandboxVerifyTarget` runs the check **inside** the clone at the recorded HEAD;
the check deploys a real `ghcr.io/nokia/srlinux` node on the Shared Lab through
`labctl`, reads it back, and destroys it. Recorded evidence — **unedited** (the two blocks below are the exact `raw`
fields of the `nos.ssh` and `nos.gnmi` rows; the harness redacts credentials):

```
SSH command: sshpass -p <redacted> ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -p 18021 admin@host.docker.internal 'show version'
Warning: Permanently added '[host.docker.internal]:18021' (ED25519) to the list of known hosts.
................................................................
:                  Welcome to Nokia SR Linux!                  :
:              Open Network OS for the NetOps era.             :
:                                                              :
:    This is a freely distributed official container image.    :
:                      Use it - Share it                       :
:                                                              :
: Get started: https://learn.srlinux.dev                       :
: Container:   https://go.srlinux.dev/container-image          :
: Docs:        https://doc.srlinux.dev/26-7                    :
: Rel. notes:  https://doc.srlinux.dev/rnn                     :
: YANG:        https://yang.srlinux.dev/26.7.2                 :
: Discord:     https://go.srlinux.dev/discord                  :
: Contact:     https://go.srlinux.dev/contact-sales            :
................................................................

--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
Hostname             : srl1
Chassis Type         : 7220 IXR-D3
Part Number          : Sim Part No.
Serial Number        : Sim Serial No.
System HW MAC Address: 1A:CB:00:FF:00:00
OS                   : SR Linux
Software Version     : v26.7.2
Build Number         : 519-g94fbd638fa8
Architecture         : aarch64
Last Booted          : 2026-10-18T04:14:26.260Z
Total Memory         : 16593984 kB
Free Memory          : 13670608 kB
--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
SSH_EXIT=0
SSH_LEG_OK
```

```
gNMI command: gnmic -a host.docker.internal:18002 -u admin -p <redacted> --skip-verify -e json_ietf get --path /system/name/host-name
[
  {
    "source": "host.docker.internal:18002",
    "timestamp": 1792296887131809852,
    "time": "2026-10-18T04:14:47.131809852Z",
    "updates": [
      {
        "Path": "srl_nokia-system:system/srl_nokia-system-name:name/host-name",
        "values": {
          "srl_nokia-system:system/srl_nokia-system-name:name/host-name": "srl1"
        }
      }
    ]
  }
]
GNMI_EXIT=0
GNMI_LEG_OK
```

Both blocks are the harness's own `raw` fields, copied verbatim: the SSH leg's
echoed command, banner, `Hostname`..`Software Version` body and `SSH_EXIT=` are
all present (the round-2 fix — a 600-char cap used to cut the body off mid-banner,
so the `Software Version` row never reached the evidence), and the gNMI block ends
at `GNMI_LEG_OK`/`GNMI_LEG_FAIL`.

**Transport honesty.** The read-back is now recorded **three** ways, and the two
real legs are `PASS` **only** with real evidence (a missing `sshpass`/`gnmic` is
recorded `NOT_RUN`, never a `PASS`):

1. `labctl exec` → clab-api-server `POST /api/v1/labs/{lab}/exec` → `docker exec`
   on the Lab host — **not SSH**.
2. A **real** `ssh` from inside the Coding Sandbox to the node's published `:22`
   (`sshpass -p … ssh -p 18021 admin@host.docker.internal 'show version'`): the
   SR Linux banner and `Software Version: v26.7.2`, `SSH_EXIT=0`, `SSH_LEG_OK`.
   If the transparent path is refused the leg retries through the egress CONNECT
   proxy (`-o ProxyCommand='socat - PROXY:gateway.docker.internal:%h:%p,proxyport=3128'`),
   whose raw output and exit code are recorded too. When the **fallback** produced
   the PASS, the detail reports `SSH_FALLBACK_EXIT=…` and the `SSH fallback
   command:` (marked "via the CONNECT-proxy fallback") — **not** the failed direct
   attempt's `SSH_EXIT=` (round-3 fix; the direct attempt's non-zero exit is the
   first `SSH_EXIT=` line in the section).
3. A **real** `gnmic` get on the node's published `:57400`:
   `gnmic -a host.docker.internal:18002 -u admin -p … --skip-verify -e json_ietf
   get --path /system/name/host-name` returned `srl1`, `GNMI_EXIT=0`,
   `GNMI_LEG_OK`. SR Linux serves gNMI over **TLS** with a self-signed cert, so
   the client uses `--skip-verify` (TLS, verification skipped) — `--insecure`
   would speak plaintext gRPC to a TLS port and always fail.

A non-`PASS` leg keeps its whole output and reports the **cause**: `SSH_NOT_RUN`/
`GNMI_NOT_RUN` means the tool (`sshpass`/`gnmic`) is genuinely absent, while
`SSH_LEG_RAW_FAIL`/`GNMI_LEG_FAIL` means the tool ran and failed and its raw
output is attached (the verdict stays `NOT_RUN` either way). This matters: a real
TLS failure must not be misdiagnosed as a missing tool with the error dropped.

`inspect --json` reported the running node and reachable management endpoints, and
the read-back is bound to the **real** NOS and to the checked-out HEAD.

**Node host ports.** The node's SSH/gNMI are published 1:1 on the Shared Lab's
host ports `18021`/`18002` (the harness calls `sbx ports ish824-lab --publish
0.0.0.0:<p>:<p>` — a `409 … already published` is success — and allows exactly
those `host:port` for the Sandbox, never a bare host). `18001` is **not** used:
on this host an unrelated long-lived service (an OpenHands `uvicorn` automation
server) squats `127.0.0.1:18001`, and the Sandbox egress proxy dials the
published binding on `127.0.0.1`, so a `host.docker.internal:18001` tunnel
reaches that foreign listener and is closed — the earlier `Connection closed by
169.254.1.1 port 18001` / `SSH_LEG_FAIL` was that collision, not a structural
SSH block.

### B. Failure injections — **no false PASS**

| injection | observed | expected |
| --- | --- | --- |
| clone HEAD ≠ the bound head | `not_run` (the command never ran) | never a PASS |
| a check that dirties the tree | `inconclusive` | never a PASS |
| a REQUIRED check that exits non-zero | `fail` | never a PASS |
| a second Task lab on an already-published Lab port (18021) | `deployTaskLab` `ok=false` (API 500, container networking) — and the partial container is torn down (`nos.lab-port-cleanup`) | never a PASS |
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

**Provider credential.** *(Updated by ISH-830c.)* The stage creates its Task
sandbox from the Coding Kit and forwards **no** provider key: the kit's `headless`
profile resolves the `ollama-cloud` route and the credential comes from the
operator's `sbx` proxy secret. The stage runs `warmLab()` whenever a Lab stage
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

  > **Superseded (ISH-830c).** This record is the PR #20 measurement. The
  > follow-up makes the Coding Kit provision the sandbox `headless` profile at the
  > `ollama-cloud` route, and the `factory` stage now creates its Task sandbox
  > from that kit, so the in-sandbox Run no longer resolves `deepseek-official`.
  > See [`ish830c-kit-dsh-profile.md`](ish830c-kit-dsh-profile.md).
- **Real SSH and real gNMI are now `PASS` — measured, not claimed.** The two
  legs above ran from the Coding Sandbox at head `7eedfb2` and produced real
  evidence, recorded verbatim: `nos.ssh.raw` carries the banner + the
  `Hostname`..`Software Version: v26.7.2` body + `SSH_EXIT=0`, and `nos.gnmi.raw`
  carries gnmic's JSON + `GNMI_EXIT=0`. An absent `sshpass`/`gnmic` in a future
  Sandbox is still recorded `NOT_RUN` (tool absent), and a tool that runs but
  fails is `NOT_RUN` with its output attached — never a `PASS`.
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
bun test                   # 1045 pass, 1 skip, 0 fail  (3840 expect() calls, 73 files)
bun run smoke:factory      # FAIL: pre-existing DSH_VERSION_MISMATCH (see above)
sbx kit validate sandbox/coding-kit                  # ✓ valid (directory)
sbx kit inspect  sandbox/coding-kit                  # 6 install, 1 startup, 26 allow
RELAY_ISH830_E2E=1 … bun scripts/ish830-real-e2e.ts  # counts: {"PASS":32,"BLOCKED":2}
```

The full run (all five stages) is the summary above: **32 PASS, 2 BLOCKED (the
provider credential), 0 FAIL**; `nos.ssh` and `nos.gnmi` are `PASS` with real
evidence.

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
- Real SSH and real gNMI read-backs now run (`nos.ssh` / `nos.gnmi` `PASS`). The
  **Coding Kit's** `gnmic` install is pinned and validated (`sbx kit validate`),
  and a unit test (`tests/ish830-e2e.test.ts`) keeps the kit and harness gnmic
  versions from drifting, but a **full `sbx create ./sandbox/coding-kit` install
  run was NOT performed here** — the harness provisions `gnmic` in its own
  throwaway `shell` Sandbox (the real leg above proves the client + the network
  path; the kit's install command is byte-identical in intent).
- No GitHub push/PR/Linear write is performed by the harness (MergeReady is
  read-only); this PR is opened by the owner flow, unmerged.
