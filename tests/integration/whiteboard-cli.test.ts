import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { extractExcalidrawScene } from '../../dashboard/src/lib/excalidraw.js';
import { mutateWhiteboard, readWhiteboard } from '../../src/lib/whiteboards/store.js';
import { mergeElements } from '../../src/lib/whiteboards/merge.js';
import { widgetPayloadOf } from '../../src/lib/whiteboards/widgets.js';

/**
 * `dreamcontext whiteboard` end-to-end through the built CLI, against a scratch project:
 * create → add all 7 kinds → show --json → update/check → remove --tag → draw.
 */

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
const BUILDER = join(__dirname, '..', '..', 'skill-packs', 'excalidraw', 'scripts', 'build_excalidraw.js');

let project: string;
let root: string;

function run(args: string[]): { out: string; err: string; code: number } {
  const r = spawnSync('node', [CLI, ...args], { cwd: project, encoding: 'utf-8', timeout: 20_000 });
  return { out: r.stdout, err: r.stderr, code: r.status ?? 1 };
}

function json<T = any>(args: string[]): T {
  const r = run([...args, '--json']);
  if (r.code !== 0) throw new Error(`${args.join(' ')} failed: ${r.out}${r.err}`);
  return JSON.parse(r.out) as T;
}

beforeAll(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-cli-')));
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(root, 'lab', 'insights'), { recursive: true });
  writeFileSync(join(root, 'knowledge', 'pricing.md'), '---\nname: Pricing\n---\n');
  writeFileSync(join(root, 'state', 'ship-it.md'), '---\nname: Ship it\n---\n');
  writeFileSync(join(root, 'lab', 'insights', 'dau.md'), '---\nname: DAU\n---\n');
});
afterAll(() => rmSync(project, { recursive: true, force: true }));

describe('whiteboard CLI (integration)', { timeout: 60_000 }, () => {
  const slug = 'gunluk';
  const ids: Record<string, string> = {};

  it('create "Günlük" writes the board, keeps the name verbatim, and the dashboard parser reads it', () => {
    const created = json(['whiteboard', 'create', 'Günlük', '-d', 'her gün']);
    expect(created.slug).toBe(slug);
    const path = join(root, 'whiteboards', slug, `${slug}.excalidraw.md`);
    const md = readFileSync(path, 'utf-8');
    expect(md).toContain('name: "Günlük"');
    expect(extractExcalidrawScene(md)?.elements).toEqual([]);
    expect(readFileSync(join(root, 'whiteboards', '.gitattributes'), 'utf-8')).toBe('* merge=binary\n');
    expect(json(['whiteboard', 'list'])).toMatchObject([{ slug, name: 'Günlük', elements: 0 }]);
  });

  it('add works for all 7 kinds; a dangling ref warns but does not fail', () => {
    const htmlFile = join(project, 'block.html');
    writeFileSync(htmlFile, '<b>merhaba</b>');
    ids.insight = json(['whiteboard', 'add', slug, 'insight', '--ref', 'dau', '--tag', 'daily']).id;
    ids.knowledge = json(['whiteboard', 'add', slug, 'knowledge', '--ref', 'pricing']).id;
    ids.task = json(['whiteboard', 'add', slug, 'task', '--ref', 'ship-it', '--title', 'Ship']).id;
    ids.todo = json(['whiteboard', 'add', slug, 'todo', '--title', 'Bugün', '--item', 'süt al', '--item', 'kod yaz', '--tag', 'daily', '--at', '0,500']).id;
    ids.note = json(['whiteboard', 'add', slug, 'note', '--text', `# Not\n${'x'.repeat(600)}`, '--tag', 'daily']).id;
    ids.html = json(['whiteboard', 'add', slug, 'html', '--file', htmlFile, '--size', '400,300']).id;
    ids.web = json(['whiteboard', 'add', slug, 'web', '--url', 'https://example.com/page']).id;

    const dangling = run(['whiteboard', 'add', slug, 'knowledge', '--ref', 'nope']);
    expect(dangling.code).toBe(0);
    expect(dangling.out).toMatch(/no knowledge 'nope' exists yet/);
    ids.dangling = /widget (\S+) to/.exec(dangling.out)![1];
  });

  it('add refuses a bad kind, an http url, a traversal ref', () => {
    expect(run(['whiteboard', 'add', slug, 'image']).code).not.toBe(0);
    const http = run(['whiteboard', 'add', slug, 'web', '--url', 'http://example.com']);
    expect(http.code).not.toBe(0);
    expect(http.err).toMatch(/https/);
    expect(run(['whiteboard', 'add', slug, 'task', '--ref', '../../x']).code).not.toBe(0);
  });

  it('show --json lists live elements with kind/ref/title/bbox/tag and payloads (truncated to 500)', () => {
    const shown = json(['whiteboard', 'show', slug]);
    expect(shown.name).toBe('Günlük');
    const byId = Object.fromEntries(shown.elements.map((e: any) => [e.id, e]));
    expect(byId[ids.insight]).toMatchObject({ type: 'embeddable', kind: 'insight', ref: 'dau', tag: 'daily' });
    expect(byId[ids.task]).toMatchObject({ kind: 'task', ref: 'ship-it', title: 'Ship' });
    expect(byId[ids.todo]).toMatchObject({ kind: 'todo', size: 'm', bbox: { x: 0, y: 500, w: 376, h: 180 } });
    expect(byId[ids.todo].items.map((i: any) => [i.text, i.done])).toEqual([['süt al', false], ['kod yaz', false]]);
    expect(byId[ids.note].markdown).toHaveLength(500);
    expect(byId[ids.note].truncated).toBe(true);
    // free-form --size w,h keeps its box; show reports the nearest preset
    expect(byId[ids.html]).toMatchObject({ kind: 'html', html: '<b>merhaba</b>', bbox: { w: 400, h: 300 }, size: 'l' });
    expect(byId[ids.web].url).toBe('https://example.com/page');
    // auto-placement: nothing overlaps the first widget's slot
    expect(byId[ids.knowledge].bbox.x).toBeGreaterThan(byId[ids.insight].bbox.x);

    const full = json(['whiteboard', 'show', slug, ids.note, '--full']);
    expect(full.markdown).toHaveLength(`# Not\n`.length + 600);
    expect(full.truncated).toBeUndefined();
  });

  it('a todo ticked in the UI (a browser PUT merged by the store) reads back as done:true', async () => {
    const { board } = readWhiteboard(root, slug);
    const todo = structuredClone(board.elements.find((e) => e.id === ids.todo)!);
    const dc = widgetPayloadOf(todo)!;
    dc.items![1].done = true;
    todo.version += 1;
    todo.versionNonce = 12345;
    await mutateWhiteboard(root, slug, (b) => { b.elements = mergeElements(b.elements, [todo]).elements; });
    const shown = json(['whiteboard', 'show', slug, ids.todo]);
    expect(shown.items.map((i: any) => i.done)).toEqual([false, true]);
  });

  it('update: title, --check / --uncheck, --item, --at', () => {
    const upd = json(['whiteboard', 'update', slug, ids.todo, '--check', '1', '--uncheck', '2', '--item', 'yeni', '--title', 'Yarın', '--at', '10,510']);
    expect(upd.title).toBe('Yarın');
    expect(upd.items.map((i: any) => [i.text, i.done])).toEqual([['süt al', true], ['kod yaz', false], ['yeni', false]]);
    expect(upd.bbox).toMatchObject({ x: 10, y: 510 });
    const note = json(['whiteboard', 'update', slug, ids.note, '--text', 'kısa']);
    expect(note.markdown).toBe('kısa');
    expect(run(['whiteboard', 'update', slug, ids.web, '--check', '1']).code).not.toBe(0);
    expect(run(['whiteboard', 'update', slug, 'no-such-id', '--title', 'x']).code).not.toBe(0);
  });

  it('remove --tag tombstones the group and prints its bbox; the elements leave show', () => {
    const before = json(['whiteboard', 'show', slug]).elements.filter((e: any) => e.tag === 'daily');
    expect(before).toHaveLength(3);
    const human = run(['whiteboard', 'remove', slug, '--tag', 'daily']);
    expect(human.code).toBe(0);
    const minX = Math.min(...before.map((e: any) => e.bbox.x));
    const minY = Math.min(...before.map((e: any) => e.bbox.y));
    expect(human.out).toMatch(new RegExp(`bbox ${minX},${minY},\\d+,\\d+`));
    const after = json(['whiteboard', 'show', slug]).elements;
    expect(after.some((e: any) => e.tag === 'daily')).toBe(false);
    // tombstones stay in the file (D4), stripped of their payload (D14)
    const onDisk = readWhiteboard(root, slug).board.elements.filter((e) => e.isDeleted);
    expect(onDisk).toHaveLength(3);
    // nothing left to remove is not an error, and --json reports an empty group
    expect(json(['whiteboard', 'remove', slug, '--tag', 'daily'])).toEqual({ removed: [], bbox: null });
    const one = json(['whiteboard', 'remove', slug, ids.dangling]);
    expect(one.removed).toEqual([ids.dangling]);
  });

  it('draw imports a builder board: re-ids, keeps bindings/groups consistent, offsets, tags', () => {
    const boardFile = join(project, 'diagram.excalidraw.md');
    const spec = {
      out: boardFile,
      audit: false,
      elements: [
        { type: 'rectangle', x: 100, y: 100, width: 200, height: 80, group: 'g' },
        { type: 'text', x: 110, y: 120, text: 'Kutu', group: 'g' },
        { type: 'arrow', x: 300, y: 140, points: [[0, 0], [120, 0]] },
      ],
    };
    const specFile = join(project, 'spec.json');
    writeFileSync(specFile, JSON.stringify(spec));
    execFileSync('node', [BUILDER, specFile], { cwd: project });
    // Bind the arrow to the rectangle so the import has a binding to keep consistent.
    const md = readFileSync(boardFile, 'utf-8');
    const src = extractExcalidrawScene(md)!.elements as any[];
    const [rect, , arrow] = src;
    arrow.startBinding = { elementId: rect.id, focus: 0, gap: 1 };
    rect.boundElements = [{ id: arrow.id, type: 'arrow' }];
    writeFileSync(join(project, 'diagram.json'), JSON.stringify({ elements: src }));

    const r = json(['whiteboard', 'draw', slug, '--file', join(project, 'diagram.json'), '--at', '1000,1000', '--tag', 'diagram']);
    expect(r.ids).toHaveLength(3);
    expect(r.bbox).toMatchObject({ x: 1000, y: 1000 });
    const els = readWhiteboard(root, slug).board.elements.filter((e) => r.ids.includes(e.id));
    const nRect = els.find((e) => e.type === 'rectangle')! as any;
    const nText = els.find((e) => e.type === 'text')! as any;
    const nArrow = els.find((e) => e.type === 'arrow')! as any;
    expect(src.map((e) => e.id)).not.toContain(nRect.id);
    expect(nArrow.startBinding.elementId).toBe(nRect.id);
    expect(nRect.boundElements).toEqual([{ id: nArrow.id, type: 'arrow' }]);
    expect(nRect.groupIds).toEqual(nText.groupIds);
    expect(nRect.groupIds[0]).not.toBe(src[0].groupIds[0]);
    expect(nRect.x).toBe(1000);
    expect(nText.x).toBe(1010);
    expect(nRect.customData.dcTag).toBe('diagram');
    // fresh indices above everything already on the board
    const others = readWhiteboard(root, slug).board.elements.filter((e) => !r.ids.includes(e.id));
    const maxOther = others.map((e) => e.index as string).sort().at(-1)!;
    for (const e of els) expect((e.index as string) > maxOther).toBe(true);

    // the .excalidraw.md form is accepted too, and --tag removal takes the whole group back out
    expect(json(['whiteboard', 'draw', slug, '--file', boardFile, '--tag', 'd2']).ids).toHaveLength(3);
    expect(json(['whiteboard', 'remove', slug, '--tag', 'diagram']).removed).toHaveLength(3);
  });

  it('draw refuses a file carrying an image element (D10) and leaves the board untouched', () => {
    const path = join(root, 'whiteboards', slug, `${slug}.excalidraw.md`);
    const before = readFileSync(path, 'utf-8');
    const f = join(project, 'img.json');
    writeFileSync(f, JSON.stringify([{ id: 'i', type: 'image', version: 1, x: 0, y: 0, width: 10, height: 10, fileId: 'x' }]));
    const r = run(['whiteboard', 'draw', slug, '--file', f]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/Images are not supported/);
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('refuses to write over a corrupt board, exits non-zero, leaves the file untouched', () => {
    json(['whiteboard', 'create', 'Bozuk']);
    const path = join(root, 'whiteboards', 'bozuk', 'bozuk.excalidraw.md');
    const garbage = readFileSync(path, 'utf-8').replace('"elements": []', '"elements": [{');
    writeFileSync(path, garbage);
    const r = run(['whiteboard', 'add', 'bozuk', 'note', '--text', 'x']);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/does not parse/);
    expect(readFileSync(path, 'utf-8')).toBe(garbage);
    expect(run(['whiteboard', 'show', 'bozuk']).code).not.toBe(0);
  });

  it('an unknown or invalid slug fails cleanly', () => {
    expect(run(['whiteboard', 'show', 'nope']).code).not.toBe(0);
    expect(run(['whiteboard', 'show', '../etc']).code).not.toBe(0);
  });
});

describe('whiteboard CLI: sizes, grid placement, the default board (A15, A17)', { timeout: 60_000 }, () => {
  const slug = 'sizes';
  const PITCH = 196;
  const boxes = () => json(['whiteboard', 'show', slug]).elements.map((e: any) => e.bbox);

  it('create a board; list marks the default board once it exists', () => {
    expect(json(['whiteboard', 'create', 'Sizes']).slug).toBe(slug);
    expect(run(['whiteboard', 'list']).out).toMatch(/Control Panel.*created the first time/);
    // The dashboard creates it on first open; here a create of the same name stands in for that.
    expect(json(['whiteboard', 'create', 'Control Panel']).slug).toBe('control-panel');
    const list = json(['whiteboard', 'list']);
    expect(list.find((b: any) => b.slug === 'control-panel').isDefault).toBe(true);
    expect(list.find((b: any) => b.slug === slug).isDefault).toBeUndefined();
    expect(run(['whiteboard', 'list']).out).toMatch(/control-panel.*\(default\)/);
    // A second "Control Panel" follows the ordinary slug rules.
    expect(json(['whiteboard', 'create', 'Control Panel']).slug).toBe('control-panel-2');
  });

  it('add --size s|m|l|xl sets the preset box and dc.size; no --size takes the kind default', () => {
    const id = {
      s: json(['whiteboard', 'add', slug, 'note', '--text', 'a', '--size', 's']).id,
      xl: json(['whiteboard', 'add', slug, 'note', '--text', 'b', '--size', 'XL']).id,
      task: json(['whiteboard', 'add', slug, 'task', '--ref', 'ship-it']).id,
      web: json(['whiteboard', 'add', slug, 'web', '--url', 'https://example.com']).id,
    };
    const byId = Object.fromEntries(json(['whiteboard', 'show', slug]).elements.map((e: any) => [e.id, e]));
    expect(byId[id.s]).toMatchObject({ size: 's', bbox: { w: 180, h: 180 } });
    expect(byId[id.xl]).toMatchObject({ size: 'xl', bbox: { w: 768, h: 376 } });
    expect(byId[id.task]).toMatchObject({ size: 's', bbox: { w: 180, h: 180 } });
    expect(byId[id.web]).toMatchObject({ size: 'l', bbox: { w: 376, h: 376 } });
    const onDisk = readWhiteboard(root, slug).board.elements.find((e) => e.id === id.xl)!;
    expect(widgetPayloadOf(onDisk)?.size).toBe('xl');

    expect(run(['whiteboard', 'add', slug, 'note', '--size', 'huge']).code).not.toBe(0);
    expect(run(['whiteboard', 'add', slug, 'note', '--size', '0,10']).code).not.toBe(0);
  });

  it('auto-placement lands on the grid pitch, never overlaps, and wraps below a full row', () => {
    for (let i = 0; i < 6; i++) json(['whiteboard', 'add', slug, 'todo', '--item', `t${i}`, '--size', i % 2 ? 'm' : 'l']);
    const all = boxes();
    expect(all).toHaveLength(10);
    for (const b of all) {
      expect(b.x % PITCH, `x ${b.x}`).toBe(0);
      expect(b.y % PITCH, `y ${b.y}`).toBe(0);
    }
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i];
        const b = all[j];
        const apart = a.x + a.w + 16 <= b.x || b.x + b.w + 16 <= a.x || a.y + a.h + 16 <= b.y || b.y + b.h + 16 <= a.y;
        expect(apart, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(true);
      }
    }
    // Ten widgets do not fit in one eight-cell row: something wrapped below the first row.
    expect(Math.max(...all.map((b: any) => b.y))).toBeGreaterThan(0);
    expect(Math.max(...all.map((b: any) => b.x + b.w))).toBeLessThanOrEqual(8 * PITCH);
  });

  it('update --size s|m|l|xl sets dc.size and the box and bumps version; --size w,h drops dc.size', () => {
    const [first] = json(['whiteboard', 'show', slug]).elements;
    const v0 = readWhiteboard(root, slug).board.elements.find((e) => e.id === first.id)!.version;
    expect(json(['whiteboard', 'update', slug, first.id, '--size', 'xl'])).toMatchObject({ size: 'xl', bbox: { w: 768, h: 376 } });
    let el = readWhiteboard(root, slug).board.elements.find((e) => e.id === first.id)!;
    expect(el.version).toBe(v0 + 1);
    expect(widgetPayloadOf(el)?.size).toBe('xl');

    expect(json(['whiteboard', 'update', slug, first.id, '--size', '200,190'])).toMatchObject({ size: 's', bbox: { w: 200, h: 190 } });
    el = readWhiteboard(root, slug).board.elements.find((e) => e.id === first.id)!;
    expect(widgetPayloadOf(el)?.size).toBeUndefined();
    expect(run(['whiteboard', 'update', slug, first.id, '--size', 'xxl']).code).not.toBe(0);
  });
});
