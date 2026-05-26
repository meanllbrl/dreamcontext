import { execFileSync } from 'node:child_process';
import type { CorpusType } from './recall.js';

export interface ExtractedQuery {
  q: string;
  types?: CorpusType[];
}

export interface ExtractionResult {
  queries: ExtractedQuery[];
  skip: boolean;
}

export type ClaudeExecutor = (prompt: string, systemPrompt: string) => string;

const FALLBACK: ExtractionResult = { queries: [], skip: false };

const VALID_CORPUS_TYPES = new Set<string>([
  'knowledge', 'feature', 'task', 'memory', 'changelog',
]);

export const SYSTEM_PROMPT = `Extract 1-3 BM25 search queries from the user's message for a project memory system.

Corpus types: knowledge, feature, task, memory, changelog.

Return ONLY valid JSON: {"queries":[{"q":"2-4 keywords"}],"skip":false}
- Extract domain-relevant keywords, strip conversational filler
- skip=true ONLY if prompt has zero searchable intent (greetings, "ok", "yes")
- Do NOT add "types" filtering — always search all types`;

const DEFAULT_TIMEOUT_MS = 15_000;

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

function stripCodeBlock(text: string): string {
  const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (match) return match[1].trim();
  return text.trim();
}

function parseExtractionResult(raw: string): ExtractionResult {
  const json = stripCodeBlock(raw);
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== 'object') return FALLBACK;

  const obj = parsed as Record<string, unknown>;
  const skip = obj.skip === true;
  const rawQueries = Array.isArray(obj.queries) ? obj.queries : [];

  const queries: ExtractedQuery[] = [];
  for (const entry of rawQueries) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.q !== 'string' || !e.q.trim()) continue;
    const extracted: ExtractedQuery = { q: e.q.trim() };
    if (Array.isArray(e.types)) {
      const filtered = e.types
        .filter((t): t is string => typeof t === 'string' && VALID_CORPUS_TYPES.has(t));
      if (filtered.length > 0) extracted.types = filtered as CorpusType[];
    }
    queries.push(extracted);
  }

  return { queries, skip };
}

export function extractRecallQueries(
  rawPrompt: string,
  opts?: {
    executor?: ClaudeExecutor;
    timeoutMs?: number;
  },
): ExtractionResult {
  try {
    const executor = opts?.executor ?? defaultExecutor;
    const output = executor(rawPrompt, SYSTEM_PROMPT);
    return parseExtractionResult(output);
  } catch {
    return FALLBACK;
  }
}
