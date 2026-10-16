/**
 * ISH-810 — dsh 0.2.0-rc.2 headless **JSONL execution events**.
 *
 * `dsh --profile headless --json <task>` (or `... --json - < task.md`) writes
 * newline-delimited JSON events to STDOUT: an initial `session`
 * (`sessionId`/`cwd`), `status` (turn/step phases + `turn_end` reason), `text`,
 * `thinking`, `tool_call`, `tool_result`, and a terminal `final` — or `error`
 * when a failure happens OUTSIDE a turn.
 *
 * This is a **bounded projection**, not a lossless Session log: strings are
 * capped (typically ≤8 KiB), a whole event is capped (≤32 KiB, terminal `final`
 * exempt) and truncated fields are flagged; tool results may contain sensitive
 * data. Relay records the ORIGINAL dsh JSONL as per-Run evidence (`dsh.jsonl`)
 * and keeps its OWN lifecycle log (`events.jsonl`) strictly distinct — synthetic
 * Relay events are never written as if they were dsh events.
 *
 * A `final` (or even a clean exit 0) is **not** Task approval: only a structured
 * `relay run submit` advances a Task. A parse/truncation problem is surfaced and
 * never manufactures a success.
 */

import { readFileSync } from "node:fs";

/** The event types dsh 0.2.0-rc.2 is known to emit. Unknown types are tolerated. */
export const DSH_EVENT_TYPES = [
  "session",
  "status",
  "text",
  "thinking",
  "tool_call",
  "tool_result",
  "final",
  "error",
] as const;

export type DshEventType = (typeof DSH_EVENT_TYPES)[number];

/** One decoded dsh JSONL event (kept verbatim; extra fields are preserved). */
export interface DshEvent {
  type: string;
  [k: string]: unknown;
}

/** The result of decoding ONE stdout line from a `--json` headless Run. */
export type DshLine =
  | { kind: "blank" }
  | { kind: "event"; event: DshEvent; raw: string }
  | { kind: "malformed"; raw: string; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Decode one line of dsh `--json` stdout. Never throws. A blank line is
 * `blank`; a JSON object with a string `type` is an `event` (unknown `type`s are
 * accepted so a future dsh event is not lost); anything else — including the
 * `[opencode-session-id] mounted: …` plugin banner dsh's profile prints before
 * the JSONL — is `malformed` and stays visible.
 */
export function parseDshLine(raw: string): DshLine {
  if (raw.trim() === "") return { kind: "blank" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "malformed", raw, error: "not JSON" };
  }
  if (!isRecord(parsed)) return { kind: "malformed", raw, error: "JSON is not an object" };
  if (typeof parsed.type !== "string" || parsed.type === "") {
    return { kind: "malformed", raw, error: "missing string `type`" };
  }
  return { kind: "event", event: parsed as DshEvent, raw };
}

/** The dsh Session id from a `session` event, else null. */
export function dshSessionId(event: DshEvent): string | null {
  if (event.type !== "session") return null;
  const id = event.sessionId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** True when a bounded-projection field was flagged truncated (either shape). */
export function isTruncated(event: DshEvent): boolean {
  if (event.truncated === true) return true;
  const fields = event.truncatedFields ?? event.truncated_fields;
  return Array.isArray(fields) ? fields.length > 0 : false;
}

/** The `turn_end` reason kind from a `status` event, else null. */
export function turnEndReason(event: DshEvent): string | null {
  if (event.type !== "status" || event.phase !== "turn_end") return null;
  const reason = event.reason;
  if (isRecord(reason) && typeof reason.kind === "string") return reason.kind;
  return null;
}

function clip(s: string, max = 200): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

function j(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * A single human-readable line for a dsh event — the read-only Run-history
 * view (`relay run logs`). Not a re-serialization: the raw JSONL stays the
 * evidence, this is only a rendering.
 */
export function formatDshEvent(event: DshEvent): string {
  const flag = isTruncated(event) ? " [truncated]" : "";
  switch (event.type) {
    case "session":
      return `session ${dshSessionId(event) ?? "?"} cwd=${j(event.cwd)}${flag}`;
    case "status": {
      const bits: string[] = [`status ${j(event.phase)}`];
      if (event.turn !== undefined) bits.push(`turn=${j(event.turn)}`);
      if (event.step !== undefined) bits.push(`step=${j(event.step)}`);
      const reason = turnEndReason(event);
      if (reason) bits.push(`reason=${reason}`);
      return bits.join(" ") + flag;
    }
    case "text":
      return `text "${clip(j(event.text))}"${flag}`;
    case "thinking":
      return `thinking "${clip(j(event.thinking ?? event.text))}"${flag}`;
    case "tool_call": {
      const call = event.callId !== undefined ? ` ${j(event.callId)}` : "";
      return `tool_call ${j(event.tool)}${call} input=${clip(j(event.input))}${flag}`;
    }
    case "tool_result": {
      const call = event.callId !== undefined ? ` ${j(event.callId)}` : "";
      const status = event.status !== undefined ? ` status=${j(event.status)}` : "";
      return `tool_result${call}${status} result=${clip(j(event.result))}${flag}`;
    }
    case "final":
      return `final "${clip(j(event.text))}"${flag}`;
    case "error":
      return `error: ${clip(j(event.message ?? event.error ?? event.text))}${flag}`;
    default:
      return `${event.type} ${clip(j(event))}${flag}`;
  }
}

/** Counters derived from a Run's dsh events (recorded on the terminal event). */
export interface DshEventCounts {
  total: number;
  session: number;
  status: number;
  text: number;
  thinking: number;
  toolCall: number;
  toolResult: number;
  final: number;
  error: number;
  malformed: number;
  truncated: number;
}

export function emptyDshCounts(): DshEventCounts {
  return {
    total: 0,
    session: 0,
    status: 0,
    text: 0,
    thinking: 0,
    toolCall: 0,
    toolResult: 0,
    final: 0,
    error: 0,
    malformed: 0,
    truncated: 0,
  };
}

/** Fold ONE parsed stdout line into the counters. */
export function countDshLine(counts: DshEventCounts, line: DshLine): void {
  if (line.kind === "blank") return;
  if (line.kind === "malformed") {
    counts.malformed += 1;
    return;
  }
  counts.total += 1;
  if (isTruncated(line.event)) counts.truncated += 1;
  switch (line.event.type) {
    case "session":
      counts.session += 1;
      break;
    case "status":
      counts.status += 1;
      break;
    case "text":
      counts.text += 1;
      break;
    case "thinking":
      counts.thinking += 1;
      break;
    case "tool_call":
      counts.toolCall += 1;
      break;
    case "tool_result":
      counts.toolResult += 1;
      break;
    case "final":
      counts.final += 1;
      break;
    case "error":
      counts.error += 1;
      break;
  }
}

/** Read a Run's persisted dsh JSONL evidence into events (skips malformed lines). */
export function readDshEvents(path: string): { event: DshEvent; raw: string }[] {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: { event: DshEvent; raw: string }[] = [];
  for (const raw of text.split("\n")) {
    const line = parseDshLine(raw);
    if (line.kind === "event") out.push({ event: line.event, raw: line.raw });
  }
  return out;
}
