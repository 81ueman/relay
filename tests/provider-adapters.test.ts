import { describe, expect, test } from "bun:test";
import {
  GhCliGitHub,
  LinearApiReadOnly,
  defaultExec,
  factoryNativeReviewDepsFromEnv,
  parseJsonStream,
  providerDepsFromEnv,
  providerExecTimeoutMs,
  type Exec,
  type ExecResult,
} from "../src/provider-adapters";

// Finding 6: the real adapters are read-only and unit-tested through an injected
// command executor (no `gh`, no network).

function scriptedExec(script: (argv: string[], opts?: { stdin?: Uint8Array }) => ExecResult): Exec {
  return (argv, opts) => script(argv, opts);
}

const ok = (stdout: string): ExecResult => ({ ok: true, stdout, stderr: "" });

describe("parseJsonStream", () => {
  test("decodes concatenated paginated JSON arrays", () => {
    const raw = `[{"a":1}] [{"b":2},{"b":3}]`;
    const parsed = parseJsonStream(raw);
    expect(parsed).toHaveLength(2);
    expect((parsed[0] as unknown[]).length).toBe(1);
    expect((parsed[1] as unknown[]).length).toBe(2);
  });

  test("ignores a malformed trailing page", () => {
    expect(parseJsonStream(`[{"a":1}] [{"b":`)).toHaveLength(1);
  });
});

describe("GhCliGitHub (GET-only)", () => {
  test("maps gh pr view JSON to a PrView and never passes a write verb", async () => {
    const seen: string[][] = [];
    const gh = new GhCliGitHub(
      scriptedExec((argv) => {
        seen.push(argv);
        return ok(
          JSON.stringify({
            number: 7,
            url: "https://github.com/o/r/pull/7",
            state: "MERGED",
            isDraft: false,
            headRefName: "feat/x",
            headRefOid: "cafe",
            baseRefName: "main",
            baseRefOid: "base",
            mergeable: "MERGEABLE",
            labels: [{ name: "needs-review" }],
            updatedAt: "2026-01-01T00:00:00Z",
          })
        );
      })
    );
    const v = (await gh.getPullRequest({ repo: "o/r", number: 7 }))!;
    expect(gh.readOnly).toBe(true);
    expect(v.state).toBe("merged");
    expect(v.headSha).toBe("cafe");
    expect(v.baseRef).toBe("main");
    expect(v.labels).toEqual(["needs-review"]);
    // Every invoked gh verb is a read.
    for (const argv of seen) {
      if (argv[0] === "gh" && argv[1] === "pr") expect(["view", "list"]).toContain(argv[2]);
      if (argv[0] === "gh" && argv[1] === "api") expect(argv.length).toBeGreaterThanOrEqual(3);
    }
    expect(seen[0].slice(0, 4)).toEqual(["gh", "pr", "view", "7"]);
  });

  test("maps gh pr list for a branch and returns null without it", async () => {
    const gh = new GhCliGitHub(
      scriptedExec((argv) =>
        argv[2] === "list"
          ? ok(JSON.stringify([{ number: 9, state: "OPEN", headRefName: "b", headRefOid: "abc" }]))
          : ok("[]")
      )
    );
    expect((await gh.findPullRequestForBranch("o/r", "b"))?.ref.number).toBe(9);
    const none = new GhCliGitHub(scriptedExec(() => ok("[]")));
    expect(await none.findPullRequestForBranch("o/r", "missing")).toBeNull();
  });

  test("collects comments from all three read endpoints", async () => {
    const gh = new GhCliGitHub(
      scriptedExec((argv) => {
        const path = argv[2] ?? "";
        if (path.includes("/issues/")) return ok(JSON.stringify([{ user: { login: "claude" }, created_at: "t1", body: "issue" }]));
        if (path.includes("/reviews")) return ok(JSON.stringify([{ user: { login: "claude" }, submitted_at: "t2", body: "review" }]));
        return ok(JSON.stringify([{ user: { login: "other" }, created_at: "t3", body: "inline" }]));
      })
    );
    const comments = await gh.listComments({ repo: "o/r", number: 7 });
    expect(comments?.map((c) => c.body)).toEqual(["issue", "review", "inline"]);
  });

  test("a failed read returns null / empty (fail closed)", async () => {
    const gh = new GhCliGitHub(scriptedExec(() => ({ ok: false, stdout: "", stderr: "no gh" })));
    expect(await gh.getPullRequest({ repo: "o/r", number: 1 })).toBeNull();
    expect(await gh.listComments({ repo: "o/r", number: 1 })).toBeNull();
  });

  test("a partial endpoint failure is a FAILED read (null), never a partial list", async () => {
    // The issue-comments endpoint succeeds, the reviews endpoint fails: the
    // stream is incomplete, so the whole read must report failure.
    const gh = new GhCliGitHub(
      scriptedExec((argv) => {
        const path = argv[2] ?? "";
        if (path.includes("/reviews")) return { ok: false, stdout: "", stderr: "502" };
        return ok(JSON.stringify([{ user: { login: "claude" }, created_at: "t", body: "x" }]));
      })
    );
    expect(await gh.listComments({ repo: "o/r", number: 1 })).toBeNull();
  });
});

describe("LinearApiReadOnly (GET-only GraphQL query)", () => {
  test("maps an issue and only ever POSTs a query; the token rides stdin, never argv", async () => {
    let argv: string[] = [];
    let stdin = "";
    const lin = new LinearApiReadOnly(
      "tok",
      scriptedExec((a, opts) => {
        argv = a;
        stdin = opts?.stdin ? new TextDecoder().decode(opts.stdin) : "";
        return ok(
          JSON.stringify({ data: { issue: { id: "ISH-1", state: { name: "In Progress" }, labels: { nodes: [{ name: "hold" }] } } } })
        );
      })
    );
    const issue = (await lin.getIssue("ISH-1"))!;
    expect(lin.readOnly).toBe(true);
    expect(issue.state).toBe("In Progress");
    expect(issue.labels).toEqual(["hold"]);
    const sent = argv.join(" ");
    expect(sent).toContain("query");
    expect(sent).not.toContain("mutation");
    // The token is NOT on argv (not readable via ps); it rides stdin.
    expect(sent).not.toContain("tok");
    expect(argv).toContain("@-");
    expect(stdin).toContain("Authorization: tok");
  });

  test("fails closed on a bad body", async () => {
    const lin = new LinearApiReadOnly("tok", scriptedExec(() => ok("not json")));
    expect(await lin.getIssue("ISH-1")).toBeNull();
  });
});

describe("providerDepsFromEnv (opt-in, deny-by-default)", () => {
  test("default: no providers, authority denied, default reviewer", async () => {
    const deps = await providerDepsFromEnv({});
    expect(deps.github).toBeUndefined();
    expect(deps.linear).toBeUndefined();
    expect(deps.authority).toEqual({ linearWrite: false, merge: false });
    expect(deps.authorizedReviewers).toEqual(["claude"]);
  });

  test("opt-in enables the read-only readers and the authorized reviewer list", async () => {
    const deps = await providerDepsFromEnv(
      {
        RELAY_PROVIDER_GITHUB: "gh",
        RELAY_PROVIDER_LINEAR: "api",
        LINEAR_API_TOKEN: "tok",
        RELAY_REVIEW_AUTHORIZED: "claude, second-reviewer",
      },
      scriptedExec(() => ok("{}"))
    );
    expect(deps.github?.name).toBe("gh-cli");
    expect(deps.github?.readOnly).toBe(true);
    expect(deps.linear?.name).toBe("linear-api");
    expect(deps.authorizedReviewers).toEqual(["claude", "second-reviewer"]);
    // Enabling a reader never grants a write or a merge.
    expect(deps.authority.merge).toBe(false);
    expect(deps.authority.linearWrite).toBe(false);
  });

  test("the Linear reader needs a token", async () => {
    const deps = await providerDepsFromEnv({ RELAY_PROVIDER_LINEAR: "api" });
    expect(deps.linear).toBeUndefined();
  });
});

describe("ISH-1087 provider auto-detection (read-only, fail closed)", () => {
  const ghAuthed = (seen: string[][] = []): Exec =>
    scriptedExec((argv) => {
      seen.push(argv);
      if (argv[0] === "gh" && argv[1] === "auth") return ok("Logged in to github.com\n");
      if (argv[0] === "gh" && argv[1] === "api" && argv[2] === "user") return ok("81ueman\n");
      return ok("{}");
    });

  test("an unset RELAY_PROVIDER_GITHUB auto-detects an authenticated gh only when asked", async () => {
    const auto = await providerDepsFromEnv({}, ghAuthed(), { autoGithub: true });
    expect(auto.github?.name).toBe("gh-cli");
    expect(auto.checks?.name).toBe("gh-cli");
    // The library default stays explicit-only (no surprise subprocess).
    expect((await providerDepsFromEnv({}, ghAuthed())).github).toBeUndefined();
  });

  test("an explicit off disables auto-detection; a failed probe or unknown value has no reader", async () => {
    expect((await providerDepsFromEnv({ RELAY_PROVIDER_GITHUB: "off" }, ghAuthed(), { autoGithub: true })).github).toBeUndefined();
    expect((await providerDepsFromEnv({ RELAY_PROVIDER_GITHUB: "typo" }, ghAuthed(), { autoGithub: true })).github).toBeUndefined();
    const failing = scriptedExec(() => ({ ok: false, stdout: "", stderr: "not logged in" }));
    expect((await providerDepsFromEnv({}, failing, { autoGithub: true })).github).toBeUndefined();
  });

  test("the Factory's native-review deps default ON and derive the author from gh", async () => {
    const seen: string[][] = [];
    const deps = await factoryNativeReviewDepsFromEnv({}, ghAuthed(seen));
    expect(deps?.author).toBe("81ueman");
    expect(deps?.github?.name).toBe("gh-cli");
    expect(deps?.allowedTools).toContain("Bash");
    expect(seen.some((a) => a[0] === "gh" && a[1] === "auth")).toBe(true);
    expect(seen.some((a) => a[0] === "gh" && a[1] === "api" && a[2] === "user")).toBe(true);
    // The review WRITE grant is still an explicit opt-out: 0 disables it.
    expect(await factoryNativeReviewDepsFromEnv({ RELAY_GITHUB_REVIEW_WRITE: "0" }, ghAuthed())).toBeUndefined();
    // An explicit author wins over the gh lookup.
    expect(
      (await factoryNativeReviewDepsFromEnv({ RELAY_REVIEW_AUTHOR: "reviewer-login" }, ghAuthed()))?.author
    ).toBe("reviewer-login");
  });
});

describe("ISH-1125: a provider command is time-bounded", () => {
  test("providerExecTimeoutMs defaults to 5s and rejects non-positive/non-numeric values", () => {
    expect(providerExecTimeoutMs({})).toBe(5000);
    expect(providerExecTimeoutMs({ RELAY_PROVIDER_EXEC_TIMEOUT_MS: "1500" })).toBe(1500);
    expect(providerExecTimeoutMs({ RELAY_PROVIDER_EXEC_TIMEOUT_MS: "0" })).toBe(5000);
    expect(providerExecTimeoutMs({ RELAY_PROVIDER_EXEC_TIMEOUT_MS: "-1" })).toBe(5000);
    expect(providerExecTimeoutMs({ RELAY_PROVIDER_EXEC_TIMEOUT_MS: "nope" })).toBe(5000);
  });

  test("defaultExec kills a hung command instead of blocking the caller forever", async () => {
    const prev = process.env.RELAY_PROVIDER_EXEC_TIMEOUT_MS;
    process.env.RELAY_PROVIDER_EXEC_TIMEOUT_MS = "150";
    try {
      const started = Date.now();
      const hung = await defaultExec(["sh", "-c", "sleep 5"]);
      expect(hung.ok).toBe(false);
      expect(Date.now() - started).toBeLessThan(3000);
      // A fast command still succeeds unchanged.
      expect((await defaultExec(["sh", "-c", "printf ok"])).stdout).toBe("ok");
    } finally {
      if (prev === undefined) delete process.env.RELAY_PROVIDER_EXEC_TIMEOUT_MS;
      else process.env.RELAY_PROVIDER_EXEC_TIMEOUT_MS = prev;
    }
  });
});

describe("ISH-1129: daemon shutdown aborts an in-flight provider command", () => {
  test("aborting the signal kills a hung command without waiting for the timeout", async () => {
    const prev = process.env.RELAY_PROVIDER_EXEC_TIMEOUT_MS;
    // A LONG timeout: the abort, not the per-command budget, must release it.
    process.env.RELAY_PROVIDER_EXEC_TIMEOUT_MS = "30000";
    try {
      const ac = new AbortController();
      const started = Date.now();
      const pending = defaultExec(["sh", "-c", "sleep 30"], { signal: ac.signal });
      setTimeout(() => ac.abort(), 100);
      const r = await pending;
      expect(r.ok).toBe(false);
      expect(r.stderr).toContain("aborted");
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      if (prev === undefined) delete process.env.RELAY_PROVIDER_EXEC_TIMEOUT_MS;
      else process.env.RELAY_PROVIDER_EXEC_TIMEOUT_MS = prev;
    }
  });

  test("stdin bytes are delivered to the child (the Linear token path)", async () => {
    const r = await defaultExec(["sh", "-c", "cat"], {
      stdin: new TextEncoder().encode("Authorization: tok\n"),
    });
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("Authorization: tok\n");
  });

  test("an already-aborted signal never spawns the command", async () => {
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    const r = await defaultExec(["sh", "-c", "sleep 30"], { signal: ac.signal });
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("aborted");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
