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

  test("ISH-1133: `relay run factory --help` documents the no-env defaults and overrides", () => {
    const out = help(["run", "factory"]);
    expect(out).toContain("NO environment variable is required");
    expect(out).toContain("$HOME/.dsh/bin/dsh-model");
    expect(out).toContain("RELAY_PROVIDER_GITHUB=off");
    expect(out).toContain("RELAY_REVIEW_TIMEOUT_MS");
    expect(out).toContain("45 min / 2,700,000 ms");
  });

  test("ISH-1174: `relay run factory --help` documents the transient class and the caps", () => {
    const out = help(["run", "factory"]);
    expect(out).toContain("TRANSIENT RECOVERY");
    expect(out).toContain("provider HTTP 5xx or 429");
    expect(out).toContain("--session-id");
    expect(out).toContain("factory.waiting_transient");
    expect(out).toContain("factory.run_resumed");
    expect(out).toContain("factory.review_resumed");
    expect(out).toContain("--max-resumes N");
    expect(out).toContain("--transient-wait DUR");
    expect(out).toContain("--transient-backoff DUR");
    expect(out).toContain("default 3");
    expect(out).toContain("60 min");
    expect(out).toContain("RELAY_TRANSIENT_MAX_RESUMES");
    expect(out).toContain("RELAY_PROVIDER_PROBE_URL");
    // The top-level usage advertises the same caps.
    expect(help([])).toContain("--max-resumes N");
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
    expect(out).toContain("relay pr unbind <task-id>");
  });

  test("ISH-1222: `relay pr --help` documents the explicit unbind override", () => {
    const out = help(["pr"]);
    expect(out).toContain("relay pr unbind <task-id>");
    expect(out).toContain("task.pr_unbound");
    expect(out).toContain("never runs implicitly");
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
