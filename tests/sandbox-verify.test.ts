import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { getTask } from "../src/tasks";
import { claimTask } from "../src/tasks";
import { registerWorker } from "../src/workers";
import { intakeTask, runMechanicalVerification, submitPhase } from "../src/workflow";
import { isBlockingOutcome, runChecks, type CheckSpec } from "../src/verify";
import { upsertSandbox } from "../src/sandbox";
import {
  defaultVerifyTarget,
  evidenceSandboxRunner,
  jsonlEvidenceSink,
  notRunRunner,
  sandboxCommandRunner,
  sandboxLabctl,
  sandboxVerifyTarget,
  type SandboxCheckEvidence,
  type SandboxExec,
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxVerifyBinding,
} from "../src/sandbox-verify";

// ISH-829: the Coding Sandbox VERIFY boundary. A FAKE `sbx exec` stands in for
// the sandbox, so every fail-closed branch (HEAD mismatch, timeout, transport
// error, a HEAD that moved mid-check) is deterministic and no Docker is used.

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

class FakeSbxExec implements SandboxExec {
  /** Values returned by successive `git rev-parse HEAD` reads. */
  heads: (string | null)[] = [];
  headDefault: string | null = HEAD;
  /** Working-tree states returned by successive `git status --porcelain` reads. */
  trees: ("clean" | "dirty" | "unknown")[] = [];
  treeDefault: "clean" | "dirty" | "unknown" = "clean";
  command: (argv: string[]) => SandboxExecResult = () => ({ code: 0, stdout: "ok", stderr: "", timedOut: false });
  calls: { name: string; argv: string[]; workdir?: string; timeoutMs?: number; env?: Record<string, string> }[] = [];

  async exec(name: string, argv: string[], opts: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    this.calls.push({ name, argv, workdir: opts.workdir, timeoutMs: opts.timeoutMs, env: opts.env });
    const joined = argv.join(" ");
    if (joined.includes("rev-parse HEAD")) {
      const v = this.heads.length > 0 ? (this.heads.shift() as string | null) : this.headDefault;
      if (v === null) return { code: 1, stdout: "", stderr: "not a git repo", timedOut: false };
      return { code: 0, stdout: `${v}\n`, stderr: "", timedOut: false };
    }
    if (joined.includes("status") && joined.includes("--porcelain")) {
      const t = this.trees.length > 0 ? this.trees.shift()! : this.treeDefault;
      if (t === "unknown") return { code: 1, stdout: "", stderr: "status failed", timedOut: false };
      return { code: 0, stdout: t === "dirty" ? " M src/x.ts\n?? extra.ts\n" : "", stderr: "", timedOut: false };
    }
    return this.command(argv);
  }

  /** Non-HEAD, non-status calls (the actual checks + labctl). */
  get checkCalls() {
    return this.calls.filter((c) => {
      const j = c.argv.join(" ");
      return !j.includes("rev-parse HEAD") && !(j.includes("status") && j.includes("--porcelain"));
    });
  }
}

const binding = (exec: SandboxExec, over: Partial<SandboxVerifyBinding> = {}): SandboxVerifyBinding => ({
  sandbox: "relay-ish-829-abcd1234",
  workspace: "/workspace/repo",
  head: HEAD,
  exec,
  ...over,
});

describe("notRunRunner", () => {
  test("refuses every check with its reason (the fail-closed target)", async () => {
    const r = await notRunRunner("no usable sandbox", "sbx-x").run({ name: "a", command: "true", required: true }, { cwd: "/x" });
    expect(r.outcome).toBe("not_run");
    expect(r.output).toBe("no usable sandbox");
    expect(r.sandbox).toBe("sbx-x");
  });
});

describe("sandboxCommandRunner", () => {
  test("a check that exits 0 at the bound HEAD PASSes and is labelled with its sandbox+HEAD", async () => {
    const exec = new FakeSbxExec();
    const r = await sandboxCommandRunner(binding(exec)).run({ name: "typecheck", command: "bun run typecheck" }, { cwd: "/x" });
    expect(r.outcome).toBe("pass");
    expect(r.exitCode).toBe(0);
    expect(r.sandbox).toBe("relay-ish-829-abcd1234");
    expect(r.head).toBe(HEAD);
    expect(r.timedOut).toBe(false);
    // The command ran THROUGH the sandbox exec, not on the host.
    expect(exec.checkCalls).toHaveLength(1);
    expect(exec.checkCalls[0].name).toBe("relay-ish-829-abcd1234");
    expect(exec.checkCalls[0].argv).toEqual(["bash", "-lc", "bun run typecheck"]);
    expect(exec.checkCalls[0].workdir).toBe("/workspace/repo");
  });

  test("a non-zero exit is a FAIL (never masked)", async () => {
    const exec = new FakeSbxExec();
    exec.command = () => ({ code: 2, stdout: "", stderr: "boom", timedOut: false });
    const r = await sandboxCommandRunner(binding(exec)).run({ name: "test", command: "bun test" }, { cwd: "/x" });
    expect(r.outcome).toBe("fail");
    expect(r.exitCode).toBe(2);
  });

  test("a timeout is NOT_RUN (never a pass)", async () => {
    const exec = new FakeSbxExec();
    exec.command = () => ({ code: null, stdout: "", stderr: "timed out", timedOut: true });
    const r = await sandboxCommandRunner(binding(exec)).run({ name: "test", command: "sleep 1", timeoutMs: 1 }, { cwd: "/x" });
    expect(r.outcome).toBe("not_run");
    expect(r.timedOut).toBe(true);
  });

  test("a transport/spawn error is NOT_RUN and the command is never trusted", async () => {
    const exec = new FakeSbxExec();
    exec.command = () => ({ code: null, stdout: "", stderr: "", timedOut: false, error: "sbx exec spawn failed" });
    const r = await sandboxCommandRunner(binding(exec)).run({ name: "test", command: "bun test" }, { cwd: "/x" });
    expect(r.outcome).toBe("not_run");
    expect(r.output).toContain("spawn failed");
  });

  test("a HEAD that is not the bound head is NOT_RUN and the command does not run", async () => {
    const exec = new FakeSbxExec();
    exec.headDefault = OTHER;
    const r = await sandboxCommandRunner(binding(exec)).run({ name: "test", command: "bun test" }, { cwd: "/x" });
    expect(r.outcome).toBe("not_run");
    expect(r.output).toContain("!= bound head");
    expect(exec.checkCalls).toHaveLength(0);
  });

  test("an unreadable HEAD is NOT_RUN", async () => {
    const exec = new FakeSbxExec();
    exec.headDefault = null;
    const r = await sandboxCommandRunner(binding(exec)).run({ name: "test", command: "bun test" }, { cwd: "/x" });
    expect(r.outcome).toBe("not_run");
    expect(exec.checkCalls).toHaveLength(0);
  });

  test("a HEAD that MOVED while the check ran is INCONCLUSIVE (no trusted pass)", async () => {
    const exec = new FakeSbxExec();
    // before = HEAD, after = OTHER
    exec.heads = [HEAD, OTHER];
    const r = await sandboxCommandRunner(binding(exec)).run({ name: "test", command: "git commit --allow-empty -m x" }, { cwd: "/x" });
    expect(r.outcome).toBe("inconclusive");
  });

  test("a DIRTY clone is NOT_RUN and the command does not run", async () => {
    const exec = new FakeSbxExec();
    exec.treeDefault = "dirty"; // uncommitted edits present at the bound HEAD
    const r = await sandboxCommandRunner(binding(exec)).run({ name: "test", command: "bun test" }, { cwd: "/x" });
    expect(r.outcome).toBe("not_run");
    expect(r.output).toContain("dirty");
    expect(exec.checkCalls).toHaveLength(0);
  });

  test("an UNKNOWN tree state (status probe failed) is NOT_RUN", async () => {
    const exec = new FakeSbxExec();
    exec.treeDefault = "unknown";
    const r = await sandboxCommandRunner(binding(exec)).run({ name: "test", command: "bun test" }, { cwd: "/x" });
    expect(r.outcome).toBe("not_run");
    expect(exec.checkCalls).toHaveLength(0);
  });

  test("a check that DIRTIES the tree (exit 0) is INCONCLUSIVE, never a pass", async () => {
    const exec = new FakeSbxExec();
    exec.trees = ["clean", "dirty"]; // clean before, dirty after
    const r = await sandboxCommandRunner(binding(exec)).run({ name: "test", command: "echo x > generated.ts" }, { cwd: "/x" });
    expect(r.outcome).toBe("inconclusive");
  });

  test("a check that fails AND dirties the tree is still a FAIL", async () => {
    const exec = new FakeSbxExec();
    exec.trees = ["clean", "dirty"];
    exec.command = () => ({ code: 1, stdout: "", stderr: "boom", timedOut: false });
    const r = await sandboxCommandRunner(binding(exec)).run({ name: "test", command: "false" }, { cwd: "/x" });
    expect(r.outcome).toBe("fail");
    expect(r.exitCode).toBe(1);
  });
});

describe("evidence (stdout/stderr/exit/timeout/HEAD/required count)", () => {
  test("each check is recorded with its required count and stream tails", async () => {
    const exec = new FakeSbxExec();
    exec.command = () => ({ code: 1, stdout: "some stdout", stderr: "some stderr", timedOut: false });
    const evidence: SandboxCheckEvidence[] = [];
    const checks: CheckSpec[] = [
      { name: "a", command: "true", required: true },
      { name: "b", command: "false", required: false },
    ];
    const runner = evidenceSandboxRunner(binding(exec), checks, (e) => evidence.push(e));
    await runChecks(checks, runner, "/x");
    expect(evidence).toHaveLength(2);
    expect(evidence[0].requiredCount).toBe(1);
    expect(evidence[0].index).toBe(1);
    expect(evidence[1].index).toBe(2);
    expect(evidence[0].exitCode).toBe(1);
    expect(evidence[0].stdout).toContain("some stdout");
    expect(evidence[0].stderr).toContain("some stderr");
    expect(evidence[0].boundHead).toBe(HEAD);
    expect(evidence[0].headBefore).toBe(HEAD);
  });

  test("the JSONL sink appends one readable line per check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-ish829-ev-"));
    try {
      const path = join(dir, "nested", "sandbox-verify.jsonl");
      const exec = new FakeSbxExec();
      const checks: CheckSpec[] = [{ name: "a", command: "true", required: true }];
      await runChecks(checks, evidenceSandboxRunner(binding(exec), checks, jsonlEvidenceSink(path)), "/x");
      const lines = readFileSync(path, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const rec = JSON.parse(lines[0]) as SandboxCheckEvidence;
      expect(rec.sandbox).toBe("relay-ish-829-abcd1234");
      expect(rec.outcome).toBe("pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("host sentinel: a check never escapes to host bash", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relay-ish829-sentinel-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a command that would touch a host path only runs inside the sandbox", async () => {
    const sentinel = join(dir, "HOST_SENTINEL");
    const exec = new FakeSbxExec();
    // The fake never executes on the host; the assertion is that the command was
    // routed to `sbx exec` (the sandbox), so the host sentinel is absent.
    const r = await sandboxCommandRunner(binding(exec)).run(
      { name: "sentinel", command: `touch ${sentinel}` },
      { cwd: dir }
    );
    expect(r.outcome).toBe("pass");
    expect(existsSync(sentinel)).toBe(false);
    expect(exec.checkCalls[0].name).toBe("relay-ish-829-abcd1234");
  });
});

describe("sandboxLabctl: labctl runs inside the sandbox, not the host", () => {
  test("runs `labctl <args>` through sbx exec and reports failure on timeout", async () => {
    const exec = new FakeSbxExec();
    exec.command = (argv) =>
      argv[0] === "labctl"
        ? { code: 0, stdout: '{"lab":"x","nodes":[]}', stderr: "", timedOut: false }
        : { code: 0, stdout: "", stderr: "", timedOut: false };
    const labctl = sandboxLabctl(binding(exec));
    const ok = await labctl.run(["inspect", "x", "--json", "--api", "https://lab:8090"]);
    expect(ok.ok).toBe(true);
    expect(exec.checkCalls[0].argv[0]).toBe("labctl");
    expect(exec.checkCalls[0].name).toBe("relay-ish-829-abcd1234");

    exec.command = () => ({ code: null, stdout: "", stderr: "", timedOut: true });
    const bad = await labctl.run(["deploy", "-t", "t.clab.yml"]);
    expect(bad.ok).toBe(false);
    expect(bad.timedOut).toBe(true);
  });

  test("forwards the Lab credential env to `sbx exec -e`, never the host env", async () => {
    const exec = new FakeSbxExec();
    const labctl = sandboxLabctl(binding(exec), { LABCTL_TOKEN: "secret-token" });
    await labctl.run(["inspect", "x", "--json"]);
    expect(exec.checkCalls[0].env).toEqual({ LABCTL_TOKEN: "secret-token" });
  });
});

describe("other-task lab: a Task never inspects/destroys another Task's lab", () => {
  test("labctl is called with the Task's OWN lab name only", async () => {
    // ownership is enforced by `ownsLab`/`foreignLabError` (see tests/lab.test.ts);
    // here we assert the sandbox labctl wrapper never rewrites the target.
    const exec = new FakeSbxExec();
    const labctl = sandboxLabctl(binding(exec));
    await labctl.run(["inspect", "relay-other-task-ffffffff", "--json", "--api", "https://lab:8090"]);
    expect(exec.checkCalls[0].argv).toContain("relay-other-task-ffffffff");
  });
});

describe("sandboxVerifyTarget", () => {
  let dir = "";
  let db: Database;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relay-ish829-target-"));
    process.env.RELAY_DB = join(dir, "state.db");
    db = openDb(process.env.RELAY_DB);
    registerWorker(db, "impl", { role: "worker" });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function verifyTask(): string {
    const t = intakeTask(db, { provider: "test", issueId: `ISH-829-${Math.random()}`, codeChange: true, headSha: HEAD });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl");
    return t.id;
  }

  test("a task with no sandbox has no sandbox target (host fallback)", () => {
    const id = verifyTask();
    expect(sandboxVerifyTarget(db, getTask(db, id)!, [{ name: "a", command: "true" }])).toBeNull();
    // The default resolver (the Factory/daemon default) agrees: no row -> null,
    // so only a real Coding Sandbox row can ever pre-empt the host runner.
    expect(defaultVerifyTarget(db, getTask(db, id)!, [{ name: "a", command: "true" }])).toBeNull();
  });

  test("defaultVerifyTarget resolves a sandbox row to a non-null sandbox target", () => {
    const id = verifyTask();
    upsertSandbox(db, { taskId: id, name: "relay-ish-829-dflt", agent: "shell", source: "/repo", workspace: "/workspace/repo", branch: "main", headSha: HEAD, state: "running" });
    const target = defaultVerifyTarget(db, getTask(db, id)!, [{ name: "a", command: "true" }]);
    expect(target).not.toBeNull();
    expect(target!.sandbox).toBe("relay-ish-829-dflt");
  });

  test("a task with a live sandbox target binds to the sandbox + recorded head", () => {
    const id = verifyTask();
    upsertSandbox(db, {
      taskId: id,
      name: "relay-ish-829-live",
      agent: "shell",
      source: "/repo",
      workspace: "/workspace/repo",
      branch: "main",
      headSha: HEAD,
      state: "running",
    });
    const target = sandboxVerifyTarget(db, getTask(db, id)!, [{ name: "a", command: "true" }], {
      exec: new FakeSbxExec(),
      headProbe: () => HEAD,
    })!;
    expect(target.sandbox).toBe("relay-ish-829-live");
    expect(target.cwd).toBe("/workspace/repo");
    expect(target.headSha).toBe(HEAD);
  });

  test("a removed sandbox row yields a fail-closed target, never a host fallback", async () => {
    const id = verifyTask();
    upsertSandbox(db, {
      taskId: id,
      name: "relay-ish-829-dead",
      agent: "shell",
      source: "/repo",
      workspace: "/workspace/repo",
      branch: "main",
      headSha: HEAD,
      state: "removed",
    });
    const target = sandboxVerifyTarget(db, getTask(db, id)!, [{ name: "a", command: "true" }]);
    expect(target).not.toBeNull();
    const { outcome, task } = await runMechanicalVerification(db, id, {
      checks: [{ name: "a", command: "true" }],
      runner: target!.runner,
      cwd: target!.cwd,
      headSha: target!.headSha,
      headProbe: target!.headProbe,
    });
    expect(outcome).toBe("not_run");
    expect(task.phase).toBe("verify");
    expect(task.state).toBe("blocked_human");
  });

  test("a failed sandbox row yields a fail-closed target too", async () => {
    const id = verifyTask();
    upsertSandbox(db, { taskId: id, name: "relay-ish-829-failed", agent: "shell", source: "/repo", workspace: "/workspace/repo", branch: "main", headSha: HEAD, state: "failed" });
    const target = sandboxVerifyTarget(db, getTask(db, id)!, [{ name: "a", command: "true" }]);
    expect(target).not.toBeNull();
    const r = await target!.runner.run({ name: "a", command: "true", required: true }, { cwd: target!.cwd });
    expect(r.outcome).toBe("not_run");
    expect(r.output).toContain("failed");
  });

  test("a same-HEAD sandbox run reaches PASS and advances to review", async () => {
    const id = verifyTask();
    upsertSandbox(db, { taskId: id, name: "relay-ish-829-ok", agent: "shell", source: "/repo", workspace: "/workspace/repo", branch: "main", headSha: HEAD, state: "running" });
    const exec = new FakeSbxExec();
    const target = sandboxVerifyTarget(db, getTask(db, id)!, [{ name: "a", command: "true" }], { exec, headProbe: () => HEAD })!;
    const { outcome, task } = await runMechanicalVerification(db, id, {
      checks: [{ name: "a", command: "true" }],
      runner: target.runner,
      cwd: target.cwd,
      headSha: target.headSha,
      headProbe: target.headProbe,
    });
    expect(outcome).toBe("pass");
    expect(task.phase).toBe("review");
  });

  test("a HEAD mismatch inside the sandbox BLOCKS (never advances to review)", async () => {
    const id = verifyTask();
    upsertSandbox(db, { taskId: id, name: "relay-ish-829-bad", agent: "shell", source: "/repo", workspace: "/workspace/repo", branch: "main", headSha: HEAD, state: "running" });
    const exec = new FakeSbxExec();
    exec.headDefault = OTHER; // the clone is NOT at the recorded head
    const target = sandboxVerifyTarget(db, getTask(db, id)!, [{ name: "a", command: "true" }], { exec, headProbe: () => HEAD })!;
    const { outcome, task } = await runMechanicalVerification(db, id, {
      checks: [{ name: "a", command: "true" }],
      runner: target.runner,
      cwd: target.cwd,
      headSha: target.headSha,
      headProbe: target.headProbe,
    });
    expect(outcome).toBe("not_run");
    expect(isBlockingOutcome(outcome)).toBe(true);
    expect(task.phase).toBe("verify");
    expect(task.state).toBe("blocked_human");
  });

  test("a timeout inside the sandbox BLOCKS (never advances to review)", async () => {
    const id = verifyTask();
    upsertSandbox(db, { taskId: id, name: "relay-ish-829-to", agent: "shell", source: "/repo", workspace: "/workspace/repo", branch: "main", headSha: HEAD, state: "running" });
    const exec = new FakeSbxExec();
    exec.command = () => ({ code: null, stdout: "", stderr: "", timedOut: true });
    const target = sandboxVerifyTarget(db, getTask(db, id)!, [{ name: "a", command: "true" }], { exec, headProbe: () => HEAD })!;
    const { outcome, task } = await runMechanicalVerification(db, id, {
      checks: [{ name: "a", command: "true" }],
      runner: target.runner,
      cwd: target.cwd,
      headSha: target.headSha,
      headProbe: target.headProbe,
    });
    expect(outcome).toBe("not_run");
    expect(task.phase).toBe("verify");
    expect(task.state).toBe("blocked_human");
  });
});
