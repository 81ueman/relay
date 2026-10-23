/**
 * ISH-869 — the ONE pinned dsh build used by the headless Coding Worker.
 *
 * A floating `latest`/`alpha`, a second 0.2.x code path, or an old-version
 * fallback is deliberately NOT introduced. DeepSeek-V4.1-Flash-1017 requires
 * dsh >= 0.2.1-rc.1; Relay pins the 2026-10-17 `0.2.1-rc.2` build.
 */

export const PINNED_DSH_VERSION = "0.2.1-rc.2";

/**
 * True when `version` (a `dsh --version` line, possibly prefixed like
 * `dsh 0.2.1-rc.2`) names EXACTLY `want`. Matching is a whitespace-delimited
 * token, so `0.2.1-rc.20` does NOT match. An old/mismatched build is a failure,
 * not a fallback.
 */
export function isPinnedDsh(version: string | null, want = PINNED_DSH_VERSION): boolean {
  if (!version) return false;
  return version.trim().split(/\s+/).includes(want);
}

/**
 * `dsh --version` (first line) for a host executable, or null when the binary
 * cannot be run / exits non-zero. Used by the `startDshRun` guard.
 */
export function readDshVersion(bin: string): string | null {
  try {
    const p = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) return null;
    const line = (p.stdout?.toString() ?? "").trim().split("\n")[0]?.trim() ?? "";
    return line || null;
  } catch {
    return null;
  }
}
