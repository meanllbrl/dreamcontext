/**
 * Drift test for `src/lib/model-facts.ts`, the ONE place the app writes down what a Claude
 * model costs and is for. Every other list is either derived from it (and tested to be) or a
 * dashboard mirror (the dashboard has its own tsconfig) read here and compared.
 *
 * Pattern: mirror-with-drift-test. The mutation cases at the bottom prove the comparison
 * itself bites: change one fact and `mirrorDrift` reports it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MODEL_FACTS, MODEL_ALIASES, LEGACY_MODEL_PRICES, LEGACY_SLEEP_MODEL_IDS, SLEEP_MODEL_PICKER_IDS,
  SMALL_WINDOW_MODEL, priceForModelId, type ModelFact,
} from '../../src/lib/model-facts.js';
import { BASE_MODEL_OPTIONS, modelAlias } from '../../src/lib/model-list.js';
import { KNOWN_SLEEP_MODELS } from '../../src/lib/setup-config.js';
import { priceForModel, contextLimitFor } from '../../src/server/routes/agent-terminal.js';
import {
  FALLBACK_MODEL_CONFIG, MODEL_INSIGHTS, modelFamily,
  SMALL_WINDOW_MODEL as DASHBOARD_SMALL_WINDOW_MODEL,
} from '../../dashboard/src/lib/agentComposer.js';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8');

/** The quoted words of the first array literal after `anchor` in a source file. */
function quotedList(source: string, anchor: RegExp): string[] {
  const m = anchor.exec(source);
  if (!m) throw new Error(`anchor not found: ${anchor}`);
  const rest = source.slice(m.index + m[0].length);
  const body = /\[([^\]]*)\]/.exec(rest);
  if (!body) throw new Error(`no array after ${anchor}`);
  return [...body[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** Every place the facts are copied, compared against `facts`; the list of mismatches. */
function mirrorDrift(facts: readonly ModelFact[]): string[] {
  const out: string[] = [];
  const aliases = facts.map((f) => f.alias).sort();
  const eq = (name: string, got: readonly string[]) => {
    if (JSON.stringify([...got].sort()) !== JSON.stringify(aliases)) out.push(`${name}: ${got.join(',')} != ${aliases.join(',')}`);
  };
  eq('BASE_MODEL_OPTIONS', BASE_MODEL_OPTIONS.map((o) => o.id));
  eq('FALLBACK_MODEL_CONFIG', FALLBACK_MODEL_CONFIG.models.map((o) => o.id));
  eq('AutomationDialog MODELS', quotedList(read('dashboard/src/components/agents/AutomationDialog.tsx'), /const MODELS = /));
  eq('chatEntities MODEL_FAMILIES', quotedList(read('dashboard/src/components/sleepy/chat/chatEntities.ts'), /const MODEL_FAMILIES = /));
  eq('agentComposer MODEL_FAMILIES', quotedList(read('dashboard/src/lib/agentComposer.ts'), /const MODEL_FAMILIES = /));
  for (const f of facts) {
    if (MODEL_INSIGHTS[f.family]?.insight !== f.note) out.push(`MODEL_INSIGHTS.${f.family}.insight != note`);
    if (modelFamily(f.id) !== f.family) out.push(`modelFamily(${f.id}) != ${f.family}`);
  }
  const picker = quotedList(read('dashboard/src/hooks/useConfig.ts'), /const SLEEP_MODEL_OPTIONS = /);
  const wanted = facts.filter((f) => f.sleepOption).map((f) => f.id);
  if (JSON.stringify(picker) !== JSON.stringify(wanted)) out.push(`SLEEP_MODEL_OPTIONS: ${picker.join(',')} != ${wanted.join(',')}`);
  return out;
}

describe('model-facts — the single source', () => {
  it('has one current model per family with sane numbers', () => {
    expect(MODEL_FACTS.map((f) => f.family).sort()).toEqual(['fable', 'haiku', 'opus', 'sonnet']);
    for (const f of MODEL_FACTS) {
      expect(f.id).toMatch(/^claude-[a-z]+-\d+-\d+$/);
      expect(f.price.in).toBeGreaterThan(0);
      expect(f.price.out).toBeGreaterThan(f.price.in);
      // The 5-minute cache-write rate is 1.25x input; the read rate is the docs' own number.
      expect(f.price.cacheWrite).toBeCloseTo(f.price.in * 1.25, 6);
      expect(f.price.cacheRead).toBeGreaterThan(0);
      expect(f.price.cacheRead).toBeLessThan(f.price.in);
      expect(f.note.length).toBeGreaterThan(10);
    }
  });

  it('every copy of the facts agrees with it (alias lists, notes, family lists, sleep picker)', () => {
    expect(mirrorDrift(MODEL_FACTS)).toEqual([]);
  });

  it('the mirror check bites: one changed fact is reported', () => {
    const clone = (over: Partial<ModelFact>, family: string): ModelFact[] =>
      MODEL_FACTS.map((f) => (f.family === family ? { ...f, ...over } : f));
    expect(mirrorDrift(clone({ note: 'changed' }, 'opus')).join()).toContain('MODEL_INSIGHTS.opus');
    expect(mirrorDrift(clone({ alias: 'zeta' as never }, 'haiku')).length).toBeGreaterThan(0);
    expect(mirrorDrift(clone({ sleepOption: false }, 'sonnet')).join()).toContain('SLEEP_MODEL_OPTIONS');
  });
});

describe('model-facts — readout, window, picker', () => {
  it('the cost readout resolves every current id and alias to its MODEL_FACTS row', () => {
    for (const f of MODEL_FACTS) {
      expect(priceForModel(f.id)).toEqual(f.price);
      expect(priceForModel(f.alias)).toEqual(f.price);
      expect(priceForModelId(f.id)).toEqual(f.price);
    }
  });

  it('every legacy row is fully priced and none shadows a current id', () => {
    for (const row of LEGACY_MODEL_PRICES) {
      expect(row.price.in).toBeGreaterThan(0);
      expect(row.price.cacheRead).toBeGreaterThan(0);
      for (const f of MODEL_FACTS) {
        // The Fable 5.1 row is reachable through the `mythos` catch-all by design.
        if (row.pattern.source === 'mythos') continue;
        expect(row.pattern.test(f.id)).toBe(false);
      }
    }
  });

  it('one older id per family resolves to its legacy price, mythos to Fable', () => {
    expect(priceForModel('claude-opus-5').in).toBe(5);
    expect(priceForModel('claude-opus-4-1').in).toBe(15);
    expect(priceForModel('claude-sonnet-5').cacheRead).toBe(0.2);
    expect(priceForModel('claude-sonnet-4-6').in).toBe(3);
    expect(priceForModel('claude-haiku-4-5').in).toBe(1);
    expect(priceForModel('claude-fable-5').cacheRead).toBe(1);
    expect(priceForModel('claude-mythos-5').in).toBe(10);
  });

  it('claude-haiku-5-5 shows the 1M window in both copies; the 4.x line keeps 200K', () => {
    expect(SMALL_WINDOW_MODEL.test('claude-haiku-5-5')).toBe(false);
    expect(DASHBOARD_SMALL_WINDOW_MODEL.test('claude-haiku-5-5')).toBe(false);
    expect(contextLimitFor(1000, 'claude-haiku-5-5')).toBe(1_000_000);
    expect(contextLimitFor(1000, 'claude-haiku-4-5-20251001')).toBe(200_000);
    expect(DASHBOARD_SMALL_WINDOW_MODEL.source).toBe(SMALL_WINDOW_MODEL.source);
  });

  it('modelAlias keeps mapping every id to its family bucket', () => {
    for (const f of MODEL_FACTS) expect(modelAlias(f.id)).toBe(f.alias);
    expect(modelAlias('claude-opus-4-1-20250805')).toBe('opus');
    expect(modelAlias('totally-unknown')).toBe('totally-unknown');
  });

  it('sleep config accepts the current ids, the aliases and the old ids, and still refuses a typo', () => {
    for (const f of MODEL_FACTS) {
      expect(KNOWN_SLEEP_MODELS).toContain(f.id);
      expect(KNOWN_SLEEP_MODELS).toContain(f.alias);
    }
    for (const old of LEGACY_SLEEP_MODEL_IDS) expect(KNOWN_SLEEP_MODELS).toContain(old);
    expect(KNOWN_SLEEP_MODELS).not.toContain('claude-opus5');
    for (const m of KNOWN_SLEEP_MODELS) expect(/^[A-Za-z0-9._-]+$/.test(m)).toBe(true);
    expect(SLEEP_MODEL_PICKER_IDS).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(MODEL_ALIASES).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
  });
});
