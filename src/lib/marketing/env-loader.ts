/**
 * Minimal .env loader. Spec from meta-marketing-skill.md:
 *   1. Strip BOM.
 *   2. Support \r\n and \n line endings.
 *   3. # is a comment outside quotes; inline # allowed inside quoted values.
 *   4. KEY=value, value trimmed unless quoted.
 *   5. Double-quote allows \n \t \\ \" escapes; single-quote literal.
 *   6. Multiline only inside double-quoted values.
 *   7. = inside quoted value is literal.
 *   8. Reject keys not matching /^[A-Z_][A-Z0-9_]*$/.
 *   No env-of-env. process.env overrides file (CI safety) — applied by callers.
 */

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

export interface EnvParseError {
  line: number;
  message: string;
}

export interface ParsedEnv {
  values: Record<string, string>;
  errors: EnvParseError[];
}

export function parseEnv(raw: string): ParsedEnv {
  const values: Record<string, string> = {};
  const errors: EnvParseError[] = [];

  // Strip BOM (rule 1)
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

  let i = 0;
  let line = 1;
  const n = raw.length;

  const skipLineWhitespace = (): void => {
    while (i < n && (raw[i] === ' ' || raw[i] === '\t')) i++;
  };

  const readToEol = (): void => {
    while (i < n && raw[i] !== '\n') i++;
    if (i < n && raw[i] === '\n') { i++; line++; }
  };

  while (i < n) {
    skipLineWhitespace();
    // Blank line or comment line
    if (i >= n) break;
    if (raw[i] === '\r') { i++; continue; }
    if (raw[i] === '\n') { i++; line++; continue; }
    if (raw[i] === '#') { readToEol(); continue; }

    // Optional `export ` prefix — tolerate it
    if (raw.startsWith('export ', i)) i += 'export '.length;

    // Read key
    const keyStart = i;
    while (i < n && raw[i] !== '=' && raw[i] !== '\n' && raw[i] !== '\r') i++;
    const key = raw.slice(keyStart, i).trim();

    if (i >= n || raw[i] !== '=') {
      if (key) errors.push({ line, message: `missing '=' for key ${key}` });
      readToEol();
      continue;
    }
    i++; // consume '='

    if (!KEY_RE.test(key)) {
      errors.push({ line, message: `invalid key: ${JSON.stringify(key)}` });
      readToEol();
      continue;
    }

    // Read value
    let value = '';
    skipLineWhitespace();

    if (i < n && raw[i] === '"') {
      // Double-quoted — escape sequences + multiline
      i++;
      const startLine = line;
      while (i < n) {
        const c = raw[i];
        if (c === '\\' && i + 1 < n) {
          const nxt = raw[i + 1];
          if (nxt === 'n') { value += '\n'; i += 2; continue; }
          if (nxt === 't') { value += '\t'; i += 2; continue; }
          if (nxt === '\\') { value += '\\'; i += 2; continue; }
          if (nxt === '"') { value += '"'; i += 2; continue; }
          if (nxt === 'r') { value += '\r'; i += 2; continue; }
          // Unknown escape — keep literal
          value += c; i++; continue;
        }
        if (c === '"') { i++; break; }
        if (c === '\n') line++;
        value += c;
        i++;
      }
      if (i > n) {
        errors.push({ line: startLine, message: `unterminated double-quoted value for ${key}` });
      }
      readToEol();
    } else if (i < n && raw[i] === '\'') {
      // Single-quoted — literal, no multiline (rule 6)
      i++;
      const startLine = line;
      while (i < n && raw[i] !== '\'' && raw[i] !== '\n') {
        value += raw[i]; i++;
      }
      if (i < n && raw[i] === '\'') { i++; }
      else errors.push({ line: startLine, message: `unterminated single-quoted value for ${key}` });
      readToEol();
    } else {
      // Unquoted: trim trailing whitespace + strip inline comment
      let raw_value = '';
      while (i < n && raw[i] !== '\n' && raw[i] !== '\r') {
        raw_value += raw[i]; i++;
      }
      // Strip inline comment (only on unquoted, only at ` #`)
      const hashIdx = findUnquotedHash(raw_value);
      if (hashIdx >= 0) raw_value = raw_value.slice(0, hashIdx);
      value = raw_value.trim();
      readToEol();
    }

    values[key] = value;
  }

  return { values, errors };
}

function findUnquotedHash(s: string): number {
  // A `#` preceded by whitespace (or at start) starts a comment.
  for (let j = 0; j < s.length; j++) {
    if (s[j] === '#') {
      if (j === 0 || s[j - 1] === ' ' || s[j - 1] === '\t') return j;
    }
  }
  return -1;
}
