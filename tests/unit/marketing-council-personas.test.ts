import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadAllPersonas,
  parsePersonaFile,
  selectPersonas,
  findPersonasDir,
} from '../../src/lib/marketing/council-personas.js';

function makeDir(): string {
  const raw = join(tmpdir(), `mk-personas-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

describe('marketing/council-personas — parsePersonaFile', () => {
  let dir: string;

  beforeEach(() => { dir = makeDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('parses a valid persona file', () => {
    const path = join(dir, 'p.md');
    writeFileSync(path, `---
slug: my-persona
model: opus
aspects:
  - one
  - two
---

## Persona

# My Persona

Body content here.
`);
    const p = parsePersonaFile(path);
    expect(p.slug).toBe('my-persona');
    expect(p.model).toBe('opus');
    expect(p.aspects).toEqual(['one', 'two']);
    expect(p.body).toContain('# My Persona');
    expect(p.body).toContain('Body content here.');
    expect(p.filePath).toBe(path);
  });

  it('rejects invalid slug', () => {
    const path = join(dir, 'p.md');
    writeFileSync(path, '---\nslug: BAD SLUG\nmodel: opus\n---\n\nbody\n');
    expect(() => parsePersonaFile(path)).toThrow(/Invalid persona slug/);
  });

  it('rejects unknown model', () => {
    const path = join(dir, 'p.md');
    writeFileSync(path, '---\nslug: ok\nmodel: gpt-99\n---\n\nbody\n');
    expect(() => parsePersonaFile(path)).toThrow(/Invalid persona model/);
  });

  it('rejects missing model', () => {
    const path = join(dir, 'p.md');
    writeFileSync(path, '---\nslug: ok\n---\n\nbody\n');
    expect(() => parsePersonaFile(path)).toThrow(/Invalid persona model/);
  });

  it('rejects empty body', () => {
    const path = join(dir, 'p.md');
    writeFileSync(path, '---\nslug: ok\nmodel: opus\n---\n\n');
    expect(() => parsePersonaFile(path)).toThrow(/body is empty/);
  });

  it('handles missing aspects (defaults to [])', () => {
    const path = join(dir, 'p.md');
    writeFileSync(path, '---\nslug: ok\nmodel: opus\n---\n\nbody content\n');
    const p = parsePersonaFile(path);
    expect(p.aspects).toEqual([]);
  });
});

describe('marketing/council-personas — loadAllPersonas', () => {
  let dir: string;

  beforeEach(() => { dir = makeDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('loads multiple personas in alphabetical order', () => {
    writeFileSync(join(dir, 'beta.md'), '---\nslug: beta\nmodel: sonnet\n---\n\nbody\n');
    writeFileSync(join(dir, 'alpha.md'), '---\nslug: alpha\nmodel: opus\n---\n\nbody\n');
    const all = loadAllPersonas(dir);
    expect(all.map((p) => p.slug)).toEqual(['alpha', 'beta']);
  });

  it('ignores non-md files', () => {
    writeFileSync(join(dir, 'p.md'), '---\nslug: p\nmodel: opus\n---\n\nbody\n');
    writeFileSync(join(dir, 'README.txt'), 'note');
    writeFileSync(join(dir, '.DS_Store'), '');
    const all = loadAllPersonas(dir);
    expect(all.map((p) => p.slug)).toEqual(['p']);
  });

  it('returns [] for nonexistent dir', () => {
    expect(loadAllPersonas(join(dir, 'nope'))).toEqual([]);
  });
});

describe('marketing/council-personas — selectPersonas', () => {
  const all = [
    { slug: 'a', model: 'opus', aspects: [], body: 'a', filePath: '/a.md' },
    { slug: 'b', model: 'sonnet', aspects: [], body: 'b', filePath: '/b.md' },
    { slug: 'c', model: 'haiku', aspects: [], body: 'c', filePath: '/c.md' },
  ];

  it('returns all when requested is empty', () => {
    expect(selectPersonas(all, []).map((p) => p.slug)).toEqual(['a', 'b', 'c']);
  });

  it('filters to requested subset, in requested order', () => {
    expect(selectPersonas(all, ['c', 'a']).map((p) => p.slug)).toEqual(['c', 'a']);
  });

  it('throws on unknown slug with available list', () => {
    expect(() => selectPersonas(all, ['a', 'z'])).toThrow(/Unknown persona slug.*z.*Available: a, b, c/);
  });
});

describe('marketing/council-personas — bundled personas', () => {
  it('finds the bundled personas dir from the source tree', () => {
    const dir = findPersonasDir();
    expect(dir).not.toBeNull();
  });

  it('loads exactly 4 marketing personas with the expected slugs and models', () => {
    const all = loadAllPersonas();
    const slugs = all.map((p) => p.slug).sort();
    expect(slugs).toEqual(['creative-director', 'performance-monitor', 'risk-officer', 'strategy-optimizer']);
    // Hard rules carrying forward — sanity check each persona body cites its core hook:
    const so = all.find((p) => p.slug === 'strategy-optimizer')!;
    expect(so.body).toMatch(/hypothesis/i);
    expect(so.body).toMatch(/budget/i);
    const pm = all.find((p) => p.slug === 'performance-monitor')!;
    expect(pm.body).toMatch(/kill by spend/i);
    const cd = all.find((p) => p.slug === 'creative-director')!;
    expect(cd.body).toMatch(/hook/i);
    const ro = all.find((p) => p.slug === 'risk-officer')!;
    expect(ro.body).toMatch(/CAPI/i);
  });
});
