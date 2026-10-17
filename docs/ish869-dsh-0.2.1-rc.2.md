# ISH-869 — dsh `0.2.1-rc.2` pin (DeepSeek-V4.1-Flash-1017)

Version-pin + regression only. No new Runner/provider abstraction, no compat
shim, no second 0.2.x path, no old-version fallback. The `network-lab` Kit stays
in `relay/` (not moved back to `ishiul`).

- Target: **`@deepseek-ai/dsh@0.2.1-rc.2`** (exact). Previous baseline:
  `0.2.0-rc.2`. Official source: [dsh v0.2.1-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)
  (2026-10-17, adds DeepSeek-V4.1-Flash-1017 + Search/Fetch).
- Search/Fetch are **not** enabled by this change.

## Pin locations (single source of truth)

| Where | What |
| -- | -- |
| `src/dsh-version.ts` | `PINNED_DSH_VERSION = "0.2.1-rc.2"`, `isPinnedDsh`, `readDshVersion` — the ONE constant + guard used by **both** the host runner and the sandbox |
| `src/sandbox-lifecycle.ts` | re-exports the shared pin; `prepareSandboxDsh` installs/probes it and the launch guard enforces it |
| `src/dsh-runner.ts` | the host `startDshRun` guard (`DSH_VERSION_MISMATCH`) |
| `sandbox/coding-kit/spec.yaml` | `npm i -g @deepseek-ai/dsh@0.2.1-rc.2` (the fresh-sandbox provision) |
| `sandbox/README.md`, `docs/dsh-headless-runner.md`, `docs/sandbox-lifecycle.md`, `docs/factory-e2e.md`, `README.md` | version references |
| `tests/*`, `scripts/ish828-smoke.ts`, `scripts/ish762-real-smoke.ts` | pinned fixtures/comments |

## Fail-closed version guard

Both headless Coding Worker paths require **exactly** `PINNED_DSH_VERSION`; the
guard runs **before any Run row is written and before any process is spawned**, so
an old build can never be run as a normal success. `isPinnedDsh` matches an exact
whitespace-delimited token, so `0.2.1-rc.20` does **not** match.

- **Sandbox** (`launchTaskSandboxRun`): probes the binary it will run
  (`sbx exec … <dshBin> --version`) and refuses on a mismatch:

  ```
  SANDBOX_ERROR: sandbox <name> has dsh 0.2.0-rc.2, but Relay pins
  @deepseek-ai/dsh@0.2.1-rc.2; refusing to start a Run (an old version is never a
  silent pass)
  ```
- **Host** (`startDshRun`, reached by `relay run start` and `relay run factory`):
  probes `<dshBin> --version` (default `$RELAY_DSH_BIN` or `dsh` on `PATH`) and
  refuses on a mismatch:

  ```
  DSH_VERSION_MISMATCH: /path/to/dsh reports 0.2.0-rc.2, but Relay pins
  @deepseek-ai/dsh@0.2.1-rc.2; refusing to start a Run (an old version is never a
  silent pass)
  ```

## Verified (raw output)

Environment: Apple Silicon (`darwin/arm64`), `sbx v0.48.0`.

1. Registry has the exact build (no floating tag):
   ```
   $ npm view @deepseek-ai/dsh@0.2.1-rc.2 version
   0.2.1-rc.2
   ```

2. **Isolated host install** into a temp prefix — the user's global `dsh` was
   **not** touched:
   ```
   $ npm install -g --prefix "$TMP/dsh-021" @deepseek-ai/dsh@0.2.1-rc.2
   $ "$TMP/dsh-021/bin/dsh" --version
   0.2.1-rc.2
   ```

3. **Fresh ARM64 Coding Sandbox** from the updated Kit:
   ```
   $ sbx create --clone --name ish869-vercheck ./sandbox/coding-kit "$TMP/repo"
   ...
   $ sbx exec ish869-vercheck -- bash -lc 'dsh --version && which dsh'
   0.2.1-rc.2
   /usr/local/share/npm-global/bin/dsh
   ```

4. **An existing old sandbox is detected** — the leftover `ishiul-coding`
   sandbox still reports the old build, and by default the next launch would
   **install the pin in place** and only proceed if `dsh --version` then reports
   exactly `0.2.1-rc.2` (with `installDsh:false` it refuses outright):
   ```
   $ sbx exec ish827-kit -- dsh --version
   0.2.0-rc.2
   ```
   Covered by the unit test `ISH-869: an OLD dsh in the sandbox fails the launch
   closed (no silent pass)` (`installDsh:false` → refused) and `ISH-869: a MISSING
   dsh (install disabled) also fails the launch closed` (`tests/sandbox.test.ts`).

5. **Real headless JSONL contract** (identical to `0.2.0-rc.2`; no decoder change
   needed) and **fail-closed with no key** — the real process exits **non-zero**
   (never a silent `0`). Same stream from the fresh sandbox and from the isolated
   pinned host binary:
   ```
   $ RELAY_DSH_BIN="$TMP/dsh-021/bin/dsh"   # 0.2.1-rc.2
   $ DSH_HOME="$TMP/home" "$RELAY_DSH_BIN" --profile headless --json "reply with the single token PING"; echo EXIT=$?
   {"type":"session","sessionId":"session-d20b4e0b-...","cwd":"..."}
   {"type":"status","phase":"turn_start","turn":1}
   {"type":"status","phase":"step_start","turn":1,"step":1}
   {"type":"status","phase":"step_end","turn":1,"step":1}
   {"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"llm-deepseek: no API key for provider route \"deepseek-official\"; ... export DEEPSEEK_API_KEY in the launching environment","code":"MISSING_CREDENTIAL"}}}
   {"type":"final","text":""}
   EXIT=1
   stderr: dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"; ...
   ```

   This is the dsh 0.2.1-rc.1 headless credential-precedence change: headless
   reads `DEEPSEEK_API_KEY` from the **environment / `.env`**, not a saved
   credential. **Relay forwards only its allowlisted child env
   (`src/child-env.ts`) and does NOT inject a DeepSeek provider key** — the host
   CLI paths (`relay run start`/`launch`/`factory`) and `tests/dsh-smoke.test.ts`
   pass no provider key `env`/`dshEnv`, and `DEEPSEEK_API_KEY` is not allowlisted.
   The operator authenticates dsh through their **own provider configuration**
   (their dsh profile / provider route, an injected `.env`, or a sandbox
   credential proxy). **Host `.dsh` isolation:** a **sandbox** VM has no host
   `HOME`, so Relay does not share the host `~/.dsh` with a sandbox Run; a
   **host** Run, however, inherits `HOME`/`DSH_HOME` (`src/child-env.ts`), so the
   operator's `~/.dsh` — including `.credentials.yaml` — is **readable** from the
   host Run. dsh 0.2.1 headless does not read the saved credential by default,
   but Relay does not isolate it on the host (per-Run `HOME`/`DSH_HOME` isolation
   is tracked under ISH-869).
   Model route: `deepseek-official` → `deepseek-flash` (V4.1-Flash).

6. **The host Coding Worker guard (ISH-869 finding 1)** — the shared pin is now
   enforced in front of the host spawn too. Unit tests (no real dsh needed):
   `tests/dsh-runner.test.ts` → `ISH-869: a host dsh that is not the pin is
   refused before any Run row or process` (a fake `dshBin` reporting
   `0.2.0-rc.2` → `DSH_VERSION_MISMATCH`, 0 processes, 0 Run rows), `… whose
   --version fails is refused`, `an unpinned default from PATH/RELAY_DSH_BIN is
   refused`, and `the pinned host dsh is admitted and runs`. `tests/dsh-version.test.ts`
   covers the shared `isPinnedDsh`/`readDshVersion`. This host's global `dsh`
   (`0.2.0-rc.2`) is now refused on `relay run start`/`factory` unless
   `$RELAY_DSH_BIN` points at the pin — the global dsh was **not** modified.

7. Local gates:
   ```
   $ bun run typecheck
   $ tsc --noEmit          # exit 0

   $ bun test
   918 pass, 1 skip, 0 fail  (3376 expect() calls; 67 files)

   $ bun run smoke:sandbox
   PASS — 15 checks
   ```
   (The 1 skip is the opt-in authenticated smoke below.)

## NOT verified here (do not treat as PASS)

- **BLOCKED — authenticated `deepseek-flash` API smoke** (acceptance item 2: a
  real `session` + `tool_call`/`tool_result` + terminal status + exit with the
  live DeepSeek API). No `DEEPSEEK_API_KEY` is provisioned in this environment
  (`env | grep -i deepseek` is empty), so the decisive call cannot succeed. The
  exact command **was run** against the pinned build and fails closed for lack of
  a key:

  ```
  $ RELAY_DSH_BIN="$TMP/dsh-021/bin/dsh" RELAY_DSH_SMOKE=1 bun test tests/dsh-smoke.test.ts
  #  DEEPSEEK_API_KEY is unset; real dsh 0.2.1-rc.2 spawned
  (fail) real dsh headless smoke (opt-in) > runs one dsh --json process, ...
    Expected: "exited"
    Received: "failed"        # MISSING_CREDENTIAL (see item 5)
  ```

  This is **not unblockable by exporting a key alone**: Relay forwards only its
  allowlisted child env and does **not** inject `DEEPSEEK_API_KEY` into the host
  Run (see item 5), so
  `DEEPSEEK_API_KEY=... RELAY_DSH_SMOKE=1 bun test tests/dsh-smoke.test.ts` would
  still fail closed. The authenticated `deepseek-flash` smoke needs **provider-key
  forwarding to the host Run — deferred under ISH-869** — or an operator dsh
  **provider configuration** that authenticates without an ambient
  `DEEPSEEK_API_KEY`. The sandbox path uses the operator's credential proxy:
  ```sh
  RELAY_SANDBOX_SMOKE=1 RELAY_SANDBOX_AGENT=ishiul-coding \
    RELAY_SANDBOX_KEY_CMD=/abs/get-key.sh bun run smoke:sandbox:real
  ```
- **The real Factory E2E** (ISH-762) was not run here.
- No provider push / PR / merge was performed by this change (Relay adds no
  such authority); the PR for this issue is opened by the owner flow, unmerged.

## Regenerating / repairing a pinned sandbox

The Kit pins the build in `sandbox/coding-kit/spec.yaml`; a **new** sandbox picks
it up on create. An **existing** sandbox left on `0.2.0-rc.2` is upgraded **in
place** on the next `relay run sandbox launch` (Relay runs
`npm i -g @deepseek-ai/dsh@0.2.1-rc.2` inside the VM), and the Run starts only when
`dsh --version` then reports exactly `0.2.1-rc.2`; with `installDsh:false` the
launch is refused outright. To rebuild cleanly instead:

```sh
sbx rm --force <old-name>
sbx create --clone --name <new-name> ./sandbox/coding-kit <main-checkout>
sbx exec <new-name> -- dsh --version   # 0.2.1-rc.2
```
