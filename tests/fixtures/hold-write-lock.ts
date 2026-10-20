// ISH-995 test fixture: hold the control-plane writer lock from a SECOND
// process/connection while the test's connection attempts a structured result
// write. It prints LOCKED only AFTER `BEGIN IMMEDIATE` has acquired the lock, so
// the parent never races the acquisition, then releases it after HOLD_MS.
import { Database } from "bun:sqlite";

const dbPath = process.env.HOLD_DB;
if (!dbPath) throw new Error("HOLD_DB is required");
const holdMs = Number(process.env.HOLD_MS ?? "150");

const db = new Database(dbPath);
try {
  db.exec("PRAGMA busy_timeout = 0;");
  db.exec("BEGIN IMMEDIATE;");
  console.log("LOCKED");
  await Bun.sleep(holdMs);
  db.exec("ROLLBACK;");
} finally {
  db.close();
}
