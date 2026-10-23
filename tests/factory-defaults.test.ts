import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  factoryGithubDepsFromEnv,
  type Exec,
  type ExecResult,
} from "../src/provider-adapters";
import { DSH_MODEL_BIN_RELATIVE, resolveDshBin } from "../src/dsh-runner";
import { DEFAULT_REVIEW_TIMEOUT_MS, reviewTimeoutMs } from "../src/reviewer-runner";

// ISH-1133: `relay run factory <T>` must work with no environment variables.
// These are the three defaults the Gateway used to set explicitly:
//   * the read-only gh provider (and the native review that needs it),
//   * the `$HOME/.dsh/bin/dsh-model` time-of-day wrapper (fallback `dsh`),
//   * a 45 min headless-review budget.
// Each env var remains an override; `RELAY_PROVIDER_GITHUB=off` stays the
// explicit test opt-out.

const ok = (stdout: string): ExecResult => ({ ok: true, stdout, stderr: "" });

/** A fake, authenticated gh: auth status succeeds and api user returns a login. */
function ghAuthed(seen: string[][] = []): Exec {
  return (argv) => {
    seen.push(argv);
    if (argv[0] === "gh" && argv[1] === "auth") return ok("Logged in to github.com\n");
    if (argv[0] === "gh" && argv[1] === "api" && argv[2] === "user") return ok("81ueman\n");
    return ok("{}");
  };
}

let dir = "";
let home = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-factory-defaults-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function installWrapper(mode = 0o755): string {
  const p = join(home, DSH_MODEL_BIN_RELATIVE);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 0.2.1-rc.2; exit 0; fi\nexit 0\n");
  chmodSync(p, mode);
  return p;
}

describe("ISH-1133: factory no-env defaults", () => {
  test("no env selects gh for BOTH PR binding and native review, the dsh-model wrapper, and 45 min", async () => {
    const wrapper = installWrapper();
    const deps = await factoryGithubDepsFromEnv({ HOME: home }, ghAuthed());

    // One detection feeds both legs: the native review reuses the provider
    // reader object, so "gh is auto-detected for PR binding but not for the
    // native-review leg" cannot happen.
    expect(deps.providers.github?.name).toBe("gh-cli");
    expect(deps.providers.checks).toBe(deps.providers.github);
    expect(deps.nativeReview?.github).toBe(deps.providers.github);
    expect(deps.nativeReview?.author).toBe("81ueman");
    expect(deps.nativeReview?.rateLimited).toBeUndefined();

    expect(resolveDshBin({ HOME: home })).toEqual({ bin: wrapper, source: "dsh-model" });
    expect(DEFAULT_REVIEW_TIMEOUT_MS).toBe(2_700_000);
    expect(reviewTimeoutMs({} as NodeJS.ProcessEnv)).toBe(2_700_000);
  });

  test("the dsh binary falls back to `dsh` when the wrapper is absent or not executable", () => {
    expect(resolveDshBin({ HOME: home })).toEqual({ bin: "dsh", source: "path" });

    installWrapper(0o644);
    expect(resolveDshBin({ HOME: home })).toEqual({ bin: "dsh", source: "path" });
  });

  test("each environment variable still overrides its native default", async () => {
    installWrapper();
    expect(resolveDshBin({ HOME: home, RELAY_DSH_BIN: "/opt/fake/dsh" })).toEqual({
      bin: "/opt/fake/dsh",
      source: "env",
    });
    expect(reviewTimeoutMs({ RELAY_REVIEW_TIMEOUT_MS: "60000" } as NodeJS.ProcessEnv)).toBe(60_000);

    // An explicit `gh` still forces the reader (and the reviewed author).
    const deps = await factoryGithubDepsFromEnv({ RELAY_PROVIDER_GITHUB: "gh" }, ghAuthed());
    expect(deps.providers.github?.name).toBe("gh-cli");
    expect(deps.nativeReview?.author).toBe("81ueman");
  });

  test("RELAY_PROVIDER_GITHUB=off disables the provider and the native review (no gh probe)", async () => {
    const seen: string[][] = [];
    const deps = await factoryGithubDepsFromEnv({ RELAY_PROVIDER_GITHUB: "off" }, ghAuthed(seen));

    expect(deps.providers.github).toBeUndefined();
    expect(deps.nativeReview).toBeUndefined();
    expect(seen).toEqual([]);
  });

  test("an authenticated gh with an unreadable login is an author failure, not 'not configured'", async () => {
    const exec: Exec = (argv) => {
      if (argv[0] === "gh" && argv[1] === "auth") return ok("Logged in to github.com\n");
      if (argv[0] === "gh" && argv[1] === "api" && argv[2] === "user") {
        return { ok: false, stdout: "", stderr: "token cannot read the user" };
      }
      return ok("{}");
    };
    const deps = await factoryGithubDepsFromEnv({}, exec);

    expect(deps.providers.github?.name).toBe("gh-cli");
    expect(deps.nativeReview).toBeDefined();
    expect(deps.nativeReview?.author).toBe("");
  });
});
