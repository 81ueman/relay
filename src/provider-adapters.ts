import {
  DEFAULT_REVIEW_OWNER,
  NO_AUTHORITY,
  type CheckRunView,
  type ChecksReadOnly,
  type CommentView,
  type GitHubReadOnly,
  type GitHubReviewReader,
  type IssueView,
  type LinearReadOnly,
  type NativeReviewDeps,
  type PrRef,
  type PrState,
  type PrView,
  type ReviewView,
} from "./providers";
import {
  ProviderRateLimitGuard,
  providerRateLimitFromExec,
  type ProviderRateLimitState,
} from "./provider-rate-limit";

export {
  PROVIDER_RATE_LIMITED,
  ProviderRateLimitedError,
  isProviderRateLimitedError,
} from "./provider-rate-limit";

/**
 * ISH-759 real provider adapters — GET-ONLY.
 *
 * GitHub is read through the `gh` CLI (`gh pr view` / `gh pr list` / `gh api`,
 * all read verbs) and Linear through a read-only GraphQL `query` with a token.
 * Both are behind explicit env opt-in and default OFF, so the ordinary daemon
 * change is a no-op: provider reconciliation only runs when an operator enables
 * a reader. No adapter here can mutate a provider or merge a PR — writes remain
 * deny-by-default (see `ProviderAuthority`).
 */

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Bytes written to the child's stdin (the Linear token travels this way). */
  stdin?: Uint8Array;
  /**
   * ISH-1129: daemon shutdown. Aborting kills the in-flight provider command
   * (whole process group) instead of waiting out its timeout.
   */
  signal?: AbortSignal;
}

/**
 * A provider command executor. It MAY be synchronous (injected test fakes) or
 * asynchronous (the real `defaultExec`), so every provider read awaits it.
 */
export type Exec = (argv: string[], opts?: ExecOptions) => ExecResult | Promise<ExecResult>;

/**
 * ISH-1125: how long one read-only provider command (`gh`/`curl`) may run before
 * it is killed. The default is deliberately generous for a slow network, but
 * BOUNDED: a hung command must never block the supervisor forever.
 *
 * ISH-1129: the DEFAULT executor is asynchronous and honours the daemon's
 * shutdown signal, so SIGTERM aborts an in-flight command immediately instead of
 * waiting for this timeout. The timeout remains the per-command ceiling.
 * `0`/a non-number falls back to the default.
 */
export function providerExecTimeoutMs(env: EnvLike = process.env): number {
  const v = Number(env.RELAY_PROVIDER_EXEC_TIMEOUT_MS ?? "");
  return Number.isFinite(v) && v > 0 ? v : 5000;
}

/** Kill a provider command's WHOLE process group (it runs `detached`). */
function killProviderGroup(proc: { pid: number; kill: (signal?: NodeJS.Signals) => void }): void {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * ISH-1129: the real executor. ASYNC on purpose: `Bun.spawnSync` blocks the JS
 * event loop, so neither a SIGTERM handler nor an AbortSignal can run/kill a
 * hung `gh` call. `Bun.spawn` keeps the loop responsive; the daemon's SIGTERM
 * handler aborts `opts.signal`, which kills the child's process group and lets
 * the supervisor exit bounded regardless of how many Tasks are bound.
 *
 * Each command runs in its own process group (`detached`) so a timeout/shutdown
 * kills descendants too. Output is collected concurrently with `exited`; on a
 * timeout we stop awaiting the pipes (a grandchild holding them open must not
 * keep the daemon alive).
 */
export const defaultExec: Exec = async (argv, opts) => {
  const signal = opts?.signal;
  if (signal?.aborted) {
    return { ok: false, stdout: "", stderr: "provider command aborted by daemon shutdown" };
  }
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: opts?.stdin ? "pipe" : "ignore",
      detached: true,
    });
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e) };
  }

  const sink = proc.stdin;
  if (opts?.stdin && sink && typeof sink === "object") {
    try {
      sink.write(opts.stdin);
      sink.end();
    } catch {
      /* the child may have exited before reading its stdin */
    }
  }

  const timeoutMs = providerExecTimeoutMs();
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    killProviderGroup(proc);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  // Close the check/add race: an abort between the probe above and the listener
  // registration would otherwise leave the child running to its timeout.
  if (signal?.aborted) onAbort();

  const collector = (async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);
    const code = await proc.exited;
    return { stdout, stderr, code };
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      killProviderGroup(proc);
      resolve("timeout");
    }, timeoutMs);
  });
  let winner: Awaited<typeof collector> | "timeout";
  try {
    winner = await Promise.race([collector, timeout]);
  } catch (e) {
    // A killed child can reject its pipe read (EPIPE/EIO). This executor is a
    // FAIL-CLOSED reader: it reports an unreadable result, never throws into the
    // reconcile pass during shutdown.
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    void collector.catch(() => {});
    return { ok: false, stdout: "", stderr: String(e) };
  }
  if (timer) clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);

  if (winner === "timeout") {
    // Do NOT await the pipes: a stuck read must not block shutdown/reconcile.
    void collector.catch(() => {});
    return { ok: false, stdout: "", stderr: `timed out after ${timeoutMs}ms (process group killed)` };
  }
  if (aborted) {
    void collector.catch(() => {});
    return { ok: false, stdout: "", stderr: "provider command aborted by daemon shutdown" };
  }
  return { ok: winner.code === 0, stdout: winner.stdout, stderr: winner.stderr };
};

function mapPrState(state: string): PrState {
  switch ((state ?? "").toUpperCase()) {
    case "OPEN":
      return "open";
    case "CLOSED":
      return "closed";
    case "MERGED":
      return "merged";
    default:
      return "unknown";
  }
}

interface GhPrJson {
  url?: string;
  state?: string;
  isDraft?: boolean;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  baseRefOid?: string;
  mergeable?: string;
  labels?: { name?: string }[];
  updatedAt?: string;
  number?: number;
  // ISH-880: fork detection — a `--head` lookup returns cross-repository PRs.
  isCrossRepository?: boolean;
  headRepository?: { nameWithOwner?: string } | null;
}

const PR_FIELDS =
  "url,state,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,mergeable,labels,updatedAt,number,isCrossRepository,headRepository";

function toPrView(ref: PrRef, j: GhPrJson): PrView {
  return {
    ref,
    url: j.url ?? `https://github.com/${ref.repo}/pull/${ref.number}`,
    state: mapPrState(j.state ?? ""),
    isDraft: j.isDraft === true,
    headRefName: j.headRefName ?? "",
    headSha: j.headRefOid ?? "",
    baseRef: j.baseRefName ?? "",
    baseSha: j.baseRefOid ?? "",
    mergeable:
      (j.mergeable ?? "").toUpperCase() === "MERGEABLE"
        ? "mergeable"
        : (j.mergeable ?? "").toUpperCase() === "CONFLICTING"
          ? "conflicting"
          : "unknown",
    labels: (j.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
    updatedAt: j.updatedAt ?? "",
    isCrossRepository: j.isCrossRepository === true,
    headRepo: j.headRepository?.nameWithOwner ?? "",
  };
}

/** Normalize one GitHub review object (`/pulls/N/reviews`) to a `ReviewView`. */
function toReviewView(ref: PrRef, raw: Record<string, unknown>): ReviewView {
  const user = (raw.user ?? {}) as Record<string, unknown>;
  return {
    id: Number(raw.id ?? 0),
    repo: ref.repo,
    prNumber: ref.number,
    author: typeof user.login === "string" ? user.login : "",
    headSha: String(raw.commit_id ?? ""),
    state: String(raw.state ?? ""),
    body: String(raw.body ?? ""),
    url: String(raw.html_url ?? ""),
    createdAt: String(raw.submitted_at ?? ""),
  };
}

/** GET-only GitHub reader backed by the `gh` CLI (read verbs only). */
export class GhCliGitHub implements GitHubReadOnly, ChecksReadOnly, GitHubReviewReader {
  readonly name = "gh-cli";
  readonly readOnly = true as const;
  private readonly rateLimits = new ProviderRateLimitGuard("github");

  constructor(private exec: Exec = defaultExec) {}

  /** ISH-1132: the active backoff, or null when a read may spend a call. */
  rateLimit(): ProviderRateLimitState | null {
    return this.rateLimits.blocked();
  }

  /** Seed the backoff from an env/auth probe result (no command is run here). */
  noteExec(result: ExecResult): void {
    this.rateLimits.note(result);
  }

  /** Seed the backoff from an already-classified observation. */
  noteRateLimit(state: ProviderRateLimitState): void {
    this.rateLimits.seed(state);
  }

  /**
   * Spawn one read unless the budget is in backoff. A rate-limit failure is
   * recorded on the guard and reported as a failed read (`null` here); callers
   * distinguish it by asking `rateLimit()`.
   */
  private async run(argv: string[]): Promise<ExecResult | null> {
    if (this.rateLimits.blocked()) return null;
    const r = await this.exec(argv);
    this.rateLimits.note(r);
    return r;
  }

  async getPullRequest(ref: PrRef): Promise<PrView | null> {
    const r = await this.run(["gh", "pr", "view", String(ref.number), "--repo", ref.repo, "--json", PR_FIELDS]);
    if (!r?.ok) return null;
    try {
      const j = JSON.parse(r.stdout) as GhPrJson;
      return toPrView({ repo: ref.repo, number: j.number ?? ref.number }, j);
    } catch {
      return null;
    }
  }

  async findPullRequestForBranch(repo: string, branch: string): Promise<PrView | null> {
    const r = await this.run([
      "gh", "pr", "list", "--repo", repo, "--head", branch, "--state", "all",
      "--limit", "1", "--json", PR_FIELDS,
    ]);
    if (!r?.ok) return null;
    try {
      const arr = JSON.parse(r.stdout) as GhPrJson[];
      if (!Array.isArray(arr) || arr.length === 0) return null;
      const j = arr[0];
      return toPrView({ repo, number: j.number ?? 0 }, j);
    } catch {
      return null;
    }
  }

  async listComments(ref: PrRef): Promise<CommentView[] | null> {
    const out: CommentView[] = [];
    const paths = [
      `repos/${ref.repo}/issues/${ref.number}/comments`,
      `repos/${ref.repo}/pulls/${ref.number}/reviews`,
      `repos/${ref.repo}/pulls/${ref.number}/comments`,
    ];
    for (const path of paths) {
      const r = await this.run(["gh", "api", path, "--paginate"]);
      // ANY endpoint failing means the stream is incomplete: report failure
      // (null) rather than a partial list, so the caller does not treat a
      // transient 5xx / rate-limit as "no comments" and consume the watermark.
      if (!r?.ok) return null;
      for (const obj of parseJsonStream(r.stdout)) {
        const items = Array.isArray(obj) ? obj : [obj];
        for (const c of items as Record<string, unknown>[]) {
          const user = (c.user ?? {}) as Record<string, unknown>;
          const author = (typeof user.login === "string" ? user.login : "") as string;
          const createdAt = (c.created_at ?? c.submitted_at ?? "") as string;
          const body = (c.body ?? "") as string;
          out.push({ author, createdAt, body });
        }
      }
    }
    return out;
  }

  /**
   * ISH-883: list a PR's reviews (the READ-BACK side of a native review). A
   * FAILED read returns `null` (never an empty list), so Relay can distinguish
   * "no review" from "could not verify".
   */
  async listReviews(ref: PrRef): Promise<ReviewView[] | null> {
    const r = await this.run(["gh", "api", "--paginate", `repos/${ref.repo}/pulls/${ref.number}/reviews`]);
    if (!r?.ok) return null;
    const out: ReviewView[] = [];
    for (const page of parseJsonStream(r.stdout)) {
      const items = Array.isArray(page) ? page : [page];
      for (const v of items as Record<string, unknown>[]) out.push(toReviewView(ref, v));
    }
    return out;
  }

  /**
   * ISH-761: the check runs + commit statuses bound to EXACTLY `headSha`. Reads
   * two GET endpoints (check-runs, combined status) and merges them. This is
   * FAIL-CLOSED: if EITHER read fails or does not parse — or a read is short of
   * its declared `total_count` — the whole result is `null` (NOT_RUN). A
   * one-sided failure can therefore never masquerade as the complete picture, and
   * a failing check on a later page can never be missed. `--paginate` follows the
   * `Link` header so EVERY page of check runs is read, not just the first 30. An
   * empty array means the commit genuinely reported no checks. Never mutates.
   */
  async listChecks(ref: PrRef, headSha: string): Promise<CheckRunView[] | null> {
    if (!headSha) return null;
    const runs = await this.run([
      "gh", "api", `repos/${ref.repo}/commits/${headSha}/check-runs`, "--paginate",
      "-H", "Accept: application/vnd.github+json",
    ]);
    // A null result means the reader is (or just became) rate-limited: do NOT
    // spend the second read; the caller sees `rateLimit()` and backs off.
    if (!runs?.ok) return null;
    const statuses = await this.run(["gh", "api", `repos/${ref.repo}/commits/${headSha}/status`]);
    if (!statuses?.ok) return null;

    const runPages = parseJsonStream(runs.stdout) as {
      total_count?: number;
      check_runs?: { name?: string; status?: string; conclusion?: string | null }[];
    }[];
    if (runPages.length === 0) return null;
    const rawRuns = runPages.flatMap((p) => p.check_runs ?? []);
    const declaredRuns = runPages[0]?.total_count;
    if (typeof declaredRuns === "number" && rawRuns.length < declaredRuns) return null;

    const statusObjs = parseJsonStream(statuses.stdout) as {
      total_count?: number;
      statuses?: { context?: string; state?: string }[];
    }[];
    if (statusObjs.length === 0) return null;
    const rawStatuses = statusObjs.flatMap((o) => o.statuses ?? []);
    const declaredStatuses = statusObjs[0]?.total_count;
    if (typeof declaredStatuses === "number" && rawStatuses.length < declaredStatuses) return null;

    const out: CheckRunView[] = [];
    for (const c of rawRuns) {
      out.push({ name: c.name ?? "check", bucket: mapCheckRunBucket(c.status ?? "", c.conclusion ?? "") });
    }
    for (const s of rawStatuses) {
      out.push({ name: s.context ?? "status", bucket: mapCommitStatusBucket(s.state ?? "") });
    }
    return out;
  }
}

/** GitHub check-run (status, conclusion) -> the `gh pr checks` bucket vocabulary. */
export function mapCheckRunBucket(status: string, conclusion: string): CheckRunView["bucket"] {
  if ((status ?? "").toLowerCase() !== "completed") return "pending";
  switch ((conclusion ?? "").toLowerCase()) {
    case "success":
    case "neutral":
      return "pass";
    case "skipped":
      return "skipping";
    case "cancelled":
      return "cancel";
    case "":
      return "pending";
    default:
      return "fail";
  }
}

/** Legacy commit status state -> the same bucket vocabulary. */
export function mapCommitStatusBucket(state: string): CheckRunView["bucket"] {
  switch ((state ?? "").toLowerCase()) {
    case "success":
      return "pass";
    case "pending":
      return "pending";
    default:
      return "fail";
  }
}

/**
 * Decode one or more concatenated JSON values (what `gh api --paginate` emits
 * when it chains pages). Scans balanced `{}`/`[]` while respecting strings.
 */
export function parseJsonStream(raw: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      if (start < 0) start = i;
      continue;
    }
    if (c === "{" || c === "[") {
      if (start < 0) start = i;
      depth++;
      continue;
    }
    if (c === "}" || c === "]") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(raw.slice(start, i + 1)));
        } catch {
          /* skip a malformed page */
        }
        start = -1;
      }
    }
  }
  return out;
}

interface LinearGraphQLJson {
  data?: { issue?: { id?: string; state?: { name?: string }; labels?: { nodes?: { name?: string }[] } } };
}

/** GET-only Linear reader: a read-only GraphQL `query` with a token. */
export class LinearApiReadOnly implements LinearReadOnly {
  readonly name = "linear-api";
  readonly readOnly = true as const;
  private readonly rateLimits = new ProviderRateLimitGuard("linear");

  constructor(
    private token: string,
    private exec: Exec = defaultExec,
    private endpoint = "https://api.linear.app/graphql"
  ) {}

  /** ISH-1132: the active backoff, or null when a read may spend a call. */
  rateLimit(): ProviderRateLimitState | null {
    return this.rateLimits.blocked();
  }

  async getIssue(id: string): Promise<IssueView | null> {
    if (this.rateLimits.blocked()) return null;
    const query = "query($id:String!){issue(id:$id){id state{name} labels{nodes{name}}}}";
    const payload = JSON.stringify({ query, variables: { id } });
    // The token travels on STDIN (`-H @-`), never on argv, so it is not visible
    // to other local users via `ps`.
    const r = await this.exec(
      [
        "curl", "-s", "-X", "POST", this.endpoint,
        "-H", "@-",
        "-H", "Content-Type: application/json",
        "-d", payload,
      ],
      { stdin: new TextEncoder().encode(`Authorization: ${this.token}\n`) }
    );
    this.rateLimits.note(r);
    if (!r.ok) return null;
    // Linear reports a GraphQL rate limit in a 200 body (`errors` +
    // `RATELIMITED`), so classify it from the body too. This is a GET-only
    // query, never a write.
    if (/RATELIMITED|rate.?limit exceeded|too many requests/i.test(r.stdout)) {
      this.rateLimits.note({ ok: false, stdout: r.stdout, stderr: "" });
      if (this.rateLimits.blocked()) return null;
    }
    try {
      const j = JSON.parse(r.stdout) as LinearGraphQLJson;
      const issue = j.data?.issue;
      if (!issue) return null;
      return {
        id: issue.id ?? id,
        state: issue.state?.name ?? "",
        labels: (issue.labels?.nodes ?? []).map((l) => l.name ?? "").filter(Boolean),
        updatedAt: "",
      };
    } catch {
      return null;
    }
  }
}

export interface EnvLike {
  [key: string]: string | undefined;
}

/** True when an env opt-in explicitly DISABLES a reader. */
function optOut(value: string | undefined): boolean {
  return ["0", "off", "none", "false", "no"].includes((value ?? "").trim().toLowerCase());
}

/**
 * ISH-1132: distinguish an exhausted API budget from a missing/invalid `gh`.
 *
 * `gh auth status` is known to misreport a rate-limited token as invalid. The
 * `rate_limit` endpoint does not consume the core budget, so it is the safe
 * disambiguation probe after a failed auth status. Returns the typed backoff
 * state when the budget is exhausted (the reader is configured, just retrying).
 */
async function probeGithubRateLimit(exec: Exec): Promise<ProviderRateLimitState | null> {
  const r = await exec(["gh", "api", "rate_limit"]);
  const limited = providerRateLimitFromExec(r, { provider: "github" });
  if (limited) return limited;
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.stdout) as {
      resources?: { core?: { limit?: number; remaining?: number; reset?: number } };
    };
    const core = j.resources?.core;
    if (core && core.remaining === 0 && typeof core.reset === "number" && core.reset > 0) {
      const now = Date.now();
      return {
        provider: "github",
        reason: `GitHub core API budget exhausted (remaining 0 of ${core.limit ?? "?"})`,
        observedAt: now,
        resetAt: core.reset * 1000 > now ? core.reset * 1000 : now + 1000,
      };
    }
  } catch {
    /* not JSON: a failed/other result is handled above */
  }
  return null;
}

/**
 * ISH-1087: resolve the read-only GitHub reader.
 *
 * `RELAY_PROVIDER_GITHUB=gh` always enables it and an explicit `off` always
 * disables it. When `auto` is requested (the Factory/operator path), an UNSET
 * value is resolved by probing `gh auth status`: a read-only check, so a
 * machine with an authenticated `gh` needs no extra relay env to bind the PR
 * and evaluate the merge gate. Anything unreadable stays undefined (fail
 * closed) — auto detection never invents a reader.
 *
 * ISH-1132: a rate-limited probe is NOT "not configured". The reader is returned
 * with its backoff seeded, so the Factory can surface a typed, retryable
 * `PROVIDER_RATE_LIMITED` and the daemon skips provider calls until the reset.
 */
export async function githubReaderFromEnv(
  env: EnvLike = process.env,
  exec: Exec = defaultExec,
  opts: { auto?: boolean } = {}
): Promise<GhCliGitHub | undefined> {
  const mode = (env.RELAY_PROVIDER_GITHUB ?? "").trim().toLowerCase();
  if (optOut(mode)) return undefined;
  if (mode === "gh") return new GhCliGitHub(exec);
  if (!opts.auto || (mode !== "" && mode !== "auto")) return undefined;
  // "auto" or unset: only an AVAILABLE, AUTHENTICATED gh is a reader.
  const probe = await exec(["gh", "auth", "status"]);
  const probeLimit = providerRateLimitFromExec(probe, { provider: "github" });
  if (probeLimit) {
    const gh = new GhCliGitHub(exec);
    gh.noteRateLimit(probeLimit);
    return gh;
  }
  if (probe.ok) return new GhCliGitHub(exec);
  // A failed auth status may be the known rate-limit misreport. Probe the
  // non-consuming rate_limit endpoint before concluding "not configured".
  const exhausted = await probeGithubRateLimit(exec);
  if (exhausted) {
    const gh = new GhCliGitHub(exec);
    gh.noteRateLimit(exhausted);
    return gh;
  }
  return undefined;
}

/**
 * The `gh`-authenticated login plus any rate-limit evidence from the same read.
 * A failed `api user` is otherwise indistinguishable from a bad credential.
 */
export async function ghAuthenticatedLoginResult(
  exec: Exec = defaultExec
): Promise<{ login: string | null; rateLimit: ProviderRateLimitState | null }> {
  const r = await exec(["gh", "api", "user", "--jq", ".login"]);
  const rateLimit = providerRateLimitFromExec(r, { provider: "github" });
  if (!r.ok) return { login: null, rateLimit };
  const login = r.stdout.trim();
  return { login: /^[A-Za-z0-9-]+$/.test(login) ? login : null, rateLimit: null };
}

/** The `gh`-authenticated login, or null (read-only GET `api user`). */
export async function ghAuthenticatedLogin(exec: Exec = defaultExec): Promise<string | null> {
  return (await ghAuthenticatedLoginResult(exec)).login;
}

/**
 * Build the daemon's workflow deps from env. Provider readers are OPT-IN:
 *
 *   RELAY_PROVIDER_GITHUB=gh            enable the read-only gh CLI reader
 *   RELAY_PROVIDER_GITHUB=off           never auto-detect the reader
 *   RELAY_PROVIDER_LINEAR=api          enable the read-only Linear reader
 *   LINEAR_API_TOKEN=<token>           required by the Linear reader
 *   RELAY_REVIEW_AUTHORIZED=a,b        authorized verdict-marker authors
 *
 * `autoGithub` is used by the operator/Factory entrypoints (ISH-1087): with the
 * value unset, an authenticated `gh` becomes the read-only reader. The default
 * remains explicit-only so a library caller is never surprised by a subprocess.
 *
 * Authority is always NO_AUTHORITY here: enabling a reader never grants a write
 * or a merge.
 */
export async function providerDepsFromEnv(
  env: EnvLike = process.env,
  exec: Exec = defaultExec,
  opts: { autoGithub?: boolean } = {}
) {
  const github = await githubReaderFromEnv(env, exec, { auto: opts.autoGithub === true });
  const token = env.LINEAR_API_TOKEN;
  const linear =
    env.RELAY_PROVIDER_LINEAR === "api" && token ? new LinearApiReadOnly(token, exec) : undefined;
  const authorizedReviewers = (env.RELAY_REVIEW_AUTHORIZED ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    github,
    linear,
    checks: github,
    authorizedReviewers: authorizedReviewers.length > 0 ? authorizedReviewers : [DEFAULT_REVIEW_OWNER],
    authority: NO_AUTHORITY,
  };
}

/**
 * ISH-1087: the operator/daemon provider deps. Same as
 * `providerDepsFromEnv`, but an UNSET `RELAY_PROVIDER_GITHUB` auto-detects the
 * read-only `gh` reader (an explicit `off` still disables it).
 */
export async function operatorProviderDepsFromEnv(env: EnvLike = process.env, exec: Exec = defaultExec) {
  return providerDepsFromEnv(env, exec, { autoGithub: true });
}

/**
 * ISH-883: build the native-review deps for the headless reviewer. This is OFF
 * unless an operator gives an explicit owner authorization for the external
 * GitHub write AND the identity the review is expected to be authored by:
 *
 *   RELAY_GITHUB_REVIEW_WRITE=1     explicit owner authorization (ISH-288)
 *   RELAY_GITHUB_REVIEW_WRITE=0     explicit opt-out (never post a review)
 *   RELAY_REVIEW_AUTHOR=<login>     the gh-authenticated login the review posts as
 *   RELAY_PROVIDER_GITHUB=gh        the (read-only) gh CLI reader for read-back
 *
 * The reviewer is the POSTER (it runs `gh` in its disposable review checkout);
 * Relay only reads the review back. The reviewer gets a GitHub shell + a scoped
 * token env (`RELAY_REVIEW_GH_TOKEN` or an inherited `GH_TOKEN`) ONLY under this
 * explicit grant; `linearWrite` and `merge` are never granted.
 *
 * ISH-1087 additions (all opt-in through `opts`, so existing callers keep the
 * exact old semantics):
 *   - `autoGithub` resolves the read-only reader through `githubReaderFromEnv`
 *     (an unset `RELAY_PROVIDER_GITHUB` may auto-detect an authenticated gh);
 *   - `autoAuthor` derives the expected author from `gh api user` when
 *     `RELAY_REVIEW_AUTHOR` is omitted, instead of silently disabling the path;
 *   - `defaultGrant` lets the Factory authorize the reviewer's COMMENT review
 *     when `RELAY_GITHUB_REVIEW_WRITE` is unset (owner decision ISH-1087). An
 *     explicit `0` still disables it.
 *
 * ISH-1133: `github` lets the Factory hand in the reader it already resolved
 * (so the PR-binding and native-review legs cannot diverge); `null` means the
 * caller already decided there is no reader and no further probe should run.
 * When `autoAuthor` is requested but `gh api user` cannot resolve a login, the
 * Factory gets a deps object with an empty author (it reports the concrete
 * author failure) instead of the misleading "not configured".
 */
export async function nativeReviewDepsFromEnv(
  env: EnvLike = process.env,
  exec: Exec = defaultExec,
  opts: {
    autoGithub?: boolean;
    autoAuthor?: boolean;
    defaultGrant?: boolean;
    github?: GhCliGitHub | null;
  } = {}
): Promise<NativeReviewDeps | undefined> {
  const grant = (env.RELAY_GITHUB_REVIEW_WRITE ?? "").trim();
  if (optOut(grant)) return undefined;
  if (grant !== "1" && opts.defaultGrant !== true) return undefined;
  const github =
    opts.github === null
      ? undefined
      : opts.github ?? (await githubReaderFromEnv(env, exec, { auto: opts.autoGithub === true }));
  if (!github) return undefined;
  const authorEnv = (env.RELAY_REVIEW_AUTHOR ?? "").trim();
  // A rate-limited auth probe already proves the reader is configured; do not
  // spend another `gh api user` call just to fail again.
  const probeRateLimit = github.rateLimit?.() ?? null;
  if (probeRateLimit) {
    return {
      reader: github,
      github,
      author: authorEnv,
      allowedTools: "Read Grep Glob Bash",
      rateLimited: probeRateLimit,
    };
  }
  let author = authorEnv;
  let authorRateLimit: ProviderRateLimitState | null = null;
  if (!author && opts.autoAuthor) {
    const login = await ghAuthenticatedLoginResult(exec);
    author = login.login ?? "";
    authorRateLimit = login.rateLimit;
  }
  // ISH-1132: a rate-limited (but authenticated) gh is a retryable provider
  // condition, not "native review not configured". Carry the typed state so the
  // Factory returns PROVIDER_RATE_LIMITED instead of
  // FACTORY_NATIVE_REVIEW_REQUIRED.
  const rateLimited = github.rateLimit?.() ?? authorRateLimit;
  if (rateLimited) {
    return {
      reader: github,
      github,
      author,
      allowedTools: "Read Grep Glob Bash",
      rateLimited,
    };
  }
  if (!author) {
    // ISH-1133: the Factory must be able to distinguish "no gh reader" from
    // "gh is authenticated but the expected reviewer login could not be read".
    // Keep the reader for the Factory's concrete author error; the ordinary
    // native-review callers keep the old undefined (unavailable) result.
    if (opts.autoAuthor === true && opts.defaultGrant === true) {
      return { reader: github, github, author, allowedTools: "Read Grep Glob Bash" };
    }
    return undefined;
  }
  const token = env.RELAY_REVIEW_GH_TOKEN ?? env.GH_TOKEN;
  return {
    reader: github,
    github,
    author,
    ...(token ? { spawnEnv: { GH_TOKEN: token } } : {}),
    // The reviewer must be able to run `gh` (and git) to post; this is an
    // approval allowlist, NOT an OS-level containment boundary (ISH-883 explicitly does not claim
    // isolation from it).
    allowedTools: "Read Grep Glob Bash",
  };
}

/**
 * ISH-1087: the Factory's native-review deps. The owner decision is that EVERY
 * Factory-reviewed PR carries the independent reviewer's verdict on GitHub, so
 * the Factory authorizes the reviewer's COMMENT review by default, resolves the
 * author from the gh login, and auto-detects the read-only reader. An explicit
 * `RELAY_GITHUB_REVIEW_WRITE=0` still turns it off (the Factory then refuses to
 * reach MergeReady when `requireNativeReview` is set).
 *
 * ISH-1133: pass `github` to reuse the reader the provider/PR-binding leg
 * already resolved (`null` when it found none).
 */
export async function factoryNativeReviewDepsFromEnv(
  env: EnvLike = process.env,
  exec: Exec = defaultExec,
  opts: { github?: GhCliGitHub | null } = {}
): Promise<NativeReviewDeps | undefined> {
  return nativeReviewDepsFromEnv(env, exec, {
    autoGithub: true,
    autoAuthor: true,
    defaultGrant: true,
    github: opts.github,
  });
}

/**
 * ISH-1133: the Factory's no-env GitHub defaults. One auto-detection resolves
 * the read-only provider; the native-review leg reuses that SAME reader, so an
 * authenticated `gh` selected for PR binding can never be "not configured" for
 * the native review. `RELAY_PROVIDER_GITHUB=off` disables both (fail closed),
 * and a rate-limited detection is carried through as a retryable state.
 */
export async function factoryGithubDepsFromEnv(
  env: EnvLike = process.env,
  exec: Exec = defaultExec
): Promise<{ providers: Awaited<ReturnType<typeof providerDepsFromEnv>>; nativeReview: NativeReviewDeps | undefined }> {
  const providers = await providerDepsFromEnv(env, exec, { autoGithub: true });
  const nativeReview = await factoryNativeReviewDepsFromEnv(env, exec, {
    github: providers.github ?? null,
  });
  return { providers, nativeReview };
}
