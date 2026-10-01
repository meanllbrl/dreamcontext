/**
 * The funnel block's explorer mode (W2-L4): funnel pick, selection lookup,
 * markWorst, the flow layout, pinned lanes, and v1 lookup honesty in the
 * funnel pages' model (applyClientFilters / breakdownLanes never sum a lookup
 * set). Plus the regression guard: default options draw exactly today's markup.
 * Static markup through the dashboard's own React; geometry is measured by the
 * lab-boards verify run. Synthetic Acme vocabulary only.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import { funnelSlice, stepDrops, type FunnelFrame } from '../../dashboard/src/generated/frameOps.js';
import type { Block } from '../../dashboard/src/components/lab/board/boardTypes.js';

const COPY: Record<string, string> = {
  'lab.blocks.funnel.ofPrev': '{pct} of prev. step',
  'lab.blocks.funnel.more': '+{n} more funnels. Make the card taller to see them.',
  'lab.blocks.funnel.worst': 'Biggest drop',
  'lab.blocks.funnel.drop': '{pct} drop',
  'lab.blocks.funnel.lane': 'Lane {n}',
  'lab.blocks.explorer.notMeasured': 'Not measured for {sel}: {reason}',
  'lab.blocks.explorer.unknownFunnel': 'Funnel {id} is not in the data. Showing {name}.',
  'lab.blocks.explorer.lowSample': 'Low sample: {n} users',
  'lab.blocks.breakdown.all': 'All traffic',
  'lab.blocks.breakdown.noPath': 'No measured path for this combination.',
};

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => COPY[key] ?? key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));

/** The measured box every block and layout sees (the static render has none): 0 = not measured. */
const BOX = { width: 0, height: 0 };
vi.mock('../../dashboard/src/components/lab/chartBody.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, useMeasured: () => [() => {}, { ...BOX }] };
});
function inBox<T>(width: number, height: number, fn: () => T): T {
  Object.assign(BOX, { width, height });
  try { return fn(); } finally { Object.assign(BOX, { width: 0, height: 0 }); }
}

const { FunnelBlock, explorerView } = await import('../../dashboard/src/components/lab/blocks/FunnelBlock.js');
const { stageWidthPct, dropBadgeText, flowMode, flowTight, FLOW_PX } = await import('../../dashboard/src/components/lab/funnel/FunnelFlow.js');
const { laneModel, lanesDense, laneTextWidths, LANE_PX } = await import('../../dashboard/src/components/lab/funnel/FunnelLanes.js');
const model = await import('../../dashboard/src/components/lab/funnel/funnelModel.js');

const LOW = 'fewer than 300 users in the window';
const STEPS = [
  { key: 'visit', label: 'Visit', users: 1000 },
  { key: 'lead', label: 'Lead', users: 400 },
  { key: 'checkout', label: 'Checkout', users: 200 },
  { key: 'buy', label: 'Buy', users: 100 },
];
const path = (users: number[], keys = ['visit', 'lead', 'checkout', 'buy']) => keys.map((key, i) => ({ key, users: users[i] }));

/** Acme Storefront, lookup mode: one-axis paths AND intersections overlap (summing them double-counts). */
function lookupFrame(): FunnelFrame {
  return {
    kind: 'funnel',
    insight: 'acme-funnel-explorer',
    segmentMode: 'lookup',
    lowSample: 50,
    dimensions: [
      { key: 'platform', label: 'Platform', values: ['Meta Ads', 'TikTok Ads'] },
      { key: 'language', label: 'Language', values: ['EN', 'ES'] },
    ],
    funnels: [
      {
        id: 'quiz-checkout',
        name: 'Quiz checkout (v2)',
        steps: STEPS,
        segments: [
          { dims: { platform: 'Meta Ads' }, users: 600, steps: path([600, 300, 150, 90]), measured: true, reason: null },
          { dims: { platform: 'TikTok Ads' }, users: 400, steps: path([400, 100, 50, 10]), measured: true, reason: null },
          { dims: { language: 'EN' }, users: 700, steps: path([700, 280, 140, 70]), measured: true, reason: null },
          { dims: { platform: 'Meta Ads', language: 'EN' }, users: 420, steps: path([420, 210, 105, 63]), measured: true, reason: null },
          { dims: { platform: 'Meta Ads', language: 'ES' }, users: 0, steps: [], measured: false, reason: LOW },
          // Lacks the checkout step: the lane shows a dash there.
          { dims: { platform: 'TikTok Ads', language: 'EN' }, users: 280, steps: path([280, 70, 7], ['visit', 'lead', 'buy']), measured: true, reason: null },
          { dims: { platform: 'TikTok Ads', language: 'ES' }, users: 40, steps: path([40, 20, 10, 5]), measured: true, reason: null },
        ],
      },
      { id: 'activation', name: 'Activation ladder', steps: [{ key: 'signup', label: 'Signup', users: 500 }, { key: 'active', label: 'Active', users: 120 }] },
    ],
  };
}

/** Yesterday's v1 funnel frame: several funnels, no dims, no explorer fields. */
function legacyFrame(): FunnelFrame {
  return {
    kind: 'funnel',
    insight: 'acme-funnels',
    funnels: [
      { id: 'a', name: 'Signup', steps: [{ key: 's1', label: 'Landing', users: 1000 }, { key: 's2', label: 'Form', users: 500 }, { key: 's3', label: 'Done', users: 250 }] },
      { id: 'b', name: 'Checkout', steps: [{ key: 'c1', label: 'Cart', users: 300 }, { key: 'c2', label: 'Paid', users: 90 }] },
    ],
  };
}

const BLOCK: Block = { type: 'funnel', options: {} } as Block;
function render(frame: FunnelFrame, options: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(FunnelBlock, { block: { ...BLOCK, options }, frame, options, ...extra }));
}
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('No regression: default funnel render unchanged', () => {
  // The markup the block drew before explorer mode existed (default options, two funnels).
  const BASELINE = "<div class=\"lab-block-funnel lab-block-funnel--fit\" data-step-conversion=\"\" data-step-mode=\"full\"><section class=\"lab-block-funnel-item\"><h4 class=\"lab-block-funnel-name\">Signup</h4><div class=\"funnel-bars funnel-bars--fill\" style=\"grid-template-rows:repeat(3, minmax(0, var(--space-8)))\"><div class=\"funnel-bars-row\" title=\"Landing: 1,000 users \u00b7 100.0% of top\"><span class=\"funnel-bars-label\">Landing</span><span class=\"funnel-bars-track\"><span class=\"funnel-bars-fill\" style=\"width:100%\"></span></span><span class=\"funnel-bars-value\">1,000<span class=\"funnel-bars-pct\"> \u00b7 100%</span><span class=\"funnel-bars-step funnel-bars-step--spacer\" aria-hidden=\"true\"><svg class=\"funnel-bars-step-icon\" viewBox=\"0 0 10 10\" width=\"10\" height=\"10\" focusable=\"false\"></svg>100% of prev. step</span></span></div><div class=\"funnel-bars-row\" title=\"Form: 500 users \u00b7 50.0% of top \u00b7 50% of prev. step\"><span class=\"funnel-bars-label\">Form</span><span class=\"funnel-bars-track\"><span class=\"funnel-bars-fill\" style=\"width:50%\"></span></span><span class=\"funnel-bars-value\">500<span class=\"funnel-bars-pct\"> \u00b7 50%</span><span class=\"funnel-bars-step\" data-step-pct=\"50.0\"><svg class=\"funnel-bars-step-icon\" viewBox=\"0 0 10 10\" width=\"10\" height=\"10\" aria-hidden=\"true\" focusable=\"false\"><path d=\"M2 1v4.5h5.5M5.5 3.5l2 2-2 2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"></path></svg>50% of prev. step</span></span></div><div class=\"funnel-bars-row\" title=\"Done: 250 users \u00b7 25.0% of top \u00b7 50% of prev. step\"><span class=\"funnel-bars-label\">Done</span><span class=\"funnel-bars-track\"><span class=\"funnel-bars-fill\" style=\"width:25%\"></span></span><span class=\"funnel-bars-value\">250<span class=\"funnel-bars-pct\"> \u00b7 25%</span><span class=\"funnel-bars-step\" data-step-pct=\"50.0\"><svg class=\"funnel-bars-step-icon\" viewBox=\"0 0 10 10\" width=\"10\" height=\"10\" aria-hidden=\"true\" focusable=\"false\"><path d=\"M2 1v4.5h5.5M5.5 3.5l2 2-2 2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"></path></svg>50% of prev. step</span></span></div></div></section><section class=\"lab-block-funnel-item\"><h4 class=\"lab-block-funnel-name\">Checkout</h4><div class=\"funnel-bars funnel-bars--fill\" style=\"grid-template-rows:repeat(2, minmax(0, var(--space-8)))\"><div class=\"funnel-bars-row\" title=\"Cart: 300 users \u00b7 100.0% of top\"><span class=\"funnel-bars-label\">Cart</span><span class=\"funnel-bars-track\"><span class=\"funnel-bars-fill\" style=\"width:100%\"></span></span><span class=\"funnel-bars-value\">300<span class=\"funnel-bars-pct\"> \u00b7 100%</span><span class=\"funnel-bars-step funnel-bars-step--spacer\" aria-hidden=\"true\"><svg class=\"funnel-bars-step-icon\" viewBox=\"0 0 10 10\" width=\"10\" height=\"10\" focusable=\"false\"></svg>100% of prev. step</span></span></div><div class=\"funnel-bars-row\" title=\"Paid: 90 users \u00b7 30.0% of top \u00b7 30% of prev. step\"><span class=\"funnel-bars-label\">Paid</span><span class=\"funnel-bars-track\"><span class=\"funnel-bars-fill\" style=\"width:30%\"></span></span><span class=\"funnel-bars-value\">90<span class=\"funnel-bars-pct\"> \u00b7 30%</span><span class=\"funnel-bars-step\" data-step-pct=\"30.0\"><svg class=\"funnel-bars-step-icon\" viewBox=\"0 0 10 10\" width=\"10\" height=\"10\" aria-hidden=\"true\" focusable=\"false\"><path d=\"M2 1v4.5h5.5M5.5 3.5l2 2-2 2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"></path></svg>30% of prev. step</span></span></div></div></section></div>";

  it('default options draw the baseline markup byte for byte', () => {
    expect(render(legacyFrame())).toBe(BASELINE);
  });

  it('an empty selection, no lanes, or a selection on dims the frame lacks change nothing', () => {
    expect(render(legacyFrame(), {}, { selection: {}, lanes: [] })).toBe(BASELINE);
    expect(render(legacyFrame(), {}, { selection: { platform: 'Meta Ads' } })).toBe(BASELINE);
    expect(render(legacyFrame(), { layout: 'bars', markWorst: false })).toBe(BASELINE);
  });

  it('the legacy options (compact, showConversion) stay on the default path', () => {
    expect(explorerView(legacyFrame(), { compact: true, showConversion: false }, {}, [])).toBeNull();
    expect(render(legacyFrame(), { compact: true })).not.toContain('funnel-explorer');
    expect(render(lookupFrame())).not.toContain('funnel-explorer');
  });
});

describe('Lookup never sums in the UI', () => {
  it('a one-axis selection draws exactly that path', () => {
    const html = render(lookupFrame(), {}, { selection: { platform: 'Meta Ads' } });
    expect(html).toContain('data-lab-selection="platform=Meta Ads"');
    expect(html).toContain('Visit: 600 users');
    expect(html).toContain('Buy: 90 users');
  });

  it('an intersection draws exactly the intersection path, never a sum of overlapping paths', () => {
    const html = render(lookupFrame(), {}, { selection: { platform: 'Meta Ads', language: 'EN' } });
    expect(html).toContain('Visit: 420 users');
    expect(html).toContain('Lead: 210 users');
    // Summing Meta + EN + the intersection would read 1,720 / 790.
    expect(html).not.toContain('1,720');
    expect(html).not.toContain('Visit: 600 users');
  });
});

describe('Not measured is not zero', () => {
  it('an unmeasured intersection says so with its reason and draws no number', () => {
    const html = render(lookupFrame(), {}, { selection: { platform: 'Meta Ads', language: 'ES' } });
    expect(html).toContain('data-lab-measured="false"');
    expect(html).toContain(`Not measured for Meta Ads · ES: ${LOW}`);
    expect(html).not.toContain('funnel-bars-row');
    expect(html).not.toMatch(/>0%?</);
  });

  it('an unknown combination (no path) falls back to the noPath wording', () => {
    const f = lookupFrame();
    f.dimensions![1].values.push('DE');
    const html = render(f, {}, { selection: { language: 'DE' } });
    expect(html).toContain('Not measured for DE: No measured path for this combination.');
  });

  it('a low-sample slice is flagged', () => {
    const html = render(lookupFrame(), {}, { selection: { platform: 'TikTok Ads', language: 'ES' } });
    expect(html).toContain('data-lab-low-sample="40"');
    expect(html).toContain('Low sample: 40 users');
  });
});

describe('funnel pick', () => {
  it('a picked funnel is the one drawn', () => {
    const html = render(lookupFrame(), { funnel: 'activation' });
    expect(html).toContain('data-lab-funnel="activation"');
    expect(html).toContain('Signup: 500 users');
    expect(html).not.toContain('data-lab-unknown-funnel');
  });

  it('an unknown pick says so visibly and shows the first funnel', () => {
    const html = render(lookupFrame(), { funnel: 'gone' });
    expect(html).toContain('data-lab-unknown-funnel="gone"');
    expect(html).toContain('Funnel gone is not in the data. Showing Quiz checkout (v2).');
    expect(html).toContain('data-lab-funnel="quiz-checkout"');
  });
});

describe('markWorst (bars)', () => {
  it('marks the step stepDrops calls worst', () => {
    const html = render(lookupFrame(), { markWorst: true }, { selection: { platform: 'TikTok Ads' } });
    const worst = stepDrops(path([400, 100, 50, 10]).map((s, i) => ({ ...s, label: STEPS[i].label }))).find((d) => d.worst)!;
    expect(worst.key).toBe('buy');
    expect(html).toContain(`data-lab-worst="${worst.key}"`);
    expect(html).toContain('Checkout → Buy');
    expect(html).toContain('80% drop');
    expect(count(html, 'data-lab-worst=')).toBe(1);
  });
});

describe('Flow layout', () => {
  it('one stage per step with width proportional to users, one drop badge per link, the worst marked', () => {
    const html = render(lookupFrame(), { layout: 'flow', markWorst: true });
    expect(html).toContain('data-lab-funnel-explorer="flow"');
    expect(count(html, 'data-lab-flow-stage=')).toBe(4);
    expect(count(html, 'data-lab-drop=')).toBe(3);
    for (const s of STEPS) {
      expect(html).toContain(`data-lab-flow-stage="${s.key}" data-users="${s.users}"`);
      expect(html).toContain(`width:${(s.users / 1000) * 100}%`);
    }
    const worst = stepDrops(STEPS).find((d) => d.worst)!;
    expect(count(html, 'data-lab-worst=')).toBe(1);
    expect(html).toMatch(new RegExp(`data-lab-drop="${worst.key}"[^>]*data-lab-worst="${worst.key}"`));
    expect(html).toContain('Biggest drop');
  });

  it('no worst mark without markWorst; stage widths are exact ratios', () => {
    expect(render(lookupFrame(), { layout: 'flow' })).not.toContain('data-lab-worst');
    expect(stageWidthPct(333, 1000)).toBeCloseTo(33.3, 6);
    expect(stageWidthPct(5, 0)).toBe(0);
    expect(dropBadgeText({ dropPct: 60 })).toBe('▼ 60%');
    expect(dropBadgeText({ dropPct: -12.4 })).toBe('▲ 12%');
    expect(dropBadgeText({ dropPct: null })).toBe('—');
  });
});

describe('Lanes', () => {
  const LANES = [{ platform: 'Meta Ads' }, { platform: 'TikTok Ads', language: 'EN' }, { platform: 'Meta Ads', language: 'ES' }];

  it('pinned selections draw side by side on one spine, each from its own path', () => {
    const html = render(lookupFrame(), { markWorst: true }, { lanes: LANES });
    expect(html).toContain('data-lab-lanes="3"');
    expect(count(html, 'data-lab-lane-step=')).toBe(4);
    expect(html).toContain('data-lab-lane="1"');
    expect(html).toContain('>Meta Ads</span>');
    expect(html).toContain('>TikTok Ads · EN</span>');
    // Lane 1's own rates: 300 / 600 = 50% of its own top.
    expect(html).toContain('Meta Ads · Lead: 300 · 50%');
  });

  it('a missing step is a dash, and the next drop comes from the lane\'s own previous step', () => {
    const m = laneModel(
      LANES.map((sel) => ({ slice: sliceOf(sel), label: model.selectionLabel(sel)! })),
      STEPS,
    );
    expect(m.spine.map((s) => s.key)).toEqual(['visit', 'lead', 'checkout', 'buy']);
    const tiktok = m.lanes[1];
    expect(tiktok.byKey.has('checkout')).toBe(false);
    // buy (7) after lead (70): a 90% drop, not measured against a missing checkout.
    expect(tiktok.byKey.get('buy')!.dropPct).toBeCloseTo(90, 6);
    const html = render(lookupFrame(), {}, { lanes: LANES });
    expect(html).toContain('data-lab-lane-missing="checkout" data-lane="2"');
  });

  it('an unmeasured lane says so and draws dashes, never zeros', () => {
    const html = render(lookupFrame(), {}, { lanes: LANES });
    expect(html).toMatch(/data-lab-lane="3" data-lab-lane-unmeasured=""/);
    expect(html).toContain(`Not measured for Meta Ads · ES: ${LOW}`);
    expect(count(html, 'data-lane="3"') - count(html, 'data-lab-lane-missing=')).toBeLessThanOrEqual(4);
    for (const s of STEPS) expect(html).toContain(`data-lab-lane-missing="${s.key}" data-lane="3"`);
  });

  it('each lane marks its own worst drop', () => {
    const html = render(lookupFrame(), { markWorst: true }, { lanes: LANES.slice(0, 2) });
    expect(html).toMatch(/data-lab-drop="lead" data-lane="1"[^>]*data-lab-worst="lead"/);
    expect(html).toMatch(/data-lab-drop="buy" data-lane="2"[^>]*data-lab-worst="buy"/);
  });

  it('at most 4 lanes are drawn', () => {
    const five = [{}, { platform: 'Meta Ads' }, { platform: 'TikTok Ads' }, { language: 'EN' }, { platform: 'Meta Ads', language: 'EN' }];
    const html = render(lookupFrame(), {}, { lanes: five });
    expect(html).toContain('data-lab-lanes="4"');
    expect(html).toContain('>All traffic</span>');
  });
});

describe('Flow at small sizes (fix round): labels and users never vanish', () => {
  it('flowMode: full when every stage and link row fits, else one line per step', () => {
    expect(flowMode(4, 0)).toBe('full');
    expect(flowMode(4, 4 * FLOW_PX.stage + 3 * FLOW_PX.link)).toBe('full');
    expect(flowMode(7, 100)).toBe('compact');
    expect(flowMode(4, 4 * FLOW_PX.stage + 3 * FLOW_PX.link - 1)).toBe('compact');
  });

  it('a 3x3 cell draws the compact flow: every stage keeps its label, users and shape, the drop badge inline', () => {
    const html = inBox(240, 90, () => render(lookupFrame(), { layout: 'flow', markWorst: true }));
    expect(html).toContain('data-flow-mode="compact"');
    expect(count(html, 'data-lab-flow-stage=')).toBe(4);
    for (const s of STEPS) {
      expect(html).toMatch(new RegExp(`data-lab-flow-stage="${s.key}"[^>]*><span class="funnel-flow-label">${s.label}</span>`));
      expect(html).toContain(`width:${(s.users / 1000) * 100}%`);
    }
    for (const users of ['1,000', '400', '200', '100']) expect(html).toMatch(new RegExp(`class="funnel-flow-value">${users}`));
    expect(count(html, 'data-lab-drop=')).toBe(3);
    expect(count(html, 'funnel-flow-link--inline')).toBe(4);
    expect(count(html, 'data-lab-worst=')).toBe(1);
    // Rows have a readable floor: no row may collapse to 0px.
    expect(html).toContain(`grid-template-rows:${Array(4).fill(`minmax(${FLOW_PX.line}px, 1fr)`).join(' ')}`);
    expect(html).not.toContain('minmax(0, 1fr)');
  });

  it('a cell too short even for 16px lines tightens to 12px lines, never to 0', () => {
    expect(flowTight(7, 0)).toBe(false);
    expect(flowTight(7, 7 * FLOW_PX.line)).toBe(false);
    expect(flowTight(7, 84)).toBe(true);
    const html = inBox(240, 50, () => render(lookupFrame(), { layout: 'flow' }));
    expect(html).toContain('data-flow-tight=""');
    expect(html).toContain(`grid-template-rows:${Array(4).fill(`minmax(${FLOW_PX.tight}px, 1fr)`).join(' ')}`);
    expect(count(html, 'class="funnel-flow-label"')).toBe(4);
  });

  it('the full flow keeps a readable floor on its stage rows too', () => {
    const html = render(lookupFrame(), { layout: 'flow' });
    expect(html).toContain('data-flow-mode="full"');
    expect(html).not.toContain('minmax(0, 1fr)');
  });
});

describe('Lanes at the 8x7 Steps card (fix round): rows never collapse', () => {
  const LANES = [{ platform: 'Meta Ads' }, { platform: 'TikTok Ads', language: 'EN' }, { platform: 'Meta Ads', language: 'ES' }];

  it('one row per step with a readable minimum height (no separate drop rows, no 0px rows)', () => {
    const html = render(lookupFrame(), { markWorst: true }, { lanes: LANES });
    expect(html).toContain(`grid-template-rows:auto ${Array(4).fill(`minmax(${LANE_PX.row}px, 1fr)`).join(' ')}"`);
    expect(html).not.toContain('funnel-lanes-gap');
  });

  it('each cell carries its bar, "users · share", the share alone (for narrow lanes) and the drop into the step', () => {
    const html = render(lookupFrame(), { markWorst: true }, { lanes: LANES });
    const i = html.indexOf('title="Meta Ads · Lead: 300 · 50%"');
    const cell = html.slice(i, html.indexOf('</span></span></span>', html.indexOf('data-lab-drop="lead" data-lane="1"')));
    expect(cell).toContain('class="funnel-lanes-track"');
    expect(cell).toContain('class="funnel-lanes-value">300<span class="funnel-lanes-pct"> · 50%</span>');
    expect(cell).toContain('class="funnel-lanes-share" aria-hidden="true">50%');
    expect(cell).toContain('data-lab-drop="lead" data-lane="1"');
    expect(cell).toContain('▼ 50%');
  });

  it('a lane keeps one text width down its rows, so bars compare down the lane', () => {
    const m = laneModel([{ slice: sliceOf({ platform: 'Meta Ads' }), label: 'Meta Ads' }], STEPS);
    const w = laneTextWidths(m.lanes[0]);
    expect(w.value).toBe('600 · 100%'.length);
    expect(w.share).toBe('100%'.length);
    const html = render(lookupFrame(), {}, { lanes: LANES });
    // Every drawn cell of a lane carries the lane's one width (lane 1: 4 steps, lane 2: 3 of its own).
    expect(count(html, 'data-lane="1" data-users=')).toBe(4);
    expect(count(html, '--lane-value-w:10ch')).toBe(7);
  });

  it('a short block turns the lane heads to one line', () => {
    expect(lanesDense(7, 0)).toBe(false);
    expect(lanesDense(7, 400)).toBe(false);
    expect(lanesDense(7, 150)).toBe(true);
    expect(inBox(600, 120, () => render(lookupFrame(), {}, { lanes: LANES }))).toMatch(/class="funnel-lanes"[^>]*data-dense=""/);
  });

  it('a narrow one-line lane head keeps the name and lets the users go (they stay in the title)', () => {
    const css = readFileSync(join(new URL('../../', import.meta.url).pathname, 'dashboard/src/components/lab/funnel/FunnelLanes.css'), 'utf8');
    const q = css.slice(css.indexOf('@container lanehead'));
    expect(q).toContain('.funnel-lanes[data-dense] .funnel-lanes-users { display: none; }');
    expect(q.slice(0, q.indexOf('\n}'))).not.toContain('.funnel-lanes-name');
    expect(render(lookupFrame(), {}, { lanes: LANES })).toContain('title="Lane 1: Meta Ads · 600"');
  });

  it('lane-head numbers use the breakdown lane badges\' pair: white on the strong accent (5.64:1), never on accent-soft', () => {
    const css = readFileSync(join(new URL('../../', import.meta.url).pathname, 'dashboard/src/components/lab/funnel/FunnelLanes.css'), 'utf8');
    const at = css.indexOf('.funnel-lanes-num {');
    const rule = css.slice(at, css.indexOf('}', at));
    expect(rule).toContain('background: var(--color-accent-strong)');
    expect(rule).toContain('color: var(--color-accent-text)');
    expect(rule).not.toContain('accent-soft');
  });

  it('narrow lanes drop the users first, then the share; the bar and the drop stay', () => {
    const css = readFileSync(join(new URL('../../', import.meta.url).pathname, 'dashboard/src/components/lab/funnel/FunnelLanes.css'), 'utf8');
    const mid = css.slice(css.indexOf('@container lane (max-width: 190px)'), css.indexOf('@container lane (max-width: 120px)'));
    const narrow = css.slice(css.indexOf('@container lane (max-width: 120px)'));
    expect(mid).toContain('.funnel-lanes-value { display: none; }');
    expect(mid).toContain('.funnel-lanes-share { display: inline; }');
    expect(narrow).toContain('.funnel-lanes-text { display: none; }');
    expect(narrow).not.toContain('.funnel-lanes-drop');
    expect(narrow).not.toContain('.funnel-lanes-track');
  });
});

describe('script-authored strings render as text', () => {
  it('a step label or dim value carrying markup is escaped', () => {
    const f = lookupFrame();
    f.funnels[0].steps = [{ key: 'visit', label: '<img src=x onerror=alert(1)>', users: 1000 }, ...STEPS.slice(1)];
    f.funnels[0].segments![0].dims = { platform: '<b>Meta</b>' };
    for (const html of [
      render(f, { layout: 'flow' }),
      render(f, { markWorst: true }),
      render(f, {}, { lanes: [{ platform: '<b>Meta</b>' }] }),
    ]) {
      expect(html).not.toContain('<img');
      expect(html).not.toContain('<b>');
    }
  });
});

describe('v1 lookup honesty: the funnel pages never sum a lookup set', () => {
  const def = (): import('../../dashboard/src/components/lab/funnel/funnelModel.js').FunnelDef => ({
    id: 'quiz-checkout',
    name: 'Quiz checkout (v2)',
    meta: {},
    metrics: {},
    steps: STEPS,
    segments: lookupFrame().funnels[0].segments!.map((s) => ({ dims: s.dims, users: s.users, steps: s.steps, measured: s.measured, ...(s.reason ? { reason: s.reason } : {}) })),
  });

  it('applyClientFilters in lookup mode returns exactly the one-axis path', () => {
    const r = model.applyClientFilters(def(), { platform: ['Meta Ads'] }, 'lookup')!;
    expect(r.measured).toBe(true);
    expect(r.steps.map((s) => s.users)).toEqual([600, 300, 150, 90]);
  });

  it('applyClientFilters in lookup mode returns exactly the intersection path (cells mode would sum)', () => {
    const r = model.applyClientFilters(def(), { platform: ['Meta Ads'], language: ['EN'] }, 'lookup')!;
    expect(r.steps.map((s) => s.users)).toEqual([420, 210, 105, 63]);
    expect(r.steps.map((s) => s.label)).toEqual(['Visit', 'Lead', 'Checkout', 'Buy']);
    // Cells mode would sum every segment carrying platform=Meta Ads: Meta (600) + Meta&EN (420).
    expect(model.applyClientFilters(def(), { platform: ['Meta Ads'] })!.steps[0].users).toBe(1020);
  });

  it('an unmeasured path is not measured with its reason, never zero steps', () => {
    const r = model.applyClientFilters(def(), { platform: ['Meta Ads'], language: ['ES'] }, 'lookup')!;
    expect(r).toMatchObject({ measured: false, reason: LOW, steps: [], users: 0 });
    const none = model.applyClientFilters(def(), { language: ['DE'] }, 'lookup')!;
    expect(none).toMatchObject({ measured: false, reason: null });
  });

  it('two values on one dim cannot be added up in lookup mode', () => {
    const r = model.applyClientFilters(def(), { platform: ['Meta Ads', 'TikTok Ads'] }, 'lookup')!;
    expect(r).toMatchObject({ measured: false, multiValue: true, steps: [] });
  });

  it('cells mode never adds an unmeasured cell', () => {
    const f = def();
    f.segments = [
      { dims: { platform: 'Meta Ads' }, users: 600, steps: path([600, 300, 150, 90]) },
      { dims: { platform: 'Meta Ads' }, users: 999, steps: path([999, 999, 999, 999]), measured: false, reason: LOW },
    ];
    expect(model.applyClientFilters(f, { platform: ['Meta Ads'] })!.steps[0].users).toBe(600);
    f.segments = [f.segments[1]];
    expect(model.applyClientFilters(f, { platform: ['Meta Ads'] })).toMatchObject({ measured: false, reason: LOW });
  });

  it('breakdownLanes in lookup mode: each value is its one-axis path, intersections never summed in', () => {
    const lanes = model.breakdownLanes(def(), 'platform', undefined, 'lookup');
    expect(lanes.map((l) => l.value)).toEqual(['Meta Ads', 'TikTok Ads']);
    expect(lanes[0].users).toBe(600);
    expect([...lanes[0].steps.values()]).toEqual([600, 300, 150, 90]);
    expect(lanes.some((l) => l.value === model.REMAINDER_VALUE || l.value === model.OTHER_VALUE)).toBe(false);
    // Cells mode (today) sums Meta + Meta&EN (+ skips the unmeasured Meta&ES): 1,020.
    expect(model.breakdownLanes(def(), 'platform')[0].users).toBe(1020);
  });

  it('breakdownLanes in lookup mode: a 12-value dim is never folded into Other, unmeasured paths are marked', () => {
    const f = def();
    f.segments = Array.from({ length: 12 }, (_, i) => ({
      dims: { country: `Country ${i + 1}` },
      users: 100 + i,
      steps: path([100 + i, 50, 20, 5]),
      ...(i === 11 ? { measured: false, reason: LOW, steps: [], users: 0 } : {}),
    }));
    const lanes = model.breakdownLanes(f, 'country', undefined, 'lookup');
    expect(lanes).toHaveLength(12);
    expect(lanes.some((l) => l.value === model.OTHER_VALUE)).toBe(false);
    expect(lanes[11]).toMatchObject({ value: 'Country 12', measured: false, reason: LOW });
    expect(lanes[11].steps.size).toBe(0);
  });
});

describe('selectionLabel', () => {
  it('writes values in the frame dimension order', () => {
    const dims = [{ key: 'platform' }, { key: 'language' }];
    expect(model.selectionLabel({ language: 'EN', platform: 'Meta Ads' }, dims)).toBe('Meta Ads · EN');
    expect(model.selectionLabel({}, dims)).toBeNull();
  });
});

describe('the explorer stylesheets speak only in tokens', () => {
  const ROOT = join(new URL('../../', import.meta.url).pathname, 'dashboard/src/components/lab/funnel');
  for (const file of ['FunnelFlow.css', 'FunnelLanes.css']) {
    it(file, () => {
      const text = readFileSync(join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
      const bad: string[] = [];
      const re = /(^|[;{\s])(-?[a-z-]+)\s*:\s*([^;{}]+)(?=[;}])/g;
      let seen = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const [prop, value] = [m[2], m[3].trim()];
        if (prop.startsWith('--')) continue;
        seen++;
        if (/#[0-9a-f]{3,8}\b/i.test(value) || /\b(rgba?|hsla?)\(/i.test(value) || /cubic-bezier\(/i.test(value)) bad.push(`${prop}: ${value}`);
        if (prop === 'font-size' && !/^(inherit|var\(--font-size-(xs|sm)\))$/.test(value)) bad.push(`${prop}: ${value}`);
        if (prop === 'font-weight' && !/^(400|600|inherit|var\(--font-weight-(normal|semibold)\))$/.test(value)) bad.push(`${prop}: ${value}`);
      }
      expect(seen).toBeGreaterThan(20);
      expect(bad).toEqual([]);
    });
  }
});

/** A lane's slice through the same pure op the block uses. */
function sliceOf(sel: Record<string, string>) {
  return funnelSlice(lookupFrame(), null, sel);
}
