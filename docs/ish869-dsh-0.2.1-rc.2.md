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
| `src/sandbox-lifecycle.ts` | `export const PINNED_DSH_VERSION = "0.2.1-rc.2"` — used by `prepareSandboxDsh` (install) and the launch guard |
| `sandbox/coding-kit/spec.yaml` | `npm i -g @deepseek-ai/dsh@0.2.1-rc.2` (the fresh-sandbox provision) |
| `sandbox/README.md`, `docs/dsh-headless-runner.md`, `docs/sandbox-lifecycle.md`, `docs/factory-e2e.md`, `README.md` | version references |
| `tests/*`, `scripts/ish828-smoke.ts`, `scripts/ish762-real-smoke.ts` | pinned fixtures/comments |

## Fail-closed version guard (new)

`launchTaskSandboxRun` now refuses a Run when the sandbox's `dsh --version` is not
**exactly** `PINNED_DSH_VERSION`:

```
SANDBOX_ERROR: sandbox <name> has dsh 0.2.0-rc.2, but Relay pins
@deepseek-ai/dsh@0.2.1-rc.2; refusing to start a Run (an old version is never a
silent pass)
```

A sandbox left on the `0.2.0-rc.2` baseline (or with dsh missing and
`installDsh:false`) is **never** treated as a successful start. The check runs
before any process spawn and before a Run row is written. `isPinnedDsh` matches an
exact whitespace-delimited token, so `0.2.1-rc.20` does **not** match.

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

4. **An existing old sandbox is detected, not silently passed** — the leftover
   `ishiul-coding` sandbox still reports the old build, and the new guard refuses it:
   ```
   $ sbx exec ish827-kit -- dsh --version
   0.2.0-rc.2
   ```
   Covered by unit tests `ISH-869: an OLD dsh in the sandbox fails the launch
   closed` and `ISH-869: a MISSING dsh (install disabled) also fails the launch
   closed` (`tests/sandbox.test.ts`).

5. **Real headless JSONL contract inside the fresh sandbox** (identical to
   `0.2.0-rc.2`; no decoder change needed) and **fail-closed with no key** — the
   real process exits **non-zero** (never a silent `0`):
   ```
   $ sbx exec ish869-vercheck -- bash -lc 'dsh --profile headless --json "reply with the single token PING"; echo EXIT=$?'
   {"type":"session","sessionId":"session-b8136206-...","cwd":"..."}
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
   credential. Relay already injects a provider key explicitly (host runner
   `env` option; sandbox `sbx exec -e` / the operator's `sbx secret set-custom`
   proxy) and never shares the host `~/.dsh/.credentials.yaml`. Model route:
   `deepseek-official` → `deepseek-flash` (V4.1-Flash).

6. Local gates:
   ```
   $ bun run typecheck
   $ tsc --noEmit          # exit 0

   $ bun test
   905 pass, 1 skip, 0 fail  (3344 expect() calls; 66 files)

   $ bun run smoke:sandbox
   PASS — 15 checks
   ```

## NOT verified here (do not treat as PASS)

- **Authenticated `deepseek-flash` API smoke** (a real `tool_call`/`tool_result`
  with a live key): no `DEEPSEEK_API_KEY` is provisioned in this environment, so
  it was not run. It is opt-in and needs an operator key. Run it with:
  ```sh
  DEEPSEEK_API_KEY=... RELAY_DSH_SMOKE=1 bun test tests/dsh-smoke.test.ts
  ```
  or, in a sandbox:
  ```sh
  RELAY_SANDBOX_SMOKE=1 RELAY_SANDBOX_AGENT=ishiul-coding \
    RELAY_SANDBOX_KEY_CMD=/abs/get-key.sh bun run smoke:sandbox:real
  ```
- **The real Factory E2E** (ISH-762) was not run here.
- No provider push / PR / merge was performed by this change (Relay adds no
  such authority); the PR for this issue is opened by the owner flow, unmerged.

## Regenerating a pinned sandbox

The Kit pins the build in `sandbox/coding-kit/spec.yaml`; a **new** sandbox picks
it up on create. An **existing** sandbox keeps its old dsh until re-created — and
Relay now refuses to run in it:

```sh
sbx rm --force <old-name>
sbx create --clone --name <new-name> ./sandbox/coding-kit <main-checkout>
sbx exec <new-name> -- dsh --version   # 0.2.1-rc.2
```
