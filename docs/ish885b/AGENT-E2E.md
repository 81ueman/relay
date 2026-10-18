# ISH-885b Agent E2E

This file is the documentation half of the ISH-885b Agent-owned PR fixture.

`src/ish885b/semver.ts` exports `compareSemver(a, b)`, which orders two
SemVer 2.0.0 version strings by precedence as defined by
[semver.org §11](https://semver.org/#spec-item-11):

- compare `MAJOR`, `MINOR`, and `PATCH` numerically;
- a pre-release version has lower precedence than its release;
- compare dot-separated pre-release identifiers left to right, numeric
  identifiers numerically and alphanumeric identifiers in ASCII order;
- numeric identifiers have lower precedence than non-numeric identifiers;
- a larger set of pre-release fields wins when all preceding fields are equal;
- build metadata is ignored for precedence;
- malformed versions throw.
