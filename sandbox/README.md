# `sandbox/` — Docker Sandboxes artifacts

Declarative [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) kit artifacts
used to run Ishiul work in an isolated microVM. This is **not** the containerlab
lab tree ([`../labs/`](../labs/README.md)) and not the dind devcontainer
([`../.devcontainer/`](../.devcontainer/devcontainer.json)): it is the *coding*
sandbox an agent works in, with no NOS image and no inner containerlab.

## `coding-kit/` (ISH-827)

A `schemaVersion: "2"`, `kind: sandbox` kit that forks the built-in `shell`
agent (`extends: shell`) and adds only the Ishiul development tools:

- `dsh` `0.2.0-rc.2` (`@deepseek-ai/dsh`) for headless Runs;
- the Rust/Cargo toolchain (rustup, minimal stable) with `build-essential`,
  `pkg-config` and `protoc`;
- Python with `PyYAML` and `uv`;
- `/usr/local/bin/labctl`, installed from the checked-out workspace
  ([`../labs/labctl/labctl.py`](../labs/labctl/README.md) — no second copy);
- a focused network allowlist (npm/rust/crates/PyPI, GitHub, `api.deepseek.com`)
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

Full measured evidence, resource tuning and unmet limits:
[`../research/design/ish827-coding-kit-evidence.md`](../research/design/ish827-coding-kit-evidence.md).
