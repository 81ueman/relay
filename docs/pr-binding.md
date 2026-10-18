# Task ↔ PR binding (ISH-880)

ISH-828 fetches a Task's **exact Coding Sandbox commit** to the host; ISH-829
verifies that **exact local HEAD**; ISH-761 is a **read-only** HEAD-bound merge
gate. None of them turns a produced commit into a GitHub PR. ISH-880 is the one
seam that does: it publishes (only when explicitly authorized) and then binds the
PR's **live remote HEAD** to the same Task/attempt — before the Task may enter
the review stage.

`src/pr-binding.ts` composes existing pieces only: the read-only
`GitHubReadOnly` reader, `linkTask` (whose HEAD fence already invalidates a
Review/VERIFY at a moved HEAD) and the point-of-use `ProviderAuthority`. There is
**no** second workflow engine, provider framework or credential grant.

## Identity is explicit

The Task↔PR identity is a recorded **`pr_url`** (`owner/repo#n`, a GitHub PR URL,
or `#n` with a `pr_repo`). It is **never** inferred from a branch name or output
text alone. A missing identity is not "no PR" — it is *unbound*, which can never
become a merge-ready PASS.

## The bind passes

`bindTaskPr(db, taskId, deps)` returns a structured
`PrBindingResult { status, ref, expectedHead, remoteHead, created, reason,
identity }` and, in order:

1. **Recorded identity** — re-read the PR from GitHub and require its `headSha`
   to equal the produced commit (`expectedHead`, default `task.head_sha`). The
   publisher is **never** called: a recorded PR is not re-published.
2. **Crash-retry adoption** — with no recorded identity, an existing PR on the
   Task's **own repo + branch** is adopted *only when its head equals the
   produced commit* (repo AND head, so this is not branch-name-only inference).
   No duplicate PR is created.
3. **Publish** — otherwise `git push` + find-or-create `gh pr create` through the
   `PrPublisher` seam (`GitGhPrPublisher`), and only with an explicit
   point-of-use `githubWrite` grant.

Every pass re-reads GitHub and requires the remote head to equal the produced
commit; the recorded `head_sha`/`pr_url` are only written through `linkTask`.

## Fail-closed rules

- A **moved** PR head (`HEAD_MOVED`), an **unreadable** provider/PR
  (`PROVIDER_UNREADABLE`/`PR_UNREADABLE`), a **different repo** (`REPO_CHANGED`),
  a **non-open** PR (`PR_NOT_OPEN`) or a **missing produced commit**
  (`NO_PRODUCED_HEAD`) is **BLOCKED** — never a fake `review_pass`, never a
  silently-accepted stale commit.
- Publishing without an explicit `githubWrite` grant (`PUBLISH_UNAUTHORIZED`),
  without a publisher (`NO_PUBLISHER`), without a target repo
  (`REPO_UNKNOWN`/`BRANCH_UNKNOWN`) or when `git`/`gh` fails (`PUBLISH_FAILED`)
  is **BLOCKED**. There is no implicit grant, no default publisher, and no
  runtime repository push without it.
- `GitGhPrPublisher` refuses to push when the git remote does **not** point at
  the target repo, so a misconfigured checkout can never publish a Task's commit
  into an unrelated repository.
- Nothing here merges, approves, deletes a branch, or writes Linear.
- A new PR HEAD is review-invalidating: `reconcileTaskFromProvider`/`linkTask`
  re-open the review at a new attempt when the live PR head moves, so old
  Review/VERIFY evidence at the previous HEAD never carries forward.

## Factory integration (opt-in)

`FactoryDeps.prBinding` enables the step. When set and the Task records a
`pr_repo`/`pr_url`, the Factory binds **before the review stage** (at the top of
the `review` phase); a BLOCKED bind returns the Factory outcome `blocked` and the
reviewer never runs. Unset, the Factory behaves exactly as before (read-only).

## Operator contract

```sh
# Read-only (re-read + verify an already-recorded PR). Needs the gh reader:
RELAY_PROVIDER_GITHUB=gh relay pr bind <task-id>
RELAY_PROVIDER_GITHUB=gh relay pr bind <task-id> --json

# Explicit point-of-use write grant: push the produced commit + find-or-create
# the PR (normal git/gh; never merges).
RELAY_PROVIDER_GITHUB=gh relay pr bind <task-id> --publish
```

`--publish` is the *only* way this code path writes to a provider, and it is
per-invocation. The Factory path uses whatever `prBinding` deps the operator
wires; it is unset by default.

## Tests

`tests/pr-binding.test.ts` is the fixture suite: publish-then-verify, idempotent
re-read, crash-retry adoption (no duplicate PR), moved-head / closed /
other-repo / unreadable failures, the unauthorized and no-publisher refusals, the
`GitGhPrPublisher` remote guard + find-or-create, and the HEAD-evidence
invalidation through the existing provider reconcile. `tests/factory.test.ts`
adds the Factory gate: a matching PR head reaches MergeReady, a moved one BLOCKS
with the reviewer never running. No network is used.
