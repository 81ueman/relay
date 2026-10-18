import { describe, expect, test } from "bun:test";
import { countGraphemes, reverseText } from "../src/ish885b/text";

const samples = [
  "",
  "hello",
  "e\u0301", // e + combining acute
  "a\u0301b",
  "👨‍👩‍👧‍👦", // ZWJ family
  "👍🏽", // skin tone modifier
  "a🇺🇸b", // regional-indicator flag
  "a\r\nb", // CRLF is one grapheme cluster
  "𝄞", // astral-plane code point
  "\uD800", // lone surrogate
];

describe("countGraphemes", () => {
  test("counts user-perceived characters, not UTF-16 code units", () => {
    expect(countGraphemes("hello")).toBe(5);
    expect(countGraphemes("e\u0301")).toBe(1);
    expect(countGraphemes("👨‍👩‍👧‍👦")).toBe(1);
    expect(countGraphemes("👍🏽")).toBe(1);
    expect(countGraphemes("a🇺🇸b")).toBe(3);
    expect(countGraphemes("a\r\nb")).toBe(3);
    expect(countGraphemes("𝄞")).toBe(1);
    expect(countGraphemes("")).toBe(0);
  });
});

describe("reverseText", () => {
  test("reverses clusters and keeps each cluster intact", () => {
    expect(reverseText("hello")).toBe("olleh");
    expect(reverseText("e\u0301")).toBe("e\u0301");
    expect(reverseText("a\u0301b")).toBe("ba\u0301");
    expect(reverseText("a🇺🇸b")).toBe("b🇺🇸a");
    expect(reverseText("👨‍👩‍👧‍👦x")).toBe("x👨‍👩‍👧‍👦");
  });

  test("is its own exact inverse for every sample", () => {
    for (const s of samples) {
      expect(reverseText(reverseText(s))).toBe(s);
    }
  });
});
