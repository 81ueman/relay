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

/**
 * dsh's own provider-neutral failure codes (`LlmFailure.code`,
 * packages/llm/llm/src/error.ts + retry-policy.ts) that mean the provider or
 * the transport was unavailable. The `turn_end` event and the `dsh: <CODE>:`
 * stderr line carry exactly these codes — never an HTTP status counter.
 */
const TRANSIENT_DSH_CODES = new Set([
  "TIMEOUT",
  "TRANSPORT",
  "SERVER",
  "RATE_LIMIT",
  "OVERLOADED",
  // Older/provider-specific spellings Relay has recorded.
  "PROVIDER_ERROR",
  "PROVIDER_FAILED",
  "PROVIDER_FAILURE",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_OVERLOADED",
  // Raw transport errno codes, when dsh surfaces one as the failure code.
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "ENETDOWN",
  "EAI_AGAIN",
]);

/** Stable dsh codes that are permanent/local: auto-resuming would repeat them. */
const NON_TRANSIENT_DSH_CODES: Record<string, NonNullable<TransientFailure["veto"]>> = {
  AUTH: "auth",
  MISSING_CREDENTIAL: "auth",
  INVALID_CREDENTIAL: "auth",
  FORBIDDEN: "auth",
  PERMISSION: "permission",
  EACCES: "permission",
  EPERM: "permission",
  ENOSPC: "enospc",
  QUOTA: "enospc",
  ACCOUNT_QUOTA: "enospc",
  CONTEXT_WINDOW_EXCEEDED: "unknown",
  INVALID_REQUEST: "unknown",
  PI_AI_ERROR: "unknown",
  UNKNOWN: "unknown",
};

/**
 * The trailing HTTP status of a dsh code such as `HTTP_500` / `PROVIDER_HTTP_503`,
 * or of a bare `"429"` string. Null when the code is not status-shaped.
 */
function statusFromCode(code: string | null): number | null {
  if (!code) return null;
  const c = code.trim().toUpperCase();
  const m = /^(?:PROVIDER_)?HTTP[_-]?(\d{3})$/.exec(c);
  if (m) {
    const n = Number(m[1]);
    return n >= 100 && n <= 599 ? n : null;
  }
  if (/^\d{3}$/.test(c)) {
    const n = Number(c);
    return n >= 100 && n <= 599 ? n : null;
  }
  return null;
}

/**
 * The `dsh: <CODE>: <message>` stderr line dsh writes for a failed terminal
 * turn (`packages/bundle/headless/src/index.ts`). A lowercase `dsh: warning:`
 * or a path-like `dsh: profile …` never matches because the code must be an
 * upper-case identifier immediately followed by a colon.
 */
function dshStderrCode(text: string): string | null {
  for (const line of text.split("\n")) {
    const m = /^\s*dsh:\s*([A-Z][A-Z0-9_]*)\s*:/.exec(line);
    if (m) return m[1];
  }
  return null;
}

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
  turnEndStatus: number | null;
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
    turnEndStatus: null,
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
      if (event.reason.kind === "error" && isRecord(error)) {
        if (typeof error.code === "string" && error.code) out.turnEndCode = error.code;
        if (typeof error.message === "string" && error.message) out.turnEndMessage = error.message;
        out.turnEndStatus = status ?? statusFromCode(out.turnEndCode);
      } else {
        // A completed/aborted turn never inherits the previous turn's failure.
        out.turnEndCode = null;
        out.turnEndStatus = null;
        out.turnEndMessage = null;
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
  /** Structured provider statuses from dsh events (if any). NEVER event counts. */
  statuses?: readonly number[];
  /** The last dsh `turn_end` reason kind. */
  turnEnd?: string | null;
  /** The last `turn_end reason=error` code (`TIMEOUT`, `SERVER`, `ECONNRESET`, …). */
  turnEndCode?: string | null;
  /** An explicit provider HTTP status on the `turn_end` error box, if any. */
  turnEndStatus?: number | null;
}

/**
 * Classify one dsh failure CODE (from `turn_end reason.error.code` or the
 * `dsh: <CODE>:` stderr line). Returns null for a code Relay does not know, so
 * the message/transport evidence can still decide. The structured code is
 * authoritative when present: a `TIMEOUT` is never vetoed by an unrelated
 * number in the message, and an `AUTH` code is never overridden by a transient
 * marker.
 */
function classifyDshCode(code: string | null): TransientFailure | null {
  if (!code) return null;
  const c = code.trim().toUpperCase();
  const status = statusFromCode(c);
  if (status !== null) {
    if (status === 401 || status === 403) {
      return nonTransient({ veto: "auth", evidence: [`status=${status}`] });
    }
    if (status === 429) {
      return {
        transient: true,
        cause: "provider_http_429",
        status: 429,
        detail: `provider HTTP ${status} (too many requests)`,
        evidence: bounded([`status=${status}`]),
      };
    }
    if (status >= 500 && status <= 599) {
      return {
        transient: true,
        cause: "provider_http_5xx",
        status,
        detail: `provider HTTP ${status} (server error)`,
        evidence: bounded([`status=${status}`]),
      };
    }
    if (status === 408) {
      return {
        transient: true,
        cause: "provider_transport",
        status,
        detail: `provider HTTP ${status} (request timeout)`,
        evidence: bounded([`status=${status}`]),
      };
    }
    if (status >= 400) {
      return nonTransient({ veto: "unknown", evidence: [`status=${status}`] });
    }
  }
  const veto = NON_TRANSIENT_DSH_CODES[c];
  if (veto) return nonTransient({ veto, evidence: [`code=${c}`] });
  if (TRANSIENT_DSH_CODES.has(c)) {
    const cause: TransientCause =
      c === "RATE_LIMIT"
        ? "provider_http_429"
        : c === "SERVER" || c === "OVERLOADED"
          ? "provider_http_5xx"
          : c.startsWith("PROVIDER_")
            ? "turn_end_provider_error"
            : "provider_transport";
    return {
      transient: true,
      cause,
      status: null,
      detail: `dsh error code ${c}`,
      evidence: bounded([`code=${c}`]),
    };
  }
  return null;
}

/**
 * Classify one body of evidence. Pure: the SAME input always yields the SAME
 * class, so the Factory and its tests can reason about it without a process.
 *
 * The terminal `turn_end reason=error` CODE and its explicit HTTP status are
 * the strongest evidence and are consulted first. The non-transient text
 * vetoes are checked next: an authorization/permission/disk failure is never
 * auto-resumed even when the message also mentions a retryable status (a 401
 * is permanent, a full disk is local).
 *
 * IMPORTANT: the `dsh` object Relay records on a terminal `dsh.run.*` event is
 * a per-type EVENT-COUNT histogram (`status` = how many status events ran),
 * not an HTTP status. It is deliberately NOT an input here.
 */
export function classifyTransientEvidence(input: TransientEvidenceInput): TransientFailure {
  const text = input.text ?? "";
  const statuses = input.statuses ?? [];
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const match = (re: RegExp): string | null => lines.find((l) => re.test(l)) ?? (re.test(text) ? text.trim().slice(0, 300) : null);

  // 1. Structured terminal failure code/status (never an event count).
  const code = input.turnEndCode?.trim() || dshStderrCode(text);
  const codeVerdict = classifyDshCode(code);
  if (codeVerdict) return codeVerdict;
  const structuredStatus = input.turnEndStatus ?? statusFromCode(code);
  if (structuredStatus !== null) {
    const statusVerdict = classifyDshCode(String(structuredStatus));
    if (statusVerdict) return statusVerdict;
  }

  // 2. Local/permanent text vetoes.
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
 * The bounded Run fields this classifier reads (the existing evidence only).
 *
 * The terminal `dsh.run.*` event is deliberately NOT an input: its `dsh` object
 * is a histogram of dsh EVENT COUNTS (`status` = number of status events), so a
 * long Run with 500 status events would otherwise look like an HTTP 500. The
 * per-Run JSONL is the only structured source.
 */
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
  const result = classifyTransientEvidence({
    text,
    statuses: evidence.statuses,
    turnEnd: evidence.turnEnd,
    turnEndCode: evidence.turnEndCode,
    turnEndStatus: evidence.turnEndStatus,
  });
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
