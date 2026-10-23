import type { Database } from "bun:sqlite";
import { logEvent } from "./events";

/**
 * ISH-1132 — provider rate-limit backoff.
 *
 * The daemon's read-only provider poll used to treat an exhausted GitHub API
 * budget as just another unreadable read. That is wrong in two ways: it keeps
 * spending calls every tick, and the Factory/PR-binding paths turn "unreadable"
 * into a configuration error (`FACTORY_NATIVE_REVIEW_REQUIRED`). A rate limit is
 * a TRANSIENT, RETRYABLE condition with a provider-reported reset, so it gets its
 * own typed state.
 *
 * This module is deliberately transport-agnostic: it parses a failed `gh`/`curl`
 * result, holds the backoff for a reader instance, and logs one event per
 * (provider, reset) episode. It never writes a provider.
 */

/** The stable reason code a rate-limited provider read surfaces. */
export const PROVIDER_RATE_LIMITED = "PROVIDER_RATE_LIMITED";

/** The one durable event per rate-limit episode (daemon and Factory share it). */
export const PROVIDER_RATE_LIMIT_EVENT = "workflow.provider_rate_limited";

/**
 * Fallback backoff when the provider does not report a reset. GitHub's primary
 * budget resets hourly; waiting the full hour is the conservative, budget-safe
 * choice. `RELAY_PROVIDER_RATE_LIMIT_BACKOFF_MS` can lower it (tests/operators).
 */
export const DEFAULT_PROVIDER_RATE_LIMIT_BACKOFF_MS = 60 * 60_000;

export interface ProviderRateLimitState {
  /** `github` | `linear` (or another reader-provided name). */
  provider: string;
  /** A bounded, human-readable cause (the provider's own error text). */
  reason: string;
  /** Epoch ms when the limit was observed. */
  observedAt: number;
  /** Epoch ms when the provider reported (or we conservatively expect) reset. */
  resetAt: number;
}

/** The command result shape this module classifies (no `provider-adapters` cycle). */
export interface ProviderExecResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
}

export function providerRateLimitBackoffMs(env: { [key: string]: string | undefined } = process.env): number {
  const v = Number(env.RELAY_PROVIDER_RATE_LIMIT_BACKOFF_MS ?? "");
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_PROVIDER_RATE_LIMIT_BACKOFF_MS;
}

const RATE_LIMIT_RE =
  /api rate limit exceeded|secondary[- ]?rate[- ]?limit|rate[- ]?limit(?:ed|ing)?|too many requests|abuse detection|\bhttp(?: status)?\s*429\b|\bstatus(?: code)?\s*429\b/i;

function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  return (line ?? "rate limited").slice(0, 300);
}

/**
 * Parse the reset the provider reported, in ms. Supported forms:
 *   - `x-ratelimit-reset: <epoch seconds>` (GitHub headers)
 *   - `retry-after: <seconds>` (secondary limit)
 *   - `try again in N seconds|minutes|hours`
 *   - `reset at <ISO timestamp>`
 * Returns null when no reset is reported so the caller can use its fallback.
 */
export function parseProviderRateLimitReset(text: string, now = Date.now()): number | null {
  const epoch = /x-ratelimit-reset["']?\s*[:=]\s*(\d{9,12})/i.exec(text);
  if (epoch) {
    const at = Number(epoch[1]) * 1000;
    return at > now ? at : now + 1000;
  }
  const retryAfter = /retry-after["']?\s*[:=]\s*(\d+)/i.exec(text);
  if (retryAfter) return now + Number(retryAfter[1]) * 1000;
  const inMatch =
    /(?:try again|retry|resets?|available)\s+in\s+(\d+)\s*(second|sec|minute|min|hour|hr)s?/i.exec(text) ??
    /(?:retry|wait)\s+after\s+(\d+)\s*(second|sec|minute|min|hour|hr)s?/i.exec(text);
  if (inMatch) {
    const n = Number(inMatch[1]);
    const unit = inMatch[2].toLowerCase();
    const scale = unit.startsWith("h") ? 3_600_000 : unit.startsWith("m") ? 60_000 : 1000;
    return now + n * scale;
  }
  const iso = /(?:rate limit resets? at|reset at)\s*(\d{4}-\d{2}-\d{2}T[^\s."']+)/i.exec(text);
  if (iso) {
    const at = Date.parse(iso[1]);
    if (Number.isFinite(at)) return at > now ? at : now + 1000;
  }
  return null;
}

/**
 * Classify a failed provider command as a rate limit. An OK result is never a
 * rate limit (even if its text mentions one); only stderr/stdout of a failure is
 * inspected, so a normal JSON body cannot trigger a backoff.
 */
export function providerRateLimitFromText(
  text: string,
  opts: { provider?: string; now?: number; fallbackMs?: number } = {}
): ProviderRateLimitState | null {
  if (!RATE_LIMIT_RE.test(text)) return null;
  const now = opts.now ?? Date.now();
  const fallbackMs = opts.fallbackMs ?? providerRateLimitBackoffMs();
  const resetAt = parseProviderRateLimitReset(text, now) ?? now + fallbackMs;
  return {
    provider: opts.provider ?? "provider",
    reason: firstLine(text),
    observedAt: now,
    resetAt,
  };
}

export function providerRateLimitFromExec(
  result: ProviderExecResult,
  opts: { provider?: string; now?: number; fallbackMs?: number } = {}
): ProviderRateLimitState | null {
  if (result.ok) return null;
  const text = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  if (!text) return null;
  return providerRateLimitFromText(text, opts);
}

/** A typed, retryable rate-limit error. `retryable` is deliberately true. */
export class ProviderRateLimitedError extends Error {
  readonly code = PROVIDER_RATE_LIMITED;
  readonly retryable = true;
  readonly state: ProviderRateLimitState;

  constructor(state: ProviderRateLimitState) {
    super(providerRateLimitedReason(state));
    this.name = "ProviderRateLimitedError";
    this.state = state;
  }
}

export function isProviderRateLimitedError(e: unknown): e is ProviderRateLimitedError {
  return e instanceof ProviderRateLimitedError;
}

/**
 * The single-line reason used by the Factory, PR binding and merge gate. It
 * always starts with the typed code so callers and logs can branch on it.
 */
export function providerRateLimitedReason(state: ProviderRateLimitState): string {
  const reset = new Date(state.resetAt).toISOString();
  return `${PROVIDER_RATE_LIMITED}: ${state.provider} API rate limit (${state.reason}); retry after ${reset} (retryable)`;
}

/** The state only while its reset is still in the future (a stale state is noise). */
export function activeProviderRateLimit(
  state: ProviderRateLimitState | null | undefined,
  now = Date.now()
): ProviderRateLimitState | null {
  return state && state.resetAt > now ? state : null;
}

/**
 * Per-reader backoff. The reader refuses to spawn another provider command until
 * `resetAt`, so a daemon tick cannot keep spending calls between observations.
 * A single instance is held by each long-lived reader (`GhCliGitHub`), which is
 * created once per daemon process.
 */
export class ProviderRateLimitGuard {
  private state: ProviderRateLimitState | null = null;

  constructor(
    private readonly provider: string,
    private readonly now: () => number = Date.now,
    private readonly fallbackMs: number = providerRateLimitBackoffMs()
  ) {}

  /** Record a provider result; returns the active state when it was a limit. */
  note(result: ProviderExecResult): ProviderRateLimitState | null {
    const next = providerRateLimitFromExec(result, {
      provider: this.provider,
      now: this.now(),
      fallbackMs: this.fallbackMs,
    });
    if (next) this.state = next;
    return next;
  }

  /** Seed from an already-classified observation (e.g. an env auth probe). */
  seed(state: ProviderRateLimitState): void {
    this.state = state;
  }

  /** The active backoff, or null when the reset has passed. */
  blocked(now = this.now()): ProviderRateLimitState | null {
    if (!this.state) return null;
    if (now >= this.state.resetAt) {
      this.state = null;
      return null;
    }
    return this.state;
  }

  reset(): void {
    this.state = null;
  }
}

/**
 * Log exactly ONE event per (provider, reset) episode. Both the daemon poll and
 * the Factory use this so two layers observing the same exhaust do not spam the
 * event log on every tick/attempt. Returns true when this call inserted it.
 */
export function logProviderRateLimitOnce(
  db: Database,
  state: ProviderRateLimitState,
  opts: { source?: string; taskId?: string | null } = {}
): boolean {
  const key = `${state.provider}:${state.resetAt}`;
  try {
    const already = db
      .query(
        `SELECT 1 AS x FROM events
          WHERE type = ? AND json_extract(payload_json, '$.key') = ?
          LIMIT 1`
      )
      .get(PROVIDER_RATE_LIMIT_EVENT, key);
    if (already) return false;
    logEvent(db, {
      source: opts.source ?? "workflow",
      taskId: opts.taskId ?? null,
      type: PROVIDER_RATE_LIMIT_EVENT,
      payload: {
        key,
        provider: state.provider,
        reason: state.reason,
        observedAt: state.observedAt,
        resetAt: state.resetAt,
      },
    });
    return true;
  } catch {
    // Event logging is observability; a full disk must not turn a backoff into a
    // crash. The in-memory guard still prevents further provider calls.
    return false;
  }
}
