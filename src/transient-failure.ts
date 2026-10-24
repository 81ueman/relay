/**
 * ISH-1174 — the TRANSIENT failure class for the Factory.
 *
 * A short provider/network outage used to stop three ishiul factory lanes with
 * `CODING_FAILED` / `UNKNOWN_CAUSE`; a re-run was refused and the only re-entry
 * discarded the live worktree/session. This module is the SMALL, conservative
 * judge that recognises the recoverable infrastructure class from evidence the
 * Run ALREADY recorded (the durable Run row, its dsh JSONL and stderr) and the
 * reviewer process's raw output. It owns no state machine and mutates nothing.
 *
 * TRANSIENT means: the provider answered HTTP 5xx or 429, the transport failed
 * (connection reset/refused/timeout/DNS/stream), or a dsh `turn_end` failed with
 * a provider/transport error. Everything else — auth, permission, ENOSPC and
 * other resource exhaustion, cancellation, and genuinely unknown causes — keeps
 * the fail-closed classification it has today.
 */

import type { Database } from "bun:sqlite";
import type { Run } from "./schema";
import { dshProviderStatus, readDshEvents, turnEndReason } from "./dsh-events";
import { readEvidenceTail } from "./implement-recovery";

/** Emitted while the Factory is waiting for the provider to come back. */
export const FACTORY_WAITING_TRANSIENT = "factory.waiting_transient";
/** Emitted when a failed IMPLEMENT Run is continued in the SAME session/worktree. */
export const FACTORY_RUN_RESUMED = "factory.run_resumed";
/** Emitted when a transient REVIEW_PROCESS_FAILED is re-run at the same head. */
export const FACTORY_REVIEW_RESUMED = "factory.review_resumed";

export type TransientCause =
  | "provider_http_5xx"
  | "provider_http_429"
  | "provider_transport"
  | "turn_end_provider_error";

export interface TransientFailure {
  transient: boolean;
  /** The concrete class, or a non-transient veto (`auth`, `enospc`, …). */
  cause: TransientCause | null;
  /** The provider HTTP status when the evidence carries a structured one. */
  status: number | null;
  /** A one-line, human-readable cause for the resume prompt / events. */
  detail: string | null;
  /** Bounded lines that matched, suitable for a durable event/step. */
  evidence: string[];
  /** Why a transient-looking text was nevertheless NOT treated as transient. */
  veto?: "auth" | "enospc" | "permission" | "cancelled" | "timeout" | "unknown";
}

const AUTH_MARKER =
  /\bMISSING_CREDENTIAL\b|\bunauthori[sz]ed\b|\bforbidden\b|authentication (?:failed|required)|(?:invalid|missing|expired|revoked|bad)[ _-]?(?:api[ _-]?key|credential|token)|no (?:api[ _-]?key|credential)|api[ _-]?key (?:is )?(?:invalid|missing|expired|not set|required)|token (?:expired|invalid)|login required|\b401\b|\b403\b/i;

const ENOSPC_MARKER =
  /\bENOSPC\b|no space left on device|disk (?:is )?full|quota exceeded|insufficient (?:free )?(?:disk|space)/i;

const PERMISSION_MARKER = /\bEACCES\b|\bEPERM\b|permission denied|operation not permitted|read-only file system|access denied/i;

const HTTP_429_MARKER =
  /\b(?:HTTP(?:\s+status)?|status(?:\s*code)?|statusCode|API(?:\s+error)?)\s*["']?\s*[:=]\s*["']?429\b|\b429\s+(?:Too Many Requests|Rate Limit)|\btoo many requests\b/i;

/**
 * A non-auth 4xx (400/404/405/409/410/413/414/415/422/425) is a BAD REQUEST,
 * not an outage: resume would repeat it. 408 (request timeout) is transport and
 * 429 is handled above as retryable.
 */
const HTTP_4XX_BAD_MARKER =
  /\b(?:HTTP(?:\s+status)?|status(?:\s*code)?|statusCode|API(?:\s+error)?)\s*["']?\s*[:=]\s*["']?(?:400|404|405|409|410|413|414|415|422|425)\b/i;

const HTTP_5XX_MARKER =
  /\b(?:HTTP(?:\s+status)?|status(?:\s*code)?|statusCode|API(?:\s+error)?|upstream(?:\s+error)?)\s*["']?\s*[:=]\s*["']?5\d\d\b|\b5\d\d\s+(?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out|Server Error)\b|\b(?:internal server error|bad gateway|service unavailable|gateway time-?out)\b/i;

const CONNECTION_MARKER =
  /\bECONNRESET\b|\bECONNREFUSED\b|\bECONNABORTED\b|\bETIMEDOUT\b|\bEPIPE\b|\bENETUNREACH\b|\bENETDOWN\b|\bEAI_AGAIN\b|connection[- ](?:reset|refused|closed|aborted|error|failed)|socket hang ?up|network (?:error|unreachable|is down)|fetch failed|TLS (?:handshake|error)|getaddrinfo|temporary failure in name resolution|DNS (?:error|lookup failed)|client network socket disconnected/i;

/** A provider/transport failure reported as a failed turn (not a bare "error"). */
const PROVIDER_TRANSPORT_MARKER =
  /\bPROVIDER_(?:ERROR|FAILED|FAILURE|UNAVAILABLE|TIMEOUT|OVERLOADED)\b|\bprovider\b[^\n]{0,120}\b(?:error|failed|failure|unreachable|timeout|timed out|overloaded|unavailable)\b|\bupstream\b[^\n]{0,120}\b(?:error|failed|failure|unreachable|timeout|overloaded|unavailable)\b|\bstream (?:error|closed|reset|aborted)\b|\bAPI error\b|\bmodel (?:error|overloaded|unavailable)\b|\boverloaded_error\b|\bservice overloaded\b|\bprovider request failed\b|\brequest failed\b[^\n]{0,80}\b(?:provider|upstream|network|transport)\b/i;

/** Evidence that a `--session-id` adoption was refused by dsh itself. */
const SESSION_UNADOPTABLE_MARKER =
  /unknown session|no such session|unrecognized (?:option|argument|flag)s?[^\n]{0,80}--session-id|--session-id[^\n]{0,80}(?:unrecognized|unsupported|invalid|unknown)|session (?:id )?(?:is )?(?:not found|does not exist|invalid|corrupt|expired|unreadable|failed to load|failed to resume)|invalid session|cannot (?:resume|load|open|adopt) (?:the )?session|could not (?:find|load|open|resume)[^\n]{0,60}session|failed to (?:read|load|open|resume) (?:the )?session|\bsession\b[^\n]{0,80}\bENOENT\b/i;

function oneLine(value: string | null | undefined, max = 300): string | null {
  if (!value) return null;
  const one = value.replace(/\s+/g, " ").trim();
  if (!one) return null;
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

function nonTransient(fields: Partial<TransientFailure> = {}): TransientFailure {
  return { transient: false, cause: null, status: null, detail: null, evidence: [], ...fields };
}

/** The provider-shaped fields of one Run's EXISTING dsh evidence. */
export interface RunProviderEvidence {
  statuses: number[];
  turnEnd: string | null;
  turnEndCode: string | null;
  turnEndMessage: string | null;
  errors: string[];
  finalText: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Read the provider/turn evidence from a Run's dsh JSONL. Bounded and
 * best-effort: a missing/unreadable file yields empty evidence, never a throw.
 */
export function readRunProviderEvidence(path: string | null | undefined): RunProviderEvidence {
  const out: RunProviderEvidence = {
    statuses: [],
    turnEnd: null,
    turnEndCode: null,
    turnEndMessage: null,
    errors: [],
    finalText: null,
  };
  if (!path) return out;
  for (const { event } of readDshEvents(path)) {
    const status = dshProviderStatus(event);
    if (status !== null) out.statuses.push(status);
    const kind = turnEndReason(event);
    if (kind) out.turnEnd = kind;
    if (event.type === "status" && event.phase === "turn_end" && isRecord(event.reason)) {
      const error = event.reason.error;
      if (isRecord(error)) {
        if (typeof error.code === "string" && error.code) out.turnEndCode = error.code;
        if (typeof error.message === "string" && error.message) out.turnEndMessage = error.message;
      }
    }
    if (event.type === "error") {
      const message = event.message ?? event.error ?? event.text;
      if (typeof message === "string" && message) out.errors.push(message);
    }
    if (event.type === "final" && typeof event.text === "string" && event.text.trim()) {
      out.finalText = event.text;
    }
  }
  return out;
}

export interface TransientEvidenceInput {
  /** Bounded error/transport text (Factory error, Run error, stderr, turn error). */
  text: string;
  /** Structured HTTP statuses from dsh events (if any). */
  statuses?: readonly number[];
  /** The last dsh `turn_end` reason kind. */
  turnEnd?: string | null;
}

/**
 * Classify one body of evidence. Pure: the SAME input always yields the SAME
 * class, so the Factory and its tests can reason about it without a process.
 *
 * The non-transient vetoes are checked FIRST: an authorization/permission/disk
 * failure is never auto-resumed even when the message also mentions a retryable
 * status (a 401 is permanent, a full disk is local).
 */
export function classifyTransientEvidence(input: TransientEvidenceInput): TransientFailure {
  const text = input.text ?? "";
  const statuses = input.statuses ?? [];
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const match = (re: RegExp): string | null => lines.find((l) => re.test(l)) ?? (re.test(text) ? text.trim().slice(0, 300) : null);

  if (statuses.some((s) => s === 401 || s === 403) || AUTH_MARKER.test(text)) {
    return nonTransient({ veto: "auth", evidence: bounded([match(AUTH_MARKER)]) });
  }
  if (ENOSPC_MARKER.test(text)) {
    return nonTransient({ veto: "enospc", evidence: bounded([match(ENOSPC_MARKER)]) });
  }
  if (PERMISSION_MARKER.test(text)) {
    return nonTransient({ veto: "permission", evidence: bounded([match(PERMISSION_MARKER)]) });
  }
  const status4xx = statuses.find((s) => s >= 400 && s < 500 && s !== 408 && s !== 429) ?? null;
  if (status4xx !== null || HTTP_4XX_BAD_MARKER.test(text)) {
    return nonTransient({ veto: "unknown", evidence: bounded([status4xx !== null ? `status=${status4xx}` : null, match(HTTP_4XX_BAD_MARKER)]) });
  }
  const status408 = statuses.find((s) => s === 408) ?? null;
  if (status408 !== null) {
    return {
      transient: true,
      cause: "provider_transport",
      status: status408,
      detail: `provider HTTP ${status408} (request timeout)`,
      evidence: bounded([`status=${status408}`]),
    };
  }

  const status429 = statuses.find((s) => s === 429) ?? null;
  const status5xx = statuses.find((s) => s >= 500 && s <= 599) ?? null;
  if (status429 !== null || HTTP_429_MARKER.test(text)) {
    const detail = status429 !== null ? `provider HTTP ${status429} (too many requests)` : "provider HTTP 429 (too many requests)";
    return {
      transient: true,
      cause: "provider_http_429",
      status: status429 ?? 429,
      detail,
      evidence: bounded([status429 !== null ? `status=${status429}` : null, match(HTTP_429_MARKER)]),
    };
  }
  if (status5xx !== null || HTTP_5XX_MARKER.test(text)) {
    const detail = status5xx !== null ? `provider HTTP ${status5xx} (server error)` : "provider HTTP 5xx (server error)";
    return {
      transient: true,
      cause: "provider_http_5xx",
      status: status5xx,
      detail,
      evidence: bounded([status5xx !== null ? `status=${status5xx}` : null, match(HTTP_5XX_MARKER)]),
    };
  }
  const connection = match(CONNECTION_MARKER);
  if (connection) {
    return {
      transient: true,
      cause: "provider_transport",
      status: null,
      detail: `network/transport failure: ${oneLine(connection, 200)}`,
      evidence: bounded([connection]),
    };
  }
  if (input.turnEnd === "error" && PROVIDER_TRANSPORT_MARKER.test(text)) {
    const providerError = match(PROVIDER_TRANSPORT_MARKER);
    return {
      transient: true,
      cause: "turn_end_provider_error",
      status: null,
      detail: `dsh turn_end error: ${oneLine(providerError, 200)}`,
      evidence: bounded([providerError]),
    };
  }
  return nonTransient({ veto: "unknown" });
}

function bounded(lines: (string | null)[]): string[] {
  return lines.filter((l): l is string => !!l).slice(0, 6);
}

/**
 * The provider statuses Relay already wrote into the Run's terminal `dsh.run.*`
 * event (the T294 evidence shape: `"dsh":{… "status":500 …}`). The per-Run JSONL
 * is the primary source, but the event is a durable second record after a
 * partial terminal write, so it is read too.
 */
export function readDshRunEventStatuses(db: Database, runId: string): number[] {
  const rows = db
    .query(
      `SELECT payload_json FROM events
        WHERE type IN ('dsh.run.failed','dsh.run.exited','dsh.run.timeout','dsh.run.cancelled')
          AND json_extract(payload_json, '$.runId') = ?
        ORDER BY id DESC LIMIT 8`
    )
    .all(runId) as { payload_json: string }[];
  const out: number[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const v of value) visit(v, depth + 1);
      return;
    }
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key === "status" || key === "statusCode" || key === "httpStatus" || key === "dshStatus") {
        if (typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 599) out.push(v);
      }
      visit(v, depth + 1);
    }
  };
  for (const row of rows) {
    try {
      visit(JSON.parse(row.payload_json), 0);
    } catch {
      /* malformed historical payload: ignore */
    }
  }
  return out;
}

/** The bounded Run fields this classifier reads (the existing evidence only). */
export type TransientRun = Pick<
  Run,
  | "id"
  | "state"
  | "exit_code"
  | "signal"
  | "error"
  | "dsh_events_path"
  | "stderr_path"
  | "resumed_from_run_id"
  | "resume_count"
>;

export interface ClassifyRunTransientInput {
  run: TransientRun | null;
  /** The Factory error string (`CODING_FAILED: …`). */
  error: string | null;
  /**
   * The live DB, when available, so the Run's durable terminal
   * `dsh.run.*` event (`dsh.status`) is part of the evidence too.
   */
  db?: Database;
  /** Test seam (default: the real per-Run files). */
  readTail?: (path: string | null | undefined, maxBytes?: number) => string | null;
  readProvider?: (path: string | null | undefined) => RunProviderEvidence;
}

/**
 * Classify a terminal IMPLEMENT Run failure from the evidence it already wrote.
 * Cancelled/timed-out Runs are never transient (an explicit stop is not an
 * outage), and an adopted/orphaned Run is left to its own stop path.
 */
export function classifyTransientRunFailure(input: ClassifyRunTransientInput): TransientFailure {
  const { run, error } = input;
  if (!run) return nonTransient({ veto: "unknown" });
  if (run.state === "cancelled" || run.signal === "cancelled") {
    return nonTransient({ veto: "cancelled", evidence: [`run ${run.id} was cancelled`] });
  }
  if (run.state === "timeout" || run.signal === "timeout") {
    return nonTransient({ veto: "timeout", evidence: [`run ${run.id} timed out`] });
  }
  const readProvider = input.readProvider ?? readRunProviderEvidence;
  const readTail = input.readTail ?? readEvidenceTail;
  const evidence = readProvider(run.dsh_events_path);
  const stderr = readTail(run.stderr_path);
  const text = [
    error ?? "",
    run.error ?? "",
    evidence.turnEndCode ?? "",
    evidence.turnEndMessage ?? "",
    ...evidence.errors,
    stderr ?? "",
  ]
    .filter((s) => s.length > 0)
    .join("\n");
  const statuses = [
    ...evidence.statuses,
    ...(input.db ? readDshRunEventStatuses(input.db, run.id) : []),
  ];
  const result = classifyTransientEvidence({ text, statuses, turnEnd: evidence.turnEnd });
  if (result.transient) {
    result.evidence = bounded([`run ${run.id}: ${run.state} (exit ${run.exit_code ?? "none"})`, ...result.evidence]);
  }
  return result;
}

export interface ReviewerTransientInput {
  /** The HeadlessReviewResult error (`REVIEW_PROCESS_FAILED: …`) or null. */
  error: string | null;
  /** The reviewer process's combined stdout+stderr (bounded upstream). */
  raw: string;
}

/**
 * A reviewer process failure is transient ONLY when it is the process-level
 * `REVIEW_PROCESS_FAILED` refusal AND its output shows a provider/transport
 * cause. A malformed verdict, a HEAD mismatch or an independence refusal is a
 * judgement/authority problem and is never auto-retried.
 */
export function classifyTransientReviewerFailure(input: ReviewerTransientInput): TransientFailure {
  const error = input.error ?? "";
  if (!/^REVIEW_PROCESS_FAILED\b/.test(error)) return nonTransient({ veto: "unknown" });
  const statuses: number[] = [];
  for (const m of input.raw.matchAll(/\b(?:status|statusCode|httpStatus|code)"?\s*[:=]\s*"?(5\d\d|429)\b/gi)) {
    const n = Number(m[1]);
    if (Number.isInteger(n)) statuses.push(n);
  }
  // A reviewer PROCESS failure is already a failed turn: a provider/transport
  // marker on its own (e.g. `overloaded_error`, "provider request failed") is
  // enough, so pass turnEnd="error" to the same evidence rule.
  return classifyTransientEvidence({ text: `${error}\n${input.raw}`, statuses, turnEnd: "error" });
}

export interface SessionAdoptionDecision {
  unadoptable: boolean;
  detail: string | null;
}

/**
 * Did dsh REFUSE the `--session-id` adoption (unknown/corrupt/session file
 * missing)? Such a Run is recoverable only by a FRESH session carrying the
 * previous final text/status/diff — never by retrying the same dead id.
 */
export function classifyUnadoptableSession(input: {
  run: Pick<TransientRun, "id" | "error" | "dsh_events_path" | "stderr_path"> | null;
  error: string | null;
  readTail?: (path: string | null | undefined, maxBytes?: number) => string | null;
  readProvider?: (path: string | null | undefined) => RunProviderEvidence;
}): SessionAdoptionDecision {
  if (!input.run) return { unadoptable: false, detail: null };
  const readTail = input.readTail ?? readEvidenceTail;
  const readProvider = input.readProvider ?? readRunProviderEvidence;
  const ev = readProvider(input.run.dsh_events_path);
  const text = [
    input.error ?? "",
    input.run.error ?? "",
    ev.turnEndCode ?? "",
    ev.turnEndMessage ?? "",
    ...ev.errors,
    readTail(input.run.stderr_path) ?? "",
  ].join("\n");
  const line = text.split("\n").map((l) => l.trim()).find((l) => SESSION_UNADOPTABLE_MARKER.test(l)) ?? null;
  if (!line) return { unadoptable: false, detail: null };
  return { unadoptable: true, detail: oneLine(line) };
}
