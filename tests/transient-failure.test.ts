import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { logEvent } from "../src/events";
import {
  classifyTransientEvidence,
  classifyTransientReviewerFailure,
  classifyTransientRunFailure,
  classifyUnadoptableSession,
  readRunProviderEvidence,
  type TransientRun,
} from "../src/transient-failure";
import {
  DEFAULT_TRANSIENT_BACKOFF_MS,
  DEFAULT_TRANSIENT_MAX_BACKOFF_MS,
  DEFAULT_TRANSIENT_MAX_RESUMES,
  DEFAULT_TRANSIENT_WAIT_MS,
  resolveTransientPolicy,
  waitForProviderRecovery,
} from "../src/transient-recovery";

const dirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "relay-ish1174-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runWith(
  lines: Record<string, unknown>[] | null,
  extra: Partial<TransientRun> & { stderr?: string } = {}
): TransientRun {
  const dir = tmp();
  const dshEvents = join(dir, "dsh.jsonl");
  const stderr = join(dir, "stderr.log");
  writeFileSync(dshEvents, lines ? lines.map((l) => `${JSON.stringify(l)}\n`).join("") : "");
  writeFileSync(stderr, extra.stderr ?? "");
  return {
    id: "run-1",
    state: "failed",
    exit_code: 1,
    signal: null,
    error: null,
    dsh_events_path: dshEvents,
    stderr_path: stderr,
    session_id: null,
    resumed_from_run_id: null,
    resume_count: 0,
    resume_session_id: null,
    ...extra,
  };
}

const SESSION = { type: "session", sessionId: "session-1", cwd: "/tmp/wt" };

describe("ISH-1174: the transient failure class is evidence-derived", () => {
  test("dsh provider HTTP 5xx (structured status) is transient", () => {
    const run = runWith([
      SESSION,
      { type: "status", phase: "turn_end", turn: 1, reason: { kind: "error", error: { status: 500, message: "upstream failed" } } },
    ], { error: "exit 1" });
    const res = classifyTransientRunFailure({ run, error: "CODING_FAILED: run run-1 is 'failed' (exit 1)" });
    expect(res.transient).toBe(true);
    expect(res.cause).toBe("provider_http_5xx");
    expect(res.status).toBe(500);
    expect(res.evidence.join("\n")).toContain("run run-1");
    expect(res.evidence.join("\n")).toContain("status=500");
  });

  test("dsh provider HTTP 429 is transient even though 'too many requests' reads like RESOURCE", () => {
    const run = runWith([
      SESSION,
      { type: "status", phase: "turn_end", reason: { kind: "error", error: { statusCode: 429, message: "Too Many Requests for api key" } } },
    ]);
    const res = classifyTransientRunFailure({ run, error: "CODING_FAILED: exit 1" });
    expect(res.transient).toBe(true);
    expect(res.cause).toBe("provider_http_429");
    expect(res.status).toBe(429);
  });

  test("a connection reset in stderr is transient", () => {
    const run = runWith([SESSION], { stderr: "fetch failed: read ECONNRESET\n" });
    const res = classifyTransientRunFailure({ run, error: "CODING_FAILED: exit 1" });
    expect(res.transient).toBe(true);
    expect(res.cause).toBe("provider_transport");
    expect(res.detail).toContain("ECONNRESET");
  });

  test("a PROVIDER_ERROR turn_end code alone is transient", () => {
    const run = runWith([
      SESSION,
      { type: "status", phase: "turn_end", reason: { kind: "error", error: { code: "PROVIDER_ERROR" } } },
    ]);
    const res = classifyTransientRunFailure({ run, error: "CODING_FAILED: exit 1" });
    expect(res.transient).toBe(true);
    expect(res.cause).toBe("turn_end_provider_error");
  });

  test("a non-auth 4xx bad request is NON-transient", () => {
    const run = runWith([
      SESSION,
      { type: "status", phase: "turn_end", reason: { kind: "error", error: { status: 400, message: "invalid request: tool schema" } } },
    ]);
    const res = classifyTransientRunFailure({ run, error: "CODING_FAILED: exit 1" });
    expect(res.transient).toBe(false);
    expect(res.veto).toBe("unknown");
  });

  test("a provider/transport turn_end error is transient", () => {
    const res = classifyTransientEvidence({
      text: "provider request failed: upstream error before completion",
      turnEnd: "error",
    });
    expect(res.transient).toBe(true);
    expect(res.cause).toBe("turn_end_provider_error");
  });

  test("auth is NON-transient even when the text also looks retryable", () => {
    const run = runWith([
      SESSION,
      { type: "status", phase: "turn_end", reason: { kind: "error", error: { status: 401, code: "MISSING_CREDENTIAL", message: "no API key for provider" } } },
    ]);
    const res = classifyTransientRunFailure({ run, error: "CODING_FAILED: 401" });
    expect(res.transient).toBe(false);
    expect(res.veto).toBe("auth");
  });

  test("ENOSPC and permission failures are NON-transient", () => {
    const enospc = classifyTransientRunFailure({
      run: runWith([SESSION], { stderr: "fatal: No space left on device\n" }),
      error: "CODING_FAILED: exit 1",
    });
    expect(enospc.transient).toBe(false);
    expect(enospc.veto).toBe("enospc");
    const permission = classifyTransientRunFailure({
      run: runWith([SESSION], { stderr: "EACCES: permission denied\n" }),
      error: "CODING_FAILED: exit 1",
    });
    expect(permission.transient).toBe(false);
    expect(permission.veto).toBe("permission");
  });

  test("a genuinely unknown failure is NON-transient", () => {
    const res = classifyTransientRunFailure({ run: runWith([SESSION]), error: "CODING_FAILED: exit 1" });
    expect(res.transient).toBe(false);
    expect(res.veto).toBe("unknown");
  });

  test("a cancelled/timed-out Run is never transient", () => {
    expect(
      classifyTransientRunFailure({ run: runWith([SESSION], { state: "cancelled", signal: "cancelled" }), error: "cancelled" }).transient
    ).toBe(false);
    expect(
      classifyTransientRunFailure({ run: runWith([SESSION], { state: "timeout", signal: "timeout" }), error: "timeout" }).transient
    ).toBe(false);
  });

  test("the REAL 2026-10-24 outage evidence (turn_end TIMEOUT + `dsh: TIMEOUT:`) is transient", () => {
    // Verbatim shapes from run-9de64bd1/run-baf6bcd8/run-168e8c81.
    const run = runWith(
      [
        SESSION,
        { type: "status", phase: "turn_end", turn: 1, reason: { kind: "error", error: { message: "Request timed out.", code: "TIMEOUT" } } },
        { type: "final", text: "…" },
      ],
      { stderr: "dsh: TIMEOUT: Request timed out.\n" }
    );
    const res = classifyTransientRunFailure({ run, error: "CODING_FAILED: exit 1" });
    expect(res.transient).toBe(true);
    expect(res.cause).toBe("provider_transport");
    expect(res.detail).toContain("TIMEOUT");
    expect(res.evidence.join("\n")).toContain("code=TIMEOUT");
  });

  test("dsh provider-neutral codes TIMEOUT/TRANSPORT/SERVER/RATE_LIMIT are transient; AUTH/ENOSPC/unknown are not", () => {
    const verdict = (code: string) =>
      classifyTransientRunFailure({
        run: runWith(
          [
            SESSION,
            { type: "status", phase: "turn_end", turn: 1, reason: { kind: "error", error: { message: `failure ${code}`, code } } },
          ],
          { stderr: `dsh: ${code}: failure ${code}\n` }
        ),
        error: "CODING_FAILED: exit 1",
      });
    expect(verdict("TIMEOUT").transient).toBe(true);
    expect(verdict("TIMEOUT").cause).toBe("provider_transport");
    expect(verdict("TRANSPORT").transient).toBe(true);
    expect(verdict("TRANSPORT").cause).toBe("provider_transport");
    expect(verdict("SERVER").transient).toBe(true);
    expect(verdict("SERVER").cause).toBe("provider_http_5xx");
    expect(verdict("RATE_LIMIT").transient).toBe(true);
    expect(verdict("RATE_LIMIT").cause).toBe("provider_http_429");
    expect(verdict("ECONNRESET").transient).toBe(true);
    expect(verdict("AUTH").transient).toBe(false);
    expect(verdict("AUTH").veto).toBe("auth");
    expect(verdict("ENOSPC").transient).toBe(false);
    expect(verdict("ENOSPC").veto).toBe("enospc");
    expect(verdict("INVALID_REQUEST").transient).toBe(false);
    expect(verdict("PI_AI_ERROR").transient).toBe(false);
  });

  test("REGRESSION: a long Run (500+ status events) with a non-transient error is NOT an HTTP 5xx", () => {
    const lines: Record<string, unknown>[] = [SESSION];
    for (let i = 0; i < 500; i++) lines.push({ type: "status", phase: "step", turn: 1, step: i });
    lines.push({
      type: "status",
      phase: "turn_end",
      turn: 1,
      reason: { kind: "error", error: { message: "invalid tool schema", code: "INVALID_REQUEST" } },
    });
    const run = runWith(lines, { stderr: "dsh: INVALID_REQUEST: invalid tool schema\n" });
    // The JSONL really carries 500+ status events…
    const ev = readRunProviderEvidence(run.dsh_events_path);
    expect(ev.statuses).toEqual([]);
    expect(ev.turnEndCode).toBe("INVALID_REQUEST");
    // …and the terminal `dsh.run.failed` event's `dsh.status` is that COUNT
    // (500), not an HTTP status. It must NOT make a genuine coding failure look
    // like a provider outage.
    const db = openDb(join(tmp(), "state.db"));
    try {
      logEvent(db, {
        source: "dsh-runner",
        taskId: "T1",
        type: "dsh.run.failed",
        payload: { runId: "run-1", error: "exit 1", dsh: { status: 500, total: 502, text: 0 } },
      });
    } finally {
      db.close();
    }
    const res = classifyTransientRunFailure({ run, error: "CODING_FAILED: exit 1" });
    expect(res.transient).toBe(false);
    expect(res.cause).toBeNull();
  });

  test("REGRESSION: a later error turn with NO code does not inherit an earlier TIMEOUT code", () => {
    const lines: Record<string, unknown>[] = [
      SESSION,
      // Turn 1 is a genuine provider timeout…
      { type: "status", phase: "turn_end", turn: 1, reason: { kind: "error", error: { code: "TIMEOUT", message: "Request timed out." } } },
      // …turn 2 fails with a message but NO code: it must not inherit TIMEOUT.
      { type: "status", phase: "turn_end", turn: 2, reason: { kind: "error", error: { message: "tool loop exploded" } } },
    ];
    const run = runWith(lines);
    const ev = readRunProviderEvidence(run.dsh_events_path);
    expect(ev.turnEnd).toBe("error");
    expect(ev.turnEndCode).toBeNull();
    expect(ev.turnEndMessage).toBe("tool loop exploded");
    expect(ev.turnEndStatus).toBeNull();
    const res = classifyTransientRunFailure({ run, error: "CODING_FAILED: exit 1" });
    expect(res.transient).toBe(false);
    expect(res.veto).toBe("unknown");
  });

  test("REGRESSION: a completed turn after an error turn clears the failure evidence", () => {
    const run = runWith([
      SESSION,
      { type: "status", phase: "turn_end", turn: 1, reason: { kind: "error", error: { code: "TIMEOUT", message: "Request timed out." } } },
      { type: "status", phase: "turn_end", turn: 2, reason: { kind: "completed" } },
    ]);
    const ev = readRunProviderEvidence(run.dsh_events_path);
    expect(ev.turnEnd).toBe("completed");
    expect(ev.turnEndCode).toBeNull();
    expect(ev.turnEndMessage).toBeNull();
    expect(ev.turnEndStatus).toBeNull();
  });

  test("an EARLIER transient turn does not make a later genuine failure transient", () => {
    const lines: Record<string, unknown>[] = [
      SESSION,
      // turn 1 failed with a provider 500, then the Run continued…
      { type: "status", phase: "turn_end", turn: 1, reason: { kind: "error", error: { status: 500, message: "upstream 500" } } },
      { type: "error", message: "fetch failed: read ECONNRESET" },
      { type: "status", phase: "step", turn: 2, step: 1 },
      // …and turn 2 is a genuine failure with NO transport/provider evidence.
      { type: "status", phase: "turn_end", turn: 2, reason: { kind: "error", error: { message: "the tool schema is invalid" } } },
    ];
    const run = runWith(lines);
    const ev = readRunProviderEvidence(run.dsh_events_path);
    expect(ev.statuses).toEqual([]); // the earlier 500 is replaced, not accumulated
    expect(ev.errors).toEqual([]); // the earlier ECONNRESET is not terminal evidence
    expect(ev.turnEndCode).toBeNull();
    const res = classifyTransientRunFailure({ run, error: "CODING_FAILED: exit 1" });
    expect(res.transient).toBe(false);
    expect(res.veto).toBe("unknown");
  });

  test("REGRESSION: a real ECONNRESET is not vetoed by a 401-shaped status event count", () => {
    const lines: Record<string, unknown>[] = [SESSION];
    for (let i = 0; i < 401; i++) lines.push({ type: "status", phase: "step", turn: 1, step: i });
    const run = runWith(lines, { stderr: "fetch failed: read ECONNRESET\n" });
    const res = classifyTransientRunFailure({ run, error: "CODING_FAILED: exit 1" });
    expect(res.transient).toBe(true);
    expect(res.cause).toBe("provider_transport");
    expect(res.veto).toBeUndefined();
  });

  test("readRunProviderEvidence reads structured statuses/codes from the dsh JSONL", () => {
    const dir = tmp();
    const path = join(dir, "dsh.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify(SESSION),
        JSON.stringify({ type: "status", phase: "turn_end", reason: { kind: "error", error: { status: 503, code: "OVERLOADED" } } }),
        JSON.stringify({ type: "error", statusCode: 429, message: "slow down" }),
        // A successful tool_result status is NOT a provider status.
        JSON.stringify({ type: "tool_result", status: "completed", result: "ok" }),
      ].join("\n") + "\n"
    );
    const ev = readRunProviderEvidence(path);
    expect(ev.turnEnd).toBe("error");
    expect(ev.turnEndCode).toBe("OVERLOADED");
    expect(ev.turnEndStatus).toBe(503);
    expect(ev.statuses).toEqual([503, 429]);
  });
});

describe("ISH-1174: reviewer + session classification", () => {
  test("REVIEW_PROCESS_FAILED with transport/provider evidence is transient", () => {
    const res = classifyTransientReviewerFailure({
      error: "REVIEW_PROCESS_FAILED: reviewer process exit 1 signal none",
      raw: "API Error: 500 Internal Server Error\n",
    });
    expect(res.transient).toBe(true);
    expect(res.cause).toBe("provider_http_5xx");
  });

  test("REVIEW_PROCESS_FAILED with the dsh-style TIMEOUT code is transient", () => {
    const res = classifyTransientReviewerFailure({
      error: "REVIEW_PROCESS_FAILED: reviewer process exit 1 signal none",
      raw: "dsh: TIMEOUT: Request timed out.\n",
    });
    expect(res.transient).toBe(true);
    expect(res.cause).toBe("provider_transport");
    expect(res.detail).toContain("TIMEOUT");
  });

  test("a REVIEW_PROCESS_FAILED with auth/unknown evidence is NON-transient", () => {
    expect(
      classifyTransientReviewerFailure({
        error: "REVIEW_PROCESS_FAILED: reviewer process exit 1 signal none",
        raw: "authentication failed: invalid api key",
      }).transient
    ).toBe(false);
    expect(
      classifyTransientReviewerFailure({
        error: "REVIEW_PROCESS_FAILED: reviewer process exit 1 signal none",
        raw: "reviewer crashed",
      }).transient
    ).toBe(false);
  });

  test("REGRESSION: provider words only QUOTED on reviewer stdout are not transient evidence", () => {
    const res = classifyTransientReviewerFailure({
      error: "REVIEW_PROCESS_FAILED: reviewer process exit 1 signal none",
      // The reviewer was reading this very code and quoted its markers; it then
      // crashed for an unrelated reason. Only stderr is process-failure evidence.
      raw: "src/transient-failure.ts mentions ECONNRESET and status: 500\nreviewer crashed",
      stderr: "reviewer crashed",
    });
    expect(res.transient).toBe(false);
    expect(res.veto).toBe("unknown");
    // Real stderr transport evidence still classifies.
    const real = classifyTransientReviewerFailure({
      error: "REVIEW_PROCESS_FAILED: reviewer process exit 1 signal none",
      raw: "pass {}\n",
      stderr: "API Error: 500 Internal Server Error",
    });
    expect(real.transient).toBe(true);
  });

  test("a non-process refusal (malformed verdict / head mismatch) is never transient", () => {
    expect(
      classifyTransientReviewerFailure({
        error: "REVIEW_NO_STRUCTURED_RESULT: no JSON object",
        raw: "connection reset",
      }).transient
    ).toBe(false);
    expect(
      classifyTransientReviewerFailure({
        error: "REVIEW_HEAD_MISMATCH: reviewer named head abc",
        raw: "status=500",
      }).transient
    ).toBe(false);
  });

  test("an unknown/corrupt --session-id adoption is detected ONLY for a session-mode resume", () => {
    // A Run that never passed --session-id cannot have failed to adopt one.
    const first = runWith([SESSION], { error: "dsh: unknown session session-1" });
    expect(classifyUnadoptableSession({ run: first, error: "CODING_FAILED: exit 1" }).unadoptable).toBe(false);

    const run = runWith([SESSION], {
      resumed_from_run_id: "run-0",
      resume_count: 1,
      resume_session_id: "session-1",
    });
    expect(classifyUnadoptableSession({ run, error: "CODING_FAILED: exit 1" }).unadoptable).toBe(false);
    const bad = runWith([SESSION], {
      resumed_from_run_id: "run-0",
      resume_count: 1,
      resume_session_id: "session-1",
      error: "dsh: unknown session session-1",
    });
    const res = classifyUnadoptableSession({ run: bad, error: "CODING_FAILED: exit 1" });
    expect(res.unadoptable).toBe(true);
    expect(res.detail).toContain("unknown session");
  });

  test("REGRESSION: a FIRST-run auth failure that says 'session expired' is NOT an adoption failure", () => {
    const run = runWith([SESSION], { error: "dsh: AUTH: login session expired; run dsh login" });
    // The auth veto is fail-closed…
    const transient = classifyTransientRunFailure({ run, error: "CODING_FAILED: exit 1" });
    expect(transient.transient).toBe(false);
    expect(transient.veto).toBe("auth");
    // …and the phrase must not be mistaken for an unadoptable Session.
    expect(classifyUnadoptableSession({ run, error: "CODING_FAILED: exit 1" }).unadoptable).toBe(false);
  });

  test("a session-mode resume with AUTH evidence is unadoptable-looking but still vetoed", () => {
    const run = runWith([SESSION], {
      resumed_from_run_id: "run-0",
      resume_count: 1,
      resume_session_id: "session-1",
      error: "dsh: AUTH: login session expired; run dsh login",
    });
    expect(classifyUnadoptableSession({ run, error: "CODING_FAILED: exit 1" }).unadoptable).toBe(true);
    const transient = classifyTransientRunFailure({ run, error: "CODING_FAILED: exit 1" });
    expect(transient.transient).toBe(false);
    expect(transient.veto).toBe("auth");
  });
});

describe("ISH-1174: bounded wait policy", () => {
  test("caps default to 3 resumes / 60 min / 30 s doubling to 5 min", () => {
    const p = resolveTransientPolicy({ env: {} as NodeJS.ProcessEnv });
    expect(p.maxResumes).toBe(DEFAULT_TRANSIENT_MAX_RESUMES);
    expect(p.waitMs).toBe(DEFAULT_TRANSIENT_WAIT_MS);
    expect(p.backoffMs).toBe(DEFAULT_TRANSIENT_BACKOFF_MS);
    expect(p.maxBackoffMs).toBe(DEFAULT_TRANSIENT_MAX_BACKOFF_MS);
    expect(p.maxResumes).toBe(3);
    expect(p.waitMs).toBe(60 * 60_000);
    expect(p.backoffMs).toBe(30_000);
    expect(p.maxBackoffMs).toBe(5 * 60_000);
  });

  test("env/CLI overrides are applied; invalid values keep the safe default", () => {
    const env = {
      RELAY_TRANSIENT_MAX_RESUMES: "5",
      RELAY_TRANSIENT_WAIT_MS: "1200",
      RELAY_TRANSIENT_BACKOFF_MS: "5",
      RELAY_TRANSIENT_MAX_BACKOFF_MS: "100",
    } as unknown as NodeJS.ProcessEnv;
    const p = resolveTransientPolicy({ env, maxResumes: 2 });
    expect(p.maxResumes).toBe(2);
    expect(p.waitMs).toBe(1200);
    expect(p.backoffMs).toBe(5);
    expect(p.maxBackoffMs).toBe(100);
    const invalid = resolveTransientPolicy({
      env: { RELAY_TRANSIENT_MAX_RESUMES: "nope", RELAY_TRANSIENT_WAIT_MS: "-4" } as unknown as NodeJS.ProcessEnv,
    });
    expect(invalid.maxResumes).toBe(DEFAULT_TRANSIENT_MAX_RESUMES);
    expect(invalid.waitMs).toBe(DEFAULT_TRANSIENT_WAIT_MS);
  });

  test("the probe backs off 30s -> 60s -> 120s and resumes once reachable", async () => {
    let now = 0;
    const delays: number[] = [];
    const probes: number[] = [];
    const res = await waitForProviderRecovery({
      probe: async () => {
        probes.push(now);
        return probes.length >= 3;
      },
      onWait: (e) => delays.push(e.delayMs),
      capMs: 10_000,
      backoffMs: 30,
      maxBackoffMs: 5_000,
      context: { taskId: "T1", runId: "run-1", phase: "implement", attempt: 0, cause: "5xx", resumeCount: 1 },
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(res.recovered).toBe(true);
    expect(res.probes).toBe(3);
    expect(delays).toEqual([30, 60]);
  });

  test("the total wait cap expires and returns recovered=false", async () => {
    let now = 0;
    let sleeps = 0;
    const res = await waitForProviderRecovery({
      probe: async () => false,
      onWait: () => {},
      capMs: 50,
      backoffMs: 30,
      maxBackoffMs: 1000,
      context: { taskId: "T1", runId: "run-1", phase: "implement", attempt: 0, cause: "5xx", resumeCount: 1 },
      now: () => now,
      sleep: async (ms) => {
        sleeps++;
        now += ms;
      },
    });
    expect(res.recovered).toBe(false);
    expect(now).toBeGreaterThanOrEqual(50);
    expect(sleeps).toBeGreaterThan(0);
  });
});
