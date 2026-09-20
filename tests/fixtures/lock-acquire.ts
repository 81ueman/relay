// Test fixture: race several processes for one SQLite supervisor lock.
//
// All participants busy-wait until START_AT (ms epoch) so their
// `acquireSupervisorLock` calls land at the same instant. Prints `ACQUIRED` or
// `REJECTED <err>`.
import { acquireSupervisorLock } from "../../src/singleton";

const dbPath = process.env.LOCK_DB!;
const startAt = Number(process.env.START_AT ?? "0");
const holdMs = Number(process.env.HOLD_MS ?? "800");

while (Date.now() < startAt) await Bun.sleep(1);

try {
  const lock = acquireSupervisorLock(dbPath);
  console.log("ACQUIRED");
  await Bun.sleep(holdMs);
  lock.release();
  process.exit(0);
} catch (e) {
  console.log(`REJECTED ${String(e)}`);
  process.exit(3);
}
