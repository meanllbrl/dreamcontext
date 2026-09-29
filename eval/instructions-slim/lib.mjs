/**
 * Shared helpers for the instructions-slim eval (plan r3, task T0).
 *
 * The baseline is a copy of the WORKING TREE taken before any doc edit (the
 * previous wave was uncommitted, so git HEAD is the wrong reference). It lives
 * in the gitignored `tmp/instructions-slim/baseline/` and is guarded by a
 * `SHA256SUMS` manifest: both scripts refuse to compare against a baseline that
 * moved, because a silently edited baseline would make every "nothing lost" and
 * every size delta meaningless.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Thrown when the baseline is missing or no longer matches its manifest. */
export class BaselineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BaselineError';
  }
}

/** Thrown for bad command-line input or a malformed ledger. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export function baselineDir(root) {
  return join(root, 'tmp', 'instructions-slim', 'baseline');
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Check every file listed in SHA256SUMS. Returns the set of verified names.
 * Names are plain file names; anything with a path separator is rejected so a
 * tampered manifest cannot point the scripts outside the baseline directory.
 */
export function verifyBaseline(root) {
  const dir = baselineDir(root);
  const manifestPath = join(dir, 'SHA256SUMS');
  if (!existsSync(manifestPath)) {
    throw new BaselineError(`No baseline manifest at ${relative(root, manifestPath)}. T0 captures it before any doc edit.`);
  }
  const verified = new Set();
  const lines = readFileSync(manifestPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64})\s+\*?(\S.*)$/);
    if (!match) throw new BaselineError(`Malformed SHA256SUMS line: ${line}`);
    const [, expected, name] = match;
    if (name.includes('/') || name.includes('\\') || name.startsWith('.')) {
      throw new BaselineError(`SHA256SUMS names a path outside the baseline directory: ${name}`);
    }
    const file = join(dir, name);
    if (!existsSync(file)) throw new BaselineError(`Baseline file listed in SHA256SUMS is missing: ${name}`);
    const actual = sha256(readFileSync(file));
    if (actual !== expected) {
      throw new BaselineError(`Baseline file ${name} changed since capture (sha256 mismatch). Refusing to compare against a moved baseline.`);
    }
    verified.add(name);
  }
  return verified;
}

export function readBaseline(root, verified, name) {
  if (!verified.has(name)) throw new BaselineError(`${name} is not in the verified baseline manifest.`);
  return readFileSync(join(baselineDir(root), name), 'utf8');
}

/**
 * Resolve a repo-relative path and refuse anything that escapes the root.
 * Ledger `home` values are hand-written, so they are untrusted input.
 */
export function resolveInsideRoot(root, relPath) {
  if (typeof relPath !== 'string' || relPath.trim() === '' || isAbsolute(relPath)) {
    throw new UsageError(`Expected a repo-relative path, got: ${String(relPath)}`);
  }
  const abs = resolve(root, relPath);
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new UsageError(`Path escapes the repository root: ${relPath}`);
  }
  return abs;
}

// ─── Text model ──────────────────────────────────────────────────────────────

/** Minimum normalized length for a unit to be checked (shorter ones are labels). */
export const MIN_UNIT_CHARS = 25;

/**
 * NFC, lowercase, no emphasis or code marks, one dash form, one space form.
 * A table-escaped `\|` folds to `|`: cell extraction unescapes it, and the same
 * sentence must compare equal whether it is read from a cell or a whole file.
 */
export function normalize(text) {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/\\\|/g, '|')
    .replace(/[*`]/g, '')
    .replace(/[\u2014\u2013]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?]+$/u, '')
    .trim();
}

/** Unique words of 4+ letters/digits, the vocabulary the fuzzy pass compares. */
export function tokenize(normalizedText) {
  const words = normalizedText.match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter((w) => w.length >= 4))];
}

function stripFrontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return { body: text, offset: 0 };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { body: text, offset: 0 };
  const after = text.indexOf('\n', end + 1);
  const cut = after === -1 ? text.length : after + 1;
  const offset = text.slice(0, cut).split('\n').length - 1;
  return { body: text.slice(cut), offset };
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

/** Split a table row into cells, honouring `\|` escapes. */
function tableCells(row) {
  const cells = [];
  let current = '';
  const inner = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && inner[i + 1] === '|') {
      current += '|';
      i++;
    } else if (ch === '|') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells.map((c) => c.trim()).filter((c) => c !== '');
}

/**
 * Markdown to blocks: headings, list items (with their continuation lines),
 * table rows (kept whole, plus their cells), paragraphs, and each code line.
 * Every block carries the 1-based line it starts on in the original file.
 */
export function extractBlocks(text) {
  const { body, offset } = stripFrontmatter(text.replace(/\r\n/g, '\n'));
  const lines = body.split('\n');
  const blocks = [];
  let open = null;
  let inFence = false;

  const flush = () => {
    if (open) blocks.push(open);
    open = null;
  };

  lines.forEach((line, index) => {
    const lineNo = index + 1 + offset;
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      inFence = !inFence;
      return;
    }
    if (inFence) {
      if (line.trim() !== '') blocks.push({ kind: 'code', text: line, line: lineNo });
      return;
    }
    if (line.trim() === '') {
      flush();
      return;
    }
    if (/^#{1,6}\s/.test(line)) {
      flush();
      blocks.push({ kind: 'heading', text: line.replace(/^#{1,6}\s+/, ''), line: lineNo });
      return;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      if (TABLE_SEPARATOR.test(line)) return;
      blocks.push({ kind: 'row', text: line, line: lineNo, cells: tableCells(line) });
      return;
    }
    if (LIST_ITEM.test(line)) {
      flush();
      open = { kind: 'item', text: line.replace(LIST_ITEM, ''), line: lineNo };
      return;
    }
    if (open) {
      open.text += `\n${line}`;
      return;
    }
    open = { kind: 'paragraph', text: line, line: lineNo };
  });
  flush();
  return blocks;
}

/**
 * Sentence split that tolerates markdown: a boundary is end punctuation (optionally
 * closed by emphasis, as in a bold rule title `**Recall before grep.**`) plus a
 * likely sentence start.
 */
export function splitSentences(text) {
  return text
    .split(/(?<=[.!?][*_]*)\s+(?=[A-Z0-9`*"'(\[_>])/u)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}
