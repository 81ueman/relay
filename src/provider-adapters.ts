import {
  DEFAULT_REVIEW_OWNER,
  NO_AUTHORITY,
  type CheckRunView,
  type ChecksReadOnly,
  type CommentView,
  type GitHubReadOnly,
  type IssueView,
  type LinearReadOnly,
  type PrRef,
  type PrState,
  type PrView,
} from "./providers";
import { defaultVerifyTarget } from "./sandbox-verify";

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
export type Exec = (argv: string[], opts?: { stdin?: Uint8Array }) => ExecResult;

export const defaultExec: Exec = (argv, opts) => {
  try {
    const p = Bun.spawnSync(argv, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: opts?.stdin ?? "ignore",
    });
    return { ok: p.exitCode === 0, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e) };
  }
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
}

const PR_FIELDS = "url,state,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,mergeable,labels,updatedAt,number";

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
  };
}

/** GET-only GitHub reader backed by the `gh` CLI (read verbs only). */
export class GhCliGitHub implements GitHubReadOnly, ChecksReadOnly {
  readonly name = "gh-cli";
  readonly readOnly = true as const;

  constructor(private exec: Exec = defaultExec) {}

  getPullRequest(ref: PrRef): PrView | null {
    const r = this.exec(["gh", "pr", "view", String(ref.number), "--repo", ref.repo, "--json", PR_FIELDS]);
    if (!r.ok) return null;
    try {
      const j = JSON.parse(r.stdout) as GhPrJson;
      return toPrView({ repo: ref.repo, number: j.number ?? ref.number }, j);
    } catch {
      return null;
    }
  }

  findPullRequestForBranch(repo: string, branch: string): PrView | null {
    const r = this.exec([
      "gh", "pr", "list", "--repo", repo, "--head", branch, "--state", "all",
      "--limit", "1", "--json", PR_FIELDS,
    ]);
    if (!r.ok) return null;
    try {
      const arr = JSON.parse(r.stdout) as GhPrJson[];
      if (!Array.isArray(arr) || arr.length === 0) return null;
      const j = arr[0];
      return toPrView({ repo, number: j.number ?? 0 }, j);
    } catch {
      return null;
    }
  }

  listComments(ref: PrRef): CommentView[] | null {
    const out: CommentView[] = [];
    const paths = [
      `repos/${ref.repo}/issues/${ref.number}/comments`,
      `repos/${ref.repo}/pulls/${ref.number}/reviews`,
      `repos/${ref.repo}/pulls/${ref.number}/comments`,
    ];
    for (const path of paths) {
      const r = this.exec(["gh", "api", path, "--paginate"]);
      // ANY endpoint failing means the stream is incomplete: report failure
      // (null) rather than a partial list, so the caller does not treat a
      // transient 5xx / rate-limit as "no comments" and consume the watermark.
      if (!r.ok) return null;
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
   * ISH-761: the check runs + commit statuses bound to EXACTLY `headSha`. Reads
   * two GET endpoints (check-runs, combined status) and merges them. This is
   * FAIL-CLOSED: if EITHER read fails or does not parse — or a read is short of
   * its declared `total_count` — the whole result is `null` (NOT_RUN). A
   * one-sided failure can therefore never masquerade as the complete picture, and
   * a failing check on a later page can never be missed. `--paginate` follows the
   * `Link` header so EVERY page of check runs is read, not just the first 30. An
   * empty array means the commit genuinely reported no checks. Never mutates.
   */
  listChecks(ref: PrRef, headSha: string): CheckRunView[] | null {
    if (!headSha) return null;
    const runs = this.exec([
      "gh", "api", `repos/${ref.repo}/commits/${headSha}/check-runs`, "--paginate",
      "-H", "Accept: application/vnd.github+json",
    ]);
    if (!runs.ok) return null;
    const statuses = this.exec(["gh", "api", `repos/${ref.repo}/commits/${headSha}/status`]);
    if (!statuses.ok) return null;

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

  constructor(
    private token: string,
    private exec: Exec = defaultExec,
    private endpoint = "https://api.linear.app/graphql"
  ) {}

  getIssue(id: string): IssueView | null {
    const query = "query($id:String!){issue(id:$id){id state{name} labels{nodes{name}}}}";
    const payload = JSON.stringify({ query, variables: { id } });
    // The token travels on STDIN (`-H @-`), never on argv, so it is not visible
    // to other local users via `ps`.
    const r = this.exec(
      [
        "curl", "-s", "-X", "POST", this.endpoint,
        "-H", "@-",
        "-H", "Content-Type: application/json",
        "-d", payload,
      ],
      { stdin: new TextEncoder().encode(`Authorization: ${this.token}\n`) }
    );
    if (!r.ok) return null;
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

/**
 * Build the daemon's workflow deps from env. Provider readers are OPT-IN:
 *
 *   RELAY_PROVIDER_GITHUB=gh            enable the read-only gh CLI reader
 *   RELAY_PROVIDER_LINEAR=api          enable the read-only Linear reader
 *   LINEAR_API_TOKEN=<token>           required by the Linear reader
 *   RELAY_REVIEW_AUTHORIZED=a,b        authorized verdict-marker authors
 *
 * Authority is always NO_AUTHORITY here: enabling a reader never grants a write
 * or a merge.
 */
export function providerDepsFromEnv(env: EnvLike = process.env, exec: Exec = defaultExec) {
  const github = env.RELAY_PROVIDER_GITHUB === "gh" ? new GhCliGitHub(exec) : undefined;
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
    // ISH-829: mechanical VERIFY of a Task with a durable Coding Sandbox runs
    // INSIDE that sandbox at the recorded HEAD; a Task without one falls back to
    // the host runner (see runPendingMechanicalVerifications).
    verifyTarget: defaultVerifyTarget,
  };
}
