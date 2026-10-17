# Network Lab skill + Task-owned lab cleanup (ISH-845)

A coding Task may need a **real, arbitrary containerlab topology** (routing,
switching, VPN, NOS config, gNMI/SSH observation). ISH-845 gives the agent one
small **skill** to deploy/inspect/exec/destroy such a topology with `labctl`, and
gives Relay a **minimal** way to reclaim the Task's external lab when the Task
ends.

Relay stays **containerlab-agnostic**. It models no network, no NOS, no topology
and no image; it adds **no `relay lab` command**, no generic external-resource
orchestrator, no per-task Linux user and no resident daemon.

The moving parts:

| part | where | responsibility |
| --- | --- | --- |
| `network-lab` skill | [`skills/network-lab/SKILL.md`](../skills/network-lab/SKILL.md) | tell the agent how to run an arbitrary topology with `labctl` under its owner id |
| kit install | [`sandbox/coding-kit/files/home/.agents/skills/network-lab/SKILL.md`](../sandbox/coding-kit/files/home/.agents/skills/network-lab/SKILL.md) | put the skill on the **real dsh Sandbox skill path** in the microVM |
| owner id | `labOwnerId` (`src/lab-cleanup.ts`) | the Task's external Lab owner identifier (deterministic = Task id), injected as `RELAY_LAB_OWNER` |
| cleanup hook | `planLabCleanup` / `applyLabCleanup` (`src/lab-cleanup.ts`) | run **one trusted pre-configured command** for exactly this Task's owner id |
| CLI wiring | `src/cli.ts` (`relay run cleanup`, `relay run sandbox cleanup`) | run the hook as part of Task teardown |

## 1. One skill, on the path dsh actually reads

`dsh 0.2.0-rc.2` discovers skills with `@deepseek-ai/dsh-skill-filesystem` →
`FileSystemSkillProvider.roots`, which scans, in rank order: the project
(`<project>/.dsh/skills`, `<project>/.agents/skills`), any custom dirs, and the
**user** roots `$DSH_HOME/skills` and `$AGENTS_HOME/skills` (default
`~/.agents/skills`). The Coding Kit installs `network-lab` at
`files/home/.agents/skills/network-lab/SKILL.md` → `~/.agents/skills/...` in the
microVM — a **Sandbox** skill, deliberately distinct from Relay's active OpenCode
Gateway skills (`~/.config/opencode/skills`) and from the legacy Herdr attached
Coding Worker skills. The repo file and the kit copy are byte-for-byte identical,
pinned by `tests/network-lab-skill.test.ts`, so the installed skill is always the
reviewed one.

The skill instructs the agent to: use the task's owner id as **both** the
topology `name:` and the `labctl --namespace`; deploy with `labctl`; read
management endpoints from `inspect --json` (`reachable_at`); record the E2E
result as evidence; and destroy the lab. It explicitly says the agent may use
**any** topology and does **not** tell it to copy NOS images, `docker pull`, or
touch host Docker (the image cache lives on the Lab and is reused across tasks).

Two `labctl` behaviours the skill pins (both found by a real agent run, see the
evidence doc): `labctl` reads the topology `name:` **verbatim** (no shell
expansion), so the owner id must be written into the file; and `--insecure` is a
**per-subcommand** option (and, for `exec`, must precede `<lab>/<node>`).

## 2. Owner id — the only registration

Relay already holds the Task id. `labOwnerId(taskId)` returns it unchanged, and
`launchTaskSandboxRun` injects it into the sandbox env as `RELAY_LAB_OWNER`. The
skill uses it as the lab `name:`/`--namespace`. That is the whole contract: two
Tasks can never share an owner id, so a cleanup for one Task can never name —
let alone destroy — another Task's lab. `labctl` itself stays generic; a
non-Relay user just picks their own namespace.

## 3. Cleanup — one trusted hook, Task-end only

`applyLabCleanup` runs a **single fixed command**, `RELAY_LAB_CLEANUP_CMD`, as
`[cmd, ownerId]`. It never uses a shell, never interpolates the Task prompt or
any Run-derived URL/command, and passes no other argument — the hook cannot be
pointed at another Task's lab. The child gets the small `childEnv()` allowlist
plus `RELAY_LAB_OWNER`/`RELAY_TASK_ID`; **host secrets and the SSH agent are
not** handed over, so the hook owns its own `labctl` credentials (loaded at
runtime from the operator's file), matching ISH-845 scope 7.

Guards (mirroring the worktree/sandbox cleanup):

- **no hook configured** → pure no-op (no subprocess, no external call), so a
  Lab-unused Task causes no extra operation;
- the Task must have **ended** — merged (`merged_at`) or an explicit `--abort`,
  with no open PR. A Task parked at **`merge_ready`** has *not* ended and is
  refused: reaching MergeReady never deletes a lab;
- the hook is **idempotent and re-runnable**: a non-zero exit, a spawn failure
  or a timeout is recorded as an event (`lab.cleanup_failed`), never thrown, and
  re-invoking cleanup retries it. Success records `lab.cleaned`.

Relay never removes NOS images or the Shared Lab VM; the hook is required to
destroy only the owner's containers/networks (the skill says the same).

## 4. Non-goals

No generic plugin registry, no resident daemon, no external-resource
orchestrator, no per-task Linux user, no `relay lab` network command, no
network-specific Task schema. Relay never learns a topology.

## 5. Tests

`bun run typecheck` (or `./node_modules/.bin/tsc --noEmit`) and `bun test`.
`tests/lab-cleanup.test.ts` pins the guard (no hook / MergeReady / unmerged),
the trusted invocation (`[cmd, ownerId]`, dry-run), two-task isolation, failure
injection (auth error, timeout, missing executable) and retry, and the real hook
process (real script, real exit code, real kill-on-timeout).
`tests/network-lab-skill.test.ts` pins the kit copy and the skill's contract.
`formal/` is untouched, so no TLC run is required.
