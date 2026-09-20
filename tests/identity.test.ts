import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { findWorkerByPane, resolveWorkerIdentity } from "../src/identity";
import { recordRuntime } from "../src/runtimes";
import { registerWorker, retireWorker } from "../src/workers";

// Which worker is the caller acting as? In a shared checkout .relay/worker-id
// remembers only the LAST registration, so it must never silently outvote the
// caller's own pane.

let dir = "";
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-identity-"));
  db = openDb(join(dir, "state.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Register a worker and attach an ACTIVE runtime on `pane`. */
function placed(id: string, pane: string, role = "worker"): void {
  registerWorker(db, id, { role });
  recordRuntime(db, { workerId: id, generation: 1, runtimeId: pane, paneId: pane, state: "active" });
}

describe("worker identity resolution", () => {
  test("--worker always wins", () => {
    placed("w1", "w50:p1");
    expect(resolveWorkerIdentity({ db, explicit: "w9", paneId: "w50:p1", fileDefault: "w1" })).toBe("w9");
  });

  test("$RELAY_WORKER wins over pane and file", () => {
    placed("w1", "w50:p1");
    expect(resolveWorkerIdentity({ db, envWorker: "w8", paneId: "w50:p1", fileDefault: "w1" })).toBe("w8");
  });

  test("the caller's own pane wins over the shared file default", () => {
    placed("w1", "w50:p1");
    placed("integrator", "w52:p2M");
    // The caller runs in w50:p1 while the shared file says 'integrator'.
    expect(resolveWorkerIdentity({ db, paneId: "w50:p1", fileDefault: "integrator" })).toBe("w1");
    expect(findWorkerByPane(db, "w50:p1")).toBe("w1");
  });

  test("the file default is used only when the pane cannot name a worker", () => {
    placed("w2", "w50:p2");
    // Paneless caller (script/CI): the convenience default still applies.
    expect(resolveWorkerIdentity({ db, fileDefault: "w2" })).toBe("w2");
  });

  test("a file default attached to ANOTHER live pane is refused", () => {
    placed("integrator", "w52:p2M");
    // Caller is in a pane with no worker of its own; borrowing 'integrator'
    // would misattribute notes and break the submit fence.
    expect(() => resolveWorkerIdentity({ db, paneId: "w52:p3H", fileDefault: "integrator" }))
      .toThrow(/refusing to act as 'integrator'.*w52:p2M/);
  });

  test("a file default with no active runtime is allowed (cannot prove a conflict)", () => {
    registerWorker(db, "w3", { role: "worker" }); // registered, never attached
    expect(resolveWorkerIdentity({ db, paneId: "w52:p3H", fileDefault: "w3" })).toBe("w3");
  });

  test("a retired worker's runtime does not claim its pane", () => {
    placed("w4", "w50:p4");
    retireWorker(db, "w4");
    expect(findWorkerByPane(db, "w50:p4")).toBeNull();
    expect(resolveWorkerIdentity({ db, paneId: "w50:p4", fileDefault: "w5" })).toBe("w5");
  });

  test("no identity at all is an error", () => {
    expect(() => resolveWorkerIdentity({ db })).toThrow(/no worker identity/);
  });
});
