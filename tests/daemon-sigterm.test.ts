import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { intakeTask } from "../src/workflow";

// ISH-1125: the daemon reconciles providers SYNCHRONOUSLY, so an un-timed
// read-only `gh` call blocks the whole supervisor loop — including the SIGTERM
// handler. With the provider poll active, SIGTERM must still stop the daemon in
// bounded time: the provider executor kills a hung command after
// RELAY_PROVIDER_EXEC_TIMEOUT_MS and the loop then honours the pending signal.
//
// The test uses a REAL daemon child and a fake `gh` that hangs forever on the PR
// read (never a network call), so a regression FAILS by timing out instead of
// passing silently.

const REPO = "81ueman/relay";

let dir = "";
let db: Database | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(import.meta.dir, ".tmp-ish1125-"));
});

afterEach(() => {
  db?.close();
  db = null;
  rmSync(dir, { recursive: true, force: true });
});

// HARNESS GUARD, not the property under test. The runner timeout below is 60s;
// this internal deadline sits under it so a wedged daemon is SIGKILLed and the
// failure is reported with stderr instead of leaking the child and leaving the
// 25ms poll running until the runner abandons the test body.
const WAIT_FOR_POLL_HARNESS_DEADLINE_MS = 50_000;

/**
 * Wait until the daemon is INSIDE the hanging provider read.
 *
 * This is STARTUP, not the property under test. The full suite runs many files
 * in parallel and a loaded host can take arbitrarily long to schedule the
 * daemon child and exec the fake `gh`; the old fixed 5s wait measured that
 * spawn time and failed here (at ~5014ms) while the daemon was healthy. So
 * startup gets no ASSERTION budget: the shutdown bound asserted later is
 * measured from SIGTERM delivery, never from spawn.
 *
 * There is still a harness guard: WAIT_FOR_POLL_HARNESS_DEADLINE_MS (50s, below
 * the 60s runner timeout) SIGKILLs the child and throws with stderr. That is
 * harness liveness only; it does not tighten or measure the shutdown bound.
 *
 * The wait fails fast when the child dies before the poll is ready, whether it
 * exited normally (`exitCode`) or was killed by a signal (`signalCode`, e.g.
 * OOM/SIGKILL); both report stderr.
 */
async function waitForPoll(
  proc: Bun.Subprocess,
  marker: string,
  stderrP: Promise<string>
): Promise<void> {
  const startedAt = performance.now();
  for (;;) {
    if (existsSync(marker) && readFileSync(marker, "utf-8").trim().length > 0) return;
    if (proc.exitCode !== null || proc.signalCode !== null) {
      const err = await stderrP;
      const how = proc.signalCode !== null ? `signal ${proc.signalCode}` : `code ${proc.exitCode}`;
      throw new Error(`daemon exited (${how}) before reaching the provider poll.\nstderr:\n${err}`);
    }
    if (performance.now() - startedAt >= WAIT_FOR_POLL_HARNESS_DEADLINE_MS) {
      proc.kill("SIGKILL");
      const err = await stderrP;
      throw new Error(
        `daemon did not reach the provider poll within the 50s harness deadline; SIGKILLed.\nstderr:\n${err}`
      );
    }
    await Bun.sleep(25);
  }
}

describe("ISH-1125: daemon shutdown with the provider poll enabled", () => {
  test(
    "SIGTERM stops the daemon within a bounded time even while a provider poll is hung",
    async () => {
      // A DB with one provider-bound task: the poll will read its PR.
      const dbPath = join(dir, "state.db");
      db = openDb(dbPath);
      intakeTask(db, {
        provider: "test",
        issueId: "ISH-1125-SIGTERM",
        title: "a task whose PR poll hangs",
        codeChange: true,
        prUrl: `https://github.com/${REPO}/pull/60`,
      });
      // ISH-1132: no live Run and not in review would make the Task ineligible
      // for a provider poll; put this fixture in review so the PR read runs.
      db.query(`UPDATE tasks SET phase = 'review', state = 'review' WHERE issue_id = 'ISH-1125-SIGTERM'`).run();
      db.close();
      db = null;

      // Fake gh: the startup auth probe succeeds; every PR read hangs.
      const binDir = join(dir, "bin");
      mkdirSync(binDir, { recursive: true });
      const marker = join(dir, "gh-polled");
      const gh = join(binDir, "gh");
      writeFileSync(
        gh,
        `#!/bin/sh\n` +
          `if [ "$1" = "auth" ]; then exit 0; fi\n` +
          `printf '%s\\n' "$*" >> "$RELAY_TEST_GH_MARKER"\n` +
          `exec sleep 30\n`
      );
      chmodSync(gh, 0o755);

      const cli = join(import.meta.dir, "..", "src", "cli.ts");
      const proc = Bun.spawn({
        cmd: [process.execPath, cli, "daemon"],
        env: {
          ...process.env,
          RELAY_DB: dbPath,
          RELAY_SOCK: join(dir, "relay.sock"),
          RELAY_RUNTIME: "mock",
          RELAY_PROVIDER_GITHUB: "gh",
          RELAY_INTERVAL_MS: "50",
          // Keep the test fast. 1500ms leaves scheduling headroom for the fake
          // `gh` to write its marker on a loaded test host; ISH-1129's many-task
          // test uses a much longer timeout and proves the shutdown ABORT, not
          // this per-command budget, is what ends the poll.
          RELAY_PROVIDER_EXEC_TIMEOUT_MS: "1500",
          RELAY_TEST_GH_MARKER: marker,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderrP = Bun.readableStreamToText(proc.stderr).catch(() => "");
      const stdoutP = Bun.readableStreamToText(proc.stdout).catch(() => "");

      try {
        // Wait until the daemon is INSIDE the hanging PR read (the signal must
        // arrive while the poll is in flight, not before it starts). Startup has
        // no assertion budget here, only the 50s harness guard: see waitForPoll.
        await waitForPoll(proc, marker, stderrP);

        // The pinned property is SIGNAL DELIVERY -> exit. Daemon spawn and
        // startup time are outside this measurement.
        const signalledAt = performance.now();
        proc.kill("SIGTERM");
        const outcome = await Promise.race([
          proc.exited,
          Bun.sleep(8000).then(() => "timeout" as const),
        ]);
        const elapsed = performance.now() - signalledAt;
        if (outcome === "timeout") {
          proc.kill("SIGKILL");
          const err = await stderrP;
          throw new Error(`daemon did not exit within 8s of SIGTERM (elapsed=${elapsed.toFixed(1)}ms).\nstderr:\n${err}`);
        }
        const err = await stderrP;
        await stdoutP;
        expect(typeof outcome).toBe("number");
        expect(elapsed).toBeLessThan(5000);
        // The daemon stopped cleanly (not a crash exit).
        expect(outcome).toBe(0);
        expect(err).toContain("daemon stopped");
        // The hung read was observed BEFORE the signal: the poll path ran.
        expect(readFileSync(marker, "utf-8")).toContain("pr view");
      } finally {
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }
    },
    // Harness liveness guard only (a wedged child); NOT the shutdown bound.
    // waitForPoll's internal 50s deadline fires first and reports stderr.
    // The 5s assertion above is unchanged and is measured from SIGTERM.
    60000
  );
});
