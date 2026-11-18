import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  installPlugin,
  installedSet,
  isPluginInstalled,
  pickEntry,
  pinOnThisMac,
  pluginStatuses,
  readEntry,
  readPins,
  removePlugin,
  setPins,
  unknownEntryFiles,
  PluginEntryConflictError,
  UnknownPluginError,
  type PluginEntry,
} from '../../src/lib/plugins/store.js';
import { PLUGINS, pluginGives, getPlugin } from '../../src/lib/plugins/registry.js';
import { readBrainLocal, readSetupConfig, updateSetupConfig, writeBrainLocal } from '../../src/lib/setup-config.js';

let project: string;
let ctx: string;

function write(rel: string, body: string): void {
  const abs = join(ctx, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body, 'utf-8');
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'dc-plugins-'));
  ctx = join(project, '_dream_context');
  mkdirSync(join(ctx, 'state'), { recursive: true });
  writeFileSync(join(ctx, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], multiProduct: false, setupVersion: '0.41.22', disableNativeMemory: true }), 'utf-8');
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe('registry', () => {
  it('lists the five D1 plugins in order with categories and gives', () => {
    expect(PLUGINS.map((p) => p.id)).toEqual(['roadmap', 'hypotheses', 'lab', 'council', 'marketing']);
    expect(getPlugin('lab')!.category).toBe('data');
    expect(pluginGives(getPlugin('lab')!)).toEqual(['screen', 'command', 'agent']);
    expect(pluginGives(getPlugin('marketing')!)).toEqual(['command', 'agent', 'sleep']);
    expect(pluginGives(getPlugin('hypotheses')!)).toEqual(['screen', 'command', 'agent', 'sleep']);
  });
});

describe('derivation (no owner entry → hasData)', () => {
  it('a new project has nothing installed and writes nothing', () => {
    expect(installedSet(ctx)).toEqual([]);
    expect(pluginStatuses(ctx).every((s) => s.source === 'none')).toBe(true);
    expect(existsSync(join(ctx, 'overrides'))).toBe(false);
  });

  it('each plugin counts as installed iff its data exists', () => {
    write('core/objectives/grow.md', '---\nname: grow\n---\n');
    write('lab/insights/wau/manifest.json', '{}');
    write('council/index.json', JSON.stringify([{ id: 'd1' }]));
    mkdirSync(join(ctx, 'marketing'));
    expect(installedSet(ctx)).toEqual(['roadmap', 'lab', 'council', 'marketing']);
    updateSetupConfig(project, { learning: { enabled: true } });
    expect(isPluginInstalled(ctx, 'hypotheses')).toBe(true);
    expect(pluginStatuses(ctx).find((s) => s.id === 'lab')!.source).toBe('data');
  });

  it('thesis files with learning off do not install hypotheses, and stay untouched', () => {
    write('theses/t1.md', 'claim');
    const before = readFileSync(join(ctx, 'theses/t1.md'));
    expect(isPluginInstalled(ctx, 'hypotheses')).toBe(false);
    expect(readFileSync(join(ctx, 'theses/t1.md')).equals(before)).toBe(true);
  });

  it('an empty council index and empty dirs do not count; a lab board does', () => {
    write('council/index.json', '[]');
    mkdirSync(join(ctx, 'core', 'objectives'), { recursive: true });
    mkdirSync(join(ctx, 'lab', 'insights'), { recursive: true });
    expect(installedSet(ctx)).toEqual([]);
    write('lab/boards/main.md', '# board');
    expect(isPluginInstalled(ctx, 'lab')).toBe(true);
  });

  it('a symlinked data path never counts', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dc-plugins-out-'));
    try {
      mkdirSync(join(outside, 'objectives'));
      writeFileSync(join(outside, 'objectives', 'x.md'), 'x');
      mkdirSync(join(ctx, 'core'));
      symlinkSync(join(outside, 'objectives'), join(ctx, 'core', 'objectives'));
      symlinkSync(outside, join(ctx, 'marketing'));
      expect(isPluginInstalled(ctx, 'roadmap')).toBe(false);
      expect(isPluginInstalled(ctx, 'marketing')).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('owner entries', () => {
  it('install then remove writes one entry, keeps data byte-identical', () => {
    write('lab/insights/wau/manifest.json', '{"a":1}');
    const before = readFileSync(join(ctx, 'lab/insights/wau/manifest.json'));
    removePlugin(ctx, 'lab', 'ayse', new Date('2026-11-17T10:00:00Z'));
    expect(isPluginInstalled(ctx, 'lab')).toBe(false);
    expect(readEntry(ctx, 'lab').entry).toEqual({ state: 'removed', at: '2026-11-17T10:00:00.000Z', by: 'ayse' });
    expect(readFileSync(join(ctx, 'lab/insights/wau/manifest.json')).equals(before)).toBe(true);
    installPlugin(ctx, 'lab', 'ayse', new Date('2026-11-17T11:00:00Z'));
    expect(isPluginInstalled(ctx, 'lab')).toBe(true);
    expect(pluginStatuses(ctx).find((s) => s.id === 'lab')!.source).toBe('chosen');
    // Nothing but the entry under overrides/plugins; no temp file left anywhere tracked.
    expect(readdirSync(join(ctx, 'overrides', 'plugins'))).toEqual(['lab.json']);
  });

  it('an unknown id is refused', () => {
    expect(() => installPlugin(ctx, 'hackathon', 'x')).toThrow(UnknownPluginError);
  });

  it('hypotheses install/remove mirrors learning.enabled', () => {
    installPlugin(ctx, 'hypotheses', 'x');
    expect(readSetupConfig(project)?.learning?.enabled).toBe(true);
    removePlugin(ctx, 'hypotheses', 'x');
    expect(readSetupConfig(project)?.learning?.enabled).toBe(false);
    expect(isPluginInstalled(ctx, 'hypotheses')).toBe(false);
  });

  it('files for unknown ids are left alone and listed', () => {
    write('overrides/plugins/hackathon.json', JSON.stringify({ state: 'installed', at: '2026-11-17T00:00:00Z', by: 'x' }));
    installPlugin(ctx, 'council', 'x');
    expect(unknownEntryFiles(ctx)).toEqual(['overrides/plugins/hackathon.json']);
    expect(existsSync(join(ctx, 'overrides/plugins/hackathon.json'))).toBe(true);
  });
});

describe('precedence and conflicts', () => {
  const a: PluginEntry = { state: 'installed', at: '2026-11-17T10:00:00Z', by: 'a' };
  const b: PluginEntry = { state: 'removed', at: '2026-11-17T11:00:00Z', by: 'b' };

  it('pickEntry: later at wins; a tie goes to installed', () => {
    expect(pickEntry(a, b)).toBe(b);
    expect(pickEntry(b, a)).toBe(b);
    const tie: PluginEntry = { ...b, at: a.at };
    expect(pickEntry(tie, a)).toBe(a);
    expect(pickEntry(a, tie)).toBe(a);
  });

  it('a conflict-markered entry resolves by pickEntry and refuses writes naming the file', () => {
    write('council/index.json', '[{"id":"x"}]');
    write('overrides/plugins/council.json', [
      '<<<<<<< HEAD',
      JSON.stringify(a),
      '=======',
      JSON.stringify(b),
      '>>>>>>> theirs',
      '',
    ].join('\n'));
    const read = readEntry(ctx, 'council');
    expect(read.conflict).toBe(true);
    expect(read.entry).toEqual(b);
    expect(isPluginInstalled(ctx, 'council')).toBe(false);
    expect(() => installPlugin(ctx, 'council', 'x')).toThrow(PluginEntryConflictError);
    try {
      installPlugin(ctx, 'council', 'x');
    } catch (err) {
      expect((err as Error).message).toContain('overrides/plugins/council.json');
    }
    // Other plugins are unaffected.
    installPlugin(ctx, 'lab', 'x');
    expect(isPluginInstalled(ctx, 'lab')).toBe(true);
  });

  it('one unparseable side → the parseable side', () => {
    write('overrides/plugins/lab.json', ['<<<<<<< HEAD', '{broken', '=======', JSON.stringify(a), '>>>>>>> x', ''].join('\n'));
    expect(readEntry(ctx, 'lab')).toMatchObject({ conflict: true, entry: a });
  });

  it('a wholly unreadable entry falls back to data and refuses writes', () => {
    write('overrides/plugins/lab.json', 'not json');
    write('lab/boards/b.md', '#');
    const s = pluginStatuses(ctx).find((x) => x.id === 'lab')!;
    expect(s.error).toBeTruthy();
    expect(s.installed).toBe(true);
    expect(() => removePlugin(ctx, 'lab', 'x')).toThrow(PluginEntryConflictError);
  });

  it('a symlinked plugins folder is never read through or written through', () => {
    const outside = mkdtempSync(join(tmpdir(), 'dc-plugins-out-'));
    try {
      writeFileSync(join(outside, 'lab.json'), JSON.stringify(a));
      mkdirSync(join(ctx, 'overrides'));
      symlinkSync(outside, join(ctx, 'overrides', 'plugins'));
      expect(readEntry(ctx, 'lab').entry).toBeNull();
      expect(() => installPlugin(ctx, 'council', 'x')).toThrow(PluginEntryConflictError);
      expect(existsSync(join(outside, 'council.json'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('pins in state/.brain-local.json', () => {
  it('seeds once with the installed set, then follows install/remove from this Mac', () => {
    write('lab/boards/b.md', '#');
    write('core/objectives/o.md', 'x');
    expect(readBrainLocal(project).pluginPins).toBeUndefined();
    expect(readPins(ctx)).toEqual(['roadmap', 'lab']);
    expect(readBrainLocal(project).pluginPins).toEqual(['roadmap', 'lab']);
    installPlugin(ctx, 'council', 'x');
    expect(readPins(ctx)).toEqual(['roadmap', 'lab', 'council']);
    removePlugin(ctx, 'lab', 'x');
    expect(readPins(ctx)).toEqual(['roadmap', 'council']);
  });

  it('[] stays empty and a teammate install does not pin here', () => {
    setPins(ctx, []);
    write('overrides/plugins/lab.json', JSON.stringify({ state: 'installed', at: '2026-11-17T00:00:00Z', by: 'teammate' }));
    expect(readPins(ctx)).toEqual([]);
  });

  it('keeps other brain-local fields and drops unknown or malformed ids', () => {
    writeBrainLocal(project, { lastFetchAt: 42 });
    setPins(ctx, ['lab', 'nope', 'lab']);
    expect(readBrainLocal(project)).toMatchObject({ lastFetchAt: 42, pluginPins: ['lab'] });
    writeFileSync(join(ctx, 'state', '.brain-local.json'), JSON.stringify({ pluginPins: ['lab', 3, '../x'] }));
    expect(readBrainLocal(project).pluginPins).toEqual(['lab']);
    pinOnThisMac(ctx, 'council', true);
    expect(readPins(ctx)).toEqual(['lab', 'council']);
  });
});
