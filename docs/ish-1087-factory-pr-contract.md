# ISH-1087 — Factory PR + head-pinned review contract

Status: implemented in Relay (this repo). The ishiul-side Gateway/skill edit is a
separate PR; this document is the contract Relay now enforces.

## The failure this closes

The live ishiul Factory intake records a Task with **no `pr_repo` / `pr_url`** —
only a branch. The old Factory:

- skipped the read-only Task↔PR bind (`if (task.pr_repo || task.pr_url)`), so the
  dsh worker was never told to open a PR;
- ran the reviewer as a **local structured verdict** with no GitHub review;
- reached `merge_ready` with the merge gate `BLOCKED / NO_PR`;
- and credited `TaskMerged` for a merge with **no bound PR at all**.

Evidence: ishiul `T243` / PR #928 and `T238` / PR #916. In the ishiul state DB the
Runs and ReviewResults exist, the Tasks have `pr_url = NULL`, and the merge gate
event is `BLOCKED: CHECKS_NOT_RUN+NO_PERMISSION+NO_PR`. The PR was created only at
merge time by the Gateway.

## Who opens the PR

The **dsh coding worker** does, before its Run ends. The Gateway must not open a
PR except as a recorded fallback.

The Relay Run brief (pinned at `.relay/run-brief.md` and passed as the dsh prompt)
now includes a mandatory section when a GitHub target is resolvable:

- push the Task branch: `git push origin HEAD:refs/heads/<branch>` (never the
  default branch);
- open the PR with title **`ISH-<n>: <what changed>`**;
- body follows the target repo's `.github/pull_request_template.md` and includes
  a **`## Documentation Impact`** section (`None` is a valid value);
- on a FIX, push the new commit to the **same** PR and update its body — no
  duplicate;
- never merge and never post a review.

The target repo is the Task's `pr_repo`/`pr_url`, else the Task workspace's
`origin`, else the Factory source checkout (`--pr-repo` overrides). This is why a
Task that records only a branch now gets the instruction.

## What the Factory enforces

1. At intake it records the resolved `pr_repo` on the Task.
2. Before the review stage it **always** runs the read-only bind (when a GitHub
   reader is configured). The PR must be open and its live head must equal the
   produced commit. No PR / moved head / fork / other repo / unreadable →
   `blocked`; the reviewer never runs. A Factory Task can no longer reach
   `merge_ready` with `NO_PR`.
3. `requireNativeReview` defaults to true once a `prBinding` is configured (and
   `relay run factory` sets it explicitly): the independent reviewer must post
   the ISH-883 native `COMMENT` review and Relay must read it back at the
   reviewed head. A local-only structured PASS cannot reach MergeReady.
4. The review body carries the `<!-- ishiul-review head=<sha> verdict=... -->`
   marker **and** `## Findings — attempt <n>` (or `No findings.`), so the
   attempt-N finding text is readable from the PR itself.
5. `confirmMerged` refuses to credit a merge for a code Task with no bound PR
   (`CODE_CHANGE_GATE: NO_PR`). Relay still does not perform merges; a real merge
   is only *observed and credited* against an explicit PR at the recorded head.

## Provenance rule

The native review / `ishiul-review` marker is posted **only by the reviewer Run**,
never by the Gateway or the coding worker. The GitHub login is shared, so the
provenance guarantee is structural: Relay's only write tool is none; the coding
worker's brief forbids reviews; the reviewer's brief requires one.

## Operator configuration

- `RELAY_PROVIDER_GITHUB=gh` forces the read-only `gh` reader; `off` disables it.
  When unset, the operator/Factory/daemon paths auto-detect a `gh` that passes
  `gh auth status`.
- The Factory authorizes the reviewer's `COMMENT` review by default
  (`RELAY_GITHUB_REVIEW_WRITE=0` opts out and then `requireNativeReview` blocks).
- `RELAY_REVIEW_AUTHOR=<login>` overrides the author; otherwise the authenticated
  `gh api user` login is used.
- `relay pr bind <task>` / `relay merge-check <task>` print the bound PR
  (`pr=owner/name#n@sha`).

## Verification

- `bun test` and `bun run typecheck`.
- New tests: worker brief (target resolution, title/template/Documentation
  Impact), Factory adoption from `--pr-repo` with no `task.pr_repo`,
  `requireNativeReview` blocking before the reviewer, review-body findings
  contract, provider auto-detection, and `confirmMerged` refusing a no-PR merge.
- Live acceptance (next Factory-merged ishiul PR): `reviews` or an
  `ishiul-review` marker whose head equals the merged head, posted before
  `mergedAt`; the PR author/commit trail is the worker Run; `relay merge-check
  <T>` shows the bound PR.
