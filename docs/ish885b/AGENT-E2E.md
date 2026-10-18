# ISH-885b Agent E2E

Real-agent GitHub end-to-end fixture for [ISH-885](../pr-binding.md): the Coding
Agent — not Relay — owns every GitHub write.

## What this proves

Relay is read-only when it comes to GitHub. For a Task to become merge-ready, the
**Agent** running in its own Task Sandbox must:

1. make the change on the Task branch in the checkout it was given;
2. commit on that branch (never the default branch);
3. push the commit to the Task branch;
4. open a pull request against `main` with `gh pr create`.

Relay then independently re-reads GitHub and binds the Task to that PR and its
current remote HEAD. Relay never pushes, never creates or updates a PR, and never
posts a review; the independent reviewer owns the native `gh pr review`.

## Fixture contents

| Path | Purpose |
| --- | --- |
| `docs/ish885b/AGENT-E2E.md` | this document — the real-agent E2E record |
| `docs/ish885b/CHANGELOG.md` | the fixture changelog, with an `## Unreleased` section |
| `README.md` → `## ISH-885b fixture` | links to both documents above |

The fixture is deliberately small and path-scoped so that the E2E exercises the
Agent's real `git`/`gh` credentials and branch, not Relay's machinery.

## Runbook

From the Task Sandbox checkout on the Task branch:

```sh
# 1) make the change (this fixture already does)
# 2) verify the fixture mechanically
test -f docs/ish885b/AGENT-E2E.md
grep -q '^# ISH-885b Agent E2E$' docs/ish885b/AGENT-E2E.md
test -f docs/ish885b/CHANGELOG.md
grep -q '^## Unreleased$' docs/ish885b/CHANGELOG.md

# 3) commit path-scoped on the Task branch
git commit --only docs/ish885b/AGENT-E2E.md docs/ish885b/CHANGELOG.md README.md

# 4) push the Task branch (never the default branch)
git push origin HEAD:refs/heads/<task-branch>

# 5) open the PR against main — the Agent's GitHub write
gh pr create --base main --head <task-branch> \
  --title 'ISH-885b: real Agent-owned PR fixture' \
  --body 'Agent-owned push + PR for the ISH-885b E2E.'
```

If a PR already exists for the branch (for example a FIX round), push the new
commit to the same PR instead of opening a duplicate. Never merge and never post
a review from the worker.

## Pass criteria

- the fixture files exist and the checks above pass **at the reviewed commit**;
- the commit is present on the remote Task branch;
- an **OPEN** PR against `main` exists for that branch;
- Relay's read-only Task↔PR check reports the PR bound at that exact HEAD.

## Notes

- The Task/Worktree persists; the Run and its Sandbox are disposable.
- Do **not** run `relay claim`/`relay submit`/`relay approve`/`relay note` during
  the Run — Relay alone submits the Run after the process exits.
- No formal (TLA+) suites are involved: this fixture does not touch `formal/`.
