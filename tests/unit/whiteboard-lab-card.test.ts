/**
 * A whiteboard draws a funnel as its explorer, any Lab board card as a `lab-card` widget, and the
 * date window on the card (Tilki 2026-10-04). Covers the pure halves and the server/CLI ends:
 * the lab-card ref rule (both contract mirrors + the validator), the funnel-explorer one-card
 * board (`GET /api/lab/explorer/:slug`), the window label, the funnel headline and the tab a
 * funnel widget opens on, `tweaks_from` window groups, and the lookup-mode segments header that
 * printed "Not measured" above measured rows. Synthetic Acme vocabulary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as lib from '../../src/lib/whiteboards/widgets.js';
import * as dash from '../../dashboard/src/lib/whiteboardWidgets.js';
import { validateWidgetPayload } from '../../src/lib/whiteboards/validate.js';
import { isValidRefFor } from '../../dashboard/src/components/whiteboard/widgetModel.js';
import { createInsight, getInsight, windowGroup, writeCache, writeWindowTweaks } from '../../src/lib/lab/store.js';
import { buildExplorerResponse, EXPLORER_BOARD_PREFIX } from '../../src/server/routes/lab-boards.js';
import { funnelExplorerBlocks } from '../../src/lib/lab/presets.js';
import { projectFunnelFrame, type FunnelFrame } from '../../src/lib/lab/frameOps.js';
import { explorerBlockView } from '../../src/cli/commands/lab.js';
import { dataWindow, formatWindow } from '../../dashboard/src/components/whiteboard/widgets/windowModel.js';
import { funnelHeadline, lanesTab } from '../../dashboard/src/components/whiteboard/widgets/funnelWidgetModel.js';
import type { InsightCache } from '../../src/lib/lab/types.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dc-wb-lab-card-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const base = (slug: string, extra: Partial<InsightCache> = {}): InsightCache => ({
  slug, fetchedAt: '2026-10-01T00:00:00Z', tweaks: {}, granularity: 'daily', unit: 'users',
  series: [], latest: null, error: null, errorAt: null, scriptHash: null, ...extra,
});

function seedFunnel(slug = 'acme-funnel'): void {
  createInsight(root, { slug, title: 'Acme funnel', render: 'funnel', adapter: 'script' });
  writeCache(root, slug, base(slug, {
    funnel: {
      notices: [],
      range: { fromISO: '2026-07-06', toISO: '2026-10-04' },
      set: {
        kind: 'funnel-set/v1',
        dimensions: [
          { key: 'channel', label: 'Channel', mode: 'client', values: ['Meta Ads', 'TikTok Ads'] },
          { key: 'browser', label: 'Browser', mode: 'client', values: ['Chrome', 'Safari'] },
        ],
        funnels: [{
          id: 'quiz', name: 'Quiz to signup', meta: {}, metrics: {},
          steps: [{ key: 'land', label: 'Landed', users: 400 }, { key: 'start', label: 'Started', users: 200 }, { key: 'signup', label: 'Signed up', users: 10 }],
          segments: [
            { dims: { channel: 'Meta Ads' }, users: 300, steps: [{ key: 'land', users: 300 }, { key: 'start', users: 150 }, { key: 'signup', users: 8 }] },
            { dims: { channel: 'TikTok Ads' }, users: 100, steps: [{ key: 'land', users: 100 }, { key: 'start', users: 50 }, { key: 'signup', users: 2 }] },
            { dims: { browser: 'Chrome' }, users: 250, steps: [{ key: 'land', users: 250 }, { key: 'start', users: 120 }, { key: 'signup', users: 6 }] },
            { dims: { browser: 'Safari' }, users: 150, steps: [{ key: 'land', users: 150 }, { key: 'start', users: 80 }, { key: 'signup', users: 4 }] },
          ],
        }],
      },
    },
  } as Partial<InsightCache>));
}

describe('lab-card widget ref', () => {
  const cases: unknown[] = ['growth/c-signups', 'a/b', 'growth/c-signups/x', 'growth', '/c', 'growth/', 'Growth/c', 'growth/C', '../x/y', 'a b/c', 42, null];
  it('is <board>/<card-id>, judged the same by both mirrors and the canvas', () => {
    for (const c of cases) {
      expect(dash.isLabCardRef(c), String(c)).toBe(lib.isLabCardRef(c));
      expect(isValidRefFor('lab-card', c), String(c)).toBe(lib.isLabCardRef(c));
    }
    expect(lib.isLabCardRef('growth/c-signups')).toBe(true);
    for (const bad of ['growth/c-signups/x', 'growth', 'Growth/c', '../x/y']) expect(lib.isLabCardRef(bad), bad).toBe(false);
    expect(lib.splitLabCardRef('growth/c-signups')).toEqual({ board: 'growth', card: 'c-signups' });
    expect(dash.splitLabCardRef('nope')).toBeNull();
  });

  it('the validator takes a lab-card with a ref, refuses one without or with a bad one', () => {
    expect(() => validateWidgetPayload({ v: 1, kind: 'lab-card', ref: 'growth/c-signups' })).not.toThrow();
    expect(() => validateWidgetPayload({ v: 1, kind: 'lab-card' })).toThrow(/needs a ref/);
    expect(() => validateWidgetPayload({ v: 1, kind: 'lab-card', ref: 'growth' })).toThrow(/invalid widget ref/);
    expect(lib.DEFAULT_WIDGET_SIZES['lab-card']).toBe('xl');
    expect(lib.REF_KINDS).toContain('lab-card');
  });
});

describe('the funnel explorer as a one-card board', () => {
  it('is the preset card, resolved: breakdown + tabs, one segments tab per dim, frames for every block', () => {
    seedFunnel();
    const out = buildExplorerResponse(root, 'acme-funnel', 'tr')!;
    expect(out.board.slug).toBe(`${EXPLORER_BOARD_PREFIX}acme-funnel`);
    expect(out.board.cards).toHaveLength(1);
    const card = out.board.cards[0];
    expect(card.insight).toBe('acme-funnel');
    expect(card.blocks).toEqual(funnelExplorerBlocks('acme-funnel', [{ key: 'channel', label: 'Channel' }, { key: 'browser', label: 'Browser' }], 'tr'));
    expect(Object.keys(out.frames).length + Object.keys(out.frameAliases ?? {}).length).toBeGreaterThanOrEqual(7);
    expect(Object.keys(out.summaries)).toEqual(['acme-funnel']);
  });

  it('is null for an insight with no funnel set (unsynced, or not a funnel)', () => {
    createInsight(root, { slug: 'acme-unsynced', title: 'Unsynced', render: 'funnel', adapter: 'script' });
    expect(buildExplorerResponse(root, 'acme-unsynced', 'en')).toBeNull();
    createInsight(root, { slug: 'acme-signups', title: 'Signups' });
    writeCache(root, 'acme-signups', base('acme-signups', { series: [{ name: 's', points: [{ t: '2026-10-01', v: 3 }] }], latest: 3 }));
    expect(buildExplorerResponse(root, 'acme-signups', 'en')).toBeNull();
    expect(buildExplorerResponse(root, 'nope', 'en')).toBeNull();
  });

  it('opens on the Compare tab (the pinned lanes), found by content', () => {
    const blocks = funnelExplorerBlocks('acme-funnel', [{ key: 'channel', label: 'Channel' }], 'en');
    // Steps (compare off) comes before Compare: the lanes tab is the one with compare: 'lanes'.
    expect(lanesTab({ blocks })).toEqual({ path: '1', tab: 5 });
    expect(blocks[1].tabs![5].label).toBe('Compare');
    expect(lanesTab({ blocks: [{ type: 'breakdown', options: {} }] })).toBeNull();
  });

  it('falls back to the first bars funnel on a card without a Compare tab (an older preset)', () => {
    const old = [
      { type: 'breakdown', options: {} },
      {
        type: 'tabs',
        options: {},
        tabs: [
          { blocks: [{ type: 'trend', options: {} }] },
          { blocks: [{ type: 'funnel', options: { layout: 'flow', markWorst: true } }] },
          { blocks: [{ type: 'funnel', options: { layout: 'bars', markWorst: true } }] },
        ],
      },
    ];
    expect(lanesTab({ blocks: old })).toEqual({ path: '1', tab: 2 });
  });
});

describe('the window on the card', () => {
  it('is the data window: a funnel/matrix/dataset/app range first, the resolved tweaks last', () => {
    const funnel = { fromISO: '2026-07-06', toISO: '2026-10-04' };
    expect(dataWindow({ cache: { funnel: { range: funnel } }, resolvedRange: { fromISO: '2026-09-04', toISO: '2026-10-04' } })).toEqual(funnel);
    expect(dataWindow({ cache: null, resolvedRange: { fromISO: '2026-09-04', toISO: '2026-10-04' } })).toEqual({ fromISO: '2026-09-04', toISO: '2026-10-04' });
    expect(dataWindow({ cache: { funnel: { range: { fromISO: '', toISO: '' } } } })).toBeNull();
    expect(dataWindow(null)).toBeNull();
  });

  it('reads "6 Tem – 4 Eki" in Turkish, without the year inside this year', () => {
    const now = new Date(2026, 9, 4);
    expect(formatWindow({ fromISO: '2026-07-06', toISO: '2026-10-04' }, 'tr', now)).toBe('6 Tem – 4 Eki');
    expect(formatWindow({ fromISO: '2026-07-06', toISO: '2026-10-04' }, 'en-US', now)).toBe('Jul 6 – Oct 4');
    expect(formatWindow({ fromISO: '2025-12-20', toISO: '2026-01-10' }, 'en-US', now)).toMatch(/2025.*2026/);
    expect(formatWindow({ fromISO: '2026-10-04', toISO: '2026-10-04' }, 'en-US', now)).toBe('Oct 4');
  });
});

describe('a funnel at S/M', () => {
  it('speaks for the primary funnel, else the first; null with no steps', () => {
    const set = {
      primary: 'b',
      funnels: [
        { id: 'a', name: 'A', steps: [{ key: 'x', label: 'X', users: 1 }] },
        { id: 'b', name: 'B', steps: [{ key: 'y', label: 'Y', users: 9 }, { key: 'z', label: 'Z', users: 3 }] },
      ],
    };
    expect(funnelHeadline(set)?.id).toBe('b');
    expect(funnelHeadline({ ...set, primary: 'gone' })?.id).toBe('a');
    expect(funnelHeadline({ funnels: [{ id: 'e', name: 'E', steps: [] }] })).toBeNull();
    expect(funnelHeadline(undefined)).toBeNull();
  });
});

describe('tweaks_from: one window for insights derived from one source', () => {
  function follower(slug: string, from: string | null): void {
    createInsight(root, { slug, title: slug });
    if (from === null) return;
    const path = getInsight(root, slug)!.path;
    writeFileSync(path, readFileSync(path, 'utf8').replace(/^---\n/, `---\ntweaks_from: ${from}\n`));
  }

  it('groups the source and its followers, from any member', () => {
    seedFunnel('acme-funnel');
    follower('acme-steps', 'acme-funnel');
    follower('acme-by-channel', 'acme-funnel');
    follower('acme-other', null);
    follower('acme-self', 'acme-self');
    expect(getInsight(root, 'acme-steps')!.tweaks_from).toBe('acme-funnel');
    expect(getInsight(root, 'acme-self')!.tweaks_from).toBeNull();
    expect(windowGroup(root, 'acme-funnel')).toEqual(['acme-funnel', 'acme-by-channel', 'acme-steps']);
    expect(windowGroup(root, 'acme-steps')).toEqual(['acme-funnel', 'acme-by-channel', 'acme-steps']);
    expect(windowGroup(root, 'acme-other')).toEqual(['acme-other']);
  });

  it('a window change on any member moves the whole group; other tweaks stay on the one written', () => {
    seedFunnel('acme-funnel');
    follower('acme-steps', 'acme-funnel');
    follower('acme-other', null);
    const { moved } = writeWindowTweaks(root, 'acme-steps', { range: 'last_28_days' });
    expect(moved).toEqual(['acme-funnel']);
    const value = (slug: string, key: string) => getInsight(root, slug)!.tweaks.find((t) => t.key === key)?.value;
    expect(value('acme-funnel', 'range')).toBe('last_28_days');
    expect(value('acme-steps', 'range')).toBe('last_28_days');
    expect(value('acme-other', 'range')).toBeUndefined();

    const custom = writeWindowTweaks(root, 'acme-funnel', { from: '2026-09-01', to: '2026-09-30' });
    expect(custom.moved).toEqual(['acme-steps']);
    expect(value('acme-steps', 'from')).toBe('2026-09-01');
    expect(value('acme-steps', 'to')).toBe('2026-09-30');
  });
});

describe('lookup-mode segments under a selection', () => {
  it('no longer claims "not measured" for a header its projected frame cannot hold', () => {
    const seg = (dims: Record<string, string>, users: number) => ({
      dims, users, measured: true, reason: null as string | null, steps: [{ key: 'land', users }],
      metrics: { signup_rate: { v: users / 100, prev: null, format: 'pct' as const, label: 'Signup rate', measured: true, reason: null } },
    });
    const frame: FunnelFrame = {
      kind: 'funnel',
      insight: 'acme-funnel',
      segmentMode: 'lookup',
      dimensions: [
        { key: 'channel', label: 'Channel', values: ['Meta Ads', 'TikTok Ads'] },
        { key: 'browser', label: 'Browser', values: ['Chrome', 'Safari'] },
      ],
      funnels: [{
        id: 'quiz', name: 'Quiz to signup',
        steps: [{ key: 'land', label: 'Landed', users: 400 }],
        metrics: { signup_rate: { v: 2.5, prev: null, format: 'pct', label: 'Signup rate', measured: true, reason: null } },
        segments: [
          seg({ channel: 'Meta Ads' }, 300),
          seg({ channel: 'Meta Ads', browser: 'Chrome' }, 200),
          seg({ channel: 'Meta Ads', browser: 'Safari' }, 100),
        ],
      }],
    };
    const options = { by: 'browser' };
    const view = explorerBlockView('segments', projectFunnelFrame(frame, 'segments', options), options, { channel: 'Meta Ads' })!;
    expect(view.slice).toBeUndefined();
    expect(view.funnelName).toBe('Quiz to signup');
    expect(view.rows!.map((r) => ('measured' in r ? r.measured : null))).toEqual([true, true]);
  });
});

describe('a percent bar axis', () => {
  it('writes % on every value tick; another unit stays in the title', async () => {
    const { layoutBars } = await import('../../dashboard/src/components/lab/BarList.js');
    const { estimateTextWidth } = await import('../../dashboard/src/components/lab/chart/layout.js');
    const measure = (s: string) => estimateTextWidth(s, 12);
    const model = {
      categories: [{ key: 'a', label: 'Reel A' }, { key: 'b', label: 'Reel B' }, { key: 'c', label: 'Bio link' }],
      series: [{ id: 'rate', label: 'Signup rate', values: [3.6, 2.1, 16.3] }],
    };
    const ticks = (unit: string) => layoutBars({ model, opts: { unit }, width: 560, height: 260, fontPx: 12, measure }).layout.x.labels.map((l) => l.label);
    const pct = ticks('%');
    expect(pct.length).toBeGreaterThan(1);
    expect(pct.every((t) => t.endsWith('%')), pct.join(',')).toBe(true);
    expect(ticks('signups').some((t) => /signups/.test(t))).toBe(false);
  });
});
