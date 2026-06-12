import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fg from 'fast-glob';
import {
  buildCorpus,
  bm25Search,
  isFederated,
  tokenize,
  docKey,
  type CorpusDoc,
  type CorpusType,
} from './recall.js';
import { readFrontmatter } from './frontmatter.js';
import { DIGEST_SCHEMA_VERSION, type DigestEntry, type DigestEntryKind } from './federation-inbox.js';

/**
 * An interest profile is the set of query terms describing what a PEER cares
 * about. The sender BM25-searches its own corpus against these terms to pick the
 * most relevant entries to push (so we send what the receiver wants, not a dump).
 */
export interface InterestProfile {
  /** Tokenised terms describing the peer's interests. */
  terms: string[];
  /** The raw query string (terms joined) used by bm25Search. */
  query: string;
}

/**
 * Build an interest profile for a PEER from its OWN root — READ-ONLY (no writes,
 * no resolution of further vaults). The profile is the union of:
 *   - the peer corpus's frontmatter tags (what the peer already knows about),
 *   - the peer's active-task terms (slug + title of any in_progress task),
 *   - an explicit `topics` override (the connection's topic filter).
 *
 * When `topics` is a non-empty list it takes precedence as the SOLE signal (the
 * user narrowed the flow deliberately); otherwise the corpus-derived terms drive
 * the profile. The current vault's own corpus is never read here.
 */
export function buildInterestProfile(peerRoot: string, topics?: string[] | null): InterestProfile {
  // Explicit topic override wins — the connection narrowed the flow on purpose.
  if (topics && topics.length > 0) {
    const terms = Array.from(new Set(tokenize(topics.join(' '))));
    return { terms, query: terms.join(' ') };
  }

  const termSet = new Set<string>();

  // Peer corpus tags — read-only, federated docs excluded so the profile reflects
  // the peer's NATIVE interests (not what merely passed through it).
  try {
    const corpus = buildCorpus(peerRoot).filter((doc) => !isFederated(doc));
    for (const doc of corpus) {
      for (const tag of doc.tags) for (const t of tokenize(tag)) termSet.add(t);
    }
  } catch {
    // A peer we can't read yields an empty profile — never throws.
  }

  // Active-task terms (slug + title of an in_progress task) — recent intent.
  for (const t of activeTaskTerms(peerRoot)) termSet.add(t);

  const terms = Array.from(termSet);
  return { terms, query: terms.join(' ') };
}

/** Read terms from the peer's most-recent in_progress task (slug + title). */
function activeTaskTerms(peerRoot: string): string[] {
  const stateDir = join(peerRoot, 'state');
  if (!existsSync(stateDir)) return [];
  let files: string[];
  try {
    files = fg.sync('*.md', { cwd: stateDir, absolute: true });
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const file of files) {
    try {
      const { data } = readFrontmatter(file);
      if (String(data.status ?? '') !== 'in_progress') continue;
      const name = String(data.name ?? data.title ?? '');
      for (const t of tokenize(name)) out.add(t);
    } catch {
      // skip unreadable
    }
  }
  return Array.from(out);
}

/** Map a corpus doc type to a digest entry kind. */
function kindOf(doc: CorpusDoc): DigestEntryKind {
  if (doc.type === 'changelog') return 'changelog';
  // task decisions + memory + knowledge all surface as durable "knowledge",
  // except tasks which we treat as decisions (the durable outcome of the work).
  if (doc.type === 'task') return 'decision';
  return 'knowledge';
}

/** Stable, sanitiser-friendly entry id for a source doc: `<type>/<slug>@<date>`. */
function entryIdFor(doc: CorpusDoc): string {
  const date = doc.updatedAt ?? 'undated';
  return `${docKey(doc)}@${date}`;
}

export interface ComputeDigestOptions {
  /** Restrict the source corpus to these types (defaults to the full corpus). */
  types?: CorpusType[];
  /** Reference time for BM25 recency (determinism in tests). */
  now?: Date;
}

/**
 * Compute the digest the SENDER should push to a peer (P3.3/P3.4). The source
 * set is the sender's corpus MINUS:
 *   - every `federated: true` doc (transitive-leak guard — never re-export what
 *     merely passed through this vault), and
 *   - every doc whose `updatedAt` is `<= sinceISO` (the last sync watermark) —
 *     only changes since the last sync flow. A doc with UNDEFINED `updatedAt` is
 *     INCLUDED (safer to over-send than to silently drop undated knowledge).
 *
 * The surviving docs are BM25-ranked against the peer's interest profile and the
 * top-K become provenance-stamped {@link DigestEntry} objects.
 */
export function computeDigest(
  senderRoot: string,
  senderVaultName: string,
  profile: InterestProfile,
  sinceISO: string | null,
  topK: number,
  opts: ComputeDigestOptions = {},
): DigestEntry[] {
  const now = opts.now ?? new Date();
  const sinceTime = sinceISO ? Date.parse(sinceISO) : NaN;

  const corpus = buildCorpus(senderRoot, opts.types ? { types: opts.types } : {})
    // Transitive-leak guard: never re-export ingested-from-peer docs.
    .filter((doc) => !isFederated(doc))
    // Watermark: only docs changed since the last sync. Undated docs INCLUDE.
    .filter((doc) => {
      if (!doc.updatedAt) return true; // undefined updatedAt → include (safer)
      if (Number.isNaN(sinceTime)) return true; // no prior watermark → include all
      const t = Date.parse(doc.updatedAt);
      if (Number.isNaN(t)) return true; // unparseable date → include
      return t > sinceTime; // strictly newer than the watermark
    });

  if (corpus.length === 0) return [];

  // No profile terms (peer has no expressible interest) → send nothing rather
  // than a blind dump. The receiver can always recall across instead.
  if (profile.terms.length === 0) return [];

  const hits = bm25Search(profile.query, corpus, topK, { now });
  return hits.map((hit) => toEntry(hit.doc, senderVaultName, hit.rankScore));
}

/** Build a provenance-stamped DigestEntry from a source doc. */
function toEntry(doc: CorpusDoc, senderVaultName: string, recallScore: number): DigestEntry {
  const entryId = entryIdFor(doc);
  return {
    version: DIGEST_SCHEMA_VERSION,
    id: `${senderVaultName}:${entryId}`,
    origin: {
      vault: senderVaultName,
      entryId,
      sourceTimestamp: doc.updatedAt ?? null,
    },
    kind: kindOf(doc),
    title: doc.title,
    summary: doc.description || doc.body.slice(0, 280),
    recallScore,
    links: [doc.relPath],
  };
}

/**
 * Conservatively detect cross-vault conflicts: a sender doc whose slug or title
 * matches an EXISTING local doc in the receiver but whose content DIFFERS. Such
 * entries are re-kinded `conflict-note` so ingestion surfaces them as a bookmark
 * for the user rather than auto-resolving them (P3.7).
 *
 * "Conservative" = only flags when there is a same-slug / same-title local doc
 * AND the bodies differ; a brand-new slug is never a conflict.
 */
export function detectConflicts(entries: DigestEntry[], receiverRoot: string): DigestEntry[] {
  let receiverCorpus: CorpusDoc[];
  try {
    receiverCorpus = buildCorpus(receiverRoot);
  } catch {
    return entries; // can't read receiver → no conflicts detectable, pass through
  }
  const bySlug = new Map<string, CorpusDoc>();
  const byTitle = new Map<string, CorpusDoc>();
  for (const doc of receiverCorpus) {
    bySlug.set(doc.slug.toLowerCase(), doc);
    byTitle.set(doc.title.trim().toLowerCase(), doc);
  }

  return entries.map((entry) => {
    const slug = slugFromTitle(entry.title);
    const local = bySlug.get(slug) ?? byTitle.get(entry.title.trim().toLowerCase());
    if (!local) return entry; // new knowledge — no conflict
    // Compare the entry's summary against the local body; differing content on a
    // matching identity is a potential conflict to surface (never auto-resolve).
    const entryContent = entry.summary.trim();
    const localContent = (local.description || local.body).trim();
    if (entryContent && localContent && entryContent !== localContent) {
      return { ...entry, kind: 'conflict-note' as const };
    }
    return entry;
  });
}

/**
 * Derive a kebab-case slug from a title. Mirrors the ingest slug rule so conflict
 * detection and ingestion agree on identity.
 */
export function slugFromTitle(title: string): string {
  const slug = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}
