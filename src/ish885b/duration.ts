const UNIT_MS: Record<string, bigint> = {
  ms: 1n,
  s: 1_000n,
  m: 60_000n,
  h: 3_600_000n,
  d: 86_400_000n,
};

/**
 * Parse a duration string into whole milliseconds.
 *
 * The grammar is one or more `<quantity><unit>` components with no separator,
 * where `<quantity>` is an integer or decimal (`12` or `1.5`) and `<unit>` is
 * one of `ms`, `s`, `m`, `h`, `d` (case-insensitive). Units may not repeat.
 * The exact total is rounded to the nearest millisecond, half up.
 *
 * Any malformed input returns -1.
 */
export function parseDuration(s: string): number {
  if (typeof s !== "string" || s.length === 0) return -1;

  const component = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gi;
  const parts: Array<{ digits: bigint; fractionDigits: number; unitMs: bigint }> = [];
  const seenUnits = new Set<string>();
  let cursor = 0;
  let maxFractionDigits = 0;

  for (let match = component.exec(s); match !== null; match = component.exec(s)) {
    // Reject anything between components (whitespace, signs, junk, ...).
    if (match.index !== cursor) return -1;

    const unit = match[2].toLowerCase();
    if (seenUnits.has(unit)) return -1;
    seenUnits.add(unit);

    const [whole, fraction = ""] = match[1].split(".");
    parts.push({
      // Concatenating the whole and fractional digits keeps the value exact.
      digits: BigInt(whole + fraction),
      fractionDigits: fraction.length,
      unitMs: UNIT_MS[unit],
    });
    maxFractionDigits = Math.max(maxFractionDigits, fraction.length);
    cursor = component.lastIndex;
  }

  // No complete component, or trailing input after the last component.
  if (cursor !== s.length) return -1;

  const denominator = 10n ** BigInt(maxFractionDigits);
  let numerator = 0n;
  for (const part of parts) {
    const scale = 10n ** BigInt(maxFractionDigits - part.fractionDigits);
    numerator += part.digits * part.unitMs * scale;
  }

  // All durations are non-negative, so this is round-half-up.
  const rounded = (numerator + denominator / 2n) / denominator;
  return Number(rounded);
}
