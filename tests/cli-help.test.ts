import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// ISH-904: operators used flags that existed but were absent from the help text
// (`relay run factory --permission`, `relay task intake --description`). The
// help must also state the Factory's code-change / REQUIRED-check preconditions.

const cli = join(import.meta.dir, "..", "src", "cli.ts");

function help(args: string[]): string {
  const r = Bun.spawnSync(["bun", cli, ...args, "--help"], { stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode).toBe(0);
  return `${r.stdout.toString()}\n${r.stderr.toString()}`;
}

describe("ISH-904: CLI help documents the operator flags and preconditions", () => {
  test("`relay run factory --help` documents --permission and the preconditions", () => {
    const out = help(["run", "factory"]);
    expect(out).toContain("--permission MODE");
    expect(out).toContain("CODE-CHANGE TASKS ONLY");
    expect(out).toContain("relay task intake --code-change");
    expect(out).toContain("at least ONE REQUIRED");
    expect(out).toContain("--check name=command");
    expect(out).toContain("no_checks");
  });

  test("`relay task intake --help` documents --description", () => {
    const out = help(["task", "intake"]);
    expect(out).toContain("--description D");
    expect(out).toContain("distinct from --title");
  });

  test("the top-level usage lists --permission on the factory and --description on intake", () => {
    const out = help([]);
    expect(out).toContain("relay run factory <task-id>");
    expect(out).toContain("--permission MODE");
    expect(out).toContain("relay task intake --provider P --issue ID");
    expect(out).toContain("--description D");
  });
});

describe("ISH-1122: CLI help documents the coordinator rebase route", () => {
  test("`relay result rebase --help` documents the reason, authority and refusals", () => {
    const out = help(["result", "rebase"]);
    expect(out).toContain("relay result rebase <task-id> --reason <text>");
    expect(out).toContain("merge_ready");
    expect(out).toContain("CONFLICTING");
    expect(out).toContain("integrator");
    expect(out).toContain("reviewer NG/HOLD");
    expect(out).toContain("never records a review verdict");
  });

  test("the top-level usage and `relay result --help` list the rebase subcommand", () => {
    expect(help([])).toContain("relay result rebase <task-id> --reason");
    expect(help(["result"])).toContain("relay result rebase <task-id> --reason");
  });
});
