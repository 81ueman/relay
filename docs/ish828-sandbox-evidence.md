# ISH-828 — real Coding Sandbox smoke evidence

Measured on the host that ran the ISH-822/827 work (`sbx v0.48.0`, Docker
Sandboxes on Apple Silicon). Raw per-Run files are committed under
[`ish828-sandbox-evidence/`](ish828-sandbox-evidence/).

## Command

```sh
RELAY_SANDBOX_SMOKE=1 \
RELAY_SANDBOX_EVIDENCE_DIR="$TMPDIR/ish828-evidence" \
RELAY_SANDBOX_AGENT="$HOME/ghq/github.com/81ueman/ishiul/sandbox/coding-kit" \
  bun scripts/ish828-real-smoke.ts
```

The script creates a throwaway **main checkout**, lets Relay create a real
clone-mode sandbox from it, runs a real `dsh` inside via `sbx exec`, then tears the
sandbox down. It refuses to run without `RELAY_SANDBOX_SMOKE=1`.

## Output (verbatim)

```
ISH-828 real sandbox smoke — agent/kit: /Users/81ueman/ghq/github.com/81ueman/ishiul/sandbox/coding-kit
sbx version: sbx version v0.48.0 5caf923e0587d376848f6f388eca3e0f5ca00e2d
  ok 1. sbx is reachable and logged in
  ... sandbox relay-ish-828-real-1792200236622 (workspace /private/var/folders/2l/lk91l4dd1ysb1jfw7bkw0nrh0000gn/T/relay-ish828-real-l6Bjh2/repo)
  ok 2. dsh is present inside the sandbox (0.2.0-rc.2)
  ... real dsh Run run-2b926777: state=failed exit=1 session=session-0b65a11d-901e-453d-9578-afdeeec648b5
  ... dsh JSONL (first line): {"type":"session","sessionId":"session-0b65a11d-901e-453d-9578-afdeeec648b5","cwd":"/private/var/folders/.../repo"}
  ... dsh stderr tail:
dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment
  ok 3. Run evidence dir exists (.../runs/run-2b926777)
  ok 4. a real dsh stream or a real error was recorded (no silent no-op)
  ... run did not exit 0 (exit 1); skipping the commit assertion
  ok 5. cleanup plans without acting; sandbox named
  ok 6. the sandbox was stopped and removed (relay-ish-828-real-1792200236622)
  ok 7. the mapping records the removal
  ok 8. the Run evidence survived teardown

PASS — 8 checks
```

## What is proven

| Claim | Result |
| --- | --- |
| `sbx create --clone` from a **main checkout** via Relay | ✅ `relay-ish-828-real-…` created, private clone at the host path |
| Real `dsh` 0.2.0-rc.2 present **inside** the microVM | ✅ read via `sbx exec … dsh --version` |
| A real headless `dsh` Run started with `sbx exec` | ✅ real `session` event with a session id, JSONL captured |
| Original dsh JSONL + Relay events as per-Run evidence | ✅ `dsh.jsonl` / `stdout.log` / `stderr.log` / `events.jsonl` / `spec.md` |
| Brief pinned into the clone | ✅ no `sandbox.brief_pin_failed` (after the `.relay` mkdir fix) |
| Fail **closed** on a dsh failure | ✅ `state=failed`, `exit=1`, `producedHead=null`, no submission |
| Teardown saves evidence first, then removes the VM | ✅ `sbx stop` + `sbx rm`; `docs/…/events.jsonl` retained |

### Raw Relay event log ([`events.jsonl`](ish828-sandbox-evidence/events.jsonl))

```
{"t":"run.started","runId":"run-2b926777","sandbox":"relay-ish-828-real-…","phase":"implement","attempt":0,"baseHead":"2e4f7f3e…"}
{"t":"dsh.event","type":"session"}
{"t":"dsh.event","type":"status"}  (×4)
{"t":"dsh.event","type":"final"}
{"t":"stderr","v":"dsh: MISSING_CREDENTIAL: …"}
{"t":"run.exited","state":"failed","exitCode":1,"producedHead":null,"sessionId":"session-0b65a11d-…","dsh":{"total":6,"session":1,"status":4,"final":1,…}}
```

### Raw dsh JSONL ([`dsh.jsonl`](ish828-sandbox-evidence/dsh.jsonl))

```
{"type":"session","sessionId":"session-0b65a11d-…","cwd":"/private/var/folders/…/repo"}
{"type":"status","phase":"turn_start","turn":1}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"status","phase":"step_end","turn":1,"step":1}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"llm-deepseek: no API key …","code":"MISSING_CREDENTIAL"}}}
{"type":"final","text":""}
```

## Expected vs. measured, and the blocker

- **Expected:** the Run writes `SMOKE.md` and commits it; Relay fetches
  `sandbox-<name>/<branch>` and reports `exited`.
- **Measured:** the Relay plumbing is correct end to end, but the **model call**
  fails inside the sandbox: `MISSING_CREDENTIAL: llm-deepseek: no API key for
  provider route "deepseek-official"`. This is a **sandbox provider
  configuration** matter (the ISH-827 kit ships `dsh` but no DeepSeek key; the
  ISH-822 PoC supplied an Ollama-Cloud overlay + credential proxy), **not** a
  Relay defect — exactly the ISH-822 caveat. Relay failed **closed** (no commit
  invented, no submission).
- The smoke therefore HARD-asserts only the plumbing Relay owns (clone creation,
  dsh presence, `sbx exec` streaming, JSONL evidence, host fetch/cleanup) and
  records the real dsh outcome. An operator with a provider configured (e.g. the
  ISH-822 credential proxy) gets the `exited` path and a real fetched commit.

## Bugs this real smoke caught (not visible to the fake tests)

1. `sbx exec` was spawned **without the `sbx` binary prefix** (`Executable not
   found in $PATH: "exec"`). Fixed in `launchTaskSandboxRun`; the fake spawner now
   asserts `argv[0]` is the sbx binary.
2. The brief `sbx cp` failed because the destination `.relay` directory did not
   exist in the clone (`tar extract failed … Cannot open`). Fixed by
   `mkdir -p .relay` in the clone before the copy; the event
   `sandbox.brief_pin_failed` no longer appears.

## Reproduce

```sh
bun run smoke:sandbox                 # fake sbx/exec, real local git fetch (no Docker)
RELAY_SANDBOX_SMOKE=1 bun run smoke:sandbox:real   # real Docker Sandbox
```
