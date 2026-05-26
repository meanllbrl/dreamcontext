import { execFileSync } from 'node:child_process';
import { buildCorpus, type CorpusDoc, type RecallHit } from './recall.js';

export type ClaudeExecutor = (prompt: string, systemPrompt: string) => string;

// 'skip' = no recall needed, null = fallback to raw BM25
export type HaikuRecallResult = RecallHit[] | 'skip' | null;

const SYSTEM_TEMPLATE = `You are a memory recall filter for an AI coding agent. Given a user prompt and a corpus index of project documents, decide which documents (0-3) are DIRECTLY relevant to what the user needs.

Rules:
- Return 0 docs if nothing is relevant — zero noise is better than wrong context
- skip=true ONLY for pure greetings/acknowledgments ("ok", "evet", "tamam", "devam", "yes", "no")
- The user may write in Turkish, English, or mixed — understand intent in any language
- The corpus is in English — match concepts across languages
- Prefer specific docs over generic ones
- For each selected doc, write a short reason (1 sentence) explaining WHY it is relevant to this specific prompt

Corpus:
{INDEX}

Return ONLY valid JSON:
{"docs":[{"key":"type/slug","reason":"why this doc matters for the prompt"}],"skip":false}

If nothing is relevant: {"docs":[],"skip":false}
If pure greeting: {"skip":true}`;

const DEFAULT_TIMEOUT_MS = 120_000;

const defaultExecutor: ClaudeExecutor = (prompt, systemPrompt) => {
  return execFileSync('claude', [
    '--model', 'haiku',
    '-p',
    '--setting-sources', '',
    '--tools', '',
    '--no-session-persistence',
    '--exclude-dynamic-system-prompt-sections',
    '--system-prompt', systemPrompt,
    prompt,
  ], {
    timeout: DEFAULT_TIMEOUT_MS,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
};

export function buildCorpusIndex(corpus: CorpusDoc[]): string {
  return corpus.map(d => {
    const desc = d.description ? ` — ${d.description}` : '';
    const tags = d.tags.length > 0 ? `. Tags: ${d.tags.join(', ')}` : '';
    return `[${d.type}] ${d.slug}${desc}${tags}`;
  }).join('\n');
}

function stripCodeBlock(text: string): string {
  const match = text.match(/```(?:\w+)?\s*\n?([\s\S]*?)\n?\s*```/i);
  if (match) return match[1].trim();
  return text.trim();
}

export function haikuRecall(
  rawPrompt: string,
  contextRoot: string,
  opts?: { executor?: ClaudeExecutor },
): HaikuRecallResult {
  try {
    const corpus = buildCorpus(contextRoot);
    if (corpus.length === 0) return null;

    const MAX_INDEX_CHARS = 8_000;
    const fullIndex = buildCorpusIndex(corpus);
    const index = fullIndex.length > MAX_INDEX_CHARS
      ? fullIndex.slice(0, MAX_INDEX_CHARS) + '\n[...truncated]'
      : fullIndex;
    const systemPrompt = SYSTEM_TEMPLATE.replace('{INDEX}', index);

    const executor = opts?.executor ?? defaultExecutor;
    const output = executor(rawPrompt, systemPrompt);

    const json = stripCodeBlock(output);
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;

    const obj = parsed as Record<string, unknown>;
    if (obj.skip === true) return 'skip';

    const rawDocs = Array.isArray(obj.docs) ? obj.docs : [];
    if (rawDocs.length === 0) return [];

    const lookup = new Map<string, CorpusDoc>();
    for (const doc of corpus) {
      lookup.set(`${doc.type}/${doc.slug}`, doc);
    }

    const hits: RecallHit[] = [];
    for (const entry of rawDocs) {
      let key: string;
      let reason = '';
      if (typeof entry === 'string') {
        key = entry;
      } else if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).key === 'string') {
        key = (entry as Record<string, unknown>).key as string;
        reason = String((entry as Record<string, unknown>).reason ?? '');
      } else {
        continue;
      }
      const doc = lookup.get(key);
      if (!doc) continue;
      hits.push({ doc, score: 0, snippet: reason });
      if (hits.length >= 3) break;
    }

    return hits;
  } catch (err) {
    if (process.env.DREAMCONTEXT_DEBUG) {
      console.error('[haikuRecall]', (err as Error).message ?? err);
    }
    return null;
  }
}
