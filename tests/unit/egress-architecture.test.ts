import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * One way out. These greps over src/ and scripts/ pin where the OpenRouter endpoint, the recall
 * key and the egress minting may be referenced, so a second code path to the network (or to the
 * key) cannot appear without this test being edited on purpose. (tmp/ is gitignored and out of scope.)
 */
const ROOT = join(__dirname, '..', '..');
const EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.test(name)) out.push(p);
  }
  return out;
}

const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts'))].map((abs) => ({
  rel: relative(ROOT, abs).split(sep).join('/'),
  text: readFileSync(abs, 'utf-8'),
}));

const holders = (re: RegExp, pool = files): string[] => pool.filter((f) => re.test(f.text)).map((f) => f.rel).sort();

const OPENROUTER = 'src/lib/embeddings/openrouter.ts';
const VOICE_OPENROUTER = 'src/lib/voice/openrouter.ts';
const AGENT_VOICE = 'src/server/routes/agent-voice.ts';
const JEV = ['scripts/verify/jev-spike-empty-field.mjs', 'scripts/verify/jev-spike-recall-settings.mjs', 'scripts/verify/jev-walk-funnel.mjs'];

describe('the OpenRouter endpoint', () => {
  it('is named only by the recall client, the voice client and the three jev verify scripts', () => {
    expect(holders(/openrouter\.ai/)).toEqual([OPENROUTER, VOICE_OPENROUTER, ...JEV].sort());
  });

  // PLAN DEVIATION (reported): the plan allowed OPENROUTER_BASE only in embeddings/openrouter.ts, but the
  // voice feature already defines/uses its own OPENROUTER_BASE in these two files. They are voice-only
  // (speech), unrelated to recall; allow-listed explicitly rather than renamed (voice is not this lane).
  it('names OPENROUTER_BASE only in the recall client and the pre-existing voice files', () => {
    expect(holders(/OPENROUTER_BASE/)).toEqual([OPENROUTER, VOICE_OPENROUTER, AGENT_VOICE].sort());
  });

  it('spells the embeddings and rerank API paths only in the recall client (it builds them from the payload endpoint)', () => {
    expect(holders(/\/api\/v1\/(embeddings|rerank)/).filter((f) => f !== OPENROUTER)).toEqual([]);
  });
});

describe('the recall key and the egress minting', () => {
  it('reads the recall key (recallCloudApiKey) only in its definition and the recall client', () => {
    expect(holders(/recallCloudApiKey/)).toEqual([OPENROUTER, 'src/lib/recall-cloud-config.ts'].sort());
  });

  it('resolves minted payloads (resolveEgressPayload) only in egress.ts and the recall client', () => {
    expect(holders(/resolveEgressPayload/)).toEqual([OPENROUTER, 'src/lib/embeddings/egress.ts'].sort());
  });

  it('touches recall-cloud.json only in the config module', () => {
    expect(holders(/recall-cloud\.json/)).toEqual(['src/lib/recall-cloud-config.ts']);
  });

  it('reads a stored OpenRouter key (.openRouterKey) only in the config module, voice, and the jev scripts', () => {
    expect(holders(/\.openRouterKey/)).toEqual(['src/lib/recall-cloud-config.ts', 'src/lib/voice/config.ts', AGENT_VOICE, ...JEV].sort());
  });

  it('calls voiceApiKey( only inside voice, its route, the spoken-summary speaker, and the explicit copy in the config module', () => {
    const outside = holders(/voiceApiKey\(/).filter((f) => !f.startsWith('src/lib/voice/'));
    expect(outside).toEqual(['src/lib/recall-cloud-config.ts', AGENT_VOICE, 'src/server/voice-speak.ts'].sort());
  });
});

describe('the network seam', () => {
  // PLAN DEVIATION (reported): the plan said `fetchImpl` may appear only in its declaration and tests,
  // but ~25 unrelated modules (task backends, git-sync, lab, handsfree, ...) already use a `fetchImpl`
  // DI parameter of their own. The invariant that matters is scoped instead: no recall/embeddings module
  // other than the recall client has it, and nothing that calls the recall client passes one.
  const recallModules = files.filter((f) => f.rel.startsWith('src/lib/embeddings/') || /^src\/lib\/recall-cloud-/.test(f.rel));

  it('keeps fetchImpl (incl. the { fetchImpl } shorthand) out of every recall module but the client', () => {
    expect(holders(/\bfetchImpl\b/, recallModules)).toEqual([OPENROUTER]);
  });

  it('passes no fetchImpl from any non-test caller of the recall client', () => {
    const callers = files.filter((f) => f.rel !== OPENROUTER && /\bopenRouter(Embed|Rerank)\b/.test(f.text));
    expect(callers.length).toBeGreaterThan(0);
    expect(holders(/\bfetchImpl\b/, callers)).toEqual([]);
  });

  it('opens the network from no recall module but the client', () => {
    const strip = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const stripped = recallModules.map((f) => ({ rel: f.rel, text: strip(f.text) }));
    expect(holders(/\bfetch\s*\(|\bglobalThis\.fetch\b|:\s*typeof fetch|:\s*fetch\b|\bhttps?\.request\b/, stripped).filter((f) => f !== OPENROUTER)).toEqual([]);
  });
});
