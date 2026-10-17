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
| owner id | `labOwnerId` (`src/lab-cleanup.ts`) | the Task's external Lab owner identifier (never reused), handed out as `RELAY_LAB_OWNER` and recorded as `lab.owner_assigned` |
| relay cleanup | `planLabCleanup` / `applyLabCleanup` (`src/lab-cleanup.ts`) | decide and run **one trusted pre-configured command** for exactly this Task's owner id |
| reference hook | [`scripts/lab-cleanup.sh`](../scripts/lab-cleanup.sh) | the documented `RELAY_LAB_CLEANUP_CMD`: destroy only `netlab-<owner>` + purge the owner's leftover dir |
| CLI wiring | `src/cli.ts`, `src/gc.ts` | run the hook as part of Task teardown; keep a pending Task out of `gc` |

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
topology `name:` (`netlab-<owner>`) and the `labctl --namespace`; deploy with
`labctl`; read management endpoints from `inspect --json` (`reachable_at`);
record the E2E result as evidence; and destroy the lab. It explicitly says the
agent may use **any** topology and does **not** tell it to copy NOS images,
`docker pull`, or touch host Docker (the image cache lives on the Lab and is
reused across tasks).

Two `labctl` behaviours the skill pins (both found by a real agent run, see the
evidence doc): `labctl` reads the topology `name:` **verbatim** (no shell
expansion), so the owner id must be written into the file; and `--insecure` is a
**per-subcommand** option (and, for `exec`, must precede `<lab>/<node>`).

## 2. Owner id — assigned durably, never reused

`labOwnerId(task)` = `<task.id>-<task.created_at>`. It is **never reused**: even
if `relay gc` deletes a terminal Task and `nextTaskId` later hands the same id to
a new Task, the new Task's `created_at` differs, so it can never take over the
earlier Task's Lab identity (and its cleanup can never target the earlier Task's
Lab). The value matches the containerlab naming charset (`[A-Za-z0-9._-]`).

Relay **records the assignment** when it actually hands the owner id out:
`launchTaskSandboxRun` writes a durable `lab.owner_assigned` event
(`src/sandbox-lifecycle.ts`, next to the `RELAY_LAB_OWNER` env injection).
`planLabCleanup` uses that record — never a recomputation — and **skips** a Task
that never had an owner assigned (reason `no lab owner assigned`), so a Task
that only ran through the worktree/factory path causes **no external Lab call**
even when a hook is configured.

To keep a failed cleanup re-runnable, `planGc` **skips** a terminal Task whose
latest `lab.*` event is not `lab.cleaned` (i.e. it was assigned a lab and never
successfully cleaned it), while a hook is configured; the Task row (and thus its
owner id) survives so `relay run cleanup <id>` can retry. A Task with no
assignment, or one whose lab was cleaned, is gc-eligible as before.

## 3. Cleanup — one trusted hook, Task-end only, no live Run

`applyLabCleanup` runs a **single fixed command**, `RELAY_LAB_CLEANUP_CMD`, as
`[cmd, ownerId]`. It never uses a shell, never interpolates the Task prompt or
any Run-derived URL/command, and passes no other argument — the hook cannot be
pointed at another Task's lab.

The **hook process** gets: the small `childEnv()` startup allowlist (PATH, HOME,
locale — and the SSH agent socket, as every Relay child does), plus
`RELAY_LAB_OWNER`/`RELAY_TASK_ID`, plus a narrow, explicitly named `LABCTL_*` set
(`LABCTL_ENV_ALLOWLIST`: `API`, `USER`, `PASSWORD`, `PASSWORD_FILE`, `TOKEN`,
`CA_CERT`, `BIN`) copied **from Relay's own environment** in `labCleanupHookEnv`.
A hook that prefers to keep the secret out of Relay's environment may instead
load it from the operator-owned file `$HOME/.config/relay/labctl.env` (sourced
only when the environment defines no credential, so the environment wins).

The **dsh Run inside the sandbox** is a different boundary: it still gets only
the explicit `-e` values Relay sets, so an unrelated host secret in Relay's
environment does not reach the VM by default. No task-prompt-derived value is
ever placed in the hook's argv or environment.

Guards (mirroring the worktree/sandbox cleanup):

- **no hook configured** → pure no-op (no subprocess, no external call);
- **no owner assigned** → skipped (no external call);
- **an active Run** (`runs.state` `starting`/`running` for the Task) → refused,
  even with `--abort`: a lab a live Run is using is never torn down;
- the Task must have **ended** — merged (`merged_at`) or an explicit `--abort`,
  with no open PR. A Task parked at **`merge_ready`** has *not* ended and is
  refused;
- the hook is **idempotent and re-runnable**: a non-zero exit, a spawn failure
  or a timeout is recorded as an event (`lab.cleanup_failed`), never thrown, and
  re-invoking cleanup retries it. Success records `lab.cleaned`.

### The reference hook (`scripts/lab-cleanup.sh`)

The hook that decides *which* labs die ships in the repo (it is the value of
`RELAY_LAB_CLEANUP_CMD`). It selects **strictly by owner**: it lists the Labs and
destroys only the one named **exactly** `netlab-<owner>` — never by name suffix
or prefix (so cleaning owner `T1` can never destroy another owner's `bgp-T1`, nor
a `netlab-T11`). It then purges the owner's leftover workspace directory
(`labctl purge netlab-<owner> --namespace <owner>`, recovering a crashed/timed-out
deploy with no lab), validates the owner id (`[A-Za-z0-9._-]`), and never touches
images or the Shared Lab VM.

The purge **fails closed**: only labctl's `EXIT_NOTFOUND` (6 — no remote dir, or
a lab still exists) is "nothing to purge"; any other failure (auth 4, API 5,
timeout 7, …) exits the hook non-zero, so a hidden purge failure can never be
recorded as a successful cleanup that leaks the directory.

`tests/lab-cleanup-hook.test.ts` runs the committed hook against a fake `labctl`
with `netlab-T1`, `bgp-T1` (another owner) and `netlab-T11` (only `netlab-T1` is
destroyed), checks the purge/credential cases, and `tests/lab-cleanup.test.ts`
runs the committed hook **through `applyLabCleanup` + `realLabCleanupRunner`**
(a fake `labctl`) to prove Relay's forwarded `LABCTL_*` environment actually
reaches it and the cleanup is `ok`.

Relay never removes NOS images or the Shared Lab VM; the hook is required to
destroy only the owner's containers/networks (the skill says the same).

## 4. Non-goals

No generic plugin registry, no resident daemon, no external-resource
orchestrator, no per-task Linux user, no `relay lab` network command, no
network-specific Task schema. Relay never learns a topology.

## 5. Tests

`bun run typecheck` (or `./node_modules/.bin/tsc --noEmit`) and `bun test`.
`tests/lab-cleanup.test.ts` pins the guards (no hook / no assignment / MergeReady
/ unmerged / **active Run**), the trusted invocation (`[cmd, ownerId]`,
dry-run), the never-reused owner id, two-task isolation, failure injection (auth
error, timeout, missing executable) and retry, and the real hook process.
`tests/lab-cleanup-hook.test.ts` pins the committed hook's strict owner
selection, its credential sources (environment + `$HOME/.config/relay/labctl.env`)
and its fail-closed purge; `tests/lab-cleanup.test.ts` additionally runs the
committed hook through `applyLabCleanup` + `realLabCleanupRunner` to prove the
forwarded `LABCTL_*` environment reaches it. `tests/gc.test.ts` pins the
pending-lab-cleanup skip.
`tests/network-lab-skill.test.ts` pins the kit copy and the skill's contract.
`formal/` is untouched, so no TLC run is required.
