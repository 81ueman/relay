/**
 * The explicit child-process environment boundary.
 *
 * The coding runners must NOT hand the whole host `process.env` to a child. A
 * dsh Run is a coding agent with write access to its workspace, so an unrelated
 * host variable (a secret, a CI token, a proxy credential) must not leak into it
 * by default.
 *
 * Only the variables a process actually needs to start — the executable search
 * path, the home dir (dsh's credential/config store lives under it), the terminal
 * locale, and the SSH agent socket — are inherited. Everything else is opt-in via
 * the caller's explicit `env` (which is how an operator injects a provider key or
 * a model overlay).
 */
export const CHILD_ENV_ALLOWLIST = [
  // Process startup / shell.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TMPDIR",
  // Locale.
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  // SSH agent forwarding (Git over the forwarded agent; never a key file).
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  // dsh configuration.
  "DSH_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  // Relay's own attribution/fencing vars may be needed by wrappers.
  "RELAY_DB",
  "RELAY_SOCK",
] as const;

/**
 * Build a child environment from the allowlist, then merge the caller's explicit
 * values on top. `env` always wins, so a caller can inject a provider key.
 */
export function childEnv(
  env: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {}
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of CHILD_ENV_ALLOWLIST) {
    const v = env[k];
    if (typeof v === "string") out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) out[k] = v;
  return out;
}
