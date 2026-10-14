import { describe, expect, test } from "bun:test";
import {
  aggregateOutcome,
  defaultRunner,
  isBlockingOutcome,
  parseChecks,
  runChecks,
  serializeChecks,
  type CheckSpec,
  type CommandRunner,
  type ExecutedCheck,
} from "../src/verify";

const spec = (name: string, command: string, required = true): CheckSpec => ({ name, command, required });

function fakeRunner(map: Record<string, Partial<ExecutedCheck>>): CommandRunner {
  return {
    async run(s, { cwd }) {
      const r = map[s.name] ?? {};
      return {
        name: s.name,
        required: s.required !== false,
        outcome: r.outcome ?? "pass",
        exitCode: r.exitCode ?? (r.outcome === "not_run" || r.outcome === "inconclusive" ? null : 0),
        output: `${cwd}:${r.output ?? ""}`,
        durationMs: r.durationMs ?? 1,
      };
    },
  };
}

describe("aggregateOutcome", () => {
  test("pass only when every required check passed", () => {
    expect(
      aggregateOutcome([
        { name: "a", required: true, outcome: "pass", exitCode: 0, output: "", durationMs: 0 },
        { name: "b", required: true, outcome: "pass", exitCode: 0, output: "", durationMs: 0 },
      ])
    ).toBe("pass");
  });

  test("a FAIL always fails, even next to a required not_run", () => {
    expect(
      aggregateOutcome([
        { name: "a", required: true, outcome: "not_run", exitCode: null, output: "", durationMs: 0 },
        { name: "b", required: true, outcome: "fail", exitCode: 1, output: "", durationMs: 0 },
      ])
    ).toBe("fail");
  });

  test("a required NOT_RUN blocks", () => {
    const out = aggregateOutcome([
      { name: "a", required: true, outcome: "pass", exitCode: 0, output: "", durationMs: 0 },
      { name: "b", required: true, outcome: "not_run", exitCode: null, output: "", durationMs: 0 },
    ]);
    expect(out).toBe("not_run");
    expect(isBlockingOutcome(out)).toBe(true);
  });

  test("a required INCONCLUSIVE blocks", () => {
    expect(
      aggregateOutcome([
        { name: "a", required: true, outcome: "inconclusive", exitCode: null, output: "", durationMs: 0 },
      ])
    ).toBe("inconclusive");
  });

  test("an OPTIONAL not_run does not block", () => {
    expect(
      aggregateOutcome([
        { name: "a", required: true, outcome: "pass", exitCode: 0, output: "", durationMs: 0 },
        { name: "b", required: false, outcome: "not_run", exitCode: null, output: "", durationMs: 0 },
      ])
    ).toBe("pass");
  });
});

describe("parseChecks / serializeChecks", () => {
  test("round-trips valid specs and drops junk", () => {
    const json = serializeChecks([spec("typecheck", "bun run typecheck"), spec("test", "bun test")]);
    const parsed = parseChecks(json);
    expect(parsed.map((c) => c.name)).toEqual(["typecheck", "test"]);
    expect(parsed.every((c) => c.required)).toBe(true);
    expect(parseChecks(JSON.stringify([{ name: "x" }, { command: "y" }, "nope"])).length).toBe(0);
    expect(parseChecks("not json")).toEqual([]);
    expect(parseChecks(null)).toEqual([]);
  });
});

describe("runChecks with a read-only fake runner", () => {
  test("runs each spec and threads the aggregate through", async () => {
    const checks = [spec("typecheck", "bun run typecheck"), spec("test", "bun test")];
    const runner = fakeRunner({ typecheck: { outcome: "pass" }, test: { outcome: "fail", exitCode: 2 } });
    const r = await runChecks(checks, runner, "/work");
    expect(r.outcome).toBe("fail");
    expect(r.checks).toHaveLength(2);
    expect(r.checks[0].output).toContain("/work");
  });

  test("a runner that throws yields not_run, never a pass", async () => {
    const throwing: CommandRunner = {
      async run() {
        throw new Error("no such command");
      },
    };
    const r = await runChecks([spec("typecheck", "bun run typecheck")], throwing, "/work");
    expect(r.outcome).toBe("not_run");
    expect(r.checks[0].outcome).toBe("not_run");
  });
});

describe("defaultRunner hard timeout (finding 5)", () => {
  test("a hung command with a live grandchild is killed as a group and returns not_run fast", async () => {
    // `sleep` is a grandchild of bash; it holds the stdout pipe open. Without a
    // process-group kill the reader would block until sleep exits (~4s).
    const started = Date.now();
    const r = await defaultRunner.run(
      { name: "slow", command: "sleep 4; echo done", required: true, timeoutMs: 300 },
      { cwd: process.cwd() }
    );
    const elapsed = Date.now() - started;
    expect(r.outcome).toBe("not_run");
    expect(r.output).toContain("timed out");
    expect(elapsed).toBeLessThan(2000);
  });

  test("a fast command still reports its real exit result", async () => {
    const ok = await defaultRunner.run({ name: "ok", command: "true", required: true }, { cwd: process.cwd() });
    expect(ok.outcome).toBe("pass");
    expect(ok.exitCode).toBe(0);
    const bad = await defaultRunner.run({ name: "bad", command: "false", required: true }, { cwd: process.cwd() });
    expect(bad.outcome).toBe("fail");
    expect(bad.exitCode).toBe(1);
  });
});
