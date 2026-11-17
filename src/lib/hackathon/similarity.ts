/**
 * Similarity between thesis cards (plan C6 peek) and the shared no-tool model call the jury
 * uses too. Every call: `--tools ''`, `--strict-mcp-config`, `--setting-sources ''` written as
 * argv, team text fenced as data. A pair above the gate puts the overlap line into the later
 * team's next round message.
 */
import { spawn } from 'node:child_process';
import { fenceAsData, type ThesisCard } from './team-files.js';
import { teamEnv } from './secrets.js';

/** The argv of a closed model call: no tools, no MCP, no settings. */
export function closedCallArgv(model: string, prompt: string): string[] {
  return [
    '--model', model,
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--permission-mode', 'dontAsk',
    '--output-format', 'json',
    '-p', prompt,
  ];
}

export type ModelCall = (model: string, prompt: string, tool?: 'claude' | 'codex') => Promise<string>;

/** The real call: `claude -p` (or `codex exec` read-only with no tools reachable). */
export const realModelCall: ModelCall = (model, prompt, tool = 'claude') => new Promise((resolve, reject) => {
  const env = teamEnv(process.env, tool);
  const child = tool === 'claude'
    ? spawn('claude', closedCallArgv(model, prompt), { env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('codex', ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-c', 'web_search="disabled"', ...(model ? ['-m', model] : []), prompt], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: process.env.TMPDIR || '/tmp' });
  let out = '';
  child.stdout.on('data', (b: Buffer) => { out += b.toString('utf-8'); });
  const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('model call timed out')); }, 5 * 60_000);
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code !== 0) return reject(new Error(`model call exited ${code}`));
    if (tool === 'claude') {
      try { resolve(String((JSON.parse(out) as { result?: unknown }).result ?? '')); } catch { resolve(out); }
    } else resolve(out);
  });
});

/** The first JSON object in a model's answer. */
export function firstJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
    try {
      const v = JSON.parse(text.slice(start, end + 1));
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* shorter */ }
  }
  return null;
}

const cardText = (c: ThesisCard) => [c.thesis, ...c.claims].join('\n');

export function similarityPrompt(a: ThesisCard, b: ThesisCard): string {
  return [
    'Two hackathon teams wrote these thesis cards. How similar are their APPROACHES (not their wording)?',
    'Answer with one JSON object only: {"score": 0..1, "overlap": "one sentence naming what they share"}.',
    fenceAsData('kart A', cardText(a)),
    fenceAsData('kart B', cardText(b)),
  ].join('\n\n');
}

export interface SimilarPair { a: string; b: string; score: number; overlap: string }

/** Every pair's score; failed calls are skipped (no line is better than a guessed one). */
export async function scorePairs(cards: Record<string, ThesisCard | null>, call: ModelCall, model = 'haiku'): Promise<SimilarPair[]> {
  const ids = Object.keys(cards).filter((k) => cards[k]);
  const out: SimilarPair[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]!; const b = ids[j]!;
      try {
        const j0 = firstJson(await call(model, similarityPrompt(cards[a]!, cards[b]!)));
        const score = typeof j0?.score === 'number' ? Math.max(0, Math.min(1, j0.score)) : NaN;
        if (!Number.isNaN(score)) out.push({ a, b, score, overlap: String(j0?.overlap ?? '').slice(0, 200) });
      } catch { /* skipped */ }
    }
  }
  return out;
}

/**
 * The overlap lines: for each pair above the gate, the LATER team in design order is told to move
 * away from the shared approach in its next round.
 */
export function overlapLines(pairs: readonly SimilarPair[], order: readonly string[], gate: number): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of pairs) {
    if (p.score <= gate) continue;
    const later = order.indexOf(p.a) > order.indexOf(p.b) ? p.a : p.b;
    (out[later] ??= []).push(`=== YAKINSAMA UYARISI ===\nBaşka bir ekiple yaklaşımınız çok benziyor (${p.score.toFixed(2)}): ${p.overlap.replace(/[<>]/g, '')} Bu turda farklı bir yol deneyin.`);
  }
  return out;
}
