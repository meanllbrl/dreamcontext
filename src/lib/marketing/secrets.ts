/**
 * Redact secrets in any string before logging or persisting to disk.
 * Patterns covered (per task: System User Token, Bearer values, IG Graph
 * tokens, Pixel hash, Page tokens). Conservative — over-redacts before
 * under-redacts.
 */

const REDACT = '[REDACTED]';

const PATTERNS: Array<{ name: string; re: RegExp; replace: string }> = [
  // Authorization: Bearer <token>
  { name: 'bearer', re: /Bearer\s+[A-Za-z0-9._\-]+/g, replace: 'Bearer ' + REDACT },
  // access_token=<value> in URLs / query strings (defense-in-depth — header-only is enforced elsewhere)
  { name: 'access_token_url', re: /access_token=[A-Za-z0-9._\-|]+/gi, replace: `access_token=${REDACT}` },
  // FB / IG long-lived Graph tokens — typical shape: `EAA...` or pipe-separated `<id>|<secret>`
  { name: 'fb_eaa_token', re: /EAA[A-Za-z0-9]{20,}[A-Za-z0-9_\-]*/g, replace: REDACT },
  // App-id|secret style
  { name: 'app_secret_pair', re: /\b\d{8,}\|[A-Za-z0-9_\-]{16,}\b/g, replace: REDACT },
  // System User Token / Page Token: long base64-ish blobs ≥40 chars
  { name: 'long_blob', re: /\b[A-Za-z0-9]{40,}\b/g, replace: REDACT },
  // SHA-256 (Pixel-hashed PII)
  { name: 'sha256', re: /\b[a-f0-9]{64}\b/g, replace: REDACT },
];

export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  for (const p of PATTERNS) out = out.replace(p.re, p.replace);
  return out;
}

/** Recursively redact secrets in a structured value. Best-effort. */
export function redactDeep<T>(value: T): T {
  if (value == null) return value;
  if (typeof value === 'string') return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map(redactDeep) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}
