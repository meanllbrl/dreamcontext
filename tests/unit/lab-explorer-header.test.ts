/**
 * The funnel explorer header (explorer/ExplorerHeader.tsx) and its shared
 * wording and figures (explorer/explorerFormat.ts): the funnel picker, the
 * window and source lines, the headline cards (never a 0 for an unmeasured
 * figure, no orphan card), and the reading traps in `orderedNotes` order with
 * the first four visible and the rest behind "+N". Synthetic Acme data only.
 * Static markup through the dashboard's own React; a direct call (outside a
 * render) gets slot-backed state, so a handler can be called on the tree.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, isValidElement, type ReactElement, type ReactNode } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { FunnelFrame } from '../../dashboard/src/generated/frameOps.js';

const COPY: Record<string, string> = {
  'lab.explorer.picker': 'Funnel',
  'lab.explorer.pickerOption': '{name} · {users} users',
  'lab.explorer.window': '{from} to {to}',
  'lab.explorer.windowPrev': 'compared with {from} to {to}',
  'lab.explorer.source': 'Source: {source}',
  'lab.explorer.pulled': 'pulled {ago}',
  'lab.explorer.filters': 'Filters',
  'lab.explorer.notes': 'Reading traps',
  'lab.explorer.notesMore': '{n} more',
  'lab.explorer.notesAll': 'Reading traps ({n})',
  'lab.explorer.pulledAt': 'pulled: {ago}',
  'lab.explorer.dataAge': 'data age at pull: {age}',
  'lab.explorer.noSpend': 'No spend is attributed to this path',
  'lab.explorer.kpiDelta': '{delta} vs previous',
  'lab.explorer.notMeasured': 'Not measured',
  'lab.explorer.knTitle': 'Fewer than {min} in the denominator: shown as {k} of {n}, not as a rate',
  'lab.explorer.reasonNotPulled': 'this combination was not pulled from the source',
  'lab.explorer.reasonBelowFloor': 'under {n} users, or not pulled',
  'lab.explorer.fill': 'To fill it: {hint}',
  'lab.blocks.breakdown.noPath': 'No measured path for this combination.',
};
const t = (key: string) => COPY[key] ?? key;

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => COPY[key] ?? key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

const H: { on: boolean; slots: unknown[]; i: number } = { on: false, slots: [], i: 0 };
vi.mock('../../dashboard/node_modules/react/index.js', async (orig) => {
  const real = (await orig()) as typeof import('react');
  return {
    ...real,
    useState: <T,>(init: T) => {
      if (!H.on) return real.useState(init);
      const k = H.i++;
      return [k < H.slots.length ? H.slots[k] : typeof init === 'function' ? (init as () => T)() : init, () => {}];
    },
    useId: () => (H.on ? 'uid' : real.useId()),
  };
});

const header = await import('../../dashboard/src/components/lab/explorer/ExplorerHeader.js');
const fmt = await import('../../dashboard/src/components/lab/explorer/explorerFormat.js');
const { ExplorerHeader, ExplorerNotes, ExplorerCardNotes, FunnelPicker, kpiKeys, sourceParts, NOTES_VISIBLE, CARD_TRAPS } = header;
const { balancedColumns, formatRateOrKn, reasonText, hintLine, minUsersFor, fill, rateAttrs } = fmt;
const { fmtPercent, fmtPoints, fmtCount, fmtCompact, fmtDrop, fmtMetric, fmtMetricDelta, spendDisplay } = fmt;

const STEPS = [
  { key: 'visit', label: 'Visit', users: 12000 },
  { key: 'lead', label: 'Lead', users: 4000 },
];
const metric = (v: number | null, format: 'count' | 'usd' | 'pct', label: string, prev: number | null = null, measured = true, reason: string | null = null) =>
  ({ v, prev, format, label, measured, reason });

function frame(): FunnelFrame {
  return {
    kind: 'funnel',
    insight: 'acme-storefront-funnels',
    segmentMode: 'lookup',
    dimensions: [{ key: 'country', label: 'Country', values: ['US', 'DE'] }],
    window: { from: '2026-09-07', to: '2026-10-04', prevFrom: '2026-08-10', prevTo: '2026-09-06' },
    provenance: { source: 'Acme warehouse', pulledAt: '2026-10-08T09:00:00Z', freshness: 'data 2h old', filters: ['product = Acme', 'date 2026-09-07..2026-10-04'] },
    intersections: [{ dims: ['country', 'platform'], minUsers: 300 }],
    hints: { payment: 'pull the acceptance chart by funnel and cohort' },
    notes: [
      { code: 'RU', text: 'Russian traffic is a language, not a country', level: 'trap', keys: ['dim:country'], scope: 'set' },
      { code: null, text: 'Refund rate not used', level: 'info', keys: [], scope: 'set' },
      { code: 'A3', text: 'Contra rows in subs after 1 Sep', level: 'info', keys: ['subs'], scope: 'set' },
      { code: 'C12', text: 'Re-entering users keep their first funnel id', level: 'info', keys: [], scope: 'set' },
    ],
    funnels: [
      {
        id: 'quiz',
        name: 'Quiz checkout',
        steps: STEPS,
        metrics: {
          users: metric(12000, 'count', 'Users', 10000),
          spend: metric(5400, 'usd', 'Spend', 6000),
          subs: metric(420, 'count', 'Subscribers'),
          conv: metric(null, 'pct', 'Visit to subscriber', null, false, 'checkout event missing'),
        },
        notes: [
          { code: 'C1', text: 'No checkout event in this funnel family', level: 'trap', keys: ['lead'], scope: 'funnel' },
          { code: null, text: 'Opened on the new payment provider', level: 'info', keys: [], scope: 'funnel' },
        ],
      },
      { id: 'ladder', name: 'Activation ladder', steps: [{ key: 'visit', label: 'Visit', users: 900 }] },
    ],
  };
}

const html = (el: ReactElement) => renderToStaticMarkup(el);
function call<P>(fn: (p: P) => unknown, p: P, slots: unknown[] = []): ReactElement {
  Object.assign(H, { on: true, i: 0, slots });
  try {
    return fn(p) as ReactElement;
  } finally {
    H.on = false;
  }
}
function findAll(node: ReactNode, pred: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    const el = n as ReactElement<Record<string, unknown>>;
    if (pred(el)) out.push(el);
    walk(el.props.children as ReactNode);
  };
  walk(node);
  return out;
}

describe('explorerFormat', () => {
  it('balancedColumns never leaves one card alone on the last row', () => {
    expect(balancedColumns(4, 4)).toBe(4);
    expect(balancedColumns(5, 4)).toBe(3);
    expect(balancedColumns(9, 4)).toBe(3);
    expect(balancedColumns(3, 4)).toBe(3);
    expect(balancedColumns(1, 4)).toBe(1);
    expect(balancedColumns(0, 4)).toBe(1);
    for (let n = 2; n <= 12; n++) {
      const cols = balancedColumns(n, 4);
      expect(cols, String(n)).toBeLessThanOrEqual(4);
      expect(n % cols, String(n)).not.toBe(1);
    }
  });

  it('a rate over a denominator under 100 reads k/n with its reason; otherwise the formatted rate', () => {
    const small = formatRateOrKn(55, 'pct', { k: 33, n: 60 }, 'en', t);
    expect(small.text).toBe('33/60');
    expect(small.kn).toBe('33/60');
    expect(small.title).toBe('Fewer than 100 in the denominator: shown as 33 of 60, not as a rate');
    expect(rateAttrs(small)['data-lab-kn']).toBe('33/60');
    const big = formatRateOrKn(50, 'pct', { k: 200, n: 400 }, 'en', t);
    expect(big).toEqual({ text: '50.0%', kn: null, title: null });
    expect(formatRateOrKn(21.8, 'pct', null, 'tr', t).text).toBe('%21,8');
    expect(formatRateOrKn(null, 'pct', null, 'en', t).text).toBe('');
  });

  it('a missing path says why: its own reason, never pulled, under the floor, else the generic sentence', () => {
    expect(reasonText(t, 'Language split not pulled for this funnel', 'not-pulled', null)).toBe('Language split not pulled for this funnel');
    expect(reasonText(t, null, 'not-pulled', null)).toBe('this combination was not pulled from the source');
    expect(reasonText(t, null, 'below-floor', 300)).toBe('under 300 users, or not pulled');
    expect(reasonText(t, null, null, null)).toBe('No measured path for this combination.');
    expect(minUsersFor(frame(), { platform: 'Meta', country: 'US' })).toBe(300);
    expect(minUsersFor(frame(), { country: 'US' })).toBeNull();
  });

  it('hintLine fills from the snapshot hints, null when there is none', () => {
    expect(hintLine(t, frame(), 'payment')).toBe('To fill it: pull the acceptance chart by funnel and cohort');
    expect(hintLine(t, frame(), 'daily')).toBeNull();
    expect(fill('{a} and {b}', { a: 1 })).toBe('1 and {b}');
  });

  it('no em dash in the helpers or the header source', () => {
    for (const f of ['explorer/explorerFormat.ts', 'explorer/ExplorerHeader.tsx']) {
      const src = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab', f), 'utf8');
      expect(src, f).not.toMatch(/—/);
    }
  });
});

describe('one number formatter (tr-TR / en-US)', () => {
  it('fmtPercent: value already in percent units, one decimal by default', () => {
    expect(fmtPercent(21.8, 'tr')).toBe('%21,8');
    expect(fmtPercent(21.8, 'en')).toBe('21.8%');
    expect(fmtPercent(92.37, 'tr', 0)).toBe('%92');
    expect(fmtPercent(-2.14, 'en')).toBe('−2.1%');
    expect(fmtPercent(null, 'en')).toBe('–');
  });

  it('fmtPoints: signed points, and a zero change is "0", never "+0" or "−0"', () => {
    expect(fmtPoints(-2.1, 'tr')).toBe('−2,1 puan');
    expect(fmtPoints(-2.1, 'en')).toBe('−2.1 pp');
    expect(fmtPoints(5, 'en')).toBe('+5.0 pp');
    expect(fmtPoints(0.04, 'tr')).toBe('0 puan');
    expect(fmtPoints(-0.04, 'en')).toBe('0 pp');
    expect(fmtPoints(null, 'en')).toBe('–');
  });

  it('fmtCount groups by locale; fmtCompact never says "B"', () => {
    expect(fmtCount(659569, 'tr')).toBe('659.569');
    expect(fmtCount(659569, 'en')).toBe('659,569');
    expect(fmtCompact(659569, 'tr')).toBe('660 bin');
    expect(fmtCompact(1_200_000, 'tr')).toBe('1,2 mn');
    expect(fmtCompact(659569, 'en')).toBe('660K');
    expect(fmtCompact(1_200_000, 'en')).toBe('1.2M');
    expect(fmtCompact(999_960, 'en')).toBe('1M');
    expect(fmtCompact(3_400_000_000, 'en')).toBe('3.4bn');
    expect(fmtCompact(496, 'tr')).toBe('496');
    for (const v of [1500, 660_000, 2_000_000, 7_000_000_000]) {
      expect(fmtCompact(v, 'tr'), String(v)).not.toMatch(/\bB\b/);
      expect(fmtCompact(v, 'en'), String(v)).not.toMatch(/\dB$/);
    }
  });

  it('fmtDrop and the metric forms: rates 1 decimal, ratios 2, dollars, no-spend dash', () => {
    expect(fmtDrop(92.37, 'tr')).toBe('%92,4 düşüş');
    expect(fmtDrop(92.37, 'en')).toBe('92.4% drop');
    expect(fmtMetric(0.2804, 'x', 'tr')).toBe('0,28x');
    expect(fmtMetric(238947.01, 'usd', 'tr')).toBe('$238.947,01');
    expect(fmtMetric(238947.01, 'usd', 'en', true)).toBe('$238,947');
    expect(fmtMetricDelta(-2.1, 'pct', 'tr')).toBe('−2,1 puan');
    expect(fmtMetricDelta(324000, 'count', 'tr', true)).toBe('+324 bin');
    expect(spendDisplay(0, 'tr', t)).toEqual({ text: '–', title: 'No spend is attributed to this path' });
    expect(spendDisplay(12, 'en', t).text).toBe('$12.00');
  });
});

describe('header: picker, window, source', () => {
  it('lists every funnel with its first-step users, the current one chosen', () => {
    const out = html(createElement(ExplorerHeader as never, { frame: frame(), funnelId: 'ladder', selection: {}, onFunnel: () => {} } as never));
    expect(out).toContain('data-lab-explorer-header=""');
    expect(out).toContain('data-lab-funnel="ladder"');
    expect(out).toMatch(/<select[^>]*data-lab-funnel-picker=""/);
    expect(out).toContain('Quiz checkout · 12K users');
    // The chosen funnel's full text is the select's title: an ellipsis never hides it.
    expect(out).toMatch(/<select[^>]*title="Activation ladder · 900 users"/);
    expect(out).toContain('Activation ladder · 900 users');
    expect(out).toMatch(/<option[^>]*value="ladder"[^>]*selected=""/);
  });

  it('the picker calls onFunnel; without onFunnel it cannot change', () => {
    const onFunnel = vi.fn();
    const root = call(FunnelPicker as never, { frame: frame(), current: 'quiz', onFunnel, t, locale: 'en' } as never);
    const select = findAll(root, (e) => e.props['data-lab-funnel-picker'] === '')[0];
    (select.props.onChange as (e: unknown) => void)({ target: { value: 'ladder' } });
    expect(onFunnel).toHaveBeenLastCalledWith('ladder');
    const fixed = call(FunnelPicker as never, { frame: frame(), current: 'quiz', t, locale: 'en' } as never);
    expect(findAll(fixed, (e) => e.props['data-lab-funnel-picker'] === '')[0].props.disabled).toBe(true);
  });

  it('window and previous window, source with freshness, filters behind a disclosure', () => {
    const out = html(createElement(ExplorerHeader as never, { frame: frame(), funnelId: null, selection: {} } as never));
    expect(out).toContain('data-lab-explorer-window="2026-09-07..2026-10-04"');
    expect(out).toContain('Sep 7, 2026 to Oct 4, 2026');
    expect(out).toContain('compared with Aug 10, 2026 to Sep 6, 2026');
    expect(out).toContain('data-lab-explorer-source=""');
    expect(out).toContain('Source: Acme warehouse');
    expect(out).toContain('data age at pull: data 2h old');
    expect(out).toContain('pulled: ');
    expect(out).toMatch(/<details[^>]*data-lab-explorer-filters=""><summary>Filters \(2\)<\/summary>/);
    expect(out).toContain('<li>product = Acme</li>');
  });

  it('no window, no provenance: those lines are simply absent', () => {
    const f = frame();
    delete f.window;
    delete f.provenance;
    const out = html(createElement(ExplorerHeader as never, { frame: f, funnelId: null, selection: {} } as never));
    expect(out).not.toContain('data-lab-explorer-window');
    expect(out).not.toContain('data-lab-explorer-source');
  });
});

describe('header: the source line labels both times', () => {
  it('pulled and data age are both named, so they never read as a contradiction', () => {
    const p = frame().provenance!;
    const now = Date.parse('2026-10-19T09:00:00Z');
    expect(sourceParts(p, t, 'en', now)).toEqual(['Source: Acme warehouse', 'pulled: 11 days ago', 'data age at pull: data 2h old']);
  });
});

describe('header: the card form stays small', () => {
  it('headline figures are ONE strip; the change is a small signed suffix', () => {
    const out = html(createElement(ExplorerHeader as never, { frame: frame(), funnelId: 'quiz', selection: {} } as never));
    expect(out).toContain('data-mode="card"');
    expect(out).toMatch(/class="lab-xh-strip"[^>]*data-lab-explorer-kpis=""/);
    expect(out).not.toContain('lab-xh-kpis');
    expect(out).toMatch(/data-lab-kpi="users"[\s\S]*?>12K<[\s\S]*?data-sign="up"[^>]*>\+2K</);
    expect(out).toMatch(/data-lab-kpi="spend"[\s\S]*?>\$5,400<[\s\S]*?data-sign="down"[^>]*>−\$600</);
    expect(out).toMatch(/data-lab-kpi="conv"[^>]*data-measured="false"[\s\S]*?Not measured/);
  });

  it('only the current funnel\'s own traps show; set traps and info notes sit behind "Reading traps (N)"', () => {
    expect(CARD_TRAPS).toBe(2);
    const out = html(createElement(ExplorerHeader as never, { frame: frame(), funnelId: 'quiz', selection: {} } as never));
    const shown = [...out.matchAll(/data-lab-explorer-note="([^"]+)" data-level="([a-z]+)" data-scope="([a-z]+)"/g)].map((m) => m.slice(1).join(':'));
    expect(shown).toEqual(['C1:trap:funnel']);
    expect(out).toContain('data-lab-notes-more="5"');
    expect(out).toContain('>Reading traps (5)<');
  });

  it('opened, the rest follows in orderedNotes order; with nothing to hide there is no disclosure', () => {
    const notes = [
      { code: 'C1', text: 'own trap', level: 'trap', keys: [], scope: 'funnel' },
      { code: 'RU', text: 'set trap', level: 'trap', keys: [], scope: 'set' },
      { code: null, text: 'own info', level: 'info', keys: [], scope: 'funnel' },
    ];
    const opened = renderToStaticMarkup(call(ExplorerCardNotes as never, { notes, t } as never, [true]));
    expect([...opened.matchAll(/data-lab-explorer-note="([^"]+)"/g)].map((m) => m[1])).toEqual(['C1', 'RU', '2']);
    expect(opened).toContain('aria-expanded="true"');
    const alone = html(createElement(ExplorerCardNotes as never, { notes: notes.slice(0, 1), t } as never));
    expect(alone).not.toContain('data-lab-notes-more');
    expect(alone).toContain('Reading traps');
    expect(alone).toContain('data-lab-explorer-note="C1"');
  });

  it('a funnel with three own traps shows two; the third is behind the disclosure', () => {
    const f = frame();
    f.funnels[0].notes = ['a', 'b', 'c'].map((code) => ({ code, text: code, level: 'trap' as const, keys: [], scope: 'funnel' as const }));
    const out = html(createElement(ExplorerHeader as never, { frame: f, funnelId: 'quiz', selection: {} } as never));
    expect([...out.matchAll(/data-lab-explorer-note="([^"]+)"/g)].map((m) => m[1])).toEqual(['a', 'b']);
    expect(out).toContain('data-lab-notes-more="5"');
  });

  it('a spend of 0 is "no spend attributed", never $0', () => {
    const f = frame();
    f.funnels[0].metrics!.spend = metric(0, 'usd', 'Spend', 10);
    const out = html(createElement(ExplorerHeader as never, { frame: f, funnelId: 'quiz', selection: {} } as never));
    const spend = out.match(/<span[^>]*data-lab-kpi="spend"[\s\S]*?<\/span><\/span>/)?.[0] ?? '';
    expect(spend).toContain('title="No spend is attributed to this path"');
    expect(spend).toContain('>–<');
    expect(out).not.toContain('$0');
  });
});

describe('header: headline cards (fullscreen)', () => {
  it('three counts or dollars, then one rate; the unmeasured rate reads Not measured, never 0', () => {
    const f = frame();
    expect(kpiKeys(f, f.funnels[0].metrics!)).toEqual(['users', 'spend', 'subs', 'conv']);
    const out = html(createElement(ExplorerHeader as never, { frame: f, funnelId: 'quiz', selection: {}, full: true } as never));
    expect(out).toContain('--lab-xh-cols:4');
    const conv = out.match(/<div[^>]*data-lab-kpi="conv"[\s\S]*?<\/div>/)?.[0] ?? '';
    expect(conv).toContain('data-measured="false"');
    expect(conv).toContain('Not measured');
    expect(conv).toContain('title="checkout event missing"');
    expect(conv).not.toMatch(/>0</);
  });

  it('a change is signed text with its direction', () => {
    const out = html(createElement(ExplorerHeader as never, { frame: frame(), funnelId: 'quiz', selection: {}, full: true } as never));
    expect(out).toMatch(/data-lab-kpi="users"[\s\S]*?data-sign="up"[^>]*>\+2,000 vs previous/);
    expect(out).toMatch(/data-lab-kpi="spend"[\s\S]*?data-sign="down"[^>]*>−\$600\.00 vs previous/);
  });

  it('an unmeasured selection draws no cards at all', () => {
    const out = html(createElement(ExplorerHeader as never, { frame: frame(), funnelId: 'quiz', selection: { country: 'DE' } } as never));
    expect(out).not.toContain('data-lab-explorer-kpis');
  });
});

describe('header: reading traps (fullscreen)', () => {
  it('funnel traps, then set traps, then info; the first four visible, the rest behind +N', () => {
    expect(NOTES_VISIBLE).toBe(4);
    const out = html(createElement(ExplorerHeader as never, { frame: frame(), funnelId: 'quiz', selection: {}, full: true } as never));
    const shown = [...out.matchAll(/data-lab-explorer-note="([^"]+)" data-level="([a-z]+)" data-scope="([a-z]+)"/g)].map((m) => m.slice(1).join(':'));
    expect(shown).toEqual(['C1:trap:funnel', 'RU:trap:set', '2:info:funnel', '3:info:set']);
    expect(out).toContain('data-lab-notes-more="2"');
    expect(out).toContain('>2 more<');
    expect(out).toContain('Reading traps');
  });

  it('expanded, every note shows; a list of four or fewer has no toggle', () => {
    const notes = (header as { ExplorerNotes: unknown }).ExplorerNotes;
    const all = renderToStaticMarkup(call(notes as never, { notes: [
      { code: 'a', text: 'one', level: 'trap', keys: [], scope: 'funnel' },
      { code: 'b', text: 'two', level: 'trap', keys: [], scope: 'set' },
      { code: 'c', text: 'three', level: 'info', keys: [], scope: 'set' },
      { code: 'd', text: 'four', level: 'info', keys: [], scope: 'set' },
      { code: 'e', text: 'five', level: 'info', keys: [], scope: 'set' },
    ], t } as never, [true]));
    expect(all.match(/data-lab-explorer-note=/g)).toHaveLength(5);
    expect(all).toContain('aria-expanded="true"');
    const few = html(createElement(ExplorerNotes as never, { notes: [{ code: null, text: 'only', level: 'trap', keys: [], scope: 'set' }], t } as never));
    expect(few).not.toContain('data-lab-notes-more');
    expect(html(createElement(ExplorerNotes as never, { notes: [], t } as never))).toBe('');
  });

  it('note text renders as text, never HTML', () => {
    const f = frame();
    f.funnels[0].notes = [{ code: '<b>x</b>', text: '<img src=x onerror=alert(1)>', level: 'trap', keys: [], scope: 'funnel' }];
    const out = html(createElement(ExplorerHeader as never, { frame: f, funnelId: 'quiz', selection: {} } as never));
    expect(out).not.toContain('<img src=x');
    expect(out).not.toContain('<b>x');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('explorer.css speaks only in tokens and keeps strips even', () => {
  const css = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/explorer/explorer.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel: string) => {
    const at = css.indexOf(`${sel} {`);
    expect(at, sel).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('}', at));
  };

  it('card strips are equal-height grids; bar rows are at least 20px over a full-width track', () => {
    expect(rule('.lab-xh-kpis')).toContain('grid-auto-rows: 1fr');
    expect(rule('.lab-x-cards')).toContain('grid-auto-rows: 1fr');
    expect(rule('.lab-pay-bar')).toContain('min-height: var(--space-5)');
    expect(rule('.lab-pay-bar')).toContain('minmax(0, 1fr)');
  });

  it('tone is a dot, never a wash; figures never wrap', () => {
    expect(rule(".lab-x-dot[data-tone='below']")).toContain('background: var(--color-error)');
    expect(css).not.toMatch(/\[data-tone=[^\]]+\][^{]*\btd\b[^{]*\{[^}]*background/);
    expect(rule('.lab-x-num')).toContain('white-space: nowrap');
    expect(rule('.lab-x-num')).toContain('tabular-nums');
  });
});
