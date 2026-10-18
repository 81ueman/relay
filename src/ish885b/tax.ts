/**
 * Add tax to an integer amount in cents.
 *
 * The result is the amount plus the tax rounded to the nearest cent, with
 * exact half cents rounded away from zero. That means a negative half cent
 * rounds down, e.g. withTax(-1000, 55) === -1006.
 */
export function withTax(cents: number, rateBps: number): number {
  const tax = Math.round((Math.abs(cents) * rateBps) / 10000);
  return cents + Math.sign(cents) * tax;
}
