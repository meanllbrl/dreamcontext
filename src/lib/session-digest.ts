import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
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

// ── C3 continuous-capture cap ────────────────────────────────────────────────
// Index only the most-recent MAX_INDEXED_DIGESTS session digests (sorted by the
// frontmatter `created_at` date, newest first). Cheap insurance against
// unbounded corpus growth: even with the per-doc rank penalty, an ever-growing
// pile of stale digests would slow every recall (BM25 is O(corpus)) and dilute
// IDF. K=50 ≈ the last ~50 sessions — recent enough that the cross-session
// catch-up loop still finds "what did we just decide", bounded enough that the
// corpus stays small. Older digests remain on disk for sleep consolidation to
// fold into curated knowledge; they're simply not live in recall.
export const MAX_INDEXED_DIGESTS = 50;

/**
 * Coerce a frontmatter `created_at` to an ISO string. gray-matter auto-parses
 * unquoted ISO dates into `Date` objects, so a naive `typeof === 'string'` check
 * silently drops them — which would make the recency cap below treat every
 * digest as undated. Accept both shapes (string passthrough, Date → ISO).
 */
function coerceCreatedAt(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return undefined;
}

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
 * True if the digest on disk is a PARTIAL (mid-session) capture — written by
 * the PreCompact hook before context compaction. Partial digests are
 * placeholders: the SessionStart catch-up re-digests the FULL transcript over
 * them once the session has ended. Missing/unreadable digests count as
 * non-partial (false) so callers fall back to the plain existence check.
 */
export function digestIsPartial(root: string, sessionId: string): boolean {
  const file = digestPath(root, sessionId);
  if (!existsSync(file)) return false;
  try {
    const { data } = readFrontmatter(file);
    return data.partial === true;
  } catch {
    return false;
  }
}

export interface WriteDigestOptions {
  /** Mark as a mid-session (PreCompact) capture, superseded by the full digest later. */
  partial?: boolean;
}

/**
 * Write a digest markdown file under `state/.session-digests/<sessionId>.md`,
 * stamping `type: session-digest` frontmatter so corpus loaders can recognise it.
 * Returns the absolute path written.
 */
export function writeDigest(
  root: string,
  sessionId: string,
  md: string,
  opts: WriteDigestOptions = {},
): string {
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
    ...(opts.partial ? ['partial: true'] : []),
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

  // Parse each digest, carrying its `created_at` so we can keep only the
  // most-recent MAX_INDEXED_DIGESTS (C3 cap). A missing/unparsable date sorts
  // OLDEST (treated as 0) so dated digests are always preferred for the slots.
  interface Parsed { doc: CorpusDoc; createdMs: number; }
  const parsed: Parsed[] = [];
  for (const file of files) {
    try {
      const { data, content } = readFrontmatter(file);
      const sessionId = typeof data.session_id === 'string' ? data.session_id : file;
      const slug = `digest#${sessionId}`;
      const title = `Session digest ${sessionId}`;
      const body = content.trim();
      if (!body) continue;
      const relPath = join('state', DIGESTS_DIRNAME, `${sessionId}.md`);
      const createdAt = coerceCreatedAt(data.created_at);
      const fields = buildFields({ slug, title, description: '', tags: [], body });
      const ms = createdAt ? Date.parse(createdAt) : NaN;
      parsed.push({
        createdMs: Number.isNaN(ms) ? 0 : ms,
        doc: {
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
          updatedAt: createdAt,
          // C3: session digests are continuous captures → rank-penalised.
          capture: true,
        },
      });
    } catch {
      // skip malformed digest
    }
  }

  // Newest first; tie-break on slug for a deterministic order when dates collide
  // (e.g. all-default 0 in tests). Then cap to the most-recent K.
  parsed.sort((a, b) => (b.createdMs - a.createdMs) || a.doc.slug.localeCompare(b.doc.slug));
  return parsed.slice(0, MAX_INDEXED_DIGESTS).map((p) => p.doc);
}

// ── Garbage collection (`sleep done` retention) ──────────────────────────────
// `.session-digests/` grows without bound — every session that has ever been
// analyzed leaves a file on disk, whether or not it is still in the live
// recall index (loadDigestDocs caps the INDEX at MAX_INDEXED_DIGESTS but never
// deletes anything). GC brings on-disk retention in line with what recall
// actually serves, while never deleting a digest a still-pending session needs
// for its own catch-up.

/** Retention count for on-disk digests at `sleep done`. Pinned to
 *  MAX_INDEXED_DIGESTS so GC can never delete a digest that `loadDigestDocs`
 *  still indexes for recall — the two must never drift apart. */
export const DIGEST_GC_KEEP = MAX_INDEXED_DIGESTS;

export interface DigestGcEntry {
  path: string;       // absolute path to the digest file
  sessionId: string;  // frontmatter session_id (falls back to the filename stem)
  createdMs: number;  // parsed frontmatter created_at; 0 when missing/unparsable
}

export interface DigestGcPlan {
  keep: string[];      // absolute paths retained
  deleteAbs: string[]; // absolute paths to delete
}

/**
 * Pure. Keep the newest `keep` entries by `created_at` (same newest-first +
 * tie-break ordering as `loadDigestDocs`, using sessionId in place of the
 * `digest#<sessionId>` slug — an equivalent order since the slug is just that
 * prefix), PLUS every entry whose sessionId is in `protectedSessionIds`
 * regardless of age or rank. Undated/malformed entries carry `createdMs: 0`
 * and sort oldest, so they are the first candidates for deletion unless
 * protected.
 */
export function planDigestGc(
  entries: DigestGcEntry[],
  protectedSessionIds: Set<string>,
  keep: number = DIGEST_GC_KEEP,
): DigestGcPlan {
  const sorted = [...entries].sort(
    (a, b) => (b.createdMs - a.createdMs) || a.sessionId.localeCompare(b.sessionId),
  );

  const keepPaths: string[] = [];
  const deleteAbs: string[] = [];
  sorted.forEach((entry, i) => {
    if (i < keep || protectedSessionIds.has(entry.sessionId)) {
      keepPaths.push(entry.path);
    } else {
      deleteAbs.push(entry.path);
    }
  });

  return { keep: keepPaths, deleteAbs };
}

/**
 * Scan `.session-digests/` into GC planner entries. Best-effort: a malformed
 * frontmatter block is skipped (not thrown), and a missing `session_id` falls
 * back to the filename stem so the entry can still be matched against a
 * protected-session set. Never throws.
 */
export function scanDigests(root: string): DigestGcEntry[] {
  const dir = digestsDir(root);
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = fg.sync('*.md', { cwd: dir, absolute: true });
  } catch {
    return [];
  }

  const entries: DigestGcEntry[] = [];
  for (const file of files) {
    try {
      const { data } = readFrontmatter(file);
      const sessionId = typeof data.session_id === 'string' && data.session_id.trim()
        ? data.session_id
        : basename(file, '.md');
      const createdAt = coerceCreatedAt(data.created_at);
      const ms = createdAt ? Date.parse(createdAt) : NaN;
      entries.push({ path: file, sessionId, createdMs: Number.isNaN(ms) ? 0 : ms });
    } catch {
      // skip malformed digest — best-effort scan
    }
  }
  return entries;
}

/**
 * Execute a GC plan: unlink every path in `plan.deleteAbs`. Best-effort per
 * file — one failed unlink (permissions, already-gone) does not stop the
 * rest. Defense in depth: only ever unlinks paths inside this root's digests
 * directory, even if the plan was built from a stale/malformed entry list.
 * Returns the count actually deleted.
 */
export function runDigestGc(root: string, plan: DigestGcPlan): number {
  const dir = digestsDir(root);
  let deleted = 0;
  for (const path of plan.deleteAbs) {
    if (!path.startsWith(dir)) continue;
    try {
      unlinkSync(path);
      deleted++;
    } catch {
      // best-effort — a single failure must not stop the rest
    }
  }
  return deleted;
}
