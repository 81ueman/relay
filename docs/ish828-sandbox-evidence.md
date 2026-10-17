# ISH-828 — real Coding Sandbox smoke evidence

Measured on the host that ran the ISH-822/827 work (`sbx v0.48.0`, Docker
Sandboxes on Apple Silicon). Raw per-Run files are committed under
[`ish828-sandbox-evidence/`](ish828-sandbox-evidence/).

## Round 2 — decisive real acceptance (`exited` → fetch → submit)

### Command

```sh
RELAY_SANDBOX_SMOKE=1 \
RELAY_SANDBOX_EVIDENCE_DIR="$TMPDIR/ish828-evidence2" \
RELAY_SANDBOX_AGENT="$PWD/sandbox/coding-kit" \
RELAY_SANDBOX_KEY_CMD="$TMPDIR/ish822-helper/get-ollama-key.sh" \
  bun scripts/ish828-real-smoke.ts
```

The provider route is the ISH-822/827 recipe: an **Ollama-Cloud `--patch`
overlay** plus an `sbx secret set-custom` **credential proxy** (the real key stays
on the host; the sandbox only sees a `sbx-cs-…` placeholder). The smoke creates a
throwaway **main checkout**, has Relay create a real clone-mode sandbox, runs a
real `dsh` inside it, and tears it down. It refuses to run without
`RELAY_SANDBOX_SMOKE=1`.

### Output (verbatim)

```
ISH-828 real sandbox smoke — agent/kit: /Users/81ueman/.herdr/worktrees/relay/devin-ish-828-ish828/sandbox/coding-kit
sbx version: sbx version v0.48.0 5caf923e0587d376848f6f388eca3e0f5ca00e2d
provider route: ollama-cloud overlay + secret proxy (/private/var/folders/.../ish822-helper/get-ollama-key.sh)
  ok 1. `sbx ls --json` succeeded (sbx is reachable and logged in)
  ... sandbox relay-ish-828-real-1792213291301-1f93603d (workspace /private/var/folders/.../repo)
  ok 2. dsh is present inside the sandbox (0.2.0-rc.2)
  ok 3. provider credential proxy installed (sbx-cs-2vL6H6F2Iud5hYsC)
  ... real dsh Run run-c49b0f5c: state=exited exit=0 session=session-ff341c18-ecf1-4896-b87b-89cd36e48a1e
  ok 4. Run evidence dir exists (.../runs/run-c49b0f5c)
  ok 5. a real dsh stream or a real error was recorded (no silent no-op)
  ok 6. produced commit fetched to the host (8327d41e6378)
  ok 7. the fetched head is a real commit object
  ok 8. the structured submission advanced the Task
  ok 9. cleanup plans without acting; sandbox named
  ok 10. the sandbox was stopped and removed (relay-ish-828-real-1792213291301-1f93603d)
  ok 11. the mapping records the removal
  ok 12. the Run evidence survived teardown

PASS — 12 checks
```

### Raw Relay event log ([`events.jsonl`](ish828-sandbox-evidence/events.jsonl))

```
{"t":"run.started","runId":"run-c49b0f5c","sandbox":"relay-ish-828-real-…","phase":"implement","attempt":0,"baseHead":"82a58e3ac55d…"}
{"t":"dsh.event","type":"session"}
{"t":"dsh.event","type":"text"}
{"t":"dsh.event","type":"tool_call","callId":"call_xlphtmyt"}
{"t":"dsh.event","type":"tool_result","callId":"call_xlphtmyt"}
… 7 tool_call/tool_result pairs …
{"t":"dsh.event","type":"final"}
{"t":"run.exited","state":"exited","exitCode":0,"durationMs":27708,"sessionId":"session-ff341c18-…",
 "baseHead":"82a58e3ac55d2d3196bdaa983fe63707c17f37d0",
 "producedHead":"8327d41e6378321974c92e6d621b7078fb577af8",
 "dsh":{"total":40,"session":1,"status":16,"text":3,"thinking":5,"toolCall":7,"toolResult":7,"final":1,"error":0,"malformed":0,"truncated":0},
 "terminal":"final","turnReason":"completed"}
```

### Raw dsh JSONL ([`dsh.jsonl`](ish828-sandbox-evidence/dsh.jsonl), excerpts)

```
{"type":"session","sessionId":"session-ff341c18-ecf1-4896-b87b-89cd36e48a1e","cwd":"/private/var/folders/.../repo"}
{"type":"tool_call","callId":"call_xlphtmyt","tool":"bash","input":{"command":"pwd && git status --short --branch && git log --oneline -3",…}}
{"type":"tool_call","callId":"call_3wakqab2","tool":"write","input":{"file_path":"…/repo/SMOKE.md","content":"ISH-828-OK\n"}}
{"type":"tool_call","callId":"call_jsjz1rg1","tool":"bash","input":{"command":"git add SMOKE.md && git commit -m \"docs: add SMOKE.md with ISH-828-OK\" && git log --oneline -2 && …"}}
{"type":"tool_result","callId":"call_jsjz1rg1","status":"completed","result":"[relay/ish-828-real-1792213291301 8327d41] docs: add SMOKE.md with ISH-828-OK\n…"}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"Done. … Commit: `8327d41 docs: add SMOKE.md with ISH-828-OK` …"}
```

The sandbox clone committed `8327d41e6378321974c92e6d621b7078fb577af8` on
`relay/ish-828-real-1792213291301`; Relay's `git fetch sandbox-<name>` brought it
to the host, `git cat-file -t` confirmed a commit object, and
`acceptSandboxSubmission` advanced the Task. Teardown then removed the VM while
retaining the Run evidence.

## Round 1 — fail-closed negative case (no provider configured)

Without `RELAY_SANDBOX_KEY_CMD`, the same smoke produced a real dsh `session`
event and then `MISSING_CREDENTIAL: … deepseek-official`. Relay recorded
`state=failed`, `exitCode=1`, `producedHead=null`, and refused submission — no
commit was invented. This is the environment's provider gap (the ISH-822 caveat),
not a Relay defect; the round-2 run above supplies the configured-provider path.

## Bugs the real smoke caught (not visible to the fake tests)

1. `sbx exec` was spawned **without the `sbx` binary prefix** (`Executable not
   found in $PATH: "exec"`). Fixed in `launchTaskSandboxRun`; the fake spawner now
   asserts `argv[0]` is the sbx binary.
2. The brief `sbx cp` failed because the destination `.relay` directory did not
   exist in the clone. Fixed by `mkdir -p .relay` in the clone before the copy;
   `sandbox.brief_pin_failed` no longer appears (verified in the round-2
   `events.jsonl`).

## Round-2 review findings — where each is proven

1. **Pre-ISH-828 DB open** — `idx_runs_sandbox` removed from `SCHEMA`; `migrate()`
   adds it after `ALTER TABLE`. `tests/sandbox.test.ts` opens a DB whose `runs`
   table predates the column.
2. **Failed client probes/stops the in-VM dsh** — every non-`exited` outcome
   probes and stops; a stubborn in-VM dsh leaves the row non-terminal. Unit tests
   cover both a stopped orphan and a blocked second writer.
3. **No wrong-branch HEAD** — `fetchSandboxHead` has no `FETCH_HEAD` fallback when
   a branch is bound; `ensureSandboxBranch` is fatal and verifies the checked-out
   branch. Test: a fetched unrelated branch is refused.
4. **No unfetched commit destroyed** — `applySandboxCleanup` fetches and pins the
   branch tip under `refs/relay-sandbox/<name>` before `rm`; a failed fetch
   refuses removal. Test: a commit from an exit-1 Run is saved then removed.
5. **Unique sandbox names** — `relay-<slug>-<hash8>` from the stable Task id. Test:
   same issue/slice across providers yields distinct names.
6. **`sbx ls` failure is not "no sandboxes"** — `sbxList` returns an `ok` result;
   callers fail closed. Tests: ensure keeps the mapping; cleanup refuses.
7. **Decisive real acceptance** — this document + the round-2 run above.
8. **Host env boundary** — `src/child-env.ts` allowlist is used by both spawns
   (`dsh-runner`, `sbx exec`). Tests: `SECRET_X` never reaches either child.

## Round-3 review findings — where each is proven

1. **Self-matching probe** — the probe/pkill pattern is `[d]sh --profile headless`
   (`DSH_PROC_PATTERN`), so `pgrep`/`pkill` do not match the `bash -lc …` line that
   runs them. Test: the regex matches `dsh --profile headless` but not the probe or
   pkill command line.
2. **Three-state probe** — `sandboxDshState` returns `alive` / `gone` / `unknown`
   (a failed probe `sbx exec`, or neither marker, is `unknown`). `unknown` is
   treated like `alive`: the Run is left non-terminal. Test: a failed probe leaves
   the Run `running` and the single-writer guard holding.
3. **Sweep re-probes** — `sweepOrphanedSandboxRuns` re-probes after `pkill` and
   marks the Run terminal only on a confirmed `gone`; a stubborn dsh leaves the
   row non-terminal with `stopped:false, resolved:false`. Tests cover both the
   stubborn and the resolved cases.

## Reproduce

```sh
bun run smoke:sandbox                 # fake sbx/exec, real local git fetch (no Docker)
RELAY_SANDBOX_SMOKE=1 bun run smoke:sandbox:real   # real Docker Sandbox (needs a provider)
```
