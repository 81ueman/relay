# ISH-885b Agent E2E

This marker file proves the agent-owned publish path end to end:

1. The coding agent commits the change on the Task branch.
2. The agent pushes that commit to `relay/ish885b-e2e-mvdkgirl`.
3. The agent opens a pull request against `main` with `gh pr create`.

Relay itself is read-only: it never pushes, opens the PR, or posts a review.
