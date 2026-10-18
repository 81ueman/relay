# ISH-885 (item 1) — real Agent-owned GitHub PR E2E

`scripts/ish885b-real-agent-e2e.ts` proves the **real** item-1 chain against a
disposable PR on `81ueman/relay`. It is not the ISH-885 stand-in
(`scripts/ish885-real-e2e.ts`), whose own header records
`codingAgentLeg: NOT_RUN` and `independentClaudeJudgment: NOT_RUN`.

## What it proves (actor by actor)

| Actor | Does | Relay |
| --- | --- | --- |
| **dsh / DeepSeek Coding Agent** (inside a real Coding Sandbox from `sandbox/coding-kit`) | `git commit` + `git push` (SSH agent forwarding) + `gh pr create`/update (the sbx GitHub credential proxy) on a feature branch | reads GitHub only |
| **independent headless Claude** (`claude -p`, resolves to `claude-opus-5-5`) | posts a native `gh pr review` **PASS** at the reviewed HEAD — its own judgment (the verdict is never pre-filled). If a FIX round happens it also posts the **NG** at A and the **PASS** at B | reads the review(s) back via `verifyNativeReview`, bound to the exact HEAD(s) |
| **Relay** | observes: `bindTaskPr`, re-VERIFY at the reviewed HEAD, read-only merge gate | **zero GitHub writes** (no push, no create/update, no review) |

The evidence attributes the push/PR writes to the Agent by parsing the per-Run
`dsh.jsonl` tool calls (`git push …`, `gh pr create …`) — not to the script. The
NG@A leg, when it occurs, comes from the independent reviewer and never from the
harness.

**Independence is process-level, not identity-level.** The Agent's sandbox `gh`
and the `claude -p` reviewer both post as the operator's GitHub identity
(`81ueman`), so GitHub itself cannot separate them. The harness therefore
attributes *every* Agent write — including `gh pr review|comment|merge|close` and
`gh api` mutations (`POST`/`PATCH`/`PUT`/`DELETE`) — from `dsh.jsonl`, and records
the judgment `NOT_PROVEN` if an Agent tool call wrote a review or comment, rather
than crediting it to the reviewer.

## Success condition: first-try PASS counts (owner decision 2026-10-18)

The `NG@A → fresh dsh FIX → PASS@B` arc is **OPTIONAL, not required**. The success
condition is a **real review PASS at the reviewed HEAD** — the dsh Agent owns the
push/PR, an **independent** Claude posts its own verdict, and the factory reaches
**phase `merge_ready`**. A genuine first-try PASS is a PASS.

This is the *phase*, not the read-only **gate decision**: the gate is wired to
GitHub (`mergeGateDeps: { github, checks: github }`) and its `status` + `reasons`
are recorded in the evidence. In the recorded runs the gate decision was
`BLOCKED` (nothing granted a merge authority), and the docs/evidence say so
instead of claiming MergeReady.

The harness records which happened (`fixRoundOccurred`, `ngArc`) and never
fabricates a verdict: a missing or incongruent review is still `NOT_PROVEN`. The
predicate lives in the pure, unit-tested `evaluateChain()` in
`scripts/ish885b-real-agent-e2e.ts`.

## Owner prerequisite: a GitHub credential the sandbox `gh` can use

`git push` uses the **forwarded SSH agent** (no secret). `gh pr create` needs a
GitHub **API** credential.

A sandbox created from the built-in `shell` agent gets the `github` *service*
secret binding (`SBX_CRED_GITHUB_MODE=apikey`). A sandbox created from a **kit**
(like `sandbox/coding-kit`, `extends: shell`) does **not** — it is
`SBX_CRED_GITHUB_MODE=none` and `gh` sends the sbx sentinel (`GH_TOKEN=gho_sbxp…`),
so `gh api user` → `Bad credentials`. The service secret does not fix this.

The fix is a global **custom** secret that binds `GH_TOKEN` to GitHub's API hosts;
custom secrets *do* apply to kit sandboxes (the same mechanism the kit uses for
`ollama.com`).

```sh
printf '%s' "$(gh auth token)" \
  | sbx secret set-custom --host api.github.com --host github.com --env GH_TOKEN
```

The sandbox still carries the sentinel `GH_TOKEN`, so `scripts/ish885b-real-agent-e2e.ts`
reads the custom secret's **placeholder** from `sbx secret ls` and passes
`GH_TOKEN=<sbx-cs-…>` into the dsh Run env. The egress proxy substitutes the real
token on the wire — **the real token never enters the sandbox or any argv**. The
harness proves this up front with an in-sandbox `gh api user` preflight.

## Run

```sh
RELAY_ISH885B_E2E=1 bun scripts/ish885b-real-agent-e2e.ts
# (optional) RELAY_ISH885B_EVIDENCE=/path/to/evidence.json
```

The harness writes durable evidence to
`docs/ish885b-real-agent-e2e-evidence.json` **before** any cleanup, then closes the
disposable PR, deletes its branch, and removes the sandbox, and finally rewrites the
file with the cleanup outcomes. It **never merges** and **never pushes to the
default branch**.

## Gates

`bun run typecheck` + `bun test` (the harness helpers are covered by
`tests/ish885b-real-agent-e2e.test.ts`). No `formal/` file changes → no TLC run.

## Result

See `docs/ish885b-real-agent-e2e-evidence.json` (`result`, `legs`, `steps`) and
`docs/ish885b-real-agent-e2e-runs.md` (the full run history).

**Honest state (2026-10-18).** Four full real runs reached factory phase
`merge_ready` on a real, Agent-owned PR (`#36`, `#37`, `#38`, `#39` on
`81ueman/relay`), each with:

- the **dsh/DeepSeek Agent** doing `git push` + `gh pr create` inside the Coding
  Sandbox (attributed from `dsh.jsonl` tool calls, not the script);
- an **independent headless Claude** posting a native `gh pr review` that Relay read
  back via `verifyNativeReview`, bound to the exact reviewed HEAD;
- Relay making **zero GitHub writes** (static + the reviewer/publisher boundary);
- the disposable PR, branch and sandbox cleaned up, and **no merge / no
  default-branch push**.

Under the owner's success condition (a real independent Claude PASS at the reviewed
HEAD) **these runs are PASS**: each reached factory phase `merge_ready` with the
Agent's own push/PR, an independent verdict read back at the exact reviewed HEAD, and
zero Relay GitHub writes. Their read-only gate decision was `BLOCKED` because those
runs predate wiring `mergeGateDeps` — that is recorded, not hidden.

**The `NG@A → fresh dsh FIX → PASS@B` arc is OPTIONAL and remains NOT_PROVEN.** In
every run the real Agent satisfied the acceptance on the FIRST attempt (even with a
strict 6-item checklist, a description↔acceptance rounding conflict, and a
many-edge-case parser contract), so the independent reviewer had no defect to return
`NG` on and correctly returned `PASS` at the single reviewed HEAD. Producing an
`NG@A` would require the first attempt to be genuinely deficient; engineering that
deficiency (scripting a partial A, or pre-filling the reviewer's verdict) is exactly
the stand-in the spec forbids. The harness records `fixRoundOccurred=false` /
`ngArc=false` for these runs — never a fabricated arc.
