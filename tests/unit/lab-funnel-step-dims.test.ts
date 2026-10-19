/**
 * A funnel step that can only be broken down by SOME dimensions (`steps[].dims`).
 * Under a filter on a dimension the step leaves out, the step is NOT MEASURED
 * there: no 0, no rate into the next step, never the worst drop, and "top" is
 * the first measured step. Every surface applies the one rule: the contract
 * parser, the dashboard detail page model (applyClientFilters, breakdown
 * lanes), the board explorer (frameOps funnelSlice -> Steps / Flow / Compare)
 * and the CLI (`lab show --select`, `lab board show --select`). A step without
 * `dims` behaves exactly as before. Synthetic Acme vocabulary only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import { createProgram } from '../../src/cli/program.js';
import { createInsight, writeCache } from '../../src/lib/lab/store.js';
import { putBoard } from '../../src/lib/lab/boards.js';
import { parseFunnelSet } from '../../src/lib/lab/funnel.js';
import { resolveFrame } from '../../src/lib/lab/frames.js';
import { funnelSlice, splitStep, stepDrops, unsplitDims, type FunnelFrame } from '../../src/lib/lab/frameOps.js';
import type { FunnelSet, InsightCache } from '../../src/lib/lab/types.js';

const COPY: Record<string, string> = {
  'lab.blocks.funnel.ofPrev': '{pct} of prev. step',
  'lab.blocks.funnel.worst': 'Biggest drop',
  'lab.blocks.explorer.notMeasured': 'Not measured for {sel}: {reason}',
  'lab.blocks.breakdown.all': 'All traffic',
  'lab.blocks.breakdown.noPath': 'No measured path for this combination.',
  'lab.explorer.notMeasured': 'Not measured',
  'lab.explorer.notMeasuredWhy': 'Not measured: {reason}',
  'lab.explorer.notSplitBy': 'no {dims} breakdown',
};
const TR: Record<string, string> = {
  'lab.explorer.notMeasuredWhy': 'Ölçülmüyor: {reason}',
  'lab.explorer.notSplitBy': '{dims} kırılımı yok',
};

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => COPY[key] ?? key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/components/lab/chartBody.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, useMeasured: () => [() => {}, { width: 0, height: 0 }] };
});

const model = await import('../../dashboard/src/components/lab/funnel/funnelModel.js');
const { laneStepsOf } = await import('../../dashboard/src/components/lab/funnel/FunnelDetailPage.js');
const { FunnelStepTable } = await import('../../dashboard/src/components/lab/funnel/FunnelStepTable.js');
const { FunnelLane } = await import('../../dashboard/src/components/lab/funnel/FunnelLane.js');
const { FunnelBlock } = await import('../../dashboard/src/components/lab/blocks/FunnelBlock.js');
const { localizeSplitReasons } = await import('../../dashboard/src/components/lab/explorer/explorerFormat.js');

const SLUG = 'acme-chat-funnel';
const DIMENSIONS = [
  { key: 'language', label: 'Language' },
  { key: 'source', label: 'Source' },
  { key: 'channel', label: 'Channel' },
];

/**
 * Acme Messenger: a landing button, then a chat. The landing click carries the
 * language and the source but no channel (the chat app is chosen after it), so
 * its cells have no `channel` and the step says `dims: [language, source]`.
 */
function raw(opts: { dims?: unknown; mode?: 'cells' | 'lookup' } = {}): Record<string, unknown> {
  const clicked: Record<string, unknown> = { key: 'clicked', label: 'Landing button', users: 1000 };
  if (opts.dims !== undefined) clicked.dims = opts.dims;
  const cells = [
    { dims: { language: 'EN', source: 'ads' }, steps: [{ key: 'clicked', users: 500 }] },
    { dims: { language: 'EN', source: 'organic' }, steps: [{ key: 'clicked', users: 200 }] },
    { dims: { language: 'RU', source: 'ads' }, steps: [{ key: 'clicked', users: 300 }] },
    { dims: { language: 'EN', source: 'ads', channel: 'telegram' }, steps: [{ key: 'chat_started', users: 250 }, { key: 'first_reply', users: 120 }] },
    { dims: { language: 'EN', source: 'ads', channel: 'whatsapp' }, steps: [{ key: 'chat_started', users: 150 }, { key: 'first_reply', users: 80 }] },
    { dims: { language: 'EN', source: 'organic', channel: 'telegram' }, steps: [{ key: 'chat_started', users: 100 }, { key: 'first_reply', users: 50 }] },
    { dims: { language: 'RU', source: 'ads', channel: 'telegram' }, steps: [{ key: 'chat_started', users: 100 }, { key: 'first_reply', users: 50 }] },
  ];
  // Lookup: one measured path per exact selection (a channel path counts the landing as 0: no data, not none).
  const paths = [
    { dims: { channel: 'telegram' }, users: 450, steps: [{ key: 'clicked', users: 0 }, { key: 'chat_started', users: 450 }, { key: 'first_reply', users: 220 }] },
    { dims: { language: 'RU' }, users: 300, steps: [{ key: 'clicked', users: 300 }, { key: 'chat_started', users: 100 }, { key: 'first_reply', users: 50 }] },
  ];
  return {
    kind: 'funnel-set/v1',
    ...(opts.mode === 'lookup' ? { segment_mode: 'lookup' } : {}),
    dimensions: DIMENSIONS,
    funnels: [{
      id: 'chat',
      name: 'Acme Messenger: landing to chat',
      steps: [clicked, { key: 'chat_started', label: 'Chat started', users: 600 }, { key: 'first_reply', label: 'First reply', users: 300 }],
      segments: opts.mode === 'lookup' ? paths : cells,
    }],
  };
}

const parsed = (opts?: Parameters<typeof raw>[0]) => parseFunnelSet(raw(opts));
const funnelOf = (set: FunnelSet) => set.funnels[0] as unknown as Parameters<typeof model.applyClientFilters>[0];
const WITH_DIMS = { dims: ['language', 'source'] };

describe('contract: steps[].dims', () => {
  it('keeps the declared dims a step can be broken down by', () => {
    const { set, notices } = parsed(WITH_DIMS);
    expect(set.funnels[0].steps[0].dims).toEqual(['language', 'source']);
    expect(set.funnels[0].steps[1].dims).toBeUndefined();
    expect(notices.filter((n) => n.includes('dims'))).toEqual([]);
  });

  it('an undeclared dimension name is a notice and is dropped (a typo never widens the claim)', () => {
    const { set, notices } = parsed({ dims: ['language', 'chanel'] });
    expect(set.funnels[0].steps[0].dims).toEqual(['language']);
    expect(notices).toContain('funnel chat step "clicked": dims "chanel" are not declared dimensions, dropped.');
  });

  it('a list that loses every key stays [] (splits by nothing), and a non-list is ignored with a notice', () => {
    expect(parsed({ dims: ['platform'] }).set.funnels[0].steps[0].dims).toEqual([]);
    const notList = parsed({ dims: 'language' });
    expect(notList.set.funnels[0].steps[0].dims).toBeUndefined();
    expect(notList.notices).toContain('funnel chat step "clicked": dims is not a list of dimension keys, ignored.');
  });

  it('a payload without dims parses exactly as before', () => {
    const { set } = parsed();
    expect(set.funnels[0].steps[0]).toEqual({ key: 'clicked', label: 'Landing button', users: 1000 });
  });
});

describe('the rule (frameOps)', () => {
  it('unsplitDims: the selected dims a step leaves out; no list = none', () => {
    expect(unsplitDims(['language', 'source'], ['channel'])).toEqual(['channel']);
    expect(unsplitDims(['language', 'source'], ['language'])).toEqual([]);
    expect(unsplitDims(undefined, ['channel'])).toEqual([]);
    expect(unsplitDims([], ['language'])).toEqual(['language']);
  });

  it('splitStep keeps a payload reason on a step that is already not measured', () => {
    const step = { key: 'a', label: 'A', users: 0, measured: false, reason: 'event not tracked' };
    expect(splitStep(step, ['language'], ['channel'], (k) => k)).toBe(step);
  });
});

describe('detail page model: applyClientFilters (cells)', () => {
  const funnel = funnelOf(parsed(WITH_DIMS).set);

  it('Channel filter: the landing step is not measured, with a reason, and the next step has no drop rate', () => {
    const r = model.applyClientFilters(funnel, { channel: ['telegram'] }, 'cells', DIMENSIONS)!;
    expect(r.measured).toBe(true);
    expect(r.steps[0]).toEqual({ key: 'clicked', label: 'Landing button', users: 0, measured: false, reason: 'no Channel breakdown', notSplitBy: ['channel'] });
    expect(r.steps.slice(1).map((s) => s.users)).toEqual([450, 220]);
    // The users of the selection are the first MEASURED step's, not a 0.
    expect(r.users).toBe(450);
    const rows = model.computeStepRows(r.steps);
    expect(rows[0]).toMatchObject({ measured: false, ofTop: null, ofPrev: null, drop: null });
    expect(rows[1]).toMatchObject({ ofTop: 100, ofPrev: null, drop: null });
    // The biggest drop is chat -> reply, never landing -> chat.
    expect(model.worstDropIndex(rows)).toBe(2);
  });

  it('Language filter: the landing step keeps its real count', () => {
    const r = model.applyClientFilters(funnel, { language: ['RU'] }, 'cells', DIMENSIONS)!;
    expect(r.steps.map((s) => [s.users, s.measured])).toEqual([[300, undefined], [100, undefined], [50, undefined]]);
    expect(model.computeStepRows(r.steps)[1].ofPrev).toBeCloseTo(33.33, 1);
  });

  it('Language AND Channel: the landing step names only the dim it is not split by', () => {
    const r = model.applyClientFilters(funnel, { channel: ['telegram'], language: ['EN'] }, 'cells', DIMENSIONS)!;
    expect(r.steps[0]).toMatchObject({ measured: false, notSplitBy: ['channel'], reason: 'no Channel breakdown' });
  });

  it('a step without dims: exactly the old behaviour (a summed 0 under the Channel filter)', () => {
    const old = model.applyClientFilters(funnelOf(parsed().set), { channel: ['telegram'] }, 'cells', DIMENSIONS)!;
    expect(old.steps).toEqual([
      { key: 'clicked', label: 'Landing button', users: 0 },
      { key: 'chat_started', label: 'Chat started', users: 450 },
      { key: 'first_reply', label: 'First reply', users: 220 },
    ]);
    expect(old.users).toBe(0);
  });

  it('without dimension labels the reason names the dim key', () => {
    expect(model.applyClientFilters(funnel, { channel: ['telegram'] })!.steps[0].reason).toBe('no channel breakdown');
  });

  it('lookup mode applies the same rule to the looked-up path', () => {
    const f = funnelOf(parsed({ ...WITH_DIMS, mode: 'lookup' }).set);
    const tg = model.applyClientFilters(f, { channel: ['telegram'] }, 'lookup', DIMENSIONS)!;
    expect(tg.steps[0]).toMatchObject({ measured: false, reason: 'no Channel breakdown' });
    expect(tg.users).toBe(450);
    expect(model.worstDropIndex(model.computeStepRows(tg.steps))).toBe(2);
    const ru = model.applyClientFilters(f, { language: ['RU'] }, 'lookup', DIMENSIONS)!;
    expect(ru.steps[0]).toEqual({ key: 'clicked', label: 'Landing button', users: 300 });
  });
});

describe('detail page: breakdown, collapse, table, lane, markdown', () => {
  const funnel = funnelOf(parsed(WITH_DIMS).set);

  it('a breakdown by Channel puts the landing step in no lane and in no remainder', () => {
    const lanes = model.breakdownLanes(funnel, 'channel');
    expect(lanes.map((l) => l.value)).toEqual(['telegram', 'whatsapp']);
    for (const lane of lanes) expect(lane.steps.has('clicked')).toBe(false);
    expect(model.notSplitSteps(funnel, 'channel')).toEqual(new Set(['clicked']));
    expect(model.notSplitSteps(funnel, 'language')).toEqual(new Set());
    // By Language the landing step is split as usual.
    expect(model.breakdownLanes(funnel, 'language').find((l) => l.value === 'RU')!.steps.get('clicked')).toBe(300);
  });

  it('laneStepsOf marks a not-split step not measured, in either mode', () => {
    const spine = [{ key: 'clicked', label: 'Landing button', users: 1000 }, { key: 'chat_started', label: 'Chat started', users: 600 }];
    for (const mode of ['cells', 'lookup'] as const) {
      const own = laneStepsOf(spine, new Map([['chat_started', 250]]), mode, new Set(['clicked']), 'no Channel breakdown');
      expect(own.steps[0]).toEqual({ key: 'clicked', label: 'Landing button', users: 0, measured: false, reason: 'no Channel breakdown' });
      expect(own.missing).toEqual([]);
    }
  });

  it('collapse never folds a not-measured step into a group', () => {
    const steps = model.applyClientFilters(funnel, { channel: ['telegram'] }, 'cells', DIMENSIONS)!.steps;
    const collapsed = model.collapseSteps(steps, 99);
    expect(collapsed[0]).toMatchObject({ key: 'clicked', measured: false, reason: 'no Channel breakdown', collapsed: null });
    expect(collapsed.slice(1).map((c) => c.key)).toEqual(['first_reply']);
  });

  it('the step table says "Not measured" on the landing row and marks the worst drop on the reply row', () => {
    const steps = model.applyClientFilters(funnel, { channel: ['telegram'] }, 'cells', DIMENSIONS)!.steps;
    const html = renderToStaticMarkup(createElement(FunnelStepTable, { steps, caption: 'Steps' }));
    expect(html).toContain('data-lab-not-measured="clicked"');
    expect(html).toContain('Not measured: no Channel breakdown');
    expect(html).not.toMatch(/data-lab-step="clicked"[^>]*data-users/);
    expect(html).toMatch(/data-lab-step="first_reply"[^]*data-lab-worst-tag/);
    expect(html).not.toMatch(/data-lab-step="chat_started"[^>]*>[^]*?data-lab-worst-tag[^]*data-lab-step="first_reply"/);
  });

  it('the lane draws a not-measured node, not a 0', () => {
    const steps = model.applyClientFilters(funnel, { channel: ['telegram'] }, 'cells', DIMENSIONS)!.steps;
    const html = renderToStaticMarkup(createElement(FunnelLane, { steps }));
    expect(html).toContain('data-lab-not-measured="clicked"');
    expect(html).toContain('Landing button: Not measured: no Channel breakdown');
    expect(html).not.toMatch(/aria-label="Landing button: 0 users/);
  });

  it('copy-as-Markdown writes the reason, not a 0', () => {
    const steps = model.applyClientFilters(funnel, { channel: ['telegram'] }, 'cells', DIMENSIONS)!.steps;
    const md = model.stepTableMarkdown('Chat', model.computeStepRows(steps), (key) => steps.find((s) => s.key === key)?.reason);
    expect(md).toContain('| Landing button | not measured (no Channel breakdown) | — | — | — |');
  });
});

describe('board explorer: funnelSlice (Steps / Flow / Compare) and the block', () => {
  let projectRoot: string;
  let root: string;
  let frame: FunnelFrame;

  beforeEach(() => {
    projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-lab-step-dims-')));
    root = join(projectRoot, '_dream_context');
    mkdirSync(join(root, 'core'), { recursive: true });
    createInsight(root, { slug: SLUG, title: 'Acme Messenger', category: 'Growth' });
    const { set, notices } = parsed(WITH_DIMS);
    writeCache(root, SLUG, {
      slug: SLUG, fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily', unit: null,
      series: [], latest: null, error: null, errorAt: null, scriptHash: null,
      funnel: { set, notices, range: { fromISO: '2026-09-01', toISO: '2026-09-28' } },
    } as InsightCache);
    frame = resolveFrame(root, SLUG, ['funnel']) as FunnelFrame;
  });
  afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

  it('the frame carries the step dims', () => {
    expect(frame.funnels[0].steps[0].dims).toEqual(['language', 'source']);
  });

  it('Channel: the landing step is not measured and is never the worst drop', () => {
    const slice = funnelSlice(frame, null, { channel: 'telegram' });
    expect(slice.measured).toBe(true);
    expect(slice.steps[0]).toEqual({ key: 'clicked', label: 'Landing button', users: 0, measured: false, reason: 'no Channel breakdown', notSplitBy: ['channel'] });
    const drops = stepDrops(slice.steps);
    expect(drops[1]).toMatchObject({ ofTop: 100, ofPrev: null, dropPct: null, worst: false });
    expect(drops.find((d) => d.worst)!.key).toBe('first_reply');
  });

  it('Language: the landing step is a real count; a pinned Channel lane still is not', () => {
    expect(funnelSlice(frame, null, { language: 'RU' }).steps[0]).toEqual({ key: 'clicked', label: 'Landing button', users: 300 });
    expect(funnelSlice(frame, null, { language: 'RU', channel: 'telegram' }).steps[0].measured).toBe(false);
  });

  it('the reason reads in the UI language on the board', () => {
    const slice = funnelSlice(frame, null, { channel: 'telegram' });
    const tr = localizeSplitReasons((k: string) => TR[k] ?? k, slice, frame.dimensions ?? []);
    expect(tr.steps[0].reason).toBe('Channel kırılımı yok');
    expect(tr.steps[1]).toBe(slice.steps[1]);
    const unchanged = funnelSlice(frame, null, { language: 'RU' });
    expect(localizeSplitReasons((k: string) => TR[k] ?? k, unchanged, frame.dimensions ?? [])).toBe(unchanged);
  });

  it('the Steps table block: "Not measured" on the landing row, the Biggest drop tag on the reply row', () => {
    const html = renderToStaticMarkup(createElement(FunnelBlock, {
      frame, options: { table: true, markWorst: true }, selection: { channel: 'telegram' }, lanes: [],
    } as never));
    expect(html).toMatch(/data-lab-step="clicked"[^>]*data-measured="false"/);
    expect(html).toContain('Not measured: no Channel breakdown');
    expect(html).toContain('data-lab-worst-note="first_reply"');
    expect(html).toMatch(/data-lab-step="first_reply"[^>]*data-worst="true"/);
    expect(html).not.toMatch(/data-lab-step="chat_started"[^>]*data-worst="true"/);
  });

  it('the Compare lanes: a Channel lane says not measured at the landing step, a Language lane counts it', () => {
    const html = renderToStaticMarkup(createElement(FunnelBlock, {
      frame, options: { compare: 'lanes' }, selection: {}, lanes: [{ channel: 'telegram' }, { language: 'RU' }],
    } as never));
    expect(html.match(/data-lab-not-measured="clicked"/g)?.length).toBe(1);
  });

  async function cli(argv: string[]): Promise<string> {
    const lines: string[] = [];
    const push = (...a: unknown[]): void => { lines.push(a.map(String).join(' ')); };
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')].map((s) => s.mockImplementation(push));
    const cwd = process.cwd();
    process.chdir(projectRoot);
    try {
      await createProgram().parseAsync(argv, { from: 'user' });
    } finally {
      process.chdir(cwd);
      for (const s of spies) s.mockRestore();
      process.exitCode = undefined;
    }
    // eslint-disable-next-line no-control-regex
    return lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '');
  }

  it('lab show --select channel=telegram: the landing step reads "not measured (no Channel breakdown)", not 0', async () => {
    const out = await cli(['lab', 'show', SLUG, '--select', 'channel=telegram']);
    expect(out).toContain('selection: channel=telegram');
    expect(out).toMatch(/Landing button\s+not measured \(no Channel breakdown\)/);
    expect(out).not.toMatch(/Landing button\s+0\b/);
    expect(out).toMatch(/First reply .*◄ worst drop/);
    expect(out).not.toMatch(/Chat started .*◄ worst drop/);
  });

  it('lab show --select language=RU: the landing step is counted', async () => {
    const out = await cli(['lab', 'show', SLUG, '--select', 'language=RU']);
    expect(out).toMatch(/Landing button\s+300\b/);
  });

  it('lab show without --select prints the totals as before', async () => {
    const out = await cli(['lab', 'show', SLUG]);
    expect(out).toMatch(/Landing button\s+1000\b/);
    expect(out).not.toContain('not measured');
  });

  it('lab show --select --json carries the slices with the not-measured step', async () => {
    const out = await cli(['lab', 'show', SLUG, '--select', 'channel=telegram', '--json']);
    const json = JSON.parse(out);
    expect(json.selection).toEqual({ channel: 'telegram' });
    expect(json.slices[0].steps[0]).toMatchObject({ key: 'clicked', measured: false, reason: 'no Channel breakdown' });
    expect(json.slices[0].drops.find((d: { worst: boolean }) => d.worst).key).toBe('first_reply');
  });

  it('lab board show --select: the explorer Steps block says not measured and puts the biggest drop on the reply', async () => {
    await putBoard(root, 'acme', {
      title: 'Acme', order: 1,
      cards: [{ id: 'c-steps', at: { x: 0, y: 0, w: 6, h: 6 }, insight: SLUG, blocks: [{ funnel: { data: SLUG, markWorst: true } }] }],
    } as never);
    const out = await cli(['lab', 'board', 'show', 'acme', '--select', 'channel=telegram']);
    expect(out).toContain('Landing button: Not measured: no Channel breakdown');
    expect(out).toMatch(/First reply: 220.*← biggest drop/);
    expect(out).not.toMatch(/Chat started: .*← biggest drop/);
  });
});
