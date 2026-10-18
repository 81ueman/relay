import { describe, expect, test } from "bun:test";
import {
  AGENT_KINDS,
  AGENT_KINDS_HELP,
  harness,
  herdrKindOf,
  idlesViaPoll,
  inferKind,
  isKnownKind,
  resolveKind,
} from "../src/harness";

// T-HARNESS: the agent-kind registry replaces the old two-value
// `agent_kind === "codex"` special case. These tests pin the invariants the
// socket/identity/spawn paths rely on.

const CODEX_UUID = "01a0c405-70ba-7bf0-8522-98eba9dd5283";
const CLAUDE_UUID = "9030b285-ce54-4dbb-9b71-1719916a80d3";

describe("harness registry", () => {
  test("the three harnesses are registered with the expected idling mode", () => {
    expect(AGENT_KINDS).toEqual(["opencode", "codex", "claude"]);
    expect(AGENT_KINDS_HELP).toBe("opencode|codex|claude");
    expect(idlesViaPoll("opencode")).toBe(false);
    expect(idlesViaPoll("codex")).toBe(true);
    expect(idlesViaPoll("claude")).toBe(true);
    // Unknown kinds are never assumed to poll (fail closed).
    expect(idlesViaPoll("bogus")).toBe(false);
    expect(idlesViaPoll(null)).toBe(false);
  });

  test("herdr kinds: codex/claude/opencode have a start kind", () => {
    expect(herdrKindOf("claude")).toBe("claude");
    expect(harness("claude")!.herdrStartKind).toBe("claude");
    expect(harness("codex")!.herdrStartKind).toBe("codex");
    expect(harness("opencode")!.herdrStartKind).toBe("opencode");
    expect(isKnownKind("dsh")).toBe(false);
    expect(isKnownKind("nope")).toBe(false);
  });

  test("resolveKind: an undeclared opencode id is accepted by shape", () => {
    expect(resolveKind("ses_abc123")).toBe("opencode");
    expect(resolveKind("sh_1234")).toBeNull(); // shell id is never a session
  });

  test("resolveKind: a bare UUID is ambiguous and MUST be declared", () => {
    expect(resolveKind(CODEX_UUID)).toBeNull();
    expect(resolveKind(CODEX_UUID, "codex")).toBe("codex");
    expect(resolveKind(CLAUDE_UUID, "claude")).toBe("claude");
    // Declaring the WRONG kind for the id is refused.
    expect(resolveKind("sh_1234", "codex")).toBeNull();
    expect(resolveKind(CODEX_UUID, "bogus")).toBeNull();
  });

  test("inferKind: shape-based best guess, codex fallback for a bare UUID", () => {
    expect(inferKind("ses_abc123")).toBe("opencode");
    // A bare UUID defaults to codex (historical behavior); claude needs --kind.
    expect(inferKind(CODEX_UUID)).toBe("codex");
    expect(inferKind(CLAUDE_UUID)).toBe("codex");
  });
});
