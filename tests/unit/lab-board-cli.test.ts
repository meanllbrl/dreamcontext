import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createProgram } from '../../src/cli/program.js';
import { handleLabBoardShow } from '../../src/server/routes/lab-boards.js';
import { createInsight, writeCache } from '../../src/lib/lab/store.js';
import { boardsDir, getBoard, putBoard } from '../../src/lib/lab/boards.js';
import { BLOCK_TYPES } from '../../src/lib/lab/blocks.js';
import { frameKey } from '../../src/lib/lab/frames.js';
import { applyFrameOps, frameOpsFromOptions } from '../../src/lib/lab/frameOps.js';
import type { InsightCache } from '../../src/lib/lab/types.js';

/**
 * `lab board` / `lab block` / `lab create --board` driven through the REAL
 * command tree (createProgram), in a scratch vault the process chdirs into.
 * The load-bearing claim: `lab board show` prints the SAME resolved values
 * the dashboard draws, i.e. the board route's frames run through frameOps.
 */

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

function routeShow(slug: string): Promise<any> {
  let body: unknown = null;
  const res = {
    writeHead() {},
    end(data: string) { body = JSON.parse(data); },
    setHeader() {},
  } as unknown as ServerResponse;
  const req = Object.assign(Readable.from([]), { method: 'GET', url: `/api/lab/boards/${slug}`, headers: {} }) as unknown as IncomingMessage;
  return handleLabBoardShow(req, res, { slug }, root).then(() => body);
}

const base = (slug: string, extra: Partial<InsightCache>): InsightCache => ({
  slug, fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily', unit: null,
  series: [], latest: null, error: null, errorAt: null, scriptHash: null, ...extra,
});

beforeEach(() => {
  cwd = process.cwd();
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-lab-board-cli-')));
  root = join(projectRoot, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
  createInsight(root, { slug: 'signups', title: 'Signups', category: 'Growth' });
  createInsight(root, { slug: 'sales', title: 'Sales by country', category: 'Growth', render: 'breakdown' });
  writeCache(root, 'signups', base('signups', {
    series: [
      { name: 'web', points: [1, 2, 3, 4, 5].map((v, i) => ({ t: `2026-09-0${i + 1}`, v })) },
      { name: 'app', points: [10, 20, 30].map((v, i) => ({ t: `2026-09-0${i + 1}`, v })) },
    ],
    latest: 5,
  }));
  writeCache(root, 'sales', base('sales', {
    matrix: {
      set: {
        kind: 'matrix/v1',
        dims: [{ key: 'country' }],
        rows: [
          { d: { country: 'TR' }, v: 30 }, { d: { country: 'DE' }, v: 50 },
          { d: { country: 'US' }, v: 10 }, { d: { country: 'FR' }, v: 20 },
        ],
        total: { v: 110 },
      },
      notices: [],
      range: { fromISO: '2026-09-01', toISO: '2026-09-07' },
    },
  }));
  process.chdir(projectRoot);
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(projectRoot, { recursive: true, force: true });
});

const SPEC = {
  title: 'Growth',
  order: 1,
  cards: [
    { id: 'c-signups', at: { x: 0, y: 0, w: 4, h: 3 }, insight: 'signups', blocks: [
      { stat: { data: 'signups', delta: 'prev', spark: true } },
      { line: { data: 'signups', series: ['app'], limit: 2 } },
    ] },
    { id: 'c-sales', at: { x: 4, y: 0, w: 8, h: 6 }, insight: 'sales', blocks: [
      { bar: { data: 'sales', where: { country: ['TR', 'DE', 'US'] }, sort: '-v', limit: 2 } },
      { tabs: { tabs: [{ label: 'All', blocks: [{ table: { data: 'sales', sort: 'country' } }] }] } },
    ] },
    { id: 'c-legacy', at: { x: 0, y: 3, w: 4, h: 3 }, insight: 'signups' },
  ],
};

describe('lab board show', () => {
  it('--json prints exactly the route frames run through frameOps (the dashboard values)', async () => {
    await putBoard(root, 'growth', SPEC);
    const { code, out } = await run(['lab', 'board', 'show', 'growth', '--json']);
    expect(code).toBe(0);
    const view = JSON.parse(out);
    const route = await routeShow('growth');
    const byPath = (cardId: string) => Object.fromEntries(view.cards.find((c: any) => c.id === cardId).blocks.map((b: any) => [b.path, b]));

    const board = getBoard(root, 'growth')!;
    const expected = (cardId: string, path: number[], blockOptions: Record<string, unknown>) =>
      applyFrameOps(route.frames[frameKey(cardId, path)], frameOpsFromOptions(blockOptions));
    const card = (id: string) => board.cards.find((c) => c.id === id)!;

    expect(byPath('c-signups')['0'].frame).toEqual(expected('c-signups', [0], card('c-signups').blocks![0].options));
    expect(byPath('c-signups')['1'].frame).toEqual(expected('c-signups', [1], card('c-signups').blocks![1].options));
    expect(byPath('c-sales')['0'].frame).toEqual(expected('c-sales', [0], card('c-sales').blocks![0].options));
    expect(byPath('c-sales')['1.0.0'].frame).toEqual(expected('c-sales', [1, 0, 0], card('c-sales').blocks![1].tabs![0].blocks[0].options));

    // And those are the real numbers: filtered total before the limit, desc sort, limit 2.
    const bar = byPath('c-sales')['0'].frame;
    expect(bar.rows.map((r: any) => r.d.country)).toEqual(['DE', 'TR']);
    expect(bar.total).toMatchObject({ count: 3, v: 90 });
    expect(byPath('c-signups')['1'].frame.series).toEqual([{ name: 'app', points: [{ t: '2026-09-02', v: 20 }, { t: '2026-09-03', v: 30 }] }]);
    expect(byPath('c-signups')['0'].frame).toMatchObject({ kind: 'value', value: 5 });
    expect(byPath('c-legacy')['0']).toMatchObject({ type: 'insight', data: 'signups', insight: { latest: 5 } });
  });

  it('text output prints the same resolved values', async () => {
    await putBoard(root, 'growth', SPEC);
    const { code, out } = await run(['lab', 'board', 'show', 'growth']);
    expect(code).toBe(0);
    expect(out).toContain('c-sales');
    expect(out).toMatch(/\[0\] bar sales: 3 row\(s\), total 90/);
    // where drops FR, sort -v, limit 2: DE then TR, and nothing else under the bar block.
    expect(out).toMatch(/total 90\n\s+DE: 50\n\s+TR: 30\n\s+\[1\] tabs/);
    expect(out).toMatch(/\[1\] line signups: app: 30/);
  });

  it('a derived board shows too, and nothing is written', async () => {
    const { code, out } = await run(['lab', 'board', 'show', 'growth']);
    expect(code).toBe(0);
    expect(out).toContain('derived');
    expect(existsSync(boardsDir(root))).toBe(false);
  });
});

describe('lab board set / validate', () => {
  it('set rejects an invalid spec with the card id, the block path and the fix; the board is unchanged', async () => {
    await putBoard(root, 'growth', SPEC);
    const before = readFileSync(join(boardsDir(root), 'growth.md'), 'utf-8');
    const file = join(projectRoot, 'bad.yaml');
    writeFileSync(file, [
      'title: Growth',
      'cards:',
      '  - id: c-signups',
      '    at: {x: 0, y: 0, w: 4, h: 3}',
      '    blocks:',
      '      - line: {data: signups, color: 42}',
      '      - pie: {data: signups, wobble: true}',
    ].join('\n'));
    const { code, out } = await run(['lab', 'board', 'set', 'growth', '--file', file]);
    expect(code).not.toBe(0);
    expect(out).toContain('card "c-signups" at cards[0].blocks[0].line.color');
    expect(out).toContain('card "c-signups" at cards[0].blocks[1].pie.wobble');
    expect(out).toMatch(/Fix: set color to a whole number from 1 to 8/);
    expect(readFileSync(join(boardsDir(root), 'growth.md'), 'utf-8')).toBe(before);

    const v = await run(['lab', 'board', 'validate', '--file', file]);
    expect(v.code).not.toBe(0);
    expect(v.out).toContain('cards[0].blocks[0].line.color');
  });

  it('set writes a valid spec (materializing the derived boards) and validate says valid', async () => {
    const file = join(projectRoot, 'good.json');
    writeFileSync(file, JSON.stringify(SPEC));
    expect((await run(['lab', 'board', 'validate', '--file', file])).code).toBe(0);
    const { code } = await run(['lab', 'board', 'set', 'growth', '--file', file]);
    expect(code).toBe(0);
    expect(getBoard(root, 'growth')!.cards.map((c) => c.id)).toEqual(['c-signups', 'c-sales', 'c-legacy']);
  });
});

describe('lab board create / add-card / remove-card / delete', () => {
  it('edits go through the store: add-card finds a free slot, binds the block, remove and delete work', async () => {
    expect((await run(['lab', 'board', 'create', 'ops', '--title', 'Ops'])).code).toBe(0);
    expect(readdirSync(boardsDir(root)).sort()).toEqual(['growth.md', 'ops.md']);

    const add = await run(['lab', 'board', 'add-card', 'ops', '--insight', 'signups', '--block', '{"line": {"area": true}}']);
    expect(add.code).toBe(0);
    const again = await run(['lab', 'board', 'add-card', 'ops', '--insight', 'signups', '--at', '0,10,12,2']);
    expect(again.code).toBe(0);
    const ops = getBoard(root, 'ops')!;
    expect(ops.cards.map((c) => c.id)).toEqual(['c-signups', 'c-signups-2']);
    expect(ops.cards[0].blocks![0]).toMatchObject({ type: 'line', data: 'signups', options: { area: true } });
    expect(ops.cards[1].at).toEqual({ x: 0, y: 10, w: 12, h: 2 });

    const bad = await run(['lab', 'board', 'add-card', 'ops', '--insight', 'signups', '--at', '10,0,4,3']);
    expect(bad.code).not.toBe(0);

    expect((await run(['lab', 'board', 'remove-card', 'ops', 'c-signups'])).code).toBe(0);
    expect(getBoard(root, 'ops')!.cards.map((c) => c.id)).toEqual(['c-signups-2']);
    expect((await run(['lab', 'board', 'remove-card', 'ops', 'nope'])).code).not.toBe(0);
    expect((await run(['lab', 'board', 'delete', 'ops'])).code).toBe(0);
    expect(existsSync(join(boardsDir(root), 'ops.md'))).toBe(false);
  });

  it('lab board list shows derived boards', async () => {
    const { code, out } = await run(['lab', 'board', 'list', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ derived: true, boards: [{ slug: 'growth', cards: 2 }] });
  });
});

describe('lab block', () => {
  it('list prints the whole catalog', async () => {
    const { code, out } = await run(['lab', 'block', 'list']);
    expect(code).toBe(0);
    for (const type of BLOCK_TYPES) expect(out).toMatch(new RegExp(`^  ${type}: `, 'm'));
    const json = JSON.parse((await run(['lab', 'block', 'list', '--json'])).out);
    expect(json.catalog.map((b: any) => b.type)).toEqual([...BLOCK_TYPES]);
  });

  it('save puts HTML in the library, and a card on another board reuses it by ref with its declared input', async () => {
    const html = join(projectRoot, 'grid.html');
    writeFileSync(html, '<div class="dc-card" id="grid"></div>');
    const saved = await run(['lab', 'block', 'save', 'cohort-grid', '--file', html, '--inputs', 'cohorts:table', '--title', 'Cohort grid']);
    expect(saved.code).toBe(0);
    expect(existsSync(join(root, 'lab', 'blocks', 'cohort-grid.md'))).toBe(true);
    expect((await run(['lab', 'block', 'list'])).out).toContain('cohort-grid: Cohort grid');

    await run(['lab', 'board', 'create', 'ops', '--title', 'Ops']);
    for (const board of ['growth', 'ops']) {
      const add = await run(['lab', 'board', 'add-card', board, '--id', 'c-grid', '--block', '{"html": {"ref": "cohort-grid", "inputs": {"cohorts": "sales"}}}']);
      expect(add.code).toBe(0);
      const view = JSON.parse((await run(['lab', 'board', 'show', board, '--json'])).out);
      const block = view.cards.find((c: any) => c.id === 'c-grid').blocks[0];
      expect(Object.keys(block.inputs)).toEqual(['cohorts']);
      expect(block.inputs.cohorts).toMatchObject({ kind: 'table', insight: 'sales' });
    }
  });
});

describe('lab create --board / --no-board', () => {
  it('derived boards: no write by default; --board materializes and places it', async () => {
    expect((await run(['lab', 'create', 'churn', '--title', 'Churn', '--category', 'Growth'])).code).toBe(0);
    expect(existsSync(boardsDir(root))).toBe(false);
    expect((await run(['lab', 'create', 'arpu', '--title', 'ARPU', '--board', 'growth'])).code).toBe(0);
    expect(getBoard(root, 'growth')!.cards.map((c) => c.id)).toContain('c-arpu');
  });

  it('materialized: appends to the board titled like the category, else the first; --no-board opts out', async () => {
    await run(['lab', 'board', 'create', 'ops', '--title', 'Ops']);
    await run(['lab', 'create', 'uptime', '--title', 'Uptime', '--category', 'ops']);
    expect(getBoard(root, 'ops')!.cards.map((c) => c.id)).toEqual(['c-uptime']);
    await run(['lab', 'create', 'misc', '--title', 'Misc', '--category', 'Nowhere']);
    expect(getBoard(root, 'growth')!.cards.map((c) => c.id)).toContain('c-misc');
    await run(['lab', 'create', 'hidden', '--title', 'Hidden', '--category', 'ops', '--no-board']);
    expect(getBoard(root, 'ops')!.cards.map((c) => c.id)).toEqual(['c-uptime']);
  });
});
