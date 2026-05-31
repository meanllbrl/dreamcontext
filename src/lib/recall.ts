import { existsSync, readFileSync } from 'node:fs';
import { join, basename, dirname, relative } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter } from './frontmatter.js';

// 'skill' docs are produced ONLY by loadSkillDocs (called directly by the hook);
// intentionally excluded from buildCorpus defaults to avoid polluting haikuRecall.
export type CorpusType = 'knowledge' | 'feature' | 'task' | 'memory' | 'changelog' | 'skill';

export interface CorpusDoc {
  type: CorpusType;
  path: string;          // absolute path on disk
  relPath: string;       // path relative to context root
  slug: string;          // basename without .md
  title: string;         // human-readable
  description: string;   // frontmatter description (if any)
  tags: string[];        // frontmatter tags (if any)
  body: string;          // raw body text
  tokens: string[];      // tokenized body+title+description+tags
  tokenSet: Set<string>; // for DF lookup
  termFreq: Map<string, number>;
}

export interface RecallHit {
  doc: CorpusDoc;
  score: number;
  snippet: string;       // ~3 lines around the best match
}

// ─── Tokenization ──────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  // English
  'the','a','an','is','are','was','were','be','been','being','to','of','in','on',
  'at','for','with','by','from','as','that','this','it','its','and','or','but',
  'if','then','else','so','not','no','yes','do','does','did','have','has','had',
  'will','would','could','should','can','may','might','must','i','you','he','she',
  'we','they','them','their','our','your','my','me','us','him','her',
  // Turkish (light)
  've','veya','ile','bir','bu','şu','o','ne','ki','de','da','mı','mi','mu','mü',
  'için','gibi','ama','ya','ben','sen','biz','siz','onlar',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9çğıöşü_\-\s]/g, ' ')
    .split(/[\s_\-]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// ─── Corpus Loader ─────────────────────────────────────────────────────────

function loadMarkdownDocs(
  dir: string,
  type: CorpusType,
  contextRoot: string,
): CorpusDoc[] {
  if (!existsSync(dir)) return [];
  const files = fg.sync('*.md', { cwd: dir, absolute: true });
  const out: CorpusDoc[] = [];
  for (const file of files) {
    try {
      const { data, content } = readFrontmatter(file);
      const slug = basename(file, '.md');
      const title = String(data.name ?? data.title ?? slug);
      const description = String(data.description ?? data.summary ?? '');
      const tags = Array.isArray(data.tags) ? data.tags.map(String) : [];
      const body = content.trim();
      const haystack = [title, description, tags.join(' '), body].join(' ');
      const tokens = tokenize(haystack);
      const termFreq = new Map<string, number>();
      for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
      out.push({
        type,
        path: file,
        relPath: file.replace(contextRoot + '/', ''),
        slug,
        title,
        description,
        tags,
        body,
        tokens,
        tokenSet: new Set(tokens),
        termFreq,
      });
    } catch {
      // skip malformed
    }
  }
  return out;
}

function loadChangelogEntries(contextRoot: string): CorpusDoc[] {
  const path = join(contextRoot, 'core', 'CHANGELOG.json');
  if (!existsSync(path)) return [];
  let entries: Array<Record<string, unknown>> = [];
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    return [];
  }
  const out: CorpusDoc[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const date = String(e.date ?? '');
    const type = String(e.type ?? '');
    const scope = String(e.scope ?? '');
    const description = String(e.description ?? '');
    const summary = typeof e.summary === 'string' ? e.summary : '';
    const refs = Array.isArray(e.references) ? e.references.map(String) : [];
    if (!description && !summary) continue;
    const slug = `changelog#${date}-${scope || type}-${i}`;
    const title = `${date} [${type}] ${scope}${summary ? ` — ${summary}` : ''}`.trim();
    const haystack = [title, summary, description, refs.join(' ')].join(' ');
    const tokens = tokenize(haystack);
    const termFreq = new Map<string, number>();
    for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
    out.push({
      type: 'changelog',
      path,
      relPath: 'core/CHANGELOG.json',
      slug,
      title,
      description: summary || description.slice(0, 200),
      tags: [type, scope].filter(Boolean),
      body: description,
      tokens,
      tokenSet: new Set(tokens),
      termFreq,
    });
  }
  return out;
}

function loadMemoryFile(contextRoot: string): CorpusDoc[] {
  const path = join(contextRoot, 'core', '2.memory.md');
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  // Split LIFO sections by H2 headings; each becomes its own doc.
  const sections = raw.split(/^##\s+/m).slice(1); // skip preamble
  const out: CorpusDoc[] = [];
  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const firstNl = sec.indexOf('\n');
    const heading = (firstNl >= 0 ? sec.slice(0, firstNl) : sec).trim();
    const body = (firstNl >= 0 ? sec.slice(firstNl + 1) : '').trim();
    if (!body) continue;
    const haystack = [heading, body].join(' ');
    const tokens = tokenize(haystack);
    const termFreq = new Map<string, number>();
    for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
    out.push({
      type: 'memory',
      path,
      relPath: 'core/2.memory.md',
      slug: `memory#${i}`,
      title: heading || `memory entry ${i + 1}`,
      description: '',
      tags: [],
      body,
      tokens,
      tokenSet: new Set(tokens),
      termFreq,
    });
  }
  return out;
}

/**
 * Load top-level skill packs as corpus docs for related-skill recall.
 *
 * Only scans `<pack>/SKILL.md` (the `*\/SKILL.md` glob does NOT recurse into
 * nested sub-skill dirs). Skills with `alwaysApply: true` are excluded — they're
 * already loaded, so surfacing them is noise. Produces `type: 'skill'` docs that
 * are intentionally NOT part of buildCorpus (haikuRecall must stay unchanged).
 */
export function loadSkillDocs(skillsRoot: string): CorpusDoc[] {
  if (!existsSync(skillsRoot)) return [];
  const files = fg.sync('*/SKILL.md', { cwd: skillsRoot, absolute: true });
  const out: CorpusDoc[] = [];
  for (const file of files) {
    try {
      const { data, content } = readFrontmatter(file);
      // EXCLUDE always-apply skills — already loaded, surfacing them is noise.
      if (data.alwaysApply === true) continue;
      const slug = (typeof data.name === 'string' && data.name)
        ? data.name
        : basename(dirname(file));
      const title = slug;
      const description = (typeof data.description === 'string') ? data.description : '';
      const tags = Array.isArray(data.tags) ? data.tags.map(String) : [];
      const body = content.trim();
      const haystack = [title, description, tags.join(' '), body].join(' ');
      const tokens = tokenize(haystack);
      const termFreq = new Map<string, number>();
      for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
      out.push({
        type: 'skill',
        path: file,
        relPath: relative(skillsRoot, file),
        slug,
        title,
        description,
        tags,
        body,
        tokens,
        tokenSet: new Set(tokens),
        termFreq,
      });
    } catch {
      // skip malformed
    }
  }
  return out;
}

export interface BuildCorpusOptions {
  types?: CorpusType[];
}

export function buildCorpus(
  contextRoot: string,
  opts: BuildCorpusOptions = {},
): CorpusDoc[] {
  const types = new Set(opts.types ?? ['knowledge', 'feature', 'task', 'memory', 'changelog']);
  const docs: CorpusDoc[] = [];
  if (types.has('knowledge')) {
    docs.push(...loadMarkdownDocs(join(contextRoot, 'knowledge'), 'knowledge', contextRoot));
  }
  if (types.has('feature')) {
    docs.push(...loadMarkdownDocs(join(contextRoot, 'core', 'features'), 'feature', contextRoot));
  }
  if (types.has('task')) {
    docs.push(...loadMarkdownDocs(join(contextRoot, 'state'), 'task', contextRoot));
  }
  if (types.has('memory')) {
    docs.push(...loadMemoryFile(contextRoot));
  }
  if (types.has('changelog')) {
    docs.push(...loadChangelogEntries(contextRoot));
  }
  return docs;
}

// ─── BM25 Scoring ──────────────────────────────────────────────────────────

const K1 = 1.5;
const B = 0.75;

export function bm25Search(
  query: string,
  corpus: CorpusDoc[],
  topK = 5,
): RecallHit[] {
  if (corpus.length === 0) return [];
  const queryTerms = Array.from(new Set(tokenize(query)));
  if (queryTerms.length === 0) return [];

  const N = corpus.length;
  const avgdl = corpus.reduce((s, d) => s + d.tokens.length, 0) / N;

  const df: Record<string, number> = {};
  for (const term of queryTerms) {
    let count = 0;
    for (const d of corpus) if (d.tokenSet.has(term)) count++;
    df[term] = count;
  }

  const scored: RecallHit[] = [];
  for (const doc of corpus) {
    let score = 0;
    const dl = doc.tokens.length || 1;
    for (const term of queryTerms) {
      const tf = doc.termFreq.get(term) ?? 0;
      if (tf === 0) continue;
      const dfT = df[term];
      // BM25+ style epsilon to keep IDF non-negative
      const idf = Math.log(1 + (N - dfT + 0.5) / (dfT + 0.5));
      const num = tf * (K1 + 1);
      const den = tf + K1 * (1 - B + B * (dl / avgdl));
      score += idf * (num / den);
    }
    if (score > 0) {
      scored.push({ doc, score, snippet: extractSnippet(doc, queryTerms) });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// ─── Snippet Extraction ────────────────────────────────────────────────────

function extractSnippet(doc: CorpusDoc, queryTerms: string[]): string {
  const lines = doc.body.split('\n');
  if (lines.length === 0) return '';

  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < lines.length; i++) {
    const lineTokens = tokenize(lines[i]);
    if (lineTokens.length === 0) continue;
    const lineSet = new Set(lineTokens);
    let hits = 0;
    for (const term of queryTerms) if (lineSet.has(term)) hits++;
    if (hits > bestScore) {
      bestScore = hits;
      bestIdx = i;
    }
  }

  const start = Math.max(0, bestIdx - 1);
  const end = Math.min(lines.length, bestIdx + 2);
  return lines.slice(start, end).join('\n').trim();
}
