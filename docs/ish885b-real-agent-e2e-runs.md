# ISH-885b real Agent-owned GitHub E2E — run history

Disposable PRs on `81ueman/relay`; every PR below was **created by the dsh/DeepSeek
Coding Agent** (its own `git push` + `gh pr create` inside the Coding Sandbox, read
from `dsh.jsonl`), then closed and its branch deleted after the evidence was kept.
Relay made no GitHub writes. Nothing was merged.

| Run | Fixture | PR | Reviewed HEAD | Independent Claude | Factory |
| --- | --- | --- | --- | --- | --- |
| 1 | doc fixture, sandbox gh unconfigured | (none — `gh pr create` failed) | — | not reached | `blocked` `NO_PR_IDENTITY` |
| 2 | doc fixture | (none — Agent never ran `gh pr create`) | — | not reached | `blocked` `NO_PR_IDENTITY` |
| 3 | doc fixture | (none — sandbox `gh` 401) | — | not reached | `blocked` `NO_PR_IDENTITY` |
| 4 | doc fixture | (none — dsh strips `GH_TOKEN`) | — | not reached | `blocked` `NO_PR_IDENTITY` |
| 5 | doc fixture | `#36` | `c2665f6932…` | **PASS** (review `5561933089`) | `merge_ready` |
| 6 | 6-item checklist | `#37` | `4d5a18ccc9…` | **PASS** (review `5561944232`) | `merge_ready` |
| 7b | description↔acceptance rounding conflict | `#38` | `bceb0bb8b6…` | **PASS** (review `5561965729`) | `merge_ready` |
| 8 | many-edge-case parser contract | `#39` | `a478189188…` | **PASS** (review `5561989573`) | `merge_ready` |

## What the early runs fixed (all real, all recorded)

1. **The factory's `implementTarget` needs a durable sandbox row.** With none it
   deliberately runs on the HOST worktree — the harness must create the Coding
   Sandbox from the kit *before* `runFactoryTask` (run 1 → host path, corrected).
2. **A kit sandbox does not get the `github` *service* secret binding.**
   `sbx create` from `sandbox/coding-kit` reports `SBX_CRED_GITHUB_MODE=none` and
   `gh` sends the sentinel (`gho_sbxp…`) → `Bad credentials` (run 3, and the
   `WARN: credential not sent: no binding authorizes this service` on create).
3. **An env-injected `GH_TOKEN` is invisible to the Agent.** dsh's bash tool runs
   with a sanitized environment (run 4's own `env` dump had no `GH_TOKEN`).
4. **Fix that works:** a global *custom* secret binding `GH_TOKEN` to
   `api.github.com`/`github.com`, with its **placeholder** written to
   `~/.config/gh/hosts.yml`. dsh does not strip a config file, so the Agent's `gh`
   authenticates, and the egress proxy substitutes the real token on the wire —
   the real token never enters the sandbox or any argv.

## Success condition: first-try PASS counts (owner decision 2026-10-18)

Runs 5–8 each reached read-only MergeReady with the Agent's own push/PR and an
**independent Claude PASS at the reviewed HEAD**. Under the owner's success
condition that is a **PASS** — the `NG@A → FIX → PASS@B` arc is **OPTIONAL, not
required**. The harness records whether a FIX round occurred
(`fixRoundOccurred`/`ngArc`) and never fabricates a verdict.

## Why the `NG@A → FIX → PASS@B` arc is NOT_PROVEN (optional leg)

Runs 5–8 exercised the whole pipeline except a review `NG`: in each one the real
Agent satisfied the acceptance on the first attempt, so the independent reviewer
correctly returned `PASS` at a single reviewed HEAD. A strict 6-item checklist, a
description/acceptance rounding conflict and a many-edge-case parser contract
(run 8's parser handled BigInt precision, case-insensitive units and repeated-unit
rejection) all passed first try. A real `NG@A` therefore needs a genuinely
deficient first attempt; manufacturing one — a partial A, or a pre-filled reviewer
verdict — is the stand-in the spec forbids. Recorded as `NOT_PROVEN` (arc not
exercised), never a fabricated arc.
