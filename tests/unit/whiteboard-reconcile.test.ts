/**
 * A7 / D5: a poll must never drop the user's unsaved edit.
 *
 * Run against Excalidraw's REAL `restoreElements` + `reconcileElements` (0.18.1), not a model of
 * them: the whole bug this guards is a detail of the real implementation. Given the local
 * elements, `restoreElements` bumps an older remote copy to `local.version + 1`, and that copy
 * then beats the user's drag in `reconcileElements`. The canvas passes `null`.
 *
 * The package is a dashboard dependency and ships extension-less ESM imports that Node cannot
 * resolve, so the two functions are bundled with esbuild into a temp file and loaded under a
 * minimal DOM stub (the bundle reads `window`, `document` and a few constructors at load; the
 * two functions under test touch none of them for rectangles).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import {
  reconcileRemoteScene, stripImageElements,
} from '../../dashboard/src/components/whiteboard/sceneSync.js';
import { createWhiteboard, mutateWhiteboard, nextIndices, readWhiteboard } from '../../src/lib/whiteboards/store.js';
import { sortElements } from '../../src/lib/whiteboards/format.js';
import { mergeElements } from '../../src/lib/whiteboards/merge.js';
import { autoPlace, newTodoItem } from '../../src/lib/whiteboards/ops.js';
import { makeWidgetElement, type WhiteboardElement } from '../../src/lib/whiteboards/widgets.js';

type El = { id: string; type: string; version: number; versionNonce: number; index: string | null; x: number; isDeleted?: boolean };
type Restore = (els: readonly unknown[], local: readonly unknown[] | null) => El[];
type Reconcile = (local: readonly El[], remote: readonly El[], appState: unknown) => El[];

const ROOT = new URL('../../', import.meta.url).pathname;
const EXCALIDRAW = join(ROOT, 'dashboard/node_modules/@excalidraw/excalidraw/dist/prod/index.js');

const g = globalThis as Record<string, unknown>;
const STUBBED = ['window', 'document', 'navigator', 'location', 'devicePixelRatio', 'addEventListener', 'matchMedia', 'FontFace',
  'Element', 'HTMLElement', 'HTMLCanvasElement', 'HTMLImageElement', 'Node', 'SVGElement', 'HTMLInputElement',
  'HTMLTextAreaElement', 'Image', 'Path2D', 'ResizeObserver', 'MutationObserver', 'DOMParser', 'CanvasRenderingContext2D'];
const saved = new Map<string, PropertyDescriptor | undefined>();

let restoreElements: Restore;
let reconcileElements: Reconcile;
let dir: string;
/** Why Excalidraw could not be loaded, if it could not. A throw in beforeAll makes vitest SKIP
 *  the tests, and a skipped A7 test proves nothing, so the error is kept and every test throws
 *  it: an unloadable bundle is a FAIL. */
let loadError: unknown = null;

function excalidraw(): { restoreElements: Restore; reconcileElements: Reconcile } {
  if (loadError) throw new Error(`Excalidraw could not be loaded for this test: ${String((loadError as Error)?.stack ?? loadError)}`);
  if (!restoreElements || !reconcileElements) throw new Error('Excalidraw functions missing after load');
  return { restoreElements, reconcileElements };
}

function installDomStub() {
  for (const k of STUBBED) saved.set(k, Object.getOwnPropertyDescriptor(g, k));
  const noop = () => {};
  const el = () => ({
    style: {}, setAttribute: noop, appendChild: noop, addEventListener: noop,
    classList: { add: noop, remove: noop },
    getContext: () => ({ measureText: () => ({ width: 1 }), filter: 'none', font: '' }),
  });
  const define = (k: string, v: unknown) => Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
  define('window', globalThis);
  define('document', {
    createElement: el, documentElement: el(), body: el(), head: el(), addEventListener: noop,
    removeEventListener: noop, querySelector: () => null,
    fonts: { add: noop, check: () => true, load: async () => [], addEventListener: noop },
  });
  // Node 20 has no global navigator (21+ does); the bundle reads userAgent/platform at load.
  define('navigator', { userAgent: 'node', platform: 'node', language: 'en', vendor: '', maxTouchPoints: 0 });
  define('location', new URL('http://localhost/'));
  define('devicePixelRatio', 1);
  define('addEventListener', noop);
  define('matchMedia', () => ({ matches: false, addEventListener: noop, addListener: noop }));
  define('FontFace', class { load() { return Promise.resolve(this); } });
  for (const k of STUBBED.slice(8)) if (!(k in g) || g[k] === undefined) define(k, class {});
}

function restoreGlobals() {
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d); else delete g[k];
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wb-reconcile-'));
  try {
    const entry = join(dir, 'entry.mjs');
    writeFileSync(entry, `export { restoreElements, reconcileElements } from ${JSON.stringify(EXCALIDRAW)};\n`);
    const out = join(dir, 'excalidraw.mjs');
    await build({
      entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out,
      loader: { '.css': 'empty' }, logLevel: 'silent',
    });
    installDomStub();
    const mod = await import(pathToFileURL(out).href) as { restoreElements: Restore; reconcileElements: Reconcile };
    restoreElements = mod.restoreElements;
    reconcileElements = mod.reconcileElements;
  } catch (err) {
    loadError = err;
  }
}, 60_000);

afterAll(() => {
  restoreGlobals();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const BASE = {
  type: 'rectangle', y: 0, width: 100, height: 50, angle: 0, strokeColor: '#000000',
  backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 1,
  opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, isDeleted: false,
  boundElements: null, updated: 1, link: null, locked: false,
};
const APP_STATE = { editingTextElement: null, resizingElement: null, newElement: null, selectedElementIds: {} };

describe('reconcileRemoteScene (the canvas\'s poll path) on real Excalidraw 0.18', () => {
  it('keeps a local element at a higher version unchanged when a poll brings an older remote copy', () => {
    const { restoreElements, reconcileElements } = excalidraw();
    // The user dragged "a" to x=300 (version 5, not saved yet); the poll still has version 3 at x=0.
    const local = restoreElements([{ ...BASE, id: 'a', version: 5, versionNonce: 10, index: 'a0', x: 300 }], null);
    const remote = [
      { ...BASE, id: 'a', version: 3, versionNonce: 7, index: 'a0', x: 0 },
      { ...BASE, id: 'b', version: 1, versionNonce: 3, index: 'a1', x: 500 }, // a CLI add
    ];

    const out = reconcileRemoteScene({ restoreElements, reconcileElements }, local, remote, APP_STATE);

    const a = out.find((e) => e.id === 'a')!;
    expect(a.x).toBe(300);
    expect(a.version).toBe(5);
    expect(a.versionNonce).toBe(10);
    // And the remote-only element arrives, its version untouched.
    const b = out.find((e) => e.id === 'b')!;
    expect(b.version).toBe(1);
    expect(b.x).toBe(500);
  });

  it('takes a genuinely newer remote copy', () => {
    const { restoreElements, reconcileElements } = excalidraw();
    const local = restoreElements([{ ...BASE, id: 'a', version: 2, versionNonce: 10, index: 'a0', x: 10 }], null);
    const remote = [{ ...BASE, id: 'a', version: 4, versionNonce: 1, index: 'a0', x: 999 }];
    const out = reconcileRemoteScene({ restoreElements, reconcileElements }, local, remote, APP_STATE);
    expect(out.find((e) => e.id === 'a')!.x).toBe(999);
  });

  it('why null matters: restoring WITH the local elements bumps the stale remote past the local edit', () => {
    const { restoreElements, reconcileElements } = excalidraw();
    const local = restoreElements([{ ...BASE, id: 'a', version: 5, versionNonce: 10, index: 'a0', x: 300 }], null);
    const remote = [{ ...BASE, id: 'a', version: 3, versionNonce: 7, index: 'a0', x: 0 }];
    const wrongly = restoreElements(remote, local);
    expect(wrongly[0].version).toBe(6); // local.version + 1
    const out = reconcileElements(local, wrongly, APP_STATE);
    expect(out[0].x).toBe(0); // the user's drag is gone: the bug the canvas avoids
  });
});

describe('an element the CLI adds loads on real Excalidraw 0.18 with its version untouched (D11)', () => {
  let ctx: string;
  beforeAll(() => {
    ctx = join(dir, 'cli-ctx', '_dream_context');
    mkdirSync(ctx, { recursive: true });
  });

  /** What `whiteboard add` writes: `makeWidgetElement` with an index from `nextIndices`, through `mutateWhiteboard`. */
  async function cliBoard(): Promise<WhiteboardElement[]> {
    const { slug } = createWhiteboard(ctx, `cli ${Math.random()}`);
    await mutateWhiteboard(ctx, slug, (b) => {
      b.elements.push({ ...BASE, id: 'existing', version: 4, versionNonce: 9, index: 'a0', x: 0 });
    });
    for (const [kind, payload] of [
      ['note', { markdown: '# hi\n```js\nx\n```', title: 'Note' }],
      ['todo', { title: 'Todo', items: [newTodoItem('buy milk')] }],
    ] as const) {
      await mutateWhiteboard(ctx, slug, (b) => {
        const [index] = nextIndices(b.elements, 1);
        b.elements.push(makeWidgetElement(kind, payload, autoPlace(b.elements), index));
      });
    }
    return readWhiteboard(ctx, slug).board.elements;
  }

  it('restoreElements(remote, null) keeps every element, its version and its versionNonce', async () => {
    const { restoreElements } = excalidraw();
    const disk = await cliBoard();
    expect(disk.map((e) => e.index)).toEqual(['a0', 'a1', 'a2']);
    const restored = restoreElements(disk, null);
    expect(restored.map((e) => e.id)).toEqual(disk.map((e) => e.id));
    for (const el of disk) {
      const r = restored.find((e) => e.id === el.id)!;
      expect(r.version).toBe(el.version);
      expect(r.versionNonce).toBe(el.versionNonce);
      expect(r.index).toBe(el.index);
    }
  });

  it('reconcileElements keeps them unchanged and in the store\'s (index, id) order', async () => {
    const { restoreElements, reconcileElements } = excalidraw();
    const disk = await cliBoard();
    // The open canvas already holds the pre-existing element; the poll brings the two CLI adds.
    const local = restoreElements([disk[0]], null);
    const out = reconcileRemoteScene({ restoreElements, reconcileElements }, local, disk, APP_STATE);
    expect(out.map((e) => e.id)).toEqual(sortElements(disk).map((e) => e.id));
    expect(out.map((e) => e.id)).toEqual(mergeElements(disk.slice(0, 1), disk).elements.map((e) => e.id));
    for (const el of disk) {
      const r = out.find((e) => e.id === el.id)!;
      expect(r.version).toBe(el.version);
      expect(r.versionNonce).toBe(el.versionNonce);
      expect(r.index).toBe(el.index);
    }
  });
});

describe('the Excalidraw bundle', () => {
  it('loaded (a load failure fails here, it is never a skip)', () => {
    expect(typeof excalidraw().restoreElements).toBe('function');
  });
});

describe('stripImageElements (D10)', () => {
  it('removes live and deleted images, counts the visible ones, and leaves others untouched', () => {
    const els = [
      { id: 'r', type: 'rectangle', version: 1 },
      { id: 'i1', type: 'image', version: 1 },
      { id: 'i2', type: 'image', version: 2, isDeleted: true },
    ];
    const r = stripImageElements(els);
    expect(r.elements.map((e) => e.id)).toEqual(['r']);
    expect(r.removed).toBe(2);
    expect(r.visible).toBe(1);
  });

  it('returns the same array when there is nothing to remove', () => {
    const els = [{ id: 'r', type: 'rectangle', version: 1 }];
    expect(stripImageElements(els).elements).toBe(els);
  });
});
