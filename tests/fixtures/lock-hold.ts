// Test fixture: acquire the supervisor lock and hold it until killed.
//
// Writes READY_FILE once holding so the parent can synchronize, then blocks
// forever. Used to prove that SIGKILL releases the SQLite writer lock.
import { writeFileSync } from "node:fs";
import { acquireSupervisorLock } from "../../src/singleton";

const dbPath = process.env.LOCK_DB!;
const readyFile = process.env.READY_FILE!;

acquireSupervisorLock(dbPath); // throws -> nonzero exit if contended
writeFileSync(readyFile, "HOLDING");
await new Promise(() => {});
