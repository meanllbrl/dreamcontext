import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProgram } from '../../src/cli/program.js';
import { getInsight, readCache } from '../../src/lib/lab/store.js';
import { getBoard, listBoards } from '../../src/lib/lab/boards.js';
import { explorerSet } from '../fixtures/lab/explorer-set.js';

/**
 * The funnel explorer's CLI (T4): `lab create --preset`, the snapshot gate
 * `lab data write|check`, and `lab board show --select/--funnel` over the
 * derived explorer card, including the three new explorer blocks (ranking,
 * payment, access). The sync after a write runs the real template script.
 * Every name here is synthetic.
 */

const SLUG = 'acme-storefront-funnels';
const BOARD = 'acme-funnel';

let projectRoot: string;
let root: string;
let cwd: string;

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const push = (...a: unknown[]): void => { lines.push(a.map(String).join(' ')); };
  const log = vi.spyOn(console, 'log').mockImplementation(push);
  const err = vi.spyOn(console, 'error').mockImplementation(push);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(push);
  process.exitCode = undefined;
  try {
    await createProgram().parseAsync(argv, { from: 'user' });
  } finally {
    log.mockRestore();
    err.mockRestore();
    warnSpy.mockRestore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  // eslint-disable-next-line no-control-regex
  return { code, out: lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '') };
}

function snapshot(): Record<string, unknown> {
  return {
    source: {
      vault: 'acme',
      chart_name: 'Funnel Analysis',
      pulled_at: '2026-10-08T14:33:48Z',
      freshness: 'data 2h old',
      applied_filters: [
        { field: 'product', op: '=', value: 'Acme', source: 'request' },
        { field: 'event_date', op: 'between', values: ['2026-09-07', '2026-10-04'], source: 'request' },
      ],
    },
    data: explorerSet(),
  };
}

function file(name: string, body: unknown): string {
  const path = join(projectRoot, name);
  writeFileSync(path, JSON.stringify(body), 'utf-8');
  return path;
}

const dataPath = () => join(root, 'lab', 'data', `${SLUG}.json`);

async function createExplorer(): Promise<{ code: number; out: string }> {
  return run(['lab', 'create', SLUG, '--preset', 'funnel-explorer', '--title', 'Acme storefront funnels', '--category', 'Acme Funnel']);
}

beforeEach(() => {
  cwd = process.cwd();
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-lab-data-cli-')));
  root = join(projectRoot, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
  process.chdir(projectRoot);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('lab create --preset funnel-explorer', () => {
  it('scaffolds the explorer insight, writes no snapshot, and says where the card shows (derived vault)', async () => {
    const { code, out } = await createExplorer();
    expect(code, out).toBe(0);
    const m = getInsight(root, SLUG)!;
    expect(m.preset).toBe('funnel-explorer');
    expect(m.render).toBe('funnel');
    expect(m.source?.adapter).toBe('script');
    expect(existsSync(dataPath())).toBe(false);
    expect(out).toContain('funnel explorer card on the board for its category');
    expect(out).toContain(`lab data write ${SLUG} --file <path>`);
  });

  it('a materialized vault is not written: the add-card command to run after the first sync is printed', async () => {
    expect((await run(['lab', 'board', 'create', 'ops', '--title', 'Acme Funnel'])).code).toBe(0);
    const { code, out } = await createExplorer();
    expect(code, out).toBe(0);
    expect(out).toContain(`lab board add-card ops --insight ${SLUG} --preset funnel-explorer`);
    expect(getBoard(root, 'ops')!.cards).toEqual([]);
  });

  it('refuses an unknown preset, a conflicting render and the http adapter (exit 1, nothing created)', async () => {
    const unknown = await run(['lab', 'create', SLUG, '--preset', 'nope', '--title', 'X']);
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain('Unknown preset "nope"');
    expect((await run(['lab', 'create', SLUG, '--preset', 'funnel-explorer', '--render', 'line', '--title', 'X'])).code).toBe(1);
    expect((await run(['lab', 'create', SLUG, '--preset', 'funnel-explorer', '--adapter', 'http', '--title', 'X'])).code).toBe(1);
    expect(getInsight(root, SLUG)).toBeNull();
  });
});

describe('lab data write | check', () => {
  beforeEach(async () => {
    expect((await createExplorer()).code).toBe(0);
  });

  it('check without a snapshot exits 1 and names the write command', async () => {
    const { code, out } = await run(['lab', 'data', 'check', SLUG]);
    expect(code).toBe(1);
    expect(out).toContain(`No snapshot yet at lab/data/${SLUG}.json`);
  });

  it('a refused snapshot writes nothing (absent stays absent, a written one stays byte-identical)', async () => {
    const noDate = snapshot();
    (noDate.source as Record<string, unknown>).applied_filters = [{ field: 'product', op: '=', value: 'Acme', source: 'request' }];
    const refused = await run(['lab', 'data', 'write', SLUG, '--file', file('bad.json', noDate)]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('no explicit date filter');
    expect(existsSync(dataPath())).toBe(false);

    expect((await run(['lab', 'data', 'write', SLUG, '--file', file('good.json', snapshot())])).code).toBe(0);
    const before = readFileSync(dataPath());
    const wrongWindow = snapshot();
    (wrongWindow.data as Record<string, unknown>).window = { from: '2026-09-01', to: '2026-09-30' };
    const again = await run(['lab', 'data', 'write', SLUG, '--file', file('bad2.json', wrongWindow)]);
    expect(again.code).toBe(1);
    expect(again.out).toContain('matches no query');
    expect(readFileSync(dataPath()).equals(before)).toBe(true);

    const notJson = join(projectRoot, 'broken.json');
    writeFileSync(notJson, '{ not json', 'utf-8');
    expect((await run(['lab', 'data', 'write', SLUG, '--file', notJson])).code).toBe(1);
    expect(readFileSync(dataPath()).equals(before)).toBe(true);
  });

  it('a preset insight refuses data that is not a funnel set', async () => {
    const series = snapshot();
    series.data = [{ name: 'signups', points: [{ t: '2026-09-07', v: 3 }] }];
    const { code, out } = await run(['lab', 'data', 'write', SLUG, '--file', file('series.json', series)]);
    expect(code).toBe(1);
    expect(out).toContain('this insight is a funnel explorer');
    expect(existsSync(dataPath())).toBe(false);
  });

  it('a valid snapshot is written, then hard-synced through the template script', async () => {
    const { code, out } = await run(['lab', 'data', 'write', SLUG, '--file', file('good.json', snapshot())]);
    expect(code, out).toBe(0);
    expect(out).toContain(`Snapshot written: lab/data/${SLUG}.json`);
    expect(out).toContain('Snapshot is valid.');
    const cache = readCache(root, SLUG)!;
    expect(cache.error).toBeNull();
    expect(cache.funnel?.set.funnels.map((f) => f.id)).toEqual(['100', '200']);
    // The window the cache holds is the snapshot's, not a range tweak.
    expect(cache.funnel?.range).toEqual({ fromISO: '2026-09-07', toISO: '2026-10-04' });
  });

  it('check --json summarizes what the snapshot carries, read from the parsed set', async () => {
    const { code, out } = await run(['lab', 'data', 'check', SLUG, '--file', file('good.json', snapshot()), '--json']);
    expect(code, out).toBe(0);
    const check = JSON.parse(out);
    expect(check.ok).toBe(true);
    expect(check.kind).toBe('funnel-set/v1');
    expect(check.summary).toMatchObject({
      funnels: 2,
      segments: 4,
      segmentFunnels: 1,
      dailyFunnels: 1,
      intersections: 1,
      ladderStages: 1,
      payment: true,
      access: true,
      window: { from: '2026-09-07', to: '2026-10-04' },
      pulledAt: '2026-10-08T14:33:48Z',
    });
    expect(check.summary.storedBytes).toBeGreaterThan(0);
    expect(check.summary.storedBytes).toBeLessThan(400_000);
  });
});

describe('lab board show over the derived explorer card', () => {
  beforeEach(async () => {
    expect((await createExplorer()).code).toBe(0);
    expect((await run(['lab', 'data', 'write', SLUG, '--file', file('good.json', snapshot())])).code).toBe(0);
  });

  /** The explorer card's block views by tab label. */
  async function views(args: string[]): Promise<Record<string, any>> {
    const { code, out } = await run(['lab', 'board', 'show', BOARD, ...args, '--json']);
    expect(code, out).toBe(0);
    const card = JSON.parse(out).cards.find((c: { id: string }) => c.id === `c-${SLUG}`);
    const byTab: Record<string, any> = {};
    for (const b of card.blocks) byTab[b.tab ?? (b.type === 'breakdown' ? 'header' : b.path)] = b.explorer;
    return byTab;
  }

  it('the derived board holds the explorer card with every explorer block and its axis tabs', () => {
    const boards = listBoards(root);
    expect(boards.derived).toBe(true);
    const card = boards.boards.find((b) => b.slug === BOARD)!.cards.find((c) => c.id === `c-${SLUG}`)!;
    expect(card.blocks![1].tabs!.map((t) => t.labelKey)).toEqual([
      'lab.explorer.tab.daily', 'lab.explorer.tab.benchmark', 'lab.explorer.tab.ranking', 'lab.explorer.tab.flow',
      'lab.explorer.tab.steps', 'lab.explorer.tab.compare', 'lab.explorer.tab.payment', 'lab.explorer.tab.access',
      'lab.explorer.tab.dim.platform', 'lab.explorer.tab.dim.country',
    ]);
  });

  it('--select: steps with derived and not-measured marks, ranking, payment and access views, notes in reading order', async () => {
    const v = await views(['--select', 'country=TR']);
    // Header: the funnel trap first, then the set trap, then the info note.
    expect(v.header.header.notes.map((n: { code: string | null }) => n.code)).toEqual(['C1', 'R1', null]);
    expect(v.header.header.window.from).toBe('2026-09-07');
    expect(v.header.funnelId).toBe('100');
    // Steps: the path's measured steps; the funnel's unmeasured step stays unmeasured, never 0.
    const steps = v.Steps;
    expect(steps.slice.measured).toBe(true);
    expect(steps.drops.map((d: { key: string }) => d.key)).toEqual(['users', 'lead', 'subs']);
    expect(steps.drops.find((d: { worst: boolean }) => d.worst).key).toBe('subs');
    expect(steps.drops[1].basis).toBe('derived');
    // Ranking is across funnels: F100's best path on the ladder metric; F200 has no path.
    expect(v.Ranking.ranking.metric).toBe('click_to_sub');
    expect(v.Ranking.ranking.rows.map((r: { funnelId: string }) => r.funnelId)).toEqual(['100']);
    expect(v.Ranking.ranking.dropped).toEqual([{ funnelId: '200', funnelName: 'F200', why: 'no-path' }]);
    // Payment: the TR cell, 10 declines of 50 attempts (a small denominator: k/n).
    expect(v.Payment.payment.current).toMatchObject({ dims: { country: 'TR' }, attempts: 50, declines: 10, kn: { k: 10, n: 50 } });
    // Access has data here: shown, not hidden.
    expect(v.Access.hidden).toBe(false);
    expect(v.Access.access.rows.length).toBeGreaterThan(0);
  });

  it('--funnel switches the funnel the picker card draws; without it the first funnel is drawn', async () => {
    expect((await views([])).Steps.funnelId).toBe('100');
    const v = await views(['--funnel', '200']);
    expect(v.Steps.funnelId).toBe('200');
    expect(v.Steps.drops.map((d: { users: number }) => d.users)).toEqual([900, 200, 7]);
    expect(v.header.header.notes[0].code).toBe('C8');
  });

  it('the text form prints the honesty marks', async () => {
    const { code, out } = await run(['lab', 'board', 'show', BOARD]);
    expect(code, out).toBe(0);
    expect(out).toContain('Lead: 1200 (derived)');
    expect(out).toContain('Finish: Not measured: finish event not recorded');
    expect(out).toContain('← biggest drop');
    expect(out).toContain('[trap C1] no checkout event in this series');
    expect(out).toContain('ranking click_to_sub (at least 300 users');
    expect(out).toContain('decline rate 20%');
    expect(out).not.toContain('—');
  });
});
