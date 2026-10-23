/**
 * Defense-in-depth redaction for text destined for durable evidence.
 *
 * Relay must never persist a credential even when a CLI prints one on an error
 * path. Kept in its own lab-independent module so it outlives the Lab cleanup
 * hook it was first written for.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/(["']?(?:password|token|secret|authorization)["']?\s*[:=]\s*["']?)([^"'\s,}]+)/gi, "$1<redacted>")
    .replace(/\beyJ[A-Za-z0-9._-]{10,}\b/g, "<redacted-jwt>");
}
