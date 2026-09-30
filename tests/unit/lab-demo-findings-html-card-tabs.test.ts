/**
 * Insights v2 demo findings 1, 4 and 5 (owner, 2026-09-30).
 *
 * 1. A library html block added by ref (or rebound) said `lab.data failed: No data for input
 *    "rows"` until a reload. The server was right all along (the PUT response carries the ref
 *    input's frame, proven below through the real router); the iframe mounted from the
 *    optimistic spec BEFORE that response, asked once, and never asked again. The block now
 *    mounts its frame only once every declared input holds the frame of its CURRENT binding
 *    (`inputsCurrent`), and the frames' hash is in the frame's key (`inputsFingerprint`).
 * 4. No card inside a card: a root `dc-card` dissolves into the cell chrome (HTML_BLOCK_CELL_CSS
 *    in every block srcdoc), and an untitled card renders no header row.
 * 5. The detail panel treats the scaffold's Meaning placeholder as no meaning (`meaningText`).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import { buildRouter } from '../../src/server/index.js';
import { createInsight, writeCache } from '../../src/lib/lab/store.js';
import type { InsightCache } from '../../src/lib/lab/types.js';
import {
  buildHtmlBlockSrcdoc,
  createHtmlBlockHost,
  currentInputs,
  frameMatchesBinding,
  HTML_BLOCK_CELL_CSS,
  inputsCurrent,
  inputsFingerprint,
} from '../../dashboard/src/components/lab/blocks/htmlBlockBridge.js';
import type { Frame } from '../../dashboard/src/generated/frameOps.js';
import type { Card } from '../../dashboard/src/components/lab/board/boardTypes.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/context/ThemeContext.js', () => ({
  useTheme: () => ({ theme: 'light', resolved: 'light', setTheme: () => {} }),
  ThemeProvider: ({ children }: { children: unknown }) => children,
}));

const { BoardCard, cardDensity } = await import('../../dashboard/src/components/lab/board/BoardCard.js');
const { meaningText } = await import('../../dashboard/src/components/lab/InsightDetailPanel.js');

// ─── The real router, as in server-lab-boards-routes.test.ts ────────────────

let root: string;

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

async function call(method: string, url: string, bodyObj?: unknown) {
  const out = makeRes();
  const match = buildRouter().match(method, url);
  if (!match) throw new Error(`no route ${method} ${url}`);
  const req = Object.assign(Readable.from(bodyObj === undefined ? [] : [Buffer.from(JSON.stringify(bodyObj))]), {
    method, url, headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
  await match.handler(req, out.res, match.params, root);
  return out;
}

const tableCache = (slug: string, dim: string, rows: Array<[string, number]>): InsightCache => ({
  slug, fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily', unit: 'users',
  series: [], latest: null, error: null, errorAt: null, scriptHash: null, history: [],
  matrix: {
    set: { kind: 'matrix/v1', dims: [{ key: dim }], rows: rows.map(([k, v]) => ({ d: { [dim]: k }, v })) },
    notices: [],
    range: { fromISO: '2026-09-01', toISO: '2026-09-30' },
  },
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-lab-demo-findings-'));
  mkdirSync(join(root, 'core'), { recursive: true });
  createInsight(root, { slug: 'top-countries', title: 'Top countries', category: 'Growth' });
  createInsight(root, { slug: 'signups-by-channel', title: 'Signups by channel', category: 'Growth' });
  writeCache(root, 'top-countries', tableCache('top-countries', 'country', [['Atlantis', 12], ['Lemuria', 5]]));
  writeCache(root, 'signups-by-channel', tableCache('signups-by-channel', 'channel', [['Referral', 7]]));
});

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('finding 1: a ref html block gets its input frame in the same page load', () => {
  it('the PUT that adds (then rebinds) a library block by ref answers with the frame of its CURRENT binding', async () => {
    const lib = await call('PUT', '/api/lab/blocks/bar-list', {
      title: 'Bar list', inputs: [{ name: 'rows', kind: 'table' }], html: '<div class="dc-card"></div>', rev: null,
    });
    expect(lib.status()).toBe(200);
    const shown = (await call('GET', '/api/lab/boards/growth')).body();
    const card = (binding: string) => ({
      id: 'c-lib', at: { x: 0, y: 20, w: 6, h: 5 },
      blocks: [{ type: 'html', options: { ref: 'bar-list', inputs: { rows: binding } } }],
    });

    const added = await call('PUT', '/api/lab/boards/growth', {
      rev: shown.board.rev, spec: { ...shown.board, cards: [...shown.board.cards, card('top-countries')] },
    });
    expect(added.status()).toBe(200);
    const first: Frame = added.body().frames['c-lib:0#rows'];
    expect(first).toMatchObject({ kind: 'table', insight: 'top-countries' });
    expect(frameMatchesBinding(first, 'top-countries')).toBe(true);

    const board = added.body().board;
    const rebound = await call('PUT', '/api/lab/boards/growth', {
      rev: board.rev, spec: { ...board, cards: board.cards.map((c: Card) => (c.id === 'c-lib' ? card('signups-by-channel') : c)) },
    });
    expect(rebound.status()).toBe(200);
    const second: Frame = rebound.body().frames['c-lib:0#rows'];
    expect(second).toMatchObject({ kind: 'table', insight: 'signups-by-channel' });
    // The block would have refused the first frame for the new binding, and remounts on the second.
    expect(frameMatchesBinding(first, 'signups-by-channel')).toBe(false);
    expect(inputsFingerprint(['rows'], { rows: first })).not.toBe(inputsFingerprint(['rows'], { rows: second }));
  });
});

describe('finding 1: inputsCurrent holds the iframe until the frames match the bindings', () => {
  const table = (insight: string): Frame => ({
    kind: 'table', insight, dataset: null, label: null, dims: [], rows: [], sourceTotal: null,
    total: { v: null, prev: null, n: null } as never, unit: null,
  });

  it('no frame yet (the save is in flight) is not current', () => {
    expect(inputsCurrent(['rows'], { rows: 'top-countries' }, {})).toBe(false);
    expect(inputsCurrent(['rows'], { rows: 'top-countries' }, undefined)).toBe(false);
  });

  it('the previous binding\'s frame is not current; the new binding\'s is', () => {
    expect(inputsCurrent(['rows'], { rows: 'signups-by-channel' }, { rows: table('top-countries') })).toBe(false);
    expect(inputsCurrent(['rows'], { rows: 'signups-by-channel' }, { rows: table('signups-by-channel') })).toBe(true);
    expect(inputsCurrent(['rows'], { rows: ' top-countries/by-country' }, { rows: table('top-countries') })).toBe(true);
  });

  it('an empty frame matches the binding it was resolved for, an unbound input its null ref', () => {
    const missing: Frame = { kind: 'empty', reason: 'missing-insight', ref: 'gone' };
    expect(inputsCurrent(['rows'], { rows: 'gone' }, { rows: missing })).toBe(true);
    expect(inputsCurrent(['rows'], { rows: 'other' }, { rows: missing })).toBe(false);
    const unbound: Frame = { kind: 'empty', reason: 'unsafe-ref', ref: null };
    expect(inputsCurrent(['rows'], null, { rows: unbound })).toBe(true);
    expect(inputsCurrent(['rows'], null, { rows: table('top-countries') })).toBe(false);
  });

  it('nothing declared is always current', () => {
    expect(inputsCurrent([], null, undefined)).toBe(true);
  });

  it('the fingerprint follows the declared frames only', () => {
    const a = { rows: table('top-countries') };
    expect(inputsFingerprint(['rows'], a)).toBe(inputsFingerprint(['rows'], { ...a, other: table('x') }));
    expect(inputsFingerprint(['rows'], a)).not.toBe(inputsFingerprint(['rows'], {}));
  });
});

describe('finding 4: no card inside a card, no empty title row', () => {
  it('every block srcdoc dissolves a lone root dc-card into the cell chrome', () => {
    const doc = buildHtmlBlockSrcdoc({ html: '<div class="dc-card">x</div>', tokens: {}, scheme: 'light', nonce: 'n', inputs: [] });
    expect(doc).toContain(HTML_BLOCK_CELL_CSS);
    expect(HTML_BLOCK_CELL_CSS).toMatch(/body:not\(:has\(> \.dc-card ~ \.dc-card\)\) > \.dc-card/);
    expect(HTML_BLOCK_CELL_CSS).toMatch(/border: 0/);
    expect(HTML_BLOCK_CELL_CSS).toMatch(/padding: 0/);
  });

  const renderCard = (card: Card) => renderToStaticMarkup(createElement(BoardCard, {
    card, frames: {}, summaries: {}, renderBlock: () => createElement('p', null, 'block'),
    menu: createElement('button', { type: 'button', className: 'board-card-menu' }, 'menu'),
  }));

  it('an untitled card renders no header row; its menu floats', () => {
    const out = renderCard({ id: 'c-html', at: { x: 0, y: 0, w: 6, h: 5 }, blocks: [{ type: 'html', options: { html: '<p>x</p>' } }] });
    expect(out).not.toContain('board-card-head');
    expect(out).toContain('board-card--untitled');
    expect(out).toMatch(/board-card-float-menu[^>]*><button/);
  });

  it('a titled card keeps its header row with the menu in it', () => {
    const out = renderCard({ id: 'c-t', title: 'Channels', at: { x: 0, y: 0, w: 6, h: 5 }, blocks: [{ type: 'html', options: { html: '<p>x</p>' } }] });
    expect(out).toContain('board-card-head');
    expect(out).not.toContain('board-card-float-menu');
    expect(out).not.toContain('board-card--untitled');
  });
});

describe('finding 5: the scaffold placeholder is not a meaning', () => {
  it('the placeholder, alone or re-wrapped, reads as no meaning', () => {
    expect(meaningText('## Meaning\n\n(What does this number MEAN? Why does it matter, and how should a reader interpret a move?)\n')).toBe('');
    expect(meaningText('(What does this number MEAN?\nWhy does it matter, and how should a reader interpret a move?)')).toBe('');
    expect(meaningText('')).toBe('');
    expect(meaningText(null)).toBe('');
  });

  it('real prose survives, heading stripped', () => {
    expect(meaningText('## Meaning\n\nDaily active users across the fictional Atlantis apps.')).toBe('Daily active users across the fictional Atlantis apps.');
  });
});

describe('short cards: the freshness line never eats the plot', () => {
  const summary = {
    slug: 'dau', title: 'Daily active users', fetchedAt: new Date(Date.now() - 120_000).toISOString(),
    stale: false, error: null,
  } as never;
  const at = (h: number) => renderToStaticMarkup(createElement(BoardCard, {
    card: { id: 'c-dau', insight: 'dau', at: { x: 0, y: 0, w: 9, h }, blocks: [{ type: 'line', data: 'dau', options: {} }] },
    frames: {}, summaries: { dau: summary }, renderBlock: () => createElement('p', null, 'block'),
  }));

  it('density by rows: 2 or fewer short, 3-4 compact, else full', () => {
    expect([1, 2, 3, 4, 5, 8].map((h) => cardDensity(h))).toEqual(['short', 'short', 'compact', 'compact', 'full', 'full']);
    expect(cardDensity(undefined)).toBe('full');
  });

  it('a 2-row card folds the freshness into the title tooltip and keeps the hook in the DOM', () => {
    const out = at(2);
    expect(out).toContain('board-card--short');
    expect(out).toMatch(/class="board-card-fresh [^"]*board-card-fresh--short"[^>]*data-lab-freshness/);
    expect(out).toMatch(/<h3 class="board-card-title" title="Daily active users\nlab\.board\.fresh\.fresh">/);
  });

  it('a 4-row card sets the freshness beside the title; a tall card under it', () => {
    const compact = at(4);
    expect(compact).toMatch(/board-card-head-row"><h3[^>]*>Daily active users<\/h3><p class="board-card-fresh [^"]*board-card-fresh--compact"/);
    const full = at(6);
    expect(full).not.toContain('board-card-fresh--compact');
    expect(full).toMatch(/<\/div><p class="board-card-fresh board-card-fresh--fresh" data-lab-freshness/);
  });
});

describe('finding 1: a give-up never hands the iframe the previous binding\'s data', () => {
  const old: Frame = {
    kind: 'table', insight: 'top-countries', dataset: null, label: null, dims: [], rows: [{ d: { country: 'Atlantis' }, v: 12 }],
    sourceTotal: null, total: { v: 12, prev: null, n: null } as never, unit: null,
  };

  it('currentInputs drops a stale frame and keeps a current one', () => {
    expect(currentInputs(['rows'], { rows: 'signups-by-channel' }, { rows: old })).toEqual({});
    expect(currentInputs(['rows'], { rows: 'top-countries' }, { rows: old })).toEqual({ rows: old });
    // Only declared names, never an extra one the map happens to hold.
    expect(currentInputs(['rows'], { rows: 'top-countries' }, { rows: old, other: old })).toEqual({ rows: old });
  });

  it('rebind whose save never landed, then give-up: lab.data answers an error, no old data', () => {
    const sent: any[] = [];
    const win = { postMessage(m: unknown) { sent.push(m); } };
    const declared = ['rows'];
    const bindings = { rows: 'signups-by-channel' };
    const stale = { rows: old };
    expect(inputsCurrent(declared, bindings, stale)).toBe(false);
    // What HtmlBlockBody hands HtmlBlockFrame after INPUT_WAIT_MS.
    const handed = currentInputs(declared, bindings, stale);
    const host = createHtmlBlockHost({
      nonce: 'n1', getFrameWindow: () => win, getDeclared: () => declared, getInputs: () => handed, onStop: () => {},
    });
    const outcome = host.handleMessage({ source: win, data: { __dreamLabApp: 1, v: 1, nonce: 'n1', type: 'data', requestId: 'r1', name: 'rows' } });
    expect(outcome).toBe('refused');
    expect(sent[0]).toMatchObject({ type: 'dataResult', requestId: 'r1', ok: false, error: 'No data for input "rows".' });
    expect(sent[0].frame).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain('Atlantis');
  });

  it('HtmlBlockBody hands the frame currentInputs, not the raw map (source pin)', () => {
    const src = readFileSync(join(import.meta.dirname, '../../dashboard/src/components/lab/blocks/HtmlBlock.tsx'), 'utf-8');
    expect(src).toMatch(/const inputs = useMemo\(\(\) => currentInputs\(frame\.declared, bindings, frame\.inputs\)/);
    expect(src).toMatch(/<HtmlBlockFrame key=\{inputsFingerprint\(frame\.declared, inputs\)\} \{\.\.\.frame\} inputs=\{inputs\} \/>/);
  });
});
