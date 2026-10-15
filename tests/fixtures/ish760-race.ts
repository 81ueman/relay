/**
 * ISH-760 fixture: ONE process that races to become the single writer for a Task
 * worktree via `startDshRun`. The parent test spawns TWO of these against the
 * same RELAY_DB and asserts exactly one is ADMITTED. Deliberately NOT a
 * `*.test.ts` file (tests/fixtures/* is not collected by `bun test`).
 *
 * Env: RELAY_DB, TASK_ID, WORKTREE, OUTPUT_ROOT, DSH_BIN, GO_AT (epoch ms start
 * barrier so both processes hit the guard at the same instant).
 */
import { openDb } from "../../src/db";
import { startDshRun } from "../../src/dsh-runner";

const db = openDb(process.env.RELAY_DB!);
const goAt = Number(process.env.GO_AT ?? "0");
const wait = goAt - Date.now();
if (wait > 0) await Bun.sleep(wait);

try {
  const h = await startDshRun(db, {
    taskId: process.env.TASK_ID!,
    cwd: process.env.WORKTREE!,
    outputRoot: process.env.OUTPUT_ROOT!,
    dshBin: process.env.DSH_BIN!,
    fastExitMs: 0,
  });
  console.log(`ADMITTED ${h.id}`);
  const r = await h.wait();
  console.log(`ENDED ${r.state}`);
} catch (e) {
  console.log(`REFUSED ${e instanceof Error ? e.message : String(e)}`);
} finally {
  db.close();
}
