# Task Coding Sandbox lifecycle (ISH-828)

Relay runs a coding **Task** inside its own **Docker Sandboxes clone-mode
microVM** — a private in-container Git clone — while the **Task is durable**, the
**sandbox is durable (per Task)**, and each **Run/attempt is a disposable fresh
`dsh` process inside it**. No Herdr pane, no TUI, no `dsh web`, no manual attach.

This is implemented in `src/sandbox.ts` (the thin `sbx` boundary + the SQLite
mapping) and `src/sandbox-lifecycle.ts` (the Task lifecycle), composing
ISH-810's dsh JSONL decoder (`src/dsh-events.ts`), ISH-760's findings inheritance
and submission fences (`src/run-lifecycle.ts`, `src/dsh-runner.ts`). It does
**not** reimplement the phase machine, the dsh decoder or the `sbx` CLI, and it
adds **no** `relay lab` / network-specific Task schema.

```sh
relay run sandbox create  <task-id> [--agent KIT_OR_AGENT] [--source DIR] [--json]
relay run sandbox launch  <task-id> [--timeout 30m] [--permission MODE] [--json]
relay run sandbox show    <task-id> [--json]
relay run sandbox head    <task-id> [--json]
relay run sandbox list    [--json]
relay run sandbox submit  <run-id> [--evidence E] [--summary S]
relay run sandbox cleanup <task-id> [--abort REASON] [--apply] [--force] [--json]
```

## 1 Task = 1 sandbox + a private clone/branch

`relay run sandbox create` (or `launch`, which ensures it first) creates, or
**selects and reuses**, the single Coding Sandbox a Task owns:

- **clone mode** — `sbx create --clone --name <name> <agent|kit> <main-checkout>`.
  `sbx` gives the sandbox a **writable private clone** of the host repo and wires
  a host remote `sandbox-<name>`; the host checkout is never modified by the
  sandbox.
- **main checkout only** — `--clone` is run from the repo **main** checkout.
  `resolveMainCheckout` measures the git dir vs. git common dir and **refuses a
  linked worktree** (`SANDBOX_ERROR: … is a linked git worktree`), so a Relay lane
  path is never handed to `sbx`.
- **name / branch / HEAD mapping** — persisted one row per Task in the
  `sandboxes` table (`task_id`, `name`, `agent`, `source`, `workspace`, `branch`,
  `head_sha`, `state`, `evidence_dir`), and `runs.sandbox_name` links each Run to
  its sandbox. The name is `relay-<issue|id>[-<slice>]-<hash8>`: the trailing hash
  is derived from the Task's stable `id`, so two Tasks that sanitise/truncate to
  the same slug (different providers, colliding ids) still get **distinct**
  sandboxes.
- **reuse** — a second call, and every FIX, **selects the same sandbox** (no
  second clone). This is what makes a FIX the *same sandbox*.

The in-VM clone mirrors the host path (measured in ISH-822), so the sandbox
`workspace` is the resolved main checkout path. The Task branch is created/checked
out inside the clone so every Run commits onto the branch Relay later fetches.

## 1 Run = 1 fresh `sbx exec … dsh`

`relay run sandbox launch` ensures the sandbox, ensures a usable `dsh` inside it
(reads `dsh --version`; installs `@deepseek-ai/dsh@0.2.0-rc.2` only when missing
and not disabled), **pins the brief** into the clone
(`<workspace>/.relay/run-brief.md` via `sbx cp`; the same text is the dsh prompt),
then starts **exactly one** headless dsh Run:

```sh
sbx exec -w <workspace> -e DSH_PERMISSION_MODE=workspace-write \
  -e RELAY_RUN_ID=<run> -e RELAY_TASK_ID=<task> <name> \
  dsh --profile headless --json <brief>
```

The host `sbx exec` client runs in the **main checkout** cwd with only the host
environment it needs; the child dsh never inherits the host `process.env` inside
the VM. stdout / stderr / the **original dsh `--json` JSONL** / Relay's own
lifecycle log are written under `<control-plane>/runs/<run-id>/` exactly as the
worktree runner does, and the run row records phase / attempt / generation /
branch / `base_head_sha` / `head_sha` / `session_id` / exit code.

## Single-writer, staleness and duplicate submission

Single-writer is **per sandbox**: `assertNoActiveSandboxWriter` refuses a launch
while another Run on the same `sandbox_name` is `starting`/`running`, and the
check + INSERT happen in one `BEGIN IMMEDIATE` transaction, so it is atomic
across processes. A FIX is admitted only after the previous Run's row is terminal.

The Run is **not** a submission. `dsh exit 0` (or a `final` event) advances
nothing. `relay run sandbox submit` calls `acceptSandboxSubmission`, which adds a
**sandbox-identity fence** (the Run's `sandbox_name` must equal the Task's current
mapping) on top of the existing ISH-760/810 fences: the Run must be a clean
`exited`/exit-0 process; the live Task must not have moved (phase/attempt/branch
and the `base_head_sha` start fence); a newer Run for the same
`(task, phase, attempt)` supersedes it; and a terminal Task cannot be advanced.

## The produced commit reaches the host before submission

At Run end, if the process exited 0, Relay runs
`git fetch sandbox-<name>` in the main checkout and resolves
`sandbox-<name>/<branch>`. That fetched SHA is the Run's `head_sha` and the
revision `relay run sandbox submit` binds to. When a branch is bound there is
**no `FETCH_HEAD` fallback** — `git fetch` can point `FETCH_HEAD` at whatever ref
it saw first, so accepting it could record an unrelated commit. A fetch failure
fails the Run closed (`failed`, no `head_sha`): a commit Relay cannot see can
never advance a Task.

## Fail-closed on cancel / timeout / client failure / orphan

The local `sbx exec` client exiting is **not** the same as the in-VM dsh ending.
On **every** non-`exited` outcome — a cancel, a timeout, a non-zero client exit,
or a transport drop — Relay probes the sandbox
(`pgrep -f 'dsh --profile headless'`), stops any surviving in-VM dsh, and records
`orphaned: …`. If the in-VM process still will not die, the Run is deliberately
left **non-terminal** so the per-sandbox single-writer guard continues to block a
second writer; `relay run sandbox sweep --apply` resolves such a row after a
restart. A terminal `error` event contradicting exit 0 is `failed`. No path
fabricates a success.

## The host `process.env` is not inherited

Both child spawns (the host dsh runner and the `sbx exec` client) get a small
explicit allowlist (`src/child-env.ts`): `PATH`, `HOME`, locale, `SSH_AUTH_SOCK`,
and the sbx/dsh/Docker client config. An unrelated host variable (a secret, a CI
token) never reaches the child by default; a caller injects what a Run actually
needs through the explicit `env`/`dshArgs` options, and only those `-e` values
enter the VM. A provider overlay is an operator concern:
`dshArgs: ["--patch", "/home/agent/dsh-overlay.yml"]` plus the credential proxy.

## Safe teardown (evidence-retaining)

`relay run sandbox cleanup` is **dry-run** by default. `sbx stop` + `sbx rm
--force` happen only when every guard passes:

- the Task is **really merged** or explicitly **aborted** (`--abort <reason>`),
  with no open PR;
- no Run still holds the sandbox;
- **every** Run's evidence directory still exists on the host;
- a confirmed `sbx ls` (a listing failure is never treated as "gone").

Immediately before removal, `applySandboxCleanup` `git fetch`es
`sandbox-<name>` and resolves the branch tip. If the tip differs from the recorded
`head_sha` — the case where a Run committed and then exited non-zero — it is
pinned under a durable host ref (`refs/relay-sandbox/<name>`) and recorded, so a
produced commit can never be destroyed unseen. If the fetch fails, removal is
**refused**. The `runs` rows and their output directories are **never** deleted by
cleanup, and the Shared Lab VM / NOS images are a separate system this lifecycle
never touches.

## Isolation

`sbx` clone mode mounts the host repo **read-only** at `/run/sandbox/source`; the
agent works in a **separate writable copy**. Measured in ISH-822: the host home
(`/Users/<you>`), other repos, `~/.ssh` private keys and the host Docker socket
are all absent inside the VM; Git uses the **forwarded SSH agent**
(`SSH_AUTH_SOCK`), not a key file. Relay adds only the thin `sbx` boundary — no VM
provider, no bridge, no `relay lab`.

## Verified / not verified

- **Verified** (`bun test`, `bun run smoke:sandbox`): the `sbx` argv boundary
  (`--clone` from the main checkout; a linked worktree is refused); the durable
  Task→sandbox mapping, hash-suffixed unique names, and idempotent reuse; dsh
  launch via `sbx exec` with the JSONL/evidence pipeline; single-writer refusal;
  submit/refuse fences; a FIX reusing the same sandbox with the previous findings
  pinned; fail-closed on cancel/timeout/**client failure**/orphan (including a
  stubborn in-VM dsh left non-terminal) and the restart sweep; the pre-removal
  fetch-and-save of a commit from a failed Run; `sbx ls` failure as a refusal; and
  the child-env allowlist. All with a **fake** `sbx`/`sbx exec` and a **real**
  local git remote for the fetch, plus a **real-DB** reopen from the pre-ISH-828
  schema.
- **Real sandbox smoke** — `RELAY_SANDBOX_SMOKE=1 bun run smoke:sandbox:real`
  creates a real clone-mode sandbox from a throwaway main checkout, runs a real
  `dsh`, fetches the produced commit and removes the sandbox. With
  `RELAY_SANDBOX_KEY_CMD` it installs the Ollama-Cloud overlay + credential proxy
  so the run commits. Evidence is recorded in
  [`docs/ish828-sandbox-evidence.md`](ish828-sandbox-evidence.md).
- **NOT verified here**: any provider push/PR/merge (Relay adds no such
  authority); the Shared Lab / NOS / `labctl` (ISH-824/844/845); and removal of the
  obsolete worktree/attached-worker lanes (ISH-805).
