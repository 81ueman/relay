import { closeSync, openSync, readSync, statSync } from "node:fs";
import { parseDshLine } from "./dsh-events";
import type { Run } from "./schema";

/**
 * ISH-1008: classified failure cause for a Run that a liveness sweep had to
 * finish (the launching coroutine is gone, so it never wrote the terminal row).
 *
 * The class is derived from the last bytes of the Run's OWN evidence logs — the
 * daemon does not guess from an exit code alone. A run whose stderr ends in
 * `ENOSPC` is evidence that the host disk filled; a run killed by a signal is
 * distinguished from an OOM kill where the log says so; everything else is
 * `unknown` (still surfaced, never hidden).
 */
export const RUN_FAILURE_CLASSES = ["ENOSPC", "OOM", "signal", "unknown"] as const;
export type RunFailureClass = (typeof RUN_FAILURE_CLASSES)[number];

/** How much of each evidence file the classifier reads from the END. */
export const DEFAULT_RUN_FAILURE_TAIL_BYTES = 64 * 1024;

/**
 * Disk-full signatures. `ENOSPC` is the exact errno dsh/Bun/git print; the
 * human strings cover a wrapped shell error, and `SQLITE_FULL` covers the
 * control-plane write that may have failed first.
 */
const ENOSPC_RE = /\bENOSPC\b|no space left on device|disk quota exceeded|\bEDQUOT\b|\bSQLITE_FULL\b/i;

/**
 * Memory-pressure signatures. A bare `Killed` is deliberately NOT here: that is
 * a signal, not proof of an OOM kill (a user/operator kill looks identical).
 */
const OOM_RE =
  /\bOOMKilled\b|out of memory|OutOfMemoryError|JavaScript heap out of memory|cannot allocate memory|\boom-kill\b|\bMemoryError\b/i;

/**
 * A signal left in the evidence. A shell reports a killed child as exactly
 * `Killed`/`Terminated`; a program may print `SIGTERM`/`SIGKILL`. (The kernel's
 * OOM line includes "Out of memory" and is caught as OOM FIRST.)
 */
const SIGNAL_RE =
  /^(?:Killed|Terminated|Quit)\s*$|killed by signal|terminated by signal|\bSIG(?:HUP|INT|QUIT|ABRT|KILL|SEGV|PIPE|TERM)\b/i;

export interface RunFailureInput {
  /** Tail of `<run>/stderr.log` (dsh reasoning/errors). */
  stderr?: string | null;
  /** Tail of `<run>/dsh.jsonl` (the original dsh JSONL evidence). */
  dshJsonl?: string | null;
  /**
   * The recorded `runs.signal`. Relay stores its CANCEL reason there ("timeout",
   * "cancelled", operator label); an explicit `SIG*` value is treated as a
   * signal, a cancel reason is reported as an unknown-cause death.
   */
  signal?: string | null;
  /** The recorded process exit code, when the row already has one. */
  exitCode?: number | null;
}

export interface RunFailure {
  class: RunFailureClass;
  /** One bounded evidence line (or a terse exit/signal description). */
  detail: string;
}

function oneLine(text: string, max = 240): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? "";
  return line.replace(/\s+/g, " ").slice(0, max);
}

/**
 * The LAST line in `text` that matches ANY failure class: the tail is read
 * precisely so the most recent evidence decides. If one line matches more than
 * one pattern, ENOSPC wins over OOM, and OOM over a bare signal, because that is
 * the most specific root cause on the same line.
 */
function lastClassMatch(
  text: string | null | undefined,
  classes: readonly { class: RunFailureClass; re: RegExp }[]
): RunFailure | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") continue;
    for (const { class: cls, re } of classes) {
      if (re.test(line)) return { class: cls, detail: oneLine(lines[i]) };
    }
  }
  return null;
}

/** The last element of `lines` matching any class (same "most recent wins"). */
function lastClassMatchIn(
  lines: readonly string[],
  classes: readonly { class: RunFailureClass; re: RegExp }[]
): RunFailure | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") continue;
    for (const { class: cls, re } of classes) {
      if (re.test(line)) return { class: cls, detail: oneLine(lines[i]) };
    }
  }
  return null;
}

/**
 * Extract only dsh ERROR events from `dsh.jsonl`. This file is per-Run evidence
 * and also holds `text`/`thinking`/`tool_call`/`tool_result` payloads such as
 * file reads, grep output and diffs. A Run that merely READ code or docs
 * mentioning `ENOSPC`/`SIGTERM`/`out of memory` must not be classified from that
 * content, so only a terminal `error` event is evidence of why the Run died.
 * A `final` event is a SUCCESS summary and is deliberately excluded for the same
 * reason (it can quote arbitrary tool output).
 */
function dshErrorEvidence(dshJsonl: string | null | undefined): string[] {
  if (!dshJsonl) return [];
  const out: string[] = [];
  for (const raw of dshJsonl.split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    const parsed = parseDshLine(raw);
    if (parsed.kind !== "event" || parsed.event.type !== "error") continue;
    const ev = parsed.event;
    const value = ev.message ?? ev.error ?? ev.text;
    if (typeof value === "string") {
      out.push(value);
    } else if (value !== undefined) {
      try {
        out.push(JSON.stringify(value));
      } catch {
        out.push(String(value));
      }
    } else {
      out.push(parsed.raw);
    }
  }
  return out;
}

function signalName(signalNumber: number): string {
  const names: Record<number, string> = {
    1: "SIGHUP",
    2: "SIGINT",
    3: "SIGQUIT",
    6: "SIGABRT",
    9: "SIGKILL",
    11: "SIGSEGV",
    13: "SIGPIPE",
    15: "SIGTERM",
  };
  return names[signalNumber] ?? `signal ${signalNumber}`;
}

/** Classify a Run failure from its evidence tails and recorded process outcome. */
export function classifyRunFailure(input: RunFailureInput): RunFailure {
  // STDERR IS THE AUTHORITATIVE SOURCE, ACROSS ALL CLASSES: it is the Run's own
  // process error stream. Only after stderr is exhausted do we consult dsh's
  // terminal error events, and those are parsed (never raw tool payloads). This
  // ordering is what stops a dsh.jsonl ENOSPC mention from overriding real
  // stderr evidence, and stops a tool result that READ the word "ENOSPC" from
  // being treated as the cause at all.
  //
  // Within a source the LAST matching line wins: the tail's most recent evidence
  // is what killed the Run. A class is only a tie-breaker for one line.
  const stderr = input.stderr ?? null;
  const dshErrors = dshErrorEvidence(input.dshJsonl);
  const classes: { class: RunFailureClass; re: RegExp }[] = [
    { class: "ENOSPC", re: ENOSPC_RE },
    { class: "OOM", re: OOM_RE },
    { class: "signal", re: SIGNAL_RE },
  ];
  const fromStderr = lastClassMatch(stderr, classes);
  if (fromStderr) return fromStderr;
  const fromDsh = lastClassMatchIn(dshErrors, classes);
  if (fromDsh) return fromDsh;
  // `runs.signal` is Relay's CANCEL reason ("timeout", "cancelled", an operator
  // label), not a POSIX signal; only an explicit SIG* value is treated as one.
  if (input.signal && /^SIG[A-Z0-9]+$/i.test(input.signal)) {
    return { class: "signal", detail: `signal ${input.signal}` };
  }
  const code = input.exitCode ?? null;
  if (code !== null && code > 128 && code <= 128 + 64) {
    return { class: "signal", detail: `exit ${code} (${signalName(code - 128)})` };
  }
  if (code !== null) {
    return { class: "unknown", detail: `exit ${code}; no ENOSPC/OOM signature in stderr.log or dsh.jsonl` };
  }
  if (input.signal) {
    return { class: "unknown", detail: `run ${input.signal}; no ENOSPC/OOM signature in stderr.log or dsh.jsonl` };
  }
  return { class: "unknown", detail: "no ENOSPC/OOM signature in stderr.log or dsh.jsonl" };
}

/**
 * Read at most `maxBytes` from the END of a file. Missing/unreadable/empty
 * paths yield `""`: a missing log is not evidence of any particular cause.
 */
export function readFileTail(path: string | null | undefined, maxBytes = DEFAULT_RUN_FAILURE_TAIL_BYTES): string {
  if (!path) return "";
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size === 0) return "";
    const len = Math.max(0, Math.min(st.size, Math.max(1, maxBytes)));
    const start = st.size - len;
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(len);
      const read = readSync(fd, buf, 0, len, start);
      return buf.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** Classify a durable Run row by reading the tails of its own evidence files. */
export function classifyRunDeath(
  run: Pick<Run, "stderr_path" | "dsh_events_path" | "signal" | "exit_code">,
  opts: { tailBytes?: number } = {}
): RunFailure {
  const maxBytes = opts.tailBytes ?? DEFAULT_RUN_FAILURE_TAIL_BYTES;
  return classifyRunFailure({
    stderr: readFileTail(run.stderr_path, maxBytes),
    dshJsonl: readFileTail(run.dsh_events_path, maxBytes),
    signal: run.signal,
    exitCode: run.exit_code,
  });
}

/**
 * Parse the class back out of a stored Run error. The sweep stores it as
 * `cause=ENOSPC: <detail>` in `runs.error`, so `relay run show` and the
 * dashboard can project it without re-reading the (possibly rotated) logs.
 */
export function parseRunFailureClass(error: string | null | undefined): RunFailureClass | null {
  if (!error) return null;
  const m = /(?:^|[;\s])cause=([A-Z]+)\b/.exec(error);
  if (!m) return null;
  return (RUN_FAILURE_CLASSES as readonly string[]).includes(m[1]) ? (m[1] as RunFailureClass) : null;
}
