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

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, "utf-8").trim().length > 0) return true;
    await Bun.sleep(25);
  }
  return false;
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
        // arrive mid-command, not before the first Task starts).
        if (!(await waitForFile(marker, 8000))) {
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
        // The bound is independent of N and far below the 30s command timeout.
        expect(elapsed).toBeLessThan(5000);
        expect(outcome).toBe(0);
        expect(err).toContain("daemon stopped");

        // BETWEEN-TASKS interruption: only the FIRST bound Task's read started.
        const polled = readFileSync(marker, "utf-8").trim().split("\n").filter(Boolean);
        expect(polled).toHaveLength(1);
        expect(polled[0]).toContain("pr view");
      } finally {
        if (!proc.killed) proc.kill("SIGKILL");
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
    25000
  );
});
