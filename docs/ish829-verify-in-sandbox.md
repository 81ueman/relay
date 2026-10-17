# ISH-829 — Task-Sandbox VERIFY inside the Coding Sandbox (with a Shared-Lab NOS)

**Issue:** [ISH-829](https://linear.app/ishiul/issue/ISH-829) — *[relay][verify] Verify
exact Coding Sandbox HEAD against shared containerlab Lab*. **Kind:** implementation +
evidence record. Companion to [`sandbox-lifecycle.md`](sandbox-lifecycle.md) (ISH-828),
[`../sandbox/README.md`](../sandbox/README.md) (the Coding Kit) and
[`ish828-sandbox-evidence.md`](ish828-sandbox-evidence.md).

> **Scope note (round 2).** This PR is a **partial slice** of ISH-829. The Relay-side
> execution boundary, the fail-closed fencing and the `labctl` seam are implemented,
> wired and tested, and proven against a **real Coding Sandbox**. The **live** Shared-Lab
> `deploy → inspect --json → destroy` run is **not** reproduced here (it is gated on Lab
> credentials that are not available to the author), so this does **not** close ISH-829.
> The Ishiul-side items (Rust tests in the sandbox, the `labs/srl-maintenance/apply.sh`
> external-endpoint change) also live outside this repo.

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
([`sandbox/coding-kit`](../sandbox/coding-kit), ISH-827/849). `sandboxLabctl` runs
`labctl` through the same `sbx exec` boundary. Lab credentials are forwarded
**explicitly** as `sbx exec -e` (the sandbox never inherits the host env); prefer
`LABCTL_TOKEN` since a value on argv is visible in the host process table.

* `deployTaskLab(labctl, task, opts)` fails closed unless `labctl` exits 0 **and**
  every declared node is `running` **and** the returned lab is the Task's OWN; a
  mis-named deploy is **destroyed** before returning `LAB_FOREIGN`.
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
HEAD binding still apply. The RAW reviewer output is written to a **durable** base
(the Task's own worktree, or `evidenceDir`), **not** into the temporary review
worktree, so a recorded `evidence_ref` never dangles after teardown.

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
| reviewer checkout not at the fixed HEAD | `ok:false` / review refused | `tests/review-workspace.test.ts` |
| review evidence after worktree teardown | exists on a durable path | `tests/factory.test.ts` |
| Factory with a sandbox row | host `defaultRunner` never called | `tests/factory.test.ts` |

## Real evidence

### A. Coding Sandbox VERIFY — **measured**

`RELAY_SANDBOX_SMOKE=1 bun scripts/ish829-real-smoke.ts` on the ISH-822/827/828 host
(`sbx v0.48.0`, Docker Sandboxes, Apple Silicon). It creates a throwaway main
checkout, a **real** clone-mode sandbox, and drives the ISH-829 boundary against it:

```
ISH-829 real sandbox smoke — repo …/relay-ish829-real-…/repo
  head 48f7d95c9b7cd4b8019bb7a9e011798dd4401471
  ok 1. created clone-mode sandbox relay-ish829-real-…
  ok 2. clone HEAD matches the host HEAD (48f7d95c9b7c)
  ok 3. a check runs inside the clone (exit 0)
  ok 4. the check is labelled with its sandbox + bound HEAD
  ok 5. the command did NOT escape to the host (host-home sentinel absent)
  ok 6. the sentinel file IS inside the sandbox's home
  ok 7. a non-zero exit is a FAIL (exit 3)
  ok 8. a timeout is NOT_RUN (never a PASS)
  ok 9. a check that DIRTIES the tree is INCONCLUSIVE (never a PASS)
  ok 10. a DIRTY clone is NOT_RUN (never a PASS)
  ok 11. a HEAD mismatch is NOT_RUN (never a PASS)
  ok 12. evidence JSONL has one line per check (5)
  ok 13. evidence carries HEAD + required check count

PASS — 13 checks
```

Checks 5–6 are the **host-escape sentinel**: the command writes `$HOME/<sentinel>`;
the HOST path stays absent and the file exists only in the sandbox's own `$HOME`.
Checks 7–11 are the failure cases: non-zero → `fail`; timeout, dirty tree, and HEAD
mismatch → `not_run`; a check that dirties the tree → `inconclusive` — never PASS.

### B. Shared Lab — seam implemented, live run credential-gated

The Shared Lab VM (`sbx` sandbox from ISH-824) is warm (`clab-api-server` v0.8.0
healthy, `ghcr.io/nokia/srlinux:latest` cached, API published to a
sandbox-reachable host port). `labctl` is installed **inside** the Coding Kit, not
on the host, and the Lab API authenticates against the Lab's system accounts, so
the live `deploy → inspect --json → destroy` half is gated on credentials the author
does not have. The seam it exercises (`sandboxLabctl` + the three operations above)
is covered fail-closed by `tests/lab.test.ts`. To run it:

```sh
RELAY_SANDBOX_SMOKE=1 \
LABCTL_API=https://host.docker.internal:49170 \
LABCTL_TOPOLOGY=labs/labctl/examples/srl2.clab.yml \
LABCTL_USER=<user> LABCTL_PASSWORD=<pw> \
  bun scripts/ish829-real-smoke.ts
```

The lab half is wrapped in a `try/finally` that **always** destroys a deployed lab,
so a later failure cannot leak it; teardown is `labctl destroy` only (image cache
kept).

## Not measured / limits

* The **live** Shared-Lab `deploy/inspect/destroy` from inside a Coding Sandbox
  (§B). This is the decisive acceptance evidence; until it is supplied this PR is a
  partial slice and must not be treated as closing ISH-829.
* The full daemon E2E (a real `dsh` implement Run in the sandbox → produced HEAD
  fetched to the host → this VERIFY boundary). The boundary, the Factory wiring and
  the review worktree are proven separately.
* A sandbox topology must name its lab `labNameForTask` for the ownership fence;
  per-task topology `name:` rewriting stays out of Relay (ISH-844 non-goal).
* Publishing the Lab port (`sbx ports`) and the sandbox network allowlist remain a
  deployment concern (ISH-824/844); Relay does not manage them.

## Verify

```sh
bun run typecheck
bun test
RELAY_SANDBOX_SMOKE=1 bun scripts/ish829-real-smoke.ts   # real sbx, no Lab credential
```

`formal/` is untouched (`git diff --name-only | grep -q '^formal/'` is empty), so no
TLC run is required.
