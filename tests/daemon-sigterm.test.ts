import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  dir = mkdtempSync(join(tmpdir(), "relay-ish1125-sigterm-"));
});

afterEach(() => {
  db?.close();
  db = null;
  rmSync(dir, { recursive: true, force: true });
});

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, "utf-8").trim().length > 0) return true;
    await Bun.sleep(25);
  }
  return false;
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
          // Keep the test fast while still proving the bound is what releases
          // the blocked reconcile: the default (5s) would be too slow here.
          RELAY_PROVIDER_EXEC_TIMEOUT_MS: "400",
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
        // arrive while the poll is in flight, not before it starts).
        const polled = await waitForFile(marker, 5000);
        if (!polled) {
          proc.kill("SIGKILL");
          const err = await stderrP;
          throw new Error(`daemon never reached the provider poll.\nstderr:\n${err}`);
        }

        const started = Date.now();
        proc.kill("SIGTERM");
        const outcome = await Promise.race([
          proc.exited,
          Bun.sleep(8000).then(() => "timeout" as const),
        ]);
        const elapsed = Date.now() - started;
        if (outcome === "timeout") {
          proc.kill("SIGKILL");
          const err = await stderrP;
          throw new Error(`daemon did not exit within 8s of SIGTERM (elapsed=${elapsed}ms).\nstderr:\n${err}`);
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
        if (!proc.killed) proc.kill("SIGKILL");
      }
    },
    15000
  );
});
