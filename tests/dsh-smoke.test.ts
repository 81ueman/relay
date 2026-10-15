import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { intakeTask, findTaskResult } from "../src/workflow";
import { startDshRun } from "../src/dsh-runner";

// ISH-803 real local dsh smoke. OFF by default (it spawns the real `dsh
// --profile headless`, which calls the configured LLM provider — no GitHub /
// Linear mutation, but still network + credentials). Run it explicitly:
//
//   RELAY_DSH_SMOKE=1 bun test tests/dsh-smoke.test.ts
//
// It proves the pinned CLI contract end to end: the process runs in the Task
// worktree without Herdr, stdout carries the final text, and a clean exit 0
// still does NOT submit the Task.

const ENABLED = process.env.RELAY_DSH_SMOKE === "1";

let dir = "";
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-dsh-smoke-"));
  process.env.RELAY_DB = join(dir, "state.db");
  db = openDb(process.env.RELAY_DB);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("real dsh headless smoke (opt-in)", () => {
  test.skipIf(!ENABLED)(
    "runs one headless dsh process in the Task worktree and observes exit 0",
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "relay-dsh-smoke-wt-"));
      const task = intakeTask(db, {
        provider: "smoke",
        issueId: "ISH-803",
        codeChange: true,
        title: "smoke",
        worktree: cwd,
      });
      const h = await startDshRun(db, {
        taskId: task.id,
        outputRoot: join(dir, "runs"),
        timeoutMs: 240_000,
        fastExitMs: 0,
        prompt: "Reply with exactly the token SMOKE_OK and nothing else. Do not use any tools.",
      });
      const run = await h.wait();
      expect(run.state).toBe("exited");
      expect(run.exit_code).toBe(0);
      expect(run.session_id === null || /^session-/.test(run.session_id)).toBe(true);
      const out = readFileSync(run.stdout_path!, "utf-8");
      expect(out.trim().length).toBeGreaterThan(0);
      // eslint-disable-next-line no-console
      console.log(`smoke: run=${run.id} stdout=${JSON.stringify(out.trim())} stderr=${run.stderr_path}`);
      // exit 0 alone must NOT advance the task.
      expect(findTaskResult(db, task.id, "implement", 0, "TaskSubmitted")).toBeNull();
    },
    300_000
  );
});
