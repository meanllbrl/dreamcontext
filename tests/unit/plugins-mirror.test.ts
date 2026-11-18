/**
 * Mağaza D1 (C1/C7): the dashboard's plugin list mirrors the registry (pattern
 * `mirror-with-drift-test`), and every store string exists in English and Turkish.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLUGINS as REGISTRY } from '../../src/lib/plugins/registry.js';
import { PLUGINS, PLUGIN_CATEGORIES, pluginGives } from '../../dashboard/src/lib/plugins.js';

const i18n = readFileSync(new URL('../../dashboard/src/context/I18nContext.tsx', import.meta.url), 'utf8');
const trStart = i18n.indexOf('const TR_PARTIAL');
const en = i18n.slice(0, trStart);
const tr = i18n.slice(trStart);
const has = (block: string, key: string) => block.includes(`'${key}':`);

describe('dashboard plugin mirror', () => {
  it('equals the registry: id, page, category, sleep step, command', () => {
    expect(PLUGINS.map((p) => ({ id: p.id, page: p.page ?? null, category: p.category, sleepStep: p.sleepStep, command: p.command ?? null })))
      .toEqual(REGISTRY.map((p) => ({ id: p.id, page: p.page ?? null, category: p.category, sleepStep: p.sleepStep, command: p.cliRoots[0] ?? null })));
  });

  it('every registry category is a store section', () => {
    for (const p of REGISTRY) expect(PLUGIN_CATEGORIES).toContain(p.category);
  });

  it('"Kurunca gelenler" shows only what the plugin has', () => {
    const gives = Object.fromEntries(PLUGINS.map((p) => [p.id, pluginGives(p)]));
    expect(gives.lab).toEqual(['screen', 'command', 'agent']);
    expect(gives.marketing).toEqual(['command', 'agent', 'sleep']);
    expect(gives.hypotheses).toEqual(['screen', 'command', 'agent', 'sleep']);
  });

  it('every plugin and category string exists in en and tr', () => {
    const keys: string[] = ['nav.store', 'nav.apps'];
    for (const p of PLUGINS) {
      for (const k of ['name', 'tagline', 'desc', 'prompt1', 'prompt2', 'prompt3', 'agent']) keys.push(`plugin.${p.id}.${k}`);
      if (p.sleepStep) keys.push(`plugin.${p.id}.sleep`);
    }
    for (const c of PLUGIN_CATEGORIES) keys.push(`plugin.category.${c}`, `plugin.category.${c}.sub`);
    const shared = [...i18n.matchAll(/'(plugin\.(?:store|give|info|confirm|launch|notice)\.[\w.]+|plugin\.(?:official|by|install|installA11y|installed|open|remove|more|dataStays|conflict|unknown|failed|prompts|gives|info))':/g)].map((m) => m[1]);
    keys.push(...shared);
    const missing = [...new Set(keys)].filter((k) => !has(en, k) || !has(tr, k));
    expect(missing).toEqual([]);
  });
});
