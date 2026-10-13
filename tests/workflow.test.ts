import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { MockRuntime } from "../src/runtime/runtime";
import { reconcile } from "../src/reconciler";
import { approveTask, claimNext, claimTask, getTask, runnableTasks, submitTask } from "../src/tasks";
import { registerWorker } from "../src/workers";
import {
  acceptTask,
  canStartPhase,
  derivePhase,
  intakeTask,
  isCodeTask,
  linkTask,
  recordChildBlocked,
  recordReview,
  recordVerification,
  reconcileRequestToken,
  requestReconcile,
  submitPhase,
} from "../src/workflow";

// ISH-758 minimal event-driven workflow core.
//
// Everything here is driven by the SQLite Task table + structured results; no
// GitHub/Linear API is involved (intake takes the provider/issue id as plain
// data). The claims go through the ordinary relay claim machine, which proves
// the workflow is implemented on the EXISTING daemon, not a new service.

let dir = "";
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-workflow-"));
  process.env.RELAY_DB = join(dir, "state.db");
  process.env.RELAY_LEASE_MS = "120000";
  db = openDb(process.env.RELAY_DB);
  registerWorker(db, "impl", { role: "worker" });
  registerWorker(db, "ver", { role: "worker" });
  registerWorker(db, "rev", { role: "reviewer" });
  registerWorker(db, "integ", { role: "integrator" });
});

afterEach(() => {
  delete process.env.RELAY_AUTO_APPROVE;
  delete process.env.RELAY_HUMAN;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Walk a fresh code task all the way to merge_ready via real phase results. */
function toMergeReady(id: string): void {
  claimTask(db, id, "impl");
  submitPhase(db, id, "impl");
  claimTask(db, id, "ver");
  recordVerification(db, id, "ver", { passed: true });
  const claimed = claimNext(db, "rev");
  expect(claimed?.id).toBe(id);
  recordReview(db, id, "rev", { verdict: "pass", headSha: getTask(db, id)!.head_sha ?? undefined });
  claimTask(db, id, "integ");
  submitPhase(db, id, "integ");
}

describe("idempotent intake keyed by (provider, issue, slice)", () => {
  test("a replayed intake yields exactly one task; a different slice is a different task", () => {
    const a = intakeTask(db, { provider: "linear", issueId: "ISH-758", slice: "core", codeChange: true, title: "core" });
    const again = intakeTask(db, { provider: "linear", issueId: "ISH-758", slice: "core", codeChange: true, title: "core" });
    expect(again.id).toBe(a.id);
    expect(isCodeTask(a)).toBe(true);
    expect(a.phase).toBe("implement");

    const other = intakeTask(db, { provider: "linear", issueId: "ISH-758", slice: "web", codeChange: true });
    const defaultSlice = intakeTask(db, { provider: "linear", issueId: "ISH-758" });
    expect(other.id).not.toBe(a.id);
    expect(defaultSlice.id).not.toBe(a.id);

    const n = db
      .query(`SELECT COUNT(*) AS n FROM tasks WHERE provider = 'linear' AND issue_id = 'ISH-758'`)
      .get() as { n: number };
    expect(n.n).toBe(3);
  });

  test("a replayed intake fills in a missing PR link instead of creating a row", () => {
    const a = intakeTask(db, { provider: "github", issueId: "owner/repo#12", codeChange: true });
    expect(a.pr_url).toBeNull();
    const linked = intakeTask(db, {
      provider: "github",
      issueId: "owner/repo#12",
      codeChange: true,
      prUrl: "https://example.test/pr/12",
      headSha: "aaa",
    });
    expect(linked.id).toBe(a.id);
    expect(linked.pr_url).toBe("https://example.test/pr/12");
    expect(linked.head_sha).toBe("aaa");
  });
});

describe("mandatory code-change gate", () => {
  test("an implement submit advances the phase; it never completes the task", () => {
    const t = intakeTask(db, { provider: "linear", issueId: "ISH-1", codeChange: true });
    claimTask(db, t.id, "impl");
    const after = submitPhase(db, t.id, "impl", { evidence: "implemented" });
    expect(after.state).not.toBe("done");
    expect(after.phase).toBe("verify");
    expect(after.state).toBe("queued");
  });

  test("relay approve cannot complete a code task, at any phase", () => {
    const t = intakeTask(db, { provider: "linear", issueId: "ISH-2", codeChange: true });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl");
    claimTask(db, t.id, "ver");
    recordVerification(db, t.id, "ver", { passed: true }); // -> review
    expect(() => approveTask(db, t.id, "supervisor")).toThrow(/code-change gate/i);
    expect(getTask(db, t.id)!.state).toBe("review");
  });

  test("the legacy submit shortcut is refused for a code task", () => {
    const t = intakeTask(db, { provider: "linear", issueId: "ISH-3", codeChange: true });
    claimTask(db, t.id, "impl");
    expect(() => submitTask(db, t.id, "impl")).toThrow(/code-change gate/i);
  });

  test("RELAY_AUTO_APPROVE does not drain a code task's review queue", async () => {
    process.env.RELAY_AUTO_APPROVE = "true";
    const rt = new MockRuntime();
    const t = intakeTask(db, { provider: "linear", issueId: "ISH-4", codeChange: true });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl");
    claimTask(db, t.id, "ver");
    recordVerification(db, t.id, "ver", { passed: true });

    const { actions } = await reconcile(db, rt);
    expect(actions).not.toContain(`auto-approved:${t.id}`);
    expect(getTask(db, t.id)!.state).toBe("review");
    expect(getTask(db, t.id)!.phase).toBe("review");
  });

  test("only TaskAccepted at merge_ready makes a code task done", () => {
    const t = intakeTask(db, { provider: "linear", issueId: "ISH-5", codeChange: true });
    toMergeReady(t.id);
    const ready = getTask(db, t.id)!;
    expect(ready.phase).toBe("merge_ready");
    expect(ready.state).toBe("queued");
    // Not offered to any worker at merge_ready.
    expect(runnableTasks(db).some((x) => x.id === t.id)).toBe(false);
    expect(claimNext(db, "integ")).toBeNull();
    // Accepting before merge_ready is refused; at merge_ready it completes.
    const done = acceptTask(db, t.id, "coordinator");
    expect(done.state).toBe("done");
    expect(done.accepted_at).not.toBeNull();
  });

  test("accept before merge_ready is refused", () => {
    const t = intakeTask(db, { provider: "linear", issueId: "ISH-6", codeChange: true });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl"); // -> verify
    expect(() => acceptTask(db, t.id, "coordinator")).toThrow(/merge_ready/i);
  });
});

describe("a transition makes the next phase runnable", () => {
  test("each structured result queues the very next phase", () => {
    const t = intakeTask(db, { provider: "linear", issueId: "ISH-7", codeChange: true });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl");
    // verify is now claimable by a worker.
    expect(getTask(db, t.id)!.phase).toBe("verify");
    expect(claimNext(db, "ver")?.id).toBe(t.id);
    recordVerification(db, t.id, "ver", { passed: true });
    // review is now claimable by the reviewer.
    expect(claimNext(db, "rev")?.id).toBe(t.id);
    recordReview(db, t.id, "rev", { verdict: "pass" });
    // integration is now claimable by the integrator.
    expect(getTask(db, t.id)!.phase).toBe("integration");
    expect(claimTask(db, t.id, "integ").state).toBe("running");
  });

  test("a state transition bumps the immediate-reconcile token", () => {
    const t = intakeTask(db, { provider: "linear", issueId: "ISH-8", codeChange: true });
    const afterIntake = reconcileRequestToken(db);
    expect(afterIntake).not.toBe("");
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl");
    expect(reconcileRequestToken(db)).not.toBe(afterIntake);
    const before = reconcileRequestToken(db);
    requestReconcile(db, "manual");
    expect(reconcileRequestToken(db)).not.toBe(before);
  });
});

describe("phase skipping and stale/duplicate results are refused", () => {
  test("a verification in the implement phase is refused (skipping a phase)", () => {
    const t = intakeTask(db, { provider: "linear", issueId: "ISH-9", codeChange: true });
    claimTask(db, t.id, "impl");
    expect(() => recordVerification(db, t.id, "impl", { passed: true })).toThrow(/phase 'implement'/i);
  });

  test("a review in a non-review phase is refused", () => {
    const t = intakeTask(db, { provider: "linear", issueId: "ISH-10", codeChange: true });
    claimTask(db, t.id, "impl");
    expect(() => recordReview(db, t.id, "rev", { verdict: "pass" })).toThrow(/phase implement/i);
  });

  test("a duplicate submission for the same task/phase/attempt is refused", () => {
    const t = intakeTask(db, { provider: "linear", issueId: "ISH-11", codeChange: true });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl");
    // Force the task back to the same phase/attempt to model a replayed dispatch.
    db.query(`UPDATE tasks SET phase = 'implement', state = 'running', assignee = 'impl', attempt = 0 WHERE id = ?`).run(t.id);
    expect(canStartPhase(db, t.id, "implement", 0)).toBe(false);
    expect(() => submitPhase(db, t.id, "impl")).toThrow(/DUPLICATE_DISPATCH/);
  });

  test("a stale lease token is refused", () => {
    const t = intakeTask(db, { provider: "linear", issueId: "ISH-12", codeChange: true });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl");
    claimTask(db, t.id, "ver");
    expect(() => recordVerification(db, t.id, "ver", { passed: true, leaseToken: 999 })).toThrow(/STALE_LEASE/);
  });

  test("a review of a moved HEAD is refused, and a PASS must name the HEAD", () => {
    const t = intakeTask(db, { provider: "linear", issueId: "ISH-13", codeChange: true, headSha: "aaa" });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl");
    claimTask(db, t.id, "ver");
    recordVerification(db, t.id, "ver", { passed: true });
    claimNext(db, "rev");
    expect(() => recordReview(db, t.id, "rev", { verdict: "pass", headSha: "bbb" })).toThrow(/HEAD_MISMATCH/);
    expect(() => recordReview(db, t.id, "rev", { verdict: "pass" })).toThrow(/HEAD_MISMATCH/);
  });

  test("the same PR+HEAD+profile is reviewed at most once", () => {
    const t = intakeTask(db, { provider: "linear", issueId: "ISH-14", codeChange: true, headSha: "aaa" });
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl");
    claimTask(db, t.id, "ver");
    recordVerification(db, t.id, "ver", { passed: true });
    claimNext(db, "rev");
    // First review on head aaa FAILS -> rework, head cleared.
    recordReview(db, t.id, "rev", { verdict: "fail", headSha: "aaa", reason: "nope" });
    expect(getTask(db, t.id)!.attempt).toBe(1);
    expect(getTask(db, t.id)!.head_sha).toBeNull();
    // Re-implement, re-verify, and re-review the SAME unchanged head.
    claimTask(db, t.id, "impl");
    submitPhase(db, t.id, "impl", { headSha: "aaa" });
    claimTask(db, t.id, "ver");
    recordVerification(db, t.id, "ver", { passed: true });
    claimNext(db, "rev");
    expect(() => recordReview(db, t.id, "rev", { verdict: "pass", headSha: "aaa" })).toThrow(/DUPLICATE_DISPATCH/);
    // A genuinely new head is reviewable: the PR moved to bbb.
    linkTask(db, t.id, { headSha: "bbb" });
    const ok = recordReview(db, t.id, "rev", { verdict: "pass", headSha: "bbb" });
    expect(ok.phase).toBe("integration");
  });
});

describe("child accepted/blocked notifies the Gateway only when needed", () => {
  test("children_ready is sent once, only after ALL children are accepted", () => {
    process.env.RELAY_HUMAN = "gateway";
    const parent = intakeTask(db, { provider: "linear", issueId: "ISH-15", codeChange: true });
    const c1 = intakeTask(db, { provider: "linear", issueId: "ISH-15", slice: "a", codeChange: true, parentTaskId: parent.id });
    const c2 = intakeTask(db, { provider: "linear", issueId: "ISH-15", slice: "b", codeChange: true, parentTaskId: parent.id });
    toMergeReady(c1.id);
    toMergeReady(c2.id);

    acceptTask(db, c1.id, "coordinator");
    const afterFirst = db
      .query(`SELECT COUNT(*) AS n FROM messages WHERE recipient = 'gateway' AND kind = 'children_ready'`)
      .get() as { n: number };
    expect(afterFirst.n).toBe(0); // not all children done yet -> not needed

    acceptTask(db, c2.id, "coordinator");
    const afterSecond = db
      .query(`SELECT COUNT(*) AS n FROM messages WHERE recipient = 'gateway' AND kind = 'children_ready'`)
      .get() as { n: number };
    expect(afterSecond.n).toBe(1);
  });

  test("a child block reaches the Gateway exactly once", () => {
    process.env.RELAY_HUMAN = "gateway";
    const parent = intakeTask(db, { provider: "linear", issueId: "ISH-16", codeChange: true });
    const child = intakeTask(db, { provider: "linear", issueId: "ISH-16", slice: "x", codeChange: true, parentTaskId: parent.id });

    expect(recordChildBlocked(db, child.id, "impl", "missing credentials")).toBe(true);
    expect(recordChildBlocked(db, child.id, "impl", "missing credentials")).toBe(false);
    const n = db
      .query(`SELECT COUNT(*) AS n FROM messages WHERE recipient = 'gateway' AND kind = 'child_blocked'`)
      .get() as { n: number };
    expect(n.n).toBe(1);
  });
});

describe("legacy tasks are untouched", () => {
  test("a non-code task keeps phase NULL and the legacy submit/approve flow", () => {
    const t = intakeTask(db, { provider: "linear", issueId: "ISH-17" }); // codeChange defaults to false
    expect(isCodeTask(t)).toBe(false);
    expect(derivePhase(t)).toBeNull();
    claimTask(db, t.id, "impl");
    const sub = submitTask(db, t.id, "impl", { evidence: "e" });
    expect(sub.state).toBe("review");
    // A reviewer claims the review and the legacy approve completes it.
    expect(claimNext(db, "rev")?.id).toBe(t.id);
    expect(approveTask(db, t.id, "rev").state).toBe("done");
  });
});

describe("CLI wiring (no GitHub/Linear API)", () => {
  test("task intake is idempotent and a structured result advances the phase", () => {
    const cli = (args: string[], worker = "impl"): string => {
      const r = Bun.spawnSync(["bun", "src/cli.ts", ...args], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, FORCE_COLOR: "0", RELAY_DB: process.env.RELAY_DB!, RELAY_WORKER: worker },
      });
      if (r.exitCode !== 0) throw new Error(`relay ${args.join(" ")} failed: ${r.stderr.toString()}`);
      return r.stdout.toString();
    };
    const first = cli(["task", "intake", "--provider", "linear", "--issue", "ISH-20", "--code-change"]);
    const replay = cli(["task", "intake", "--provider", "linear", "--issue", "ISH-20", "--code-change"]);
    const id = first.split(" ")[0];
    expect(replay.split(" ")[0]).toBe(id);

    cli(["claim", id], "impl");
    cli(["submit", id, "--evidence", "implemented"], "impl");
    cli(["claim", id], "ver");
    expect(cli(["result", "verify", id, "--pass"], "ver")).toContain("phase=review");
  });
});
