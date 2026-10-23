import { describe, expect, test } from "bun:test";
import { redactSecrets } from "../src/redact";

// ISH-1099: the redaction helper used by the pinned Run brief was moved out of
// the removed Lab module; its behaviour is unchanged.

describe("redactSecrets", () => {
  test("strips bearer tokens, password values and JWTs", () => {
    const s = redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def and password="hunter2"');
    expect(s).not.toContain("hunter2");
    expect(s).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(s).toContain("<redacted");
  });
});
