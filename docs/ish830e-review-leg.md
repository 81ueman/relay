# ISH-830e — the factory review leg reaches a real verdict (evidence)

Task: **T17** (part of **ISH-830**). Branch `devin/ish-830e-factory-review-leg`.

## Symptom (as first recorded)

`runFactoryTask(T1)` in the real ISH-830 harness returned `outcome=blocked`, so the
harness recorded the `factory` leg **FAIL**. The original diagnosis (run
`run-488f0df2`) was a **review** block with an empty reason.

## Root cause (captured, not guessed)

Re-running the harness with the exact `runFactoryTask` reason surfaced in the
record (`reason=…; steps=…`) showed the block was **at VERIFY, not review**:

```
FAIL [factory] runFactoryTask(T1) -> blocked (head ae3c2640a708); run run-ce3ced52
     submitted exit 0; reason=verify not_run;
     steps=implement:run run-ce3ced52 -> submitted (head ae3c2640a708…)
```

The sandbox VERIFY's clean-tree fence failed. The Run's brief is pinned into the
sandbox clone at `.relay/run-brief.md` (untracked). The **host** path already
makes `.relay/` invisible via `.git/info/exclude` (`ensureRelayExcluded`), but the
**sandbox** path did not — and the ISH-830 fixture repo has no tracked
`.gitignore`, so `git status --porcelain --untracked-files=all` reported
`dirty` → `sandboxCommandRunner` returned `not_run` → `blocked_human` → the
Factory blocked **before the reviewer ever ran**. The dsh agent's own report
independently noted: *"the only remaining working-tree item is the untracked
harness `.relay/` directory"*.

## Fix (owner decision, 2026-10-18 — both parts, no full bypass)

1. **VERIFY evidence in the brief** (`src/reviewer-runner.ts`, `src/factory.ts`):
   the sandbox VERIFY result (outcome + each check's outcome/exit + a bounded
   output tail) is rendered into `buildReviewBrief` as
   `## Mechanical VERIFY — ALREADY RUN at <head> (context; do NOT re-run)`. The
   host reviewer never sees the sandbox, so it can now judge the code against the
   mechanical evidence instead of abstaining.
2. **`--permission-mode auto`** (`src/reviewer-runner.ts`): the default reviewer
   runs with `--permission-mode auto` instead of only
   `--allowedTools "Read Grep Glob"`, so the CLI's own classifier may approve safe
   read-mostly actions (e.g. a read-only `git diff`). **Never**
   `bypassPermissions` and **no** all-tools allowlist; the brief still instructs
   the reviewer to treat the checkout as READ-ONLY. The ISH-883 native-PR path
   keeps its explicit `allowedTools` allowlist (it must run `gh`).
3. **Dirty-tree fence fixed** (`src/sandbox-lifecycle.ts`):
   `ensureSandboxRelayExcluded` adds `.relay/` to the sandbox clone's
   `.git/info/exclude` when the brief is pinned — mirroring the host worktree.
4. **Precise fail-closed reasons** (`src/factory.ts`): an empty reviewer `summary`
   no longer collapses a blocked review reason to `""`
   (`reviewBlockedReason`); a blocked VERIFY now names the fence/check and its
   output tail (`verifyChecksReason`).
5. **Harness** (`scripts/ish830-real-e2e.ts`): a reviewer that reaches **no**
   verdict (`review_refused`, or `blocked` with `reviewVerdict=blocked`) is
   classified **BLOCKED** (owner prerequisite), not a generic FAIL; the harness
   dumps the raw reviewer evidence (`factory.review-evidence`) to a durable path
   before removing its temp dir; and the `runFactoryTask` `reason`/`steps` are
   recorded in the stage detail.

Relay still makes **zero GitHub writes**; nothing is merged or accepted.

## Harness re-run (honest)

```
RELAY_ISH830_E2E=1 LABCTL_API=https://host.docker.internal:49170 LABCTL_INSECURE=1 \
  LABCTL_USER=agent LABCTL_PASSWORD=clabapi ISH830_STAGES=provider,factory \
  bun scripts/ish830-real-e2e.ts
```

```
PASS  provider: real dsh/DeepSeek replied PING
PASS  lab.warm / lab.keepalive
PASS  factory.lab-ports
PASS  factory.review-evidence
FAIL  factory: merge_ready but the ISH-830 chain is NOT proven (fixIdx=-1 passIdx=-1
      head-equal=true): runFactoryTask(T1) -> merge_ready (head 7713caba45ef);
      steps=implement:…,verify:pass@0,review:pass@0,integration:submitted,merge_ready:gate=BLOCKED
PASS  factory.read-only
PASS  factory.lab-cleanup / factory.sandbox-cleanup
counts: {"PASS":7,"FAIL":1}
```

**The review leg now reaches a real verdict** (previously it was never reached):
VERIFY **pass** → review **pass** → integration → **MergeReady**, at the reviewed
HEAD.

The `factory` stage is recorded **FAIL** — honestly — because the harness's PASS
gate additionally requires the *full* ISH-830 chain (a `FIX` review followed by a
later `PASS`). This run's change was judged correct on the first review
(`fixIdx=-1`), so the chain was not exercised. No PASS is fabricated.

### Reviewer evidence (captured, `attempt-0-7713caba45.json`)

```json
{
  "taskId": "T1",
  "attempt": 0,
  "head": "7713caba45ef066cd8e40f57494cabbc4d0fa898",
  "reviewer": "claude-review",
  "command": "claude",
  "exitCode": 0,
  "signal": null,
  "structured": {
    "verdict": "pass",
    "head": "7713caba45ef066cd8e40f57494cabbc4d0fa898",
    "findings": [],
    "summary": "HEAD adds DONE.md at the repo root containing exactly 'done' plus a newline, and it is the only file in the commit. The srl-nos-readback check passed at this HEAD."
  },
  "native": null
}
```

The summary's *"The srl-nos-readback check passed at this HEAD"* is the reviewer
using the VERIFY evidence added to the brief.

## Gates

```
bun run typecheck   # tsc --noEmit -> exit 0
bun test            # 1056 pass, 1 skip, 0 fail (74 files)
```

No `formal/` file changed, so the TLC suites are not run (per `AGENTS.md`).

## Not verified / notes

- The harness's full `fix → pass` chain was not exercised this run (the change was
  correct on the first review), so the `factory` stage is FAIL by the harness's
  own chain gate — **not** a fabricated PASS.
- `merge_ready:gate=BLOCKED` is the ordinary read-only merge gate (no PR bound in
  the harness); it is not a merge.
- The reviewer's model was the CLI default (`claude-sonnet-5-5`); the lane's
  `claude-opus-5-5` reviewer model is a separate operator choice
  (`RELAY_REVIEW_MODEL`).
