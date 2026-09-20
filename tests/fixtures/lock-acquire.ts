// Test fixture: race several processes for one control-plane lock.
//
// All participants busy-wait until START_AT (ms epoch) so their `acquireLock`
// calls land at the same instant. Prints `ACQUIRED <token>` or `REJECTED <err>`.
import { acquireLock } from "../../src/singleton";

const lockPath = process.env.LOCK_PATH!;
const dbPath = process.env.LOCK_DB ?? "";
const startAt = Number(process.env.START_AT ?? "0");
const holdMs = Number(process.env.HOLD_MS ?? "800");

while (Date.now() < startAt) await Bun.sleep(1);

try {
  const handle = await acquireLock(lockPath, { dbPath });
  console.log(`ACQUIRED ${handle.token}`);
  await Bun.sleep(holdMs);
  handle.release();
  process.exit(0);
} catch (e) {
  console.log(`REJECTED ${String(e)}`);
  process.exit(3);
}
