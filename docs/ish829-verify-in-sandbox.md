# ISH-829 — Task-Sandbox VERIFY inside the Coding Sandbox (with a Shared-Lab NOS)

**Issue:** [ISH-829](https://linear.app/ishiul/issue/ISH-829) — *[relay][verify] Verify
exact Coding Sandbox HEAD against shared containerlab Lab*. **Kind:** implementation +
evidence record. Companion to [`sandbox-lifecycle.md`](sandbox-lifecycle.md) (ISH-828),
[`../sandbox/README.md`](../sandbox/README.md) (the Coding Kit) and
[`ish828-sandbox-evidence.md`](ish828-sandbox-evidence.md).

> **Scope note (round 3).** The Relay-side execution boundary, the fail-closed
> fencing and the `labctl` seam are implemented, wired and tested, and proven
> against a **real Coding Sandbox**. The **live** Shared-Lab
> `deploy → inspect --json → real SR Linux read-back → destroy` run now executes
> end-to-end from inside the Coding Sandbox (see §B), against the Shared Lab of
> ISH-824/844. What remains outside this PR is the **Ishiul-side** work (Rust tests
> in the sandbox; the `labs/srl-maintenance/apply.sh` external endpoint) and the
> full daemon E2E, so this is still a slice of ISH-829 — not a claim to close it.

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
| `src/sandbox-verify.ts` | **new**: the sandbox `sbx exec` async seam, the HEAD + working-tree fence, the sandbox-bound `CommandRunner`, the JSONL evidence sink, `sandboxLabctl`, a fail-closed `notRunRunner`, and the one `verifyTarget` resolver. |
| `src/lab.ts` | **new**: the thin `labctl deploy / inspect --json / destroy` process+JSON seam with fail-closed parsing, Task-scoped lab naming/ownership (enforced), and secret redaction. |
| `src/review-workspace.ts` | **new**: `git worktree add --detach` — the reviewer's independent fixed-HEAD read-only checkout. |
| `src/verify.ts` | `ExecutedCheck` gains optional `sandbox`/`head`/`headBefore`/`headAfter`/`timedOut`/`stdout`/`stderr` (evidence), no behavior change. |
| `src/workflow-driver.ts` | `WorkflowDeps.verifyTarget(db, task, checks)` — the single sandbox-vs-host switch for mechanical VERIFY. |
| `src/provider-adapters.ts` | the daemon wires `verifyTarget: defaultVerifyTarget`. |
| `src/cli.ts` | `relay verify <id>` uses the sandbox target unless `--cwd` is given; `relay run factory` passes the independent review-worktree root. |
| `src/factory.ts` | Factory VERIFY **defaults** to `defaultVerifyTarget`; `reviewWorktreeRoot` makes the reviewer read a detached read-only checkout. |
| `src/reviewer-runner.ts` | `HeadlessReviewDeps.reviewWorktree` + `evidenceDir` (evidence stays durable; the existing path is unchanged for the old Herdr Reviewer). |

### The VERIFY boundary

`defaultRunner` (host `bash -lc`) is the fallback **only** when a Task has **no**
Coding Sandbox row at all. A Task **with** a sandbox row is verified by
`sandboxCommandRunner`, which fences every check on BOTH the HEAD and the working
tree, before and after:

1. read the clone HEAD (`sbx exec … git -C <ws> rev-parse HEAD`); unreadable or
   ≠ the Task's recorded `head_sha` → **`not_run`** (the command never runs);
2. read the clone tree (`sbx exec … git status --porcelain --untracked-files=all`);
   `dirty`/`unknown` → **`not_run`** (a writer's uncommitted edits are never
   verified as the bound HEAD);
3. run the command with `sbx exec -w <ws> bash -lc <command>` (never a host shell);
4. re-read the HEAD and tree: a non-zero exit → **`fail`**; a HEAD that moved →
   **`inconclusive`**; a tree the check dirtied → **`inconclusive`**.

A PASS is therefore only credited to a **clean** checkout at the **exact** bound
HEAD. `runMechanicalVerification`'s own pre-run head binding is fed a real
synchronous sandbox HEAD probe, so the existing gate and the runner agree.

Evidence per check (JSONL under the sandbox's `evidence_dir`, when set):
`sandbox`, `workspace`, `boundHead`, `headBefore`, `headAfter`, `name`, `command`,
`required`, `outcome`, `exitCode`, `timedOut`, `durationMs`, `stdout`, `stderr`,
`index`, `requiredCount`. The `ExecutedCheck` also carries `sandbox`/`head`, so a
host run and a sandbox run are distinguishable in every result.

A Task whose sandbox row exists but is **unusable** (`failed`, `removed`, no
workspace) resolves to a **fail-closed** `not_run` target — never a host fallback,
so generated code is never run on the host because a sandbox went away.

### Borrowing a NOS without a host escape

`labctl` is installed **inside** the clone by the Coding Kit
([`sandbox/coding-kit`](../sandbox/coding-kit), ISH-827/849); the smoke also
installs it explicitly and asserts `command -v labctl` before deploying, so it is
self-contained. `sandboxLabctl` runs `labctl` through the same `sbx exec` boundary.
Lab credentials are forwarded **explicitly** as `sbx exec -e` (the sandbox never
inherits the host env); prefer `LABCTL_TOKEN` since a value on argv is visible in
the host process table.

* `deployTaskLab(labctl, task, opts)` fails closed unless `labctl` exits 0 **and**
  every declared node is `running` **and** the returned lab is the Task's OWN; a
  mis-named deploy is **destroyed** (a private, unfenced destroy) before returning
  `LAB_FOREIGN`.
* `inspectTaskLab(labctl, task, opts)` refuses a **foreign** lab name *before*
  invoking `labctl`, then fails closed unless the echoed lab matches, every node is
  `running`, and (by default) a reachable management endpoint is published.
* `destroyTaskLab(labctl, task, opts)` refuses a foreign lab name before invoking
  `labctl`; a failed destroy is `ok:false`.
* **Images are never touched** (no `purge`, no image verb).

### Reviewer independence + durable evidence

The reviewer keeps its existing brief/verdict/`recordReview` path. When
`reviewWorktreeRoot` is configured (the `relay run factory` CLI always sets it),
the Factory materialises a **detached** git worktree at the recorded head and runs
the reviewer there — a snapshot the coding writer cannot move. Pre- and post-run
HEAD binding still apply. The RAW reviewer output is written to a **durable** base —
the Task's own `worktree` — **not** into the temporary review worktree, so a
recorded `evidence_ref` never dangles after teardown.

## Fail-closed matrix (each row has a unit test)

| condition | outcome | test |
| --- | --- | --- |
| check exits 0 at the bound HEAD in a CLEAN tree | `pass` → review | `tests/sandbox-verify.test.ts` |
| check exits non-zero | `fail` → new attempt | same |
| check times out | `not_run` (killed group) | same |
| `sbx exec` transport/spawn error | `not_run` | same |
| clone HEAD ≠ recorded head (before) | `not_run`, command never runs | same |
| clone HEAD unreadable | `not_run` | same |
| clone tree DIRTY before the check | `not_run`, command never runs | same |
| tree status unreadable (`unknown`) | `not_run` | same |
| HEAD moved while the check ran | `inconclusive` | same |
| check made the tree dirty | `inconclusive` (a fail still `fail`) | same |
| missing recorded head | blocks (`runMechanicalVerification`) | `tests/verify.test.ts` |
| sandbox row `failed`/`removed`/no workspace | fail-closed `not_run` (no host fallback) | `tests/sandbox-verify.test.ts` |
| `labctl deploy` partial create / API error / timeout / non-JSON | `ok:false` | `tests/lab.test.ts` |
| deploy lands under a FOREIGN lab | refused + destroyed | same |
| `inspect` foreign lab (before/after) | refused; `labctl` never invoked | same |
| `inspect` node not running / no endpoint | `ok:false` | same |
| `destroy` foreign lab | refused; `labctl` never invoked | same |
| `labctl destroy` fails | `ok:false` (never swallowed) | same |
| smoke: partial deploy (`lab` set, not running) | recorded + destroyed | `scripts/ish829-real-smoke.ts` |
| smoke: failed `destroy` / `sbx rm` | non-zero exit, PASS suppressed | same |
| reviewer checkout not at the fixed HEAD | `ok:false` / review refused | `tests/review-workspace.test.ts` |
| review evidence after worktree teardown | exists on a durable path | `tests/factory.test.ts` |
| Factory with a sandbox row | host `defaultRunner` never called | `tests/factory.test.ts` |

## Real evidence

### A. Coding Sandbox VERIFY — **measured**

`RELAY_SANDBOX_SMOKE=1 bun scripts/ish829-real-smoke.ts` on the ISH-822/827/828 host
(`sbx v0.48.0`, Docker Sandboxes, Apple Silicon). It creates a throwaway main
checkout (committing `labs/labctl/labctl.py` + a Task-named topology so the clone
starts clean), a **real** clone-mode sandbox, and drives the ISH-829 boundary:

```
ISH-829 real sandbox smoke — repo …/relay-ish829-real-…/repo
  head 1f15949e406be4ebee755ee8d2d890bb360e1de5
  smoke lab: relay-ish-829-ac80ed29
  ok 1. created clone-mode sandbox relay-ish829-real-… (agent shell)
  ok 2. clone HEAD matches the host HEAD (1f15949e406b)
  ok 3. clone starts CLEAN (the topology + labctl are committed)
  ok 4. a check runs inside the clone (exit 0)
  ok 5. the check is labelled with its sandbox + bound HEAD
  ok 6. the command did NOT escape to the host (host-home sentinel absent)
  ok 7. the sentinel file IS inside the sandbox's home
  ok 8. a non-zero exit is a FAIL (exit 3)
  ok 9. a timeout is NOT_RUN (never a PASS)
  ok 10. a check that DIRTIES the tree is INCONCLUSIVE (never a PASS)
  ok 11. a DIRTY clone is NOT_RUN (never a PASS)
  ok 12. a HEAD mismatch is NOT_RUN (never a PASS)
  ok 13. evidence JSONL has one line per check (5)
  ok 14. evidence carries HEAD + required check count
  …
```

Checks 6–7 are the **host-escape sentinel**: the command writes `$HOME/<sentinel>`;
the HOST path stays absent and the file exists only in the sandbox's own `$HOME`.
Checks 8–12 are the failure cases: non-zero → `fail`; timeout, dirty tree, and HEAD
mismatch → `not_run`; a check that dirties the tree → `inconclusive` — never PASS.

### B. Shared Lab — **measured live (round 3)**

The same smoke, with `LABCTL_API` set, installs and asserts `labctl` **inside** the
sandbox, allows only the Lab's published API/gNMI ports, deploys a real
`ghcr.io/nokia/srlinux:latest` node from inside the Coding Sandbox, reads the NOS
back, and destroys it — with the Lab image cache retained:

```
  ok 15. allowed the sandbox to reach the Lab (host.docker.internal:49170,host.docker.internal:18002,localhost:49170,localhost:18002)
  ok 16. labctl is installed and runnable inside the sandbox
  ok 17. labctl deploy (in-sandbox) brought the lab up: relay-ish-829-ac80ed29 (nodes running)
  ok 18. labctl inspect --json reported running nodes + 2 reachable management endpoint(s)
  ok 19. real SR Linux read-back from the sandbox: Software Version     : v26.7.2
  ok 20. labctl destroy removed the lab (NOS image retained)

PASS — 20 checks
```

The topology is generated **inside the throwaway repo** as
`labs/ish829-smoke/smoke.clab.yml` with `name: relay-ish-829-ac80ed29` ==
`labNameForTask({id:"ish829-smoke"})`, committed before `sbx create`, so (a) the
clone is clean and (b) the Task-scoped ownership fence (`foreignLabError`) is
satisfied. The read-back runs `sr_cli -c "show version"` through `labctl exec` (a
sandbox → Lab API management call), and the reply is a real SR Linux version.

Run it (a Coding Sandbox can only reach the Lab's **published** ports; the smoke
adds those policy rules itself):

```sh
RELAY_SANDBOX_SMOKE=1 \
LABCTL_API=https://host.docker.internal:49170 \
LABCTL_INSECURE=1 \
LABCTL_TOKEN=<jwt> \                 # or LABCTL_USER=<u> LABCTL_PASSWORD=<pw>
  bun scripts/ish829-real-smoke.ts
```

`LABCTL_TOKEN` (preferred) or `LABCTL_USER`/`LABCTL_PASSWORD` are forwarded into the
sandbox via `sbx exec -e` and never logged. For this PoC Lab the token is an HS256
JWT signed with the Lab's `JWT_SECRET` carrying a `username` claim (the same
credential class `labctl` obtains from `POST /login`); the secret itself is never
recorded here. `LABCTL_SRC` points at a host `labctl.py` to copy into the clone;
`RELAY_SANDBOX_AGENT=$PWD/sandbox/coding-kit` uses the full Coding Kit (which
provisions the same toolchain).

The lab half is wrapped in a `try/finally` that is **fail-closed**: a *partial*
deploy (`LAB_NOT_RUNNING`, `lab` set) is recorded as soon as `dep.lab` is known and
**always** destroyed; and a failed `destroy` or `sbx rm` sets a non-zero exit and
**suppresses PASS**. Teardown is `labctl destroy` only (image cache kept).

## Not measured / limits

* The full daemon E2E (a real `dsh` implement Run in the sandbox → produced HEAD
  fetched to the host → this VERIFY boundary), and the **Ishiul-side** work (Rust
  tests in the sandbox; the `labs/srl-maintenance/apply.sh` external endpoint). The
  boundary, the Factory wiring, the review worktree and the live Shared-Lab round
  are proven separately.
* A sandbox topology must name its lab `labNameForTask` for the ownership fence;
  per-task topology `name:` rewriting stays out of Relay (ISH-844 non-goal).
* Publishing the Lab port (`sbx ports`) and the per-deployment sandbox network
  allowlist remain a deployment concern (ISH-824/844); the smoke adds the two ports
  it needs but Relay does not manage policy.

## Verify

```sh
bun run typecheck
bun test
RELAY_SANDBOX_SMOKE=1 bun scripts/ish829-real-smoke.ts   # real sbx; add LABCTL_API for the Lab half
```

`formal/` is untouched (`git diff --name-only | grep -q '^formal/'` is empty), so no
TLC run is required.
