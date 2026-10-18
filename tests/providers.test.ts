import { describe, expect, test } from "bun:test";
import {
  DEFAULT_REVIEW_OWNER,
  FakeGitHub,
  FakeLinear,
  NO_AUTHORITY,
  assertSideEffectAllowed,
  effectiveVerdictAtHead,
  headsMatch,
  isApprovalSignal,
  markerAfterInvalidation,
  parsePrUrl,
  parseReviewMarkers,
  performMerge,
  sideEffectAllowed,
  type CommentView,
  type PrView,
} from "../src/providers";

const FULL = "a".repeat(40);
const OTHER = "b".repeat(40);

const comment = (author: string, body: string, createdAt = "2026-01-01T00:00:00Z"): CommentView => ({
  author,
  createdAt,
  body,
});

const marker = (head: string, verdict: string, reviewer = DEFAULT_REVIEW_OWNER): string =>
  `<!-- ishiul-review head=${head} verdict=${verdict} reviewer=${reviewer} -->\n\nfindings: none`;

describe("review verdict markers (absorbed from lane.sh)", () => {
  test("only markers authored by an authorized reviewer count", () => {
    const comments = [
      comment("random-dev", marker(FULL, "OK")), // self-claim: ignored
      comment(DEFAULT_REVIEW_OWNER, marker(FULL, "OK")),
    ];
    const markers = parseReviewMarkers(comments, { authorizedReviewers: [DEFAULT_REVIEW_OWNER] });
    expect(markers).toHaveLength(1);
    expect(markers[0].author).toBe(DEFAULT_REVIEW_OWNER);
    expect(markers[0].verdict).toBe("OK");
  });

  test("a self-claimed comment is not an approval signal", () => {
    const comments = [comment("impostor", marker(FULL, "OK"))];
    const markers = parseReviewMarkers(comments, { authorizedReviewers: [DEFAULT_REVIEW_OWNER] });
    expect(markers).toHaveLength(0);
    expect(isApprovalSignal("self-claim")).toBe(false);
    expect(isApprovalSignal("turn-ended")).toBe(false);
    expect(isApprovalSignal("label")).toBe(false);
    expect(isApprovalSignal("structured")).toBe(true);
    expect(isApprovalSignal("review-marker")).toBe(true);
  });

  test("the newest marker at the head wins; a later NG beats an earlier OK", () => {
    const comments = [
      comment(DEFAULT_REVIEW_OWNER, marker(FULL, "OK"), "2026-01-01T00:00:00Z"),
      comment(DEFAULT_REVIEW_OWNER, marker(FULL, "NG"), "2026-01-02T00:00:00Z"),
    ];
    const markers = parseReviewMarkers(comments, { authorizedReviewers: [DEFAULT_REVIEW_OWNER] });
    expect(effectiveVerdictAtHead(markers, FULL)?.verdict).toBe("NG");
  });

  test("markers at a different head are ignored", () => {
    const comments = [comment(DEFAULT_REVIEW_OWNER, marker(OTHER, "OK"))];
    const markers = parseReviewMarkers(comments, { authorizedReviewers: [DEFAULT_REVIEW_OWNER] });
    expect(effectiveVerdictAtHead(markers, FULL)).toBeNull();
  });

  test("an abbreviated SHA still matches the full head", () => {
    expect(headsMatch(FULL.slice(0, 7), FULL)).toBe(true);
    expect(headsMatch(OTHER, FULL)).toBe(false);
  });

  test("a marker at/before a base-retarget invalidation is stale; a later one is fresh", () => {
    const m = {
      headSha: FULL,
      verdict: "OK" as const,
      reviewer: "claude",
      author: "claude",
      createdAt: "2026-01-02T00:00:00Z",
      body: "",
    };
    // No invalidation -> every marker counts.
    expect(markerAfterInvalidation(m, 0)).toBe(true);
    // Posted AFTER the invalidation -> fresh.
    expect(markerAfterInvalidation(m, Date.parse("2026-01-01T00:00:00Z"))).toBe(true);
    // Posted BEFORE the invalidation -> stale (not re-applied).
    expect(markerAfterInvalidation(m, Date.parse("2026-01-03T00:00:00Z"))).toBe(false);
    // An unparseable timestamp with an invalidation fails closed (stale).
    expect(markerAfterInvalidation({ ...m, createdAt: "" }, Date.parse("2026-01-01T00:00:00Z"))).toBe(false);
  });
});

describe("side-effect authority (ISH-288 point-of-use rule)", () => {
  test("default authority denies every side effect and fails closed", () => {
    expect(sideEffectAllowed(NO_AUTHORITY, "linear-write")).toBe(false);
    expect(sideEffectAllowed(NO_AUTHORITY, "merge")).toBe(false);
    expect(() => assertSideEffectAllowed(NO_AUTHORITY, "merge")).toThrow(/AUTHORITY/);
    expect(() => assertSideEffectAllowed(NO_AUTHORITY, "linear-write")).toThrow(/failing closed/);
  });

  test("a merge through Relay needs explicit authority and is still dry-run", () => {
    expect(() => performMerge(NO_AUTHORITY)).toThrow(/AUTHORITY/);
    const withAuthority = { linearWrite: false, merge: true };
    const r = performMerge(withAuthority, { dryRun: true });
    expect(r.performed).toBe(false);
    expect(r.dryRun).toBe(true);
  });
});

describe("parsePrUrl", () => {
  test("parses github urls and owner/repo#n", () => {
    expect(parsePrUrl("https://github.com/81ueman/relay/pull/12", null)).toEqual({ repo: "81ueman/relay", number: 12 });
    expect(parsePrUrl("81ueman/relay#12", null)).toEqual({ repo: "81ueman/relay", number: 12 });
    expect(parsePrUrl(null, null)).toBeNull();
  });
});

describe("read-only fakes", () => {
  const view: PrView = {
    ref: { repo: "81ueman/relay", number: 1 },
    url: "https://github.com/81ueman/relay/pull/1",
    state: "open",
    isDraft: false,
    headRefName: "feat/x",
    headSha: FULL,
    baseRef: "main",
    baseSha: "0".repeat(40),
    mergeable: "mergeable",
    labels: ["needs-review"],
    updatedAt: "2026-01-01T00:00:00Z",
  };

  test("FakeGitHub serves PRs by ref and branch and is read-only", () => {
    const gh = new FakeGitHub();
    gh.putPullRequest(view);
    expect(gh.readOnly).toBe(true);
    expect(gh.getPullRequest(view.ref)).toEqual(view);
    expect(gh.findPullRequestForBranch("81ueman/relay", "feat/x")?.ref.number).toBe(1);
    expect(gh.getPullRequest({ repo: "x/y", number: 9 })).toBeNull();
  });

  test("FakeLinear serves issues and is read-only", () => {
    const lin = new FakeLinear();
    lin.putIssue({ id: "ISH-1", state: "In Progress", labels: [], updatedAt: "2026-01-01T00:00:00Z" });
    expect(lin.readOnly).toBe(true);
    expect(lin.getIssue("ISH-1")?.state).toBe("In Progress");
    expect(lin.getIssue("ISH-404")).toBeNull();
  });
});
