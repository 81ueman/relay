import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { intakeTask, findTaskResult } from "../src/workflow";
import { startDshRun } from "../src/dsh-runner";
import { readDshEvents } from "../src/dsh-events";

// ISH-803 / ISH-810 real local dsh smoke. OFF by default (it spawns the real
// `dsh --profile headless --json`, which calls the configured LLM provider — no
// GitHub / Linear mutation, but still network + credentials). Run it explicitly:
//
//   RELAY_DSH_SMOKE=1 bun test tests/dsh-smoke.test.ts
//
// It proves the pinned 0.2.0-rc.2 CLI contract end to end: the process runs in
// the Task worktree without Herdr, stdout is the dsh `--json` JSONL, a real tool
// call + result are captured as per-Run evidence, a Session ID is recognized, and
// a clean exit 0 still does NOT submit the Task.

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
    "runs one dsh --json process, recognizes the session + ordered events + a tool call",
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "relay-dsh-smoke-wt-"));
      writeFileSync(join(cwd, "note.txt"), "hello-from-file\n");
      const task = intakeTask(db, {
        provider: "smoke",
        issueId: "ISH-810",
        codeChange: true,
        title: "smoke",
        worktree: cwd,
      });
      const h = await startDshRun(db, {
        taskId: task.id,
        outputRoot: join(dir, "runs"),
        timeoutMs: 240_000,
        fastExitMs: 0,
        prompt:
          "Read the file note.txt in the current directory using your read tool, then reply with " +
          "exactly the token SMOKE_OK followed by the file's contents.",
      });
      const run = await h.wait();
      expect(run.state).toBe("exited");
      expect(run.exit_code).toBe(0);
      expect(run.session_id === null || /^session-/.test(run.session_id)).toBe(true);

      const events = readDshEvents(run.dsh_events_path!);
      const types = events.map((e) => e.event.type);
      expect(types[0]).toBe("session"); // ordered: an initial session event
      expect(types[types.length - 1]).toBe("final"); // terminal final
      expect(types).toContain("tool_call"); // a real tool call …
      expect(types).toContain("tool_result"); // … and its result are identifiable

      const out = readFileSync(run.stdout_path!, "utf-8");
      expect(out.trim().length).toBeGreaterThan(0);
      // eslint-disable-next-line no-console
      console.log(
        `smoke: run=${run.id} session=${run.session_id} events=${types.length} ` +
          `tools=${types.filter((t) => t === "tool_call").length} dsh=${run.dsh_events_path}`
      );
      // exit 0 alone must NOT advance the task.
      expect(findTaskResult(db, task.id, "implement", 0, "TaskSubmitted")).toBeNull();
    },
    300_000
  );
});
