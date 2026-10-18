import { describe, expect, test } from "bun:test";
import { parseDuration } from "../src/ish885b/duration";

describe("parseDuration", () => {
  test("parses each supported unit", () => {
    expect(parseDuration("7ms")).toBe(7);
    expect(parseDuration("2s")).toBe(2_000);
    expect(parseDuration("3m")).toBe(180_000);
    expect(parseDuration("4h")).toBe(14_400_000);
    expect(parseDuration("5d")).toBe(432_000_000);
  });

  test("is case-insensitive", () => {
    expect(parseDuration("1MS")).toBe(1);
    expect(parseDuration("1S")).toBe(1_000);
    expect(parseDuration("1M")).toBe(60_000);
    expect(parseDuration("1H")).toBe(3_600_000);
    expect(parseDuration("1D")).toBe(86_400_000);
  });

  test("accepts concatenated components without a separator", () => {
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("1d2h3m4s")).toBe(93_784_000);
    expect(parseDuration("1D2H3M4S")).toBe(93_784_000);
  });

  test("accepts decimal quantities and rounds the total half up", () => {
    expect(parseDuration("1.5s")).toBe(1_500);
    expect(parseDuration("0.5ms")).toBe(1);
    expect(parseDuration("0.4999ms")).toBe(0);
    expect(parseDuration("0.0005s")).toBe(1);
    expect(parseDuration("1.0005s")).toBe(1_001);
    expect(parseDuration("0ms")).toBe(0);
  });

  test("returns -1 for malformed input", () => {
    for (const bad of [
      "",
      " ",
      " 1s",
      "1s ",
      "1 s",
      "1s 2m",
      "1",
      "1.5",
      "1x",
      "s",
      "ms",
      "-1s",
      "+1s",
      "1s2s",
      "1S2s",
      "1s-2m",
      "1.s",
      ".5s",
      "1e3s",
      "1..5s",
      "1s2",
    ]) {
      expect(parseDuration(bad)).toBe(-1);
    }
  });
});
