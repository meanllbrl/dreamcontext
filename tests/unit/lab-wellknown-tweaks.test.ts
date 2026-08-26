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
import {
  DEFAULT_RANGE_PRESETS,
  ENGINE_FALLBACK_RANGE,
  activeRange,
  fallbackPreset,
} from '../../dashboard/src/components/lab/rangeModel.js';
import type { PublicTweak } from '../../dashboard/src/hooks/useLab.js';

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

/** The manifest as the DASHBOARD sees it — mirrors `toPublicTweaks` in the route,
 *  so these tests exercise the control against the shape it is actually handed. */
function publicTweaks(slug: string): PublicTweak[] {
  return getInsight(root, slug)!.tweaks.map((t) => ({
    key: t.key,
    type: t.type,
    label: t.label ?? null,
    options: t.options ?? null,
    default: (t.default ?? null) as string | null,
    value: (t.value ?? null) as string | null,
  }));
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

  it('the dashboard RangeControl mirrors the engine default presets', () => {
    expect(DEFAULT_RANGE_PRESETS).toEqual([...DEFAULT_RANGE_OPTIONS]);
  });
});

/**
 * An inverted window is not a window.
 *
 * `resolveTweaks` clamps `spanDays` to 0 and hands `from > to` straight to the
 * adapter, where every source answers differently — empty rows, a provider
 * error, or a silently swapped range. The one place a window is written is the
 * one place that can refuse it.
 */
describe('well-known tweaks — an inverted custom window is refused', () => {
  it('rejects from > to when a single write carries both halves', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    expect(() => writeInsightTweaks(root, 'wau', { from: '2026-03-10', to: '2026-03-01' }))
      .toThrow(/inverted/i);
    // Refused means refused: nothing was persisted from the bad write.
    expect(tweakOf('wau', 'from')).toBeUndefined();
  });

  it('judges the MERGED pair, so half a window cannot invert a stored one', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    writeInsightTweaks(root, 'wau', { from: '2026-03-01', to: '2026-03-10' });

    expect(() => writeInsightTweaks(root, 'wau', { to: '2026-02-01' })).toThrow(/inverted/i);
    expect(() => writeInsightTweaks(root, 'wau', { from: '2026-04-01' })).toThrow(/inverted/i);

    expect(tweakOf('wau', 'from')!.value).toBe('2026-03-01');
    expect(tweakOf('wau', 'to')!.value).toBe('2026-03-10');
  });

  it('still accepts a single-day window and a half-cleared one', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    writeInsightTweaks(root, 'wau', { from: '2026-03-01', to: '2026-03-01' });
    expect(resolveTweaks(getInsight(root, 'wau')!).spanDays).toBe(0);
    // Clearing one half is how you leave custom mode — never an inversion.
    writeInsightTweaks(root, 'wau', { to: '' });
    expect(tweakOf('wau', 'to')!.value).toBe('');
  });
});

/**
 * The Clear button's parity test — the regression that made it dead.
 *
 * Writing `from`/`to` does NOT clear the `range` enum (from/to simply out-rank
 * it), so an insight with a curated enum still holds the user's real preset
 * underneath a custom window. `clearCustom` used to write a hardcoded
 * `last_30_days`, which such an enum rejects outright: Clear threw, and since a
 * custom window can only be escaped by writing `range`, the window stayed pinned.
 */
describe('well-known tweaks — clearing a custom window writes an ACCEPTED preset', () => {
  const CURATED = ['last_7_days', 'last_28_days', 'last_90_days'];

  it('the engine rejects the old hardcoded fallback on a curated enum', () => {
    writeManifest('funnels', `  - key: range\n    type: enum\n    options: ${JSON.stringify(CURATED)}\n    value: last_7_days\n`);
    expect(() => writeInsightTweaks(root, 'funnels', { range: ENGINE_FALLBACK_RANGE })).toThrow(LabError);
  });

  it('what the control now offers to Clear WITH is accepted, and un-pins the window', () => {
    writeManifest('funnels', `  - key: range\n    type: enum\n    options: ${JSON.stringify(CURATED)}\n    value: last_7_days\n  - key: from\n    type: date\n    value: ''\n  - key: to\n    type: date\n    value: ''\n`);
    writeInsightTweaks(root, 'funnels', { from: '2026-01-01', to: '2026-01-05' });

    const active = activeRange(publicTweaks('funnels'));
    expect(active.kind).toBe('custom');
    // The masked preset is the one the manifest still holds — not a guess.
    const masked = active.kind === 'custom' ? active.masked : '';
    expect(masked).toBe('last_7_days');
    expect(CURATED).toContain(masked);

    writeInsightTweaks(root, 'funnels', { range: masked });
    const resolved = resolveTweaks(getInsight(root, 'funnels')!, new Date('2026-03-10T12:00:00Z'));
    expect(resolved.range).toEqual({ fromISO: '2026-03-03', toISO: '2026-03-10' });
  });

  it('falls back to the first curated option when the enum holds no value at all', () => {
    writeManifest('funnels', `  - key: range\n    type: enum\n    options: ${JSON.stringify(CURATED)}\n`);
    expect(fallbackPreset(publicTweaks('funnels'))).toBe('last_7_days');
    writeInsightTweaks(root, 'funnels', { range: fallbackPreset(publicTweaks('funnels')) });
    expect(tweakOf('funnels', 'range')!.value).toBe('last_7_days');
  });

  it('falls back to the engine default only when nothing is curated', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    expect(fallbackPreset(publicTweaks('wau'))).toBe(ENGINE_FALLBACK_RANGE);
    writeInsightTweaks(root, 'wau', { range: fallbackPreset(publicTweaks('wau')) });
    expect(tweakOf('wau', 'range')!.value).toBe(ENGINE_FALLBACK_RANGE);
  });
});
