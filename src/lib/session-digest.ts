import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter } from './frontmatter.js';
import type { DistilledSection } from '../cli/commands/transcript.js';
import {
  type CorpusDoc,
  buildFields,
} from './recall.js';

// ── Bounds for digest selection ──────────────────────────────────────────────
// A digest is a high-signal, BOUNDED snapshot of a session that the SessionStart
// catch-up loop mines once per session (never on the latency-sensitive Stop hook).
// Hard caps keep it cheap to write and cheap to index later.
const DEFAULT_MAX_BYTES = 8000;
const MAX_USER_MESSAGES = 12;
const MAX_DECISIONS = 12;
const MAX_ERRORS = 6;
const MAX_CODE_CHANGES = 10;
const MAX_LINE_CHARS = 240; // hard per-line cap so one giant message can't blow the budget

const DIGESTS_DIRNAME = '.session-digests';

/** One sanitised, length-capped line for the digest. */
function clampLine(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= MAX_LINE_CHARS) return oneLine;
  return oneLine.slice(0, MAX_LINE_CHARS - 1) + '…';
}

/** First line of a (possibly multi-line) code-change blob — the header. */
function codeChangeHeader(change: string): string {
  const firstLine = change.split('\n', 1)[0] ?? '';
  return clampLine(firstLine);
}

/**
 * Build a bounded markdown digest from an already-parsed DistilledSection.
 *
 * Pure (no I/O). Selects the high-signal content — user messages, NON-`[thinking]`
 * agent decisions, errors, and code-change HEADERS (not full diffs) — and emits
 * markdown that is guaranteed ≤ `maxBytes` (UTF-8). The byte cap is enforced by
 * trimming whole lines from the tail, so the output always stays valid markdown.
 *
 * `[thinking]` agent decisions are excluded: internal reasoning is noise for a
 * recall digest and bloats the byte budget.
 */
export function buildDigest(
  distilled: DistilledSection,
  opts: { maxBytes?: number } = {},
): string {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const sections: string[] = ['# Session Digest', ''];

  const userMessages = distilled.userMessages.slice(0, MAX_USER_MESSAGES);
  if (userMessages.length > 0) {
    sections.push('## User Messages');
    for (const m of userMessages) sections.push(`- ${clampLine(m)}`);
    sections.push('');
  }

  // Exclude internal reasoning ([thinking]); keep real decisions/responses.
  const decisions = distilled.agentDecisions
    .filter((d) => !d.startsWith('[thinking]'))
    .slice(0, MAX_DECISIONS);
  if (decisions.length > 0) {
    sections.push('## Decisions');
    for (const d of decisions) sections.push(`- ${clampLine(d)}`);
    sections.push('');
  }

  const errors = distilled.errors.slice(0, MAX_ERRORS);
  if (errors.length > 0) {
    sections.push('## Errors');
    for (const e of errors) sections.push(`- ${clampLine(e)}`);
    sections.push('');
  }

  const codeChanges = distilled.codeChanges.slice(0, MAX_CODE_CHANGES);
  if (codeChanges.length > 0) {
    sections.push('## Code Changes');
    for (const c of codeChanges) sections.push(`- ${codeChangeHeader(c)}`);
    sections.push('');
  }

  return enforceByteCap(sections, maxBytes);
}

/**
 * Join lines and, if the result exceeds `maxBytes` (UTF-8), drop whole lines
 * from the END until it fits. Keeps the leading `# Session Digest` header.
 */
function enforceByteCap(lines: string[], maxBytes: number): string {
  const byteLen = (s: string): number => Buffer.byteLength(s, 'utf-8');
  let working = [...lines];
  let out = working.join('\n');
  while (byteLen(out) > maxBytes && working.length > 1) {
    working.pop();
    out = working.join('\n');
  }
  // Pathological guard: a single header line still over budget → hard slice.
  if (byteLen(out) > maxBytes) {
    out = Buffer.from(out, 'utf-8').subarray(0, maxBytes).toString('utf-8');
  }
  return out.trimEnd() + '\n';
}

// ── Persistence ──────────────────────────────────────────────────────────────

function digestsDir(root: string): string {
  return join(root, 'state', DIGESTS_DIRNAME);
}

function digestPath(root: string, sessionId: string): string {
  // Session IDs are UUID-ish; sanitise to a safe filename defensively.
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(digestsDir(root), `${safe}.md`);
}

/** True if a digest file already exists for this session. */
export function digestExists(root: string, sessionId: string): boolean {
  return existsSync(digestPath(root, sessionId));
}

/**
 * Write a digest markdown file under `state/.session-digests/<sessionId>.md`,
 * stamping `type: session-digest` frontmatter so corpus loaders can recognise it.
 * Returns the absolute path written.
 */
export function writeDigest(root: string, sessionId: string, md: string): string {
  const dir = digestsDir(root);
  mkdirSync(dir, { recursive: true });
  const file = digestPath(root, sessionId);
  // Sanitise before embedding in YAML frontmatter (a stray newline/`:` in a
  // session id would otherwise inject frontmatter keys read back by gray-matter).
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const frontmatter = [
    '---',
    'type: session-digest',
    `session_id: ${safeId}`,
    `created_at: ${new Date().toISOString()}`,
    '---',
    '',
  ].join('\n');
  writeFileSync(file, frontmatter + md, 'utf-8');
  return file;
}

/**
 * Load all session digests as corpus docs (type `task` — they fold under the
 * task channel so salient session moments are recallable before sleep). Mirrors
 * the field/termFreq construction used by the markdown loaders in recall.ts.
 */
export function loadDigestDocs(root: string): CorpusDoc[] {
  const dir = digestsDir(root);
  if (!existsSync(dir)) return [];
  const files = fg.sync('*.md', { cwd: dir, absolute: true });
  const out: CorpusDoc[] = [];
  for (const file of files) {
    try {
      const { data, content } = readFrontmatter(file);
      const sessionId = typeof data.session_id === 'string' ? data.session_id : file;
      const slug = `digest#${sessionId}`;
      const title = `Session digest ${sessionId}`;
      const body = content.trim();
      if (!body) continue;
      const relPath = join('state', DIGESTS_DIRNAME, `${sessionId}.md`);
      const fields = buildFields({ slug, title, description: '', tags: [], body });
      out.push({
        type: 'task',
        path: file,
        relPath,
        slug,
        title,
        description: '',
        tags: [],
        body,
        tokens: fields.tokens,
        tokenSet: new Set(fields.tokens),
        termFreq: fields.termFreq,
        fieldFreq: fields.fieldFreq,
        fieldLen: fields.fieldLen,
        links: fields.links,
        identityTokens: fields.identityTokens,
        updatedAt: typeof data.created_at === 'string' ? data.created_at : undefined,
      });
    } catch {
      // skip malformed digest
    }
  }
  return out;
}
