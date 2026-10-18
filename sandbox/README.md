# `sandbox/` — Docker Sandboxes artifacts

Declarative [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) kit artifacts
used to run Ishiul work in an isolated microVM. This is **not** the Ishiul containerlab
lab tree ([`ishiul labs/`](https://github.com/81ueman/ishiul/blob/main/labs/README.md))
and not the dind devcontainer
([`ishiul .devcontainer/`](https://github.com/81ueman/ishiul/blob/main/.devcontainer/devcontainer.json)):
it is the *coding* sandbox an agent works in, with no NOS image and no inner containerlab.

## `coding-kit/` (ISH-827)

A `schemaVersion: "2"`, `kind: sandbox` kit that forks the built-in `shell`
agent (`extends: shell`) and adds only the Ishiul development tools:

- `dsh` `0.2.1-rc.2` (`@deepseek-ai/dsh`, the official npm pin) for headless
  Runs, with a `headless` profile that defaults to the **`ollama-cloud`** pi-ai
  provider (`files/home/.dsh/profiles/headless/`, ISH-830c). Because the pinned
  npm build ships no `ollama-cloud` catalog, the provider is declared
  **explicitly** — an OpenAI-compatible endpoint
  (`api: openai-completions`, `baseURL: https://ollama.com/v1`) plus the
  `deepseek-v4.1-flash:1017` model — and names only the credential
  (`OLLAMA_CLOUD_V41_API_KEY`). There is **no** key value and **no** `secrets:`
  block in the kit. The credential is the operator's `sbx` **credential proxy** —
  a custom secret (target `ollama.com`, env `OLLAMA_CLOUD_V41_API_KEY`) whose host
  command yields the real key; the sandbox sees only a placeholder. **Owner
  prerequisite:** store the secret at **global** scope and create the sandbox
  **after** it (`sbx secret set-custom` without `--sandbox`); without it a
  headless Run fails closed with `MISSING_CREDENTIAL` for `ollama-cloud`;
- the Rust/Cargo toolchain (rustup, minimal stable) with `build-essential`,
  `pkg-config` and `protoc`;
- Python with `PyYAML` and `uv`;
- `/usr/local/bin/labctl`, installed from the checked-out Ishiul workspace
  ([`ishiul labs/labctl/labctl.py`](https://github.com/81ueman/ishiul/blob/main/labs/labctl/README.md)
  — no second copy);
- the pinned `gnmic` `0.49.0` gNMI client (`/usr/local/bin/gnmic`, Linux aarch64),
  for real gNMI read-backs against a Shared-Lab node's published `:57400`;
- the `network-lab` agent skill (ISH-845), installed at the dsh **user skill**
  path `~/.agents/skills/network-lab/SKILL.md` (`files/home/.agents/skills/`).
  This is the path the pinned `dsh 0.2.1-rc.2` actually scans
  (`@deepseek-ai/dsh-skill-filesystem` → `FileSystemSkillProvider.roots`,
  `$AGENTS_HOME/skills`). It is a *Sandbox* skill — separate from Relay's
  OpenCode Gateway skills (`~/.config/opencode/skills`) and from the legacy
  Herdr attached Coding Worker skills. The skill is a byte-for-byte copy of
  [`skills/network-lab/SKILL.md`](../skills/network-lab/SKILL.md); it tells the
  agent to deploy an arbitrary containerlab topology with `labctl`, pinned to the
  task's `RELAY_LAB_OWNER`;
- a focused network allowlist (npm/rust/crates/PyPI, GitHub, `api.deepseek.com`,
  `ollama.com`)
  and the Shared Lab's **fixed host ports** (`host.docker.internal:49170` API,
  `:18002` gNMI — never a bare host), plus an SSH config that routes GitHub to
  `ssh.github.com:443` (the sandbox policy has no `:22` rule).

Egress is the **operator's global policy ∪ the kit's allowlist** (on this host a
Balanced `local-policy`), not the kit alone — the kit adds only what Ishiul work
needs. Pin the Shared Lab publishes to the ports above (`sbx ports … --publish
0.0.0.0:49170:8090`); add any further node-management port per deployment with
`sbx policy allow network --sandbox <name> host.docker.internal:<port>`.

Validate and inspect it with the official CLI (kits are experimental):

```sh
sbx kit validate sandbox/coding-kit
sbx kit inspect  sandbox/coding-kit
```

Run it against a **main checkout** (clone mode; never a linked worktree):

```sh
sbx create --clone --name my-task ./sandbox/coding-kit /path/to/ishiul
```

The sandbox gets a private writable clone; host personal files, other repos and
the host Docker socket are not visible. Sandbox commits come back with
`git fetch sandbox-my-task` on the host.

A headless Run only resolves `ollama-cloud` when the same sandbox is **created
from this kit** — Relay's `ensureTaskSandbox` defaults its agent to `shell`
(`$RELAY_SANDBOX_AGENT`), which has no `dsh` profile. Point it at the kit:

```sh
RELAY_SANDBOX_AGENT="$PWD/sandbox/coding-kit" relay run sandbox launch <task-id>
```

The ISH-830 harness (`scripts/ish830-real-e2e.ts`) hardcodes the Coding Kit for
its `factory` stage for the same reason.

Full measured evidence, resource tuning and unmet limits:
[`docs/ish-827-coding-kit/evidence.md`](../docs/ish-827-coding-kit/evidence.md).

## Pre-building / caching the kit template (measured, sbx v0.48.0)

The kit's `setup.install:` steps (npm `dsh`, apt `build-essential`/`protoc`,
rustup, `uv`, `gnmic`) run on **every** `sbx create` from the kit. That is what
makes a cold create slow and egress-dependent. KIT-PREBUILD set out to build the
kit's install layers **once** and have later creates reuse them; this section
records what `sbx v0.48.0` on this host actually does, so the steps are not
re-derived. Numbers are host-measured, 2026-10-18 (10 CPU / 32 GiB, macOS arm64);
raw host egress was healthy (npm/apt/rustup/GitHub/astral all `200`).

### Measured: source-form `sbx create` does not reuse a warm cache

```sh
time sbx create --clone --name relay-kitpre-cold ./sandbox/coding-kit /path/to/ishiul
time sbx create --clone --name relay-kitpre-warm ./sandbox/coding-kit /path/to/ishiul
```

| create (source-form kit) | wall | daemon `POST /sandbox` |
| --- | --- | --- |
| 1st (cold) | `239s` | `235s` |
| 2nd (warm) | `201s` | `197s` |

Both creates installed the toolchain again (the sandbox ends with `dsh 0.2.1-rc.2`,
`cargo`, `gnmic`, `uv`). For reference, the recorded ISH-830c baseline was
`1:34`/create ([`docs/ish830c-kit-dsh-profile.md`](../docs/ish830c-kit-dsh-profile.md)).

### The shared kit builder is **not** populated by this kit

```console
$ sbx kit builder status
  Builder:       sbx-kit-builder (running)
  Build cache:   engine store volume; `sbx kit builder rm` reclaims it
  Kit registry:  127.0.0.1:5411 — reachable
$ sbx kit builder history ls
BUILD ID   NAME      STATUS    CREATED AT   DURATION        # (empty)
$ sbx exec sbx-kit-builder -- docker system df
Build Cache     0         0         0B           0B
$ sbx template ls
docker.io/docker/sandbox-templates  shell-docker  …            # no kit template
```

A source-form build runs the kit `install:` commands as a **container-start
hook inside the new sandbox** (`started hook: kit "ishiul-coding":
commands.install[0] (npm i -g …)`), not as a cached builder layer — so the
builder's engine store stays empty and warm ≈ cold. This matches ISH-830c's
earlier finding that the `install:` steps run per `sbx create`. A failed apply
exits with `error: failed to apply kit to sandbox`; the concrete step and its
captured output are in the daemon log
(`~/Library/Application Support/com.docker.sandboxes/sandboxes/sandboxd/daemon.log`).

### Reclaim / rebuild

`sbx kit builder rm` (add `--force` to skip the prompt) removes the builder
sandbox **and its engine-store build cache**; the next source-form build
recreates it. `sbx kit builder history rm …` prunes individual build records.

### Pin the kit as an OCI artifact (local registry)

```sh
sbx kit pack ./sandbox/coding-kit -o dist/ishiul-coding.zip
sbx kit push ./sandbox/coding-kit 127.0.0.1:5411/ishiul/coding-kit:0.1.0
```

The local kit registry `127.0.0.1:5411` serves **plain HTTP**, while `sbx kit
push` talks HTTPS, so the push fails closed here:

```console
error: push config blob: Post "https://127.0.0.1:5411/v2/ishiul/coding-kit/blobs/uploads/":
       http: server gave HTTP response to HTTPS client
```

Pin against a TLS registry (or put a TLS terminator in front of the local one).
Pinning pins the *artifact*; it does not by itself pre-build the install layers.

### Pre-build via the platform template cache (the working fast path)

Snapshot a sandbox that already has the toolchain, then create from the
snapshot instead of re-running the kit install:

```sh
# once, after a source-form create (slow): snapshot the built sandbox
# (`sbx template save` asks for confirmation; run it on a TTY)
sbx template save <built-sandbox> ishiul-coding:prebuilt-0.1.0

# every later create: boot the snapshot, no kit install
sbx create --clone --name my-task -t ishiul-coding:prebuilt-0.1.0 shell /path/to/ishiul
# or, without clone: sbx run --pull never -t ishiul-coding:prebuilt-0.1.0 shell
```

`--pull never` is implicit for a locally saved snapshot. Re-snapshot after a kit
`files/**` or `install:` change; `sbx template rm ishiul-coding:prebuilt-0.1.0`
reclaims the snapshot.

Measured on this host (`sbx v0.48.0`):

| step | wall |
| --- | --- |
| `sbx template save relay-kitpre-cold ishiul-coding:prebuilt-0.1.0` (one-off) | `4m8s` |
| `sbx create --clone -t docker.io/library/ishiul-coding:prebuilt-0.1.0 shell <repo>` | **`6s`** |

The snapshot create is `239s → 6s` (≈40×). The created sandbox was verified to
carry the toolchain without any kit install: `dsh 0.2.1-rc.2`, `cargo 1.99.1`,
`uv 0.9.26`, `gnmic 0.49.0`, `~/.agents/skills/network-lab`, and the headless
`ollama-cloud` profile.

**Caveats.** The snapshot is a *point-in-time filesystem*: a kit `install:` change
needs a re-snapshot, and the kit `startup:` hook (labctl installed from the
workspace checkout) does **not** run when creating from the snapshot — for a
workspace that needs it, install it explicitly or create from the kit. The
snapshot is host-local (not shareable across hosts without
`sbx template save --output` + `sbx template load`).
