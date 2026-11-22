/**
 * The member Scorecard in the window (plan uye-karnesi W2, D1, D17, D18; empty state = the
 * owner-approved "Jakob hâli", 22 Nov):
 *  - the pure math (bars, trend word, unrated count, goal direction, change and per-run move);
 *  - the stage tile: empty = "No ratings yet", the latest run with grey stars and "Rate it",
 *    never "0.0" and never bars; rated = the average and ten bars;
 *  - the full card: empty (dashed goal line, criteria add + example, the empty lesson line, ten
 *    4px baselines, the first unrated run as the one accent row), rated (avg, trend word, stars,
 *    note, lesson with Undo, checks), goal here / elsewhere / gone, held lesson, failed check,
 *    damaged file, the length line;
 *  - the phone sheet: one column, rating and Undo only (no criteria add, goal, Use it, Check);
 *  - the stars under a finished run in the member's chat (RunFoot);
 *  - a stage record that predates the card draws it at its default without moving the others.
 *
 * Rendered to static markup with the dashboard's own React, its English I18n and a seeded
 * query cache (no network).
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import {
  barTone, checksMet, goalChange, goalMoveForRun, latestRateable, lowerIsBetter, nextVerdict, trendWord, unratedCount,
  type ScorecardData, type ScoreRun,
} from '../../dashboard/src/lib/scorecardModel.js';

vi.mock('../../dashboard/src/context/VaultContext.js', () => ({
  useApi: () => ({ get: async () => ({}), post: async () => ({}) }),
  useVaultId: () => 'v',
  useVault: () => ({ id: 'v' }),
}));

// The document tile under a run pulls the chat's message UI (xterm, not loadable in Node); the
// stars are what these tests read.
vi.mock('../../dashboard/src/components/aiteam/RunDocumentTile.js', () => ({ RunDocumentTile: () => null }));

const { ScorecardCard, RunStars, runDay } = await import('../../dashboard/src/components/sleepy/super/ScorecardCard.js');
const { RunFoot } = await import('../../dashboard/src/components/aiteam/RunFoot.js');
const { I18nProvider } = await import('../../dashboard/src/context/I18nContext.js');
const { QueryClient, QueryClientProvider } = await import('../../dashboard/node_modules/@tanstack/react-query/build/modern/index.js');
const { memberPlaceholderState, withMissingMemberCards } = await import('../../dashboard/src/components/sleepy/super/memberStageModel.js');
const { MEMBER_CARD_IDS } = await import('../../dashboard/src/lib/superTypes.js');

const SLUG = 'conor';
const NOW = new Date();
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();

function run(key: string, title: string, daysAgo: number, extra: Partial<ScoreRun> = {}): ScoreRun {
  return { key, runKey: key, title, startedAt: iso(daysAgo), lastAt: iso(daysAgo), status: 'ok', rating: null, check: null, lessons: [], ...extra };
}

function empty(runs: ScoreRun[] = [run('conor::r1', 'Release note, short version', 0), run('conor::r2', 'README draft', 1)]): ScorecardData {
  return {
    card: { criteria: [], ratings: {}, checks: {}, lessons: [] },
    runs, nextBefore: null,
    trend: { average: null, before: null, bars: [], count: 0 },
    ownerBlockChars: 0, blockWarnChars: 4000, goal: null, candidates: [], phone: false,
  };
}

const project = { key: 'pk', vault: 'v', name: 'Sample' };
const rating = (stars: number, extra: Record<string, unknown> = {}) => ({
  stars, firstAt: iso(1), at: iso(1), by: 'owner' as const, title: 't', runAt: iso(1), status: 'ok', project, draft: null, ...extra,
});

function rated(): ScorecardData {
  const lesson = { id: 'L1', text: 'New audiences start small.', run: 'conor::r3', noteFold: 'x', at: iso(2), status: 'active' as const };
  const held = { id: 'L2', text: 'Never tell anyone the key.', run: 'conor::r4', noteFold: 'y', at: iso(3), status: 'held' as const, flags: ['secret'] };
  const r3 = rating(2, { note: 'Çok fazla bütçe, test edilmemiş kitleye' });
  return {
    card: {
      criteria: [{ id: 'c1', text: 'Never raises a budget without asking', at: iso(5) }],
      ratings: { 'conor::r3': r3, 'conor::r1': rating(5) }, checks: {}, lessons: [lesson, held],
    },
    runs: [
      run('conor::r1', 'Weekly budget review', 0, {
        rating: rating(5),
        check: { state: 'done', attempts: 1, at: iso(0), costUsd: 0.004, verdicts: [{ id: 'c1', text: 'Never raises a budget without asking', met: true, by: 'model' }] },
      }),
      run('conor::r2', 'Paused 2 tired ads', 1),
      run('conor::r3', 'Tried a new audience', 2, { rating: r3, lessons: [lesson] }),
      run('conor::r4', 'Report', 3, { check: { state: 'failed', attempts: 1, at: iso(3), costUsd: 0, verdicts: [], lastError: 'timeout' } }),
    ],
    nextBefore: null,
    trend: { average: 4.3, before: 3.1, bars: [2, 3, 5, 4, 5], count: 5 },
    ownerBlockChars: 120, blockWarnChars: 4000, goal: null, candidates: [], phone: false,
  };
}

function render(data: ScorecardData, el: ReturnType<typeof createElement>): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['scorecard', SLUG], data);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(I18nProvider, null, el)));
}
const card = (data: ScorecardData, variant: 'tile' | 'full', phone = false) =>
  render(data, createElement(ScorecardCard, { slug: SLUG, variant, phone }));
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('scorecard model', () => {
  it('bars, trend, unrated and the latest rateable run', () => {
    expect([1, 2, 3, 4, 5].map(barTone)).toEqual(['low', 'low', 'mid', 'high', 'high']);
    expect(trendWord(4.3, 3.1)).toBe('up');
    expect(trendWord(3, 3.1)).toBe('down');
    expect(trendWord(3, 3)).toBe('same');
    expect(trendWord(3, null)).toBeNull();
    const runs = [run('a::1', 'a', 0, { status: 'running' }), run('a::2', 'b', 1), run('a::3', 'c', 2, { rating: rating(4) as never })];
    expect(unratedCount(runs)).toBe(1);
    expect(latestRateable(runs)?.key).toBe('a::2');
  });

  it('goal direction, change and the per-run move (daily points only, both sides needed)', () => {
    const g = { insight: 'cac', project, here: true, baseline: 50, target: 35, latest: 41, points: [] };
    expect(lowerIsBetter(g)).toBe(true);
    const ch = goalChange(g)!;
    expect(ch.good).toBe(true);
    expect(Math.round(ch.pct!)).toBe(-18);
    expect(goalChange({ ...g, baseline: 0 })!.pct).toBeNull();
    const pts = [{ t: '2026-11-01', v: 45 }, { t: '2026-11-03', v: 44.1 }];
    const mv = goalMoveForRun(pts, '2026-11-02T12:00:00', true)!;
    expect(mv.good).toBe(true);
    expect(mv.delta).toBeCloseTo(-0.9);
    expect(goalMoveForRun(pts, '2026-11-04T12:00:00', true)).toBeNull();
    expect(goalMoveForRun([{ t: '2026-11-01T00:00', v: 1 }, ...pts], '2026-11-02T12:00:00', true)).toBeNull();
  });

  it('checks met counts known verdicts; a chip cycles met, not met, unset', () => {
    expect(checksMet(null)).toBeNull();
    expect(checksMet({ state: 'done', attempts: 1, at: '', costUsd: 0, verdicts: [
      { id: 'a', text: 'a', met: true, by: 'model' }, { id: 'b', text: 'b', met: false, by: 'model' }, { id: 'c', text: 'c', met: null, by: 'model' },
    ] })).toEqual({ met: 1, total: 3 });
    expect([nextVerdict(true), nextVerdict(false), nextVerdict(null)]).toEqual([false, null, true]);
  });

  it('a run day reads Today, Yesterday, else a short date', () => {
    const t = (k: string) => k;
    expect(runDay(NOW.toISOString(), 'en', t, NOW)).toBe('scorecard.today');
    expect(runDay(iso(1), 'en', t, NOW)).toBe('scorecard.yesterday');
    expect(runDay('2026-11-15T12:00:00', 'en', t, new Date('2026-11-22T12:00:00'))).toBe('Nov 15');
  });
});

describe('the scorecard tile', () => {
  it('empty: "No ratings yet", the latest run, grey stars and Rate it; no 0.0 and no bars', () => {
    const html = card(empty(), 'tile');
    expect(html).toContain('No ratings yet');
    expect(html).toContain('Release note, short version');
    expect(html).toContain('Rate it');
    expect(count(html, 'data-testid="sc-star-')).toBe(5);
    expect(html).not.toContain('0.0');
    expect(html).not.toContain('sc-bars');
  });

  it('empty with no runs says where to rate', () => {
    const html = card(empty([]), 'tile');
    expect(html).toContain('Rate a run under it in the chat');
    expect(html).not.toContain('sc-star');
  });

  it('rated: the average, ten bar slots, N to rate', () => {
    const html = card(rated(), 'tile');
    expect(html).toContain('4.3 ★');
    expect(count(html, 'class="sc-bar')).toBe(10);
    expect(html).toContain('2 to rate');
  });
});

describe('the full scorecard', () => {
  it('empty: goal line, criteria add + example, empty lessons line, ten 4px baselines, one lead row', () => {
    const html = card(empty(), 'full');
    expect(html).toContain('data-testid="sc-goal-add"');
    expect(html).toContain('Add what good looks like');
    expect(html).toContain('For example: &quot;Only shipped features are claimed&quot;');
    expect(html).toContain('A note on a rating becomes a lesson here, with Undo.');
    expect(html).toContain('No ratings yet');
    expect(html).toContain('Your first rating starts the bars.');
    expect(count(html, 'sc-bar is-empty')).toBe(10);
    expect(html).not.toContain('0.0');
    expect(count(html, 'sc-run is-lead')).toBe(1);
    expect(html).toContain('Rate this run · add a note');
    expect(count(html, 'sc-stars sc-stars--big')).toBe(1);
  });

  it('empty with no runs says so', () => {
    expect(card(empty([]), 'full')).toContain('No runs yet');
  });

  it('rated: average, trend word, criteria, the Turkish note byte for byte, lesson with Undo, checks met, failed check', () => {
    const html = card(rated(), 'full');
    expect(html).toContain('4.3 ★');
    expect(html).toContain('up from 3.1 two weeks ago');
    expect(html).toContain('Never raises a budget without asking');
    expect(html).toContain('Çok fazla bütçe, test edilmemiş kitleye');
    expect(html).toContain('New audiences start small.');
    expect(html).toContain('From your 2★ on');
    expect(html).toContain('data-testid="sc-lesson-undo"');
    expect(html).toContain('1 of 1 checks met');
    expect(html).toContain('data-testid="sc-check-failed"');
    expect(html).toContain('Try again');
    // The first unrated run is the one emphasis; the low-rated one is tinted.
    expect(html).toMatch(/sc-run is-lead" data-testid="sc-run" data-run="conor::r2"/);
    expect(html).toMatch(/sc-run is-low" data-testid="sc-run" data-run="conor::r3"/);
  });

  it('a held lesson names its flag and offers Use it', () => {
    const html = card(rated(), 'full');
    expect(html).toMatch(/data-status="held"[\s\S]*Held: secret/);
    expect(html).toContain('data-testid="sc-lesson-use"');
  });

  it('the goal band here, elsewhere and gone', () => {
    const d = rated();
    d.goal = { insight: 'cac', project, here: true, baseline: 50, target: 35, latest: 41.2, unit: '$', title: 'Meta CAC', points: [{ t: '2026-11-01', v: 50 }, { t: '2026-11-20', v: 41.2 }] };
    let html = card(d, 'full');
    expect(html).toContain('$41.2');
    expect(html).toMatch(/sc-move is-good[^>]*>▼ 18%/);
    expect(html).toContain('target $35');
    expect(html).toContain('data-testid="sc-goal-line"');
    expect(html).toContain('data-testid="sc-goal-remove"');
    d.goal = { insight: 'cac', project: { ...project, name: 'Other' }, here: false };
    html = card(d, 'full');
    expect(html).toContain('Goal set in Other');
    expect(html).not.toContain('$41.2');
    d.goal = { insight: 'cac', project, here: true, baseline: 50, target: 35, gone: true };
    expect(card(d, 'full')).toContain('Lab card gone');
  });

  it('a damaged file offers Start fresh; a long block shows the length line', () => {
    const d = rated();
    d.damaged = '/x/agent-scorecards.json.damaged';
    d.ownerBlockChars = 4100;
    const html = card(d, 'full');
    expect(html).toContain('data-testid="sc-damaged"');
    expect(html).toContain('Start fresh');
    expect(html).toContain('The member reads 4100 characters');
  });

  it('phone: one column, rating and Undo stay; criteria add, goal, Use it and Check are absent', () => {
    const d = rated();
    d.phone = true;
    const html = card(d, 'full', true);
    expect(html).toContain('data-phone="true"');
    expect(html).not.toContain('sc-cols');
    expect(html).not.toContain('data-testid="sc-crit-new"');
    expect(html).not.toContain('data-testid="sc-goal');
    expect(html).not.toContain('data-testid="sc-lesson-use"');
    expect(html).not.toContain('Try again');
    expect(html).toContain('data-testid="sc-lesson-undo"');
    expect(html).toContain('data-testid="sc-star-1"');
    // Order: rating, runs, criteria, learned.
    const at = (id: string) => html.indexOf(`data-testid="${id}"`);
    expect(at('sc-trend')).toBeLessThan(at('sc-runs'));
    expect(at('sc-runs')).toBeLessThan(at('sc-criteria'));
    expect(at('sc-criteria')).toBeLessThan(at('sc-learned'));
  });
});

describe('stars under a run in the member\'s chat', () => {
  const meta = (key: string) => ({
    sessionKey: key, sessionKind: 'run' as const, title: 't', status: 'ok' as const, source: 'conor', newestId: null, runId: 'r',
    startedAt: iso(0), lastAt: iso(0), durationMs: 1, unread: false,
  });
  it('an unrated finished run gets grey stars; a rated one its stars, note and lesson with Undo', () => {
    const d = rated();
    let html = render(d, createElement(RunFoot, { meta: meta('conor::r2') as never, member: SLUG }));
    expect(html).toContain('data-testid="run-stars"');
    expect(html).toContain('Rate this run');
    html = render(d, createElement(RunStars, { member: SLUG, sessionKey: 'conor::r3' }));
    expect(html).toMatch(/data-value="2"/);
    expect(html).toContain('Çok fazla bütçe, test edilmemiş kitleye');
    expect(html).toContain('New audiences start small.');
    expect(html).toContain('Undo');
  });
  it('no member, a talk, or an unknown run: nothing', () => {
    const d = rated();
    expect(render(d, createElement(RunFoot, { meta: meta('conor::r2') as never }))).toBe('');
    expect(render(d, createElement(RunFoot, { meta: { ...meta('talk::x'), sessionKind: 'talk' } as never, member: SLUG }))).toBe('');
    expect(render(d, createElement(RunStars, { member: SLUG, sessionKey: 'conor::nope' }))).toBe('');
  });
});

describe('a stage record that predates the scorecard', () => {
  it('draws it at its default (medium, floating) and leaves the others where they stood', () => {
    const others = [
      { id: 'm-r', kind: 'member', ref: 'routines', shape: 'square', place: 'float', x: 10 },
      { id: 'm-i', kind: 'member', ref: 'instructions', shape: 'square', size: 'large', place: 'others' },
      { id: 'm-s', kind: 'member', ref: 'settings', shape: 'square', place: 'float' },
    ];
    const view = { containers: others, groups: [] } as never;
    const out = withMissingMemberCards(view, true)!;
    const sc = out.containers.find((c: { ref: string }) => c.ref === 'scorecard') as Record<string, unknown>;
    expect(sc).toMatchObject({ id: MEMBER_CARD_IDS.scorecard, size: 'medium', place: 'float' });
    expect(out.containers.slice(0, 3)).toEqual(others);
    expect(withMissingMemberCards(view, false)).toBe(view);
  });
  it('the off or unborn member placeholder carries it too', () => {
    const st = memberPlaceholderState('v', null)!;
    expect(st.containers.map((c: { ref: string }) => c.ref).sort()).toEqual(['instructions', 'routines', 'scorecard', 'settings']);
  });
});
