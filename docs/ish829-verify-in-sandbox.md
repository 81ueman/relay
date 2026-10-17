# ISH-829 — Task-Sandbox VERIFY inside the Coding Sandbox (with a Shared-Lab NOS)

**Issue:** [ISH-829](https://linear.app/ishiul/issue/ISH-829) — *[relay][verify] Verify
exact Coding Sandbox HEAD against shared containerlab Lab*. **Kind:** implementation +
evidence record. Companion to [`sandbox-lifecycle.md`](sandbox-lifecycle.md) (ISH-828),
[`../sandbox/README.md`](../sandbox/README.md) (the Coding Kit) and
[`ish828-sandbox-evidence.md`](ish828-sandbox-evidence.md).

> 注記: 個人パス・ユーザ名は伏せている。token / password は記録していない。

## Goal

VERIFY 対象の Ishiul コードとテストスクリプトは **Coding Sandbox 内**で実行し、必要な
実 NOS だけ Shared Lab VM から借りる。生成コードをホストで `bash -lc` しない。Claude
Reviewer は**独立した read-only HEAD view** を使う。

Relay 側の変更はこの 1 点に絞る: `src/verify.ts` の `defaultRunner`（host
`bash -lc`）に代えて、**Task の Coding Sandbox の同一 clone / 同一 HEAD** で required
check を走らせる実行境界を足す。既存の ISH-759/757/762 の HEAD-bound VERIFY/Review
gate はそのまま再利用し、新しい TEST FSM や Review engine は作らない。`relay lab`
コマンドも追加しない。

## What changed (all additive)

| file | why |
| --- | --- |
| `src/sandbox-verify.ts` | **new**: the sandbox `sbx exec` async seam, the HEAD fence, the sandbox-bound `CommandRunner`, the JSONL evidence sink, `sandboxLabctl`, and the one `verifyTarget` resolver. |
| `src/lab.ts` | **new**: the thin `labctl deploy / inspect --json / destroy` process+JSON seam with fail-closed parsing, Task-scoped lab naming/ownership, and secret redaction. |
| `src/review-workspace.ts` | **new**: `git worktree add --detach` — the reviewer's independent fixed-HEAD read-only checkout. |
| `src/verify.ts` | `ExecutedCheck` gains optional `sandbox`/`head`/`timedOut`/`stdout`/`stderr` (evidence), no behavior change. |
| `src/workflow-driver.ts` | `WorkflowDeps.verifyTarget(db, task, checks)` — the single sandbox-vs-host switch for mechanical VERIFY. |
| `src/provider-adapters.ts` | the daemon wires `verifyTarget: defaultVerifyTarget`. |
| `src/cli.ts` | `relay verify <id>` uses the sandbox target unless `--cwd` is given. |
| `src/factory.ts` | Factory VERIFY uses `verifyTarget`; `reviewWorktreeRoot` makes the reviewer read a detached read-only checkout. |
| `src/reviewer-runner.ts` | `HeadlessReviewDeps.reviewWorktree` (omitted → the existing `task.worktree`; old Herdr Reviewer untouched). |

### The VERIFY boundary

`defaultRunner` (host `bash -lc`) is still the fallback: a Task with **no** durable
Coding Sandbox is verified exactly as before. A Task **with** a live sandbox
(`sandboxes` row, ISH-828) is verified by `sandboxCommandRunner`, which for every
check:

1. reads the clone HEAD (`sbx exec … git -C <ws> rev-parse HEAD`) **before** the
   command and refuses (`not_run`) if it is unreadable or ≠ the Task's recorded
   `head_sha`;
2. runs the command with `sbx exec -w <ws> bash -lc <command>` (never a host shell);
3. re-reads the HEAD **after**: a HEAD that moved (or a concurrent writer) makes
   the check `inconclusive` — a PASS is never credited to an unseen revision.

`runMechanicalVerification`'s own pre-run head binding is fed a **real synchronous**
sandbox HEAD probe, so the existing gate and the runner agree on the same HEAD.

Evidence per check (JSONL under the sandbox's `evidence_dir`, when set):
`sandbox`, `workspace`, `boundHead`, `headBefore`, `headAfter`, `name`, `command`,
`required`, `outcome`, `exitCode`, `timedOut`, `durationMs`, `stdout`, `stderr`,
`index`, `requiredCount`. The `ExecutedCheck` also carries `sandbox`/`head`, so a
host run and a sandbox run are distinguishable in every result.

### Borrowing a NOS without a host escape

`labctl` is installed **inside** the clone by the Coding Kit
([`sandbox/coding-kit`](../sandbox/coding-kit), ISH-827/849). `sandboxLabctl` runs
`labctl` through the same `sbx exec` boundary, so the Sandbox↔Lab hop is an
ordinary sandbox-policy **TCP management** connection to the Lab's published
endpoint — never a host `bash -lc`.

* `deployTaskLab` fails closed unless `labctl` exits 0 **and** every declared node
  is `running` (a partial create, an API error, a timeout, or non-JSON output is
  `ok:false`).
* `inspectTaskLab` fails closed unless the inspect names the expected lab, every
  node is `running`, and (by default) at least one reachable management endpoint
  is published.
* `destroyTaskLab` reports a failed destroy; **images are never touched** (no
  `purge`, no image verb).
* A Task may only touch its **own** lab: `labNameForTask` derives
  `relay-<slug>-<hash8>` from the stable Task id, and `ownsLab`/`assertOwnLab`
  refuse any other lab (`LAB_FOREIGN`).

### Reviewer independence

The reviewer keeps its existing brief/verdict/`recordReview` path (ISH-757/762).
When `reviewWorktreeRoot` is configured, the Factory materialises a **detached**
git worktree at the recorded head and runs the reviewer there — a snapshot the
coding writer cannot move. `runHeadlessReview` still binds the pre- and post-run
HEAD, so a reviewer that moved the checkout is refused exactly as before.

## Fail-closed matrix (each row has a unit test)

| condition | outcome | test |
| --- | --- | --- |
| check exits 0 at the bound HEAD | `pass` → review | `tests/sandbox-verify.test.ts` |
| check exits non-zero | `fail` → new attempt | same |
| check times out | `not_run` (killed group) | same |
| `sbx exec` transport/spawn error | `not_run` | same |
| clone HEAD ≠ recorded head (before) | `not_run`, command never runs | same |
| clone HEAD unreadable | `not_run` | same |
| HEAD moved while the check ran | `inconclusive` | same |
| missing recorded head | blocks (`runMechanicalVerification`) | `tests/verify.test.ts` |
| `labctl deploy` partial create / API error / timeout | `ok:false` | `tests/lab.test.ts` |
| `labctl inspect` node not running / no endpoint | `ok:false` | same |
| `labctl inspect` names a foreign lab | `ok:false` (`LAB_FOREIGN`) | same |
| other-Task lab name | refused | same |
| `labctl destroy` fails | `ok:false` (never swallowed) | same |
| reviewer checkout not at the fixed HEAD | `ok:false` / review refused | `tests/review-workspace.test.ts` |

## Real evidence

### A. Coding Sandbox VERIFY — **measured**

`RELAY_SANDBOX_SMOKE=1 bun scripts/ish829-real-smoke.ts` on the ISH-822/827/828 host
(`sbx v0.48.0`, Docker Sandboxes, Apple Silicon). It creates a throwaway main
checkout, a **real** clone-mode sandbox, and drives the ISH-829 boundary against it:

```
ISH-829 real sandbox smoke — repo …/relay-ish829-real-…/repo
  head bdb2b7203fc30a0e5864656ec1778c78a2662c33
  ok 1. created clone-mode sandbox relay-ish829-real-…
  ok 2. clone HEAD matches the host HEAD (bdb2b7203fc3)
  ok 3. a check runs inside the clone (exit 0)
  ok 4. the check is labelled with its sandbox + bound HEAD
  ok 5. the command did NOT escape to the host (host sentinel absent)
  ok 6. the file it wrote is IN the clone
  ok 7. the file is NOT on the host
  ok 8. a non-zero exit is a FAIL (exit 3)
  ok 9. a timeout is NOT_RUN (never a PASS)
  ok 10. a HEAD mismatch is NOT_RUN (never a PASS)
  ok 11. evidence JSONL has one line per check (3)
  ok 12. evidence carries HEAD + required check count

PASS — 12 checks
```

Checks 5–7 are the **host-escape sentinel**: the command writes `HOST_SENTINEL` and
`in-sbx.txt`; `in-sbx.txt` exists **inside** the clone and **not** on the host, and
the host sentinel stays absent. Checks 8–10 are the failure cases: a non-zero exit
is `fail`, and both a timeout and a HEAD mismatch are `not_run` — never a PASS.

### B. Shared Lab — environment ready, NOS borrowed at run time

The Shared Lab VM (`sbx` sandbox from ISH-824) is reachable and warm:

```
$ sbx exec <shared-lab> bash -lc 'curl -sk https://localhost:8090/health; docker images | grep srlinux'
{"status":"healthy","uptime":"29m 51s","version":"v0.8.0"}
ghcr.io/nokia/srlinux:latest
```

with the API published to a Coding-Sandbox-reachable host port
(`sbx ports … 0.0.0.0:49170 → 8090`). `labctl` is not installed on the host and the
Lab API uses the Lab host's system accounts for JWT auth, so the **live**
`deploy → inspect --json → destroy` half of the smoke
(`LABCTL_API`/`LABCTL_TOPOLOGY`) is **credential-gated** and was **not** run in this
record; the seam it exercises (`sandboxLabctl` + `deployTaskLab`/`inspectTaskLab`/
`destroyTaskLab`) is covered fail-closed by `tests/lab.test.ts` (14 cases). To run it:

```sh
LABCTL_API=https://host.docker.internal:49170 \
LABCTL_TOPOLOGY=labs/labctl/examples/srl2.clab.yml \
LABCTL_USER=<user> LABCTL_PASSWORD=<pw> \
  RELAY_SANDBOX_SMOKE=1 bun scripts/ish829-real-smoke.ts
```

The smoke never touches the Lab image cache: teardown is `labctl destroy` only.

## Not measured / limits

* Real `labctl deploy/inspect/destroy` from inside a Coding Sandbox against the
  live Shared Lab (credential-gated here; see §B).
* The **full** `relay` daemon E2E that launches a real `dsh` implement Run in the
  sandbox, fetches the produced HEAD to the host and then runs this VERIFY boundary
  on it — the boundary and the gate are proven separately (`tests/sandbox-verify.test.ts`,
  `scripts/ish829-real-smoke.ts`).
* A sandbox topology must name its lab `labNameForTask` for the ownership fence;
  per-task topology `name:` rewriting stays out of Relay (ISH-844 non-goal).
* Publishing the Lab port (`sbx ports`) and the sandbox network allowlist remain a
  deployment concern (ISH-824/844); Relay does not manage them.

## Verify

```sh
bun run typecheck
bun test tests/lab.test.ts tests/sandbox-verify.test.ts tests/review-workspace.test.ts
RELAY_SANDBOX_SMOKE=1 bun scripts/ish829-real-smoke.ts   # real sbx, no Lab credential
```

`formal/` is untouched (`git diff --name-only | grep -q '^formal/'` is empty), so no
TLC run is required.
