import { describe, expect, test } from "bun:test";
import {
  countDshLine,
  dshSessionId,
  emptyDshCounts,
  formatDshEvent,
  isTruncated,
  parseDshLine,
  turnEndReason,
  type DshEvent,
} from "../src/dsh-events";

// ISH-810 — the dsh 0.2.0-rc.2 `--json` JSONL decoder. Pure functions; no dsh,
// no network. Proves a bounded projection is decoded safely and that a
// malformed/truncated line is surfaced, never silently accepted as an event.

describe("parseDshLine", () => {
  test("a known event is decoded with its payload preserved", () => {
    const line = parseDshLine('{"type":"tool_call","callId":"call_1","tool":"read","input":{"file_path":"x"}}');
    expect(line.kind).toBe("event");
    if (line.kind !== "event") throw new Error("unreachable");
    expect(line.event.tool).toBe("read");
    expect((line.event.input as { file_path: string }).file_path).toBe("x");
  });

  test("an unknown future event type is tolerated, not dropped", () => {
    const line = parseDshLine('{"type":"usage","tokens":5}');
    expect(line.kind).toBe("event");
  });

  test("a blank line is blank (not malformed)", () => {
    expect(parseDshLine("   ").kind).toBe("blank");
    expect(parseDshLine("").kind).toBe("blank");
  });

  test("non-JSON (the profile banner) and a truncated JSON line are malformed", () => {
    const banner = parseDshLine("[opencode-session-id] mounted: providers=[opencode]");
    expect(banner).toMatchObject({ kind: "malformed", error: "not JSON" });
    const broken = parseDshLine('{"type":"text","text":"oops');
    expect(broken).toMatchObject({ kind: "malformed", error: "not JSON" });
  });

  test("JSON that is not an object, or lacks a string `type`, is malformed", () => {
    expect(parseDshLine("[1,2,3]")).toMatchObject({ kind: "malformed", error: "JSON is not an object" });
    expect(parseDshLine('"a string"')).toMatchObject({ kind: "malformed", error: "JSON is not an object" });
    expect(parseDshLine('{"type":7}')).toMatchObject({ kind: "malformed", error: "missing string `type`" });
    expect(parseDshLine("{}")).toMatchObject({ kind: "malformed", error: "missing string `type`" });
  });
});

describe("dsh event helpers", () => {
  test("session id comes only from a session event", () => {
    const session: DshEvent = { type: "session", sessionId: "session-abc", cwd: "/w" };
    expect(dshSessionId(session)).toBe("session-abc");
    expect(dshSessionId({ type: "text", sessionId: "nope" })).toBeNull();
    expect(dshSessionId({ type: "session" })).toBeNull();
  });

  test("turn_end reason is read from a status event", () => {
    expect(turnEndReason({ type: "status", phase: "turn_end", reason: { kind: "completed" } })).toBe("completed");
    expect(turnEndReason({ type: "status", phase: "turn_start" })).toBeNull();
  });

  test("truncation is flagged in either shape", () => {
    expect(isTruncated({ type: "text", truncated: true })).toBe(true);
    expect(isTruncated({ type: "text", truncatedFields: ["text"] })).toBe(true);
    expect(isTruncated({ type: "text" })).toBe(false);
  });

  test("formatDshEvent renders a readable chronology line per type", () => {
    expect(formatDshEvent({ type: "session", sessionId: "session-x", cwd: "/w" })).toContain("session session-x");
    expect(formatDshEvent({ type: "tool_call", tool: "read", callId: "c1", input: { file_path: "a" } })).toContain(
      "tool_call read c1"
    );
    expect(formatDshEvent({ type: "tool_result", callId: "c1", status: "completed", result: "hi" })).toContain(
      "tool_result c1 status=completed"
    );
    expect(formatDshEvent({ type: "final", text: "done" })).toBe('final "done"');
    expect(formatDshEvent({ type: "text", text: "x", truncated: true })).toContain("[truncated]");
    expect(formatDshEvent({ type: "error", message: "boom" })).toContain("error: boom");
  });

  test("countDshLine folds a decoded line into the counters", () => {
    const c = emptyDshCounts();
    countDshLine(c, parseDshLine('{"type":"session","sessionId":"s","cwd":"/w"}'));
    countDshLine(c, parseDshLine('{"type":"tool_call","tool":"read","callId":"c"}'));
    countDshLine(c, parseDshLine('{"type":"tool_result","callId":"c","result":"ok"}'));
    countDshLine(c, parseDshLine('{"type":"text","text":"hi","truncated":true}'));
    countDshLine(c, parseDshLine("garbage"));
    countDshLine(c, parseDshLine(""));
    expect(c).toMatchObject({ total: 4, session: 1, toolCall: 1, toolResult: 1, text: 1, truncated: 1, malformed: 1 });
  });
});
