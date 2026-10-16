/**
 * ISH-808: stop a Run's process GROUP by pid.
 *
 * A Run is a `dsh --profile headless` process; signalling only the leader can
 * leave its children writing in the Task's worktree, so we SIGTERM the whole
 * group (`-pid`) and fall back to the bare pid when a negative-pid group kill is
 * not permitted or the group is already gone.
 *
 * Shared so `relay run cancel` and `relay task cancel` stop a writer the SAME
 * way. Rewriting only the Run ROW would leave the process alive and writing while
 * the single-writer fence / workspace-cleanup guards treat the writer as gone.
 */
export function signalRunProcess(
  pid: number | null | undefined,
  signal: NodeJS.Signals = "SIGTERM"
): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false; // already gone
    }
  }
}
