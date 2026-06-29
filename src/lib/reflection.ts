/**
 * reflection.ts — Deterministic cross-session pattern detection.
 *
 * Scans session digests + bookmarks for recurring terms NOT yet in curated
 * knowledge/features/memory. Surfaces them as CANDIDATE generalizations only;
 * promotion is always a human/sleep-agent decision.
 *
 * Constraints (non-negotiable):
 *  - detectPatterns + formatReflection are PURE (no fs calls).
 *  - writeReflection writes ONLY state/.reflection.md.
 *  - No fetch / spawn / execFile / LLM / network calls anywhere in this file.
 *  - Only imports: node:fs, node:path, tokenize from recall.ts.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tokenize } from './recall.js';
import type { CorpusDoc } from './recall.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_REFLECTION_BYTES = 8000;
export const DEFAULT_MIN_SESSIONS = 3;
export const DEFAULT_MAX_CANDIDATES = 12;

/**
 * Noise terms that are operation/tool/infrastructure chrome rather than
 * domain knowledge. Filtered from candidates before threshold check.
 */
const REFLECTION_NOISE = new Set([
  'command', 'stdout', 'local', 'session', 'digest', 'goal', 'bash',
  'write', 'edit', 'file', 'read', 'run', 'path', 'tool', 'output',
  'agent', 'log', 'error', 'task', 'step', 'line', 'code', 'test',
  'node', 'npm', 'import', 'export', 'function', 'return', 'const',
  'type', 'string', 'number', 'boolean', 'array', 'object', 'null',
  'true', 'false', 'undefined', 'class', 'interface', 'module',
  'async', 'await', 'promise', 'param', 'arg', 'var', 'let',
  'context', 'root', 'dir', 'src', 'dist', 'lib', 'cli', 'config',
  'state', 'status', 'result', 'value', 'key', 'map', 'set', 'list',
  'index', 'count', 'total', 'max', 'min', 'default', 'option',
  'flag', 'prompt', 'message', 'response', 'request', 'data',
  'token', 'text', 'word', 'term', 'doc', 'docs', 'format',
  'build', 'start', 'stop', 'add', 'create', 'delete', 'update',
  'get', 'set', 'push', 'pop', 'join', 'split', 'slice', 'filter',
  'map', 'reduce', 'find', 'sort', 'includes', 'has', 'size', 'length',
  'timestamp', 'date', 'time', 'id', 'uuid', 'slug', 'name', 'title',
  'body', 'head', 'tail', 'chunk', 'block', 'line', 'char', 'byte',
  'utf', 'json', 'yaml', 'md', 'markdown', 'frontmatter',
  'sleep', 'wake', 'consolidat', 'recall', 'snapshot', 'hook',
  'transcript', 'distil', 'bookmark', 'trigger', 'knowleg',
  'featur', 'changelog', 'releas', 'version', 'plan', 'sprint',
  // Sub-agent / tooling coordination chrome that leaks from transcripts:
  // task-notification XML, agent-resume JSON, tool-use ids, skill loaders.
  // (Stemmed forms — see tokenize/stemToken in recall.ts.) task_OwbFN_IV.
  'toolu', 'agentid', 'subagent', 'notification', 'success',
  'successfully', 'resum', 'directory', 'base',
]);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReflectionCandidate {
  term: string;
  sessionCount: number;
  totalOccurrences: number;
}

export interface ReflectionResult {
  candidates: ReflectionCandidate[];
  /** ISO timestamp of when this result was computed */
  generatedAt: string;
  /** How many evidence docs (digests + bookmarks) were analyzed */
  evidenceDocCount: number;
  /** How many distinct sessions appeared in the evidence */
  sessionCount: number;
}

export interface DetectPatternsOptions {
  /** Minimum number of distinct sessions a term must appear in (default 3) */
  minSessions?: number;
  /** Maximum number of candidates to return (default 12) */
  maxCandidates?: number;
  /**
   * Additional excluded tokens — caller provides soul+user tokens so this
   * module stays pure (no fs) while still excluding them.
   */
  excludedExtra?: Set<string>;
  /**
   * Map from bookmark id -> session_id (read from .sleep.json by CLI).
   * Used to collapse multiple bookmarks from the same session into one
   * distinct session for the DF count.
   */
  bookmarkSessions?: Map<string, string>;
}

// ── Core algorithm (PURE — no fs) ─────────────────────────────────────────────

/**
 * Build the set of "excluded" terms: tokens that already appear in curated
 * knowledge/feature docs, memory sections (memory# slugs), and any extra tokens
 * supplied by the caller (soul + user).
 */
function buildExclusionSet(corpus: CorpusDoc[], excludedExtra: Set<string>): Set<string> {
  const excluded = new Set<string>(excludedExtra);
  for (const doc of corpus) {
    const isKnowledgeOrFeature = doc.type === 'knowledge' || doc.type === 'feature';
    const isMemorySection = doc.type === 'memory' && doc.slug.startsWith('memory#');
    if (isKnowledgeOrFeature || isMemorySection) {
      for (const tok of doc.tokens) {
        excluded.add(tok);
      }
    }
  }
  return excluded;
}

/**
 * Resolve the session key for a CorpusDoc evidence document.
 * - Digests: slug = 'digest#<uuid>' → session key = the UUID (slug.slice('digest#'.length))
 * - Bookmarks: slug = 'bookmark#<id>' → look up in bookmarkSessions map for session_id;
 *   fall back to the full slug so each bookmark is still countable.
 */
function sessionKeyFor(
  doc: CorpusDoc,
  bookmarkSessions: Map<string, string>,
): string {
  if (doc.slug.startsWith('digest#')) {
    return doc.slug.slice('digest#'.length);
  }
  if (doc.slug.startsWith('bookmark#')) {
    const id = doc.slug.slice('bookmark#'.length);
    return bookmarkSessions.get(id) ?? doc.slug;
  }
  return doc.slug;
}

/**
 * Detect recurring cross-session term patterns in the corpus.
 *
 * Evidence sources: digests (type:'task', slug 'digest#...') and bookmarks
 * (type:'memory', slug 'bookmark#...'). All other corpus docs are used only
 * to build the exclusion set (knowledge, features, memory sections).
 *
 * Pure function — no I/O.
 */
export function detectPatterns(
  corpus: CorpusDoc[],
  opts: DetectPatternsOptions = {},
): ReflectionResult {
  const minSessions = opts.minSessions ?? DEFAULT_MIN_SESSIONS;
  const maxCandidates = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const excludedExtra = opts.excludedExtra ?? new Set<string>();
  const bookmarkSessions = opts.bookmarkSessions ?? new Map<string, string>();

  // Build exclusion set from curated corpus docs + soul/user tokens
  const excluded = buildExclusionSet(corpus, excludedExtra);

  // Identify evidence docs (digests + bookmarks)
  const evidenceDocs = corpus.filter(
    (doc) =>
      (doc.type === 'task' && doc.slug.startsWith('digest#')) ||
      (doc.type === 'memory' && doc.slug.startsWith('bookmark#')),
  );

  // ── Unigram pass ──────────────────────────────────────────────────────────
  // For each term, track: which sessions it appears in + total occurrences
  const termSessions = new Map<string, Set<string>>();   // term -> Set<sessionKey>
  const termTotal = new Map<string, number>();             // term -> total occurrences

  for (const doc of evidenceDocs) {
    const sessionKey = sessionKeyFor(doc, bookmarkSessions);
    const docTerms = new Set<string>();

    for (const tok of doc.tokens) {
      if (REFLECTION_NOISE.has(tok)) continue;
      if (excluded.has(tok)) continue;
      if (tok.length < 3) continue;
      docTerms.add(tok);
    }

    for (const term of docTerms) {
      if (!termSessions.has(term)) termSessions.set(term, new Set());
      termSessions.get(term)!.add(sessionKey);
    }

    // Count total occurrences (across all tokens, not just unique per doc)
    for (const tok of doc.tokens) {
      if (REFLECTION_NOISE.has(tok)) continue;
      if (excluded.has(tok)) continue;
      if (tok.length < 3) continue;
      termTotal.set(tok, (termTotal.get(tok) ?? 0) + 1);
    }
  }

  // ── Bigram pass ──────────────────────────────────────────────────────────
  const bigramSessions = new Map<string, Set<string>>();
  const bigramTotal = new Map<string, number>();

  for (const doc of evidenceDocs) {
    const sessionKey = sessionKeyFor(doc, bookmarkSessions);
    const toks = doc.tokens;
    const docBigrams = new Set<string>();

    for (let i = 0; i < toks.length - 1; i++) {
      const a = toks[i];
      const b = toks[i + 1];

      // Skip if either half is noise
      if (REFLECTION_NOISE.has(a) || REFLECTION_NOISE.has(b)) continue;
      // Skip if EITHER half is in excluded set — we do not want excluded terms
      // appearing as part of bigram candidates.
      if (excluded.has(a) || excluded.has(b)) continue;
      if (a.length < 3 || b.length < 3) continue;

      const bigram = `${a} ${b}`;
      docBigrams.add(bigram);
    }

    for (const bigram of docBigrams) {
      if (!bigramSessions.has(bigram)) bigramSessions.set(bigram, new Set());
      bigramSessions.get(bigram)!.add(sessionKey);
    }

    // Count total occurrences for bigrams
    for (let i = 0; i < toks.length - 1; i++) {
      const a = toks[i];
      const b = toks[i + 1];
      if (REFLECTION_NOISE.has(a) || REFLECTION_NOISE.has(b)) continue;
      if (excluded.has(a) || excluded.has(b)) continue;
      if (a.length < 3 || b.length < 3) continue;
      const bigram = `${a} ${b}`;
      bigramTotal.set(bigram, (bigramTotal.get(bigram) ?? 0) + 1);
    }
  }

  // ── Threshold filter — minSessions ────────────────────────────────────────
  const qualifyingBigrams = new Set<string>();
  const candidates: ReflectionCandidate[] = [];

  // Collect qualifying bigrams first (bigrams take priority over unigrams)
  for (const [bigram, sessions] of bigramSessions) {
    if (sessions.size >= minSessions) {
      qualifyingBigrams.add(bigram);
    }
  }

  // Add qualifying bigrams to candidates
  for (const bigram of qualifyingBigrams) {
    candidates.push({
      term: bigram,
      sessionCount: bigramSessions.get(bigram)!.size,
      totalOccurrences: bigramTotal.get(bigram) ?? 0,
    });
  }

  // Add qualifying unigrams — but drop if a kept bigram contains it
  const keptBigramTerms = new Set<string>();
  for (const bigram of qualifyingBigrams) {
    for (const part of bigram.split(' ')) {
      keptBigramTerms.add(part);
    }
  }

  for (const [term, sessions] of termSessions) {
    if (sessions.size < minSessions) continue;
    // Drop unigram if a kept bigram contains it
    if (keptBigramTerms.has(term)) continue;
    candidates.push({
      term,
      sessionCount: sessions.size,
      totalOccurrences: termTotal.get(term) ?? 0,
    });
  }

  // ── Sort (deterministic total order) ─────────────────────────────────────
  // sessionCount desc, totalOccurrences desc, term asc
  candidates.sort((a, b) => {
    if (b.sessionCount !== a.sessionCount) return b.sessionCount - a.sessionCount;
    if (b.totalOccurrences !== a.totalOccurrences) return b.totalOccurrences - a.totalOccurrences;
    return a.term < b.term ? -1 : a.term > b.term ? 1 : 0;
  });

  // ── Cap ───────────────────────────────────────────────────────────────────
  const capped = candidates.slice(0, maxCandidates);

  // ── Compute evidence stats ─────────────────────────────────────────────────
  const allSessions = new Set<string>();
  for (const doc of evidenceDocs) {
    allSessions.add(sessionKeyFor(doc, bookmarkSessions));
  }

  return {
    candidates: capped,
    generatedAt: new Date().toISOString(),
    evidenceDocCount: evidenceDocs.length,
    sessionCount: allSessions.size,
  };
}

// ── Formatting (PURE — no fs) ─────────────────────────────────────────────────

/**
 * Mirror of session-digest.ts enforceByteCap — local copy so we do NOT import
 * or modify session-digest.ts. Shape is identical: join lines, drop from tail
 * until within maxBytes.
 */
function capToBytes(lines: string[], maxBytes: number): string {
  const byteLen = (s: string): number => Buffer.byteLength(s, 'utf-8');
  let working = [...lines];
  let out = working.join('\n');
  while (byteLen(out) > maxBytes && working.length > 1) {
    working.pop();
    out = working.join('\n');
  }
  // Pathological guard: single line still over budget → hard slice.
  if (byteLen(out) > maxBytes) {
    out = Buffer.from(out, 'utf-8').subarray(0, maxBytes).toString('utf-8');
  }
  return out.trimEnd() + '\n';
}

/**
 * Format a ReflectionResult as a markdown string, bounded by MAX_REFLECTION_BYTES.
 *
 * Pure function — no I/O.
 */
export function formatReflection(result: ReflectionResult): string {
  const lines: string[] = [
    '# Reflection Candidates',
    '',
    '> **CANDIDATES ONLY** — These terms recur across multiple sessions but are not yet',
    '> captured in soul/user/memory/knowledge. Review each carefully; most are noise.',
    '> Promote ONLY genuinely load-bearing patterns. NEVER auto-promote.',
    '',
    `Generated: ${result.generatedAt}`,
    `Evidence: ${result.evidenceDocCount} docs across ${result.sessionCount} distinct sessions`,
    '',
  ];

  if (result.candidates.length === 0) {
    lines.push('*No recurring patterns found above the threshold.*');
    lines.push('');
  } else {
    lines.push('## Candidates');
    lines.push('');
    lines.push('| Term | Sessions | Occurrences |');
    lines.push('|------|----------|-------------|');
    for (const c of result.candidates) {
      lines.push(`| \`${c.term}\` | ${c.sessionCount} | ${c.totalOccurrences} |`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('*To promote a candidate, add it to `_dream_context/core/2.memory.md` or a*');
    lines.push('*knowledge file. Run `dreamcontext reflect` again to see it excluded.*');
    lines.push('');
  }

  return capToBytes(lines, MAX_REFLECTION_BYTES);
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * The absolute path where the reflection output is written.
 * ONLY path this module ever touches under state/.
 */
export function reflectionPath(root: string): string {
  return join(root, 'state', '.reflection.md');
}

/**
 * Write the reflection markdown to state/.reflection.md.
 *
 * Prepends YAML frontmatter (type + generated_at). Returns the path written.
 * ONLY writes state/.reflection.md — never touches core/, knowledge/, soul, or user.
 */
export function writeReflection(root: string, md: string): string {
  const outPath = reflectionPath(root);
  const dir = dirname(outPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Extract generated_at from the markdown body if present, else now
  const tsMatch = md.match(/Generated: ([^\n]+)/);
  const generatedAt = tsMatch ? tsMatch[1].trim() : new Date().toISOString();

  const frontmatter = [
    '---',
    'type: reflection-candidates',
    `generated_at: '${generatedAt}'`,
    '---',
    '',
  ].join('\n');

  writeFileSync(outPath, frontmatter + md, 'utf-8');
  return outPath;
}
