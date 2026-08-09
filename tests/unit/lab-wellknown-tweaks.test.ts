/**
 * `range` / `from` / `to` are WELL-KNOWN tweaks: writable on every insight,
 * declared or not.
 *
 * `resolveTweaks` derives a window for every insight whether or not its author
 * declared knobs for one, but `writeInsightTweaks` used to reject any key the
 * manifest didn't list — so the dashboard could only offer the ranges someone
 * had hand-written into the frontmatter ("this funnel only has last 7 days").
 *
 * The correctness detail these tests exist for: `resolveTweaks` step 2 lets an
 * explicit `from`/`to` OVERRIDE the range enum, so a preset write that leaves a
 * stale custom window behind pins every later preset to the old dates — the
 * preset buttons would silently do nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEFAULT_RANGE_OPTIONS,
  createInsight,
  getInsight,
  isWellKnownTweakKey,
  writeInsightTweaks,
} from '../../src/lib/lab/store.js';
import { resolveTweaks } from '../../src/lib/lab/tweaks.js';
import { LabError } from '../../src/lib/lab/types.js';
import { handleLabTweaks } from '../../src/server/routes/lab.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-lab-wellknown-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a manifest with an explicit tweaks block (createInsight ships none). */
function writeManifest(slug: string, tweaksYaml: string): void {
  mkdirSync(join(root, 'lab', 'insights'), { recursive: true });
  writeFileSync(
    join(root, 'lab', 'insights', `${slug}.md`),
    `---\ntitle: ${slug}\nrender: number\ntweaks:\n${tweaksYaml}---\n## Meaning\n`,
    'utf-8',
  );
}

function tweakOf(slug: string, key: string) {
  return getInsight(root, slug)!.tweaks.find((t) => t.key === key);
}

describe('well-known tweaks — undeclared writes', () => {
  it('accepts `range` on an insight that declares no tweaks at all', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    expect(getInsight(root, 'wau')!.tweaks).toEqual([]);

    writeInsightTweaks(root, 'wau', { range: 'last_90_days' });

    const decl = tweakOf('wau', 'range')!;
    expect(decl.type).toBe('enum');
    expect(decl.value).toBe('last_90_days');
    // No `options`: an absent list means "the shared defaults", so an author who
    // later curates one still wins.
    expect(decl.options).toBeUndefined();
  });

  it('accepts a custom `from`/`to` window on an undeclared insight and sets both', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    writeInsightTweaks(root, 'wau', { from: '2026-01-01', to: '2026-01-31' });

    expect(tweakOf('wau', 'from')!.value).toBe('2026-01-01');
    expect(tweakOf('wau', 'to')!.value).toBe('2026-01-31');
    expect(tweakOf('wau', 'from')!.type).toBe('date');

    const resolved = resolveTweaks(getInsight(root, 'wau')!);
    expect(resolved.range).toEqual({ fromISO: '2026-01-01', toISO: '2026-01-31' });
  });

  it('rejects a `range` that the engine cannot parse as a relative range', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    expect(() => writeInsightTweaks(root, 'wau', { range: 'whenever' })).toThrow(LabError);
    expect(() => writeInsightTweaks(root, 'wau', { to: '31-01-2026' })).toThrow(LabError);
  });

  it('still rejects a key that is neither declared nor well-known', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    expect(() => writeInsightTweaks(root, 'wau', { country: 'tr' })).toThrow(LabError);
  });

  it('does not persist an empty well-known key it never had', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    writeInsightTweaks(root, 'wau', { from: '', to: '' });
    expect(getInsight(root, 'wau')!.tweaks).toEqual([]);
  });

  it('names the three keys the engine treats as well-known', () => {
    expect(['range', 'from', 'to'].every(isWellKnownTweakKey)).toBe(true);
    expect(isWellKnownTweakKey('country')).toBe(false);
  });
});

describe('well-known tweaks — a preset clears a stale custom window', () => {
  it('drops from/to when a preset is applied, so resolveTweaks honours the preset', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    writeInsightTweaks(root, 'wau', { from: '2026-01-01', to: '2026-01-31' });

    writeInsightTweaks(root, 'wau', { range: 'last_7_days' });

    expect(tweakOf('wau', 'from')!.value).toBe('');
    expect(tweakOf('wau', 'to')!.value).toBe('');
    const resolved = resolveTweaks(getInsight(root, 'wau')!, new Date('2026-03-10T12:00:00Z'));
    expect(resolved.range).toEqual({ fromISO: '2026-03-03', toISO: '2026-03-10' });
    expect(resolved.spanDays).toBe(7);
  });

  it('leaves from/to alone when the same write sets them explicitly', () => {
    writeManifest('wau', '  - key: range\n    type: enum\n    options: ["last_7_days"]\n');
    writeInsightTweaks(root, 'wau', { range: 'last_7_days', from: '2026-02-01', to: '2026-02-10' });

    expect(tweakOf('wau', 'from')!.value).toBe('2026-02-01');
    expect(tweakOf('wau', 'to')!.value).toBe('2026-02-10');
  });

  it('clearing the custom window returns to the preset', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    writeInsightTweaks(root, 'wau', { range: 'last_28_days' });
    writeInsightTweaks(root, 'wau', { from: '2026-01-01', to: '2026-01-05' });
    expect(resolveTweaks(getInsight(root, 'wau')!).range.toISO).toBe('2026-01-05');

    writeInsightTweaks(root, 'wau', { range: 'last_28_days' });
    const resolved = resolveTweaks(getInsight(root, 'wau')!, new Date('2026-03-10T12:00:00Z'));
    expect(resolved.spanDays).toBe(28);
  });
});

describe('well-known tweaks — declared manifests are unchanged', () => {
  it('a declared range enum keeps its curated options and still rejects outsiders', () => {
    writeManifest('wau', '  - key: range\n    type: enum\n    options: ["last_30_days", "last_1_year"]\n');

    expect(() => writeInsightTweaks(root, 'wau', { range: 'last_7_days' })).toThrow(LabError);
    writeInsightTweaks(root, 'wau', { range: 'last_1_year' });

    const decl = tweakOf('wau', 'range')!;
    expect(decl.options).toEqual(['last_30_days', 'last_1_year']);
    expect(decl.value).toBe('last_1_year');
    // The curated enum is not duplicated by an implicit declaration.
    expect(getInsight(root, 'wau')!.tweaks.filter((t) => t.key === 'range')).toHaveLength(1);
  });

  it('a declared date tweak still rejects a non-calendar value but accepts a clear', () => {
    writeManifest('wau', '  - key: from\n    type: date\n    value: "2026-01-01"\n');
    expect(() => writeInsightTweaks(root, 'wau', { from: 'not-a-date' })).toThrow(LabError);
    writeInsightTweaks(root, 'wau', { from: '' });
    expect(tweakOf('wau', 'from')!.value).toBe('');
  });

  it('non-window tweaks keep their existing behaviour', () => {
    writeManifest('wau', '  - key: country\n    type: string\n');
    writeInsightTweaks(root, 'wau', { country: 'tr' });
    expect(tweakOf('wau', 'country')!.value).toBe('tr');
  });
});

describe('well-known tweaks — the API and the dashboard agree with the engine', () => {
  function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
    let statusCode = 0;
    let responseBody: unknown = null;
    const res = {
      writeHead(code: number) { statusCode = code; },
      end(data: string) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } },
      setHeader() {},
    } as unknown as ServerResponse;
    return { res, status: () => statusCode, body: () => responseBody as any };
  }

  function makeReq(bodyObj: unknown): IncomingMessage {
    const readable = Readable.from([Buffer.from(JSON.stringify(bodyObj))]);
    return Object.assign(readable, { method: 'PATCH', headers: { 'content-type': 'application/json' } }) as unknown as IncomingMessage;
  }

  it('PATCH /api/lab/:slug/tweaks accepts a range on an insight that declares none', async () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    const { res, status, body } = makeRes();

    await handleLabTweaks(makeReq({ tweaks: { range: 'last_90_days' } }), res, { slug: 'wau' }, root);

    expect(status()).toBe(200);
    const range = body().insight.tweaks.find((t: { key: string }) => t.key === 'range');
    expect(range.value).toBe('last_90_days');
    // The summary/detail payload carries what the card needs to render the control.
    expect(range.options).toBeNull();
  });

  it('the dashboard RangeControl mirrors the engine default presets', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      join(import.meta.dirname, '../../dashboard/src/components/lab/RangeControl.tsx'),
      'utf-8',
    );
    const block = /DEFAULT_RANGE_PRESETS\s*=\s*\[([^\]]*)\]/.exec(source);
    expect(block, 'RangeControl must export DEFAULT_RANGE_PRESETS').toBeTruthy();
    const presets = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(presets).toEqual([...DEFAULT_RANGE_OPTIONS]);
  });
});
