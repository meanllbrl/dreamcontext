import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createWhiteboard, ensureDefaultWhiteboard, listWhiteboards, mutateWhiteboard, nextIndices, readWhiteboard, whiteboardRev,
  whiteboardsDir, DEFAULT_WHITEBOARD,
} from '../../src/lib/whiteboards/store.js';
import { parseWhiteboard, serializeWhiteboard } from '../../src/lib/whiteboards/format.js';
import { mergeElements } from '../../src/lib/whiteboards/merge.js';
import {
  makeWidgetElement, nearestWidgetSize, widgetPayloadOf, WIDGET_SIZES, type WhiteboardElement,
} from '../../src/lib/whiteboards/widgets.js';
import { validateElement } from '../../src/lib/whiteboards/validate.js';
import {
  WhiteboardCorruptError, WhiteboardLockError, WhiteboardNotFoundError, WhiteboardValidationError,
} from '../../src/lib/whiteboards/errors.js';

/**
 * Every test runs against its own scratch context root (injectable-root isolation): nothing
 * here can reach the real brain's `whiteboards/`.
 */
let root: string;
let outside: string;

beforeEach(() => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-store-')));
  root = join(project, '_dream_context');
  mkdirSync(root);
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'dc-wb-outside-')));
});
afterEach(() => {
  rmSync(join(root, '..'), { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function note(index: string, markdown = 'x'): WhiteboardElement {
  return makeWidgetElement('note', { markdown }, { x: 0, y: 0 }, index);
}

describe('whiteboard store: create + slugs (D15)', () => {
  it('creates whiteboards/<slug>/<slug>.excalidraw.md with the name verbatim + git hygiene files', () => {
    const { slug, path } = createWhiteboard(root, 'Günlük', 'her gün');
    expect(slug).toBe('gunluk');
    expect(path).toBe(join(root, 'whiteboards', 'gunluk', 'gunluk.excalidraw.md'));
    const board = parseWhiteboard(readFileSync(path, 'utf-8'));
    expect(board.frontmatter.name).toBe('Günlük');
    expect(board.frontmatter.description).toBe('her gün');
    expect(readFileSync(join(root, 'whiteboards', '.gitattributes'), 'utf-8')).toBe('* merge=binary\n');
    expect(readFileSync(join(root, 'whiteboards', '.gitignore'), 'utf-8')).toContain('.locks/');
  });

  it('collisions get -2, -3; an emoji-only name falls back to board; long names cut to 64', () => {
    expect(createWhiteboard(root, 'Günlük').slug).toBe('gunluk');
    expect(createWhiteboard(root, 'günlük').slug).toBe('gunluk-2');
    expect(createWhiteboard(root, 'GÜNLÜK!').slug).toBe('gunluk-3');
    expect(createWhiteboard(root, '🎉🎉').slug).toBe('board');
    expect(createWhiteboard(root, '...').slug).toBe('board-2');
    const long = createWhiteboard(root, 'x'.repeat(100)).slug;
    expect(long).toBe('x'.repeat(64));
    expect(createWhiteboard(root, 'x'.repeat(100)).slug).toBe(`${'x'.repeat(62)}-2`);
  });

  it('refuses an empty name', () => {
    expect(() => createWhiteboard(root, '   ')).toThrow(WhiteboardValidationError);
  });
});

describe('whiteboard store: path safety', () => {
  it('rejects invalid slugs as not found', () => {
    createWhiteboard(root, 'ok');
    for (const bad of ['../ok', 'OK', '-ok', 'a/b', '', 'a'.repeat(65), '.trash']) {
      expect(() => readWhiteboard(root, bad)).toThrow(WhiteboardNotFoundError);
    }
  });

  it('never follows a symlinked board folder, in reads or in the listing', () => {
    createWhiteboard(root, 'real');
    mkdirSync(join(outside, 'evil'));
    writeFileSync(join(outside, 'evil', 'evil.excalidraw.md'), serializeWhiteboard(parseWhiteboard(readFileSync(join(root, 'whiteboards', 'real', 'real.excalidraw.md'), 'utf-8'))));
    symlinkSync(join(outside, 'evil'), join(whiteboardsDir(root), 'evil'));
    expect(() => readWhiteboard(root, 'evil')).toThrow(WhiteboardNotFoundError);
    expect(listWhiteboards(root).map((b) => b.slug)).toEqual(['real']);
  });

  it('never follows a symlinked board file or a symlinked whiteboards/ dir', async () => {
    createWhiteboard(root, 'real');
    mkdirSync(join(whiteboardsDir(root), 'linked'));
    writeFileSync(join(outside, 'secret.md'), 'secret');
    symlinkSync(join(outside, 'secret.md'), join(whiteboardsDir(root), 'linked', 'linked.excalidraw.md'));
    expect(() => readWhiteboard(root, 'linked')).toThrow(WhiteboardNotFoundError);
    await expect(mutateWhiteboard(root, 'linked', () => {})).rejects.toThrow(WhiteboardNotFoundError);
    expect(readFileSync(join(outside, 'secret.md'), 'utf-8')).toBe('secret');

    const root2 = join(outside, 'ctx');
    mkdirSync(root2);
    mkdirSync(join(outside, 'target'));
    symlinkSync(join(outside, 'target'), join(root2, 'whiteboards'));
    expect(listWhiteboards(root2)).toEqual([]);
    expect(() => createWhiteboard(root2, 'x')).toThrow(WhiteboardValidationError);
  });

  it.each(['.gitattributes', '.gitignore'])('refuses to write through a symlinked whiteboards/%s, even a dangling one', async (name) => {
    const { slug, path } = createWhiteboard(root, 'real');
    const link = join(whiteboardsDir(root), name);
    rmSync(link);
    const target = join(outside, 'target-file');
    symlinkSync(target, link); // dangling: existsSync says false, a write would create the target
    expect(() => createWhiteboard(root, 'other')).toThrow(WhiteboardValidationError);
    const before = readFileSync(path, 'utf-8');
    await expect(mutateWhiteboard(root, slug, (b) => { b.elements.push(note('a0')); })).rejects.toThrow(WhiteboardValidationError);
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('refuses to take a lock through a symlinked whiteboards/.locks', async () => {
    const { slug, path } = createWhiteboard(root, 'real');
    mkdirSync(join(outside, 'locks'));
    symlinkSync(join(outside, 'locks'), join(whiteboardsDir(root), '.locks'));
    const before = readFileSync(path, 'utf-8');
    await expect(mutateWhiteboard(root, slug, (b) => { b.elements.push(note('a0')); })).rejects.toThrow(WhiteboardValidationError);
    expect(existsSync(join(outside, 'locks', `${slug}.lock`))).toBe(false);
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });
});

describe('whiteboard store: mutate', () => {
  it('writes a change, bumps rev, and the change reads back', async () => {
    const { slug } = createWhiteboard(root, 'b');
    const rev0 = whiteboardRev(root, slug);
    const r = await mutateWhiteboard(root, slug, (b) => { b.elements.push(note(nextIndices(b.elements, 1)[0])); });
    expect(r.changed).toBe(true);
    expect(r.rev).not.toBe(rev0);
    expect(whiteboardRev(root, slug)).toBe(r.rev);
    expect(readWhiteboard(root, slug).board.elements).toHaveLength(1);
  });

  it('a no-op write leaves bytes and mtime unchanged', async () => {
    const { slug, path } = createWhiteboard(root, 'b');
    await mutateWhiteboard(root, slug, (b) => { b.elements.push(note('a0')); });
    const bytes = readFileSync(path);
    const mtime = statSync(path).mtimeMs;
    const onDisk = readWhiteboard(root, slug).board.elements;
    await new Promise((r) => setTimeout(r, 20));
    const r = await mutateWhiteboard(root, slug, (b) => { b.elements = mergeElements(b.elements, structuredClone(onDisk)).elements; });
    expect(r.changed).toBe(false);
    expect(readFileSync(path).equals(bytes)).toBe(true);
    expect(statSync(path).mtimeMs).toBe(mtime);
  });

  it('a PUT carrying an unstripped tombstone at an equal version is a no-op (D14)', async () => {
    const { slug, path } = createWhiteboard(root, 'b');
    const w = { ...note('a0', 'a long note body'), isDeleted: true, version: 3 };
    await mutateWhiteboard(root, slug, (b) => { b.elements.push(w); });
    const stored = readWhiteboard(root, slug).board.elements[0];
    expect((stored.customData as { dc: { markdown?: string } }).dc.markdown).toBeUndefined();
    expect(stored.index).toBe('a0');
    const bytes = readFileSync(path);
    const r = await mutateWhiteboard(root, slug, (b) => { b.elements = mergeElements(b.elements, [w]).elements; });
    expect(r.changed).toBe(false);
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  it('serializes concurrent mutations: no update is lost', async () => {
    const { slug } = createWhiteboard(root, 'b');
    await Promise.all(Array.from({ length: 8 }, () => mutateWhiteboard(root, slug, (b) => {
      b.elements.push(note(nextIndices(b.elements, 1)[0]));
    })));
    expect(readWhiteboard(root, slug).board.elements).toHaveLength(8);
  });

  it('waits for a held lock and times out with a retryable error', async () => {
    const { slug } = createWhiteboard(root, 'b');
    const lock = join(whiteboardsDir(root), '.locks', `${slug}.lock`);
    mkdirSync(join(whiteboardsDir(root), '.locks'), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    await expect(mutateWhiteboard(root, slug, () => {}, { lockWaitMs: 60 })).rejects.toThrow(WhiteboardLockError);
    setTimeout(() => rmSync(lock), 50);
    await expect(mutateWhiteboard(root, slug, (b) => { b.elements.push(note('a0')); }, { lockWaitMs: 2000 })).resolves.toMatchObject({ changed: true });
  });

  it('releases the lock in finally after a throwing mutation', async () => {
    const { slug } = createWhiteboard(root, 'b');
    await expect(mutateWhiteboard(root, slug, () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(join(whiteboardsDir(root), '.locks', `${slug}.lock`))).toBe(false);
    await expect(mutateWhiteboard(root, slug, (b) => { b.elements.push(note('a0')); }, { lockWaitMs: 0 })).resolves.toMatchObject({ changed: true });
  });

  it('refuses a corrupt board and leaves it untouched', async () => {
    const { slug, path } = createWhiteboard(root, 'b');
    const garbage = readFileSync(path, 'utf-8').replace('"elements": []', '"elements": [{');
    writeFileSync(path, garbage);
    await expect(mutateWhiteboard(root, slug, (b) => { b.elements.push(note('a0')); })).rejects.toThrow(WhiteboardCorruptError);
    expect(readFileSync(path, 'utf-8')).toBe(garbage);
    expect(listWhiteboards(root)[0].corrupt).toBeTruthy();
  });

  it('refuses a text label holding its own "## Drawing" json block, which would read back as a different board', async () => {
    const { slug, path } = createWhiteboard(root, 'b');
    await mutateWhiteboard(root, slug, (b) => { b.elements.push(note('a0')); });
    const before = readFileSync(path, 'utf-8');
    const label = '## Drawing\n```json\n{"elements": []}\n```';
    const text: WhiteboardElement = {
      id: 'label1', type: 'text', version: 1, versionNonce: 1, index: 'a1', isDeleted: false,
      x: 0, y: 0, width: 100, height: 40, text: label, originalText: label,
    };
    await expect(mutateWhiteboard(root, slug, (b) => { b.elements.push(text); })).rejects.toThrow(WhiteboardCorruptError);
    expect(readFileSync(path, 'utf-8')).toBe(before);
    expect(readWhiteboard(root, slug).board.elements).toHaveLength(1);
  });

  it('never re-creates a deleted board', async () => {
    const { slug } = createWhiteboard(root, 'b');
    rmSync(join(whiteboardsDir(root), slug), { recursive: true });
    await expect(mutateWhiteboard(root, slug, (b) => { b.elements.push(note('a0')); })).rejects.toThrow(WhiteboardNotFoundError);
    expect(existsSync(join(whiteboardsDir(root), slug))).toBe(false);
  });

  it('refuses an image element or an invalid widget payload (D10, security invariants)', async () => {
    const { slug, path } = createWhiteboard(root, 'b');
    const before = readFileSync(path, 'utf-8');
    const img = { id: 'img', type: 'image', version: 1, versionNonce: 1, index: 'a0', fileId: 'f' };
    await expect(mutateWhiteboard(root, slug, (b) => { b.elements.push(img); })).rejects.toThrow(/Images/);
    const bad = makeWidgetElement('web', { url: 'http://example.com' }, { x: 0, y: 0 }, 'a0');
    await expect(mutateWhiteboard(root, slug, (b) => { b.elements.push(bad); })).rejects.toThrow(WhiteboardValidationError);
    const badRef = makeWidgetElement('task', { ref: '../../etc/passwd' }, { x: 0, y: 0 }, 'a0');
    await expect(mutateWhiteboard(root, slug, (b) => { b.elements.push(badRef); })).rejects.toThrow(WhiteboardValidationError);
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('a hand-made board already holding an image stays editable around it', async () => {
    const { slug, path } = createWhiteboard(root, 'b');
    const raw = readFileSync(path, 'utf-8').replace('"elements": []', '"elements": [{"id":"img","type":"image","version":1,"versionNonce":1,"index":"a0"}]');
    writeFileSync(path, raw);
    await mutateWhiteboard(root, slug, (b) => { b.elements.push(note(nextIndices(b.elements, 1)[0])); });
    expect(readWhiteboard(root, slug).board.elements.map((e) => e.type)).toEqual(['image', 'embeddable']);
  });
});

describe('whiteboard store: default "Control Panel" board (A15)', () => {
  it('creates control-panel once; a second call is a no-op', async () => {
    expect(DEFAULT_WHITEBOARD).toEqual({ slug: 'control-panel', name: 'Control Panel' });
    expect(await ensureDefaultWhiteboard(root)).toEqual({ slug: 'control-panel', created: true });
    const { board } = readWhiteboard(root, 'control-panel');
    expect(board.frontmatter.name).toBe('Control Panel');
    const path = join(root, 'whiteboards', 'control-panel', 'control-panel.excalidraw.md');
    await mutateWhiteboard(root, 'control-panel', (b) => { b.elements.push(note('a0')); });
    const bytes = readFileSync(path, 'utf-8');
    expect(await ensureDefaultWhiteboard(root)).toEqual({ slug: 'control-panel', created: false });
    expect(readFileSync(path, 'utf-8')).toBe(bytes);
    expect(readFileSync(join(root, 'whiteboards', '.gitattributes'), 'utf-8')).toBe('* merge=binary\n');
  });

  it('two concurrent callers create it exactly once and both see a complete board', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => ensureDefaultWhiteboard(root)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.every((r) => r.slug === 'control-panel')).toBe(true);
    expect(listWhiteboards(root).map((b) => b.slug)).toEqual(['control-panel']);
    expect(readWhiteboard(root, 'control-panel').board.elements).toEqual([]);
  });

  it('adopts an existing control-panel board and never writes through a symlinked one', async () => {
    const { slug } = createWhiteboard(root, 'Control Panel');
    expect(slug).toBe('control-panel');
    expect(await ensureDefaultWhiteboard(root)).toEqual({ slug, created: false });
    // A name colliding with the default follows the ordinary slug rules.
    expect(createWhiteboard(root, 'Control Panel').slug).toBe('control-panel-2');

    rmSync(join(whiteboardsDir(root), 'control-panel'), { recursive: true });
    symlinkSync(outside, join(whiteboardsDir(root), 'control-panel'));
    await expect(ensureDefaultWhiteboard(root)).rejects.toThrow(WhiteboardValidationError);
    expect(existsSync(join(outside, 'control-panel.excalidraw.md'))).toBe(false);
  });

  it('the listing marks the default board', async () => {
    createWhiteboard(root, 'Other');
    await ensureDefaultWhiteboard(root);
    const list = listWhiteboards(root);
    expect(list.find((b) => b.slug === 'control-panel')?.isDefault).toBe(true);
    expect(list.find((b) => b.slug === 'other')?.isDefault).toBeUndefined();
  });

  it('never hands out the slug "default" (GET /api/whiteboards/default is a route)', () => {
    expect(createWhiteboard(root, 'Default').slug).toBe('default-2');
  });
});

describe('whiteboard widgets: sizes (A17)', () => {
  it('a preset sets width/height and dc.size; no size takes the kind default; w,h stays free-form', () => {
    const xl = makeWidgetElement('note', { markdown: 'x', size: 'xl' }, { x: 0, y: 0, w: 10, h: 10 }, 'a0');
    expect([xl.width, xl.height]).toEqual([768, 376]);
    expect(widgetPayloadOf(xl)?.size).toBe('xl');
    const defaults = { insight: 'm', knowledge: 's', task: 's', todo: 'm', note: 'm', html: 'l', web: 'l' } as const;
    for (const [kind, size] of Object.entries(defaults)) {
      const payload = kind === 'web' ? { url: 'https://example.com' } : ['insight', 'knowledge', 'task'].includes(kind) ? { ref: 'x' } : {};
      const el = makeWidgetElement(kind as keyof typeof defaults, payload, { x: 0, y: 0 }, 'a0');
      expect([el.width, el.height], kind).toEqual([...WIDGET_SIZES[size]]);
      expect(widgetPayloadOf(el)?.size, kind).toBe(size);
    }
    const free = makeWidgetElement('note', { markdown: 'x' }, { x: 0, y: 0, w: 400, h: 300 }, 'a0');
    expect([free.width, free.height]).toEqual([400, 300]);
    expect(widgetPayloadOf(free)?.size).toBeUndefined();
    // Never 0: a zero box falls back to the kind default.
    const zero = makeWidgetElement('note', { markdown: 'x' }, { x: 0, y: 0, w: 0, h: 0 }, 'a0');
    expect(zero.width).toBeGreaterThan(0);
    expect(zero.height).toBeGreaterThan(0);
  });

  it('validation accepts only s, m, l, xl', async () => {
    const el = makeWidgetElement('note', { markdown: 'x' }, { x: 0, y: 0 }, 'a0');
    for (const size of ['s', 'm', 'l', 'xl']) {
      expect(() => validateElement({ ...el, customData: { dc: { ...widgetPayloadOf(el), size } } })).not.toThrow();
    }
    for (const size of ['XL', 'xxl', '', 3, null]) {
      expect(() => validateElement({ ...el, customData: { dc: { ...widgetPayloadOf(el), size } } }), String(size)).toThrow(WhiteboardValidationError);
    }
    const { slug } = createWhiteboard(root, 'b');
    const bad = { ...el, customData: { dc: { ...widgetPayloadOf(el), size: 'huge' } } };
    await expect(mutateWhiteboard(root, slug, (b) => { b.elements.push(bad); })).rejects.toThrow(/invalid widget size/);
  });

  it('nearestWidgetSize picks the closest preset', () => {
    expect(nearestWidgetSize(180, 180)).toBe('s');
    expect(nearestWidgetSize(320, 200)).toBe('m');
    expect(nearestWidgetSize(400, 300)).toBe('l');
    expect(nearestWidgetSize(900, 400)).toBe('xl');
  });
});
