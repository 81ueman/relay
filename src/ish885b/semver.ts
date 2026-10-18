// SemVer 2.0.0 precedence comparison (https://semver.org/#spec-item-11).
//
// Validation follows the grammar in the specification: a version is
// `MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]`, where the numeric core and any
// numeric pre-release identifiers have no leading zeros. Build metadata is
// validated but ignored for precedence.

export type SemverOrder = -1 | 0 | 1;

interface ParsedSemver {
  readonly major: string;
  readonly minor: string;
  readonly patch: string;
  /** Dot-separated pre-release identifiers, or undefined when absent. */
  readonly prerelease: readonly string[] | undefined;
}

// The official semver.org regular expression. The two alternatives for a
// pre-release identifier encode: a numeric identifier with no leading zeros,
// or an alphanumeric identifier containing at least one non-digit.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const NUMERIC_RE = /^\d+$/;

function parse(version: string): ParsedSemver {
  if (typeof version !== "string") {
    throw new TypeError("compareSemver expects two SemVer 2.0.0 strings");
  }
  const match = SEMVER_RE.exec(version);
  if (match === null) {
    throw new Error(`Invalid SemVer 2.0.0 version: ${JSON.stringify(version)}`);
  }
  const prerelease = match[4];
  return {
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: prerelease === undefined ? undefined : prerelease.split("."),
  };
}

/**
 * Compares two non-negative integers represented as decimal strings without
 * leading zeros. Comparing lengths first keeps this exact for values beyond
 * Number.MAX_SAFE_INTEGER.
 */
function compareNumeric(a: string, b: string): SemverOrder {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Orders two SemVer 2.0.0 version strings by precedence.
 *
 * Returns -1 when `a` has lower precedence than `b`, 0 when they have equal
 * precedence, and 1 when `a` has higher precedence. Build metadata never
 * affects the result. Throws when either input is not a valid SemVer 2.0.0
 * version.
 */
export function compareSemver(a: string, b: string): SemverOrder {
  const left = parse(a);
  const right = parse(b);

  const core = (compareNumeric(left.major, right.major) ||
    compareNumeric(left.minor, right.minor) ||
    compareNumeric(left.patch, right.patch)) as number;
  if (core !== 0) return core < 0 ? -1 : 1;

  // A version with a pre-release has lower precedence than the same version
  // without one.
  if (left.prerelease === undefined && right.prerelease === undefined) return 0;
  if (left.prerelease === undefined) return 1;
  if (right.prerelease === undefined) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const x = left.prerelease[i];
    const y = right.prerelease[i];

    // A larger set of pre-release fields has higher precedence when all of the
    // preceding identifiers are equal.
    if (x === undefined) return -1;
    if (y === undefined) return 1;

    const xNumeric = NUMERIC_RE.test(x);
    const yNumeric = NUMERIC_RE.test(y);

    if (xNumeric && yNumeric) {
      const order = compareNumeric(x, y);
      if (order !== 0) return order;
    } else if (xNumeric) {
      // Numeric identifiers always have lower precedence than non-numeric.
      return -1;
    } else if (yNumeric) {
      return 1;
    } else if (x !== y) {
      // Both are alphanumeric: compare lexically in ASCII sort order.
      return x < y ? -1 : 1;
    }
  }

  return 0;
}
