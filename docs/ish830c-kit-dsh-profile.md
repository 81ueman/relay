# ISH-830c — the Coding Sandbox `headless` profile resolves `ollama-cloud`

**Issue:** [ISH-830](https://linear.app/ishiul/issue/ISH-830) (follow-up).
**Kind:** kit provision + evidence record. Follow-up to PR #20/#21: the host
`provider` leg was PASS but the `factory` leg was BLOCKED because the Run's dsh
(inside the Coding Sandbox) resolved the shipped `deepseek-official` route.

## Goal

Make the Coding Sandbox's `dsh --profile headless` resolve the **`ollama-cloud`**
provider with `apiKeyEnv: OLLAMA_CLOUD_V41_API_KEY` and
`model: deepseek-v4.1-flash:1017`, so the operator's `sbx` credential proxy
authenticates the Run. No `DEEPSEEK_API_KEY` and no secret value in the repo or
the sandbox filesystem.

## What ships

The Coding Kit gains the sandbox user's dsh `headless` profile
(`sandbox/coding-kit/files/home/.dsh/profiles/headless/` → `$DSH_HOME/profiles/headless`):

- `cordis.yml` (empty entry list), `package.json`
  (`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless`), `pnpm-workspace.yaml`;
- `cordis.patch.yml` declaring the provider **explicitly**:

  ```yaml
  - id: llm-pi-ai
    name: "@deepseek-ai/dsh-llm-pi-ai"
    config:
      providers:
        ollama-cloud:
          apiKeyEnv: OLLAMA_CLOUD_V41_API_KEY
          api: openai-completions
          baseURL: https://ollama.com/v1
          models:
            - id: deepseek-v4.1-flash:1017
              name: DeepSeek V4.1 Flash
  - id: agent-default-model
    name: "@deepseek-ai/dsh-agent-default-model"
    config:
      provider: ollama-cloud
      model: deepseek-v4.1-flash:1017
  ```

The explicit endpoint/model are required because the pinned
`@deepseek-ai/dsh@0.2.1-rc.2` **npm** build ships no `ollama-cloud` catalog of its
own (see below). No key value and no `secrets:` block is added. `PINNED_DSH_VERSION`
stays `0.2.1-rc.2`.

The ISH-830 harness `factory` stage now creates its Task sandbox from this Kit
(`scripts/ish830-real-e2e.ts`), so the in-sandbox Run uses the profile. For real
runs, point Relay at the kit:
`RELAY_SANDBOX_AGENT=sandbox/coding-kit relay run sandbox launch <task>`.

## Why not the shiguredo fork (measured, rejected)

The host's `dsh` is the **shiguredo fork** of `deepseek-harness`
(`git@github.com:shiguredo/deepseek-harness`, public), which bundles the
`ollama-cloud` catalog. Three routes to put the fork in the sandbox were measured
and rejected:

| route | measured | blocker |
| --- | --- | --- |
| `sbx cp` the host (darwin) fork | `38.3s`, `2.5G`; `node apps/cli/lib/bin.js --version` → `0.2.1-rc.2` | the headless Run dies on a missing **linux-arm64** native addon (`node-addon-require-builtin/build/napi/napi-v9-linux-arm64-gnu/require_builtin.node`): the host `node_modules` carries darwin binaries only |
| clone + build in the kit `install:` | clone `8.7s`/`217M`; full `pnpm install --frozen-lockfile` `45.8s`/`2.3G`; `tsc -b tsconfig.host.json` **OOM** | 4 GiB sandbox: default V8 heap (~2 GiB) OOMs; even `--max-old-space-size=3072` peaked at **3974/3989 MiB** and was killed. The Debian Node has no TypeScript type stripping (`process.features.typescript=false`), which the fork's `pnpm build` requires. And kit `install:` steps run **per `sbx create`** (3 probe creates all re-ran; `sbx kit builder status` = *not created*), so the build would repeat every time |
| ship a prebuilt fork artifact in `files/` | fork tree `2.3G` | far too large for the repo |

The fork was only a means to the `ollama-cloud` catalog; declaring the provider
explicitly reaches the same end with the pinned, Linux-correct official build.

## Evidence (raw)

`sbx kit validate sandbox/coding-kit`:

```
  ✓ sandbox/coding-kit — valid (directory)
```

A **fresh** sandbox created from the Kit (`sbx create --clone --name
relay-ish830c-ev ./sandbox/coding-kit <repo>`; per-sandbox create `1:34.47`):

```
$ sbx exec relay-ish830c-ev -- bash -lc 'command -v dsh; dsh --version'
/usr/local/share/npm-global/bin/dsh
0.2.1-rc.2

$ dsh --profile headless --dump-config | grep -A9 llm-pi-ai
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      ollama-cloud:
        apiKeyEnv: OLLAMA_CLOUD_V41_API_KEY
        api: openai-completions
        baseURL: https://ollama.com/v1
        models:
          - id: deepseek-v4.1-flash:1017
            name: DeepSeek V4.1 Flash

$ dsh --profile headless --json "reply with the single token PING"
{"type":"session","sessionId":"session-14d442a5-36f5-4475-9a06-3296d3c16f9f","cwd":"/tmp/relay-ish830c-ev-97TF/repo"}
{"type":"status","phase":"turn_start","turn":1}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"text","text":"PING"}
{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":393,"outputTokens":4,"totalTokens":5901,"cacheReadTokens":5504}}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"PING"}
EXIT=0
```

The credential is the operator's **global** `sbx` custom secret (target
`ollama.com`, env `OLLAMA_CLOUD_V41_API_KEY`); the sandbox sees only its
`sbx-cs-…` placeholder. No key value is read or printed here.

### Harness `provider,factory`

With the Shared-Lab API unset, the `factory` leg is skipped (it needs the Lab):

```
$ RELAY_ISH830_E2E=1 ISH830_STAGES=provider,factory bun scripts/ish830-real-e2e.ts
  PASS     provider: real dsh/DeepSeek replied PING
  BLOCKED  lab: LABCTL_API is unset; the Shared-Lab legs (nos/parallel/factory) are skipped
counts: {"PASS":1,"BLOCKED":1}
```

To exercise the in-sandbox dsh leg without the real Lab, the `factory` stage was
run against an unreachable API (`LABCTL_API=https://127.0.0.1:9`). The dsh
**IMPLEMENT** Run now exits **0** and produces a HEAD — no `deepseek-official`
error — and the factory then blocks only on the missing Shared-Lab credentials:

```
$ RELAY_ISH830_E2E=1 ISH830_STAGES=factory LABCTL_API=https://127.0.0.1:9 \
    bun scripts/ish830-real-e2e.ts
  PASS     lab.warm: Shared Lab clab-api-server is ready
  PASS     lab.keepalive: started a keep-alive exec session on the Shared Lab VM
  BLOCKED  factory: real factory is BLOCKED on Shared-Lab credentials (owner prerequisite), not on the provider route:
             runFactoryTask(T1) -> blocked (head 97be0ea5c8ce); run run-2d59e9e5 submitted exit 0
  PASS     factory.read-only: merged_at=null accepted_at=null pr_url=null (MergeReady is read-only)
  BLOCKED  factory.lab-cleanup: destroy … exit 2: labctl: no LABCTL_TOKEN and no LABCTL_USER/LABCTL_PASSWORD credentials provided
  PASS     factory.sandbox-cleanup: sandbox relay-ish-830-factory-1f93603d removed
counts: {"PASS":4,"BLOCKED":2}
```

The Run's own report confirms the dsh leg: it wrote and committed `DONE.md`
(`44baaf7`) and committed the check fix (`97be0ea`), then reported that the
REQUIRED NOS check could not authenticate because `~/.labctl.env` is empty —
"the remaining blocker is harness credential injection, not connectivity or
script syntax." The harness records that as **BLOCKED** (`MISSING_LAB_CREDS`),
never a PASS.

## Gates

```sh
bun run typecheck          # tsc --noEmit -> exit 0
bun test                   # 1038 pass, 1 skip, 0 fail (73 files)
sbx kit validate sandbox/coding-kit   # valid
```

`formal/` is untouched, so no TLC run is required (AGENTS.md).

## Not verified / follow-ups

- The full factory chain (dsh IMPLEMENT → SR Linux VERIFY → Claude FIX → fresh
  dsh → re-VERIFY → Claude PASS → MergeReady): needs the Shared-Lab API
  credentials (and an Anthropic credential for the reviewer). BLOCKED here.
- **Owner prerequisite:** the `ollama-cloud` secret must be **global** and the
  sandbox created **after** it. A sandbox-scoped secret does not reach a new
  sandbox.
- A sandbox created before this profile must be recreated (the profile is copied
  at create time).
