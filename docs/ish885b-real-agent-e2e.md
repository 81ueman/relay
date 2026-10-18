# ISH-885 (item 1) — real Agent-owned GitHub PR E2E

`scripts/ish885b-real-agent-e2e.ts` proves the **real** item-1 chain against a
disposable PR on `81ueman/relay`. It is not the ISH-885 stand-in
(`scripts/ish885-real-e2e.ts`), whose own header records
`codingAgentLeg: NOT_RUN` and `independentClaudeJudgment: NOT_RUN`.

## What it proves (actor by actor)

| Actor | Does | Relay |
| --- | --- | --- |
| **dsh / DeepSeek Coding Agent** (inside a real Coding Sandbox from `sandbox/coding-kit`) | `git commit` + `git push` (SSH agent forwarding) + `gh pr create`/update (the sbx GitHub credential proxy) on a feature branch | reads GitHub only |
| **independent headless Claude** (`claude -p`, resolves to `claude-opus-5-5`) | posts a native `gh pr review` **NG** at A, then **PASS** at B — its own judgment, posted after a fresh dsh FIX pushes B to the SAME PR | reads both reviews back via `verifyNativeReview`, bound to the exact HEADs |
| **Relay** | observes: `bindTaskPr` (A then B), re-VERIFY at B, read-only merge gate | **zero GitHub writes** (no push, no create/update, no review) |

The evidence attributes the push/PR writes to the Agent by parsing the per-Run
`dsh.jsonl` tool calls (`git push …`, `gh pr create …`) — not to the script. A
partial first attempt reaches REVIEW, so the NG@A comes from the reviewer, never
from the harness.

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
`docs/ish885b-real-agent-e2e-evidence.json`, then closes the disposable PR,
deletes its branch, and removes the sandbox. It **never merges** and **never
pushes to the default branch**.

## Gates

`bun run typecheck` + `bun test` (the harness helpers are covered by
`tests/ish885b-real-agent-e2e.test.ts`). No `formal/` file changes → no TLC run.

## Result

See `docs/ish885b-real-agent-e2e-evidence.json` (`result`, `legs`, `steps`) and
`docs/ish885b-real-agent-e2e-runs.md` (the full run history).

**Honest state (2026-10-18).** Four full real runs reached read-only MergeReady on
a real, Agent-owned PR (`#36`, `#37`, `#38`, `#39` on `81ueman/relay`), each with:

- the **dsh/DeepSeek Agent** doing `git push` + `gh pr create` inside the Coding
  Sandbox (attributed from `dsh.jsonl` tool calls, not the script);
- an **independent headless Claude** posting a native `gh pr review` that Relay read
  back via `verifyNativeReview`, bound to the exact reviewed HEAD;
- Relay making **zero GitHub writes** (static + the reviewer/publisher boundary);
- the disposable PR, branch and sandbox cleaned up, and **no merge / no
  default-branch push**.

**Not proven: the `NG@A → fresh dsh FIX → PASS@B` arc.** In every run the real Agent
satisfied the acceptance on the FIRST attempt (even with a strict 6-item checklist,
a description↔acceptance rounding conflict, and a many-edge-case parser contract),
so the independent reviewer had no defect to return `NG` on and correctly returned
`PASS` at A — one reviewed HEAD, not two. Producing an `NG@A` would require the
first attempt to be genuinely deficient; engineering that deficiency (scripting a
partial A, or pre-filling the reviewer's verdict) is exactly the stand-in the spec
forbids. This is recorded as `NOT_PROVEN`, never a fabricated PASS.
