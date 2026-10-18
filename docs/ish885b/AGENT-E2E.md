# ISH-885b Agent E2E

This fixture records the real-agent GitHub end-to-end path for ISH-885b.

## Scope

A coding agent running in the Relay Task worktree owns the complete GitHub
change: it edits the files, commits on the Task branch, pushes that branch, and
opens the pull request against `main`.

## Agent-owned GitHub writes

The Agent-owned GitHub writes are the push of the Task branch and the creation
or update of its pull request. Relay is read-only for GitHub: it never pushes a
branch, never creates or updates a pull request, and never merges.

## Sequence

1. The agent makes the change in the Task worktree on the Task branch.
2. The agent commits the change locally.
3. The agent pushes `HEAD` to the Task branch.
4. The agent opens one pull request against `main` (or updates the existing one).
5. Relay and the independent reviewer only read the PR back; neither writes it.
