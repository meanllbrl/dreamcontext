import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyQuickEdit, expandScope, fitInto, LOSING_NONCE, parseQuickEditAnswer, QUICK_INPUT_CAP, quickEditArgs,
  quickEditInput, quickEditSystemPrompt, quickEditUserMessage, QuickEditRefusal, readAnswer, readJournal, writeJournal,
  buildAdds, scopeTextLimit, specProblem,
  type QuickEditAnswer, type QuickJournalRecord,
} from '../../src/lib/whiteboards/quick-edit.js';
import { createWhiteboard, identityKey, mutateWhiteboard, quickJournalPath, readWhiteboard, trashWhiteboard } from '../../src/lib/whiteboards/store.js';
import { mergeElements } from '../../src/lib/whiteboards/merge.js';
import { elementBBox, unionBBox } from '../../src/lib/whiteboards/ops.js';
import type { WhiteboardElement } from '../../src/lib/whiteboards/widgets.js';
import { untouchedIdentity } from '../../src/lib/whiteboards/quick-edit-jobs.js';
import { buildSpecDrawingBounded } from '../../src/lib/whiteboards/spec-draw.js';

let root: string;
beforeEach(() => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-quick-')));
  root = join(project, '_dream_context');
  mkdirSync(root);
});
afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }));

function rect(id: string, x = 0, y = 0, extra: Partial<WhiteboardElement> = {}): WhiteboardElement {
  return { id, type: 'rectangle', x, y, width: 100, height: 60, angle: 0, version: 3, versionNonce: 500, index: `a${id}`, isDeleted: false, groupIds: [], boundElements: null, strokeColor: '#1e1e1e', backgroundColor: '#d0bfff', fillStyle: 'solid', ...extra } as WhiteboardElement;
}
function label(id: string, container: string, text: string): WhiteboardElement {
  return { id, type: 'text', x: 10, y: 20, width: 80, height: 25, angle: 0, version: 2, versionNonce: 400, index: `b${id}`, isDeleted: false, groupIds: [], boundElements: null, text, originalText: text, fontSize: 20, fontFamily: 6, lineHeight: 1.25, containerId: container, strokeColor: '#1e1e1e' } as WhiteboardElement;
}
function labelled(id: string, text: string, x = 0): WhiteboardElement[] {
  return [rect(id, x, 0, { boundElements: [{ id: `${id}-t`, type: 'text' }] }), label(`${id}-t`, id, text)];
}
const ids = (els: WhiteboardElement[], scope: string[]) => Object.fromEntries(scope.map((id) => [id, identityKey(els.find((e) => e.id === id)!)]));
const envelope = (o: Record<string, unknown>) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: 0.004, ...o });

describe('quick edit: the answer (C2)', () => {
  it('reads structured_output first, else a fenced result; unknown shape is null', () => {
    const a = { reply: 'Tamam.', notBoard: false, scale: 1.25 };
    const p = parseQuickEditAnswer(envelope({ structured_output: a }));
    expect(p.ok && p.answer.scale).toBe(1.25);
    expect(p.costUsd).toBe(0.004);
    const f = parseQuickEditAnswer(envelope({ result: '```json\n{"reply":"x","notBoard":true}\n```' }));
    expect(f.ok && f.answer.notBoard).toBe(true);
    expect(parseQuickEditAnswer(envelope({ structured_output: { reply: 'x', notBoard: false, explode: 1 } })).ok).toBe(false);
    expect(parseQuickEditAnswer(envelope({ structured_output: { reply: 'x', notBoard: false, scale: 9 } })).ok).toBe(false);
    expect(parseQuickEditAnswer('not json').ok).toBe(false);
    expect(readAnswer({ reply: 1, notBoard: false })).toBeNull();
    expect(readAnswer({ reply: 'x', notBoard: false, update: [{ id: 'bad id!' }] })).toBeNull();
  });

  it('a usage-limit banner has its own reason', () => {
    const p = parseQuickEditAnswer(envelope({ is_error: true, result: "Session limit reached ∙ resets 5pm" }));
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe('limit');
  });

  it('the child argv is the C5 envelope: sonnet, medium, no tools, no settings, a schema', () => {
    const args = quickEditArgs('SYS', 'Request from the owner: x');
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at('--model')).toBe('sonnet');
    expect(at('--effort')).toBe('medium');
    expect(at('--tools')).toBe('');
    expect(at('--setting-sources')).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('--no-session-persistence');
    expect(at('--system-prompt')).toBe('SYS');
    expect(JSON.parse(at('--json-schema')).required).toEqual(['reply', 'notBoard']);
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('--permission-mode');
    expect(at('-p').startsWith('-')).toBe(false);
  });

  it('the system prompt carries the rules and the primitive fields, stable across calls', () => {
    const a = quickEditSystemPrompt('KIT');
    expect(a).toBe(quickEditSystemPrompt('KIT'));
    expect(a).toContain('Without a selection you may only ADD');
    for (const f of ['width', 'height', 'strokeColor', 'backgroundColor', 'points']) expect(a).toContain(f);
  });

  it('the real prompt carries every screen type with its fields, and no pointer to a file it cannot read', () => {
    const a = quickEditSystemPrompt();
    const types = ['device', 'windowFrame', 'appBar', 'tabBar', 'listRow', 'searchField', 'segmented', 'input', 'button', 'textRows', 'imagePlaceholder', 'navbar'];
    for (const t of types) expect(a, t).toContain(`| \`${t}\` |`);
    for (const f of ['items', 'kind', 'leading', 'trailing', 'subtitle', 'active', 'placeholder', 'iphone']) expect(a, f).toContain(f);
    expect(a).toContain('"type": "device"');
    expect(a).toContain('"type": "windowFrame"');
    expect(a).toContain('skill-draw/references/excalidraw.md');
    expect(a).toContain('name: draw');
    expect(a).toContain('it is just words');
  });

  it('the request sits outside the nonce fence', () => {
    const m = quickEditUserMessage('elma ekle', '{"scope":[]}', 'abc123');
    expect(m.indexOf('elma ekle')).toBeLessThan(m.indexOf('<board-data-abc123>'));
    expect(m).toContain('</board-data-abc123>');
  });
});

describe('quick edit: scope and input (C3, C5)', () => {
  it('expands a container to its bound text and a group member to its whole group', () => {
    const g = (id: string) => rect(id, 0, 0, { groupIds: ['inner', 'G'] });
    const els = [...labelled('A', 'Seçenek D'), g('g1'), g('g2'), rect('lone')];
    expect(expandScope(els, ['A']).sort()).toEqual(['A', 'A-t']);
    expect(expandScope(els, ['A-t']).sort()).toEqual(['A', 'A-t']);
    expect(expandScope(els, ['g1']).sort()).toEqual(['g1', 'g2']);
    expect(expandScope(els, [])).toEqual([]);
  });

  it('carries ids and geometry for every scope element and stays under its cap with 150', () => {
    const els: WhiteboardElement[] = [];
    for (let i = 0; i < 150; i++) els.push(rect(`s${i}`, i * 10, 0, { text: 'x'.repeat(5000) }));
    for (let i = 0; i < 400; i++) els.push({ ...label(`n${i}`, 'none', 'y'.repeat(300)), containerId: null } as WhiteboardElement);
    const scope = els.slice(0, 150).map((e) => e.id);
    const out = quickEditInput(els, scope, { x: 0, y: 0, w: 100, h: 100 });
    expect(out.length).toBeLessThanOrEqual(QUICK_INPUT_CAP);
    const doc = JSON.parse(out);
    expect(doc.scope).toHaveLength(150);
    expect(doc.scope[3]).toMatchObject({ id: 's3', type: 'rectangle', x: 30, y: 0, w: 100, h: 60 });
    expect(doc.area).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });
});

describe('quick edit: apply (C3)', () => {
  it('renames a labelled shape through its container and recolors it; written elements lose ties', () => {
    const els = [...labelled('A', 'Seçenek D')];
    const scope = expandScope(els, ['A']);
    const ans: QuickEditAnswer = { reply: 'Tamam.', notBoard: false, update: [{ id: 'A', text: 'Seçenek E', fill: 'green' }] };
    const o = applyQuickEdit({ elements: els }, ans, { scope, identities: ids(els, scope), area: null, now: 1 });
    expect(o.outOfScope).toBe(false);
    expect(o.changed.sort()).toEqual(['A', 'A-t']);
    const t = els.find((e) => e.id === 'A-t')!;
    expect(t.originalText).toBe('Seçenek E');
    expect(t.version).toBe(3);
    expect(t.versionNonce).toBe(LOSING_NONCE);
    expect(els.find((e) => e.id === 'A')!.backgroundColor).toBe('#b2f2bb');
    expect(o.before.A.backgroundColor).toBe('#d0bfff');
  });

  it('scale grows a whole group with a line and a label about its top-left', () => {
    const line = { ...rect('L', 100, 0), type: 'line', width: 100, height: 0, points: [[0, 0], [100, 0]], groupIds: ['G'] } as WhiteboardElement;
    const els = [...labelled('A', 'x').map((e) => ({ ...e, groupIds: ['G'] })), line];
    const scope = expandScope(els, ['A']);
    expect(scope.sort()).toEqual(['A', 'A-t', 'L']);
    const before = unionBBox(els.map(elementBBox))!;
    applyQuickEdit({ elements: els }, { reply: '', notBoard: false, scale: 2 }, { scope, identities: ids(els, scope), area: null });
    const after = unionBBox(els.map(elementBBox))!;
    expect(after.x).toBe(before.x);
    expect(after.w).toBeCloseTo(before.w * 2);
    expect((els.find((e) => e.id === 'L')!.points as number[][])[1][0]).toBe(200);
    expect(els.find((e) => e.id === 'A-t')!.fontSize).toBe(40);
  });

  it('an update or remove outside the scope writes nothing and answers outOfScope', () => {
    const els = [...labelled('A', 'x'), rect('B', 300)];
    const snapshot = JSON.stringify(els);
    const o = applyQuickEdit({ elements: els }, { reply: 'Önce B şeklini seç.', notBoard: false, update: [{ id: 'B', fill: 'red' }] }, { scope: [], identities: {}, area: null });
    expect(o.outOfScope).toBe(true);
    expect(JSON.stringify(els)).toBe(snapshot);
    const o2 = applyQuickEdit({ elements: els }, { reply: '', notBoard: false, remove: ['B'] }, { scope: ['A'], identities: ids(els, ['A']), area: null });
    expect(o2.outOfScope).toBe(true);
    expect(JSON.stringify(els)).toBe(snapshot);
  });

  it('skips a scope element the owner changed since the page looked (by identity)', () => {
    const els = [rect('A'), rect('B', 200)];
    const seen = ids(els, ['A', 'B']);
    els[1] = { ...els[1], version: 4, versionNonce: 9, backgroundColor: '#000000' };
    const o = applyQuickEdit({ elements: els }, { reply: '', notBoard: false, move: [10, 0] }, { scope: ['A', 'B'], identities: seen, area: null });
    expect(o.skipped).toEqual(['B']);
    expect(els[1].x).toBe(200);
    expect(els[0].x).toBe(10);
  });

  it('refuses a picture, a link, a widget payload, a path and an over-cap drawing', async () => {
    const fake = (els: Partial<WhiteboardElement>[]) => async () => ({ elements: els.map((e, i) => ({ ...rect(`z${i}`), ...e }) as WhiteboardElement) });
    const add = (build: ReturnType<typeof fake>, spec: unknown = { elements: [{ type: 'rectangle' }] }) =>
      buildAdds({ reply: '', notBoard: false, add: [{ at: [0, 0], spec: spec as { elements: unknown[] } }] }, { build: build as never });
    await expect(add(fake([{ type: 'image' }]))).rejects.toThrow(QuickEditRefusal);
    await expect(add(fake([{ link: 'https://x.test' }]))).rejects.toThrow(QuickEditRefusal);
    await expect(add(fake([{ customData: { dc: { kind: 'note' } } }]))).rejects.toThrow(QuickEditRefusal);
    await expect(add(fake([{}]), { elements: [{ type: 'row', items: [{ type: 'image', path: '/etc/passwd' }] }] })).rejects.toThrow(QuickEditRefusal);
    await expect(add(fake(Array.from({ length: 301 }, () => ({}))))).rejects.toThrow(QuickEditRefusal);
    // The real builder: a picture path is refused before it is read.
    await expect(buildAdds({ reply: '', notBoard: false, add: [{ at: [0, 0], spec: { elements: [{ type: 'image', path: '/etc/hosts', width: 10 }] } }] })).rejects.toThrow(QuickEditRefusal);
    // The apply never builds: adds without their built elements are refused.
    expect(() => applyQuickEdit({ elements: [rect('A')] }, { reply: '', notBoard: false, add: [{ at: [0, 0], spec: { elements: [{ type: 'ellipse' }] } }] }, { scope: [], identities: {}, area: null })).toThrow(QuickEditRefusal);
  });

  it('an add with a region lands wholly inside it, even an oversized drawing at an off spot (criterion 19)', async () => {
    const els = [rect('A')];
    const area = { x: 1000, y: 500, w: 210, h: 190 };
    const apple: QuickEditAnswer = {
      reply: 'Elma eklendi.', notBoard: false,
      add: [{ at: [5000, -3000], spec: { elements: [{ type: 'ellipse', width: 600, height: 500, backgroundColor: '#ff6b6b' }, { type: 'rectangle', x: 280, y: -60, width: 40, height: 80 }] } }],
    };
    const o = applyQuickEdit({ elements: els }, apple, { scope: [], identities: {}, area, built: await buildAdds(apple) });
    expect(o.added.length).toBe(2);
    const box = unionBBox(els.filter((e) => o.added.includes(e.id)).map(elementBBox))!;
    expect(box.x).toBeGreaterThanOrEqual(area.x - 0.001);
    expect(box.y).toBeGreaterThanOrEqual(area.y - 0.001);
    expect(box.x + box.w).toBeLessThanOrEqual(area.x + area.w + 0.001);
    expect(box.y + box.h).toBeLessThanOrEqual(area.y + area.h + 0.001);
    // Fresh ids above the board's indices: a repeated add never collides.
    const small: QuickEditAnswer = { reply: '', notBoard: false, add: [{ at: [0, 0], spec: { elements: [{ type: 'ellipse', width: 50, height: 50 }] } }] };
    const again = applyQuickEdit({ elements: els }, small, { scope: [], identities: {}, area: null, built: await buildAdds(small) });
    expect(new Set(els.map((e) => e.id)).size).toBe(els.length);
    expect(again.added).toHaveLength(1);
  });

  it('fitInto keeps a small drawing where it is when it already fits', () => {
    const els = [rect('A', 1010, 510, { width: 50, height: 40 })];
    fitInto(els, { x: 1000, y: 500, w: 200, h: 200 });
    expect([els[0].x, els[0].y]).toEqual([1010, 510]);
  });
});

describe('quick edit: the losing nonce (mutation-tested)', () => {
  it('an owner save that ties the agent version wins the merge', () => {
    const els = [rect('A')];
    applyQuickEdit({ elements: els }, { reply: '', notBoard: false, move: [5, 0] }, { scope: ['A'], identities: ids([rect('A')], ['A']), area: null });
    const agent = els[0];
    const owner = { ...rect('A'), version: agent.version, versionNonce: 123456, x: 999 };
    expect(mergeElements([agent], [owner]).elements[0].x).toBe(999);
    // The tie exactly at 2^31-1: same identity, the disk copy stays (no flip-flop).
    const twin = { ...owner, versionNonce: LOSING_NONCE };
    expect(mergeElements([agent], [twin]).elements[0].x).toBe(agent.x);
  });

  it('MUTATION: with a random nonce the same owner save would lose', () => {
    const agent = { ...rect('A'), version: 4, versionNonce: 7, x: 5 };
    const owner = { ...rect('A'), version: 4, versionNonce: 123456, x: 999 };
    expect(mergeElements([agent], [owner]).elements[0].x).toBe(5);
  });
});

describe('quick edit: the journal', () => {
  const record = (id: string, extra: Partial<QuickJournalRecord> = {}): QuickJournalRecord => ({
    id, at: '2026-11-12T00:00:00.000Z', text: 'x', reply: 'ok', added: [], changed: [], before: {}, after: {}, costUsd: 0.01, model: 'sonnet', undone: false, ...extra,
  });

  it('is appended only after a landed write, inside the lock', async () => {
    const { slug } = createWhiteboard(root, 'B');
    let seenJournal = -1;
    await mutateWhiteboard(root, slug, () => {}, { onCommitted: (r) => { seenJournal = r.changed ? 1 : 0; } });
    expect(seenJournal).toBe(0);
    await mutateWhiteboard(root, slug, (b) => { b.elements.push(rect('A')); }, { onCommitted: (r) => {
      // The board is already on disk when the hook runs.
      expect(readWhiteboard(root, slug).board.elements.map((e) => e.id)).toEqual(['A']);
      seenJournal = r.changed ? 1 : 0;
    } });
    expect(seenJournal).toBe(1);
  });

  it('a tampered record is skipped, never trusted; only the last 20 are kept', () => {
    const { slug } = createWhiteboard(root, 'B');
    writeJournal(root, slug, Array.from({ length: 25 }, (_, i) => record(`rec-${String(i).padStart(14, '0')}`)));
    expect(readJournal(root, slug)).toHaveLength(20);
    const file = quickJournalPath(root, slug);
    writeFileSync(file, [JSON.stringify(record('good-record-0000001')), JSON.stringify({ ...record('bad-record-00000001'), added: ['../x'] }), '{oops'].join('\n'));
    expect(readJournal(root, slug).map((r) => r.id)).toEqual(['good-record-0000001']);
  });

  it('a symlinked .locks/quick is refused', () => {
    const { slug } = createWhiteboard(root, 'B');
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-out-')));
    mkdirSync(join(root, 'whiteboards', '.locks'), { recursive: true });
    symlinkSync(outside, join(root, 'whiteboards', '.locks', 'quick'));
    expect(() => writeJournal(root, slug, [record('rec-00000000000001')])).toThrow();
    expect(existsSync(join(outside, `${slug}.jsonl`))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it('a vault with the OLD whiteboards/.gitignore keeps the journal out of git', () => {
    const { slug } = createWhiteboard(root, 'B');
    const project = join(root, '..');
    writeFileSync(join(root, 'whiteboards', '.gitignore'), '.locks/\n*.tmp\n');
    execFileSync('git', ['init', '-q'], { cwd: project });
    writeJournal(root, slug, [record('rec-00000000000001')]);
    const rel = `_dream_context/whiteboards/.locks/quick/${slug}.jsonl`;
    expect(execFileSync('git', ['check-ignore', rel], { cwd: project }).toString().trim()).toBe(rel);
  });

  it('a deleted board drops its journal', async () => {
    const { slug } = createWhiteboard(root, 'B');
    writeJournal(root, slug, [record('rec-00000000000001')]);
    expect(existsSync(quickJournalPath(root, slug))).toBe(true);
    await trashWhiteboard(root, slug);
    expect(existsSync(join(root, 'whiteboards', '.locks', 'quick', `${slug}.jsonl`))).toBe(false);
    expect(readFileSync(join(root, 'whiteboards', '.locks', 'quick', '.gitignore'), 'utf-8')).toBe('*\n');
  });
});

describe('quick edit: end review r1', () => {
  it('security r2: the build runs in a worker under a deadline; the server event loop keeps answering', async () => {
    // 20 textRows of 2000 rows each: every value small, the total work large (r2's measurement: 31 s in-process).
    const heavy: QuickEditAnswer = { reply: 'x', notBoard: false, add: [{ at: [0, 0], spec: { elements: Array.from({ length: 20 }, (_, i) => ({ type: 'textRows', x: i * 40, rows: 2000 })) } }] };
    let ticks = 0;
    const beat = setInterval(() => { ticks += 1; }, 50);
    const t0 = Date.now();
    await expect(buildAdds(heavy, { timeoutMs: 600 })).rejects.toThrow(QuickEditRefusal);
    clearInterval(beat);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(ticks).toBeGreaterThanOrEqual(5); // the loop ran beside the build
    // A large region's coordinates are fine (r2: the prompt asks for them); fitInto scales.
    expect(specProblem({ elements: [{ type: 'rectangle', x: 0, y: 0, width: 4800, height: 2700 }] })).toBeNull();
    expect(specProblem({ elements: [{ type: 'line', points: [[0, Number.POSITIVE_INFINITY]] }] })).toBe('too_big');
    expect(specProblem({ elements: Array.from({ length: 401 }, () => ({ type: 'rectangle' })) })).toBe('too_big');
    expect(specProblem({ elements: [{ type: 'textRows', rows: 3, path: 'x' }] })).toBe('path');
  }, 15_000);

  it('edge-cases r3: what a drawing weighs is bounded in the worker, and a board never grows past what it can save', async () => {
    // 2 KB of spec, one polyline of ~100k points (~6 MB): refused before this thread reads it.
    const pie: QuickEditAnswer = { reply: 'x', notBoard: false, add: [{ at: [0, 0], spec: { elements: [{ type: 'pie', slices: [{ label: 'a', value: 1 }], seg: 100000, legend: false }] } }] };
    const t0 = Date.now();
    const err = await buildAdds(pie).catch((e) => e);
    expect(err).toBeInstanceOf(QuickEditRefusal);
    expect((err as QuickEditRefusal).code).toBe('too_big');
    expect(Date.now() - t0).toBeLessThan(3000);
    // The budget is shared by every add of one answer.
    const two: QuickEditAnswer = { reply: 'x', notBoard: false, add: [0, 1].map((i) => ({ at: [i * 300, 0] as [number, number], spec: { elements: [{ type: 'ellipse', width: 80, height: 80 }] } })) };
    // The budget is one add's real output size (what the worker measured) with room: each add
    // fits alone, two do not, so this fails if buildAdds stops subtracting what each add used.
    const sizes: number[] = [];
    const measured = (async (...args: Parameters<typeof buildSpecDrawingBounded>) => {
      const r = await buildSpecDrawingBounded(...args);
      sizes.push(r.bytes);
      return r;
    }) as typeof buildSpecDrawingBounded;
    expect(await buildAdds(two, { build: measured })).toHaveLength(2);
    const budget = Math.max(...sizes) + 100;
    expect(await buildAdds({ ...two, add: [two.add![1]] }, { maxBytes: budget })).toHaveLength(1);
    await expect(buildAdds(two, { maxBytes: budget })).rejects.toThrow(QuickEditRefusal);
    // A board at its save cap: an add is refused and nothing is written; a recolor still lands.
    const els = [rect('A'), rect('B', 300)];
    const cap = Buffer.byteLength(JSON.stringify({ elements: els })) + 50;
    const many: QuickEditAnswer = { reply: '', notBoard: false, add: [{ at: [0, 0], spec: { elements: Array.from({ length: 20 }, (_, i) => ({ type: 'ellipse', x: i * 60, width: 50, height: 50 })) } }] };
    const built = await buildAdds(many);
    expect(Buffer.byteLength(JSON.stringify(built[0]))).toBeGreaterThan(4096);
    expect(() => applyQuickEdit({ elements: structuredClone(els) }, many, { scope: [], identities: {}, area: null, built, savableBytes: cap })).toThrow(QuickEditRefusal);
    expect(applyQuickEdit({ elements: structuredClone(els) }, many, { scope: [], identities: {}, area: null, built }).added).toHaveLength(20);
    const big = structuredClone(els);
    const recolor = applyQuickEdit({ elements: big }, { reply: '', notBoard: false, update: [{ id: 'A', fill: 'green' }] }, { scope: ['A'], identities: ids(big, ['A']), area: null, savableBytes: 10 });
    expect(recolor.changed).toEqual(['A']);
  }, 15_000);

  it('edge-cases: a queued edit counts a shape an earlier quick edit rewrote as untouched; a hand edit stays skipped', () => {
    const before = rect('A', 0, 0, { version: 3, versionNonce: 500 });
    const rec = { id: 'r'.repeat(16), at: '', text: '', reply: '', added: [], changed: ['A'], before: { A: before }, after: { A: `4:${LOSING_NONCE}` }, costUsd: null, model: 'sonnet', undone: false } as QuickJournalRecord;
    expect(untouchedIdentity('3:500', `4:${LOSING_NONCE}`, 'A', [rec])).toBe(`4:${LOSING_NONCE}`);
    // Disk moved on past the edit (the owner's hand): the page's identity stands, so the apply skips it.
    expect(untouchedIdentity('3:500', '5:77', 'A', [rec])).toBe('3:500');
    expect(untouchedIdentity('3:500', `4:${LOSING_NONCE}`, 'A', [{ ...rec, undone: true }])).toBe('3:500');
  });

  it('edge-cases: a text the model saw cut is never overwritten whole; a short one is shown and changed whole', () => {
    const long = 'Uzun bir paragraf. '.repeat(150); // 2850 chars, past the 2000 a lone text is shown
    const t = { ...label('T', 'none', long), containerId: null } as WhiteboardElement;
    const els = [t];
    expect(scopeTextLimit(els, ['T'])).toBe(2000);
    const o = applyQuickEdit({ elements: els }, { reply: 'Kısalttım.', notBoard: false, update: [{ id: 'T', text: 'Kısa' }] }, { scope: ['T'], identities: ids(els, ['T']), area: null });
    expect(o.changed).toEqual([]);
    expect(o.dropped).toBe(1);
    expect(els[0].originalText).toBe(long);
    const mid = 'a'.repeat(300);
    const t2 = { ...label('M', 'none', mid), containerId: null } as WhiteboardElement;
    expect(JSON.parse(quickEditInput([t2], ['M'], null)).scope[0].text).toBe(mid);
  });

  it('edge-cases: asked-for changes that cannot be made are counted, never silently dropped', () => {
    const els = [rect('B')]; // no bound label
    const ans: QuickEditAnswer = { reply: "Kutuya 'Ödeme' yazıldı.", notBoard: false, update: [{ id: 'B', text: 'Ödeme', fill: 'lightblue' }] };
    const o = applyQuickEdit({ elements: els }, ans, { scope: ['B'], identities: ids(els, ['B']), area: null });
    expect(o.changed).toEqual([]);
    expect(o.dropped).toBe(2);
  });
});
