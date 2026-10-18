# Task ↔ PR check (ISH-880, read-only as of ISH-885)

ISH-828 fetches a Task's **exact Coding Sandbox commit** to the host; ISH-829
verifies that **exact local HEAD**; ISH-761 is a **read-only** HEAD-bound merge
gate. ISH-880 added the one seam that binds a produced commit to a GitHub PR.
ISH-885 keeps that seam but makes it **read-only**: Relay observes GitHub, it
never writes.

## Who writes GitHub

The GitHub PR workflow is **Agent-owned**:

- the **Coding Agent** (dsh/DeepSeek), in its own Task Sandbox/checkout, does
  `git commit` + `git push` + `gh pr create`/update with normal credentials;
- the **independent Claude reviewer** posts a native `gh pr review`.

Relay is the supervisor: it owns Task/Run/phase, single-writer, the exact
produced commit, mechanical VERIFY, and the **read-only** Task↔PR check below.
Relay has **no** publisher, no `git push`, no PR mutation and no review
submission. The ISH-880 `GitGhPrPublisher` / `PrPublisher` seam and the
`relay pr bind --publish` / `ProviderAuthority.githubWrite` write path were
**removed** by ISH-885 — they were Agent tools misfiled as Relay capabilities.

`src/pr-binding.ts` composes existing pieces only: the read-only
`GitHubReadOnly` reader and `linkTask` (whose HEAD fence already invalidates a
Review/VERIFY at a moved HEAD). There is **no** second workflow engine, provider
framework or credential grant.

## Identity is explicit

The Task↔PR identity is a recorded **`pr_url`** (`owner/repo#n`, a GitHub PR URL,
or `#n` with a `pr_repo`). It is **never** inferred from a branch name or output
text alone. The Agent's reported PR URL/SHA are **untrusted claims** until Relay
independently re-reads GitHub. A missing identity is not "no PR" — it is
*unbound*, which can never become a merge-ready PASS.

## The read-only passes

`bindTaskPr(db, taskId, deps)` returns a structured
`PrBindingResult { status, ref, expectedHead, remoteHead, created, reason,
identity }` and, in order:

1. **Recorded identity** — re-read the PR from GitHub and require its `headSha`
   to equal the produced commit (`expectedHead`, default `task.head_sha`). The
   repo, the head repository (never a fork) and the open state are all verified.
2. **Crash-retry adoption** — with no recorded identity, an existing PR on the
   Task's **own repo + branch** is adopted *only when its head equals the
   produced commit* (repo AND head, so this is not branch-name-only inference).
   No duplicate PR is created.
3. **No identity and no adoptable PR** — `NO_PR_IDENTITY`, BLOCKED. Relay does
   **not** publish; the Coding Agent must push and create/update the PR first.

Every pass re-reads GitHub and requires the remote head to equal the produced
commit; the recorded `head_sha`/`pr_url` are only written through `linkTask`.

## The legitimate FIX is Agent-owned

When a FIX produces a new commit B, the Agent updates the **same** PR from A to B
and pushes B **first**. Relay then only **observes** B: it re-reads PR #N at B,
compares with the Task's produced B, invalidates A's checks/review and starts a
new-head review. If the PR still shows A while the Task has produced B, Relay
refuses with `HEAD_MOVED` (the Agent has not published yet) rather than
overwriting the remote head itself. If another actor changes the remote HEAD, the
mismatch fails closed too — Relay never overwrites it.

## Fail-closed rules

- A **moved** PR head (`HEAD_MOVED`), an **unreadable** provider/PR
  (`PROVIDER_UNREADABLE`/`PR_UNREADABLE`), a **different/fork repo**
  (`REPO_CHANGED` — the PR's head branch must be in the Task's own repo, never a
  fork), a **non-open** PR (`PR_NOT_OPEN`), a **missing/non-full produced commit**
  (`NO_PRODUCED_HEAD`), a caller-supplied head that is not the produced commit
  (`HEAD_MISMATCH`) or no identity/adoptable PR (`NO_PR_IDENTITY`) is **BLOCKED**
  — never a fake `review_pass`, never a silently-accepted stale commit.
- The bound head is the **exact full 40-hex produced commit** (case-insensitive
  equality, never a prefix in either direction) and it is the Task's own
  `head_sha`: a caller-supplied `expectedHead` may only *restate* it, so no input
  can rewrite `task.head_sha` to a commit that was never produced.
- Nothing here pushes, creates/updates a PR, posts a review, merges, approves,
  deletes a branch, or writes Linear.
- A new PR HEAD is review-invalidating: `reconcileTaskFromProvider`/`linkTask`
  re-open the review at a new attempt when the live PR head moves, so old
  Review/VERIFY evidence at the previous HEAD never carries forward.

## Factory integration

`FactoryDeps.prBinding` enables the step. When set and the Task records a
`pr_repo`/`pr_url`, the Factory binds **before the review stage** (at the top of
the `review` phase); a BLOCKED bind returns the Factory outcome `blocked` and the
reviewer never runs. Unset, the Factory behaves exactly as before (local-only,
read-only).

## Operator contract

```sh
# READ-ONLY: re-read + verify the PR the Agent created/updated, at the Task's
# produced commit (task.head_sha). Needs the gh reader; never writes to GitHub.
RELAY_PROVIDER_GITHUB=gh relay pr bind <task-id>
RELAY_PROVIDER_GITHUB=gh relay pr bind <task-id> --json
```

There is no `--publish`: Relay has no GitHub write path.

## Tests

`tests/pr-binding.test.ts` is the fixture suite: read-only re-read + verify,
crash-retry adoption (no duplicate PR), the read-only FIX observation (Relay binds
B once the Agent pushed it; refuses while the PR still shows A), moved-head /
closed / other-repo / fork / unreadable / no-identity failures, the
exact-full-SHA head fence (prefix and different-SHA refusals), and the HEAD-evidence
invalidation through the existing provider reconcile. `tests/factory.test.ts` adds
the Factory gate: a matching PR head reaches MergeReady, a moved one BLOCKS with
the reviewer never running. No network is used.

## Real E2E (opt-in)

```sh
RELAY_ISH885_E2E=1 bun scripts/ish885-real-e2e.ts   # or: bun run smoke:pr-binding:real
```

Against a real disposable PR on `81ueman/relay`, the script is a **stand-in for
the Coding Agent** (it runs `git push` + `gh pr create` itself — NOT dsh/DeepSeek,
`codingAgentLeg: NOT_RUN`), has headless **Claude** post a native NG review at A
and a PASS marker at B (the prompt pre-fills the verdict, so this shows posting +
Relay's readback, not an independent judgment — `independentClaudeJudgment:
NOT_RUN`), and uses Relay's **read-only** `bindTaskPr` + `verifyNativeReview` to
observe A then B (same PR) and bind each review to its exact HEAD. It cleans up
the PR/branch after writing
[`ish885-real-e2e-evidence.json`](ish885-real-e2e-evidence.json).

Relay's zero-GitHub-write property is argued **statically**, not from this run:
there is no write argv (`git push` / `gh pr create|edit|merge|review|comment` /
`gh api --method`) anywhere in `src/`, and Relay's `gh` calls are `pr view`,
`pr list` and GET `api` only. The run cannot prove it independently because the
stand-in, the Claude reviewer and the `gh` login all share ONE GitHub account
(`81ueman`). The full Sandbox-dsh coding leg and the Factory MergeReady drive are
covered separately (tests); this script isolates the GitHub write/read boundary.
