import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * ISH-1222 — the devcontainer `dind-var-lib-docker-<devcontainerId>` named volume.
 *
 * The docker-in-docker devcontainer feature mounts `/var/lib/docker` from a
 * NAMED volume:
 *
 *     source=dind-var-lib-docker-${devcontainerId}, target=/var/lib/docker
 *
 * `docker rm -v` removes only ANONYMOUS volumes, so this named volume survives a
 * normal devcontainer teardown (the 2–5 GB leak seen on the Ishiul host). Relay
 * does not create the devcontainer, and the feature does not let the caller add
 * labels, so the volume cannot be discovered by `relay.*` labels alone. Instead
 * Relay reproduces the devcontainer CLI's deterministic id from the Run's
 * recorded workspace path + config file. That exact name is the Run's recorded
 * dind volume; cleanup and the leak report use only that name (never a prefix or
 * glob scan), so another project's `dind-var-lib-docker-*` volume is untouched.
 *
 * The algorithm is the one in `@devcontainers/cli`
 * (`getDevContainerId` in `devContainersSpecCLI.js`):
 *
 *   JSON.stringify(idLabels, Object.keys(idLabels).sort())
 *     -> sha256 -> BigInt -> base32 (0-9a-v) -> left-pad to 52 chars
 *
 * `idLabels` is `{ "devcontainer.local_folder": <workspace>,
 * "devcontainer.config_file": <config> }` when the CLI resolved a config file
 * (the default `.devcontainer/devcontainer.json` / `.devcontainer.json`), and
 * `{ "devcontainer.local_folder": <workspace> }` otherwise. Verified against the
 * live Ishiul host: every `dind-var-lib-docker-*` volume left by the
 * `.relay/worktrees/T*` devcontainers resolves exactly with the config-file form.
 */

export const DIND_VOLUME_PREFIX = "dind-var-lib-docker-";

/** The devcontainer CLI's `${devcontainerId}` for one workspace + config pair. */
export function devcontainerId(workspaceFolder: string, configFile?: string | null): string {
  const labels: Record<string, string> = {
    "devcontainer.local_folder": resolve(workspaceFolder),
  };
  if (configFile) labels["devcontainer.config_file"] = resolve(configFile);
  // JSON.stringify's replacer-array form emits ONLY these keys, in this order,
  // exactly like the CLI; it is not a key filter over insertion order.
  const keys = Object.keys(labels).sort();
  const text = JSON.stringify(labels, keys);
  const digest = createHash("sha256").update(text, "utf8").digest();
  return BigInt(`0x${digest.toString("hex")}`).toString(32).padStart(52, "0");
}

/** `dind-var-lib-docker-<devcontainerId>`. */
export function dindVolumeName(devcontainerIdValue: string): string {
  return `${DIND_VOLUME_PREFIX}${devcontainerIdValue}`;
}

function realpathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * The devcontainer config files the CLI resolves for a default
 * `devcontainer up --workspace-folder <workspace>`: the two root locations plus
 * a named config under `.devcontainer/<name>/` (used with `--config`). Only
 * files that ACTUALLY exist produce a candidate; we never guess a path the CLI
 * did not use.
 */
export function devcontainerConfigCandidates(workspaceFolder: string): string[] {
  const root = resolve(workspaceFolder);
  const out: string[] = [];
  for (const rel of [join(".devcontainer", "devcontainer.json"), ".devcontainer.json"]) {
    const path = join(root, rel);
    if (existsSync(path)) out.push(path);
  }
  const containerDir = join(root, ".devcontainer");
  try {
    for (const entry of readdirSync(containerDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(containerDir, entry.name, "devcontainer.json");
      if (existsSync(path)) out.push(path);
    }
  } catch {
    /* no .devcontainer directory: the two root candidates above are all */
  }
  return unique(out);
}

/**
 * Every exact `dind-var-lib-docker-*` volume name a devcontainer for this
 * workspace can have created. Both the logical and physical spellings are
 * tried so a `/tmp` vs `/private/tmp` (or other symlinked) workspace converges.
 *
 * With `recorded: true`, the two default config paths are included even when the
 * workspace/config no longer exists. This is what lets cleanup reclaim the
 * EXISTING leaks of a finished Task: `runs.cwd` records the old worktree path,
 * but the directory (and its config file) was removed by an earlier cleanup —
 * the devcontainer id is still the pure hash of that recorded path + config.
 * The names remain exact, and the path is a Relay-owned per-Task worktree, so
 * another project's volume cannot collide. Without `recorded` (the fixture
 * contract), only configs that actually exist produce a candidate.
 */
export function dindVolumeNamesForWorkspace(
  workspaceFolder: string,
  opts: { recorded?: boolean } = {}
): string[] {
  const root = resolve(workspaceFolder);
  const configs = unique([
    ...devcontainerConfigCandidates(root),
    ...(opts.recorded
      ? [join(root, ".devcontainer", "devcontainer.json"), join(root, ".devcontainer.json")]
      : []),
  ]);
  if (configs.length === 0) return [];
  const workspaces = unique([root, realpathOf(root)]);
  const configForms = unique(configs.flatMap((c) => [resolve(c), realpathOf(c)]));
  const out: string[] = [];
  for (const workspace of workspaces) {
    for (const config of configForms) {
      out.push(dindVolumeName(devcontainerId(workspace, config)));
    }
  }
  return unique(out);
}
