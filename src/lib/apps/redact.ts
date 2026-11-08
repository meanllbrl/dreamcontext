/**
 * The ONE sink every app-derived text passes through before it is logged, stored or answered
 * (dreamcontext-apps plan r19, "redact.ts"): backend stdout/stderr, build output, lastError,
 * MCP stderr, every error body, and `POST /api/apps/:slug/call` / status answers.
 *
 * Values come from the app's `.env`, DC_TOKEN, DC_GATEWAY_SECRET and every resolved MCP env and
 * header value (literals included). Each is matched raw, URL-encoded, JSON-escaped and base64,
 * longest first; a multi-line value line by line. A value of 8+ characters is always masked; a
 * shorter one only when its key names a secret (KEY|TOKEN|SECRET|PASS|PIN), so a short
 * `PORT=3000` does not erase every "3000" in the log. Then `Bearer …` and secret-looking URL
 * query parameters. (`lab/credentials.ts redactSecrets` is not reused: it masks short values
 * everywhere and destroys the log.)
 */

export const MASK = '••••';
const SECRET_KEY = /KEY|TOKEN|SECRET|PASS|PIN/i;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g;
const QUERY_SECRET = /([?&](?:access_token|refresh_token|token|key|api_key|apikey|client_secret|secret|password|passwd|sig|signature|auth|code|appsecret_proof)=)[^&\s"'<>]+/gi;

export interface SecretValue {
  key: string;
  value: string;
}

export type Redactor = (text: string) => string;

function variants(v: string): string[] {
  const out = new Set<string>([v]);
  try { out.add(encodeURIComponent(v)); } catch { /* lone surrogate */ }
  out.add(JSON.stringify(v).slice(1, -1));
  out.add(Buffer.from(v, 'utf-8').toString('base64'));
  out.add(Buffer.from(v, 'utf-8').toString('base64').replace(/=+$/, ''));
  return [...out].filter(Boolean);
}

/** Build the redactor for a set of secret values (call again whenever the set changes). */
export function makeRedactor(secrets: readonly SecretValue[]): Redactor {
  const needles = new Set<string>();
  for (const { key, value } of secrets) {
    if (typeof value !== 'string' || !value) continue;
    const pieces = value.includes('\n') ? value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [value];
    for (const piece of pieces) {
      if (piece.length < 8 && !(SECRET_KEY.test(key) && piece.length >= 3)) continue;
      for (const v of variants(piece)) if (v.length >= 3) needles.add(v);
    }
  }
  const sorted = [...needles].sort((a, b) => b.length - a.length);
  return (text: string): string => {
    if (typeof text !== 'string' || !text) return text;
    let out = text;
    for (const n of sorted) if (out.includes(n)) out = out.split(n).join(MASK);
    return out.replace(BEARER, `$1 ${MASK}`).replace(QUERY_SECRET, `$1${MASK}`);
  };
}

/** Parse a `.env` file's KEY=VALUE pairs (comments, blanks, `export`, quotes). */
export function parseDotenv(text: string): SecretValue[] {
  const out: SecretValue[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out.push({ key: m[1], value: v });
  }
  return out;
}

/**
 * A line-oriented log: chunks are joined into whole lines before they are redacted (a secret
 * split across two writes is still caught), the partial-line buffer is bounded, and the last
 * `cap` lines are kept.
 */
export class LineLog {
  private lines: string[] = [];
  private partial = '';
  constructor(private redact: Redactor, private cap = 2000, private maxPartial = 16 * 1024) {}

  setRedactor(r: Redactor): void {
    this.redact = r;
  }

  write(chunk: string | Buffer, prefix = ''): void {
    this.partial += String(chunk);
    const parts = this.partial.split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    if (this.partial.length > this.maxPartial) {
      parts.push(this.partial);
      this.partial = '';
    }
    for (const p of parts) this.push(prefix + p);
  }

  /** Flush a trailing partial line (the process ended). */
  flush(prefix = ''): void {
    if (this.partial) this.push(prefix + this.partial);
    this.partial = '';
  }

  push(line: string): void {
    this.lines.push(this.redact(line));
    if (this.lines.length > this.cap) this.lines.splice(0, this.lines.length - this.cap);
  }

  tail(n = 200): string[] {
    return this.lines.slice(-Math.max(0, Math.min(n, this.cap)));
  }
}
