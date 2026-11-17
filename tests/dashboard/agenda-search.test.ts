/**
 * The agenda's search (owner 2026-11-17: "ufak bir arama butonu"): a magnifier in the header opens
 * a field on the same row; typing narrows the lines of EVERY day, grouped under the day's heading,
 * the match lightly marked. Turkish letters never make it miss (İ/ı, ş/s, ğ/g, ç/c, ö/o, ü/u).
 * Pure model first (agendaSearch.ts), then the render at every size and the read-only phone.
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { SuperPadItem } from '../../dashboard/src/lib/superTypes.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'tr', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/context/VaultContext.js', () => ({
  useApi: () => ({}),
  useVaultId: () => ({ vault: 'acme', bus: new EventTarget() }),
  emitInstance: (bus: EventTarget, type: string, detail?: unknown) => { bus.dispatchEvent(new CustomEvent(type, { detail })); },
}));

const S = await import('../../dashboard/src/components/sleepy/super/agendaSearch.js');
const G = await import('../../dashboard/src/components/sleepy/super/agendaGroups.js');
const { SuperAgenda } = await import('../../dashboard/src/components/sleepy/super/SuperAgenda.js');

const at = (day: number, h = 10) => new Date(2026, 10, day, h).getTime();
const item = (id: string, text: string, day: number, section: SuperPadItem['section'] = 'now'): SuperPadItem => ({ id, section, text, at: at(day), bornAt: at(day) });

describe('foldTr: one spelling for the same Turkish word', () => {
  it('folds case, İ/ı and the accented letters', () => {
    expect(S.foldTr('İSTANBUL ışık ŞÖYLE Çağrı Güneş')).toBe(S.foldTr('istanbul isik soyle cagri gunes'));
    expect(S.foldTr('IŞIK')).toBe('isik');
    expect(S.foldTr('Paddle')).toBe('paddle');
  });
});

describe('matchRange: where the match sits in the ORIGINAL text', () => {
  it('finds it across case and accents, with the original length', () => {
    expect(S.matchRange('Öğrenci sayısı günde bir kez', 'OGRENCI')).toEqual([0, 7]);
    expect(S.matchRange('Hakediş formülü yüklensin mi', 'formulu')).toEqual([8, 15]);
    expect(S.matchRange('İstanbul', 'istan')).toEqual([0, 5]);
  });
  it('no match and an empty query give null', () => {
    expect(S.matchRange('Paddle', 'stripe')).toBeNull();
    expect(S.matchRange('Paddle', '   ')).toBeNull();
  });
});

describe('searchDays: every day, grouped by day heading, newest day first', () => {
  const entries = (items: SuperPadItem[], day: string) => {
    const g = G.dayGroups(day, items, items.filter((p) => p.section === 'done'));
    return [...g.dayOpen, ...g.dayDone];
  };
  const days = [
    { day: '2026-11-12', entries: entries([item('c', 'PADDLE fiyat testi', 12, 'done')], '2026-11-12') },
    { day: '2026-11-17', entries: entries([item('a', 'Paddle öğrenci sayısı', 17), item('b', 'Tilki rehberi', 17)], '2026-11-17') },
    { day: '2026-11-10', entries: entries([item('d', 'Başka bir şey', 10)], '2026-11-10') },
  ];
  it('keeps only matching lines; a day with none is not drawn; newest day first', () => {
    const r = S.searchDays(days, 'paddle')!;
    expect(r.map((g) => g.day)).toEqual(['2026-11-17', '2026-11-12']);
    expect(r[0].entries.map((e) => e.row?.note)).toEqual(['a']);
    expect(r[1].entries.map((e) => e.row?.note)).toEqual(['c']);
  });
  it('Turkish letters never miss: "ogrenci" finds Öğrenci, "SAYISI" finds sayısı', () => {
    expect(S.searchDays(days, 'ogrenci')).toHaveLength(1);
    expect(S.searchDays(days, 'SAYISI')).toHaveLength(1);
  });
  it('an empty query is no search (null); no match is an empty list', () => {
    expect(S.searchDays(days, '  ')).toBeNull();
    expect(S.searchDays(days, 'zzz')).toEqual([]);
  });
  it('the same line seen from two days is listed once, under the newest', () => {
    const dup = [days[1], { day: '2026-11-16', entries: days[1].entries }];
    expect(S.searchDays(dup, 'paddle')!.map((g) => g.day)).toEqual(['2026-11-17']);
  });
});

describe('highlightParts: the match marked, nothing else changed', () => {
  it('splits into before, hit, after', () => {
    expect(S.highlightParts('Öğrenci sayısı', 'ogrenci')).toEqual({ before: '', hit: 'Öğrenci', after: ' sayısı' });
    expect(S.highlightParts('Paddle', 'x')).toBeNull();
  });
});

describe('the header: a magnifier at every size, and on the phone (read only)', () => {
  const base = { state: { queue: [] as never, pad: [item('a', 'Paddle öğrenci', 17)], owed: [] as never }, look: { live: () => null, titleFor: (s: string) => s, superTitle: 'Super' }, canShowChild: () => false, onShowChild: () => {}, onShowQuestion: () => {} };
  it.each(['small', 'medium', 'large', 'wide', 'full'] as const)('%s: a closed card draws the magnifier, no field yet', (size) => {
    vi.useFakeTimers({ now: at(17, 15), toFake: ['Date'] });
    const html = renderToStaticMarkup(createElement(SuperAgenda, { ...base, size }));
    expect(html).toContain('data-testid="super-agenda-search-open"');
    expect(html).not.toContain('data-testid="super-agenda-search-input"');
    vi.useRealTimers();
  });
  it('read only (the phone) keeps the magnifier: reading is what search does', () => {
    vi.useFakeTimers({ now: at(17, 15), toFake: ['Date'] });
    const html = renderToStaticMarkup(createElement(SuperAgenda, { ...base, size: 'large', readOnly: true }));
    expect(html).toContain('data-testid="super-agenda-search-open"');
    vi.useRealTimers();
  });
  it('the client can list the days that have a file', async () => {
    const api = await import('../../dashboard/src/components/sleepy/super/superApi.js');
    expect(typeof api.fetchAgendaDays).toBe('function');
  });
});

describe('r2 (owner pick A, 2026-11-18): a round magnifier that grows into a capsule in place', () => {
  const base = { state: { queue: [] as never, pad: [item('a', 'Paddle öğrenci', 17)], owed: [] as never }, look: { live: () => null, titleFor: (s: string) => s, superTitle: 'Super' }, canShowChild: () => false, onShowChild: () => {}, onShowQuestion: () => {} };
  it.each(['small', 'medium', 'large', 'wide', 'full'] as const)('%s: the closed capsule sits IN the header row, with its own spot; no field row anywhere', (size) => {
    vi.useFakeTimers({ now: at(17, 15), toFake: ['Date'] });
    const html = renderToStaticMarkup(createElement(SuperAgenda, { ...base, size }));
    expect(html).toMatch(/class="agenda-find" data-state="closed"/);
    expect(html).toContain('class="agenda-find-spot"');
    expect(html).not.toContain('class="agenda-search"');
    vi.useRealTimers();
  });
  it('closed: one round button, no input; open: glass, input, clear (×) in the same capsule', async () => {
    const { AgendaFind } = await import('../../dashboard/src/components/sleepy/super/AgendaFind.js');
    const closed = renderToStaticMarkup(createElement(AgendaFind, { open: false, query: '', onOpen: () => {}, onClose: () => {}, onQuery: () => {} }));
    expect(closed).toContain('data-testid="super-agenda-search-open"');
    expect(closed).not.toContain('<input');
    const open = renderToStaticMarkup(createElement(AgendaFind, { open: true, query: 'ödeme', onOpen: () => {}, onClose: () => {}, onQuery: () => {} }));
    expect(open).toContain('data-state="open"');
    expect(open).toMatch(/<input[^>]*data-testid="super-agenda-search-input"[^>]*value="ödeme"/);
    expect(open).toContain('data-testid="super-agenda-search-close"');
  });
});

describe('r2 CSS: motion, height and the dimmed Done result', () => {
  it('the capsule animates its width, and not at all under reduced motion; finished results are dimmed', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('../../dashboard/src/components/sleepy/super/SuperAgenda.css', import.meta.url), 'utf-8');
    expect(css).toMatch(/\.agenda-find-cap\s*{[^}]*transition:[^}]*width/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*{[^}]*\.agenda-find/);
    expect(css).toMatch(/\.agenda-results[^{]*\[data-status='done'\][^{]*{[^}]*opacity/);
    // The capsule clips its button: the closed magnifier's keyboard focus ring lives on the capsule.
    expect(css).toMatch(/\.agenda-find-cap:has\(\.agenda-find-btn:focus-visible\)\s*{[^}]*box-shadow/);
  });
});

describe('r2: a Done line still on the live pad from an earlier day is found before it is archived', () => {
  it('yesterday\'s Done line on the pad is read under yesterday, today\'s lines under today', () => {
    const pad = [item('y', 'Ödeme sayfası bitti', 17, 'done'), item('t', 'Bugünkü iş', 18)];
    const src = S.searchSources('2026-11-18', [], pad, {});
    expect(src.map((d) => d.day)).toEqual(['2026-11-18', '2026-11-17']);
    expect(S.searchDays(src, 'odeme')!.map((g) => [g.day, g.entries.map((e) => e.row?.note)])).toEqual([['2026-11-17', ['y']]]);
  });
});
