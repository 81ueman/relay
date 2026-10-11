// Type declarations for the pure dsh-bridge core (lib/core.mjs), so relay's
// `tsc --noEmit` can typecheck the unit test that imports it.

export function resolveRelaySocket(cwd?: string, env?: Record<string, string | undefined>): string;
export function isDshSessionId(id: unknown): boolean;
export function relayEventForSessionEvent(
  event: { type?: string; name?: string; callId?: string; message?: { id?: string }; error?: unknown }
): { type: string; payload?: Record<string, unknown> } | null;
export function relayEventForAgentStatus(status: string): { type: string; payload?: Record<string, unknown> } | null;
export function wakeBackoff(waitedMs: number, minGapMs?: number): number;
export function relayRequest(sockPath: string, msg: unknown, timeoutMs?: number): Promise<Record<string, unknown> | null>;
export class RelayClient {
  constructor(sockPath: string, opts?: { timeoutMs?: number });
  readonly sockPath: string;
  readonly timeoutMs: number;
  notify(msg: unknown): Promise<boolean>;
  awaitWake(
    sessionId: string,
    opts?: { waitMs?: number }
  ): Promise<{ reason: string; text: string; created_at: number } | null>;
}
