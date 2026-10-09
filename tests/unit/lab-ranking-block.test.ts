/**
 * The explorer's `ranking` block (blocks/RankingBlock.tsx): each funnel's best
 * breakdown on one metric, best first, at ONE runtime user floor (30/100/300,
 * default 300). A path under the floor never competes, a duplicate
 * intersection never shows, a low-sample row fades, a small denominator reads
 * k/n, a funnel with no qualifying path is listed, and a cells-mode set ranks
 * nothing and says why. Clicking a funnel opens that path for the card.
 * Synthetic Acme data; static markup through the dashboard's own React; a
 * direct call gets slot-backed state (slot 0 = metric, slot 1 = floor).
 */
import { describe, it, expect, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode, createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import type { FunnelFrame, FunnelFrameSegment } from '../../dashboard/src/generated/frameOps.js';
import type { Block, BlockProps } from '../../dashboard/src/components/lab/board/boardTypes.js';

const COPY: Record<string, string> = {
  'lab.explorer.picker': 'Funnel',
  'lab.explorer.rankingMetric': 'Metric',
  'lab.explorer.rankingBest': 'Best breakdown',
  'lab.explorer.rankingTotal': 'Funnel total',
  'lab.explorer.rankingUsers': 'Users',
  'lab.explorer.rankingMin': 'At least {n} users',
  'lab.explorer.rankingDropped': '{n} funnels have no breakdown with {min} users or more',
  'lab.explorer.emptyRanking': 'No breakdown has {n} users or more on {metric}.',
  'lab.explorer.emptyRankingCells': 'Rates are not carried for summed cells: ranking needs lookup paths.',
  'lab.explorer.lowSampleRow': 'Low sample',
  'lab.explorer.notMeasured': 'Not measured',
  'lab.explorer.rankingDelta': 'vs previous',
  'lab.explorer.rankingNoPrev': 'No previous window for this path',
  'lab.explorer.knTitle': 'Fewer than {min} in the denominator: shown as {k} of {n}, not as a rate',
  'lab.blocks.breakdown.all': 'All traffic',
};

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
  };
});

const { RankingBlock, rankingMetrics, rankingFloor } = await import('../../dashboard/src/components/lab/blocks/RankingBlock.js');

const STEPS = [
  { key: 'visit', label: 'Visit', users: 2000 },
  { key: 'lead', label: 'Lead', users: 900 },
];
const conv = (v: number | null, prev: number | null = null) => ({ conv: { v, prev, format: 'pct' as const, label: 'Visit to lead', measured: v !== null, reason: null } });
const seg = (dims: Record<string, string>, visit: number, lead: number, prev: number | null = null): FunnelFrameSegment => ({
  dims, users: visit, measured: true, reason: null,
  steps: [{ key: 'visit', users: visit }, { key: 'lead', users: lead }],
  metrics: conv((lead / visit) * 100, prev),
});

/** quiz: TikTok 50% beats Meta 40%; Meta x US duplicates Meta; DE is under 300. ladder: one 60-user path. */
function frame(): FunnelFrame {
  return {
    kind: 'funnel',
    insight: 'acme-storefront-funnels',
    segmentMode: 'lookup',
    lowSample: 100,
    rates: { conv: { num: 'lead', den: 'visit' } },
    dimensions: [
      { key: 'platform', label: 'Platform', values: ['Meta', 'TikTok'] },
      { key: 'country', label: 'Country', values: ['US', 'DE'] },
    ],
    funnels: [
      {
        id: 'quiz',
        name: 'Quiz checkout',
        steps: STEPS,
        metrics: conv(45),
        segments: [
          seg({ platform: 'Meta' }, 600, 240),
          seg({ platform: 'TikTok' }, 400, 200, 45),
          seg({ country: 'US' }, 500, 210),
          seg({ platform: 'Meta', country: 'US' }, 560, 226),
          seg({ country: 'DE' }, 80, 30),
        ],
      },
      { id: 'ladder', name: 'Activation ladder', steps: STEPS, metrics: conv(null), segments: [seg({ country: 'US' }, 60, 33)] },
    ],
  };
}

const BLOCK: Block = { type: 'ranking', data: 'acme-storefront-funnels', options: {} };
function props(p: Partial<BlockProps>): BlockProps & { block: Block } {
  return { frame: frame(), options: {}, block: BLOCK, ...p } as BlockProps & { block: Block };
}
const html = (p: Partial<BlockProps>) => renderToStaticMarkup(createElement(RankingBlock as never, props(p) as never) as ReactElement);
function tree(p: Partial<BlockProps>, slots: unknown[] = []): ReactElement {
  Object.assign(H, { on: true, i: 0, slots });
  try {
    return (RankingBlock as (x: unknown) => ReactElement)(props(p));
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

describe('ranking: each funnel\'s best breakdown, at the default floor of 300', () => {
  it('one row per funnel with a path over the floor, best first, the duplicate intersection gone', () => {
    const out = html({});
    expect(out).toContain('data-lab-ranking=""');
    expect(out).toContain('data-lab-ranking-floor="300"');
    const rows = [...out.matchAll(/data-lab-ranking-row="([^"]+)" data-selection="([^"]*)"/g)].map((m) => [m[1], m[2]]);
    expect(rows).toEqual([['quiz', 'platform=TikTok']]);
    expect(out).toContain('data-value="50"');
    expect(out).not.toContain('country=US&amp;platform=Meta');
  });

  it('the best path reads its breakdown, the funnel total and its change; the dot carries no wash', () => {
    const out = html({});
    expect(out).toContain('>TikTok<');
    expect(out).toContain('>50.0%<');
    expect(out).toContain('>45.0%<');
  });

  it('the change has its own labelled column, in points; a row without one says why', () => {
    const out = html({});
    expect(out).toContain('data-lab-ranking-delta-head="">vs previous<');
    expect(out).toMatch(/data-lab-ranking-delta=""[^>]*data-sign="up"[^>]*title="vs previous: \+5\.0 pp"[^>]*>\+5\.0 pp</);
    const noPrev = renderToStaticMarkup(tree({}, [null, 30])).match(/<tr[^>]*data-lab-ranking-row="quiz"[\s\S]*?<\/tr>/)?.[0] ?? '';
    expect(noPrev).toContain('data-lab-ranking-delta=""');
    const f = frame();
    f.funnels[0].segments!.forEach((s) => { s.metrics!.conv.prev = null; });
    const none = html({ frame: f }).match(/<tr[^>]*data-lab-ranking-row="quiz"[\s\S]*?<\/tr>/)?.[0] ?? '';
    expect(none).toMatch(/data-lab-ranking-no-prev=""[^>]*title="No previous window for this path"[^>]*>–</);
  });

  it('a funnel with no path over the floor is listed in the footnote, never as a 0 row', () => {
    const out = html({});
    expect(out).toContain('data-lab-ranking-dropped="1"');
    expect(out).toContain('1 funnels have no breakdown with 300 users or more');
    expect(out).toContain('title="Activation ladder"');
    expect(out).not.toContain('data-lab-ranking-row="ladder"');
  });

  it('at floor 30 the small path competes: it reads k/n and fades as low sample', () => {
    const out = renderToStaticMarkup(tree({}, [null, 30]));
    expect(out).toContain('data-lab-ranking-floor="30"');
    const ladder = out.match(/<tr[^>]*data-lab-ranking-row="ladder"[\s\S]*?<\/tr>/)?.[0] ?? '';
    expect(ladder).toContain('data-low-sample="true"');
    expect(ladder).toContain('title="Low sample"');
    expect(ladder).toContain('data-lab-kn="33/60"');
    expect(ladder).toContain('>33/60<');
    expect(ladder).not.toContain('55%');
    // The funnel level carries no measured value: it says so, never 0.
    expect(ladder).toContain('Not measured');
    // Best first: the ladder's 55% outranks quiz's 50%.
    expect(out.indexOf('data-lab-ranking-row="ladder"')).toBeLessThan(out.indexOf('data-lab-ranking-row="quiz"'));
  });

  it('floors are 30/100/300 only; any other runtime value is the default', () => {
    expect(rankingFloor(null)).toBe(300);
    expect(rankingFloor(100)).toBe(100);
    expect(rankingFloor(50)).toBe(300);
    expect(html({}).match(/<option value="\d+"/g)).toEqual(['<option value="30"', '<option value="100"', '<option value="300"']);
  });
});

describe('ranking: interaction', () => {
  it('clicking a funnel opens its best path for the card', () => {
    const onFunnel = vi.fn();
    const onSelection = vi.fn();
    const root = tree({ onFunnel, onSelection });
    const open = findAll(root, (e) => e.props['data-lab-ranking-open'] === 'quiz')[0];
    expect(open.props.disabled).toBe(false);
    (open.props.onClick as () => void)();
    expect(onFunnel).toHaveBeenLastCalledWith('quiz');
    expect(onSelection).toHaveBeenLastCalledWith({ platform: 'TikTok' });
  });

  it('without handles the funnel name is not a control', () => {
    const open = findAll(tree({}), (e) => e.props['data-lab-ranking-open'] === 'quiz')[0];
    expect(open.props.disabled).toBe(true);
  });

  it('the row for the card\'s current funnel and path is marked active', () => {
    expect(html({ options: { funnel: 'quiz' }, selection: { platform: 'TikTok' } })).toMatch(/data-lab-ranking-row="quiz"[^>]*data-active=""/);
    expect(html({ selection: { platform: 'Meta' } })).not.toContain('data-active=""');
  });

  it('the metric switch shows only with two or more metrics; a pick narrows it', () => {
    const f = frame();
    f.ladder = ['conv', 'ghost'];
    expect(rankingMetrics(f, null)).toEqual(['conv', 'ghost']);
    expect(rankingMetrics(f, ['ghost', 'nope', 'ghost'])).toEqual(['ghost']);
    expect(html({ frame: f })).toContain('data-lab-ranking-metric="ghost"');
    expect(html({})).not.toContain('data-lab-ranking-switch');
  });
});

describe('ranking: honest empty states', () => {
  it('a cells-mode set ranks nothing and says why', () => {
    const out = html({ frame: { ...frame(), segmentMode: 'cells' } });
    expect(out).toContain('data-lab-empty="ranking"');
    expect(out).toContain('Rates are not carried for summed cells');
  });

  it('no path over the floor anywhere says so, with the metric', () => {
    const f = frame();
    f.funnels[0].segments = f.funnels[0].segments!.filter((s) => s.users < 300);
    const out = html({ frame: f });
    expect(out).toContain('data-lab-empty="ranking"');
    expect(out).toContain('No breakdown has 300 users or more on Visit to lead.');
  });

  it('a non-funnel frame is the shared empty state', () => {
    expect(html({ frame: { kind: 'empty', reason: 'no-cache', ref: null } })).toContain('data-empty-reason="no-cache"');
  });

  it('script strings render as text', () => {
    const f = frame();
    f.funnels[0].name = '<img src=x onerror=alert(1)>';
    const out = html({ frame: f });
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
