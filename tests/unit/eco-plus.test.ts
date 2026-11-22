import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lowerModel, resolveSpawnModel, parseModelSource, type ModelSource } from '../../src/lib/eco-plus.js';
import { chatModelSourceFor, ecoPlusLowerModel, ecoPlusSpawnModel, savingModeOf, savingModePatch } from '../../dashboard/src/lib/agentSettings.js';
import { ecoPlusKeepEnv, ECO_PLUS_KEEP_ENV } from '../../src/lib/eco-plus.js';
import { ecoPlusDefault, appendLowered, ecoPlusLoweredPath, appendEcoPlusHistory, ecoPlusHistoryPath } from '../../src/lib/context-watch.js';

/** Plan eco-plus K1 / criterion 2: ONE table through the server rule and the dashboard mirror. */
const HEAVY = ['opus', 'opus[1m]', 'claude-opus-5-5', 'claude-opus-4-8', 'fable', 'claude-fable-5-2', 'claude-opus-5-5[1m]', 'Opus', ''];
const KEPT = ['sonnet', 'haiku', 'claude-haiku-4-5', 'claude-sonnet-5-5', 'sonnet[1m]', 'gpt-5.1'];
const SOURCES: ModelSource[] = ['saved', 'default', 'pick', 'resume'];

describe('lowerModel (D2)', () => {
  it('lowers Opus, Fable and inherit to plain sonnet on both sides', () => {
    for (const m of HEAVY) {
      expect(lowerModel(m)).toBe('sonnet');
      expect(ecoPlusLowerModel(m)).toBe('sonnet');
    }
  });
  it('never touches Sonnet, Haiku or another id', () => {
    for (const m of KEPT) {
      expect(lowerModel(m)).toBe(m);
      expect(ecoPlusLowerModel(m)).toBe(m);
    }
  });
});

describe('resolveSpawnModel (K1): only on + Claude + saved|default', () => {
  const both = (input: Parameters<typeof resolveSpawnModel>[0]) => {
    const a = resolveSpawnModel(input);
    expect(ecoPlusSpawnModel(input)).toEqual(a);
    return a;
  };
  it('lowers a saved or default heavy model, kept for pick and resume', () => {
    for (const m of HEAVY) {
      for (const source of SOURCES) {
        const r = both({ model: m, source, tool: 'claude', on: true });
        if (source === 'saved' || source === 'default') expect(r).toEqual({ model: 'sonnet', lowered: true });
        else expect(r).toEqual({ model: m, lowered: false });
      }
    }
  });
  it('keeps light models, other tools, and everything when off', () => {
    for (const source of SOURCES) {
      for (const m of KEPT) expect(both({ model: m, source, on: true })).toEqual({ model: m, lowered: false });
      for (const m of HEAVY) {
        expect(both({ model: m, source, tool: 'codex', on: true })).toEqual({ model: m, lowered: false });
        expect(both({ model: m, source, tool: 'antigravity', on: true })).toEqual({ model: m, lowered: false });
        expect(both({ model: m, source, tool: 'claude', on: false })).toEqual({ model: m, lowered: false });
      }
    }
  });
  it('an unset tool is Claude', () => {
    expect(both({ model: 'opus', source: 'saved', on: true })).toEqual({ model: 'sonnet', lowered: true });
  });
  it('parseModelSource: unknown or absent is pick (today)', () => {
    expect(parseModelSource('saved')).toBe('saved');
    expect(parseModelSource('resume')).toBe('resume');
    expect(parseModelSource(undefined)).toBe('pick');
    expect(parseModelSource('SAVED')).toBe('pick');
  });
});

describe('a chat\'s model source is where the VALUE came from (review r1)', () => {
  it('a named model is a pick or the resumed conversation\'s own; a filled-in default is saved, on a resume too', () => {
    expect(chatModelSourceFor(true, false)).toBe('pick');
    expect(chatModelSourceFor(true, true)).toBe('resume');
    expect(chatModelSourceFor(false, true)).toBe('saved');
    expect(chatModelSourceFor(false, false)).toBe('saved');
  });
  it('the kept-tree marker: only a named heavy model under Eco Plus', () => {
    expect(ecoPlusKeepEnv('opus', true)[ECO_PLUS_KEEP_ENV]).toBe('1');
    expect(ecoPlusKeepEnv('claude-fable-5-2', true)[ECO_PLUS_KEEP_ENV]).toBe('1');
    expect(ecoPlusKeepEnv('', true)[ECO_PLUS_KEEP_ENV]).toBeUndefined();
    expect(ecoPlusKeepEnv('sonnet', true)[ECO_PLUS_KEEP_ENV]).toBeUndefined();
    expect(ecoPlusKeepEnv('opus', false)[ECO_PLUS_KEEP_ENV]).toBeUndefined();
    expect(Object.keys(ecoPlusKeepEnv('sonnet', true))).toEqual([ECO_PLUS_KEEP_ENV]);
  });
});

describe('the three-way Tasarruf modu (D1)', () => {
  it('reads and writes the stored pair', () => {
    expect(savingModeOf({ ecoMode: false, ecoPlus: false })).toBe('off');
    expect(savingModeOf({ ecoMode: false, ecoPlus: true })).toBe('off');
    expect(savingModeOf({ ecoMode: true, ecoPlus: false })).toBe('eco');
    expect(savingModeOf({ ecoMode: true, ecoPlus: true })).toBe('plus');
    expect(savingModePatch('off')).toEqual({ ecoMode: false, ecoPlus: false });
    expect(savingModePatch('eco')).toEqual({ ecoMode: true, ecoPlus: false });
    expect(savingModePatch('plus')).toEqual({ ecoMode: true, ecoPlus: true });
  });
});

describe('ecoPlusDefault and the measurement logs (K2)', () => {
  let home: string;
  afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); });
  const write = (blob: unknown) => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'agent-ui.json'), typeof blob === 'string' ? blob : JSON.stringify(blob));
  };
  it('is off when missing or unreadable, on only for explicit true with Eco not off', () => {
    home = mkdtempSync(join(tmpdir(), 'eco-plus-'));
    expect(ecoPlusDefault(home)).toBe(false);
    write('{nope');
    expect(ecoPlusDefault(home)).toBe(false);
    write({ ecoPlus: true });
    expect(ecoPlusDefault(home)).toBe(true);
    write({ ecoPlus: true, ecoMode: false });
    expect(ecoPlusDefault(home)).toBe(false);
    write({ ecoPlus: 'true' });
    expect(ecoPlusDefault(home)).toBe(false);
  });
  it('appendLowered appends, and trims lines older than 30 days at most once a day', () => {
    home = mkdtempSync(join(tmpdir(), 'eco-plus-'));
    const day = 24 * 3600_000;
    const t0 = Date.UTC(2026, 10, 1);
    appendLowered({ site: 'chat', from: 'opus', to: 'sonnet' }, home, t0);
    // Trimmed at t0 (first append): the stamp blocks another trim for a day.
    appendLowered({ site: 'agent', agentType: 'goal-validator', from: 'opus', to: 'sonnet' }, home, t0 + 31 * day);
    const lines = () => readFileSync(ecoPlusLoweredPath(home), 'utf-8').trim().split('\n');
    expect(lines()).toHaveLength(1); // the 31-day-later append trimmed the t0 line
    expect(JSON.parse(lines()[0]!).agentType).toBe('goal-validator');
    appendLowered({ site: 'child', from: '', to: 'sonnet' }, home, t0 + 31 * day + 1000);
    expect(lines()).toHaveLength(2);
  });
  it('appendEcoPlusHistory writes one {at,on} line', () => {
    home = mkdtempSync(join(tmpdir(), 'eco-plus-'));
    appendEcoPlusHistory(true, home, 1000);
    expect(existsSync(ecoPlusHistoryPath(home))).toBe(true);
    expect(JSON.parse(readFileSync(ecoPlusHistoryPath(home), 'utf-8').trim())).toEqual({ at: new Date(1000).toISOString(), on: true });
  });
});
