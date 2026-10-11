// Agent-harness registry.
//
// Relay drives more than one agent harness. Everything that used to be a
// hard-coded two-value branch (`agent_kind === "codex"` vs everything else)
// lives here, so adding a harness is a table row rather than a new special case.
//
// A harness is named by its `agent_kind` — the value stored on the worker row
// and carried in the socket attach message. Two orthogonal facts matter to the
// supervisor:
//
//   - `idlesVia`: how relay learns the session went idle.
//       "events" — the harness runs relay's plugin (or an equivalent reporter)
//                  and streams `session.idle` / tool / permission events.
//       "poll"   — the harness has no event stream; liveness/idle/blocked are
//                  POLLED from Herdr `agent_status`.
//   - `herdrKind`: the Herdr `agent` kind used for identity resolution. This is
//                  what `herdr agent list` reports in `agent`, or the `--agent`
//                  label a self-reporting pane registers via
//                  `herdr pane report-agent`.
//
// Adding a harness here is the only step needed for attach, identity and
// session-id validation; the poll path and spawn path read this table too.

export type IdlesVia = "events" | "poll";
/** How relay delivers a nudge to the harness. */
export type WakeVia = "herdr" | "plugin";

export interface Harness {
  /** Value stored in `workers.agent_kind` (and sent as `kind` on attach). */
  readonly id: string;
  readonly idlesVia: IdlesVia;
  /**
   * How a nudge reaches the harness:
   *   "herdr"  — typed into its Herdr pane (`herdr agent prompt`).
   *   "plugin" — written to the durable wake outbox and pulled by the harness's
   *              relay plugin (a server harness like dsh has no input pane).
   */
  readonly wakeVia: WakeVia;
  /** Herdr agent kind / report label used by identity resolution. */
  readonly herdrKind: string;
  /** Does `sessionId` look like an id this harness could have minted? */
  matchesSessionId(sessionId: string): boolean;
  /** Herdr `agent start --kind` value, or null when Herdr cannot start it. */
  readonly herdrStartKind: string | null;
  /** One-line description for CLI help. */
  readonly note: string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID}$`, "i");
// OpenCode session ids start with `ses` (`ses_...`). Shell ids (`sh_...`) and
// any other prefix are deliberately NOT sessions.
const OPENCODE_RE = /^ses/;
// dsh session ids are `session-<uuid>`; an agent id may prefix it
// (`main-session-<uuid>`), so allow an optional `[a-z0-9_-]+-` before `session-`.
const DSH_RE = new RegExp(`^(?:[a-z0-9_-]+-)?session-${UUID}$`, "i");

export const HARNESSES: readonly Harness[] = [
  {
    id: "opencode",
    idlesVia: "events",
    wakeVia: "herdr",
    herdrKind: "opencode",
    matchesSessionId: (s) => OPENCODE_RE.test(s),
    herdrStartKind: "opencode",
    note: "OpenCode (plugin event stream)",
  },
  {
    id: "codex",
    idlesVia: "poll",
    wakeVia: "herdr",
    herdrKind: "codex",
    matchesSessionId: (s) => UUID_RE.test(s),
    herdrStartKind: "codex",
    note: "Codex (polled over Herdr)",
  },
  {
    id: "claude",
    idlesVia: "poll",
    wakeVia: "herdr",
    herdrKind: "claude",
    matchesSessionId: (s) => UUID_RE.test(s),
    herdrStartKind: "claude",
    note: "Claude Code (polled over Herdr)",
  },
  {
    id: "dsh",
    idlesVia: "events",
    wakeVia: "plugin",
    herdrKind: "dsh",
    matchesSessionId: (s) => DSH_RE.test(s),
    // Herdr has no `dsh` agent kind: a dsh worker is started by hand and its
    // relay plugin self-reports the pane via `herdr pane report-agent`.
    herdrStartKind: null,
    note: "DeepSeek Harness (relay dsh plugin event stream)",
  },
];

export const AGENT_KINDS: readonly string[] = HARNESSES.map((h) => h.id);

/** The `opencode|codex|claude|dsh` list used throughout CLI help. */
export const AGENT_KINDS_HELP: string = AGENT_KINDS.join("|");

// Kinds whose session-id shape is unambiguous: a shell id or a bare UUID can
// never collide with them, so an UNDECLARED attach can be accepted by pattern
// alone. A bare UUID is ambiguous (codex vs claude), so it needs `kind`.
//
// ORDER MATTERS: dsh's `session-<uuid>` ALSO matches the opencode `^ses` prefix,
// so the more specific dsh pattern must be tested first. `harness()` is a hoisted
// function declaration, so these initializers may call it.
const UNAMBIGUOUS: readonly Harness[] = [harness("dsh")!, harness("opencode")!];
// Preference order for `inferKind`: the unambiguous shapes first, then the
// historical `codex` fallback for anything else (a bare UUID).
const INFER_ORDER: readonly Harness[] = [...UNAMBIGUOUS];

export function harness(id: string | null | undefined): Harness | null {
  if (!id) return null;
  return HARNESSES.find((h) => h.id === id) ?? null;
}

export function isKnownKind(id: string | null | undefined): boolean {
  return harness(id) !== null;
}

/** True for harnesses whose liveness/idle/blocked come from polling Herdr. */
export function idlesViaPoll(kind: string | null | undefined): boolean {
  return harness(kind)?.idlesVia === "poll";
}

/** The Herdr agent kind for a harness id, or null when unknown. */
export function herdrKindOf(kind: string | null | undefined): string | null {
  return harness(kind)?.herdrKind ?? null;
}

/**
 * True when a nudge must be queued in the durable wake outbox for the harness's
 * relay plugin to pull, rather than typed into a Herdr pane (a server harness
 * like dsh has no input pane). Unknown kinds default to the Herdr path.
 */
export function wakeViaPlugin(kind: string | null | undefined): boolean {
  return harness(kind)?.wakeVia === "plugin";
}

/**
 * Resolve the harness kind for an ATTACH, fail closed.
 *
 * - A declared kind must exist AND match the session id. A mismatch (e.g.
 *   `kind:"codex"` on a `sh_...` id) is refused.
 * - With no declaration, only unambiguous session-id shapes are accepted:
 *   opencode (`ses...`) and dsh (`session-<uuid>`). A bare UUID is refused
 *   unless declared — the existing "an undeclared non-`ses` id is refused"
 *   guard, now covering claude as well as codex.
 *
 * Returns the resolved kind, or null when it cannot be proven.
 */
export function resolveKind(sessionId: string, declaredKind?: string | null): string | null {
  if (declaredKind) {
    const h = harness(declaredKind);
    return h && h.matchesSessionId(sessionId) ? h.id : null;
  }
  for (const h of UNAMBIGUOUS) {
    if (h.matchesSessionId(sessionId)) return h.id;
  }
  return null;
}

/**
 * Best-effort kind inference for identity resolution and CLI defaults. Unlike
 * `resolveKind` this never returns null: an unrecognized shape falls back to
 * `codex` (the historical non-`ses` default). Callers that must not guess use
 * `resolveKind` instead.
 */
export function inferKind(sessionId: string): string {
  for (const h of INFER_ORDER) {
    if (h.matchesSessionId(sessionId)) return h.id;
  }
  return "codex";
}
