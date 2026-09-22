import { execFileSync } from "node:child_process";

/**
 * T338: report which revision the RUNNING artifact is.
 *
 * The installed CLI is a BUILD (`~/.local/share/relay/cli.js`), decoupled from
 * the repo source: editing src/ no longer changes the live CLI until a
 * rebuild+reinstall. That makes "which revision am I actually running?"
 * non-obvious, so the build embeds the source commit at build time via
 * `bun build --define BUILD_COMMIT='"<sha>"'` (see scripts/install.sh). Running
 * from source (no define) it falls back to reading git live.
 */

declare const BUILD_COMMIT: string | undefined;
declare const RELAY_VERSION: string | undefined;

/** The CLI version (embedded at build time; "dev" when run from source). */
export function relayVersion(): string {
  try {
    if (typeof RELAY_VERSION === "string" && RELAY_VERSION) return RELAY_VERSION;
  } catch {
    /* not defined when running from source */
  }
  return "dev";
}

/** The commit the artifact was built from, or the live git HEAD when unbundled. */
export function buildCommit(): string | null {
  try {
    if (typeof BUILD_COMMIT === "string" && BUILD_COMMIT && BUILD_COMMIT !== "dev") return BUILD_COMMIT;
  } catch {
    /* not defined when running from source */
  }
  // Running from source: resolve live so `relay --version` still answers.
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      cwd: new URL("..", import.meta.url).pathname,
    }).trim() || null;
  } catch {
    return null;
  }
}

/** Repo HEAD of the checkout the CLI is running from, or null (installed build). */
export function repoHead(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

export function versionLine(version = relayVersion()): string {
  const built = buildCommit();
  return `relay ${version}${built ? ` (build ${built})` : " (build unknown)"}`;
}

/**
 * Warn when the INSTALLED artifact is behind the repo HEAD. Only meaningful when
 * the CLI is run from inside a relay checkout (a repo HEAD is visible) — an
 * installed build run elsewhere has no repo to compare against, so it stays
 * quiet. Returns the warning text, or null.
 */
export function staleBuildWarning(version = relayVersion()): string | null {
  const built = buildCommit();
  const head = repoHead();
  if (!built || !head || built === "dev" || built === head) return null;
  return `relay: warning: installed build ${built} is behind repo HEAD ${head} — rebuild+reinstall: bun run build && cp dist/cli.js ~/.local/share/relay/cli.js`;
}
