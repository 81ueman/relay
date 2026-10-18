/**
 * ISH-885b — text helpers that operate on USER-PERCEIVED CHARACTERS.
 *
 * A user-perceived character is a Unicode grapheme cluster (UAX #29), not a
 * UTF-16 code unit and not a code point. `Intl.Segmenter` implements the
 * grapheme rules, so combining marks, emoji ZWJ sequences, skin-tone
 * modifiers, flags and CRLF stay intact.
 */

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

/** Number of user-perceived characters (grapheme clusters) in `s`. */
export function countGraphemes(s: string): number {
  let count = 0;
  for (const _segment of graphemeSegmenter.segment(s)) {
    count += 1;
  }
  return count;
}

/**
 * Reverse a string by user-perceived characters (grapheme clusters).
 *
 * Each cluster is copied verbatim, so this is an exact involution for every
 * input: `reverseText(reverseText(s)) === s`.
 */
export function reverseText(s: string): string {
  const clusters: string[] = [];
  for (const { segment } of graphemeSegmenter.segment(s)) {
    clusters.push(segment);
  }
  return clusters.reverse().join("");
}
