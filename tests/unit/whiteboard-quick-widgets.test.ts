import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  placeQuickWidgets, prepareQuickWidgets, projectFileInside, QuickWidgetRefusal, QUICK_HTML_MAX, readQuickWidget,
} from '../../src/lib/whiteboards/quick-widgets.js';
import { answerDeclines, applyQuickEdit, readAnswer, undoQuickEdit, QuickEditRefusal, type QuickJournalRecord } from '../../src/lib/whiteboards/quick-edit.js';
import { catalogText, readQuickCatalog, resolveByTitle } from '../../src/lib/whiteboards/quick-catalog.js';
import { widgetPayloadFor } from '../../src/lib/whiteboards/widget-add.js';
import { identityKey } from '../../src/lib/whiteboards/store.js';
import { elementBBox } from '../../src/lib/whiteboards/ops.js';
import type { WhiteboardElement } from '../../src/lib/whiteboards/widgets.js';

let project: string;
let root: string;
let outside: string;
beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-qw-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-qw-out-')));
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'lab', 'insights'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'lab', 'insights', 'mrr.md'), '---\ntitle: MRR\nrender: app\nsource:\n  adapter: script\n  script:\n    file: scripts/x.mjs\n---\n');
  writeFileSync(join(root, 'state', 'fix-login.md'), '---\nname: Fix the login\nstatus: in_progress\nupdated_at: 2026-11-12\n---\n');
  mkdirSync(join(project, 'docs'));
  writeFileSync(join(project, 'docs', 'plan.html'), '<p>plan</p>');
  writeFileSync(join(outside, 'secret.html'), 'TOKEN=1');
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const rect = (id: string, x = 0, y = 0): WhiteboardElement => ({ id, type: 'rectangle', x, y, width: 100, height: 60, version: 1, versionNonce: 5, index: `a${id}`, isDeleted: false, groupIds: [] } as WhiteboardElement);
const refusalOf = (fn: () => unknown) => { try { fn(); } catch (e) { return e as QuickWidgetRefusal; } throw new Error('not refused'); };

describe('quick edit widgets: the answer', () => {
  it('reads a widgets entry and refuses an unknown key or kind', () => {
    expect(readAnswer({ reply: 'x', notBoard: false, widgets: [{ kind: 'insight', ref: 'mrr' }] })?.widgets).toEqual([{ kind: 'insight', ref: 'mrr' }]);
    expect(readAnswer({ reply: 'x', notBoard: false, widgets: [{ kind: 'insight', ref: 'mrr', at: [0, 0] }] })).toBeNull();
    expect(readQuickWidget({ kind: 'image', url: 'x' })).toBeNull();
    expect(readAnswer({ reply: 'x', notBoard: false, widgets: Array(5).fill({ kind: 'note' }) })).toBeNull();
  });

  it('an answer asking for no change declines (its reply is the reason); any one change does not', () => {
    expect(answerDeclines({ reply: 'Proje dışı dosya konamaz.', notBoard: false })).toBe(true);
    expect(answerDeclines({ reply: 'x', notBoard: false, add: [], widgets: [] })).toBe(true);
    for (const over of [{ widgets: [{ kind: 'note' as const }] }, { pictures: [1] }, { scale: 1.2 }, { move: [1, 1] as [number, number] }, { remove: ['a'] }, { update: [{ id: 'a', fill: 'red' }] }, { add: [{ at: [0, 0] as [number, number], spec: { elements: [] } }] }]) {
      expect(answerDeclines({ reply: 'x', notBoard: false, ...over })).toBe(false);
    }
  });
});

describe('quick edit widgets: names resolved against the vault', () => {
  it('a known insight and task pass; an unknown one is refused by name, never guessed', () => {
    const ok = prepareQuickWidgets(root, [{ kind: 'insight', ref: 'mrr' }, { kind: 'task', ref: 'fix-login' }]);
    expect(ok.map((p) => p.payload.ref)).toEqual(['mrr', 'fix-login']);
    const r = refusalOf(() => prepareQuickWidgets(root, [{ kind: 'insight', ref: 'mrr' }, { kind: 'insight', ref: 'arr' }]));
    expect(r).toBeInstanceOf(QuickWidgetRefusal);
    expect([r.kind, r.why, r.name]).toEqual(['insight', 'not_found', 'arr']);
    expect(refusalOf(() => prepareQuickWidgets(root, [{ kind: 'task', ref: 'no-such-task' }])).why).toBe('not_found');
  });

  it('review r1: a name the catalog may have cut resolves by its exact title across the vault; two with that title, or a near one, are refused', () => {
    expect(prepareQuickWidgets(root, [{ kind: 'task', ref: 'fix  the LOGIN' }])[0].payload.ref).toBe('fix-login');
    expect(prepareQuickWidgets(root, [{ kind: 'insight', ref: 'mrr' }])[0].payload.ref).toBe('mrr');
    writeFileSync(join(root, 'state', 'odeme.md'), '---\nname: Ödeme sayfası\nstatus: todo\n---\n');
    expect(resolveByTitle(root, 'task', 'ÖDEME SAYFASI')).toBe('odeme');
    // A page asked by its title (capitals, a space, Turkish letters) is a title, never a file path (review r2).
    mkdirSync(join(root, 'knowledge'), { recursive: true });
    writeFileSync(join(root, 'knowledge', 'odeme-sayfasi.md'), '---\nname: Ödeme Sayfası\ndescription: x\n---\nbody\n');
    expect(prepareQuickWidgets(root, [{ kind: 'knowledge', ref: 'ödeme sayfası' }])[0].payload.ref).toBe('odeme-sayfasi');
    // A title past the catalog's 80 characters, named in full.
    const long = 'Uzun başlık '.repeat(10).trim();
    writeFileSync(join(root, 'state', 'uzun.md'), `---\nname: ${long}\nstatus: todo\n---\n`);
    expect(resolveByTitle(root, 'task', long)).toBe('uzun');
    expect(refusalOf(() => prepareQuickWidgets(root, [{ kind: 'task', ref: 'Fix login' }])).why).toBe('not_found');
    writeFileSync(join(root, 'state', 'fix-login-2.md'), '---\nname: Fix the login\nstatus: todo\n---\n');
    expect(resolveByTitle(root, 'task', 'Fix the login')).toBeNull();
    expect(refusalOf(() => prepareQuickWidgets(root, [{ kind: 'task', ref: 'Fix the login' }])).why).toBe('not_found');
  });

  it('a web card: https and project files only; localhost, absolute, outside and symlinked paths are refused', () => {
    expect(prepareQuickWidgets(root, [{ kind: 'web', url: 'https://example.com' }])[0].payload.url).toBe('https://example.com/');
    expect(prepareQuickWidgets(root, [{ kind: 'web', url: 'docs/plan.html' }])[0].payload.url).toBe('docs/plan.html');
    symlinkSync(join(outside, 'secret.html'), join(project, 'docs', 'link.html'));
    symlinkSync(outside, join(project, 'out'));
    for (const url of ['http://localhost:5173', 'http://127.0.0.1/a.html', 'https://localhost:5173', 'https://127.0.0.1/a', 'https://[::1]/', 'https://app.localhost/', `${outside}/secret.html`, `file://${outside}/secret.html`,
      '../secret.html', 'docs/../../secret.html', 'docs/link.html', 'out/secret.html', 'docs/missing.html', 'javascript:alert(1)']) {
      expect(refusalOf(() => prepareQuickWidgets(root, [{ kind: 'web', url }])).why, url).toBe('web');
    }
  });

  it('a page may be a project file, never one outside it', () => {
    expect(prepareQuickWidgets(root, [{ kind: 'knowledge', ref: 'docs/plan.html' }])[0].payload.ref).toBe('docs/plan.html');
    symlinkSync(join(outside, 'secret.html'), join(project, 'docs', 'link.html'));
    expect(refusalOf(() => prepareQuickWidgets(root, [{ kind: 'knowledge', ref: 'docs/link.html' }])).why).toBe('not_found');
    expect(projectFileInside(root, 'docs/link.html')).toBe(false);
    expect(projectFileInside(root, 'docs/plan.html')).toBe(true);
  });

  it('every text is bounded: an html card past its cap is refused as too long', () => {
    expect(prepareQuickWidgets(root, [{ kind: 'html', title: 'Hafta', text: '<b>ok</b>' }])[0].payload.html).toBe('<b>ok</b>');
    expect(refusalOf(() => prepareQuickWidgets(root, [{ kind: 'html', text: 'x'.repeat(QUICK_HTML_MAX + 1) }])).why).toBe('too_long');
    expect(refusalOf(() => prepareQuickWidgets(root, [{ kind: 'note', text: 'x'.repeat(4001) }])).why).toBe('too_long');
    expect(refusalOf(() => prepareQuickWidgets(root, [{ kind: 'todo', items: Array(31).fill('a') }])).why).toBe('too_long');
    expect(refusalOf(() => prepareQuickWidgets(root, [{ kind: 'wiki' }])).why).toBe('bad');
  });

  it('the payload is the one `whiteboard add` builds (one engine)', () => {
    const quick = prepareQuickWidgets(root, [{ kind: 'todo', title: 'Bugün', items: ['a', 'b'] }])[0].payload;
    const cli = widgetPayloadFor(root, 'todo', { title: 'Bugün', items: ['a', 'b'] });
    expect({ ...quick, items: quick.items!.map((i) => i.text) }).toEqual({ ...cli, items: cli.items!.map((i) => i.text) });
  });
});

describe('quick edit widgets: placement and undo', () => {
  it('lands inside the area at natural size, beside what is there, never on top of it', () => {
    const els = [rect('A', 0, 0)];
    const prepared = prepareQuickWidgets(root, [{ kind: 'insight', ref: 'mrr' }, { kind: 'note', text: 'hi' }]);
    const { elements, grew } = placeQuickWidgets(prepared, els, { area: { x: 500, y: 300, w: 800, h: 400 }, focus: null }, 1);
    expect(grew).toBe(false);
    expect(elements.map((e) => [e.x, e.y, e.width, e.height])).toEqual([[500, 300, 376, 180], [892, 300, 376, 180]]);
    // An area over a shape: the group moves right of everything.
    const over = placeQuickWidgets(prepared, els, { area: { x: 0, y: 0, w: 800, h: 400 }, focus: null }, 1).elements;
    for (const e of over) expect(elementBBox(e).x).toBeGreaterThanOrEqual(100);
  });

  it('Geri al removes an added widget', () => {
    const els = [rect('A')];
    const answer = { reply: 'ok', notBoard: false, widgets: [{ kind: 'insight' as const, ref: 'mrr' }] };
    const widgets = prepareQuickWidgets(root, answer.widgets);
    const o = applyQuickEdit({ elements: els }, answer, { scope: [], identities: {}, area: null, widgets });
    expect(o.added).toHaveLength(1);
    const after = Object.fromEntries(o.added.map((id) => [id, identityKey(els.find((e) => e.id === id)!)]));
    const rec: QuickJournalRecord = { id: 'rec-0000000000000001', at: '', text: '', reply: '', added: o.added, changed: [], before: {}, after, costUsd: null, model: 'sonnet', undone: false };
    undoQuickEdit({ elements: els }, rec);
    expect(els.find((e) => e.id === o.added[0])!.isDeleted).toBe(true);
  });

  it('an answer with widgets the server did not prepare is refused (no second way in)', () => {
    expect(() => applyQuickEdit({ elements: [rect('A')] }, { reply: '', notBoard: false, widgets: [{ kind: 'insight', ref: 'mrr' }] }, { scope: [], identities: {}, area: null }))
      .toThrow(QuickEditRefusal);
  });
});

describe('quick edit widgets: the catalog', () => {
  it('lists the vault, bounded in size', () => {
    const cat = readQuickCatalog(root);
    expect(cat.insights).toEqual([['mrr', 'MRR']]);
    expect(cat.tasks[0].slice(0, 2)).toEqual(['fix-login', 'Fix the login']);
    const big = { ...cat, tasks: Array.from({ length: 2000 }, (_, i) => [`t-${i}`, 'x'.repeat(60)] as [string, string]) };
    const text = catalogText(big, 16_000);
    expect(text.length).toBeLessThanOrEqual(16_000);
    expect(JSON.parse(text).insights).toEqual([['mrr', 'MRR']]);
  });

  it('review r1: a cut list says so (shown, total) and the budget stays filled', () => {
    const cat = readQuickCatalog(root);
    const big = { ...cat, tasks: Array.from({ length: 2000 }, (_, i) => [`t-${i}`, 'x'.repeat(60)] as [string, string]) };
    const text = catalogText(big, 16_000);
    const out = JSON.parse(text);
    expect(out.cut.tasks).toEqual([out.tasks.length, 2000]);
    expect(out.tasks[0][0]).toBe('t-0');
    expect(text.length).toBeGreaterThan(15_000);
    expect(JSON.parse(catalogText(cat)).cut).toBeUndefined();
  });
});
