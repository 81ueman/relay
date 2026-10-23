import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { intakeTask } from "../src/workflow";

// ISH-1129: the provider poll used to run one SYNCHRONOUS `gh` call per bound
// Task, each allowed to burn the full per-command timeout. With N bound Tasks a
// SIGTERM could therefore be delayed by N x timeout: the ishiul daemon (260
// Tasks) needed 20s and then >55s, and was SIGKILLed.
//
// This test uses a REAL daemon child, N=60 PR-bound Tasks and a fake `gh` whose
// PR read hangs (no network). The per-command timeout is set to 30s on purpose:
// only the daemon's shutdown ABORT (and its between-Tasks check) can meet the
// bound. A regression fails by timing out / by polling more than one Task.

const REPO = "81ueman/relay";
const N_TASKS = 60;

let dir = "";
let db: Database | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(import.meta.dir, ".tmp-ish1129-"));
});

afterEach(() => {
  db?.close();
  db = null;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Wait until the daemon is INSIDE the hanging provider read.
 *
 * This is STARTUP, not the property under test, so it deliberately has NO
 * wall-clock budget measured from spawn. The full suite runs many files in
 * parallel and a loaded host can take arbitrarily long to schedule the daemon
 * child and exec the fake `gh`; the old fixed 8s wait measured that spawn time
 * and failed here (at ~8028ms) while the daemon was healthy. The only startup
 * failures are the child exiting before it is ready (reported with its stderr)
 * and the test runner's liveness timeout below. The shutdown bound asserted
 * later is measured from SIGTERM delivery, never from spawn.
 */
async function waitForPoll(
  proc: Bun.Subprocess,
  marker: string,
  stderrP: Promise<string>
): Promise<void> {
  for (;;) {
    if (existsSync(marker) && readFileSync(marker, "utf-8").trim().length > 0) return;
    if (proc.exitCode !== null) {
      const err = await stderrP;
      throw new Error(`daemon exited (code ${proc.exitCode}) before reaching the provider poll.\nstderr:\n${err}`);
    }
    await Bun.sleep(25);
  }
}

describe("ISH-1129: daemon shutdown is bounded by Task count", () => {
  test(
    "SIGTERM during a provider poll over 60 bound Tasks exits promptly and persists no partial link",
    async () => {
      const dbPath = join(dir, "state.db");
      db = openDb(dbPath);
      for (let i = 0; i < N_TASKS; i++) {
        intakeTask(db, {
          provider: "test",
          issueId: `ISH-1129-SIGTERM-${i}`,
          title: `bound PR task ${i}`,
          codeChange: true,
          prUrl: `https://github.com/${REPO}/pull/${1000 + i}`,
        });
      }
      // ISH-1132: the poll only considers a live Run or review/merge_ready/
      // integration. These fixtures have no Run, so put them in review.
      db.query(`UPDATE tasks SET phase = 'review', state = 'review' WHERE provider = 'test'`).run();
      db.close();
      db = null;

      // Fake gh: the startup auth probe succeeds; every PR read records itself
      // and then hangs forever (the 30s executor timeout is the only ceiling).
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
          // Poll every bound Task on every pass (the throttle would hide the loop).
          RELAY_PROVIDER_POLL_MS: "0",
          RELAY_INTERVAL_MS: "50",
          // Deliberately LONG: shutdown must abort the in-flight command, not
          // wait for this budget.
          RELAY_PROVIDER_EXEC_TIMEOUT_MS: "30000",
          RELAY_TEST_GH_MARKER: marker,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderrP = Bun.readableStreamToText(proc.stderr).catch(() => "");
      const stdoutP = Bun.readableStreamToText(proc.stdout).catch(() => "");

      try {
        // Wait until the daemon is INSIDE the provider poll (the signal must
        // arrive mid-command, not before the first Task starts). Startup is
        // unbounded here on purpose: see waitForPoll.
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
        // The bound is independent of N and far below the 30s command timeout.
        expect(elapsed).toBeLessThan(5000);
        expect(outcome).toBe(0);
        expect(err).toContain("daemon stopped");

        // BETWEEN-TASKS interruption: only the FIRST bound Task's read started.
        const polled = readFileSync(marker, "utf-8").trim().split("\n").filter(Boolean);
        expect(polled).toHaveLength(1);
        expect(polled[0]).toContain("pr view");
      } finally {
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }

      // NO PARTIAL WRITE: the aborted read never applied a link/head update and
      // never advanced the poll throttle (`linkTask` itself is transactional).
      db = openDb(dbPath);
      const tasks = db.query(`SELECT * FROM tasks ORDER BY issue_id`).all() as {
        issue_id: string;
        pr_url: string | null;
        pr_repo: string | null;
        branch: string | null;
        head_sha: string | null;
        provider_polled_at: number | null;
      }[];
      expect(tasks).toHaveLength(N_TASKS);
      for (const t of tasks) {
        expect(t.pr_repo).toBeNull();
        expect(t.branch).toBeNull();
        expect(t.head_sha).toBeNull();
        expect(t.provider_polled_at).toBeNull();
      }
    },
    // Harness liveness guard only (a wedged child); NOT the shutdown bound.
    // The 5s assertion above is unchanged and is measured from SIGTERM.
    60000
  );
});
